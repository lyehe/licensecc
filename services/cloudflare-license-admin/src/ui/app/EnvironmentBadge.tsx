import React, { useCallback, useEffect, useRef, useState } from "react";

import { type AdminSettings, environmentLabel, hasAdminSettings } from "./environment";
import { api, parseExactApiSuccess } from "../shared/api";
import { feedbackDetailText } from "../shared/FeedbackText";
import { apiFailureFeedback } from "../shared/messages";
import type { FeedbackDetail } from "../shared/operatorFeedback";

type EnvironmentState = { kind: "loading" } | { kind: "ready"; label: string } | { kind: "unknown"; detail: string } | { kind: "error"; detail: string; technical?: FeedbackDetail };

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
      const failure = apiFailureFeedback(response);
      setState({ kind: "error", detail: `Settings could not be read. ${failure.message}`, technical: failure.detail });
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
      {state.kind === "error" && state.technical !== undefined && <p><code>{feedbackDetailText(state.technical)}</code></p>}
      <button type="button" onClick={() => void refresh()}>Retry settings</button>
    </details>}
  </div>;
}
