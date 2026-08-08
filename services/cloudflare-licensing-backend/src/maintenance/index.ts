import { SEAT_OVERCAP_RECLAIM_SQL } from "../lease/issuance_sql.mjs";
import { enqueueAndDeliverWebhooks } from "@licensecc/cloudflare-runtime/webhooks/webhook";
import { appendAuditDigest } from "@licensecc/cloudflare-runtime/d1/audit_digest";
import type { Env, ExecutionContextLike } from "../env.js";
import { logEvent } from "../observability/index.js";
import { recordUsageEvent } from "../routes/reports.js";

const USAGE_EVENT_RETENTION_SEC = 90 * 24 * 60 * 60; // reports cover up to 90d; longer => rollups
const LEASE_ISSUANCE_RETENTION_SEC = 180 * 24 * 60 * 60; // > max rebind_window_sec so the rebind cap keeps its rows
// usage_meters reads only the CURRENT rolling period, so a period row is dead once its window closes.
// Keep ~13 months (a full year of monthly periods + margin for billing reconciliation), matching the
// retention discipline every other high-churn counter table has (audit R6.3 retention gap).
const USAGE_METER_RETENTION_SEC = 400 * 24 * 60 * 60;

// Sweep lapsed seats (heartbeat_deadline < now): delete them and record a 'reclaim' at the ACTUAL
// deadline (when concurrency dropped), each under its own entitlement. Used lazily on the checkout
// hot path and by the scheduled (cron) handler so idle entitlements still reclaim promptly.
export async function sweepLapsedSeats(env: Env, now: number): Promise<void> {
  try {
    const swept = await env.DB.prepare(
      "DELETE FROM seat_checkouts WHERE heartbeat_deadline < ? RETURNING project, feature, license_fingerprint, seat_id, heartbeat_deadline",
    )
      .bind(now)
      .all<{ project: string; feature: string; license_fingerprint: string; seat_id: string; heartbeat_deadline: number }>();
    for (const reclaimed of swept.results ?? []) {
      await recordUsageEvent(env, {
        project: reclaimed.project,
        feature: reclaimed.feature,
        fingerprint: reclaimed.license_fingerprint,
        event_type: "reclaim",
        seat_id: reclaimed.seat_id,
        ts: Number(reclaimed.heartbeat_deadline),
      });
    }
  } catch {
    // best-effort: reclamation is not load-bearing for any single request
  }
}

// T7 downgrade reclaim — reclaim LIVE seats above an entitlement's CURRENT pool ceiling (after a
// capacity downgrade), latest-alive kept. Each reclaimed seat records a 'reclaim' at its deadline
// under its own entitlement, so the client's next heartbeat denies (seat_reclaimed) and over-cap
// access ends within one sweep + grace. Best-effort, like sweepLapsedSeats; run on the checkout hot
// path and the cron. Distinct from the lapsed sweep (which frees EXPIRED seats); this frees still-
// live but now-over-capacity seats.
export async function reclaimOvercapSeats(env: Env, now: number): Promise<void> {
  try {
    const reclaimed = await env.DB.prepare(SEAT_OVERCAP_RECLAIM_SQL)
      .bind(now, now)
      .all<{ project: string; feature: string; license_fingerprint: string; seat_id: string; heartbeat_deadline: number }>();
    for (const seat of reclaimed.results ?? []) {
      await recordUsageEvent(env, {
        project: seat.project,
        feature: seat.feature,
        fingerprint: seat.license_fingerprint,
        event_type: "reclaim",
        seat_id: seat.seat_id,
        ts: now,
      });
    }
  } catch {
    // best-effort: downgrade reclamation is not load-bearing for any single request
  }
}

// Cron Trigger: reclaim lapsed seats so idle entitlements still free seats and log their
// reclaim (keeping peak_concurrent accurate without waiting for a later checkout), and enforce
// retention on the append-only logs. Wire via [triggers] crons in wrangler.toml.
export async function scheduled(_event: unknown, env: Env, _ctx?: ExecutionContextLike): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await sweepLapsedSeats(env, now);
    await reclaimOvercapSeats(env, now);
    try {
      await env.DB.prepare("DELETE FROM usage_events WHERE ts < ?").bind(now - USAGE_EVENT_RETENTION_SEC).run();
    } catch {
      // best-effort
    }
    try {
      await env.DB.prepare("DELETE FROM lease_issuance WHERE issued_at < ?").bind(now - LEASE_ISSUANCE_RETENTION_SEC).run();
    } catch {
      // best-effort
    }
    try {
      // Metering counter retention (audit R6.3): drop closed-period usage_meters rows past the window
      // (reads only ever touch the current period). Without this the table grows one row per
      // entitlement per period forever — the only counter table that lacked a sweep.
      await env.DB.prepare("DELETE FROM usage_meters WHERE period_start < ?").bind(now - USAGE_METER_RETENTION_SEC).run();
    } catch {
      // best-effort
    }
    // Slice 3 customer-portal sweep: expired one-time OTP rows and revoked/expired sessions. Both
    // are short-TTL auth artifacts (blueprint (b)); leaving them only grows the table — the auth
    // path never serves an expired/consumed row, so deletion is purely housekeeping.
    try {
      await env.DB.prepare("DELETE FROM portal_otp WHERE expires_at < ?").bind(now).run();
    } catch {
      // best-effort
    }
    try {
      await env.DB.prepare("DELETE FROM portal_sessions WHERE status = 'revoked' OR expires_at < ?").bind(now).run();
    } catch {
      // best-effort
    }
    // Webhook dispatcher: a strictly READ-SIDE, cron-drained transactional outbox over the existing
    // audit tables (entitlement_events/customer_events/order_events). Runs AFTER the sweeps above,
    // best-effort — enqueueAndDeliverWebhooks never throws, so a webhook problem can never break the
    // seat/retention housekeeping or the cron. Emission is UNMETERED: this is the ONLY place webhooks
    // are emitted (never inline / waitUntil on a request path).
    await enqueueAndDeliverWebhooks(env, now, logEvent);
    // Tamper-evident audit digest (R6.4): append one hash-chain segment over the new entitlement_events.
    // READ-ONLY over the log + append-only to audit_digests; best-effort so a digest problem never
    // breaks the cron.
    try {
      await appendAuditDigest(env, now);
    } catch {
      // best-effort
    }
}
