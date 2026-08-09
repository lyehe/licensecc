import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SUPPORT_UNTIL_EPOCH_SECONDS } from "@licensecc/licensing-domain/catalog/plan_projection";
import { MockD1, adminInternalsForTests, authed, baseEnv, json, worker } from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("catalog routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("catalog", 20);
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
