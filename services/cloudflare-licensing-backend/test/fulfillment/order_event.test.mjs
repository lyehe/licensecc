// Unit tests for the PURE order-event modeling (Slice 1 order-ingest).
// Mirrors test/lease-worker.test.mjs's node:test + crypto style. No DB, no HTTP.
//
// Source under test: src/fulfillment/order_event.mjs
//   normalizeOrderEvent, deriveFingerprint, clampValidUntil, mapIntentToMutation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";

import {
  normalizeOrderEvent,
  deriveFingerprint,
  clampValidUntil,
  mapIntentToMutation,
} from "../../src/fulfillment/order_event.mjs";

const NOW = 1_700_000_000; // fixed "now" for deterministic period-end checks.

function baseBody(overrides = {}) {
  return {
    event_id: "evt_abc123",
    subscription_id: "sub_abc123",
    project: "DEFAULT",
    feature: "DEFAULT",
    intent: "subscription.active",
    seq: 1,
    current_period_end: NOW + 30 * 86400,
    ...overrides,
  };
}

// --- normalizeOrderEvent: accept --------------------------------------------

test("normalizeOrderEvent accepts a well-formed active order", () => {
  const out = normalizeOrderEvent(baseBody(), NOW);
  assert.equal(out.error, undefined);
  assert.equal(out.event_id, "evt_abc123");
  assert.equal(out.subscription_id, "sub_abc123");
  assert.equal(out.intent, "subscription.active");
  assert.equal(out.seq, 1);
  assert.equal(out.order_epoch, 0, "order_epoch defaults to 0");
  assert.equal(out.project, "DEFAULT");
  assert.equal(out.feature, "DEFAULT");
  assert.equal(out.current_period_end, NOW + 30 * 86400);
});

test("normalizeOrderEvent defaults feature to project when omitted", () => {
  const out = normalizeOrderEvent(baseBody({ feature: undefined }), NOW);
  assert.equal(out.error, undefined);
  assert.equal(out.feature, "DEFAULT", "feature falls back to project");
});

test("normalizeOrderEvent accepts optional quantity/customer/license_id/occurred_at", () => {
  const out = normalizeOrderEvent(
    baseBody({
      intent: "quantity.changed",
      quantity: { pool_size: 5, max_active_devices: 3 },
      customer: { id: "cus_1", external_ref: "ext_1", name: "Acme", email: "a@b.co" },
      license_id: "lic_1",
      occurred_at: NOW - 10,
    }),
    NOW,
  );
  assert.equal(out.error, undefined);
  assert.deepEqual(out.quantity, { pool_size: 5, max_active_devices: 3 });
  assert.deepEqual(out.customer, { id: "cus_1", external_ref: "ext_1", name: "Acme", email: "a@b.co" });
  assert.equal(out.license_id, "lic_1");
  assert.equal(out.occurred_at, NOW - 10);
});

test("normalizeOrderEvent accepts a supplied 64-hex fingerprint", () => {
  const fp = "a".repeat(64);
  const out = normalizeOrderEvent(baseBody({ license_fingerprint: fp }), NOW);
  assert.equal(out.error, undefined);
  assert.equal(out.license_fingerprint, fp);
});

// --- normalizeOrderEvent: reject branches -----------------------------------

