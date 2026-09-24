// B1: the protected-create rules exist once. The in-batch assertion ANDs the named checks; the
// post-conflict diagnostic walks the SAME list in the same order, so the reason reported for a
// refusal can never describe a rule the assertion does not enforce (or miss one it does).
import assert from "node:assert/strict";
import test from "node:test";
import * as sharedApi from "../../dist-worker/shared/api.js";
// Loaded per test so a missing build output fails only these scenarios, not the whole Worker suite.
const checksModule = () => import("../../dist-worker/worker/groups/entitlements/protected-checks.js");

const input = { project: "APP", feature: "PRO", license_fingerprint: "a".repeat(64), customer_id: "owner", license_id: "license", enforcement_mode: "device_bound_v1" };
const policy = {
  id: "policy", project: "APP", name: "Policy", type: "trial", status: "active", valid_from_offset_sec: null, duration_sec: null,
  assertion_ttl_seconds: 300, pool_size: 0, max_active_devices: 3, max_borrow_sec: 0, meter_quota: 0, meter_period_sec: 2592000,
  expiry_strategy: "fixed_window", trial_expiration_basis: "from_first_activation", trial_duration_sec: 600, trial_one_per_device: 0,
  trial_require_device_proof: 0, notes: "", created_at: 1, updated_at: 1,
};

function capturingEnv(row = { reason: "customer_inactive" }) {
  const prepared = [];
  return {
    prepared,
    env: { DB: { prepare(sql) {
      const statement = { sql, args: [], bind(...args) { statement.args = args; return statement; }, async first() { return typeof row === "function" ? row() : row; } };
      prepared.push(statement);
      return statement;
    } } },
  };
}


for (const selected of [undefined, policy]) {
  test(`the batch assertion and the diagnostic come from one ordered check list (${selected ? "policy" : "no policy"})`, async () => {
    const { protectedCreateAssertion, protectedCreateChecks, protectedCreateReason, protectedWouldBeRowQuery } = await checksModule();
    const checks = protectedCreateChecks(input, selected);
    const tagged = new Set(checks.map((check) => check.reason));
    // The claim (an existing row with this key) is the diagnostic's last named rule; unknown is its default.
    assert.deepEqual([...new Set([...tagged, "fingerprint_in_use", "unknown"])].sort(), [...sharedApi.PROTECTED_CREATE_REASONS].sort());
    for (const check of checks) assert.ok(Array.isArray(check.binds) && typeof check.sql === "string" && check.sql.trim() !== "", check.reason);

    // Both queries must be exactly their fixed skeleton around the list, so a predicate added
    // outside the list (even a bind-free one) fails here instead of drifting from the diagnostic.
    const checkBinds = checks.flatMap((check) => check.binds);
    const assertion = capturingEnv();
    const statement = protectedCreateAssertion(assertion.env, input, selected);
    assert.equal(statement.sql, `SELECT CASE WHEN changes()=1 AND EXISTS (
    SELECT 1 FROM entitlements e WHERE e.project=? AND e.feature=? AND e.license_fingerprint=? AND e.enforcement_mode='device_bound_v1'
      AND ${checks.map((check) => `(${check.sql})`).join("\n      AND ")}
    ) THEN 1 ELSE json('protected_creation_conflict') END`);
    assert.deepEqual(statement.args, [input.project, input.feature, input.license_fingerprint, ...checkBinds]);

    const diagnostic = capturingEnv();
    assert.equal(await protectedCreateReason(diagnostic.env, input, selected), "customer_inactive");
    assert.equal(diagnostic.prepared.length, 1, "one diagnostic SELECT");
    const [query] = diagnostic.prepared;
    const wouldBe = protectedWouldBeRowQuery(input, selected);
    assert.equal(query.sql, `${wouldBe.sql}
    SELECT CASE ${checks.map((check) => `WHEN NOT coalesce((${check.sql}), 0) THEN '${check.reason}'`).join("\n      ")}
      WHEN EXISTS (SELECT 1 FROM entitlements s WHERE s.project=e.project AND s.feature=e.feature AND s.license_fingerprint=e.license_fingerprint) THEN 'fingerprint_in_use'
      ELSE 'unknown' END AS reason FROM e`);
    assert.deepEqual(query.args, [...wouldBe.binds, ...checkBinds], "the checks bind the same values in both queries");
  });
}

