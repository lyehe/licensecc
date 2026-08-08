import type { MutationContext, MutationEnv } from "./entitlement_mutation";
import type {
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionPreview,
} from "@licensecc/licensing-domain/catalog/plan_projection";

export type {
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionPreview,
} from "@licensecc/licensing-domain/catalog/plan_projection";

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
