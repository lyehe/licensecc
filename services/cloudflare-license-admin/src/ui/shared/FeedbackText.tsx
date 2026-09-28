import React from "react";

import type { FeedbackDetail, OperatorFeedback } from "./operatorFeedback";

export function feedbackDetailText(detail: FeedbackDetail): string {
  return [detail.code, detail.requestId, detail.httpStatus === undefined ? null : `HTTP ${detail.httpStatus}`].filter((part) => part !== null).join(" · ");
}

/** The result code and request id behind a message, collapsed under "Technical details". */
export function TechnicalDetails({ detail }: { detail: FeedbackDetail | undefined }): React.ReactElement | null {
  return detail === undefined ? null : <details className="feedbackDetails"><summary>Technical details</summary><code>{feedbackDetailText(detail)}</code></details>;
}

/**
 * The operator's sentence, with the result code and request id kept under Technical details.
 * Every banner, notice and local status line renders its feedback through this component.
 */
export function FeedbackText({ feedback }: { feedback: Pick<OperatorFeedback, "message" | "detail"> }): React.ReactElement {
  return <><span className="feedbackText">{feedback.message}</span><TechnicalDetails detail={feedback.detail} /></>;
}

/** A form's own status line: a refusal or rule that belongs to the whole form rather than one field. */
export function FormStatus({ feedback }: { feedback: OperatorFeedback | null }): React.ReactElement | null {
  if (feedback === null) return null;
  return <div className="formStatus" data-tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}><FeedbackText feedback={feedback} /></div>;
}
