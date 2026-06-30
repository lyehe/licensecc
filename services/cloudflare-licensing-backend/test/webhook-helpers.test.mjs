// Hermetic unit coverage for the PURE webhook helpers (no DB, no fetch): payload normalization,
// the event_types CSV filter, exponential backoff, and the HMAC signature round-trip through
// verifyWebhookSignature (including tampered-body and expired-t rejection). Runs raw under
// `node --test` — only Web Crypto + globals, no node:sqlite.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadSecretMap } from "../src/fulfillment/order_hmac.mjs";
import {
  buildWebhookPayload,
  eventTypeMatches,
  nextBackoff,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_REPLAY_WINDOW_SECONDS,
} from "../src/webhooks/webhook.mjs";

// A 32-byte base64 secret (24 raw bytes is < 32 and would be rejected; use 32 bytes).
const SECRET_B64 = Buffer.alloc(32, 7).toString("base64");
const SECRETS = loadSecretMap(JSON.stringify({ k1: SECRET_B64 }));

test("eventTypeMatches: '' filter matches all; csv is an exact allow-list", () => {
  assert.equal(eventTypeMatches("", "create"), true, "empty filter = all");
  assert.equal(eventTypeMatches("   ", "create"), true, "whitespace-only filter = all");
  assert.equal(eventTypeMatches("create,update", "update"), true);
  assert.equal(eventTypeMatches("create,update", "disable"), false);
  assert.equal(eventTypeMatches(" create , update ", "create"), true, "trims entries");
  assert.equal(eventTypeMatches("create", "createx"), false, "no substring match");
});

test("buildWebhookPayload normalizes each source's BEFORE/AFTER state", () => {
  const ent = buildWebhookPayload("entitlement", {
    event_id: 5,
    event_type: "update",
    occurred_at: 1000,
    project: "P",
    feature: "F",
    license_fingerprint: "a".repeat(64),
    status: "active",
    prev_json: '{"status":"disabled"}',
    next_json: '{"status":"active"}',
  });
  assert.deepEqual(ent, {
    id: 5,
    type: "update",
    source: "entitlement",
    occurred_at: 1000,
    data: {
      project: "P",
      feature: "F",
      license_fingerprint: "a".repeat(64),
      status: "active",
      prev: { status: "disabled" },
      next: { status: "active" },
    },
  });

  const cust = buildWebhookPayload("customer", {
    event_id: 9,
    event_type: "disable",
    occurred_at: 2000,
    customer_id: "cust_1",
    prev_status: "active",
    next_status: "disabled",
  });
  assert.equal(cust.source, "customer");
  assert.deepEqual(cust.data, { customer_id: "cust_1", prev_status: "active", next_status: "disabled" });

  const order = buildWebhookPayload("order", {
    event_id: 12,
    order_event_id: "evt_abc",
    event_type: "subscription.created",
    occurred_at: 3000,
    subscription_id: "sub_1",
    project: "P",
    feature: "F",
    status: "processed",
    result_json: '{"ok":true}',
  });
  assert.equal(order.source, "order");
  assert.equal(order.data.order_event_id, "evt_abc");
  assert.deepEqual(order.data.result, { ok: true });

  // Malformed/empty JSON columns degrade to null, never throw.
  const bad = buildWebhookPayload("entitlement", {
    event_id: 1,
    event_type: "create",
    occurred_at: 1,
    project: "P",
    feature: "F",
    license_fingerprint: "b".repeat(64),
    status: "active",
    prev_json: "",
    next_json: "{not json",
  });
  assert.equal(bad.data.prev, null);
  assert.equal(bad.data.next, null);
});

test("nextBackoff is the documented increasing schedule, clamped at the tail", () => {
  assert.equal(nextBackoff(1), 30);
  assert.equal(nextBackoff(2), 120);
  assert.equal(nextBackoff(3), 600);
  assert.equal(nextBackoff(4), 3600);
  assert.equal(nextBackoff(5), 21600);
  assert.equal(nextBackoff(6), 21600, "clamps to the last interval past the schedule");
  assert.equal(nextBackoff(0), 30, "attempts<=0 maps to the first interval");
});

test("signWebhookBody header round-trips through verifyWebhookSignature", async () => {
  const now = 1_700_000_000;
  const body = JSON.stringify({ id: 1, type: "create", source: "entitlement" });
  const header = await signWebhookBody(SECRETS, "k1", body, now);
  assert.match(header, /^t=1700000000,keyid=k1,v1=[0-9a-f]{64}$/);

  const ok = await verifyWebhookSignature(body, header, SECRETS, now);
  assert.equal(ok, true, "fresh signature over the exact body verifies");

  // Within the window still verifies.
  assert.equal(await verifyWebhookSignature(body, header, SECRETS, now + 200), true);
});

test("verifyWebhookSignature rejects a tampered body", async () => {
  const now = 1_700_000_000;
  const body = JSON.stringify({ id: 1, type: "create" });
  const header = await signWebhookBody(SECRETS, "k1", body, now);
  const tampered = body.replace('"create"', '"delete"');
  assert.equal(await verifyWebhookSignature(tampered, header, SECRETS, now), false);
});

test("verifyWebhookSignature rejects an expired t (outside the replay window)", async () => {
  const now = 1_700_000_000;
  const body = JSON.stringify({ id: 1 });
  const header = await signWebhookBody(SECRETS, "k1", body, now);
  const stale = now + WEBHOOK_REPLAY_WINDOW_SECONDS + 1;
  assert.equal(await verifyWebhookSignature(body, header, SECRETS, stale), false, "t too old fails");
  // And a future t beyond the window also fails.
  assert.equal(
    await verifyWebhookSignature(body, header, SECRETS, now - WEBHOOK_REPLAY_WINDOW_SECONDS - 1),
    false,
  );
});

test("verifyWebhookSignature rejects unknown key id, malformed header, and non-canonical t", async () => {
  const now = 1_700_000_000;
  const body = "{}";
  const header = await signWebhookBody(SECRETS, "k1", body, now);

  // Unknown keyid.
  const otherMap = loadSecretMap(JSON.stringify({ k2: Buffer.alloc(32, 9).toString("base64") }));
  assert.equal(await verifyWebhookSignature(body, header, otherMap, now), false, "unknown keyid fails");

  // Malformed header.
  assert.equal(await verifyWebhookSignature(body, "garbage", SECRETS, now), false);
  assert.equal(await verifyWebhookSignature(body, "", SECRETS, now), false);

  // Non-canonical t spelling must fail even if numerically equal.
  const nonCanon = header.replace("t=1700000000", "t=1700000000.0");
  assert.equal(await verifyWebhookSignature(body, nonCanon, SECRETS, now), false);

  // Null secret map (fail-closed) -> false.
  assert.equal(await verifyWebhookSignature(body, header, null, now), false);
});
