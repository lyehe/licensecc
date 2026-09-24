import assert from "node:assert/strict";
import test from "node:test";
import { authed, baseEnv, worker } from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("customer routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("customers", 15);
  await assertRouteGroupRejectsUnauthenticated("customers");
});

test("customer license creation rejects a missing key or an invalid body before touching D1", async () => {
  const env = baseEnv({ prepare() { throw new Error("D1 must not be touched"); }, batch() { throw new Error("D1 must not be touched"); } });
  const post = (body, headers = { "idempotency-key": "license-key" }) =>
    worker.fetch(authed("/api/admin/customers/cust_1/licenses", { method: "POST", headers, body: JSON.stringify(body) }), env);
  for (const [body, headers, code] of [
    [{ project: "APP" }, {}, "invalid_idempotency_key"],
    [{ project: "APP" }, { "idempotency-key": "k".repeat(129) }, "invalid_idempotency_key"],
    [{ label: "no project" }, undefined, "invalid_request"],
    [{ project: "APP SPACE" }, undefined, "invalid_request"],
    [{ project: "APP", label: "x".repeat(129) }, undefined, "invalid_request"],
    [{ project: "APP", label: "tab\there" }, undefined, "invalid_request"],
  ]) {
    const response = await post(body, headers);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, code, JSON.stringify(body));
  }
});
