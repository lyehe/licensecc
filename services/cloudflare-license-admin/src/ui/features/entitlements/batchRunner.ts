import { ENTITLEMENT_BATCH_MAX_IDS } from "../../../shared/api";
import { hasBatchResultsData, mutationFailurePolicies, parseMutationResponse, type MutationPhase } from "../../shared/mutationGuards";
import { batchBody, type BatchRowResult, type EntitlementAction } from "./workflow";

/*
 * A selection larger than the Worker's per-request cap runs as sequential
 * chunks of at most ENTITLEMENT_BATCH_MAX_IDS ids. The cap itself stays with
 * the Worker contract; this module only splits, classifies and stops. It has
 * no React and sends nothing itself, so every rule here is unit-testable.
 */

/** One request of a batch run. Its key and body are fixed, so an unknown outcome can replay it exactly. */
export interface BatchChunk {
  /** 1-based position in the run. */
  readonly index: number;
  readonly ids: readonly string[];
  readonly idempotencyKey: string;
  readonly body: string;
}

export type BatchChunkOutcome =
  | { kind: "done"; requestId: string; results: BatchRowResult[] }
  | { kind: "failed"; code: string; requestId: string }
  | { kind: "unknown" };

/**
 * Where a run stopped. "failed" is a definite refusal (its code and request id
 * are the Worker's); "not_sent" means the operation gate refused the send, so
 * no request left the browser and the chunk's rows count as not attempted.
 */
export interface BatchStop {
  readonly kind: "unknown" | "failed" | "not_sent";
  readonly chunk: BatchChunk;
  readonly code?: string;
  readonly requestId?: string;
}

export interface BatchRunState {
  readonly action: EntitlementAction;
  readonly total: number;
  readonly chunkCount: number;
  /** The chunk being sent, or the last one sent; 0 before the first. */
  readonly current: number;
  readonly running: boolean;
  /** Rows in chunks whose exact batch proof arrived. */
  readonly done: number;
  /** Rows in chunks after the stop (or not yet reached while running). */
  readonly notAttempted: number;
  readonly results: readonly BatchRowResult[];
  readonly requestIds: readonly string[];
  readonly stopped: BatchStop | null;
  /** The chunk a same-key replay later proved, if any. */
  readonly reconciled: number | null;
}

/** Split ids (duplicates dropped, first-loaded order kept) into chunks; chunk k's key is `${baseKey}:${k}`. */
export function planBatchChunks(action: EntitlementAction, ids: readonly string[], reason: string, baseKey: string): BatchChunk[] {
  const unique = [...new Set(ids)];
  const chunks: BatchChunk[] = [];
  for (let start = 0; start < unique.length; start += ENTITLEMENT_BATCH_MAX_IDS) {
    const chunkIds = unique.slice(start, start + ENTITLEMENT_BATCH_MAX_IDS);
    const index = chunks.length + 1;
    chunks.push(Object.freeze({ index, ids: Object.freeze(chunkIds), idempotencyKey: `${baseKey}:${index}`, body: JSON.stringify(batchBody(action, chunkIds, reason)) }));
  }
  return chunks;
}

function definiteRefusal(response: unknown): { code: string; requestId: string } | null {
  if (response === null || typeof response !== "object" || Array.isArray(response)) return null;
  const envelope = response as Record<string, unknown>;
  const status = envelope.__httpStatus;
  if (envelope.__httpOk !== false || typeof status !== "number" || status < 400 || status > 499 || envelope.ok !== false) return null;
  const { code, request_id: requestId } = envelope;
  return typeof code === "string" && code.trim() !== "" && typeof requestId === "string" && requestId.trim() !== "" ? { code, requestId } : null;
}

/**
 * Only the exact `batch_done` proof for exactly these ids makes a chunk done.
 * Every 4xx the batch route returns is decided before its first database read
 * (auth, key, body, action, reason, ids, size); per-row failures come back
 * inside a 200. So a well-formed 4xx refusal proves the chunk was not applied
 * and reads "failed". A 5xx, a lost transport or an unreadable answer may
 * follow a commit and stays unknown. A same-key replay runs after the original
 * may have committed, so on replay only an exact success settles anything.
 */
