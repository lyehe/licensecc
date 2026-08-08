import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import { syncEntitlement } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { requestId, safeString } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env } from "../../env.js";
import { authenticateSync } from "../../auth.js";
import { MAX_NOTES_SIZE, parseJsonBody, safeNotes } from "../../request.js";
import { clientIp } from "../../support.js";
import { validateEntitlementInput } from "../entitlements/validation.js";
function syncReason(value: unknown): string | null {
  if (value === undefined || value === "") {
    return "";
  }
  return safeString(value, MAX_NOTES_SIZE);
}

export async function handleSync(request: Request, env: Env): Promise<Response> {
  const id = requestId(request);
  if (request.method !== "POST" || new URL(request.url).pathname !== "/api/sync/entitlements") {
    return envelope(id, "not_found", undefined, 404);
  }
  const auth = await authenticateSync(request, env, id);
  if (auth instanceof Response) {
    return auth;
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(id, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, id);
  if (body instanceof Response) {
    return body;
  }
  const bodyRecord = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const input = validateEntitlementInput(body);
  const reason = syncReason(bodyRecord.reason);
  if (input === null || reason === null) {
    return envelope(id, "invalid_request", undefined, 400);
  }
  if ((input.status === "disabled" || input.status === "revoked") && reason === "") {
    return envelope(id, "reason_required", undefined, 400);
  }
  const ctx: MutationContext = {
    actor: auth,
    requestId: id,
    ip: clientIp(request),
    idempotencyKey: idempotencyKey ?? null,
    source: "sync",
  };
  return mutationResponse(request, env, ctx, "entitlement_synced", (idempotency) =>
    syncEntitlement(env, input, reason, ctx, idempotency));
}
