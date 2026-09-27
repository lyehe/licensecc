import { useCallback } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  CONFIRM_MUTATION_UNKNOWN_MESSAGE,
  CONFIRM_REFRESH_FAILURE_MESSAGE,
  EXACT_READ_PROOF,
  type ConfirmAction,
  type ConfirmActionRecovery,
  type ConfirmActionResolution,
  type ConsequenceAction,
  type KeyedMutationAction,
  type KeyedMutationAttempt,
  type KeyedMutationParseResult,
} from "./operatorActions";
import { codeFeedback, failureFeedback } from "./messages";
import type { OperatorFeedback } from "./operatorFeedback";
import type { OperationGate } from "./operationGate";
import { resolvePendingFocus, type OperatorFocus } from "./operatorFocus";
import type { ActionNotice, ActionNoticeControls } from "./useActionNotice";
import { currentContextStableFocusTarget } from "./workspaceFocus";

/*
 * Keyed and idempotent mutations: each request keeps its idempotency key until
 * its outcome is known, an unknown outcome is retained as an unresolved
 * operation, and notice recovery reconciles it by replaying the same key or
 * running a strict status read. While a notice is published it is the one
 * surface for its outcome; the page banner reports only what settles it.
 */

export interface KeyedMutationDependencies {
  gate: OperationGate;
  focus: OperatorFocus;
  notice: ActionNoticeControls;
  /** The open confirmation; a recovery never moves focus out from under it. */
  confirmActionRef: RefObject<ConfirmAction | null>;
  setFeedback: Dispatch<SetStateAction<OperatorFeedback>>;
}

export interface KeyedMutationControls {
  runMutation: <T>(work: () => Promise<T>, owner?: "consequence" | "recovery") => Promise<T | undefined>;
  runKeyedMutation: <T>(action: KeyedMutationAction<T>) => Promise<void>;
  runConsequenceAction: (action: ConsequenceAction) => Promise<void>;
  /** Run the current notice's recovery control. */
  runNoticeRecovery: () => Promise<void>;
}

