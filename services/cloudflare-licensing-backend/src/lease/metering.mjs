// Metered consumption + quota (audit R6.3).
//
// entitlements cap CONCURRENCY (pool_size) and DEVICES (max_active_devices) but not CONSUMPTION.
// meterUsage() increments a per-entitlement, per-rolling-period counter (usage_meters) and enforces
// meter_quota when it is > 0 (0 = unlimited / count-only). The increment is isolation-bound exactly
// like the seat mutations: in soft/required mode the entitlement must be owned by the caller's
// customer (a NULL-owner is allowed only in soft), so a customer can never meter another's usage.
//
// Enforcement is atomic: INSERT-OR-IGNORE the period row at 0, then a CONDITIONAL increment that only
// applies when (quota = 0 OR units_consumed + units <= quota). A rejected increment records nothing,
// so the counter never crosses the quota (no TOCTOU over-count under D1's per-object serialization).

function entitlementValid(row, now) {
  const validFrom = row.valid_from === null || row.valid_from === undefined ? null : Number(row.valid_from);
  const validUntil = row.valid_until === null || row.valid_until === undefined ? null : Number(row.valid_until);
  return (validFrom === null || validFrom <= now) && (validUntil === null || validUntil > now);
}

/**
 * Report `units` consumed against (body.project, body.feature, body.license_fingerprint). `isolation`
 * is { mode: 'off'|'soft'|'required', customerId } from accountAuth. Returns
 * { ok, status, code?, units_consumed?, quota?, period_start?, period_end? }.
 */
export async function meterUsage(env, body, isolation, units, now) {
  if (!Number.isInteger(units) || units <= 0) {
    return { ok: false, status: 400, code: "invalid_units" };
  }
  // Isolation-bound entitlement read (mirrors the seat SQL): off => no owner conjunct; soft => owner
  // OR NULL; required => owner only.
  const ownerConjunct =
    isolation.mode === "off"
      ? ""
      : isolation.mode === "soft"
        ? " AND (customer_id = ? OR customer_id IS NULL)"
        : " AND customer_id = ?";
  const readBinds = [body.project, body.feature, body.license_fingerprint];
  if (isolation.mode !== "off") readBinds.push(isolation.customerId);
  const ent = await env.DB.prepare(
    "SELECT status, valid_from, valid_until, meter_quota, meter_period_sec FROM entitlements " +
      "WHERE project = ? AND feature = ? AND license_fingerprint = ?" +
      ownerConjunct,
  )
    .bind(...readBinds)
    .first();
  if (ent === null || ent.status !== "active" || !entitlementValid(ent, now)) {
    return { ok: false, status: 403, code: "no_active_entitlement" };
  }

  const quota = Number(ent.meter_quota ?? 0);
  const periodSec = Number(ent.meter_period_sec ?? 0) > 0 ? Number(ent.meter_period_sec) : 2592000;
  const periodStart = Math.floor(now / periodSec) * periodSec;
  const periodEnd = periodStart + periodSec;

  await env.DB.prepare(
    "INSERT OR IGNORE INTO usage_meters (project, feature, license_fingerprint, period_start, units_consumed, updated_at) " +
      "VALUES (?, ?, ?, ?, 0, ?)",
  )
    .bind(body.project, body.feature, body.license_fingerprint, periodStart, now)
    .run();

  // Conditional increment: only when unlimited (quota=0) or the new total stays within quota.
  const updated = await env.DB.prepare(
    "UPDATE usage_meters SET units_consumed = units_consumed + ?, updated_at = ? " +
      "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND period_start = ? " +
      "AND (? = 0 OR units_consumed + ? <= ?) RETURNING units_consumed",
  )
    .bind(units, now, body.project, body.feature, body.license_fingerprint, periodStart, quota, units, quota)
    .first();

  if (updated === null) {
    // Would exceed the quota -> nothing recorded. Report the current (unchanged) total.
    const cur = await env.DB.prepare(
      "SELECT units_consumed FROM usage_meters WHERE project = ? AND feature = ? AND license_fingerprint = ? AND period_start = ?",
    )
      .bind(body.project, body.feature, body.license_fingerprint, periodStart)
      .first();
    return {
      ok: false,
      status: 429,
      code: "quota_exceeded",
      units_consumed: Number(cur?.units_consumed ?? 0),
      quota,
      period_start: periodStart,
      period_end: periodEnd,
    };
  }
  return {
    ok: true,
    status: 200,
    units_consumed: Number(updated.units_consumed),
    quota,
    period_start: periodStart,
    period_end: periodEnd,
  };
}
