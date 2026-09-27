import React, { useSyncExternalStore } from "react";
import { batchCountItems, batchRunHeadline, type BatchRunState } from "./batchRunner";
import { summarizeBatchResults } from "./workflow";

export interface BatchRunEntry {
  readonly runId: number;
  readonly state: BatchRunState;
}

/**
 * The latest batch run, shared by the list and the open confirmation. The
 * dialog renders outside the entitlements tree, so a store it subscribes to is
 * what lets it show a run's progress live.
 */
export interface BatchRunStore {
  get: () => BatchRunEntry | null;
  set: (entry: BatchRunEntry | null) => void;
  subscribe: (listener: () => void) => () => void;
  /** A fresh id for one confirmed decision, so its dialog only ever shows its own run. */
  reserve: () => number;
}

export function createBatchRunStore(): BatchRunStore {
  let entry: BatchRunEntry | null = null;
  let lastRunId = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => entry,
    set: (next) => {
      entry = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reserve: () => {
      lastRunId += 1;
      return lastRunId;
    },
  };
}

/**
 * "Chunk k of m" while a run is sending, then its counts. Inside the dialog it
 * shows only the dialog's own run (`runId`); in the list it shows the latest.
 */
export function BatchRunPanel({ store, runId, onDismiss }: { store: BatchRunStore; runId?: number; onDismiss?: () => void }): React.ReactElement | null {
  const entry = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (entry === null || (runId !== undefined && entry.runId !== runId)) return null;
  const { state } = entry;
  const stopped = state.stopped;
  const keptSelected = !state.running && (stopped !== null || state.notAttempted > 0);
  return <section className="batchRun" aria-label="Batch run" tabIndex={-1}>
    <div role="status" aria-live="polite" aria-atomic="true">
      <p><strong>{batchRunHeadline(state)}</strong></p>
      <ul className="batchCounts">{batchCountItems(state).map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
    {stopped?.kind === "unknown" && <p>Use “Reconcile chunk {stopped.chunk.index}” to replay that exact request under its original key. Other actions stay unavailable until it is reconciled.</p>}
    {keptSelected && <p className="muted">Entitlements that are not done stay selected.</p>}
    {(state.requestIds.length > 0 || stopped !== null) && <details><summary>Technical details</summary><dl className="recordMeta">
      {state.results.some((row) => !row.ok) && <div><dt>Per-row results</dt><dd>{summarizeBatchResults(state.results)}</dd></div>}
      {state.requestIds.length > 0 && <div><dt>Request IDs</dt><dd><code>{state.requestIds.join(", ")}</code></dd></div>}
      {stopped !== null && <div><dt>Chunk {stopped.chunk.index} idempotency key</dt><dd><code>{stopped.chunk.idempotencyKey}</code></dd></div>}
      {stopped !== null && <div><dt>Chunk {stopped.chunk.index} entitlement IDs</dt><dd><code>{stopped.chunk.ids.join(", ")}</code></dd></div>}
      {stopped?.code !== undefined && <div><dt>Refusal</dt><dd><code>{stopped.code} ({stopped.requestId})</code></dd></div>}
    </dl></details>}
    {onDismiss !== undefined && !state.running && stopped?.kind !== "unknown" && <button type="button" onClick={onDismiss}>Dismiss</button>}
  </section>;
}
