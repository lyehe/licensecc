import { useState } from "react";

export function useCatalogReadState(context: string): {
  loading: boolean;
  error: string | null;
  begin: () => void;
  settle: () => void;
  fail: (error: string) => void;
} {
  const [state, setState] = useState({ context, loading: true, error: null as string | null });
  const visible = state.context === context ? state : { loading: true, error: null };
  return {
    ...visible,
    begin: () => setState({ context, loading: true, error: null }),
    settle: () => setState({ context, loading: false, error: null }),
    fail: (error) => setState({ context, loading: false, error }),
  };
}
