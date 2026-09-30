import { accessCounts } from "./access-counts.js";
import { envelope, json } from "../../responses.js";
import type { TimeseriesBucket, ExpiringEntitlement } from "../../../shared/api";
import { verifyAuditChain } from "@licensecc/cloudflare-runtime/d1/audit_digest";
import { boundTrialDeadlineSql } from "@licensecc/cloudflare-runtime/device/bound_trial";
import { entitlementId } from "@licensecc/licensing-domain/entitlements/contracts";
import type { Env } from "../../env.js";
import { envFlag } from "../../support.js";
import { boundedCursor } from "../../query.js";

const TIMESERIES_DEFAULT_WINDOW_SECS = 604800;
const TIMESERIES_DEFAULT_BUCKETS = 24;
const TIMESERIES_MAX_BUCKETS = 200;
const EXPIRING_DEFAULT_WITHIN_DAYS = 30;
const EXPIRING_MAX_WITHIN_DAYS = 365;
const SECONDS_PER_DAY = 86400;
export async function summary(env: Env, requestIdValue: string): Promise<Response> {
  return envelope(requestIdValue, "summary", { entitlements: await accessCounts(env) });
}

export async function settings(env: Env, requestIdValue: string): Promise<Response> {
  return envelope(requestIdValue, "settings", {
    environment: env.ENVIRONMENT ?? "development",
    public_verifier_url: env.PUBLIC_VERIFIER_URL ?? "",
    auth: envFlag(env.ADMIN_DEV_BEARER_ENABLED) ? "dev-bearer" : "cloudflare-access",
  });
}

export async function report(env: Env, requestIdValue: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
    (await env.DB.prepare(sql).bind(...binds).first<{ count: number }>())?.count ?? 0;
  const byStatus = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM order_events GROUP BY status")
    .all<{ status: string; count: number }>();
  const orders: Record<string, number> = { accepted: 0, processed: 0, superseded: 0, rejected: 0 };
  for (const row of byStatus.results) {
    orders[row.status] = row.count;
  }
  return envelope(requestIdValue, "report", {
    generated_at: now,
    entitlements: await accessCounts(env),
    customers: {
      total: await count("SELECT COUNT(*) AS count FROM customers"),
      active: await count("SELECT COUNT(*) AS count FROM customers WHERE status = 'active'"),
      disabled: await count("SELECT COUNT(*) AS count FROM customers WHERE status = 'disabled'"),
    },
    licenses: { total: await count("SELECT COUNT(*) AS count FROM licenses") },
    fulfillment: {
      ...orders,
      stale_accepted: await count(
        "SELECT COUNT(*) AS count FROM order_events WHERE status = 'accepted' AND processed_at IS NULL AND received_at < ?",
        now - 300,
      ),
      events_24h: await count("SELECT COUNT(*) AS count FROM order_events WHERE received_at >= ?", now - 86400),
      events_7d: await count("SELECT COUNT(*) AS count FROM order_events WHERE received_at >= ?", now - 604800),
    },
    customer_suspensions_7d: await count(
      "SELECT COUNT(*) AS count FROM customer_events WHERE event_type = 'disable' AND created_at >= ?",
      now - 604800,
    ),
  });
}