test("normalizeOrderEvent rejects non-object / array / null bodies", () => {
  assert.equal(normalizeOrderEvent(null, NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent("x", NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(42, NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent([], NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects a bad now", () => {
  assert.equal(normalizeOrderEvent(baseBody(), -1).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody(), 1.5).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody(), "x").error, "invalid_order");
});

test("normalizeOrderEvent rejects missing/invalid ids", () => {
  assert.equal(normalizeOrderEvent(baseBody({ event_id: undefined }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ event_id: "" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ event_id: 123 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ subscription_id: undefined }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ project: undefined }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects ids carrying separator/injection bytes", () => {
  assert.equal(normalizeOrderEvent(baseBody({ event_id: "a\nb" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ event_id: "a=b" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ subscription_id: "a\r" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ project: "a\0b" }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects an unknown intent", () => {
  assert.equal(normalizeOrderEvent(baseBody({ intent: "subscription.bogus" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ intent: 1 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ intent: undefined }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects non-non-negative-integer seq/order_epoch", () => {
  assert.equal(normalizeOrderEvent(baseBody({ seq: -1 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ seq: 1.5 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ seq: "1" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ seq: undefined }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ order_epoch: -1 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ order_epoch: 2.5 }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects a non-64-hex supplied fingerprint", () => {
  assert.equal(normalizeOrderEvent(baseBody({ license_fingerprint: "xyz" }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ license_fingerprint: "A".repeat(64) }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ license_fingerprint: "a".repeat(63) }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects bad times", () => {
  assert.equal(normalizeOrderEvent(baseBody({ current_period_end: -5 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ current_period_end: 1.5 }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ occurred_at: "x" }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects bad quantity values", () => {
  assert.equal(normalizeOrderEvent(baseBody({ quantity: { pool_size: -1 } }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ quantity: { pool_size: 1.5 } }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ quantity: { max_active_devices: "3" } }), NOW).error, "invalid_order");
  assert.equal(normalizeOrderEvent(baseBody({ quantity: [] }), NOW).error, "invalid_order");
});

test("normalizeOrderEvent rejects current_period_end well in the past for a non-cancel intent", () => {
  // > GRACE (1 day) in the past -> invalid_order.
  const out = normalizeOrderEvent(baseBody({ current_period_end: NOW - 2 * 86400 }), NOW);
  assert.equal(out.error, "invalid_order");
});

test("normalizeOrderEvent allows a backdated period_end for a cancel intent", () => {
  const out = normalizeOrderEvent(
    baseBody({ intent: "subscription.canceled_at_period_end", current_period_end: NOW - 10 * 86400 }),
    NOW,
  );
  assert.equal(out.error, undefined, "cancel-at-period-end is exempt from the past-period rule");
  assert.equal(out.intent, "subscription.canceled_at_period_end");
});

test("normalizeOrderEvent tolerates period_end within the grace window", () => {
  const out = normalizeOrderEvent(baseBody({ current_period_end: NOW - 60 }), NOW);
  assert.equal(out.error, undefined, "60s in the past is inside the grace window");
});

// --- deriveFingerprint -------------------------------------------------------

test("deriveFingerprint is stable across renewals (period-independent)", async () => {
  const a = await deriveFingerprint({ subscription_id: "sub_X", project: "P", feature: "F" });
  const b = await deriveFingerprint({ subscription_id: "sub_X", project: "P", feature: "F" });
  assert.equal(a.origin, "derived");
  assert.equal(b.origin, "derived");
  assert.equal(a.fingerprint, b.fingerprint, "same subscription -> same fingerprint, regardless of renewal");

  // Matches the documented sha256(subscription_id:project:feature) hex.
  const expected = createHash("sha256").update("sub_X:P:F").digest("hex");
  assert.equal(a.fingerprint, expected);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
});

test("deriveFingerprint differs by subscription/project/feature", async () => {
  const base = await deriveFingerprint({ subscription_id: "s", project: "p", feature: "f" });
  const diffSub = await deriveFingerprint({ subscription_id: "s2", project: "p", feature: "f" });
  const diffProj = await deriveFingerprint({ subscription_id: "s", project: "p2", feature: "f" });
  const diffFeat = await deriveFingerprint({ subscription_id: "s", project: "p", feature: "f2" });
  assert.notEqual(base.fingerprint, diffSub.fingerprint);
  assert.notEqual(base.fingerprint, diffProj.fingerprint);
  assert.notEqual(base.fingerprint, diffFeat.fingerprint);
});

test("deriveFingerprint uses a supplied 64-hex fingerprint with origin 'supplied'", async () => {
  const fp = "c".repeat(64);
  const out = await deriveFingerprint({ subscription_id: "s", project: "p", feature: "f", supplied: fp });
  assert.equal(out.origin, "supplied");
  assert.equal(out.fingerprint, fp);
});

test("deriveFingerprint ignores a malformed supplied value and derives instead", async () => {
  const out = await deriveFingerprint({ subscription_id: "s", project: "p", feature: "f", supplied: "not-hex" });
  assert.equal(out.origin, "derived");
  assert.equal(out.fingerprint, createHash("sha256").update("s:p:f").digest("hex"));
});

// --- clampValidUntil ---------------------------------------------------------

test("clampValidUntil moves forward, never backward", () => {
  assert.equal(clampValidUntil(200, 100), 200, "newer period end wins");
  assert.equal(clampValidUntil(100, 200), 200, "stale period end never regresses prev");
  assert.equal(clampValidUntil(undefined, 150), 150, "missing period end keeps prev");
  assert.equal(clampValidUntil(150, undefined), 150, "missing prev keeps period end");
  assert.equal(clampValidUntil(undefined, undefined), 0, "both missing -> 0 (non-expiring)");
  assert.equal(clampValidUntil(0, 0), 0);
});

// --- mapIntentToMutation: every blueprint table row -------------------------

const ACTIVE_PREV = { status: "active", valid_until: 1000, valid_from: 0 };
const DISABLED_PREV = { status: "disabled", valid_until: 1000, valid_from: 0 };
const REVOKED_PREV = { status: "revoked", valid_until: 1000, valid_from: 0 };

function order(overrides = {}) {
  return {
    event_id: "e",
    subscription_id: "s",
    project: "p",
    feature: "f",
    order_epoch: 0,
    seq: 1,
    intent: "subscription.active",
    ...overrides,
  };
}

test("map: subscription.active -> create (only creator), clamped valid_until", () => {
  const d = mapIntentToMutation(order({ intent: "subscription.active", current_period_end: 2000 }), null, null);
  assert.equal(d.kind, "create");
  assert.equal(d.status, "active");
  assert.equal(d.eventType, "create");
  assert.equal(d.valid_until, 2000);
});

test("map: subscription.active create clamps forward against an existing prev", () => {
  const d = mapIntentToMutation(order({ intent: "subscription.active", current_period_end: 500 }), ACTIVE_PREV, null);
  assert.equal(d.kind, "create");
  assert.equal(d.valid_until, 1000, "stale period_end never regresses prev.valid_until");
});

test("map: subscription.renewed -> patch + carry-forward window (missing -> no_entitlement)", () => {
  const present = mapIntentToMutation(order({ intent: "subscription.renewed", current_period_end: 3000 }), ACTIVE_PREV, null);
  assert.equal(present.kind, "patch");
  assert.equal(present.status, "active");
  assert.equal(present.eventType, "update");
  assert.equal(present.valid_until, 3000, "renew carries the window forward");

  const missing = mapIntentToMutation(order({ intent: "subscription.renewed" }), null, null);
  assert.deepEqual(missing, { kind: "none", terminal: "no_entitlement" });
});

test("map: past_due / paused / payment_failed -> reversible disable", () => {
  for (const intent of ["subscription.past_due", "subscription.paused", "subscription.payment_failed"]) {
    const d = mapIntentToMutation(order({ intent }), ACTIVE_PREV, null);
    assert.equal(d.kind, "transition", `${intent} -> transition`);
    assert.equal(d.status, "disabled", `${intent} -> disabled (reversible)`);
    assert.equal(d.eventType, "disable");
    assert.equal(d.terminal, undefined, `${intent} is reversible, not terminal`);

    const missing = mapIntentToMutation(order({ intent }), null, null);
    assert.deepEqual(missing, { kind: "none", terminal: "no_entitlement" }, `${intent} missing -> no_entitlement`);
  }
});

test("map: canceled_at_period_end -> patch, keep active, never creates", () => {
  const d = mapIntentToMutation(order({ intent: "subscription.canceled_at_period_end", current_period_end: 1500 }), ACTIVE_PREV, null);
  assert.equal(d.kind, "patch");
  assert.equal(d.status, "active", "cancel keeps active until period end");
  assert.equal(d.valid_until, 1500);

  const missing = mapIntentToMutation(order({ intent: "subscription.canceled_at_period_end" }), null, null);
  assert.deepEqual(missing, { kind: "none", terminal: "no_entitlement" }, "cancel NEVER creates");
});

test("map: subscription.resumed -> reenable (missing -> no_entitlement)", () => {
  const d = mapIntentToMutation(order({ intent: "subscription.resumed" }), DISABLED_PREV, null);
  assert.equal(d.kind, "transition");
  assert.equal(d.status, "active");
  assert.equal(d.eventType, "reenable");

  const missing = mapIntentToMutation(order({ intent: "subscription.resumed" }), null, null);
  assert.deepEqual(missing, { kind: "none", terminal: "no_entitlement" });
});

test("map: quantity.changed -> capacity, plus reclaim on downgrade vs prior applied event", () => {
  // No downgrade (no prior pool / equal) -> capacity only.
  const flat = mapIntentToMutation(
    order({ intent: "quantity.changed", quantity: { pool_size: 5 } }),
    ACTIVE_PREV,
    null,
  );
  assert.equal(flat.kind, "capacity");
  assert.deepEqual(flat.capacity, { pool_size: 5 });
  assert.equal(flat.reclaim, undefined, "no prior applied event -> no reclaim");

  // Upgrade -> capacity only, no reclaim.
  const up = mapIntentToMutation(
    order({ intent: "quantity.changed", quantity: { pool_size: 10 } }),
    ACTIVE_PREV,
    { quantity: { pool_size: 5 } },
  );
  assert.equal(up.kind, "capacity");
  assert.equal(up.reclaim, undefined, "upgrade does not reclaim");

  // Downgrade -> capacity + reclaim diff from the PRIOR APPLIED EVENT's pool_size.
  const down = mapIntentToMutation(
    order({ intent: "quantity.changed", quantity: { pool_size: 3 } }),
    ACTIVE_PREV,
    { quantity: { pool_size: 8 } },
  );
  assert.equal(down.kind, "capacity");
  assert.deepEqual(down.capacity, { pool_size: 3 });
  assert.deepEqual(down.reclaim, { from: 8, to: 3 }, "downgrade reclaims from prior applied pool, not live state");

  // quantity.changed on a missing entitlement never materializes capacity.
  const missing = mapIntentToMutation(order({ intent: "quantity.changed", quantity: { pool_size: 3 } }), null, null);
  assert.deepEqual(missing, { kind: "none", terminal: "no_entitlement" });
});

test("map: fraud.confirmed / chargeback -> terminal revoke (only revoke path)", () => {
  for (const intent of ["fraud.confirmed", "chargeback"]) {
    const d = mapIntentToMutation(order({ intent }), ACTIVE_PREV, null);
    assert.equal(d.kind, "transition", `${intent} -> transition`);
    assert.equal(d.status, "revoked", `${intent} -> revoked`);
    assert.equal(d.eventType, "revoke");
    assert.equal(d.terminal, "revoked", `${intent} is terminal`);

    const missing = mapIntentToMutation(order({ intent }), null, null);
    assert.deepEqual(missing, { kind: "none", terminal: "no_entitlement" }, `${intent} missing -> nothing to revoke`);
  }
});

test("map: a revoked prev is terminal for every non-revoke intent", () => {
  for (const intent of [
    "subscription.active",
    "subscription.renewed",
    "subscription.past_due",
    "subscription.paused",
    "subscription.payment_failed",
    "subscription.canceled_at_period_end",
    "subscription.resumed",
    "quantity.changed",
  ]) {
    const d = mapIntentToMutation(order({ intent, quantity: { pool_size: 1 }, current_period_end: 9999 }), REVOKED_PREV, null);
    assert.deepEqual(d, { kind: "none", terminal: "revoked" }, `${intent} on revoked prev -> revoked terminal`);
  }
});

test("map: re-revoking a revoked prev is allowed (idempotent revoke path)", () => {
  const d = mapIntentToMutation(order({ intent: "fraud.confirmed" }), REVOKED_PREV, null);
  assert.equal(d.kind, "transition");
  assert.equal(d.status, "revoked");
  assert.equal(d.terminal, "revoked");
});

test("map: non-expiring create (no period end, no prior window) leaves valid_until open", () => {
  const d = mapIntentToMutation(order({ intent: "subscription.active" }), null, null);
  assert.equal(d.kind, "create");
  assert.equal(d.valid_until, null, "no finite window -> open-ended");
});

test("map: valid_from is only surfaced when strictly before the clamped valid_until", () => {
  // prev.valid_from (0) < clamped valid_until (2000) -> surfaced.
  const ok = mapIntentToMutation(order({ intent: "subscription.active", current_period_end: 2000 }), ACTIVE_PREV, null);
  assert.equal(ok.valid_from, 0);

  // prev.valid_from at/after the clamp must NOT be surfaced (would violate valid_from < valid_until).
  const tight = mapIntentToMutation(
    order({ intent: "subscription.active", current_period_end: 500 }),
    { status: "active", valid_until: 1000, valid_from: 1000 },
    null,
  );
  // clamp = max(500, 1000) = 1000; valid_from(1000) is NOT < 1000 -> omitted.
  assert.equal(tight.valid_until, 1000);
  assert.equal(tight.valid_from, undefined, "valid_from >= valid_until is never surfaced");
});
