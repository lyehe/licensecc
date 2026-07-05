import type { EntitlementRecord, MutationContext, MutationEnv } from "../entitlements/entitlement_mutation";

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

export function previewPlanProjection(
  env: MutationEnv,
  input: PlanProjectionInput,
  now?: number,
): Promise<PlanProjectionPreview>;

export function applyPlanProjection(
  env: MutationEnv,
  input: PlanProjectionInput,
  ctx: MutationContext,
  now?: number,
): Promise<PlanProjectionApplyResult>;