// Customer kill-switch (admin-only). Flipping customers.status to 'disabled' stops that customer's
// protected device issuance and renewal (the backend rechecks customers.status on each one) and portal login.
// Atomic: the guarded UPDATE...RETURNING and the conditional audit INSERT commit in one batch.
function epochParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// GET /api/admin/report/timeseries?from=&to=&buckets= (reader+admin). Bucket [from,to] into N
// equal buckets and count, per bucket, the protected refusals (a device-limit refusal is the only
// device_bound_denials row a protected grant records) and order_events (fulfillment_events by
// received_at), each in a SINGLE-PASS GROUP BY over a computed bucket index. The bucket index is
// CAST((ts - from) * buckets / span) clamped to [0, buckets-1]; the time window itself bounds the
// scan (indexed on ts / received_at).
export async function reportTimeseries(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const to = epochParam(url, "to") ?? now;
  const from = epochParam(url, "from") ?? to - TIMESERIES_DEFAULT_WINDOW_SECS;
  // A non-positive window is a client error: there is nothing to bucket.
  if (from >= to) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const buckets = Math.min(
    Math.max(Number(url.searchParams.get("buckets") ?? String(TIMESERIES_DEFAULT_BUCKETS)) || TIMESERIES_DEFAULT_BUCKETS, 1),
    TIMESERIES_MAX_BUCKETS,
  );
  const span = to - from;
  // bucket_seconds is the nominal width; the LAST bucket absorbs any integer remainder so the
  // window is fully covered (the clamp on the computed index keeps a ts == to inside bucket N-1).
  const bucketSeconds = Math.max(1, Math.floor(span / buckets));

  // The computed bucket index, shared by both aggregations. (? = from, ? = buckets, ? = span).
  // CAST(... AS INTEGER) truncates toward zero; MIN(..., buckets-1) clamps the right edge so a
  // row exactly at `to` (or any half-open boundary rounding) lands in the final bucket, never N.
  const bucketIndexExpr = (tsColumn: string): string =>
    `MIN(CAST((${tsColumn} - ?) * ? / ? AS INTEGER), ?)`;

  // Protected refusals: the device-limit refusals protected issuance records, one GROUP BY over the window.
  // device_bound_denials holds only device_limit_reached refusals, so no further filter is needed.
  const denialRows = await env.DB.prepare(
    `SELECT ${bucketIndexExpr("ts")} AS bucket, COUNT(*) AS denials
     FROM device_bound_denials WHERE ts >= ? AND ts < ? GROUP BY bucket`,
  ).bind(from, buckets, span, buckets - 1, from, to).all<{ bucket: number; denials: number }>();

  // Fulfillment events: order_events bucketed by received_at over the same window.
  const orderRows = await env.DB.prepare(
    `SELECT ${bucketIndexExpr("received_at")} AS bucket, COUNT(*) AS fulfillment_events
     FROM order_events WHERE received_at >= ? AND received_at < ? GROUP BY bucket`,
  ).bind(from, buckets, span, buckets - 1, from, to).all<{ bucket: number; fulfillment_events: number }>();

  // Dense the sparse GROUP BY results into a fixed [0..buckets-1] array (zero-filled gaps).
  const out: TimeseriesBucket[] = [];
  for (let i = 0; i < buckets; ++i) {
    out.push({ start: from + i * bucketSeconds, denials: 0, fulfillment_events: 0 });
  }
  for (const row of denialRows.results) {
    const bucket = out[row.bucket];
    if (bucket !== undefined) {
      bucket.denials = Number(row.denials) || 0;
    }
  }
  for (const row of orderRows.results) {
    const bucket = out[row.bucket];
    if (bucket !== undefined) {
      bucket.fulfillment_events = Number(row.fulfillment_events) || 0;
    }
  }
  return envelope(requestIdValue, "report_timeseries", { from, to, bucket_seconds: bucketSeconds, buckets: out });
}

// GET /api/admin/report/expiring?within_days=&limit=&cursor= (reader+admin). Active entitlements
// whose valid_until is in the open window (now, now + within_days*86400], ordered soonest-first,
// cursor-paginated. days_left is ceil((valid_until - now)/86400) so a row expiring in <1 day still
// reports 1, never 0.
// GET /api/admin/audit/verify (reader+admin). Replays the tamper-evident hash chain over
// entitlement_events (audit R6.4) and reports whether it verifies. status 200 = the check ran; the
// tamper signal is data.audit_chain.ok (false + brokenAt/reason when a covered event was altered/deleted).
export async function auditVerify(env: Env, requestIdValue: string): Promise<Response> {
  try {
    const result = await verifyAuditChain(env);
    return envelope(requestIdValue, result.ok ? "audit_chain_ok" : "audit_chain_broken", { audit_chain: result }, 200);
  } catch {
    return envelope(requestIdValue, "audit_verify_failed", undefined, 503);
  }
}

