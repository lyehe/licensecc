import React, { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../../shared/api";
import {
  confirmMutationUnknown,
  confirmSuccessWithRefreshFailure,
  EXACT_READ_PROOF,
  type ConfirmActionContext,
  type ConfirmActionOutcome,
  type ConfirmActionResolution,
  type ConfirmFocusTarget,
  type ExactReadProof,
} from "../../shared/controls";
import { feedbackWith, refusalOutcome } from "../../shared/messages";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { BatchRunPanel, createBatchRunStore, type BatchRunStore } from "./BatchRunPanel";
import { batchPlanText, batchReconcileLabel, batchRefreshFailureMessage, batchStopDetail, batchStopMessage, classifyBatchChunk, planBatchChunks, runBatchChunks, settleReconciledChunk, type BatchChunk, type BatchRunState } from "./batchRunner";
import { batchPath, batchResultSentence, type EntitlementAction } from "./workflow";

/** The list context a later reconcile must still match, captured as the single-row transitions do. */
export interface BatchRecoveryContext {
  isCurrent: () => boolean;
  capture: () => void;
}

export interface EntitlementBatchOptions {
  /** The loaded rows selected when the operator starts the action. */
  selectedIds: readonly string[];
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  runMutation: <T>(work: () => Promise<T>, owner?: "consequence" | "recovery") => Promise<T | undefined>;
  refreshCore: (strict?: boolean) => Promise<ExactReadProof | null>;
  currentReason: () => string;
  setFeedback: Dispatch<SetStateAction<OperatorFeedback>>;
  setReason: Dispatch<SetStateAction<string>>;
  recoveryContext: () => BatchRecoveryContext;
}

export interface EntitlementBatch {
  store: BatchRunStore;
  /** One confirmed decision: its run (one confirmation, one reason) and the dialog's live progress. */
  begin: (action: EntitlementAction) => { run: (context: ConfirmActionContext) => Promise<ConfirmActionOutcome>; details: React.ReactNode };
  /** Focus lands on the run's counts once its dialog closes. */
  focusTarget: ConfirmFocusTarget;
}

const focusTarget: ConfirmFocusTarget = () => document.querySelector<HTMLElement>('[data-focus-section="entitlements"] .batchRun');

/**
 * Runs a selection of any size as sequential chunks under the operation gate
 * the confirmation (or consequence action) already holds. Each chunk has its
 * own key; the first chunk that is not done stops the run. An unknown chunk
 * becomes the retained operation, reconciled by replaying that chunk exactly.
 */
export function useEntitlementBatch(options: EntitlementBatchOptions): EntitlementBatch {
  const [store] = useState(createBatchRunStore);
  const { selectedIds, setSelectedIds, runMutation, refreshCore, currentReason, setFeedback, setReason, recoveryContext } = options;
  const deselect = (ids: readonly string[]): void => setSelectedIds((previous) => {
    const next = new Set(previous);
    for (const id of ids) next.delete(id);
    return next.size === previous.size ? previous : next;
  });

  function begin(action: EntitlementAction): ReturnType<EntitlementBatch["begin"]> {
    const ids = [...new Set(selectedIds)];
    const runId = store.reserve();
    const publish = (state: BatchRunState): void => store.set({ runId, state });
    const post = (chunk: BatchChunk, owner: "consequence" | "recovery"): Promise<unknown> => runMutation(async () => {
      try {
        return await api<unknown>(batchPath(), { method: "POST", headers: { "idempotency-key": chunk.idempotencyKey }, body: chunk.body });
      } catch {
        return null;
      }
    }, owner);
    const run = async ({ idempotencyKey }: ConfirmActionContext): Promise<ConfirmActionOutcome> => {
      if (ids.length === 0) return refusalOutcome("no_entitlements_selected", null);
      const { isCurrent, capture } = recoveryContext();
      const refreshStatus = async (): Promise<ExactReadProof | null> => {
        capture();
        return await refreshCore(true);
      };
      const finished = await runBatchChunks(action, planBatchChunks(action, ids, currentReason(), idempotencyKey), (chunk) => post(chunk, "consequence"), publish);
      deselect(finished.results.map((row) => row.id));
      const stopped = finished.stopped;
      if (stopped?.kind === "unknown") {
        const replay = async (): Promise<ConfirmActionResolution> => {
          capture();
          const response = await post(stopped.chunk, "recovery");
          const outcome = response === undefined ? null : classifyBatchChunk(response, action, stopped.chunk.ids, "replay");
          if (outcome?.kind !== "done") return "indeterminate";
          const latest = store.get();
          if (latest?.runId === runId) publish(settleReconciledChunk(latest.state, outcome));
          deselect(stopped.chunk.ids);
          try {
            return (await refreshStatus()) === EXACT_READ_PROOF ? "applied" : "refresh_failed";
          } catch {
            return "refresh_failed";
          }
        };
        if (finished.done > 0) {
          // Show what the done chunks changed; the reconcile's own strict read proves the rest.
          try { await refreshCore(true); } catch { /* the reconcile refreshes again */ }
        }
        const postSuccessRefresh = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent).manualRefresh;
        return confirmMutationUnknown({ label: batchReconcileLabel(finished), run: replay, isCurrent, settlesRetainedAttempt: true, postSuccessRefresh });
      }
      const stopMessage = batchStopMessage(finished);
      const stopDetail = batchStopDetail(finished);
      if (stopMessage !== null) {
        // Nothing was applied, exactly as when a single request is refused: the
        // confirmation stays open to correct and retry, under a fresh key, and
        // shows the refusal itself. After partial progress the page reports it.
        if (finished.done === 0) return { ok: false, message: stopMessage, detail: stopDetail, retryable: true };
        setFeedback(stopDetail === undefined ? { tone: "error", message: stopMessage } : feedbackWith(stopMessage, stopDetail.code, stopDetail.requestId));
      } else {
        // Every request id stays in the run panel's Technical details. A row that did not change is
        // not a success, so the sentence is only neutral then.
        const tone = finished.results.some((row) => !row.ok) ? "info" : "success";
        setFeedback(feedbackWith(batchResultSentence(action, finished.results), "batch_done", finished.requestIds.length === 1 ? finished.requestIds[0] : null, tone));
      }
      setReason("");
      // After partial progress a definite refusal is a known outcome, as a success
      // is: nothing is retained, so the confirmation closes on the panel's counts.
      // If the status read then fails, its notice must still say the run stopped.
      const refreshFailed = (): ConfirmActionOutcome => {
        const recovery = confirmSuccessWithRefreshFailure(refreshStatus, isCurrent);
        return stopMessage === null ? recovery : { ...recovery, warning: batchRefreshFailureMessage(finished), detail: stopDetail };
      };
      try {
        return (await refreshCore(true)) === EXACT_READ_PROOF ? { ok: true } : refreshFailed();
      } catch {
        return refreshFailed();
      }
    };
    const details = <><p>{batchPlanText(ids.length)}</p><BatchRunPanel store={store} runId={runId} /></>;
    return { run, details };
  }

  return { store, begin, focusTarget };
}
