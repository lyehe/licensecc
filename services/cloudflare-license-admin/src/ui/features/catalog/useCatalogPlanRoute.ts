import { useLayoutEffect, useRef, useState } from "react";

import type { CatalogPlan } from "../../../shared/api";
import { useAdminNavigation } from "../../app/navigation";
import { api, parseExactApiSuccess } from "../../shared/api";
import { hasCatalogPlanData } from "../../shared/mutationGuards";
import { catalogPlanPath, type CatalogFilter } from "./workflow";

interface CatalogPlanRouteOptions {
  /** The routed plan id while its detail (not an editor over it) is shown. */
  planId: string | null;
  /** The settled plans list of the current filter, kept through a refresh of that same list; null before one settles. */
  plans: readonly CatalogPlan[] | null;
  /** A page-one read of the list is in flight. */
  listPending: boolean;
  listFailed: boolean;
  cursor: string | null;
  filter: CatalogFilter;
  selectedId: string;
  select: (plan: CatalogPlan) => void;
  clearFilter: () => void;
  loadMore: () => Promise<void>;
  reloadList: () => void;
}

/** Resolution of one routed plan; state kept for any other plan id is stale and ignored. */
interface Resolution {
  planId: string;
  read: "pending" | "found" | "failed";
  plan: CatalogPlan | null;
  /**
   * The list snapshot this resolution last appended to. Any new snapshot (an appended page or a
   * page-one refresh) allows one more append; an append that changed nothing is not repeated.
   */
  appendedFrom: readonly CatalogPlan[] | null;
  appending: boolean;
}

export interface CatalogPlanRoute {
  /** Nothing is in flight and the plan is still not shown: offer Retry rather than "Loading". */
  unavailable: boolean;
  retry: () => void;
  notice: string | null;
}

function isPlanNotFound(response: unknown): boolean {
  if (response === null || typeof response !== "object") return false;
  const envelope = response as { ok?: unknown; code?: unknown; request_id?: unknown; __httpStatus?: unknown };
  return envelope.__httpStatus === 404 && envelope.ok === false && envelope.code === "catalog_plan_not_found" &&
    typeof envelope.request_id === "string" && envelope.request_id.trim() !== "";
}

function filterHides(filter: CatalogFilter, plan: CatalogPlan): boolean {
  return (filter.project !== "" && plan.project !== filter.project) || (filter.status !== "" && plan.status !== filter.status);
}

/**
 * Resolves a plan detail address (reload, Back, Forward, or a deep link). The plan's own read
 * decides whether it exists, and only its not-found answer replaces the entry with the list.
 * Selection, and so every mutation path, still comes from the settled plans list: a plan the
 * list filters hide clears them, a plan on a later page is paged to, and a failed read leaves
 * the entry in place with Retry.
 */
export function useCatalogPlanRoute(options: CatalogPlanRouteOptions): CatalogPlanRoute {
  const { planId, plans, listPending, listFailed, cursor, filter, selectedId } = options;
  const { resolveMissingDrillDown } = useAdminNavigation();
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  // A read or append publishes only while the ticket it started under is current; a route
  // change, Retry, or unmount retires it.
  const ticket = useRef(0);
  const current = resolution !== null && resolution.planId === planId ? resolution : null;
  const inList = planId !== null && plans !== null && plans.some((plan) => plan.id === planId);

  function readPlan(id: string): void {
    const mine = ++ticket.current;
    setResolution({ planId: id, read: "pending", plan: null, appendedFrom: null, appending: false });
    void (async () => {
      const response = await api<CatalogPlan>(catalogPlanPath(id));
      if (mine !== ticket.current) return;
      if (isPlanNotFound(response)) {
        resolveMissingDrillDown({ kind: "plan", planId: id });
        return;
      }
      const found = parseExactApiSuccess<CatalogPlan>(response, "catalog_plan", (data) => hasCatalogPlanData(data) && (data as CatalogPlan).id === id);
      setResolution((state) => state?.planId === id ? { ...state, read: found === null ? "failed" : "found", plan: found?.data ?? null } : state);
    })();
  }
  function append(state: Resolution, from: readonly CatalogPlan[]): void {
    const mine = ticket.current;
    setResolution({ ...state, appendedFrom: from, appending: true });
    void options.loadMore().then(() => {
      if (mine !== ticket.current) return;
      setResolution((latest) => latest?.planId === state.planId ? { ...latest, appending: false } : latest);
    });
  }

  useLayoutEffect(() => () => { ticket.current += 1; }, []);
  // A layout effect selects before paint, so a restored detail never shows the previous plan.
  useLayoutEffect(() => {
    if (planId === null) {
      if (resolution !== null || clearedFor !== null) {
        ticket.current += 1;
        setResolution(null);
        setClearedFor(null);
      }
      return;
    }
    const plan = plans?.find((candidate) => candidate.id === planId);
    if (plan !== undefined) {
      if (plan.id !== selectedId) options.select(plan);
      return;
    }
    if (current === null) {
      readPlan(planId);
      return;
    }
    if (current.read !== "found" || current.plan === null || plans === null || listPending || listFailed || current.appending) return;
    if (filterHides(filter, current.plan)) {
      options.clearFilter();
      setClearedFor(planId);
    } else if (cursor !== null && plans !== current.appendedFrom) append(current, plans);
  }, [planId, plans, listPending, listFailed, cursor, filter, selectedId, current]);

  const pending = current === null || current.read === "pending" || current.appending || listPending;
  return {
    unavailable: planId !== null && !inList && !pending,
    retry: () => {
      if (planId === null) return;
      ticket.current += 1;
      // The next layout pass reads the plan again and pages on from the list's current cursor.
      setResolution(null);
      if (listFailed || cursor === null) options.reloadList();
    },
    notice: planId !== null && clearedFor === planId ? "Plan filters were cleared to show this plan." : null,
  };
}
