import React, { ReactNode, createContext, useCallback, useContext, useRef } from "react";
import type { ConfirmAction, ConsequenceAction, KeyedMutationAction } from "./operatorActions";
import { FeedbackText } from "./FeedbackText";
import { NO_FEEDBACK, type OperatorFeedback, useOperatorFeedback } from "./operatorFeedback";
import { useOperationGate } from "./operationGate";
import { useOperatorFocus } from "./operatorFocus";
import { useActionNotice } from "./useActionNotice";
import { useConfirmDialog } from "./useConfirmDialog";
import { useKeyedMutation } from "./useKeyedMutation";

// Features import the action contract and focus-target helpers from here.
export * from "./operatorActions";
export { focusTargetInRow, focusTargetInSection } from "./operatorFocus";

/**
 * A request context must advance even when its textual value returns to a prior
 * value (A → B → A). Equality alone would let an earlier response overwrite the
 * new A view or reclaim focus after the operator has moved on.
 */
export interface ContextGeneration {
  readonly generation: number;
  readonly isCurrent: (generation: number) => boolean;
  /** Capture the current generation immediately before starting a new request. */
  readonly currentGeneration: () => number;
  /** Read the current logical context without weakening generation freshness. */
  readonly currentContext: () => string;
}

export function useContextGeneration(context: string): ContextGeneration {
  const contextRef = useRef({ value: context, generation: 0 });
  if (contextRef.current.value !== context) {
    contextRef.current = { value: context, generation: contextRef.current.generation + 1 };
  }
  const isCurrent = useCallback((generation: number): boolean => contextRef.current.generation === generation, []);
  const currentGeneration = useCallback((): number => contextRef.current.generation, []);
  const currentContext = useCallback((): string => contextRef.current.value, []);
  return { generation: contextRef.current.generation, isCurrent, currentGeneration, currentContext };
}

interface OperatorControls {
  busy: boolean;
  /** Any operator notice is shown: other operations are refused until it is resolved or acknowledged. */
  operationLocked: boolean;
  /** A retained recovery owns the operation gate after its request settles. */
  operationRetained: boolean;
  modalActive: boolean;
  currentReason: () => string;
  message: string;
  feedback: OperatorFeedback;
  reason: string;
  requestConfirm: (action: ConfirmAction) => void;
  runConsequenceAction: (action: ConsequenceAction) => Promise<void>;
  runMutation: <T>(work: () => Promise<T>, owner?: "consequence" | "recovery") => Promise<T | undefined>;
  runKeyedMutation: <T>(action: KeyedMutationAction<T>) => Promise<void>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setFeedback: React.Dispatch<React.SetStateAction<OperatorFeedback>>;
  setReason: React.Dispatch<React.SetStateAction<string>>;
}

const OperatorControlsContext = createContext<OperatorControls | null>(null);

/**
 * Composes the operator's shared operation gate, confirmation dialog, action
 * notice and keyed mutations, and renders the notice and dialog after the
 * console content.
 */
export function OperatorControlsProvider({ children }: { children: ReactNode }): React.ReactElement {
  const { message, feedback, setMessage, setFeedback } = useOperatorFeedback();
  const gate = useOperationGate();
  const focus = useOperatorFocus();
  const notice = useActionNotice(gate, () => setFeedback(NO_FEEDBACK));
  const confirm = useConfirmDialog({ gate, focus, notice });
  const { runMutation, runKeyedMutation, runConsequenceAction, runNoticeRecovery } = useKeyedMutation({ gate, focus, notice, confirmActionRef: confirm.confirmActionRef, setFeedback });
  const { busy } = gate;
  const { actionNotice, noticePending, operationLocked, operationRetained, acknowledgeNotice } = notice;
  const { modalActive, currentReason, reason, requestConfirm, setReason } = confirm;

  return (
    <OperatorControlsContext.Provider value={{ busy, operationLocked, operationRetained, modalActive, currentReason, message, feedback, reason, requestConfirm, runConsequenceAction, runKeyedMutation, runMutation, setMessage, setFeedback, setReason }}>
      {children}
      {actionNotice !== null && (
        <div className="operatorNotice" role="status" aria-live="polite">
          <div className="noticeMessage"><FeedbackText feedback={actionNotice} /></div>
          {actionNotice.unresolvedKey !== undefined && <span>Other actions are unavailable until reconciliation completes.</span>}
          {actionNotice.manualRefresh !== undefined && <button type="button" disabled={noticePending} onClick={() => void runNoticeRecovery()}>{noticePending ? "Refreshing…" : actionNotice.manualRefresh.label}</button>}
          {actionNotice.dismissible === true && <span>Other actions are unavailable until you acknowledge this notice.</span>}
          {actionNotice.dismissible === true && <button type="button" disabled={noticePending} onClick={acknowledgeNotice}>Acknowledge</button>}
        </div>
      )}
      {confirm.dialog}
    </OperatorControlsContext.Provider>
  );
}

export function useOperatorControls(): OperatorControls {
  const controls = useContext(OperatorControlsContext);
  if (controls === null) {
    throw new Error("operator_controls_provider_required");
  }
  return controls;
}
