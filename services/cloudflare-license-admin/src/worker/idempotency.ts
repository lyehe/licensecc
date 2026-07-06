import type {
  D1DatabaseLike,
  IdempotencyCommit,
  MutationContext,
  MutationResult,
} from "@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation";
import { envelope, json } from "./responses.js";

interface IdempotencyEnv {
  DB: D1DatabaseLike;
}

export async function idempotentReplay(env: IdempotencyEnv, scope: string, key: string | null): Promise<Response | null> {
  if (key === null) {
    return null;
  }
  const row = await env.DB.prepare(
    "SELECT response_json FROM mutation_idempotency WHERE scope = ? AND idempotency_key = ? LIMIT 1",
  ).bind(scope, key).first<{ response_json: string }>();
  if (row === null) {
    return null;
  }
  return json(JSON.parse(row.response_json), 200, { "x-idempotent-replay": "1" });
}

export async function rememberIdempotency(
  env: IdempotencyEnv,
  scope: string,
  key: string | null,
  body: unknown,
  now: number,
): Promise<void> {
  if (key === null) {
    return;
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mutation_idempotency (scope, idempotency_key, response_json, created_at) VALUES (?, ?, ?, ?)",
  ).bind(scope, key, JSON.stringify(body), now).run();
}

export async function mutationResponse<T>(
  request: Request,
  env: IdempotencyEnv,
  ctx: MutationContext,
  code: string,
  fn: (idempotency: IdempotencyCommit | null) => Promise<MutationResult<T> | null>,
): Promise<Response> {
  const scope = `${request.method}:${new URL(request.url).pathname}:${ctx.actor.subject}`;
  const replay = await idempotentReplay(env, scope, ctx.idempotencyKey);
  if (replay !== null) {
    return replay;
  }
  try {
    const idempotency = ctx.idempotencyKey === null ? null : { scope, responseCode: code };
    const result = await fn(idempotency);
    if (result === null) {
      return envelope(ctx.requestId, "not_found", undefined, 404);
    }
    const body = { ok: true, code, request_id: ctx.requestId, data: result.data };
    if (!result.idempotencyRecorded) {
      await rememberIdempotency(env, scope, ctx.idempotencyKey, body, Math.floor(Date.now() / 1000));
    }
    return json(body);
  } catch (error) {
    if (error instanceof Error && error.message === "revoked_terminal") {
      return envelope(ctx.requestId, "revoked_entitlement_is_terminal", undefined, 409);
    }
    if (error instanceof Error && error.message === "invalid_patch") {
      return envelope(ctx.requestId, "invalid_request", undefined, 400);
    }
    if (error instanceof Error && error.message === "device_not_found") {
      return envelope(ctx.requestId, "device_not_found", undefined, 404);
    }
    if (error instanceof Error && error.message === "device_revoked_terminal") {
      return envelope(ctx.requestId, "device_is_terminal", undefined, 409);
    }
    return envelope(ctx.requestId, "mutation_failed", undefined, 500);
  }
}
