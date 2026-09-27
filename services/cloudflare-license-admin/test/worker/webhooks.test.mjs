import assert from "node:assert/strict";
import test from "node:test";
import { WEBHOOK_EVENT_TYPES } from "@licensecc/cloudflare-runtime/webhooks/event_types";
import { authed, baseEnv, worker } from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";

test("webhook routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("webhooks", 8);
  await assertRouteGroupRejectsUnauthenticated("webhooks");
});

// An unknown event_types token can never match a real event, so create/patch reject it up front
// (400 invalid_event_types + the allowed list) before ever touching D1 -- proven here with a DB
// stub that throws if touched, the same guard-rail pattern customers.test.mjs uses for its own
// pre-D1 validation rejections.
function untouchableDb() {
  return {
    prepare() { throw new Error("D1 must not be touched"); },
    batch() { throw new Error("D1 must not be touched"); },
  };
}

test("creating a webhook with an unknown event_types token returns 400 invalid_event_types with the allowed list, before touching D1", async () => {
  const env = baseEnv(untouchableDb());
  const response = await worker.fetch(
    authed("/api/admin/webhooks", {
      method: "POST",
      headers: { "idempotency-key": "webhook-create-invalid-event-types" },
      body: JSON.stringify({ url: "https://hooks.example.com/lcc", event_types: "not_a_real_event_type" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_event_types");
  assert.deepEqual(body.data?.allowed, WEBHOOK_EVENT_TYPES);
});

test("patching a webhook with an unknown event_types token returns 400 invalid_event_types with the allowed list, before touching D1", async () => {
  const env = baseEnv(untouchableDb());
  const response = await worker.fetch(
    authed("/api/admin/webhooks/wh_1", {
      method: "PATCH",
      headers: { "idempotency-key": "webhook-patch-invalid-event-types" },
      body: JSON.stringify({ event_types: "not_a_real_event_type" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_event_types");
  assert.deepEqual(body.data?.allowed, WEBHOOK_EVENT_TYPES);
});
