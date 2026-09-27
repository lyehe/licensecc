import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/** The result code behind a message and the request that produced it, shown under Technical details. */
export interface FeedbackDetail {
  code: string;
  requestId: string | null;
}

export interface OperatorFeedback {
  tone: "success" | "error" | "info";
  message: string;
  detail?: FeedbackDetail;
}

export const NO_FEEDBACK: OperatorFeedback = { tone: "info", message: "" };

export function useOperatorFeedback(): {
  message: string;
  feedback: OperatorFeedback;
  setMessage: Dispatch<SetStateAction<string>>;
  setFeedback: Dispatch<SetStateAction<OperatorFeedback>>;
} {
  const [feedback, setFeedback] = useState<OperatorFeedback>(NO_FEEDBACK);
  // A plain message is the operator's sentence and stays neutral; a result code arrives through
  // setFeedback with its own tone and detail. Unknown/error strings can never look like success.
  const setMessage = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setFeedback((current) => ({ tone: "info", message: typeof next === "function" ? next(current.message) : next }));
  }, []);
  return { message: feedback.message, feedback, setMessage, setFeedback };
}
