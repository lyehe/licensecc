import { MAX_DEVICE_LIMIT, PROTECTED_CREATE_REASONS, type EntitlementInput, type ProtectedCreateReason } from "../../../shared/api.js";
import type { Env } from "../../env.js";
import { stampFromPolicy, type Policy } from "@licensecc/licensing-domain/entitlements/policy";
import type { D1PreparedStatementLike } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import { boundOccupiedSql } from "@licensecc/cloudflare-runtime/device/bound_capacity";

/** What a protected create writes: its input, and without a policy possibly its own device limit. */
type CreateInput = EntitlementInput & { max_active_devices?: number };

// Every protected-create rule is written once, here, and tagged with the reason an operator is
// told. protectedCreateAssertion ANDs the list inside the create batch; protectedCreateReason walks
// the same list, in the same order, after a refused batch has rolled back. Never copy a predicate
// into either query: a reason that drifted from the rule it names sends the operator after the
// wrong fix.
export interface ProtectedCheck {
  readonly reason: ProtectedCreateReason;
  /** True when the rule holds for the entitlement row aliased `e`. */
  readonly sql: string;
  readonly binds: readonly unknown[];
}

// Compare all fields used by stampFromPolicy, including nullable values. An
// updated_at comparison alone misses changes made within the same second.
const POLICY_FIELDS = ["id", "project", "status", "type", "valid_from_offset_sec", "duration_sec", "max_active_devices",
  "expiry_strategy", "trial_expiration_basis", "trial_duration_sec", "trial_one_per_device"] as const;

// The provenance, capacity and trial columns the would-be row models, with the schema default each
// keeps when a create writes none of them (pinned to schema.sql by the SQL suite). A policy stamp
// writes policy_id, the device limit and the trial state. A create that updates an existing
// grant keeps that grant's values for every column it does not write.
export const STAMP_COLUMN_DEFAULTS = {
  policy_id: null, max_active_devices: 1,
  is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0,
} as const;
type StampColumn = keyof typeof STAMP_COLUMN_DEFAULTS;

const sameKey = (alias: string): string => `${alias}.project=e.project AND ${alias}.feature=e.feature AND ${alias}.license_fingerprint=e.license_fingerprint`;

/**
 * The stamp columns this create writes after its upsert: a policy's stamp (provenance, device limit
 * and trial state, as buildPolicyStampStatement writes them), or, without a policy, only the device
 * limit it sets on its own (createWithEnforcement's side-write).
 */
function stampColumns(input: CreateInput, policy?: Policy): Partial<Record<StampColumn, unknown>> {
  if (policy === undefined) return input.max_active_devices === undefined ? {} : { max_active_devices: input.max_active_devices };
  const stamp = stampFromPolicy(policy, input, 0);
  return { policy_id: policy.id, max_active_devices: stamp.capacity.max_active_devices, ...stamp.trial };
}

