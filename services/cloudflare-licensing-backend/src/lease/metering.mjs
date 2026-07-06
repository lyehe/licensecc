// Metered consumption + quota (audit R6.3).
//
// entitlements cap CONCURRENCY (pool_size) and DEVICES (max_active_devices) but not CONSUMPTION.
// meterUsage() increments a per-entitlement, per-rolling-period counter (usage_meters) and enforces
// meter_quota when it is > 0 (0 = unlimited / count-only).
//
// ISOLATION: the entitlement is read with the caller's owner conjunct (off => none; soft => owner OR
// NULL; required => owner only), so a customer can only meter its OWN entitlement -- meterUsage never
// touches another tenant's data. NOTE this differs deliberately from the seat/lease mutations, which
// fold the ownership EXISTS INTO the write to close a TOCTOU: for SEATS a stale write grants ACCESS
// (a live seat), so it must be denied atomically; for METERING the write only increments a per-
// fingerprint accounting counter (usage_meters carries no customer_id -- there is exactly one meter
// per fingerprint), so the worst a sub-millisecond revoke/expire race can do is record one extra unit
// for an already-admitted in-flight request -- harmless billing drift, never an access decision.
//
// QUOTA enforcement is atomic: upsert the period row at 0 (INSERT ... ON CONFLICT DO NOTHING, portable
// to SQLite/D1 AND Postgres), then a CONDITIONAL increment that only applies when
// (quota = 0 OR units_consumed + units <= quota). A rejected increment records nothing, so the counter
// never crosses the quota (no over-count under D1's per-object serialization).

// A single call may not report an absurd unit count: cap it well below 2^53 so units_consumed stays a
// safe integer (SQLite INTEGER / PG BIGINT are int64; JS Number loses precision above 2^53).
const MAX_METER_UNITS = 1_000_000_000;

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
  if (!Number.isSafeInteger(units) || units <= 0 || units > MAX_METER_UNITS) {
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

  // Portable upsert of the period row at 0 (SQLite/D1 AND Postgres both accept ON CONFLICT DO NOTHING;
  // SQLite-only INSERT OR IGNORE would break under the Postgres adapter, which the pg schema advertises).
  await env.DB.prepare(
    "INSERT INTO usage_meters (project, feature, license_fingerprint, period_start, units_consumed, updated_at) " +
      "VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (project, feature, license_fingerprint, period_start) DO NOTHING",
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
