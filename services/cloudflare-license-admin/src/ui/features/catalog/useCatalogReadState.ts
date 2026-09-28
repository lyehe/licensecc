import { useState } from "react";

import type { OperatorFeedback } from "../../shared/operatorFeedback";

export function useCatalogReadState(context: string): {
  loading: boolean;
  error: OperatorFeedback | null;
  begin: () => void;
  settle: () => void;
  fail: (error: OperatorFeedback) => void;
} {
  const [state, setState] = useState({ context, loading: true, error: null as OperatorFeedback | null });
  const visible = state.context === context ? state : { loading: true, error: null };
  return {
    ...visible,
    begin: () => setState({ context, loading: true, error: null }),
    settle: () => setState({ context, loading: false, error: null }),
    fail: (error) => setState({ context, loading: false, error }),
  };
}
