import { useEffect, useRef, useState } from "react";

import type { CatalogPlan } from "../../../shared/api";
import type { OperatorFeedback } from "../../shared/operatorFeedback";

export interface CreatedPlan {
  plan: CatalogPlan;
  /** The create's message; the route step to the plan clears page messages, so it is shown after. */
  feedback: OperatorFeedback;
}

/**
 * A created plan opens its own detail. The plan detail is a route, and a route step waits until the
 * save that owns the editor has settled, so the opening is queued here and runs once the operation
 * gate is free.
 */
export function useOpenCreatedPlan(busy: boolean, open: (created: CreatedPlan) => void): (created: CreatedPlan) => void {
  const [created, setCreated] = useState<CreatedPlan | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (created === null || busy) return;
    setCreated(null);
    openRef.current(created);
  }, [created, busy]);
  return setCreated;
}
