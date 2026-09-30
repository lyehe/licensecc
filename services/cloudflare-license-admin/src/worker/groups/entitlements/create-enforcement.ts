import type { AdminEntitlementCreateInput, EntitlementPatch, EntitlementRecord, ProtectedCreateReason } from "../../../shared/api.js";
import type { Policy } from "@licensecc/licensing-domain/entitlements/policy";
import type { Env } from "../../env.js";
import type { ReplayAdmission } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import { deviceLimit, ENTITLEMENT_CREATE_FIELDS, ENTITLEMENT_POLICY_CREATE_FIELDS, namesOnly, validateEntitlementInput } from "./validation.js";
import { protectedCapacityReason, protectedCreateAssertion, protectedCreateReason, protectedOwnerReason } from "./protected-checks.js";
import { createEntitlement, findEntitlement, syncEntitlement, type EntitlementKey, type GuardedMutationContext, type MutationContext, type MutationResult, type IdempotencyCommit, type D1PreparedStatementLike } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { buildDeviceLimitStatement } from "@licensecc/cloudflare-runtime/entitlements/policy_store";

/** Protected project IDs; license creation applies the same rule so its records can back a grant. */
export const PROTECTED_PROJECT = /^[A-Za-z0-9_.:-]{1,127}(?![\s\S])/;

/** The shared writer call a protected write makes, given its side statements and the protected assertion. */
type ProtectedWrite = (statements: D1PreparedStatementLike[]) => Promise<MutationResult<EntitlementRecord> | null>;

export async function createWithEnforcement(env: Env, input: AdminEntitlementCreateInput, ctx: MutationContext,
  idempotency: IdempotencyCommit | null, statements: D1PreparedStatementLike[] = [], policy?: Policy,
  write: ProtectedWrite = (extra) => createEntitlement(env, input, ctx, "", undefined, idempotency, extra)): Promise<MutationResult<EntitlementRecord> | Response | null> {
  // A create that selects no policy may set its own device limit (a policy stamps its own). Like the
  // stamp, it rides the create's claim, ahead of the protected assertion and the audit/replay records.
  const writes = policy === undefined && input.max_active_devices !== undefined
    ? [...statements, buildDeviceLimitStatement(env as never, input, input.max_active_devices)] : statements;
  if (validateEntitlementCreate(input) === null) return protectedCreationConflict(ctx, "unknown");
  try {
    return await write([...writes, protectedCreateAssertion(env, input, policy)]);
  } catch (error) {
    // Both capacity triggers abort with capacity_in_use; the list's owner-change rule tells them
    // apart. The assertion's json() failure names no rule, so the diagnostic runs only here, after
    // D1 has rolled the whole batch back.
    if (error instanceof Error && /capacity_in_use/i.test(error.message)) return protectedCreationConflict(ctx, await protectedCapacityReason(env, input, policy));
    if (error instanceof Error && /malformed JSON/i.test(error.message)) return protectedCreationConflict(ctx, await protectedCreateReason(env, input, policy));
    throw error;
  }
}

/**
 * A sync that creates a grant, or leaves or makes one active, writes the same protected grant as an
 * admin create, under the same checks. A disable or revocation of an existing grant always applies:
 * syncEntitlement makes it a status-only transition that keeps the stored owner and runs no
 * assertion, so no owner or row state can block it. An unchanged grant is a no-op.
 */
export function syncWithEnforcement(env: Env, input: AdminEntitlementCreateInput, reason: string, ctx: MutationContext,
  idempotency: IdempotencyCommit | null): Promise<MutationResult<EntitlementRecord> | Response | null> {
  return createWithEnforcement(env, input, ctx, idempotency, [], undefined,
    (extra) => syncEntitlement(env, input, reason, ctx, idempotency, extra));
}

/**
 * A PATCH that moves a grant to another customer or license is refused before any write, with the
 * protected create's reason, when the owner or license it would leave breaks a rule: an unknown or
 * suspended customer, or a license that is missing or another customer's. A PATCH that changes
 * neither is unaffected. It reads the grant it observed; a grant that is gone or has changed since
 * is left to the PATCH itself, which reports not_found or stale_transition.
 */
export async function protectedPatchRefusal(env: Env, key: EntitlementKey, patch: EntitlementPatch, ctx: GuardedMutationContext): Promise<Response | null> {
  if (patch.customer_id === undefined && patch.license_id === undefined) return null;
  const current = await findEntitlement(env, key);
  if (current === null || current.customer_id !== ctx.expectedEntitlement.customer_id || current.revocation_seq !== ctx.expectedEntitlement.revocation_seq) return null;
  const next = { ...key, customer_id: patch.customer_id ?? current.customer_id, license_id: patch.license_id !== undefined ? patch.license_id : current.license_id };
  if (next.customer_id === current.customer_id && next.license_id === current.license_id) return null;
  const reason = await protectedOwnerReason(env, next);
  return reason === null ? null : protectedCreationConflict(ctx, reason);
}

// The status and code are unchanged; data.reason names the rule. Like every per-resource error
// Response, mutationResponse checks for a same-key winner first and never caches this one.
function protectedCreationConflict(ctx: MutationContext, reason: ProtectedCreateReason): Response {
  return envelope(ctx.requestId, "protected_creation_conflict", { reason }, 409);
}

// Every create is protected, so a body names no mode. A create that selects a policy reads only the
// fields the stamp does not set: the policy stamps the grant's status and device limit.
export function validateEntitlementCreate(value: unknown): AdminEntitlementCreateInput | null {
  if (!namesOnly(value, ENTITLEMENT_CREATE_FIELDS)) return null;
  const { max_active_devices: limit, ...rest } = value;
  const selectsPolicy = rest.policy_id !== undefined && rest.policy_id !== null && rest.policy_id !== "";
  if (selectsPolicy && (!namesOnly(value, ENTITLEMENT_POLICY_CREATE_FIELDS) || typeof rest.policy_id !== "string" || rest.policy_id.length > 128)) return null;
  if (limit !== undefined && deviceLimit(limit) === undefined) return null;
  const input = validateEntitlementInput(rest);
  if (input === null || !PROTECTED_PROJECT.test(input.project) || !/^[A-Za-z0-9_.:-]{1,15}(?![\s\S])/.test(input.feature)
    || input.license_fingerprint.length !== 64 || !/^[a-f0-9]{64}$/.test(input.license_fingerprint)
    || [input.valid_from, input.valid_until].some(value => value !== null && value !== undefined && !Number.isSafeInteger(value))) return null;
  return { ...input, ...(limit === undefined ? {} : { max_active_devices: limit as number }) };
}

// A replay is conclusive only when the cached success is this exact tuple.
export function createReplayAdmission(input: AdminEntitlementCreateInput): ReplayAdmission {
  return value => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const body = value as Record<string, unknown>;
    if (body.ok !== true || body.code !== "entitlement_saved" || typeof body.data !== "object" || body.data === null) return false;
    const row = body.data as Record<string, unknown>;
    return row.project === input.project && row.feature === input.feature && row.license_fingerprint === input.license_fingerprint;
  };
}
