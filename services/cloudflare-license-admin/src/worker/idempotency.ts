import type {
  D1DatabaseLike,
  IdempotencyCommit,
  MutationContext,
  MutationResult,
} from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { envelope, json } from "./responses.js";
import { safeString } from "@licensecc/cloudflare-runtime/http/kit";
import {
  readIdempotentResponse,
  writeIdempotentResponse,
} from "@licensecc/cloudflare-runtime/d1/idempotency_store";

interface IdempotencyEnv {
  DB: D1DatabaseLike;
}

export const INVALID_IDEMPOTENCY_KEY = Symbol("invalid_idempotency_key");

export function readIdempotencyKey(request: Request): string | null | typeof INVALID_IDEMPOTENCY_KEY {
  const idempotencyKey = safeString(request.headers.get("idempotency-key"), 128);
  if (request.headers.has("idempotency-key") && idempotencyKey === null) {
    return INVALID_IDEMPOTENCY_KEY;
  }
  return idempotencyKey;
}

export async function idempotentReplay(env: IdempotencyEnv, scope: string, key: string | null): Promise<Response | null> {
  const raw = await readIdempotentResponse(env.DB, scope, key);
  if (raw === null) {
    return null;
  }
  return json(JSON.parse(raw), 200, { "x-idempotent-replay": "1" });
}

export async function rememberIdempotency(
  env: IdempotencyEnv,
  scope: string,
  key: string | null,
  body: unknown,
  now: number,
): Promise<void> {
  await writeIdempotentResponse(env.DB, scope, key, JSON.stringify(body), now);
}

export async function mutationResponse<T>(
  request: Request,
  env: IdempotencyEnv,
  ctx: MutationContext,
  code: string,
  fn: (idempotency: IdempotencyCommit | null) => Promise<MutationResult<T> | Response | null>,
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
    // A handler that discovers a per-resource error mid-mutation (a 4xx/5xx conflict,
    // not-found, or validation envelope its own error codes describe) returns that
    // Response directly; it is never cached, matching the pre-mutationResponse ceremony
    // where only the success path called rememberIdempotency.
    if (result instanceof Response) {
      return result;
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
