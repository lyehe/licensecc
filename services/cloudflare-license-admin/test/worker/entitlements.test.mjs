import assert from "node:assert/strict";
import test from "node:test";
import { entitlementCurrentJsonSql } from "@licensecc/cloudflare-runtime/d1/entitlement_json";
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
test("entitlement routes have direct owners and reject anonymous access", async () => {
  assertRouteGroup("entitlements", 9);
  await assertRouteGroupRejectsUnauthenticated("entitlements");
});

test("cloudflare access reader can read but cannot mutate", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const token = await accessToken(fixture, "reader@example.com");
  const read = await worker.fetch(accessAuthed("/api/admin/summary", token), env);
  assert.equal(read.status, 200);

  const mutate = await worker.fetch(accessAuthed("/api/admin/entitlements", token, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(mutate.status, 403);
  assert.equal((await json(mutate)).code, "admin_role_required");
});

test("cloudflare access admin can mutate entitlements", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const token = await accessToken(fixture, "admin@example.com");
  const response = await worker.fetch(accessAuthed("/api/admin/entitlements", token, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.code, "entitlement_saved");
  assert.equal(body.data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].actor, "admin@example.com");
  assert.equal(db.events[0].actor_type, "access");
});


test("admin create is audited and idempotent", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const body = {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    assertion_ttl_seconds: 300,
    cache_ttl_seconds: 3600,
    notes: "first",
  };
  const request = authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "create-1" },
    body: JSON.stringify(body),
  });
  const first = await worker.fetch(request, env);
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  assert.equal(firstBody.data.revocation_seq, 1);
  assert.equal(firstBody.data.cache_ttl_seconds, undefined);
  assert.equal(db.entitlements.get(keyOf("DEFAULT", "DEFAULT", fingerprint)).cache_ttl_seconds, 300);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, "create");
  assert.equal(JSON.parse(db.events[0].next_json).id, firstBody.data.id);
  assert.equal(db.lastBatchSize, 3);
  assert.equal(db.idempotency.size, 1);

  const replay = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "create-1" },
    body: JSON.stringify(body),
  }), env);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get("x-idempotent-replay"), "1");
  assert.equal((await json(replay)).data.revocation_seq, 1);
  assert.equal(db.events.length, 1);
});

test("admin mutation rolls back entitlement write when audit insert fails", async () => {
  const db = new MockD1();
  db.failEvents = true;
  const env = baseEnv(db);
  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "rollback-1" },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "mutation_failed");
  assert.equal(db.lastBatchSize, 3);
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
  assert.equal(db.idempotency.size, 0);
});

test("admin mutation fails closed when D1 batch is unavailable", async () => {
  const db = new MockD1();
  db.batch = undefined;
  const env = baseEnv(db);
  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  assert.equal(response.status, 500);
  assert.equal((await json(response)).code, "mutation_failed");
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.length, 0);
});

test("admin upsert increments the stored revocation sequence", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const key = keyOf("DEFAULT", "DEFAULT", fingerprint);
  db.entitlements.set(key, {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    device_hash: "",
    status: "active",
    assertion_ttl_seconds: 300,
    cache_ttl_seconds: 3600,
    revocation_seq: 7,
    valid_from: null,
    valid_until: null,
    notes: "existing",
    customer_id: null,
    license_id: null,
    created_at: 100,
    updated_at: 100,
  });

  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint, notes: "changed" }),
  }), env);

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data.revocation_seq, 8);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].event_type, "update");
  assert.equal(db.events[0].revocation_seq, 8);
});

test("admin upsert preserves historical revocation floor when row is recreated", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  db.events.push({
    id: 1,
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: fingerprint,
    device_hash: "",
    event_type: "revoke",
    status: "revoked",
    revocation_seq: 10,
    detail: "",
    actor: "previous",
    actor_type: "cli",
    source: "cli",
    request_id: "previous",
    ip: "",
    prev_json: "",
    next_json: "",
    reason: "previous revoke",
    idempotency_key: null,
    created_at: 100,
  });

  const response = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);

  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data.revocation_seq, 11);
  assert.equal(db.events.at(-1).revocation_seq, 11);
});

