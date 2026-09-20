import React, { useCallback, useEffect, useRef, useState } from "react";

import { type AdminSettings, environmentLabel, hasAdminSettings } from "./environment";
import { api, apiFailureMessage, parseExactApiSuccess } from "../shared/api";

type EnvironmentState = { kind: "loading" } | { kind: "ready"; label: string } | { kind: "unknown"; detail: string } | { kind: "error"; detail: string };

export function EnvironmentBadge(): React.ReactElement {
  const [state, setState] = useState<EnvironmentState>({ kind: "loading" });
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++generation.current;
    setState({ kind: "loading" });
    const response = await api<AdminSettings>("/api/admin/settings");
    if (current !== generation.current) return;
    const parsed = parseExactApiSuccess<AdminSettings>(response, "settings", hasAdminSettings);
    if (parsed === null) {
      setState({ kind: "error", detail: `Settings could not be read: ${apiFailureMessage(response)}` });
      return;
    }
    const label = environmentLabel(parsed.data.environment);
    setState(label === null ? { kind: "unknown", detail: "Settings returned an unrecognized environment." } : { kind: "ready", label });
  }, []);
  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  return <div className="environmentStatus">
    <span className="environmentBadge" data-state={state.kind} role="status">{state.kind === "ready" ? state.label : state.kind === "loading" ? "Checking environment…" : "Environment unknown"}</span>
    {(state.kind === "error" || state.kind === "unknown") && <details className="environmentDetails">
      <summary>Environment details</summary>
      <p>{state.detail}</p>
      <button type="button" onClick={() => void refresh()}>Retry settings</button>
    </details>}
  </div>;
}
