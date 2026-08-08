import { envelope, json } from "../../responses.js";
import type { TimeseriesBucket, ExpiringEntitlement } from "../../../shared/api";
import { verifyAuditChain } from "@licensecc/cloudflare-runtime/d1/audit_digest";
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
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements").first<{ count: number }>();
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'").first<{ count: number }>();
  const revoked = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'").first<{ count: number }>();
  const disabled = await env.DB.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'disabled'").first<{ count: number }>();
  return envelope(requestIdValue, "summary", {
    entitlements: {
      total: total?.count ?? 0,
      active: active?.count ?? 0,
      revoked: revoked?.count ?? 0,
      disabled: disabled?.count ?? 0,
    },
  });
}

export async function settings(env: Env, requestIdValue: string): Promise<Response> {
  return envelope(requestIdValue, "settings", {
    environment: env.ENVIRONMENT ?? "development",
    public_verifier_url: env.PUBLIC_VERIFIER_URL ?? "",
    auth: envFlag(env.ADMIN_DEV_BEARER_ENABLED) ? "dev-bearer" : "cloudflare-access",
  });
}

// Create an entitlement by STAMPING a policy (POST /api/admin/entitlements with a policy_id).
// Gated by POLICY_STAMP_MODE: off (default) rejects 400 policy_stamping_disabled; on stamps.
// The policy must exist and be status=active (else 404 policy_not_found). stampFromPolicy yields
// the EXACT EntitlementInput createEntitlement already writes byte-identically PLUS the capacity +
// frozen-trial side-state, which rides createEntitlement's extraStatements seam to land in the SAME
// atomic batch as the INSERT. The body's target tuple + any per-field overrides flow through `overrides`.
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
    entitlements: {
      total: await count("SELECT COUNT(*) AS count FROM entitlements"),
      active: await count("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'"),
      revoked: await count("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'revoked'"),
      disabled: await count("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'disabled'"),
    },
    customers: {
      total: await count("SELECT COUNT(*) AS count FROM customers"),
      active: await count("SELECT COUNT(*) AS count FROM customers WHERE status = 'active'"),
      disabled: await count("SELECT COUNT(*) AS count FROM customers WHERE status = 'disabled'"),
    },
    account_tokens: {
      active: await count("SELECT COUNT(*) AS count FROM account_tokens WHERE status = 'active' AND expires_at > ?", now),
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

// Customer kill-switch (admin-only). Flipping customers.status to 'disabled' severs that customer's
// account-token auth (resolveAccountToken JOINs customers c ON c.status='active') and portal login.
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
// equal buckets and aggregate, per bucket, usage_events (checkout/release+reclaim/denied by ts)
// and order_events (fulfillment_events by received_at) in a SINGLE-PASS GROUP BY over a computed
// bucket index. The bucket index is CAST((ts - from) * buckets / span) clamped to [0, buckets-1];
// the time window itself bounds the scan (indexed on ts / received_at).
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

  // Usage events: one GROUP BY over the window, counting each event_type per bucket.
  const usageRows = await env.DB.prepare(
    `SELECT ${bucketIndexExpr("ts")} AS bucket,
       SUM(CASE WHEN event_type = 'checkout' THEN 1 ELSE 0 END) AS checkouts,
       SUM(CASE WHEN event_type IN ('release', 'reclaim') THEN 1 ELSE 0 END) AS releases,
       SUM(CASE WHEN event_type = 'denied' THEN 1 ELSE 0 END) AS denials
     FROM usage_events WHERE ts >= ? AND ts < ? GROUP BY bucket`,
  ).bind(from, buckets, span, buckets - 1, from, to).all<{ bucket: number; checkouts: number; releases: number; denials: number }>();

  // Fulfillment events: order_events bucketed by received_at over the same window.
  const orderRows = await env.DB.prepare(
    `SELECT ${bucketIndexExpr("received_at")} AS bucket, COUNT(*) AS fulfillment_events
     FROM order_events WHERE received_at >= ? AND received_at < ? GROUP BY bucket`,
  ).bind(from, buckets, span, buckets - 1, from, to).all<{ bucket: number; fulfillment_events: number }>();

  // Dense the sparse GROUP BY results into a fixed [0..buckets-1] array (zero-filled gaps).
  const out: TimeseriesBucket[] = [];
  for (let i = 0; i < buckets; ++i) {
    out.push({ start: from + i * bucketSeconds, checkouts: 0, releases: 0, denials: 0, denial_rate: 0, fulfillment_events: 0 });
  }
  for (const row of usageRows.results) {
    const bucket = out[row.bucket];
    if (bucket === undefined) {
      continue;
    }
    bucket.checkouts = Number(row.checkouts) || 0;
    bucket.releases = Number(row.releases) || 0;
    bucket.denials = Number(row.denials) || 0;
    const attempts = bucket.checkouts + bucket.denials;
    // denial_rate = denials / (checkouts + denials); 0 when the bucket saw no attempts. Mirrors
    // usage_report.mjs (denials / checkout-attempts is the upsell signal).
    bucket.denial_rate = attempts === 0 ? 0 : bucket.denials / attempts;
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

export async function reportExpiring(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const withinDays = Math.min(
    Math.max(Number(url.searchParams.get("within_days") ?? String(EXPIRING_DEFAULT_WITHIN_DAYS)) || EXPIRING_DEFAULT_WITHIN_DAYS, 1),
    EXPIRING_MAX_WITHIN_DAYS,
  );
  const horizon = now + withinDays * SECONDS_PER_DAY;
  const { limit, cursor } = boundedCursor(url);
  const rows = await env.DB.prepare(
    `SELECT project, feature, license_fingerprint, customer_id, valid_until
       FROM entitlements
      WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until > ? AND valid_until <= ?
      ORDER BY valid_until ASC, project, feature, license_fingerprint
      LIMIT ? OFFSET ?`,
  ).bind(now, horizon, limit + 1, cursor).all<Omit<ExpiringEntitlement, "days_left">>();
  const items: ExpiringEntitlement[] = rows.results.slice(0, limit).map((row) => ({
    project: row.project,
    feature: row.feature,
    license_fingerprint: row.license_fingerprint,
    customer_id: row.customer_id ?? null,
    valid_until: row.valid_until,
    days_left: Math.max(1, Math.ceil((row.valid_until - now) / SECONDS_PER_DAY)),
  }));
  return envelope(requestIdValue, "report_expiring", {
    items,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

// POST /api/admin/entitlements/:id/release-seats (ADMIN-ONLY, reason REQUIRED). The operator lever
// for "a seat is stuck on a dead machine": delegates the live-seat reclaim mutation to the backend's
// seat lifecycle helper, which writes one usage_events('reclaim') row per released seat so
// peak_concurrent stays accurate. 0 released is a valid idempotent {ok:true}. Idempotency-Key supported.
