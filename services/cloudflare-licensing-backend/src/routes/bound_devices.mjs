import { BoundRequestError, readBoundJson } from "../device/bound_request.mjs";
import { boundDeviceConfig, loadBoundSigner } from "../device/bound_config.mjs";
import { limitBoundRequest } from "../device/bound_rate.mjs";
import { createBoundAuthorization, createBoundChallenge } from "../device/bound_enrollment.mjs";
import { issueBoundLease } from "../device/bound_issue.mjs";

export async function handleBoundDevice(request, env, operation) {
  const requestId = crypto.randomUUID();
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  try {
    if (request.url.includes("?") || request.url.includes("#")) throw new BoundRequestError();
    // Fixed issuer/audience and client registry are required even for challenge
    // issuance. A partially configured deployment is closed, not a legacy mode.
    const config = boundDeviceConfig(env);
    const db = typeof env.DB.withSession === "function" ? env.DB.withSession("first-primary") : env.DB;
    await limitBoundRequest(request, env, db);
    const body = await readBoundJson(request);
    if (operation === "exchange" || operation === "renew") {
      const response = await issueBoundLease(db, operation, body, config, () => loadBoundSigner(env), requestId);
      return new Response(JSON.stringify(response), { status: 200, headers });
    }
    const data = operation === "authorize" ? await createBoundAuthorization(db, body, config) : await createBoundChallenge(db, body);
    return new Response(JSON.stringify({ ok: true, code: operation === "authorize" ? "authorization_created" : "challenge_created", request_id: requestId, data }), { status: 200, headers });
  } catch (error) {
    const known = error instanceof BoundRequestError;
    const status = known ? error.status : 503;
    const code = known ? error.code : "temporarily_unavailable";
    // Never log bodies, handles, approval codes, proofs, keys or SQL exceptions.
    return new Response(JSON.stringify({ ok: false, code, request_id: requestId }), {
      status, headers: status === 429 ? { ...headers, "retry-after": "60" } : headers,
    });
  }
}