test("admin patch and transitions increment from stored row state", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const create = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;
  const key = keyOf("DEFAULT", "DEFAULT", fingerprint);
  db.entitlements.get(key).revocation_seq = 11;

  const patched = await worker.fetch(authed(`/api/admin/entitlements/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ notes: "patched" }),
  }), env);
  assert.equal((await json(patched)).data.revocation_seq, 12);

  db.entitlements.get(key).revocation_seq = 21;
  const disabled = await worker.fetch(authed(`/api/admin/entitlements/${id}/disable`, {
    method: "POST",
    body: JSON.stringify({ reason: "stored sequence regression" }),
  }), env);
  assert.equal((await json(disabled)).data.revocation_seq, 22);
});

test("admin create and patch accept explicit empty notes from UI payloads", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const create = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: fingerprint,
      notes: "",
      customer_id: null,
      license_id: null,
    }),
  }), env);
  assert.equal(create.status, 200);
  const created = await json(create);
  assert.equal(created.data.notes, "");
  assert.equal(created.data.customer_id, null);
  assert.equal(created.data.license_id, null);

  const patched = await worker.fetch(authed(`/api/admin/entitlements/${created.data.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      notes: "",
      customer_id: "",
      license_id: "",
    }),
  }), env);
  assert.equal(patched.status, 200);
  const patchedBody = await json(patched);
  assert.equal(patchedBody.data.notes, "");
  assert.equal(patchedBody.data.customer_id, null);
  assert.equal(patchedBody.data.license_id, null);
});

