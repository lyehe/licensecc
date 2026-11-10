import type { IdempotencyCommit, MutationContext, MutationEnv } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type {
  PlanProjectionApplyInput,
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionPreview,
  PlanProjectionPreviewResponse,
} from "@licensecc/licensing-domain/catalog/plan_projection";

export type {
  PlanProjectionApplyInput,
  PlanProjectionApplyResult,
  PlanProjectionInput,
  PlanProjectionPreview,
  PlanProjectionPreviewResponse,
} from "@licensecc/licensing-domain/catalog/plan_projection";

export function previewPlanProjection(
  env: MutationEnv,
  input: PlanProjectionInput,
  actorSubject: string,
  now?: number,
): Promise<PlanProjectionPreviewResponse>;

export function applyPlanProjection(
  env: MutationEnv,
  previewId: string,
  ctx: MutationContext,
  idempotency: IdempotencyCommit | null,
  now?: number,
): Promise<PlanProjectionApplyResult>;
