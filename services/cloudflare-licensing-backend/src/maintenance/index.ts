import { runBoundDeviceCleanup } from "./device_cleanup.js";
import { enqueueAndDeliverWebhooks } from "@licensecc/cloudflare-runtime/webhooks/webhook";
import { appendAuditDigest } from "@licensecc/cloudflare-runtime/d1/audit_digest";
import type { Env, ExecutionContextLike } from "../env.js";
import { logEvent } from "../observability/index.js";

const USAGE_EVENT_RETENTION_SEC = 90 * 24 * 60 * 60; // usage_events rows are kept for 90 days

// Cron Trigger: protected-device cleanup, retention on the append-only logs, portal auth sweeps,
// webhook delivery and the audit digest. Wire via [triggers] crons in wrangler.toml.
export async function scheduled(_event: unknown, env: Env, _ctx?: ExecutionContextLike): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await runBoundDeviceCleanup(env.DB);
    try {
      await env.DB.prepare("DELETE FROM usage_events WHERE ts < ?").bind(now - USAGE_EVENT_RETENTION_SEC).run();
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
    // retention housekeeping or the cron. Emission is UNMETERED: this is the ONLY place webhooks
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