export function classifyBatchChunk(response: unknown, action: EntitlementAction, ids: readonly string[], phase: MutationPhase): BatchChunkOutcome {
  const expectedCode = `entitlement_${action}d`;
  const guard = (value: unknown): value is { results: BatchRowResult[] } => hasBatchResultsData(value, ids, expectedCode);
  const parsed = parseMutationResponse(response, "batch_done", guard, mutationFailurePolicies.entitlementBatch[action], phase);
  if (parsed.kind === "success") return { kind: "done", requestId: parsed.requestId, results: parsed.data.results.map(({ id, ok, code }) => ({ id, ok, code })) };
  if (parsed.kind === "failure") return { kind: "failed", code: parsed.code, requestId: parsed.requestId };
  const refusal = phase === "initial" ? definiteRefusal(response) : null;
  return refusal === null ? { kind: "unknown" } : { kind: "failed", ...refusal };
}

export function initialBatchRunState(action: EntitlementAction, chunks: readonly BatchChunk[]): BatchRunState {
  const total = chunks.reduce((sum, chunk) => sum + chunk.ids.length, 0);
  return { action, total, chunkCount: chunks.length, current: 0, running: true, done: 0, notAttempted: total, results: [], requestIds: [], stopped: null, reconciled: null };
}

/**
 * Send the chunks one at a time and stop at the first that is not done. After
 * the stop nothing further is sent. `send` resolving `undefined` means the
 * operation gate refused the request, so it was never sent: the run stops as
 * "not sent", its rows stay not attempted, and there is no request id to show.
 */
export async function runBatchChunks(
  action: EntitlementAction,
  chunks: readonly BatchChunk[],
  send: (chunk: BatchChunk) => Promise<unknown>,
  onProgress: (state: BatchRunState) => void,
): Promise<BatchRunState> {
  let state = initialBatchRunState(action, chunks);
  for (const chunk of chunks) {
    state = { ...state, current: chunk.index };
    onProgress(state);
    const response = await send(chunk);
    if (response === undefined) {
      state = { ...state, running: false, stopped: { kind: "not_sent", chunk } };
      onProgress(state);
      return state;
    }
    const outcome = classifyBatchChunk(response, action, chunk.ids, "initial");
    const notAttempted = state.notAttempted - chunk.ids.length;
    if (outcome.kind === "done") {
      state = { ...state, done: state.done + chunk.ids.length, notAttempted, results: [...state.results, ...outcome.results], requestIds: [...state.requestIds, outcome.requestId] };
      continue;
    }
    const stopped: BatchStop = outcome.kind === "failed" ? { kind: "failed", chunk, code: outcome.code, requestId: outcome.requestId } : { kind: "unknown", chunk };
    state = { ...state, running: false, notAttempted, stopped };
    onProgress(state);
    return state;
  }
  state = { ...state, running: false };
  onProgress(state);
  return state;
}

/** A same-key replay proved the unknown chunk: its rows become done; nothing else changes. */
export function settleReconciledChunk(state: BatchRunState, outcome: Extract<BatchChunkOutcome, { kind: "done" }>): BatchRunState {
  const stopped = state.stopped;
  if (stopped === null || stopped.kind !== "unknown") return state;
  return {
    ...state,
    done: state.done + stopped.chunk.ids.length,
    results: [...state.results, ...outcome.results],
    requestIds: [...state.requestIds, outcome.requestId],
    stopped: null,
    reconciled: stopped.chunk.index,
  };
}

export function batchRunCounts(state: BatchRunState): { done: number; unknown: number; failed: number; notAttempted: number } {
  const stopped = state.stopped;
  return {
    done: state.done,
    unknown: stopped?.kind === "unknown" ? stopped.chunk.ids.length : 0,
    failed: stopped?.kind === "failed" ? stopped.chunk.ids.length : 0,
    notAttempted: state.notAttempted,
  };
}