// A grant's effective deadline is normally its stamped valid_until. A trial's clock can end earlier
// (or, for an activation-basis trial with no valid_until at all, be the ONLY deadline it has); the
// protected trial rule's own SQL twin computes that clock exactly as the lease/consent path enforces
// it, clamped to valid_until with the same min(coalesce(valid_until, MAX), trial deadline) discipline
// the portal's self-service entitlement list uses (never a hand-rolled copy of that clamp). An
// unstarted activation-basis trial has no trial deadline yet (its rule yields NULL), so that side
// falls back to the same MAX sentinel: SQLite's min() is NULL if any argument is, and an unknown clock
// must never hide a stamped valid_until, which the consent page and lease issuer enforce regardless of
// it. With neither date the result is MAX, which the report's window excludes just as a non-expiring
// grant.
const EFFECTIVE_UNTIL_EXPRESSION = `CASE WHEN e.is_trial <> 1 THEN e.valid_until ELSE min(coalesce(e.valid_until, 9007199254740991),
             coalesce(${boundTrialDeadlineSql("e", "NULL")}, 9007199254740991)) END`;

// The SELECT list shared by both branches below (kept identical so the UNION ALL output shape and
// the effective-deadline computation cannot drift between them).
const EXPIRING_COLUMNS = `e.project AS project, e.feature AS feature, e.license_fingerprint AS license_fingerprint,
                e.customer_id AS customer_id, c.name AS customer_name, ${EFFECTIVE_UNTIL_EXPRESSION} AS effective_until`;

export async function reportExpiring(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const withinDays = Math.min(
    Math.max(Number(url.searchParams.get("within_days") ?? String(EXPIRING_DEFAULT_WITHIN_DAYS)) || EXPIRING_DEFAULT_WITHIN_DAYS, 1),
    EXPIRING_MAX_WITHIN_DAYS,
  );
  const horizon = now + withinDays * SECONDS_PER_DAY;
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const { limit, cursor } = pagination;
  // Two branches instead of one full scan of every active row: (a) is the common case and keeps the
  // pre-existing range seek on idx_entitlements_valid_until (forced with INDEXED BY so an unanalyzed
  // planner cannot fall back to scanning every active row); it covers every non-trial grant, plus any
  // trial whose own valid_until (not its trial clock) already lands in the window. (b) is the rare
  // case: an active trial whose CLOCK lands in the window despite valid_until being NULL or outside
  // it (an activation-basis trial commonly has no valid_until at all). The two WHERE clauses are
  // mutually exclusive by construction, so UNION ALL cannot duplicate a row.
  const rows = await env.DB.prepare(
    `SELECT project, feature, license_fingerprint, customer_id, customer_name, effective_until
       FROM (
         SELECT ${EXPIRING_COLUMNS}
           FROM entitlements e INDEXED BY idx_entitlements_valid_until
           LEFT JOIN customers c ON c.id = e.customer_id
          WHERE e.status = 'active' AND e.valid_until IS NOT NULL AND e.valid_until > ? AND e.valid_until <= ?
         UNION ALL
         SELECT ${EXPIRING_COLUMNS}
           FROM entitlements e
           LEFT JOIN customers c ON c.id = e.customer_id
          WHERE e.status = 'active' AND e.is_trial = 1
            AND (e.valid_until IS NULL OR e.valid_until <= ? OR e.valid_until > ?)
       )
      WHERE effective_until IS NOT NULL AND effective_until > ? AND effective_until <= ?
      ORDER BY effective_until ASC, project, feature, license_fingerprint
      LIMIT ? OFFSET ?`,
  ).bind(now, horizon, now, horizon, now, horizon, limit + 1, cursor)
    .all<{ project: string; feature: string; license_fingerprint: string; customer_id: string; customer_name: string | null; effective_until: number }>();
  const items: ExpiringEntitlement[] = rows.results.slice(0, limit).map((row) => ({
    id: entitlementId(row.project, row.feature, row.license_fingerprint),
    project: row.project,
    feature: row.feature,
    license_fingerprint: row.license_fingerprint,
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? null,
    valid_until: row.effective_until,
    days_left: Math.max(1, Math.ceil((row.effective_until - now) / SECONDS_PER_DAY)),
  }));
  return envelope(requestIdValue, "report_expiring", {
    items,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}