test("the diagnostic's would-be row provides every column a check reads from e", async () => {
  const { protectedCreateChecks, protectedCreateReason } = await checksModule();
  for (const selected of [undefined, policy]) {
    const diagnostic = capturingEnv();
    await protectedCreateReason(diagnostic.env, input, selected);
    const provided = new Set([...diagnostic.prepared[0].sql.matchAll(/ AS ([a-z_]+)/g)].map((match) => match[1]));
    const read = new Set(protectedCreateChecks(input, selected).flatMap((check) => [...check.sql.matchAll(/\be\.([a-z_]+)/g)].map((match) => match[1])));
    assert.ok(read.size > 10);
    for (const column of read) assert.ok(provided.has(column), `the would-be row lacks e.${column}, so every refusal would read as unknown`);
  }
});

// B2: a create without a policy may set its own device limit. Its side-write rides the create batch,
// so the would-be row carries that value instead of the kept one, and the batch requires the row to
// hold exactly what the create wrote.
test("a create's own device limit is modelled in the would-be row and required of the written row", async () => {
  const { protectedCreateAssertion, protectedCreateChecks, protectedWouldBeRowQuery } = await checksModule();
  const limited = { ...input, max_active_devices: 3 };
  const wouldBe = protectedWouldBeRowQuery(limited);
  assert.equal(JSON.parse(wouldBe.binds[0]).max_active_devices, 3);
  assert.doesNotMatch(wouldBe.sql, /x\.max_active_devices, 1\) AS max_active_devices/);
  const written = protectedCreateChecks(limited).find((check) => check.reason === "unknown");
  assert.match(written.sql, /AND e\.max_active_devices IS \?$/);
  assert.deepEqual(written.binds, ["owner", "license", 3]);
  assert.deepEqual(protectedCreateAssertion(capturingEnv().env, limited).args.slice(-3), ["owner", "license", 3]);
  // Without its own limit a create keeps the existing value; a policy's stamp is checked by policy_mismatch.
  assert.deepEqual(protectedCreateChecks(input).find((check) => check.reason === "unknown").binds, ["owner", "license"]);
  assert.deepEqual(protectedCreateChecks(input, policy).find((check) => check.reason === "unknown").binds, ["owner", "license"]);
});

// B2 fix round 1 (ruling R27): capacity_in_use during a create comes from one of two schema
// triggers. The owner-change rule is a named check in the same list, and it alone tells the two
// apart against the would-be row.
test("a capacity refusal is named by the list's owner-change rule: a move to another customer, or the device limit", async () => {
  const { protectedCapacityReason, protectedCreateChecks, protectedWouldBeRowQuery } = await checksModule();
  const owner = protectedCreateChecks(input).find((check) => check.reason === "devices_connected");
  assert.ok(owner, "moving a grant with connected devices is a named rule");
  assert.match(owner.sql, /cur\.customer_id IS NOT e\.customer_id/);
  assert.match(owner.sql, /b\.state = 'active' OR \(b\.state = 'retiring' AND b\.hold_until > unixepoch\(\)\)/, "it counts with the shared occupancy predicate");
  const wouldBe = protectedWouldBeRowQuery(input);
  for (const [answer, reason] of [[{ holds: 0 }, "devices_connected"], [{ holds: 1 }, "invalid_capacity"], [null, "invalid_capacity"],
    [() => { throw new Error("D1 unavailable"); }, "invalid_capacity"]]) {
    const probe = capturingEnv(answer);
    assert.equal(await protectedCapacityReason(probe.env, input), reason, JSON.stringify(answer));
    assert.equal(probe.prepared.length, 1, "one read");
    assert.ok(probe.prepared[0].sql.startsWith(wouldBe.sql) && probe.prepared[0].sql.includes(`(${owner.sql})`));
    assert.deepEqual(probe.prepared[0].args, [...wouldBe.binds, ...owner.binds]);
  }
});

test("the diagnostic falls back to unknown for an unrecognized answer or a failed read", async () => {
  const { protectedCreateReason } = await checksModule();
  for (const row of [null, { reason: "not_a_reason" }, { reason: 7 }, () => { throw new Error("D1 unavailable"); }]) {
    assert.equal(await protectedCreateReason(capturingEnv(row).env, input), "unknown");
  }
});
