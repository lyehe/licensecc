import React from "react";

/** Presentation only: request fences, authoritative data and retries stay with the feature. */
export function ReadNotice({ loading, error, hasData, onRetry, label }: {
  loading: boolean;
  error: string | null;
  hasData: boolean;
  onRetry: () => void;
  label: string;
}): React.ReactElement | null {
  if (error !== null) return <div className="readState error" role="alert"><span>Could not load {label}. {hasData ? "Previously loaded records are shown." : ""}</span><button type="button" onClick={onRetry}>Retry</button><details><summary>Request details</summary><code>{error}</code></details></div>;
  if (loading) return <div className="readState" role="status">{hasData ? `Updating ${label}…` : `Loading ${label}…`}</div>;
  return null;
}
