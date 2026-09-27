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

export interface BatchStop {
  readonly kind: "unknown" | "failed";
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
 * operation gate refused the request, so it was never sent: that stops the run
 * as a definite failure rather than an unknown outcome.
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
    const outcome: BatchChunkOutcome = response === undefined
      ? { kind: "failed", code: "mutation_busy", requestId: "not_sent" }
      : classifyBatchChunk(response, action, chunk.ids, "initial");
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

export function batchProgressText(state: Pick<BatchRunState, "current" | "chunkCount">): string {
  return `Chunk ${state.current} of ${state.chunkCount}`;
}

const ACTION_LABELS: Record<EntitlementAction, string> = { disable: "Disable", reenable: "Reenable", revoke: "Revoke" };

export function batchRunHeadline(state: BatchRunState): string {
  const label = ACTION_LABELS[state.action];
  if (state.running) return batchProgressText(state);
  const stopped = state.stopped;
  if (stopped !== null) {
    const where = `${label} stopped at chunk ${stopped.chunk.index} of ${state.chunkCount}`;
    return stopped.kind === "unknown" ? `${where}: its outcome is unknown.` : `${where}: the request was refused.`;
  }
  if (state.reconciled !== null) {
    return state.notAttempted > 0
      ? `${label} stopped at chunk ${state.reconciled} of ${state.chunkCount}; chunk ${state.reconciled} is now reconciled.`
      : `${label} finished; chunk ${state.reconciled} is now reconciled.`;
  }
  return `${label} finished.`;
}

/** The plan the operator confirms: how many requests, and that the run stops at the first one that does not succeed. */
export function batchPlanText(count: number): string {
  const requests = Math.ceil(count / ENTITLEMENT_BATCH_MAX_IDS);
  if (requests <= 1) return "Sent as one request.";
  return `Sent as ${requests} requests of up to ${ENTITLEMENT_BATCH_MAX_IDS}, one at a time. The run stops at the first request that does not succeed, and nothing after it is sent.`;
}
