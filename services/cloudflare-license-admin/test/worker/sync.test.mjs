import assert from "node:assert/strict";
import test from "node:test";
import {
  NEXT_JSON_KEYS,
  MockD1,
  accessAuthed,
  accessEnv,
  accessFixture,
  accessToken,
  adminInternalsForTests,
  authed,
  baseEnv,
  clone,
  effectiveLicenseMode,
  entitlementDefaults,
  fingerprint,
  json,
  keyOf,
  rotatableAccessFixture,
  syncAuthed,
  syncEnv,
  worker,
} from "./fixtures.mjs";
import { assertRouteGroup, assertRouteGroupRejectsUnauthenticated } from "./route-group-assertions.mjs";
test("sync route has a direct owner and rejects anonymous access", async () => {
  assertRouteGroup("sync", 1);
  await assertRouteGroupRejectsUnauthenticated("sync");
});

test("sync endpoint requires its dedicated bearer secret", async () => {
  const payload = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint };
  const missing = await worker.fetch(syncAuthed(payload), baseEnv(new MockD1()));
  assert.equal(missing.status, 401);
  assert.equal((await json(missing)).code, "sync_auth_not_configured");

  const invalid = await worker.fetch(new Request("https://admin.example/api/sync/entitlements", {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), syncEnv(new MockD1()));
  assert.equal(invalid.status, 403);
  assert.equal((await json(invalid)).code, "invalid_sync_token");
});

// Every synced grant is protected, so it names the customer who owns it and that customer's license.
const ownedSync = { project: "APP", feature: "PRO", license_fingerprint: fingerprint, status: "active", customer_id: "cus_1", license_id: "lic_1" };

// A MockD1 that also holds the active customer and that customer's license for the project, so a
// sync naming them passes the protected create checks.
function ownedDb(customerId, licenseId, project = "DEFAULT") {
  const db = new MockD1();
  db.customers.set(customerId, { id: customerId, status: "active" });
  db.licenses.set(licenseId, { id: licenseId, customer_id: customerId, project });
  return db;
}

test("sync without customer_id is refused", async () => {
  const db = new MockD1();
  const { customer_id: _omitted, ...payload } = ownedSync;
  for (const body of [payload, { ...payload, customer_id: null }, { ...payload, customer_id: "" }]) {
    const response = await worker.fetch(syncAuthed(body), syncEnv(db));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await json(response)).code, "invalid_request");
  }
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
});

test("sync without license_id is refused", async () => {
  const db = new MockD1();
  const { license_id: _omitted, ...payload } = ownedSync;
  for (const body of [payload, { ...payload, license_id: null }, { ...payload, license_id: "" }]) {
    const response = await worker.fetch(syncAuthed(body), syncEnv(db));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await json(response)).code, "invalid_request");
  }
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
});

test("sync refuses device_hash and assertion_ttl_seconds", async () => {
  const db = new MockD1();
  for (const field of [{ device_hash: "" }, { device_hash: "d".repeat(64) }, { assertion_ttl_seconds: 300 }]) {
    const response = await worker.fetch(syncAuthed({ ...ownedSync, ...field }), syncEnv(db));
    assert.equal(response.status, 400, JSON.stringify(field));
    assert.equal((await json(response)).code, "invalid_request");
  }
  assert.equal(db.entitlements.size, 0);
});

test("sync endpoint upserts user database projection and no-ops identical state", async () => {
  const db = ownedDb("cus_123", "lic_123");
  const env = syncEnv(db);
  const payload = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    status: "active",
    customer_id: "cus_123",
    license_id: "lic_123",
    notes: "paid account",
  };

  const first = await worker.fetch(syncAuthed(payload, { headers: { "idempotency-key": "sync-1" } }), env);
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  assert.equal(firstBody.code, "entitlement_synced");
  assert.equal(firstBody.data.customer_id, "cus_123");
  assert.equal(firstBody.data.license_id, "lic_123");
  assert.equal(firstBody.data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].source, "sync");
  assert.equal(db.events[0].actor_type, "sync");

  const identical = await worker.fetch(syncAuthed(payload), env);
  assert.equal(identical.status, 200);
  assert.equal((await json(identical)).data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
});

test("sync endpoint revokes with reason and keeps revoked terminal", async () => {
  const db = ownedDb("cus_456", "lic_456");
  const env = syncEnv(db);
  const active = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    status: "active",
    customer_id: "cus_456",
    license_id: "lic_456",
  };
  assert.equal((await worker.fetch(syncAuthed(active), env)).status, 200);

  const missingReason = await worker.fetch(syncAuthed({ ...active, status: "revoked" }), env);
  assert.equal(missingReason.status, 400);
  assert.equal((await json(missingReason)).code, "reason_required");

  const revoked = await worker.fetch(syncAuthed({ ...active, status: "revoked", reason: "chargeback" }), env);
  assert.equal(revoked.status, 200);
  const revokedBody = await json(revoked);
  assert.equal(revokedBody.data.status, "revoked");
  assert.equal(revokedBody.data.customer_id, "cus_456");
  assert.equal(revokedBody.data.license_id, "lic_456");
  assert.equal(revokedBody.data.revocation_seq, 2);
  assert.equal(db.events.at(-1).event_type, "revoke");
  assert.equal(db.events.at(-1).source, "sync");
  assert.equal(db.events.at(-1).reason, "chargeback");

  const reactivate = await worker.fetch(syncAuthed(active), env);
  assert.equal(reactivate.status, 409);
  assert.equal((await json(reactivate)).code, "revoked_entitlement_is_terminal");
});

test("sync endpoint records status transition event types while updating projection", async () => {
  const db = ownedDb("cus_789", "lic_789");
  const env = syncEnv(db);
  const base = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    customer_id: "cus_789",
    license_id: "lic_789",
  };

  const disabled = await worker.fetch(syncAuthed({
    ...base,
    status: "disabled",
    notes: "paused",
    reason: "subscription paused",
  }), env);
  assert.equal(disabled.status, 200);
  const disabledBody = await json(disabled);
  assert.equal(disabledBody.data.status, "disabled");
  assert.equal(disabledBody.data.notes, "paused");
  assert.equal(db.events.at(-1).event_type, "disable");
  assert.equal(db.events.at(-1).reason, "subscription paused");

  const reenabled = await worker.fetch(syncAuthed({
    ...base,
    status: "active",
    notes: "paid again",
  }), env);
  assert.equal(reenabled.status, 200);
  const reenabledBody = await json(reenabled);
  assert.equal(reenabledBody.data.status, "active");
  assert.equal(reenabledBody.data.notes, "paid again");
  assert.equal(reenabledBody.data.revocation_seq, 2);
  assert.equal(db.events.at(-1).event_type, "reenable");
});
