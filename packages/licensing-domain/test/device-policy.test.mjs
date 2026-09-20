import assert from "node:assert/strict";
import test from "node:test";
import { deviceLeaseWindow, bindingOccupiesSlot, deviceLeaseEffectiveTime, assertDeviceLeaseAnchor } from "../src/lease/device_policy.mjs";

test("lease expiry is clamped and its capacity hold includes exactly the acceptance allowance", () => {
  assert.deepEqual(deviceLeaseWindow(1000, null), {issuedAt:1000, renewAfter:44200, expiresAt:87400, acceptUntil:87520});
  assert.deepEqual(deviceLeaseWindow(1000, 1100), {issuedAt:1000, renewAfter:1050, expiresAt:1100, acceptUntil:1220});
  for (const end of [999, 1000, 1001]) assert.throws(() => deviceLeaseWindow(1000, end));
  assert.throws(() => deviceLeaseWindow(Number.MAX_SAFE_INTEGER - 10, null));
  assert.equal(deviceLeaseWindow(Number.MAX_SAFE_INTEGER - 50000, Number.MAX_SAFE_INTEGER - 49000).expiresAt, Number.MAX_SAFE_INTEGER - 49000);
});

test("persistent slots survive expired leases and retired slots free exactly at their hold deadline", () => {
  assert.equal(bindingOccupiesSlot("active", 1200, 9000), true);
  assert.equal(bindingOccupiesSlot("retiring", 1200, 1199), true);
  assert.equal(bindingOccupiesSlot("retiring", 1200, 1200), false);
  assert.equal(bindingOccupiesSlot("released", 1200, 900), false);
  assert.throws(() => bindingOccupiesSlot("deleted", 1200, 900));
});

test("delayed response and same-process retry cannot restart offline allowance", () => {
  const issuedAt = 1000, originalSend = 50;
  assert.equal(deviceLeaseEffectiveTime(issuedAt, originalSend, 51), 1001);
  assert.equal(deviceLeaseEffectiveTime(issuedAt, originalSend, 1050), 1001);
  const heldResponse = originalSend + 86520 * 1000;
  assert.equal(deviceLeaseEffectiveTime(issuedAt, originalSend, heldResponse), 87520);
  assert.equal(deviceLeaseEffectiveTime(issuedAt, originalSend, heldResponse) >= deviceLeaseWindow(issuedAt, null).acceptUntil, true);
  // Receipt of the same response later only advances time.
  assert.ok(deviceLeaseEffectiveTime(issuedAt, originalSend, heldResponse + 1000) > deviceLeaseEffectiveTime(issuedAt, originalSend, heldResponse));
  assert.throws(() => deviceLeaseEffectiveTime(issuedAt, 100, 99));
  assert.throws(() => deviceLeaseEffectiveTime(issuedAt, 0, Infinity));
  assert.throws(() => deviceLeaseEffectiveTime(issuedAt, 1e20, 1e20 + 1000));
});

test("recovered old operations after restart cannot establish a new time anchor", () => {
  const claims = {"operation-id": "original"};
  assert.doesNotThrow(() => assertDeviceLeaseAnchor(claims, "original", true));
  assert.throws(() => assertDeviceLeaseAnchor(claims, "new-operation", true));
  assert.throws(() => assertDeviceLeaseAnchor(claims, "original", false));
  assert.throws(() => assertDeviceLeaseAnchor(claims, "original", "false"));
});