/** The counts an operator reads: done always; the stopped chunk and the rest once the run has stopped. */
export function batchCountItems(state: BatchRunState): string[] {
  const counts = batchRunCounts(state);
  if (state.running) return [`${counts.done} done`];
  const items = [`${counts.done} done`];
  if (counts.unknown > 0) items.push(`${counts.unknown} outcome unknown`);
  if (counts.failed > 0) items.push(`${counts.failed} failed`);
  if (state.stopped !== null || counts.notAttempted > 0) items.push(`${counts.notAttempted} not attempted`);
  return items;
}

/*
 * Copy. A run of one chunk is a single request and keeps the single-request
 * wording ("Reconcile status", a plain "code (request id)" refusal). A longer
 * run is spoken of in chunks, each sent as one request.
 */

export function batchProgressText(state: Pick<BatchRunState, "current" | "chunkCount">): string {
  return state.chunkCount <= 1 ? "Sending one request" : `Chunk ${state.current} of ${state.chunkCount}`;
}

const ACTION_LABELS: Record<EntitlementAction, string> = { disable: "Disable", reenable: "Reenable", revoke: "Revoke" };

export function batchRunHeadline(state: BatchRunState): string {
  const label = ACTION_LABELS[state.action];
  if (state.running) return batchProgressText(state);
  const single = state.chunkCount <= 1;
  const stopped = state.stopped;
  if (stopped !== null) {
    if (single) return stopped.kind === "unknown" ? `${label}: the outcome is unknown.` : stopped.kind === "failed" ? `${label} was refused.` : `${label} was not sent.`;
    const where = `${label} stopped at chunk ${stopped.chunk.index} of ${state.chunkCount}`;
    return stopped.kind === "unknown" ? `${where}: its outcome is unknown.` : stopped.kind === "failed" ? `${where}: the request was refused.` : `${where}: it was not sent.`;
  }
  if (state.reconciled !== null) {
    if (single) return `${label} finished; the request is now reconciled.`;
    return state.notAttempted > 0
      ? `${label} stopped at chunk ${state.reconciled} of ${state.chunkCount}; chunk ${state.reconciled} is now reconciled.`
      : `${label} finished; chunk ${state.reconciled} is now reconciled.`;
  }
  return `${label} finished.`;
}

/** The message for a run that stopped on a refusal or an unsent chunk; null otherwise. */
export function batchStopMessage(state: BatchRunState): string | null {
  const stopped = state.stopped;
  if (stopped === null || stopped.kind === "unknown") return null;
  if (stopped.kind === "not_sent") return batchRunHeadline(state);
  const refusal = `${stopped.code} (${stopped.requestId})`;
  return state.chunkCount <= 1 ? refusal : `${batchRunHeadline(state)} ${refusal}`;
}

/** The notice control that replays the unknown chunk under its own key. */
export function batchReconcileLabel(state: BatchRunState): string {
  const stopped = state.stopped;
  return state.chunkCount <= 1 || stopped === null ? "Reconcile status" : `Reconcile chunk ${stopped.chunk.index}`;
}

/**
 * Where the reconcile control lives: in the operator notice at the bottom of
 * the page, which cannot be reached while the confirmation is still open.
 */
export function batchReconcileGuidance(state: BatchRunState, where: "dialog" | "page"): string | null {
  if (state.stopped?.kind !== "unknown") return null;
  const control = `“${batchReconcileLabel(state)}” in the notice at the bottom of the page`;
  const lead = where === "dialog" ? `Close this dialog, then use ${control}.` : `Use ${control}.`;
  return `${lead} It replays that exact request under its original key; other actions stay unavailable until it is reconciled.`;
}

/** A stopped run whose status read then failed: say both, never that the action succeeded. */
export function batchRefreshFailureMessage(state: BatchRunState): string {
  return `${batchRunHeadline(state)} Status refresh failed.`;
}

/** The plan the operator confirms: how many chunks, and that the run stops at the first one that does not succeed. */
export function batchPlanText(count: number): string {
  const chunks = Math.ceil(count / ENTITLEMENT_BATCH_MAX_IDS);
  if (chunks <= 1) return "Sent as one request.";
  return `Sent as ${chunks} chunks of up to ${ENTITLEMENT_BATCH_MAX_IDS} entitlements, one request each, one chunk at a time. The run stops at the first chunk that does not succeed, and nothing after it is sent.`;
}
