import type { EntitlementCreateInput, EntitlementInput, Policy } from "../../../shared/api.js";
import type { Env } from "../../env.js";
import type { ReplayAdmission } from "../../idempotency.js";
import { validateEntitlementInput } from "./validation.js";
import { stampFromPolicy } from "@licensecc/licensing-domain/entitlements/policy";
import { createEntitlement, type MutationContext, type IdempotencyCommit, type D1PreparedStatementLike } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";

export async function createWithEnforcement(env: Env, input: EntitlementCreateInput, ctx: MutationContext,
  idempotency: IdempotencyCommit | null, statements: D1PreparedStatementLike[] = [], policy?: Policy) {
  try {
    if (input.enforcement_mode === "device_bound_v1" && validateEntitlementCreate(input) === null) throw new Error("protected_creation_conflict");
    return await createEntitlement(env, input, ctx, "", undefined, idempotency,
      input.enforcement_mode === "device_bound_v1" ? [...statements, protectedCreateAssertion(env, input, policy)] : statements);
  } catch (error) {
    if (input.enforcement_mode === "device_bound_v1" && error instanceof Error && /malformed JSON|capacity_in_use/i.test(error.message)) {
      throw new Error("protected_creation_conflict");
    }
    throw error;
  }
}

export function validateEntitlementCreate(value: unknown): EntitlementCreateInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { enforcement_mode: mode, ...rest } = value as Record<string, unknown>;
  if (rest.policy_id !== undefined && rest.policy_id !== null && rest.policy_id !== "" && (typeof rest.policy_id !== "string" || rest.policy_id.length > 128)) return null;
  if (typeof rest.policy_id === "string" && rest.policy_id !== "" && rest.assertion_ttl_seconds === null) return null;
  if (Object.hasOwn(value, "enforcement_mode") && mode !== "legacy" && mode !== "device_bound_v1") return null;
  const input = validateEntitlementInput(rest);
  if (mode === "device_bound_v1" && input !== null && (
    !/^[A-Za-z0-9_.:-]{1,127}(?![\s\S])/.test(input.project) || !/^[A-Za-z0-9_.:-]{1,15}(?![\s\S])/.test(input.feature)
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

// Compare all fields used by stampFromPolicy, including nullable values. An
// updated_at comparison alone misses changes made within the same second.
const POLICY_FIELDS = ["id", "project", "status", "type", "valid_from_offset_sec", "duration_sec", "assertion_ttl_seconds",
  "pool_size", "max_active_devices", "max_borrow_sec", "expiry_strategy", "trial_expiration_basis", "trial_duration_sec",
  "trial_one_per_device", "trial_require_device_proof", "meter_quota", "meter_period_sec"] as const;

export function protectedCreateAssertion(env: Env, input: EntitlementInput, policy?: Policy): D1PreparedStatementLike {
  const stamp = policy === undefined ? undefined : stampFromPolicy(policy, input, 0);
  const expected = stamp === undefined ? [] : Object.entries({ policy_id: policy?.id, ...stamp.capacity, ...stamp.trial });
  const policyGuard = policy === undefined ? "1" : `EXISTS (SELECT 1 FROM entitlement_policies p WHERE ${POLICY_FIELDS.map(field => `p.${field} IS ?`).join(" AND ")} AND p.status='active' AND p.project=e.project)`;
  // SELECT does not alter changes(), so the following audit/cache statements
  // still observe the claim/stamp. Failure raises inside D1's batch and rolls
  // back the preceding write; it never reports a failure after partial commit.
  return env.DB.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS (
    SELECT 1 FROM entitlements e WHERE e.project=? AND e.feature=? AND e.license_fingerprint=?
      AND e.enforcement_mode='device_bound_v1' AND e.device_hash='' AND e.pool_size=0
      AND (e.valid_from IS NULL OR (typeof(e.valid_from)='integer' AND e.valid_from BETWEEN 0 AND 9007199254740991))
      AND (e.valid_until IS NULL OR (typeof(e.valid_until)='integer' AND e.valid_until BETWEEN 0 AND 9007199254740991))
      AND (e.valid_from IS NULL OR e.valid_until IS NULL OR e.valid_from<e.valid_until)
      AND typeof(e.max_active_devices)='integer' AND e.max_active_devices BETWEEN 1 AND 1000000
      AND e.customer_id IS ? AND e.license_id IS ?
      AND EXISTS (SELECT 1 FROM customers c WHERE c.id=e.customer_id AND c.status='active')
      AND EXISTS (SELECT 1 FROM licenses l WHERE l.id=e.license_id AND l.customer_id=e.customer_id AND l.project=e.project)
      AND NOT EXISTS (SELECT 1 FROM entitlements other WHERE other.project=e.project AND
        ((other.license_id=e.license_id AND other.license_fingerprint<>e.license_fingerprint)
        OR (other.license_fingerprint=e.license_fingerprint AND (other.license_id IS NOT e.license_id OR other.customer_id IS NOT e.customer_id))))
      AND NOT EXISTS (SELECT 1 FROM license_plan_assignments a WHERE a.project=e.project AND a.license_id=e.license_id AND a.license_fingerprint<>e.license_fingerprint)
      AND NOT EXISTS (SELECT 1 FROM lease_issuance h WHERE h.project=e.project AND h.feature=e.feature AND h.license_fingerprint=e.license_fingerprint)
      AND NOT EXISTS (SELECT 1 FROM entitlement_devices h WHERE h.project=e.project AND h.feature=e.feature AND h.license_fingerprint=e.license_fingerprint)
      AND NOT EXISTS (SELECT 1 FROM seat_checkouts h WHERE h.project=e.project AND h.feature=e.feature AND h.license_fingerprint=e.license_fingerprint)
      AND NOT EXISTS (SELECT 1 FROM usage_events h WHERE h.project=e.project AND h.feature=e.feature AND h.license_fingerprint=e.license_fingerprint)
      AND NOT EXISTS (SELECT 1 FROM entitlement_events h WHERE h.project=e.project AND h.feature=e.feature AND h.license_fingerprint=e.license_fingerprint
        AND CASE WHEN json_valid(h.next_json) THEN json_extract(h.next_json,'$.enforcement_mode') IS NOT 'device_bound_v1' ELSE 1 END)
      AND (e.is_trial=0 OR (e.is_trial=1 AND e.trial_one_per_device IN (0,1) AND e.trial_require_device_proof IN (0,1)
        AND ((e.trial_expiration_basis='from_issue' AND typeof(e.valid_until)='integer' AND e.valid_until>unixepoch())
          OR (e.trial_expiration_basis IN ('from_first_activation','from_first_use') AND typeof(e.trial_duration_sec)='integer'
            AND e.trial_duration_sec BETWEEN 2 AND 3153600000))))
      AND ${policyGuard}
      AND ${expected.length === 0 ? "1" : expected.map(([field]) => `e.${field} IS ?`).join(" AND ")}
    ) THEN 1 ELSE json('protected_creation_conflict') END`)
    .bind(input.project, input.feature, input.license_fingerprint, input.customer_id ?? null, input.license_id ?? null,
      ...(policy === undefined ? [] : POLICY_FIELDS.map(field => policy[field])), ...expected.map(([, value]) => value));
}
