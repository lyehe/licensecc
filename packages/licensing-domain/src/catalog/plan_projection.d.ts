import type { EntitlementRecord } from "../entitlements/contracts";

export interface PlanProjectionInput {
  project: string;
  license_id: string;
  license_fingerprint: string;
  customer_id?: string | null;
  plan_id?: string | null;
  plan_key?: string | null;
  support_until?: number | null;
  addons?: string[] | null;
  notes?: string | null;
}

/** The normalized, fail-closed input consumed by the projection algorithm. */
export interface NormalizedPlanProjectionInput {
  project: string;
  license_id: string;
  license_fingerprint: string;
  customer_id: string | null;
  plan_id: string | null;
  plan_key: string | null;
  support_until: number | null;
  support_until_provided: boolean;
  addons: string[];
  notes: string;
}

/** The complete entitlement payload derived from one catalog feature row. */
export interface PlanProjectionDesiredRow {
  input: {
    project: string;
    feature: string;
    license_fingerprint: string;
    device_hash: string;
    status: "active";
    notes: string;
    customer_id: string | null;
    license_id: string;
    assertion_ttl_seconds?: number;
    valid_from?: number | null;
    valid_until?: number | null;
  };
  policy_id: string | null;
  capacity: {
    pool_size: number;
    max_active_devices: number;
    max_borrow_sec: number;
    meter_quota: number;
    meter_period_sec: number;
  };
  trial: {
    is_trial: number;
    trial_expiration_basis: string | null;
    trial_duration_sec: number;
    trial_one_per_device: number;
    trial_require_device_proof: number;
  };
  source: string;
  addon_key: string | null;
  feature_name: unknown;
}

export interface ResolvedPlanProjectionPlan extends Record<string, unknown> {
  id: string;
  plan_key: string;
}

export function normalizePlanProjectionInput(input: PlanProjectionInput): NormalizedPlanProjectionInput;
export function desiredPlanProjectionRow(
  row: Record<string, unknown>,
  input: NormalizedPlanProjectionInput,
  now: number,
): PlanProjectionDesiredRow;
export function planProjectionMatchesDesired(existing: EntitlementRecord, desired: PlanProjectionDesiredRow): boolean;
export function classifyPlanProjection(input: {
  input: NormalizedPlanProjectionInput;
  plan: ResolvedPlanProjectionPlan;
  desired: PlanProjectionDesiredRow[];
  existingRows: EntitlementRecord[];
}): PlanProjectionPreview;

export interface PlanProjectionItem {
  project: string;
  feature: string;
  license_fingerprint: string;
  policy_id: string | null;
  source: "included" | "addon";
  addon_key: string | null;
  license_mode: "trial" | "floating" | "node_locked";
  status: "active" | "disabled" | "revoked";
  valid_from: number | null;
  valid_until: number | null;
  assertion_ttl_seconds: number;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  meter_quota: number;
  meter_period_sec: number;
  reason?: string;
  previous_status?: string;
}

export interface PlanProjectionPreview {
  plan: Record<string, unknown>;
  assignment: {
    project: string;
    license_id: string;
    license_fingerprint: string;
    customer_id: string | null;
    plan_id: string;
    plan_key: string;
    support_until: number | null;
    addons: string[];
  };
  desired: PlanProjectionItem[];
  will_create: PlanProjectionItem[];
  will_update: PlanProjectionItem[];
  will_disable: PlanProjectionItem[];
  blocked: PlanProjectionItem[];
  unchanged: PlanProjectionItem[];
  summary: {
    create: number;
    update: number;
    disable: number;
    blocked: number;
    unchanged: number;
  };
}
export interface PlanProjectionApplyResult extends PlanProjectionPreview {
  applied: {
    created: EntitlementRecord[];
    updated: EntitlementRecord[];
    disabled: EntitlementRecord[];
    assignment: Record<string, unknown> | null;
  };
}
