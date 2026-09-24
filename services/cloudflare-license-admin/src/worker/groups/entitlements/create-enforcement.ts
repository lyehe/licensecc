import type { EntitlementCreateInput, EntitlementRecord, Policy, ProtectedCreateReason } from "../../../shared/api.js";
import type { Env } from "../../env.js";
import type { ReplayAdmission } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import { validateEntitlementInput } from "./validation.js";
import { protectedCreateAssertion, protectedCreateReason } from "./protected-checks.js";
import { createEntitlement, type MutationContext, type MutationResult, type IdempotencyCommit, type D1PreparedStatementLike } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";

/** Protected project IDs; license creation applies the same rule so its records can back a grant. */
export const PROTECTED_PROJECT = /^[A-Za-z0-9_.:-]{1,127}(?![\s\S])/;

export async function createWithEnforcement(env: Env, input: EntitlementCreateInput, ctx: MutationContext,
  idempotency: IdempotencyCommit | null, statements: D1PreparedStatementLike[] = [], policy?: Policy): Promise<MutationResult<EntitlementRecord> | Response | null> {
  if (input.enforcement_mode !== "device_bound_v1") return createEntitlement(env, input, ctx, "", undefined, idempotency, statements);
  if (validateEntitlementCreate(input) === null) return protectedCreationConflict(ctx, "unknown");
  try {
    return await createEntitlement(env, input, ctx, "", undefined, idempotency, [...statements, protectedCreateAssertion(env, input, policy)]);
  } catch (error) {
    // The capacity trigger names its own rule. The assertion's json() failure names none, so the
    // diagnostic runs only here, after D1 has rolled the whole batch back.
    if (error instanceof Error && /capacity_in_use/i.test(error.message)) return protectedCreationConflict(ctx, "invalid_capacity");
    if (error instanceof Error && /malformed JSON/i.test(error.message)) return protectedCreationConflict(ctx, await protectedCreateReason(env, input, policy));
    throw error;
  }
}

// The status and code are unchanged; data.reason names the rule. Like every per-resource error
// Response, mutationResponse checks for a same-key winner first and never caches this one.
function protectedCreationConflict(ctx: MutationContext, reason: ProtectedCreateReason): Response {
  return envelope(ctx.requestId, "protected_creation_conflict", { reason }, 409);
}

export function validateEntitlementCreate(value: unknown): EntitlementCreateInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { enforcement_mode: mode, ...rest } = value as Record<string, unknown>;
  if (rest.policy_id !== undefined && rest.policy_id !== null && rest.policy_id !== "" && (typeof rest.policy_id !== "string" || rest.policy_id.length > 128)) return null;
  if (typeof rest.policy_id === "string" && rest.policy_id !== "" && rest.assertion_ttl_seconds === null) return null;
  if (Object.hasOwn(value, "enforcement_mode") && mode !== "legacy" && mode !== "device_bound_v1") return null;
  const input = validateEntitlementInput(rest);
  if (mode === "device_bound_v1" && input !== null && (
    !PROTECTED_PROJECT.test(input.project) || !/^[A-Za-z0-9_.:-]{1,15}(?![\s\S])/.test(input.feature)
    || input.license_fingerprint.length !== 64 || !/^[a-f0-9]{64}$/.test(input.license_fingerprint)
    || [input.valid_from, input.valid_until].some(value => value !== null && value !== undefined && !Number.isSafeInteger(value))
  )) return null;
  return input === null ? null : mode === undefined ? input : { ...input, enforcement_mode: mode as "legacy" | "device_bound_v1" };
}

export function createReplayAdmission(input: EntitlementCreateInput): ReplayAdmission | undefined {
  if (input.enforcement_mode === undefined) return undefined;
  return value => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    if (body.ok !== true || body.code !== "entitlement_saved" || typeof body.data !== "object" || body.data === null) return false;
    const row = body.data as Record<string, unknown>;
    return row.project === input.project && row.feature === input.feature && row.license_fingerprint === input.license_fingerprint
      && row.enforcement_mode === input.enforcement_mode;
  };
}
