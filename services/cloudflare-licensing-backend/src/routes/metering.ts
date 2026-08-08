import { meterUsage } from "@licensecc/cloudflare-runtime/lease/metering";
import { json } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env, ExecutionContextLike, IsolationBinding } from "../env.js";
import { readJsonBody, requireString, resolveIsolation } from "./verify.js";

// Metered consumption (R6.3). Account-authed under the "report" scope (metering IS a usage report;
// reusing it avoids widening the account-token operation axis). The counter is per-customer isolated
// exactly like seats: accountAuth binds (project, feature, customer), and meterUsage's entitlement
// read carries the owner conjunct so a customer can only meter its own entitlement. Body:
// { project, feature, license_fingerprint, units? } (units defaults to 1). Enforcement (429
// quota_exceeded) only bites when the entitlement's meter_quota > 0; the default 0 counts only.
// Rate-limiting note: like the other ACCOUNT-AUTHED mutating endpoints (seat checkout/heartbeat/
// release, lease activate/renew), /v1/meter is gated by a valid per-customer account token rather than
// the D1/limiter tiers that protect the UNAUTHENTICATED public /v1/verify path. A flood is therefore
// bounded to the token holder's own isolated entitlement (self-directed billing drift), consistent
// with every sibling account-authed route — not the open-abuse surface checkRateLimit exists for.
export async function handleMeter(request: Request, env: Env, ctx?: ExecutionContextLike, isolationOverride?: IsolationBinding): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const rawBody = await readJsonBody(request);
  if (!rawBody.ok) return json({ ok: false, code: rawBody.code }, rawBody.status);
  const raw = rawBody.value;
  if (raw === null || typeof raw !== "object") return json({ ok: false, code: "invalid_request" }, 400);
  const value = raw as Record<string, unknown>;
  const project = requireString(value.project);
  const feature = requireString(value.feature);
  const fingerprint = requireString(value.license_fingerprint);
  if (project === null || feature === null || fingerprint === null) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  // Absent units => a single unit; a present-but-non-numeric units => -1 so meterUsage rejects it.
  const units = value.units === undefined ? 1 : typeof value.units === "number" ? value.units : -1;

  const isolation = await resolveIsolation(request, env, "report", project, feature, now, ctx, isolationOverride);
  if ("ok" in isolation) return json({ ok: false, code: isolation.code }, isolation.status);

  let result: { ok: boolean; status: number; code?: string; units_consumed?: number; quota?: number; period_start?: number; period_end?: number };
  try {
    result = await meterUsage(env, { project, feature, license_fingerprint: fingerprint }, isolation, units, now);
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  const { status, ...payload } = result;
  return json({ server_time: now, ...payload }, status);
}
