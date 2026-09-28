import React from "react";

import { TechnicalDetails } from "./FeedbackText";
import type { OperatorFeedback } from "./operatorFeedback";

/**
 * Presentation only: request fences, authoritative data and retries stay with the feature. A read
 * failure is reported here, beside what it failed to load, and never again in the page banner.
 */
export function ReadNotice({ loading, error, hasData, onRetry, label }: {
  loading: boolean;
  error: OperatorFeedback | null;
  hasData: boolean;
  onRetry: () => void;
  label: string;
}): React.ReactElement | null {
  if (error !== null) return <div className="readState error" role="alert"><span>Could not load {label}. {error.message}{hasData ? " Previously loaded records are shown." : ""}</span><button type="button" onClick={onRetry}>Retry</button><TechnicalDetails detail={error.detail} /></div>;
  if (loading) return <div className="readState" role="status">{hasData ? `Updating ${label}…` : `Loading ${label}…`}</div>;
  return null;
}
