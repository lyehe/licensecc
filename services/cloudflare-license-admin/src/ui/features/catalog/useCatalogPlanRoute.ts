import { useLayoutEffect } from "react";

import type { CatalogPlan } from "../../../shared/api";
import { useAdminNavigation } from "../../app/navigation";

interface CatalogPlanRouteOptions {
  /** The routed plan id while its detail (not an editor over it) is shown. */
  planId: string | null;
  /** The current settled plans list; null while it loads, refreshes, or failed to read. */
  plans: readonly CatalogPlan[] | null;
  hasMore: boolean;
  selectedId: string;
  select: (plan: CatalogPlan) => void;
  loadMore: () => void;
}

/**
 * Resolves a plan detail address (reload, Back, Forward, or a deep link) against the settled plans
 * list: select the plan, page further while the list has more, or report it missing. Missing
 * replaces the entry with the list once, so the detail never stays open without a plan.
 */
export function useCatalogPlanRoute({ planId, plans, hasMore, selectedId, select, loadMore }: CatalogPlanRouteOptions): void {
  const { resolveMissingDrillDown } = useAdminNavigation();
  // A layout effect selects before paint, so a restored detail never shows the previous plan.
  useLayoutEffect(() => {
    if (planId === null || plans === null) return;
    const plan = plans.find((candidate) => candidate.id === planId);
    if (plan !== undefined) {
      if (plan.id !== selectedId) select(plan);
    } else if (hasMore) loadMore();
    else resolveMissingDrillDown("plan", planId);
  }, [planId, plans, hasMore, selectedId]);
}