export function useKeyedMutation({ gate, focus, notice: noticeControls, confirmActionRef, setFeedback }: KeyedMutationDependencies): KeyedMutationControls {
  const { busyRef, operationBusyRef, operationOwnerRef, confirmPendingRef, consequencePendingRef, unresolvedOperationRef, setBusy, setOperationBusy } = gate;
  // useFocusRestoration (called inside useConfirmDialog) is what actually reads and resolves these
  // focus refs, including pendingShellFocusRef; this hook only ever writes them.
  const { pendingRestoreFocusRef, pendingSuccessFocusRef, pendingShellFocusRef, setFocusGeneration, focusSoon, capturePendingFocus } = focus;
  const { actionNoticeRef, noticePendingRef, setNoticePending, publishActionNotice, replaceActionNotice, clearActionNotice } = noticeControls;

  const runMutation = useCallback(async <T,>(work: () => Promise<T>, owner?: "consequence" | "recovery"): Promise<T | undefined> => {
    if (busyRef.current || (operationOwnerRef.current !== null && owner !== operationOwnerRef.current) || (operationOwnerRef.current === null && owner !== undefined)) {
      return undefined;
    }
    if (operationOwnerRef.current === null) {
      operationOwnerRef.current = "mutation";
    }
    busyRef.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      busyRef.current = false;
      if (!operationBusyRef.current) {
        setBusy(false);
      }
      if (operationOwnerRef.current === "mutation") {
        operationOwnerRef.current = null;
      }
    }
  }, []);
  const runKeyedMutation = useCallback(async <T,>(action: KeyedMutationAction<T>): Promise<void> => {
    if (operationOwnerRef.current !== null || confirmPendingRef.current || consequencePendingRef.current || noticePendingRef.current || unresolvedOperationRef.current !== null || actionNoticeRef.current !== null) {
      return;
    }
    const focusTarget = capturePendingFocus(action.successFocusTarget);
    const attempt: Readonly<KeyedMutationAttempt> = Object.freeze({
      method: action.request.method,
      path: action.request.path,
      body: action.request.body,
      idempotencyKey: crypto.randomUUID(),
    });
    let retained = false;
    const strictRefresh: ConfirmActionRecovery = {
      label: "Refresh status",
      isCurrent: action.isCurrent,
      settlesKnownSuccess: true,
      run: async (): Promise<ConfirmActionResolution> => {
        // `onApplied` may intentionally clear an editable form and therefore
        // advance its mutation context.  This is still a mandatory strict GET:
        // the refresh callback carries the narrower list/detail fence that
        // prevents a stale response from changing a successor view.
        return (await action.refresh()) === EXACT_READ_PROOF ? "applied" : "indeterminate";
      },
    };
    const retainKnownRefreshFailure = (): void => {
      const message = CONFIRM_REFRESH_FAILURE_MESSAGE;
      pendingRestoreFocusRef.current = focusTarget;
      setFocusGeneration((generation) => generation + 1);
      publishActionNotice({
        message,
        manualRefresh: strictRefresh,
        focusTarget,
        dismissible: false,
      });
    };
    const applyExactSuccess = async (result: Extract<KeyedMutationParseResult<T>, { kind: "success" }>): Promise<"applied" | "refresh_failed"> => {
      try {
        await action.onApplied(result);
        // A successful write is not presented as applied until its strict
        // read succeeds. `onApplied` is allowed to advance an editable form's
        // generation, so this intentionally delegates stale-view protection
        // to the narrower list/detail fence in the refresh callback.
        return await strictRefresh.run() === "applied" ? "applied" : "refresh_failed";
      } catch {
        // The write is known to have applied.  Its original immutable request
        // is no longer a recovery action: only a strict GET may resolve the
        // stale view, and it must never issue another POST. The caller's
        // refresh notice reports it.
        return "refresh_failed";
      }
    };
    const retainUnknown = (): void => {
      retained = true;
      const reconciliation: ConfirmActionRecovery = {
        label: action.recoveryLabel ?? "Reconcile status",
        isCurrent: action.isCurrent,
        settlesRetainedAttempt: true,
        postSuccessRefresh: strictRefresh,
        run: async (): Promise<ConfirmActionResolution> => {
          const replay = await runMutation(() => action.send(attempt), "recovery");
          if (replay === undefined) {
            return "indeterminate";
          }
          let parsed: KeyedMutationParseResult<T>;
          try {
            parsed = action.parse(replay, "replay");
          } catch {
            return "indeterminate";
          }
          if (parsed.kind === "success") {
            return await applyExactSuccess(parsed);
          }
          if (parsed.kind === "failure") {
            action.onUnapplied?.(parsed);
            return "unapplied";
          }
          return "indeterminate";
        },
      };
      unresolvedOperationRef.current = { idempotencyKey: attempt.idempotencyKey, focusTarget, reconciliation, request: attempt };
      pendingRestoreFocusRef.current = focusTarget;
      setFocusGeneration((generation) => generation + 1);
      publishActionNotice({
        message: CONFIRM_MUTATION_UNKNOWN_MESSAGE,
        manualRefresh: reconciliation,
        focusTarget,
        dismissible: false,
        unresolvedKey: attempt.idempotencyKey,
      });
    };
    operationOwnerRef.current = "ordinary";
    busyRef.current = true;
    setOperationBusy(true);
    try {
      let parsed: KeyedMutationParseResult<T>;
      try {
        parsed = action.parse(await action.send(attempt), "initial");
      } catch {
        retainUnknown();
        return;
      }
      if (parsed.kind === "success") {
        if (await applyExactSuccess(parsed) === "refresh_failed") {
          retainKnownRefreshFailure();
        }
        return;
      }
      if (parsed.kind === "failure") {
        if (action.onUnapplied !== undefined) {
          action.onUnapplied(parsed);
        } else if (action.isCurrent?.() !== false) {
          setFeedback(failureFeedback(parsed.code, parsed.requestId));
        }
        return;
      }
      retainUnknown();
    } finally {
      busyRef.current = false;
      if (!retained && operationOwnerRef.current === "ordinary") {
        operationOwnerRef.current = null;
      }
      setOperationBusy(false);
    }
  }, [capturePendingFocus, publishActionNotice, runMutation, setFeedback, setOperationBusy]);
  const runConsequenceAction = useCallback(async (action: ConsequenceAction): Promise<void> => {
    if (operationOwnerRef.current !== null || confirmPendingRef.current || consequencePendingRef.current || noticePendingRef.current || unresolvedOperationRef.current !== null || actionNoticeRef.current !== null) {
      return;
    }
    const focusTarget = capturePendingFocus(action.successFocusTarget);
    const invokingElement = focusTarget.invokingElement;
    const idempotencyKey = crypto.randomUUID();
    operationOwnerRef.current = "consequence";
    setOperationBusy(true);
    consequencePendingRef.current = true;
    try {
      const outcome = await action.run({ idempotencyKey });
      if (outcome === undefined) {
        return;
      }
      if (!outcome.ok) {
        const failure = outcome.message !== undefined ? { message: outcome.message, detail: outcome.detail }
          : outcome.unknown === true ? { message: CONFIRM_MUTATION_UNKNOWN_MESSAGE } : codeFeedback("action_failed");
        const unknown = outcome.unknown === true || outcome.retryable === false;
        if (unknown) {
          unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation: outcome.reconciliation ?? action.reconciliation };
        }
        pendingRestoreFocusRef.current = focusTarget;
        setFocusGeneration((generation) => generation + 1);
        publishActionNotice({ message: failure.message, detail: failure.detail, manualRefresh: unknown ? outcome.reconciliation ?? action.reconciliation : undefined, focusTarget, dismissible: !unknown, unresolvedKey: unknown ? idempotencyKey : undefined });
        return;
      }
      const current = action.isCurrent?.() !== false;
      const focusAllowed = current && (invokingElement === null || document.activeElement === invokingElement || document.activeElement === document.body);
      pendingSuccessFocusRef.current = focusAllowed ? focusTarget : null;
      if (outcome.warning !== undefined || outcome.manualRefresh !== undefined) {
        const message = outcome.warning ?? CONFIRM_REFRESH_FAILURE_MESSAGE;
        publishActionNotice({ message, manualRefresh: outcome.manualRefresh, focusTarget });
      }
      setFocusGeneration((generation) => generation + 1);
    } catch {
      const message = CONFIRM_MUTATION_UNKNOWN_MESSAGE;
      unresolvedOperationRef.current = { idempotencyKey, focusTarget, reconciliation: action.reconciliation };
      pendingRestoreFocusRef.current = focusTarget;
      setFocusGeneration((generation) => generation + 1);
      publishActionNotice({ message, manualRefresh: action.reconciliation, focusTarget, unresolvedKey: idempotencyKey });
    } finally {
      consequencePendingRef.current = false;
      const hasManualRefresh = (actionNoticeRef.current as ActionNotice | null)?.manualRefresh !== undefined;
      if (operationOwnerRef.current === "consequence" && unresolvedOperationRef.current === null && !hasManualRefresh) {
        operationOwnerRef.current = null;
      }
      // Retained/known-outcome notices still own the logical gate, but their
      // saved focus target must remain usable for accessible focus restoration.
      setOperationBusy(false);
    }
  }, [capturePendingFocus, publishActionNotice, setOperationBusy]);

  const runNoticeRecovery = useCallback(async (): Promise<void> => {
    const notice = actionNoticeRef.current;
    const recovery = notice?.manualRefresh;
    if (notice === null || notice === undefined || recovery === undefined || noticePendingRef.current) {
      return;
    }
    const focusTarget = notice.focusTarget;
    const generation = notice.generation;
    const recoveryTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const canRestoreFocus = (): boolean => {
      if (confirmActionRef.current !== null || recovery.isCurrent?.() === false) {
        return false;
      }
      return recoveryTrigger === null || document.activeElement === recoveryTrigger || document.activeElement === document.body;
    };
    const restoreNoticeFocus = (): void => {
      if (!canRestoreFocus()) {
        return;
      }
      window.requestAnimationFrame(() => focusSoon(resolvePendingFocus(focusTarget)));
    };
    noticePendingRef.current = true;
    operationOwnerRef.current = "recovery";
    setOperationBusy(true);
    setNoticePending(true);
    try {
      const resolution = await recovery.run();
      if (actionNoticeRef.current?.generation !== generation) {
        return;
      }
      if (recovery.isCurrent?.() === false && recovery.settlesRetainedAttempt !== true && recovery.settlesKnownSuccess !== true) {
        // A refresh for a superseded row/filter context cannot reconcile the
        // notice. Keep its recovery control until that context is current.
        return;
      }
      if (resolution === "refresh_failed") {
        // The same-key replay has given exact proof of the write. Clear its
        // immutable request/owner immediately and replace it with a GET-only
        // recovery. Replaying again here would turn a known success into a
        // second POST and make recovery less safe, not more.
        if (notice.unresolvedKey === undefined || recovery.postSuccessRefresh === undefined || unresolvedOperationRef.current?.idempotencyKey !== notice.unresolvedKey) {
          return;
        }
        unresolvedOperationRef.current = null;
        operationOwnerRef.current = null;
        publishActionNotice({
          message: CONFIRM_REFRESH_FAILURE_MESSAGE,
          manualRefresh: recovery.postSuccessRefresh,
          focusTarget,
          dismissible: false,
        });
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        restoreNoticeFocus();
        return;
      }
      if (recovery.settlesKnownSuccess === true && resolution !== "applied") {
        // A known POST must never be treated as reconciled merely because its
        // old callback became a no-op after a form/filter context changed.
        // Retain the GET-only notice until a current exact read supplies proof.
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        restoreNoticeFocus();
        return;
      }
      if (notice.unresolvedKey !== undefined && resolution === "indeterminate") {
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        const message = CONFIRM_MUTATION_UNKNOWN_MESSAGE;
        const currentNotice = actionNoticeRef.current;
        if (currentNotice?.generation === generation && currentNotice.message !== message) {
          replaceActionNotice({ ...currentNotice, message });
        }
        restoreNoticeFocus();
        return;
      }
      if (notice.unresolvedKey !== undefined) {
        if (unresolvedOperationRef.current?.idempotencyKey !== notice.unresolvedKey) {
          return;
        }
        unresolvedOperationRef.current = null;
      }
      const focusAllowed = canRestoreFocus();
      const staleRetainedReplay = !focusAllowed
        && recovery.settlesRetainedAttempt === true
        && recovery.isCurrent?.() === false;
      if (focusAllowed) {
        // The recovery control is about to unmount. Move focus before that
        // happens, then let the post-render pass refine it against refreshed
        // row data; otherwise browsers may transiently fall back to <body>.
        focusSoon(resolvePendingFocus(focusTarget));
        pendingSuccessFocusRef.current = focusTarget;
      } else if (staleRetainedReplay) {
        // The old presentation is stale, so never resolve its Catalog/row
        // target. Move from the soon-to-unmount notice to a live shell target
        // before clearing it, then let the post-commit layout pass reaffirm
        // focus after React removes the notice.
        pendingShellFocusRef.current = true;
        focusSoon(currentContextStableFocusTarget());
      }
      clearActionNotice();
      operationOwnerRef.current = null;
      setOperationBusy(false);
      // Do not leave the global status stale after a recovery resolves.  A
      // terminal Worker rejection is just as conclusive as an applied replay:
      // both release the retained key and the shared operation owner.
      setFeedback({ tone: resolution === "unapplied" ? "info" : "success", message: resolution === "unapplied" ? "Mutation was not applied." : "Status reconciled." });
      if (focusAllowed || staleRetainedReplay) {
        setFocusGeneration((current) => current + 1);
      }
      restoreNoticeFocus();
    } catch {
      if (actionNoticeRef.current?.generation === generation) {
        if (canRestoreFocus()) {
          pendingRestoreFocusRef.current = focusTarget;
          setFocusGeneration((current) => current + 1);
        }
        setFeedback(codeFeedback("status_refresh_failed"));
        restoreNoticeFocus();
      }
    } finally {
      noticePendingRef.current = false;
      setNoticePending(false);
      setOperationBusy(false);
      if (recovery.isCurrent?.() === false && actionNoticeRef.current?.generation === generation && recoveryTrigger !== null) {
        window.requestAnimationFrame(() => {
          if (actionNoticeRef.current?.generation === generation && (document.activeElement === document.body || document.activeElement === recoveryTrigger)) {
            focusSoon(recoveryTrigger);
          }
        });
      }
    }
  }, [clearActionNotice, focusSoon, publishActionNotice, replaceActionNotice, setFeedback, setOperationBusy]);

  return { runMutation, runKeyedMutation, runConsequenceAction, runNoticeRecovery };
}
