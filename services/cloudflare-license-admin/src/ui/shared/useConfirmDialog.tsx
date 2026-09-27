import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { CONFIRM_MUTATION_UNKNOWN_MESSAGE, CONFIRM_REFRESH_FAILURE_MESSAGE, type ConfirmAction, type ConfirmActionFailure } from "./operatorActions";
import type { OperationGate } from "./operationGate";
import { focusableElements, useFocusRestoration, type OperatorFocus, type PendingFocus } from "./operatorFocus";
import type { ActionNotice, ActionNoticeControls } from "./useActionNotice";

/*
 * The shared confirmation dialog: its state, its reason field, focus
 * management while it is open and after it closes, and its render. Browsers
 * without a native <dialog> get an equivalent non-native modal.
 */

function supportsNativeDialog(): boolean {
  return typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";
}

export interface ConfirmDialogDependencies {
  gate: OperationGate;
  focus: OperatorFocus;
  notice: ActionNoticeControls;
  setMessage: Dispatch<SetStateAction<string>>;
}

export interface ConfirmDialogControls {
  reason: string;
  setReason: Dispatch<SetStateAction<string>>;
  currentReason: () => string;
  requestConfirm: (action: ConfirmAction) => void;
  modalActive: boolean;
  confirmActionRef: RefObject<ConfirmAction | null>;
  /** The dialog element, rendered after the provider's children. */
  dialog: React.ReactElement;
}

