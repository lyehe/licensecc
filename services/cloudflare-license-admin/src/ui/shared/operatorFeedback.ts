import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

export interface OperatorFeedback {
  tone: "success" | "error" | "info";
  message: string;
}

export function useOperatorFeedback(): {
  message: string;
  feedback: OperatorFeedback;
  setMessage: Dispatch<SetStateAction<string>>;
  setFeedback: Dispatch<SetStateAction<OperatorFeedback>>;
} {
  const [feedback, setFeedback] = useState<OperatorFeedback>({ tone: "info", message: "" });
  // Legacy feature messages remain neutral until the owning workflow supplies
  // an explicit tone. Unknown/error strings can never look like success.
  const setMessage = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setFeedback((current) => ({ tone: "info", message: typeof next === "function" ? next(current.message) : next }));
  }, []);
  return { message: feedback.message, feedback, setMessage, setFeedback };
}
