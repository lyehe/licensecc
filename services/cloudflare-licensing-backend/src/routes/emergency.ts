import { constantTimeEqual, readBearer } from "../auth/account_auth.mjs";
import { json, requestId, clientIp } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env, ExecutionContextLike, IsolationBinding } from "../env.js";
import { logEvent } from "../observability/index.js";
import { handleLeaseIssue } from "./leases.js";
import { handleMeter } from "./metering.js";
import { handleUsageReport } from "./reports.js";
import { handleSeatCheckout, handleSeatHeartbeat, handleSeatRelease } from "./seats.js";

const EMERGENCY_ISOLATION: IsolationBinding = { mode: "off", customerId: null };

// D10 break-glass dispatcher. Reachable ONLY at /v1/emergency/* (a path the 6 scoped routes can
// never produce), gated by a constant-time EMERGENCY_OPERATOR_BEARER compare. On a verified match
// it passes an explicit non-isolated operator context into the target handler, so no account-token
// or legacy lease bearer gate is re-run. The override is not a customer's scoped credential and is
// logged loudly. The bearer is never logged (L10).
export async function handleEmergencyRoute(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const configured = env.EMERGENCY_OPERATOR_BEARER;
  // Unset/empty => the route does not exist (no oracle): 404, same as any unknown path.
  if (configured === undefined || configured === "") return json({ ok: false, code: "not_found" }, 404);
  const raw = readBearer(request);
  const okBearer = raw !== null && (await constantTimeEqual(raw, configured));
  if (!okBearer) return json({ ok: false, code: "unauthorized" }, 401);

  // Strip the /v1/emergency prefix to recover the target scoped path.
  const target = url.pathname.slice("/v1/emergency".length); // e.g. "/v1/release"
  logEvent("warn", "account.emergency_override_used", {
    request_id: requestId(request),
    method: request.method,
    target,
    client_ip: clientIp(request),
  });

  if (request.method === "POST" && (target === "/v1/activate" || target === "/v1/renew")) {
    return await handleLeaseIssue(request, env, target === "/v1/activate" ? "activate" : "renew", ctx, EMERGENCY_ISOLATION);
  }
  if (request.method === "POST" && target === "/v1/checkout") {
    return await handleSeatCheckout(request, env, ctx, EMERGENCY_ISOLATION);
  }
  if (request.method === "POST" && target === "/v1/heartbeat") {
    return await handleSeatHeartbeat(request, env, ctx, EMERGENCY_ISOLATION);
  }
  if (request.method === "POST" && target === "/v1/release") {
    return await handleSeatRelease(request, env, ctx, EMERGENCY_ISOLATION);
  }
  if (request.method === "POST" && target === "/v1/meter") {
    return await handleMeter(request, env, ctx, EMERGENCY_ISOLATION);
  }
  if (request.method === "GET" && target === "/v1/admin/report") {
    return await handleUsageReport(request, env, ctx, EMERGENCY_ISOLATION);
  }
  return json({ ok: false, code: "not_found" }, 404);
}