export function protectedCreateChecks(input: CreateInput, policy?: Policy): readonly ProtectedCheck[] {
  const expected = Object.entries(stampColumns(input, policy));
  // A policy's stamp is compared under policy_mismatch; a create's own writes are integrity.
  const ownWrites = policy === undefined ? expected : [];
  return [
    { reason: "customer_inactive", sql: "EXISTS (SELECT 1 FROM customers c WHERE c.id=e.customer_id AND c.status='active')", binds: [] },
    { reason: "license_missing", sql: "EXISTS (SELECT 1 FROM licenses l WHERE l.id=e.license_id)", binds: [] },
    { reason: "license_customer_mismatch", sql: "EXISTS (SELECT 1 FROM licenses l WHERE l.id=e.license_id AND l.customer_id=e.customer_id AND l.project=e.project)", binds: [] },
    // Another row pairs this license or fingerprint differently. The key's own row is excluded: in
    // the batch that is e itself, which never matches; after a rollback it is the pre-update grant.
    { reason: "fingerprint_in_use", sql: `NOT EXISTS (SELECT 1 FROM entitlements other WHERE other.project=e.project
        AND NOT (other.feature=e.feature AND other.license_fingerprint=e.license_fingerprint)
        AND ((other.license_id=e.license_id AND other.license_fingerprint<>e.license_fingerprint)
          OR (other.license_fingerprint=e.license_fingerprint AND (other.license_id IS NOT e.license_id OR other.customer_id IS NOT e.customer_id))))`, binds: [] },
    { reason: "plan_assignment_conflict", sql: "NOT EXISTS (SELECT 1 FROM license_plan_assignments a WHERE a.project=e.project AND a.license_id=e.license_id AND a.license_fingerprint<>e.license_fingerprint)", binds: [] },
    // The policy is unchanged since it was read, and the stamp wrote exactly its values.
    { reason: "policy_mismatch", sql: policy === undefined ? "1" : `EXISTS (SELECT 1 FROM entitlement_policies p WHERE ${POLICY_FIELDS.map((field) => `p.${field} IS ?`).join(" AND ")} AND p.status='active' AND p.project=e.project)
      AND ${expected.map(([column]) => `e.${column} IS ?`).join(" AND ")}`,
    binds: policy === undefined ? [] : [...POLICY_FIELDS.map((field) => policy[field]), ...expected.map(([, value]) => value)] },
    { reason: "invalid_trial", sql: `e.is_trial=0 OR (e.is_trial=1 AND e.trial_one_per_device IN (0,1)
      AND ((e.trial_expiration_basis='from_issue' AND typeof(e.valid_until)='integer' AND e.valid_until>unixepoch())
        OR (e.trial_expiration_basis IN ('from_first_activation','from_first_use') AND typeof(e.trial_duration_sec)='integer'
          AND e.trial_duration_sec BETWEEN 2 AND 3153600000)))`, binds: [] },
    // A grant keeps its customer while it has connected devices (tr_bound_owner_change, ADR 0006).
    // In the batch the key's row is e itself, which never differs; after a rollback it is the
    // stored grant, so the diagnostic sees a move to another customer.
    { reason: "devices_connected", sql: `NOT EXISTS (SELECT 1 FROM entitlements cur WHERE ${sameKey("cur")} AND cur.customer_id IS NOT e.customer_id
        AND EXISTS (SELECT 1 FROM device_bound_bindings b WHERE ${sameKey("b")} AND ${boundOccupiedSql("b", "unixepoch()")}))`, binds: [] },
    { reason: "invalid_capacity", sql: `typeof(e.max_active_devices)='integer' AND e.max_active_devices BETWEEN 1 AND ${MAX_DEVICE_LIMIT}`, binds: [] },
    // Integrity rules with no operator-specific fix: the row is exactly what this create wrote.
    { reason: "unknown", sql: `(e.valid_from IS NULL OR (typeof(e.valid_from)='integer' AND e.valid_from BETWEEN 0 AND 9007199254740991))
      AND (e.valid_until IS NULL OR (typeof(e.valid_until)='integer' AND e.valid_until BETWEEN 0 AND 9007199254740991))
      AND (e.valid_from IS NULL OR e.valid_until IS NULL OR e.valid_from<e.valid_until)
      AND e.customer_id IS ? AND e.license_id IS ?${ownWrites.map(([column]) => ` AND e.${column} IS ?`).join("")}`,
    binds: [input.customer_id ?? null, input.license_id ?? null, ...ownWrites.map(([, value]) => value)] },
  ];
}

export function protectedCreateAssertion(env: Env, input: CreateInput, policy?: Policy): D1PreparedStatementLike {
  const checks = protectedCreateChecks(input, policy);
  // SELECT does not alter changes(), so the following audit/cache statements
  // still observe the claim/stamp. Failure raises inside D1's batch and rolls
  // back the preceding write; it never reports a failure after partial commit.
  return env.DB.prepare(`SELECT CASE WHEN changes()=1 AND EXISTS (
    SELECT 1 FROM entitlements e WHERE e.project=? AND e.feature=? AND e.license_fingerprint=?
      AND ${checks.map((check) => `(${check.sql})`).join("\n      AND ")}
    ) THEN 1 ELSE json('protected_creation_conflict') END`)
    .bind(input.project, input.feature, input.license_fingerprint, ...checks.flatMap((check) => check.binds));
}

/**
 * The row a create would have written, as a CTE named `e`: its input columns, its policy stamp or
 * its own device limit, and otherwise what an existing grant with this key keeps (or the
 * schema default). Values travel as one JSON document so json_extract types numbers the way an
 * INTEGER column stores them.
 * A create that writes another column before the assertion must model it here too; the SQL suite
 * compares this row with the committed one after real creates.
 */
