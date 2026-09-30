import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SUPPORT_UNTIL_EPOCH_SECONDS } from "@licensecc/licensing-domain/catalog/plan_projection";
import { MockD1, adminInternalsForTests, authed, baseEnv, json, recordingDb, worker } from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("catalog routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("catalog", 21);
  await assertRouteGroupRejectsUnauthenticated("catalog");
});

function projectionInput(overrides = {}) {
  return {
    project: "DEFAULT",
    license_id: "lic_projection",
    license_fingerprint: "a".repeat(64),
    plan_key: "basic",
    ...overrides,
  };
}

test("plan projection rejects unsafe support_until before it can reach D1", async () => {
  const db = new MockD1();
  for (const support_until of [253_402_300_800, 1e100, 1.5]) {
    const response = await worker.fetch(
      authed("/api/admin/license-plans/preview", { method: "POST", body: JSON.stringify(projectionInput({ support_until })) }),
      baseEnv(db),
    );
    assert.equal(response.status, 400, String(support_until));
    assert.equal((await json(response)).code, "invalid_request", String(support_until));
  }
  assert.equal(db.lastBatchSize, 0, "invalid epoch values must be rejected before D1");
});

test("plan projection worker validation uses the documented safe epoch ceiling", () => {
  assert.equal(MAX_SUPPORT_UNTIL_EPOCH_SECONDS, 253_402_300_799);
  const { validatePlanProjectionInput } = adminInternalsForTests;
  for (const support_until of [0, MAX_SUPPORT_UNTIL_EPOCH_SECONDS]) {
    assert.equal(validatePlanProjectionInput(projectionInput({ support_until }))?.support_until, support_until);
  }
  for (const support_until of [MAX_SUPPORT_UNTIL_EPOCH_SECONDS + 1, 1e100, 1.5]) {
    assert.equal(validatePlanProjectionInput(projectionInput({ support_until })), null, String(support_until));
  }
});

test("a plan feature with pool_size is refused", async () => {
  // A plan feature names only its device limit and policy; seat, borrow, meter and TTL fields are refused.
  for (const field of [{ pool_size: 5 }, { max_borrow_sec: 60 }, { meter_quota: 10 }, { meter_period_sec: 60 }, { assertion_ttl_seconds: 120 }]) {
    const db = recordingDb();
    const response = await worker.fetch(authed("/api/admin/catalog/plans/plan_1/features", {
      method: "POST",
      body: JSON.stringify({ project: "APP", feature_key: "PRO", max_active_devices: 2, ...field }),
    }), baseEnv(db));
    assert.equal(response.status, 400, JSON.stringify(field));
    assert.equal((await json(response)).code, "invalid_request");
    assert.deepEqual(db.statements, [], `${JSON.stringify(field)} never reaches D1`);

    const manifest = {
      format_version: 1,
      features: [{ project: "APP", feature_key: "PRO", name: "Pro" }],
      plans: [{ project: "APP", plan_key: "basic", name: "Basic", features: [{ project: "APP", feature_key: "PRO", ...field }] }],
    };
    const preview = await worker.fetch(authed("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(manifest) }), baseEnv(db));
    assert.equal(preview.status, 400, `import ${JSON.stringify(field)}`);
    assert.equal((await json(preview)).code, "invalid_request");
    assert.deepEqual(db.statements, [], `an imported ${JSON.stringify(field)} never reaches D1`);
  }
});

test("a plan feature's max_active_devices is capped at MAX_DEVICE_LIMIT (1,000,000), like the entitlement device limit", async () => {
  const db = recordingDb();
  const response = await worker.fetch(authed("/api/admin/catalog/plans/plan_1/features", {
    method: "POST",
    body: JSON.stringify({ project: "APP", feature_key: "PRO", max_active_devices: 1_000_001 }),
  }), baseEnv(db));
  assert.equal(response.status, 400);
  assert.equal((await json(response)).code, "invalid_request");
  assert.deepEqual(db.statements, [], "a device limit over the cap never reaches D1");

  const manifest = {
    format_version: 1,
    features: [{ project: "APP", feature_key: "PRO", name: "Pro" }],
    plans: [{ project: "APP", plan_key: "basic", name: "Basic", features: [{ project: "APP", feature_key: "PRO", max_active_devices: 1_000_001 }] }],
  };
  const preview = await worker.fetch(authed("/api/admin/catalog/import?dry_run=1", { method: "POST", body: JSON.stringify(manifest) }), baseEnv(db));
  assert.equal(preview.status, 400);
  assert.equal((await json(preview)).code, "invalid_request");
  assert.deepEqual(db.statements, [], "an imported device limit over the cap never reaches D1");
});
