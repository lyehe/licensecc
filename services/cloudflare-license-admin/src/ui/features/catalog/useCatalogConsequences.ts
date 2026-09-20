import type { CatalogFeature, CatalogPlan, CatalogPlanFeature } from "../../../shared/api";
import { focusTargetInRow, type ConfirmActionContext, type ConfirmActionOutcome, useOperatorControls } from "../../shared/controls";
import { disableCatalogFeatureConfirm, disableCatalogPlanConfirm, disableCatalogPlanFeatureConfirm } from "./workflow";

interface Transition<T> {
  run: (record: T, action: "disable" | "reenable", idempotencyKey: string) => Promise<ConfirmActionOutcome>;
  isCurrent: () => boolean;
}

export function useCatalogConsequences(plan: Transition<CatalogPlan>, feature: Transition<CatalogFeature>, planFeature: Transition<CatalogPlanFeature>): {
  requestPlanDisable: (record: CatalogPlan) => void;
  runPlanReenable: (record: CatalogPlan) => void;
  requestFeatureDisable: (record: CatalogFeature) => void;
  runFeatureReenable: (record: CatalogFeature) => void;
  requestPlanFeatureDisable: (record: CatalogPlanFeature) => void;
  runPlanFeatureReenable: (record: CatalogPlanFeature) => void;
} {
  const { requestConfirm, runConsequenceAction } = useOperatorControls();
  function disable<T>(record: T, transition: Transition<T>, title: string, body: string, rowKey: string): void {
    requestConfirm({ title, body, requiresReason: true, run: ({ idempotencyKey }: ConfirmActionContext) => transition.run(record, "disable", idempotencyKey), successFocusTarget: focusTargetInRow(rowKey, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: transition.isCurrent });
  }
  function reenable<T>(record: T, transition: Transition<T>, rowKey: string): void {
    void runConsequenceAction({ run: ({ idempotencyKey }: ConfirmActionContext) => transition.run(record, "reenable", idempotencyKey), successFocusTarget: focusTargetInRow(rowKey, ['button[data-focus-action="reenable"]', ".status"]), isCurrent: transition.isCurrent });
  }
  return {
    requestPlanDisable: (record) => disable(record, plan, "Disable plan", disableCatalogPlanConfirm(record), `catalog-plan:${record.id}`),
    runPlanReenable: (record) => reenable(record, plan, `catalog-plan:${record.id}`),
    requestFeatureDisable: (record) => disable(record, feature, "Disable feature", disableCatalogFeatureConfirm(record), `catalog-feature:${record.id}`),
    runFeatureReenable: (record) => reenable(record, feature, `catalog-feature:${record.id}`),
    requestPlanFeatureDisable: (record) => disable(record, planFeature, "Disable plan row", disableCatalogPlanFeatureConfirm(record), `catalog-plan-feature:${record.plan_id}:${record.feature_key}`),
    runPlanFeatureReenable: (record) => reenable(record, planFeature, `catalog-plan-feature:${record.plan_id}:${record.feature_key}`),
  };
}