export function protectedWouldBeRowQuery(input: CreateInput, policy?: Policy): { sql: string; binds: unknown[] } {
  const stamp = stampColumns(input, policy);
  const written = {
    project: input.project, feature: input.feature, license_fingerprint: input.license_fingerprint,
    valid_from: input.valid_from ?? null, valid_until: input.valid_until ?? null, customer_id: input.customer_id ?? null, license_id: input.license_id ?? null,
    ...stamp,
  };
  const kept = Object.entries(STAMP_COLUMN_DEFAULTS).filter(([column]) => !(column in stamp))
    .map(([column, fallback]) => `${fallback === null ? `x.${column}` : `coalesce(x.${column}, ${fallback})`} AS ${column}`);
  return {
    sql: `WITH w(doc) AS (SELECT ?),
    x AS (SELECT ${Object.keys(STAMP_COLUMN_DEFAULTS).join(", ")} FROM entitlements WHERE project=? AND feature=? AND license_fingerprint=?),
    e AS (SELECT ${[...Object.keys(written).map((column) => `json_extract(w.doc,'$.${column}') AS ${column}`), ...kept].join(", ")} FROM w LEFT JOIN x ON 1)`,
    binds: [JSON.stringify(written), input.project, input.feature, input.license_fingerprint],
  };
}

/**
 * Names the first rule a refused create broke, after its batch rolled back, by walking the checks
 * against the would-be row. A key that already has a row, with every rule holding, means the claim
 * lost to a concurrent write.
 */
export async function protectedCreateReason(env: Env, input: CreateInput, policy?: Policy): Promise<ProtectedCreateReason> {
  const checks = protectedCreateChecks(input, policy);
  const wouldBe = protectedWouldBeRowQuery(input, policy);
  const sql = `${wouldBe.sql}
    SELECT CASE ${checks.map((check) => `WHEN NOT coalesce((${check.sql}), 0) THEN '${check.reason}'`).join("\n      ")}
      WHEN EXISTS (SELECT 1 FROM entitlements s WHERE ${sameKey("s")}) THEN 'fingerprint_in_use'
      ELSE 'unknown' END AS reason FROM e`;
  try {
    const row = await env.DB.prepare(sql).bind(...wouldBe.binds, ...checks.flatMap((check) => check.binds)).first<{ reason: unknown }>();
    return PROTECTED_CREATE_REASONS.find((reason) => reason === row?.reason) ?? "unknown";
  } catch {
    return "unknown";
  }
}

// The owner and license rules a PATCH that moves a grant must meet, as a protected create does: a
// real, active customer, and a license that exists and that customer owns for this project. They
// are the create's own checks, named by the same reasons. A PATCH may leave a grant without a
// license, so the license rules hold when it names or keeps none.
const OWNER_RULES: ReadonlySet<ProtectedCreateReason> = new Set(["customer_inactive", "license_missing", "license_customer_mismatch"]);

/** The first owner or license rule the grant a PATCH would leave breaks, or null when every one holds. */
export async function protectedOwnerReason(env: Env, row: CreateInput & { license_id: string | null }): Promise<ProtectedCreateReason | null> {
  const checks = protectedCreateChecks(row).filter((check) => OWNER_RULES.has(check.reason));
  const holds = (check: ProtectedCheck): string => check.reason === "customer_inactive" ? `(${check.sql})` : `(e.license_id IS NULL OR (${check.sql}))`;
  const result = await env.DB.prepare(`WITH e(project, customer_id, license_id) AS (SELECT ?, ?, ?)
    SELECT CASE ${checks.map((check) => `WHEN NOT coalesce(${holds(check)}, 0) THEN '${check.reason}'`).join(" ")} END AS reason FROM e`)
    .bind(row.project, row.customer_id, row.license_id, ...checks.flatMap((check) => check.binds)).first<{ reason: unknown }>();
  return PROTECTED_CREATE_REASONS.find((reason) => reason === result?.reason) ?? null;
}

/**
 * A create refused with capacity_in_use broke one of two schema triggers: moving a grant with
 * connected devices to another customer (tr_bound_owner_change, which the upsert fires before any
 * capacity write), or a device limit below them (tr_bound_capacity_decrease). The list's
 * owner-change rule, asked alone of the would-be row, tells them apart.
 */
export async function protectedCapacityReason(env: Env, input: CreateInput, policy?: Policy): Promise<ProtectedCreateReason> {
  const owner = protectedCreateChecks(input, policy).find((check) => check.reason === "devices_connected");
  if (owner === undefined) return "invalid_capacity";
  const wouldBe = protectedWouldBeRowQuery(input, policy);
  try {
    const row = await env.DB.prepare(`${wouldBe.sql}
    SELECT coalesce((${owner.sql}), 0) AS holds FROM e`).bind(...wouldBe.binds, ...owner.binds).first<{ holds: unknown }>();
    return row?.holds === 0 ? "devices_connected" : "invalid_capacity";
  } catch {
    return "invalid_capacity";
  }
}
