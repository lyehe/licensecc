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

function inOrder(haystack, needles) {
  let from = 0;
  for (const needle of needles) {
    const at = haystack.indexOf(needle, from);
    assert.ok(at >= 0, `missing, or out of order: ${needle.slice(0, 80)}`);
    from = at + needle.length;
  }
}

for (const selected of [undefined, policy]) {
  test(`the batch assertion and the diagnostic come from one ordered check list (${selected ? "policy" : "no policy"})`, async () => {
    const { protectedCreateAssertion, protectedCreateChecks, protectedCreateReason } = await checksModule();
    const checks = protectedCreateChecks(input, selected);
    const tagged = new Set(checks.map((check) => check.reason));
    // The claim (an existing row with this key) is the diagnostic's last named rule; unknown is its default.
    assert.deepEqual([...new Set([...tagged, "fingerprint_in_use", "unknown"])].sort(), [...sharedApi.PROTECTED_CREATE_REASONS].sort());
    for (const check of checks) assert.ok(Array.isArray(check.binds) && typeof check.sql === "string" && check.sql.trim() !== "", check.reason);

    const assertion = capturingEnv();
    const statement = protectedCreateAssertion(assertion.env, input, selected);
    inOrder(statement.sql, checks.map((check) => `(${check.sql})`));
    assert.match(statement.sql, /^SELECT CASE WHEN changes\(\)=1 AND EXISTS \(/);
    assert.match(statement.sql, /THEN 1 ELSE json\('protected_creation_conflict'\) END$/);
    assert.deepEqual(statement.args, [input.project, input.feature, input.license_fingerprint, ...checks.flatMap((check) => check.binds)]);

    const diagnostic = capturingEnv();
    assert.equal(await protectedCreateReason(diagnostic.env, input, selected), "customer_inactive");
    assert.equal(diagnostic.prepared.length, 1, "one diagnostic SELECT");
    const [query] = diagnostic.prepared;
    inOrder(query.sql, [...checks.map((check) => `WHEN NOT coalesce((${check.sql}), 0) THEN '${check.reason}'`), "THEN 'fingerprint_in_use'", "ELSE 'unknown' END"]);
    const checkBinds = checks.flatMap((check) => check.binds);
    assert.deepEqual(query.args.slice(query.args.length - checkBinds.length), checkBinds, "the checks bind the same values in both queries");
  });
}

test("the diagnostic falls back to unknown for an unrecognized answer or a failed read", async () => {
  const { protectedCreateReason } = await checksModule();
  for (const row of [null, { reason: "not_a_reason" }, { reason: 7 }, () => { throw new Error("D1 unavailable"); }]) {
    assert.equal(await protectedCreateReason(capturingEnv(row).env, input), "unknown");
  }
});
