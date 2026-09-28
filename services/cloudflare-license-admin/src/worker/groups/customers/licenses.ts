import { batchReturnedRow, type Actor } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { CreatedLicense } from "../../../shared/api.js";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { idempotentReplay, INVALID_IDEMPOTENCY_KEY, readIdempotencyKey } from "../../idempotency.js";
import { parseJsonBody } from "../../request.js";
import { envelope, json } from "../../responses.js";
import { PROTECTED_PROJECT } from "../entitlements/create-enforcement.js";

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

// POST /api/admin/customers/{id}/licenses: one `licenses` row a protected entitlement can reference.
// The active-customer check lives in the INSERT itself, so a suspension that lands after the replay
// read still refuses the write, and a replay record is written only beside a written row.
export async function createCustomerLicense(request: Request, env: Env, actor: Actor, customerId: string, rid: string): Promise<Response> {
  const denied = requireAdmin(actor, rid);
  if (denied) return denied;
  const key = readIdempotencyKey(request);
  if (!key || key === INVALID_IDEMPOTENCY_KEY) return envelope(rid, "invalid_idempotency_key", undefined, 400);
  const input = await parseJsonBody(request, rid);
  if (input instanceof Response) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return envelope(rid, "invalid_request", undefined, 400);
  const body = input as Record<string, unknown>;
  const project = typeof body.project === "string" && PROTECTED_PROJECT.test(body.project) ? body.project : null;
  const label = body.label === undefined ? "" : typeof body.label === "string" ? body.label.trim() : null;
  if (project === null || label === null || label.length > 128 || Array.from(label).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return envelope(rid, "invalid_request", undefined, 400);
  const scope = `POST:/api/admin/customers/${encodeURIComponent(customerId)}/licenses:${actor.subject}`;
  const replay = await idempotentReplay(env, scope, key);
  if (replay) return noStore(replay);
  if (!env.DB.batch) return envelope(rid, "mutation_failed", undefined, 500);
  const now = Math.floor(Date.now() / 1000);
  const data: CreatedLicense = { id: `lic_${crypto.randomUUID()}`, customer_id: customerId, project, label, created_at: now };
  const response = { ok: true, code: "license_created", request_id: rid, data };
  let written: unknown[];
  try {
    written = await env.DB.batch([
      env.DB.prepare("INSERT INTO licenses (id,customer_id,project,label,metadata_json,created_at,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM customers WHERE id=? AND status='active') RETURNING id")
        .bind(data.id, customerId, project, label, JSON.stringify({ created_by: actor.subject, created_request_id: rid, source: "admin" }), now, now, customerId),
      // Cache only public data. A raced same-key claim rolls back the entire batch.
      env.DB.prepare("INSERT INTO mutation_idempotency (scope,idempotency_key,response_json,created_at) SELECT ?,?,?,? WHERE changes()=1").bind(scope, key, JSON.stringify(response), now),
    ]);
  } catch {
    const raced = await idempotentReplay(env, scope, key);
    if (raced) return noStore(raced);
    return envelope(rid, "mutation_failed", undefined, 500);
  }
  if (batchReturnedRow(written[0]) === null) {
    const customer = await env.DB.prepare("SELECT status FROM customers WHERE id=?").bind(customerId).first();
    return customer === null ? envelope(rid, "not_found", undefined, 404) : envelope(rid, "customer_inactive", undefined, 409);
  }
  return json(response, 200, { "cache-control": "no-store" });
}