export function useConfirmDialog({ gate, focus, notice, setMessage }: ConfirmDialogDependencies): ConfirmDialogControls {
  const { busy, operationOwnerRef, confirmPendingRef, consequencePendingRef, unresolvedOperationRef, setOperationBusy } = gate;
  const { pendingRestoreFocusRef, pendingSuccessFocusRef, focusSoon, capturePendingFocus } = focus;
  const { actionNoticeRef, noticePendingRef, publishActionNotice } = notice;
  const [reason, setReason] = useState("");
  const reasonRef = useRef("");
  reasonRef.current = reason;
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const [nativeDialogEnabled, setNativeDialogEnabled] = useState(supportsNativeDialog);
  const confirmId = useId().replace(/:/g, "-");
  const titleId = `confirm-title-${confirmId}`;
  const descriptionId = `confirm-description-${confirmId}`;
  const errorId = `confirm-error-${confirmId}`;
  const nativeDialogRef = useRef<HTMLDialogElement | null>(null);
  const fallbackOverlayRef = useRef<HTMLDivElement | null>(null);
  const fallbackDialogRef = useRef<HTMLDivElement | null>(null);
  const reasonInputRef = useRef<HTMLInputElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const invokingElementRef = useRef<HTMLElement | null>(null);
  const invokingRowKeyRef = useRef<string | null>(null);
  const invokingSectionKeyRef = useRef<string | null>(null);
  const confirmAttemptKeyRef = useRef<string | null>(null);
  const confirmActionRef = useRef<ConfirmAction | null>(null);
  confirmActionRef.current = confirmAction;

  const currentReason = useCallback((): string => reasonRef.current, []);
  const dismissConfirm = useCallback((): void => {
    if (confirmPendingRef.current) {
      return;
    }
    pendingRestoreFocusRef.current = {
      invokingElement: invokingElementRef.current,
      rowKey: invokingRowKeyRef.current,
      sectionKey: invokingSectionKeyRef.current,
    };
    pendingSuccessFocusRef.current = null;
    invokingElementRef.current = null;
    invokingRowKeyRef.current = null;
    invokingSectionKeyRef.current = null;
    const keepConsequenceOwner = unresolvedOperationRef.current !== null || actionNoticeRef.current?.manualRefresh !== undefined;
    confirmAttemptKeyRef.current = null;
    setConfirmPending(false);
    setConfirmError(null);
    setConfirmUnknown(false);
    setConfirmAction(null);
    setReason("");
    if (!keepConsequenceOwner && operationOwnerRef.current === "consequence") {
      operationOwnerRef.current = null;
      setOperationBusy(false);
    }
  }, [setOperationBusy]);
  const requestConfirm = useCallback((action: ConfirmAction): void => {
    if (operationOwnerRef.current !== null || confirmPendingRef.current || consequencePendingRef.current || noticePendingRef.current || unresolvedOperationRef.current !== null || actionNoticeRef.current !== null) {
      return;
    }
    const pendingFocus = capturePendingFocus();
    invokingElementRef.current = pendingFocus.invokingElement;
    invokingRowKeyRef.current = pendingFocus.rowKey;
    invokingSectionKeyRef.current = pendingFocus.sectionKey;
    pendingRestoreFocusRef.current = null;
    pendingSuccessFocusRef.current = null;
    confirmAttemptKeyRef.current = crypto.randomUUID();
    setConfirmPending(false);
    setConfirmError(null);
    setConfirmUnknown(false);
    setReason("");
    operationOwnerRef.current = "consequence";
    setConfirmAction(action);
  }, [capturePendingFocus]);
  const confirmProceed = useCallback(async (): Promise<void> => {
    const action = confirmAction;
    if (action === null || (action.requiresReason && currentReason().trim() === "")) {
      return;
    }
    if (confirmPendingRef.current) {
      return;
    }
    confirmPendingRef.current = true;
    setConfirmPending(true);
    setConfirmError(null);
    setConfirmUnknown(false);
    setOperationBusy(true);
    try {
      const idempotencyKey = confirmAttemptKeyRef.current ?? crypto.randomUUID();
      confirmAttemptKeyRef.current = idempotencyKey;
      const outcome = await action.run({ idempotencyKey });
      if (outcome === undefined || !outcome.ok) {
        const unknown = outcome === undefined || outcome.unknown === true || outcome.retryable === false;
        const message = outcome?.message ?? (unknown ? CONFIRM_MUTATION_UNKNOWN_MESSAGE : "action_failed");
        if (unknown) {
          const focusTarget: PendingFocus = {
            actionTarget: action.successFocusTarget,
            invokingElement: invokingElementRef.current,
            rowKey: invokingRowKeyRef.current,
            sectionKey: invokingSectionKeyRef.current,
          };
          const failure = outcome as ConfirmActionFailure | undefined;
          const reconciliation = failure?.reconciliation ?? action.reconciliation;
          unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation };
          publishActionNotice({ message, manualRefresh: reconciliation, focusTarget, dismissible: false, unresolvedKey: idempotencyKey });
        } else {
          // A documented pre-mutation rejection concludes this attempt.  Keep
          // the modal editable, but do not reuse its old idempotency key.
          confirmAttemptKeyRef.current = null;
        }
        setConfirmError(message);
        setConfirmUnknown(unknown);
        setConfirmPending(false);
        confirmPendingRef.current = false;
        setOperationBusy(false);
        return;
      }
      const successFocusTarget: PendingFocus = {
        actionTarget: action.successFocusTarget,
        invokingElement: invokingElementRef.current,
        rowKey: invokingRowKeyRef.current,
        sectionKey: invokingSectionKeyRef.current,
      };
      pendingSuccessFocusRef.current = action.isCurrent?.() === false ? null : successFocusTarget;
      invokingElementRef.current = null;
      invokingRowKeyRef.current = null;
      invokingSectionKeyRef.current = null;
      confirmAttemptKeyRef.current = null;
      setConfirmPending(false);
      confirmPendingRef.current = false;
      if (outcome.warning !== undefined || outcome.manualRefresh !== undefined) {
        const message = outcome.warning ?? CONFIRM_REFRESH_FAILURE_MESSAGE;
        setMessage(message);
        publishActionNotice({ message, manualRefresh: outcome.manualRefresh, focusTarget: successFocusTarget });
      }
      setConfirmAction(null);
      setReason("");
      const hasManualRefresh = (actionNoticeRef.current as ActionNotice | null)?.manualRefresh !== undefined;
      if (operationOwnerRef.current === "consequence" && !hasManualRefresh) {
        operationOwnerRef.current = null;
      }
      setOperationBusy(false);
    } catch (error) {
      const idempotencyKey = confirmAttemptKeyRef.current ?? crypto.randomUUID();
      confirmAttemptKeyRef.current = idempotencyKey;
      const focusTarget: PendingFocus = {
        actionTarget: action.successFocusTarget,
        invokingElement: invokingElementRef.current,
        rowKey: invokingRowKeyRef.current,
        sectionKey: invokingSectionKeyRef.current,
      };
      unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation: action.reconciliation };
      publishActionNotice({ message: CONFIRM_MUTATION_UNKNOWN_MESSAGE, manualRefresh: action.reconciliation, focusTarget, dismissible: false, unresolvedKey: idempotencyKey });
      setConfirmError(CONFIRM_MUTATION_UNKNOWN_MESSAGE);
      setConfirmUnknown(true);
      setConfirmPending(false);
      confirmPendingRef.current = false;
      setOperationBusy(false);
    }
  }, [confirmAction, currentReason, publishActionNotice, setMessage, setOperationBusy]);

  // The pending-focus pass must stay ahead of the dialog's own layout effects.
  useFocusRestoration(focus, confirmAction);

  useLayoutEffect(() => {
    if (confirmAction === null || confirmPending || confirmError === null) {
      return;
    }
    focusSoon(errorRef.current ?? confirmButtonRef.current ?? cancelButtonRef.current);
  }, [confirmAction, confirmError, confirmPending, focusSoon]);

  useLayoutEffect(() => {
    if (confirmAction === null || !confirmPending) {
      return;
    }
    const dialog = nativeDialogEnabled ? nativeDialogRef.current : fallbackDialogRef.current;
    if (dialog !== null) {
      focusSoon(confirmButtonRef.current ?? dialog);
    }
  }, [confirmAction, confirmPending, focusSoon, nativeDialogEnabled]);

  useLayoutEffect(() => {
    if (confirmAction === null) {
      return;
    }
    const dialog = nativeDialogEnabled ? nativeDialogRef.current : fallbackDialogRef.current;
    const modalContainer = nativeDialogEnabled ? nativeDialogRef.current : fallbackOverlayRef.current;
    if (dialog === null || modalContainer === null) {
      return;
    }
    if (nativeDialogEnabled && nativeDialogRef.current !== null && !nativeDialogRef.current.open) {
      try {
        nativeDialogRef.current.showModal();
      } catch {
        setNativeDialogEnabled(false);
        return;
      }
    }

    const backgroundRoot = modalContainer.parentElement;
    const backgroundElements = backgroundRoot === null
      ? []
      : Array.from(backgroundRoot.children)
        .filter((element) => element !== modalContainer)
        .map((element) => element as HTMLElement);
    const previousBackgroundState = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of backgroundElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    const initialFocus = confirmAction.requiresReason ? reasonInputRef.current : cancelButtonRef.current;
    focusSoon(initialFocus ?? dialog);

    return () => {
      for (const previous of previousBackgroundState) {
        previous.element.inert = previous.inert;
        if (previous.ariaHidden === null) {
          previous.element.removeAttribute("aria-hidden");
        } else {
          previous.element.setAttribute("aria-hidden", previous.ariaHidden);
        }
      }
      if (nativeDialogEnabled && dialog instanceof HTMLDialogElement && dialog.open) {
        dialog.close();
      }
    };
  }, [confirmAction, focusSoon, nativeDialogEnabled]);

  useEffect(() => {
    if (confirmAction === null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      const dialog = nativeDialogEnabled ? nativeDialogRef.current : fallbackDialogRef.current;
      if (dialog === null) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!confirmPendingRef.current) {
          dismissConfirm();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = focusableElements(dialog);
      event.stopPropagation();
      event.preventDefault();
      if (focusable.length === 0) {
        dialog.focus({ preventScroll: true });
        return;
      }
      const activeElement = document.activeElement;
      const currentIndex = activeElement instanceof HTMLElement ? focusable.indexOf(activeElement) : -1;
      if (currentIndex < 0) {
        (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus({ preventScroll: true });
      } else if (event.shiftKey) {
        focusable[(currentIndex - 1 + focusable.length) % focusable.length].focus({ preventScroll: true });
      } else {
        focusable[(currentIndex + 1) % focusable.length].focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [confirmAction, dismissConfirm, nativeDialogEnabled]);

  const modalContent = confirmAction === null ? null : (
    <div className="modalSurface" onClick={(event) => event.stopPropagation()}>
      <h2 id={titleId}>{confirmAction.title}</h2>
      <p id={descriptionId}>{confirmAction.body}</p>
      {confirmAction.details !== undefined && <section className="modalDetails" aria-label="Action consequences">{confirmAction.details}</section>}
      {confirmPending && <p className="modalProgress" role="status" aria-live="polite">Working…</p>}
      {confirmError !== null && <p ref={errorRef} id={errorId} className="modalError" role="alert" tabIndex={-1}>{confirmError}</p>}
      {confirmAction.requiresReason && (
        <label className="reason">Reason (required)<input ref={reasonInputRef} autoFocus disabled={confirmPending} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      )}
      <div className="actions">
        <button ref={cancelButtonRef} type="button" autoFocus={!confirmAction.requiresReason} disabled={confirmPending} onClick={dismissConfirm}>Cancel</button>
        <button
          ref={confirmButtonRef}
          type="button"
          className="danger"
          disabled={!confirmPending && (confirmUnknown || busy || (confirmAction.requiresReason && reason.trim() === ""))}
          aria-disabled={confirmPending ? "true" : undefined}
          onClick={() => void confirmProceed()}
        >Confirm</button>
      </div>
    </div>
  );

  const dialog = (
    <>
      {confirmAction !== null && nativeDialogEnabled && (
        <dialog
          ref={nativeDialogRef}
          className="modal danger"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={confirmError === null ? descriptionId : `${descriptionId} ${errorId}`}
          aria-busy={confirmPending}
          tabIndex={-1}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              dismissConfirm();
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            dismissConfirm();
          }}
        >
          {modalContent}
        </dialog>
      )}
      {confirmAction !== null && !nativeDialogEnabled && (
        <div ref={fallbackOverlayRef} className="modalOverlay" role="presentation" onClick={dismissConfirm}>
          <div ref={fallbackDialogRef} className="modal danger" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={confirmError === null ? descriptionId : `${descriptionId} ${errorId}`} aria-busy={confirmPending} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            {modalContent}
          </div>
        </div>
      )}
    </>
  );

  return { reason, setReason, currentReason, requestConfirm, modalActive: confirmAction !== null, confirmActionRef, dialog };
}