test("admin transitions require reason and revoked is terminal", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const create = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    headers: { "idempotency-key": "create-2" },
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;

  const missingReason = await worker.fetch(authed(`/api/admin/entitlements/${id}/disable`, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal(missingReason.status, 400);
  assert.equal((await json(missingReason)).code, "reason_required");

  const disabled = await worker.fetch(authed(`/api/admin/entitlements/${id}/disable`, {
    method: "POST",
    headers: { "idempotency-key": "disable-1" },
    body: JSON.stringify({ reason: "support request" }),
  }), env);
  assert.equal((await json(disabled)).data.status, "disabled");

  const reenabled = await worker.fetch(authed(`/api/admin/entitlements/${id}/reenable`, {
    method: "POST",
    headers: { "idempotency-key": "reenable-1" },
    body: JSON.stringify({}),
  }), env);
  assert.equal((await json(reenabled)).data.status, "active");

  const revoked = await worker.fetch(authed(`/api/admin/entitlements/${id}/revoke`, {
    method: "POST",
    headers: { "idempotency-key": "revoke-1" },
    body: JSON.stringify({ reason: "chargeback" }),
  }), env);
  const revokedBody = await json(revoked);
  assert.equal(revokedBody.data.status, "revoked");
  assert.equal(revokedBody.data.revocation_seq, 4);

  const terminal = await worker.fetch(authed(`/api/admin/entitlements/${id}/reenable`, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal(terminal.status, 409);
  assert.equal((await json(terminal)).code, "revoked_entitlement_is_terminal");
});

// ATOM-2: pin the audit next_json contract (the only existing assertion checks a single field, .id).
test("audit next_json carries the full production json_object field set", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const res = await worker.fetch(authed("/api/admin/entitlements", {
    method: "POST",
    body: JSON.stringify({
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: fingerprint,
      device_hash: "d".repeat(64),
      assertion_ttl_seconds: 321,
      valid_from: 1000,
      valid_until: 2000,
      notes: "shape probe",
      customer_id: "cus-1",
      license_id: "lic-1",
      status: "active",
    }),
  }), env);
  assert.equal(res.status, 200);
  const saved = (await json(res)).data;
  const next = JSON.parse(db.events[0].next_json);
  assert.deepEqual(Object.keys(next).sort(), [...NEXT_JSON_KEYS].sort());
  // Intentional shape divergence: next_json includes cache_ttl_seconds; the API response (withId) does not.
  assert.ok("cache_ttl_seconds" in next);
  assert.equal(saved.cache_ttl_seconds, undefined);
  assert.equal(next.id, saved.id);
  assert.equal(next.customer_id, "cus-1");
  assert.equal(next.license_id, "lic-1");
  assert.equal(db.events[0].prev_json, ""); // prev was null on create
});

test("canonical D1-safe next_json key set matches the audit contract (drift guard)", () => {
  // Both entitlement mutation and plan projection interpolate this shared
  // expression. Keep the semantic key contract independent of its safe nested
  // json_set representation; a monolithic json_object exceeds D1's arg cap.
  const expression = entitlementCurrentJsonSql("", "?", { includeCacheTtl: true });
  const keys = [
    ...expression.matchAll(/'([a-z_]+)'\s*,/g),
    ...expression.matchAll(/'\$\.([a-z_]+)'\s*,/g),
  ].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [...NEXT_JSON_KEYS].sort());
});

test("audit prev_json is the prior API record on update", async () => {
  const db = new MockD1();
  const env = baseEnv(db);
  const base = { project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint, notes: "v1" };
  const first = await worker.fetch(authed("/api/admin/entitlements", { method: "POST", body: JSON.stringify(base) }), env);
  const firstData = (await json(first)).data;
  const second = await worker.fetch(
    authed("/api/admin/entitlements", { method: "POST", body: JSON.stringify({ ...base, notes: "v2" }) }),
    env,
  );
  assert.equal(second.status, 200);
  const updateEvent = db.events.at(-1);
  assert.equal(updateEvent.event_type, "update");
  const prev = JSON.parse(updateEvent.prev_json);
  assert.equal(prev.id, firstData.id);
  assert.equal(prev.notes, "v1");
  assert.equal(prev.status, firstData.status);
});

// TEST-1: PATCH and the transitions were only exercised via the dev bearer; prove the Access-JWT path too.
test("cloudflare access admin can patch and transition entitlements end to end", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const token = await accessToken(fixture, "admin@example.com");
  const create = await worker.fetch(accessAuthed("/api/admin/entitlements", token, {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;

  const patched = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify({ notes: "access-patched" }),
  }), env);
  assert.equal(patched.status, 200);
  assert.equal((await json(patched)).code, "entitlement_patched");

  const disabled = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/disable`, token, {
    method: "POST",
    body: JSON.stringify({ reason: "support request" }),
  }), env);
  assert.equal((await json(disabled)).data.status, "disabled");

  const reenabled = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/reenable`, token, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal((await json(reenabled)).data.status, "active");

  const revoked = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/revoke`, token, {
    method: "POST",
    body: JSON.stringify({ reason: "chargeback" }),
  }), env);
  assert.equal((await json(revoked)).data.status, "revoked");

  const terminal = await worker.fetch(accessAuthed(`/api/admin/entitlements/${id}/reenable`, token, {
    method: "POST",
    body: JSON.stringify({}),
  }), env);
  assert.equal(terminal.status, 409);
  assert.equal((await json(terminal)).code, "revoked_entitlement_is_terminal");

  // Every audit event must carry the Access identity (actor propagation through eventFromCurrentStatement).
  assert.ok(db.events.length >= 4);
  for (const event of db.events) {
    assert.equal(event.actor_type, "access");
    assert.equal(event.actor, "admin@example.com");
  }
});

test("cloudflare access reader cannot patch or transition", async (t) => {
  const fixture = await accessFixture(t);
  const db = new MockD1();
  const env = accessEnv(db, fixture);
  const create = await worker.fetch(accessAuthed("/api/admin/entitlements", await accessToken(fixture, "admin@example.com"), {
    method: "POST",
    body: JSON.stringify({ project: "DEFAULT", feature: "DEFAULT", license_fingerprint: fingerprint }),
  }), env);
  const id = (await json(create)).data.id;
  const eventsAfterCreate = db.events.length;
  const reader = await accessToken(fixture, "reader@example.com");
  for (const request of [
    accessAuthed(`/api/admin/entitlements/${id}`, reader, { method: "PATCH", body: JSON.stringify({ notes: "x" }) }),
    accessAuthed(`/api/admin/entitlements/${id}/disable`, reader, { method: "POST", body: JSON.stringify({ reason: "x" }) }),
    accessAuthed(`/api/admin/entitlements/${id}/reenable`, reader, { method: "POST", body: JSON.stringify({}) }),
    accessAuthed(`/api/admin/entitlements/${id}/revoke`, reader, { method: "POST", body: JSON.stringify({ reason: "x" }) }),
  ]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "admin_role_required");
  }
  assert.equal(db.events.length, eventsAfterCreate); // denied reader mutations write nothing
});

// TEST-2: JWKS cache reuse + fail-closed unknown-kid (the only review-listed auth path with zero coverage).
