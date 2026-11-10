import assert from "node:assert/strict";
import test from "node:test";
import { loadWorkflowModules } from "./helpers.mjs";

async function fixture() {
  const [runner, actions, guards] = await loadWorkflowModules([
    "shared/consequenceMutation.ts", "shared/operatorActions.ts", "shared/mutationGuards.ts",
  ]);
  const writes = [], phases = [], owners = [], applied = [];
  let captures = 0;
  let reads = 0;
  let read = async () => actions.EXACT_READ_PROOF;
  const request = { method: "POST", path: "/api/admin/customers/customer-a/disable", body: '{"reason":"retire"}', idempotencyKey: "retained-key" };
  const action = {
    request,
    runMutation: async (work, owner) => { owners.push(owner); return await work(); },
    parse: (value, phase) => {
      phases.push(phase);
      return guards.parseMutationResponse(value, "customer_disabled", data => data?.id === "customer-a" && data?.status === "disabled", guards.mutationFailurePolicies.customerTransition.disable, phase);
    },
    onApplied: value => applied.push(value),
    refresh: async () => { reads += 1; return await read(); },
    captureRecoveryContext: () => { captures += 1; },
    isCurrent: () => true,
  };
  const send = body => ({ status: 200, ok: true, json: async () => body });
  const success = () => send({ ok: true, code: "customer_disabled", request_id: "request-success", data: { id: "customer-a", status: "disabled" } });
  return { ...runner, ...actions, action, writes, phases, owners, applied, success, get captures() { return captures; }, get reads() { return reads; }, setRead(value) { read = value; } };
}

test("consequence reconciliation retains the original key, body and endpoint and applies only an exact replay", async t => {
  const work = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (path, init) => {
    work.writes.push({ path, ...init });
    if (work.writes.length === 1) throw new Error("response lost");
    return work.success();
  };
  const outcome = await work.runConsequenceMutation(work.action);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.unknown, true);
  assert.equal(outcome.reconciliation.settlesRetainedAttempt, true);
  work.action.request.path = "/api/admin/customers/customer-b/disable";
  work.action.request.body = '{"reason":"changed"}';
  work.action.request.idempotencyKey = "different-key";
  assert.equal(await outcome.reconciliation.run(), "applied");
  assert.deepEqual(work.writes.map(({ path, method, headers, body }) => ({ path, method, key: headers["idempotency-key"], body })), [
    { path: "/api/admin/customers/customer-a/disable", method: "POST", key: "retained-key", body: '{"reason":"retire"}' },
    { path: "/api/admin/customers/customer-a/disable", method: "POST", key: "retained-key", body: '{"reason":"retire"}' },
  ]);
  assert.deepEqual(work.owners, ["consequence", "recovery"]);
  assert.deepEqual(work.phases, ["initial", "replay"]);
  assert.equal(work.captures, 2, "replay and its strict read each acquire the current recovery context");
  assert.equal(work.reads, 1);
  assert.equal(work.applied.length, 0, "replayed success refreshes the current view rather than applying stale local form updates");
});

test("a proven initial refusal or occupied gate does not retain a consequence mutation", async t => {
  const work = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return { status: 403, ok: false, json: async () => ({ ok: false, code: "admin_role_required", request_id: "refused" }) };
  };
  const refused = await work.runConsequenceMutation(work.action);
  assert.equal(refused.ok, false);
  assert.equal(refused.unknown, undefined);
  assert.equal(refused.reconciliation, undefined);
  assert.equal(work.reads, 0);
  assert.equal(work.applied.length, 0);
  work.action.runMutation = async () => undefined;
  const busy = await work.runConsequenceMutation(work.action);
  assert.equal(busy.ok, false);
  assert.equal(busy.unknown, undefined);
  assert.equal(busy.reconciliation, undefined);
  assert.equal(sends, 1, "an occupied gate must not issue the mutation");
});

test("known consequence success recovers only with strict reads after a failed refresh", async t => {
  const work = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return work.success(); };
  work.setRead(async () => { throw new Error("GET failed"); });
  const outcome = await work.runConsequenceMutation(work.action);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.manualRefresh.settlesKnownSuccess, true);
  assert.equal(work.applied.length, 1);
  work.setRead(async () => null);
  assert.equal(await outcome.manualRefresh.run(), "indeterminate");
  work.setRead(async () => work.EXACT_READ_PROOF);
  assert.equal(await outcome.manualRefresh.run(), "applied");
  assert.equal(work.applied.length, 1);
  assert.equal(sends, 1, "post-success recovery must not issue another POST");
});

test("a successful replay with an unproved refresh leaves a GET-only recovery", async t => {
  const work = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let sends = 0;
  globalThis.fetch = async () => { sends += 1; return sends === 1 ? { status: 502, ok: false, json: async () => null } : work.success(); };
  work.setRead(async () => null);
  const outcome = await work.runConsequenceMutation(work.action);
  assert.equal(await outcome.reconciliation.run(), "refresh_failed");
  assert.equal(outcome.reconciliation.postSuccessRefresh.settlesKnownSuccess, true);
  work.setRead(async () => work.EXACT_READ_PROOF);
  assert.equal(await outcome.reconciliation.postSuccessRefresh.run(), "applied");
  assert.equal(sends, 2);
  assert.equal(work.applied.length, 0);
});
