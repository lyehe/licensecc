import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkflowModule } from "./helpers.mjs";

// A batch larger than the Worker's four-id cap runs as sequential chunks. These
// contracts pin the pure runner: how a selection is split, how each chunk's
// response is classified, and where a run stops.

const loadRunner = () => loadWorkflowModule("features/entitlements/batchRunner.ts");

/** The UI `api()` envelope: the parsed body plus its non-JSON transport facts. */
function envelope(status, body) {
  return { ...(body ?? {}), __httpOk: status >= 200 && status < 300, __httpStatus: status, __rawBody: body };
}

function batchDone(ids, action = "disable", requestId = "ui-unit-batch") {
  return envelope(200, {
    ok: true,
    code: "batch_done",
    request_id: requestId,
    data: { results: ids.map((id) => ({ id, ok: true, code: `entitlement_${action}d` })) },
  });
}

const refusal = (status, code, requestId = `ui-unit-${status}`) => envelope(status, { ok: false, code, request_id: requestId });
const twenty = Array.from({ length: 20 }, (_unused, index) => `ent-${index + 1}`);

test("a selection splits into sequential chunks of at most four, each with its own key and immutable body", async () => {
  const runner = await loadRunner();
  const chunks = runner.planBatchChunks("disable", twenty, "contract ended", "base-key");
  assert.deepEqual(chunks.map((chunk) => chunk.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(chunks.map((chunk) => chunk.ids.length), [4, 4, 4, 4, 4]);
  assert.deepEqual(chunks[2].ids, ["ent-9", "ent-10", "ent-11", "ent-12"]);
  assert.deepEqual(chunks.map((chunk) => chunk.idempotencyKey), ["base-key:1", "base-key:2", "base-key:3", "base-key:4", "base-key:5"]);
  assert.deepEqual(JSON.parse(chunks[2].body), { action: "disable", reason: "contract ended", ids: ["ent-9", "ent-10", "ent-11", "ent-12"] });

  assert.deepEqual(runner.planBatchChunks("revoke", ["a", "b", "c", "d", "e"], "r", "k").map((chunk) => chunk.ids), [["a", "b", "c", "d"], ["e"]]);
  assert.deepEqual(runner.planBatchChunks("reenable", ["a", "b", "a"], "", "k").map((chunk) => chunk.ids), [["a", "b"]], "duplicates are dropped and first-loaded order kept");
  assert.deepEqual(runner.planBatchChunks("disable", [], "r", "k"), []);
});

test("a chunk is done only on its exact proof; a 5xx, lost transport or malformed success stays unknown; a well-formed 4xx is failed", async () => {
  const runner = await loadRunner();
  const ids = ["ent-1", "ent-2"];
  const classify = (response, phase = "initial") => runner.classifyBatchChunk(response, "disable", ids, phase);

  const done = classify(batchDone(ids, "disable", "ui-unit-done"));
  assert.equal(done.kind, "done");
  assert.equal(done.requestId, "ui-unit-done");
  assert.deepEqual(done.results.map((row) => row.id), ids);

  for (const unknown of [
    refusal(500, "internal_error"),
    refusal(503, "temporarily_unavailable"),
    envelope(0, undefined),
    null,
    undefined,
    batchDone(["ent-1", "ent-3"]),
    batchDone(ids, "revoke"),
    envelope(409, { ok: false, code: "idempotency_request_conflict" }),
    envelope(409, { ok: true, code: "batch_done", request_id: "ui-unit-409" }),
  ]) {
    assert.deepEqual(classify(unknown), { kind: "unknown" });
  }

  assert.deepEqual(classify(refusal(409, "idempotency_request_conflict", "ui-unit-conflict")), { kind: "failed", code: "idempotency_request_conflict", requestId: "ui-unit-conflict" });
  assert.deepEqual(classify(refusal(400, "entitlement_batch_too_large", "ui-unit-large")), { kind: "failed", code: "entitlement_batch_too_large", requestId: "ui-unit-large" });
  assert.deepEqual(classify(refusal(403, "admin_role_required", "ui-unit-role")), { kind: "failed", code: "admin_role_required", requestId: "ui-unit-role" });
  // A same-key replay happens after the original may have committed, so only its exact success settles it.
  assert.deepEqual(classify(refusal(409, "idempotency_request_conflict"), "replay"), { kind: "unknown" });
  assert.equal(classify(batchDone(ids), "replay").kind, "done");
});

test("chunk 3 of 5 returning 500 stops the run with 8 done, 4 outcome unknown and 8 not attempted after exactly 3 requests", async () => {
  const runner = await loadRunner();
  const chunks = runner.planBatchChunks("disable", twenty, "audit", "rf5");
  const sent = [];
  const progress = [];
  const state = await runner.runBatchChunks("disable", chunks, async (chunk) => {
    sent.push(chunk.idempotencyKey);
    return chunk.index === 3 ? refusal(500, "internal_error") : batchDone(chunk.ids);
  }, (snapshot) => progress.push(snapshot.running ? runner.batchProgressText(snapshot) : "stopped"));

  assert.deepEqual(sent, ["rf5:1", "rf5:2", "rf5:3"], "nothing is sent after the unknown chunk");
  assert.deepEqual(progress, ["Chunk 1 of 5", "Chunk 2 of 5", "Chunk 3 of 5", "stopped"]);
  assert.equal(state.running, false);
  assert.equal(state.stopped.kind, "unknown");
  assert.equal(state.stopped.chunk.index, 3);
  assert.equal(state.stopped.chunk.idempotencyKey, "rf5:3");
  assert.deepEqual(state.stopped.chunk.ids, ["ent-9", "ent-10", "ent-11", "ent-12"]);
  assert.deepEqual(runner.batchRunCounts(state), { done: 8, unknown: 4, failed: 0, notAttempted: 8 });
  assert.deepEqual(runner.batchCountItems(state), ["8 done", "4 outcome unknown", "8 not attempted"]);
  assert.match(runner.batchRunHeadline(state), /stopped at chunk 3 of 5/);
  assert.match(runner.batchRunHeadline(state), /unknown/);
});

test("a definite refusal on chunk 2 reads failed, not unknown, and stops after 2 requests", async () => {
  const runner = await loadRunner();
  const chunks = runner.planBatchChunks("revoke", twenty, "chargeback", "k");
  let requests = 0;
  const state = await runner.runBatchChunks("revoke", chunks, async (chunk) => {
    requests += 1;
    return chunk.index === 2 ? refusal(409, "idempotency_request_conflict", "ui-unit-chunk-two") : batchDone(chunk.ids, "revoke");
  }, () => {});
  assert.equal(requests, 2);
  assert.equal(state.stopped.kind, "failed");
  assert.equal(state.stopped.code, "idempotency_request_conflict");
  assert.equal(state.stopped.requestId, "ui-unit-chunk-two");
  assert.deepEqual(runner.batchRunCounts(state), { done: 4, unknown: 0, failed: 4, notAttempted: 12 });
  assert.deepEqual(runner.batchCountItems(state), ["4 done", "4 failed", "12 not attempted"]);
  assert.doesNotMatch(runner.batchRunHeadline(state), /unknown/);
});

test("a send the operation gate refuses stops the run as failed, never as sent", async () => {
  const runner = await loadRunner();
  const chunks = runner.planBatchChunks("disable", twenty.slice(0, 8), "r", "k");
  const state = await runner.runBatchChunks("disable", chunks, async () => undefined, () => {});
  assert.equal(state.stopped.kind, "failed");
  assert.deepEqual(runner.batchRunCounts(state), { done: 0, unknown: 0, failed: 4, notAttempted: 4 });
});

test("an all-success run reports every row done, in order, with each chunk's request id", async () => {
  const runner = await loadRunner();
  const chunks = runner.planBatchChunks("disable", twenty, "audit", "k");
  const state = await runner.runBatchChunks("disable", chunks, async (chunk) => batchDone(chunk.ids, "disable", `rid-${chunk.index}`), () => {});
  assert.equal(state.stopped, null);
  assert.equal(state.running, false);
  assert.deepEqual(runner.batchRunCounts(state), { done: 20, unknown: 0, failed: 0, notAttempted: 0 });
  assert.deepEqual(runner.batchCountItems(state), ["20 done"]);
  assert.deepEqual(state.results.map((row) => row.id), twenty);
  assert.deepEqual(state.requestIds, ["rid-1", "rid-2", "rid-3", "rid-4", "rid-5"]);
  assert.match(runner.batchRunHeadline(state), /finished/);
});

test("a same-key replay that proves the unknown chunk settles it as done and leaves the rest not attempted", async () => {
  const runner = await loadRunner();
  const chunks = runner.planBatchChunks("disable", twenty, "audit", "k");
  const stopped = await runner.runBatchChunks("disable", chunks, async (chunk) => chunk.index === 3 ? envelope(0, undefined) : batchDone(chunk.ids), () => {});
  const replay = runner.classifyBatchChunk(batchDone(stopped.stopped.chunk.ids, "disable", "rid-replay"), "disable", stopped.stopped.chunk.ids, "replay");
  const settled = runner.settleReconciledChunk(stopped, replay);
  assert.equal(settled.stopped, null);
  assert.equal(settled.reconciled, 3);
  assert.deepEqual(runner.batchRunCounts(settled), { done: 12, unknown: 0, failed: 0, notAttempted: 8 });
  assert.deepEqual(runner.batchCountItems(settled), ["12 done", "8 not attempted"]);
  assert.match(runner.batchRunHeadline(settled), /reconciled/);
  assert.equal(runner.settleReconciledChunk(settled, replay), settled, "only an unknown chunk can be settled");
});

test("the confirmation names the chunk plan before anything is sent", async () => {
  const runner = await loadRunner();
  assert.match(runner.batchPlanText(20), /5 requests of up to 4/);
  assert.match(runner.batchPlanText(20), /stops at the first request that does not succeed/);
  assert.match(runner.batchPlanText(5), /2 requests of up to 4/);
  assert.match(runner.batchPlanText(3), /one request/);
});
