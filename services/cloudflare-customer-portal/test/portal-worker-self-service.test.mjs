import { test } from "node:test";
import { assert, worker, mintSession, codeFromSecretBytes, requestOtp, redeemOtp, policyCapacityViolation, FP_A, FP_B, installBackendStub, cookieFor, sameSiteHeaders, entitlementId, ownedEntitlementId, call, baseFixture, seedDevice, seedEntitlement, CTX, NOW } from "./portal-worker-fixtures.mjs";
test("portal worker rejects oversized JSON bodies without relying on Content-Length", async () => {
  const { db, env } = baseFixture();
  const res = await worker.fetch(new Request("https://portal.test/portal/v1/auth/request", {
    method: "POST",
    headers: sameSiteHeaders(),
    body: "x".repeat(8193),
  }), env, CTX);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "body_too_large");
  db.close();
});

test("A's /api/portal/entitlements returns ONLY A's entitlements", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
    const r = await call(env, "GET", "/api/portal/entitlements", { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.items.length, 1);
    assert.equal(r.body.data.items[0].project, "DEFAULT");
    assert.equal(r.body.data.items[0].license_mode, "floating");
    assert.equal(r.body.data.items[0].pool_size, 5);
    assert.equal(typeof r.body.data.items[0].id, "string");
  // The response carries no fingerprint/foreign id.
  assert.ok(!JSON.stringify(r.body).includes(FP_B), "B's data never appears in A's response");
  db.close();
});

test("/api/portal/me reports the SESSION customer, never a client value", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.body.data.customer_id, "A");
  db.close();
});

test("devices + usage are gated by the ownership EXISTS (A sees no B rows)", async () => {
  const { db, env } = baseFixture();
  // Seed a device + usage event on B's entitlement.
  db.prepare(
    "INSERT INTO entitlement_devices (project, feature, license_fingerprint, device_key_id, public_key_spki_der_base64, status, created_at, updated_at) VALUES ('DEFAULT','DEFAULT',?, 'dk_b','x','active',?,?)",
  ).run(FP_B, NOW, NOW);
  db.prepare(
    "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, ts) VALUES ('DEFAULT','DEFAULT',?, 'checkout', ?)",
  ).run(FP_B, NOW);
  const cookie = await cookieFor(env, "A");
  const devices = await call(env, "GET", "/api/portal/devices", { cookie });
  assert.equal(devices.body.data.items.length, 0, "A sees none of B's devices");
  const usage = await call(env, "GET", "/api/portal/usage", { cookie });
  assert.equal(usage.body.data.items.length, 0, "A sees none of B's usage");
  db.close();
});

test("A releases A's own device -> 200 device_released; it disappears from GET /devices and is audited", async () => {
  const { db, env } = baseFixture();
  seedDevice(db, { fingerprint: FP_A, deviceKeyId: "dk_a" });
  const cookie = await cookieFor(env, "A");
  // Present before the release.
  const before = await call(env, "GET", "/api/portal/devices", { cookie });
  assert.equal(before.body.data.items.length, 1, "A's own device is listed before release");
  const seqBefore = db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP_A).revocation_seq;

  const rel = await call(env, "POST", "/api/portal/devices/release", { cookie, body: { device_key_id: "dk_a" } });
  assert.equal(rel.status, 200);
  assert.equal(rel.body.code, "device_released");

  // Gone from the customer-facing listing.
  const after = await call(env, "GET", "/api/portal/devices", { cookie });
  assert.equal(after.body.data.items.length, 0, "the released device no longer appears");

  // The device row is flipped (not deleted) and the entitlement revocation_seq is bumped so the
  // released device is refused by the online-verify path on its next proof-carrying check.
  const dev = db.prepare("SELECT status FROM entitlement_devices WHERE device_key_id = 'dk_a'").get();
  assert.equal(dev.status, "revoked", "the device is flipped away from active, not deleted");
  const seqAfter = db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP_A).revocation_seq;
  assert.ok(seqAfter > seqBefore, "releasing bumps the entitlement revocation_seq");

  // An audit event records the release with the SESSION customer id (no client value).
  const audit = db.prepare("SELECT actor, source, reason, detail FROM entitlement_events WHERE reason = 'portal_device_release'").get();
  assert.ok(audit, "an audit event row exists for the portal device release");
  assert.equal(audit.actor, "A", "the audit records the session customer id");
  assert.equal(audit.source, "portal");
  assert.match(audit.detail, /dk_a/, "the audit detail names the released device");
  db.close();
});

test("A -> B: releasing another customer's device is a generic not_found (no existence oracle)", async () => {
  const { db, env } = baseFixture();
  seedDevice(db, { fingerprint: FP_B, deviceKeyId: "dk_b" });
  const cookie = await cookieFor(env, "A");
  const rel = await call(env, "POST", "/api/portal/devices/release", { cookie, body: { device_key_id: "dk_b" } });
  assert.equal(rel.status, 404, "a foreign device is the SAME generic not_found as an absent one (no 403 oracle)");
  assert.equal(rel.body.code, "not_found");
  // B's device is untouched (no cross-account write).
  const dev = db.prepare("SELECT status FROM entitlement_devices WHERE device_key_id = 'dk_b'").get();
  assert.equal(dev.status, "active", "a foreign device is never mutated");
  db.close();
});

test("releasing the same device twice -> the second call is 409 device_status_conflict", async () => {
  const { db, env } = baseFixture();
  seedDevice(db, { fingerprint: FP_A, deviceKeyId: "dk_a" });
  const cookie = await cookieFor(env, "A");
  const first = await call(env, "POST", "/api/portal/devices/release", { cookie, body: { device_key_id: "dk_a" } });
  assert.equal(first.status, 200);
  assert.equal(first.body.code, "device_released");
  const second = await call(env, "POST", "/api/portal/devices/release", { cookie, body: { device_key_id: "dk_a" } });
  assert.equal(second.status, 409, "an already-released device cannot be released again (guarded transition)");
  assert.equal(second.body.code, "device_status_conflict");
  db.close();
});

test("the release audit records the FRESHLY-BUMPED revocation_seq, not the stale pre-read value", async () => {
  const { db, env } = baseFixture();
  seedDevice(db, { fingerprint: FP_A, deviceKeyId: "dk_a" });
  const cookie = await cookieFor(env, "A");
  const rel = await call(env, "POST", "/api/portal/devices/release", { cookie, body: { device_key_id: "dk_a" } });
  assert.equal(rel.status, 200);
  const seqAfter = db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP_A).revocation_seq;
  const audit = db.prepare("SELECT revocation_seq FROM entitlement_events WHERE reason = 'portal_device_release'").get();
  assert.equal(audit.revocation_seq, seqAfter, "the audit event carries the bumped revocation_seq the release produced");
  db.close();
});

test("lost race between the ownership pre-read and the guarded write -> 409 with NO audit row and NO seq bump", async () => {
  const { db, env } = baseFixture();
  seedDevice(db, { fingerprint: FP_A, deviceKeyId: "dk_a" });
  const cookie = await cookieFor(env, "A");
  const seqBefore = db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP_A).revocation_seq;

  // Simulate a concurrent release landing AFTER apiDeviceRelease's ownership pre-read saw the device
  // active but BEFORE its guarded batch runs: wrap batch() to flip the device out of 'active' first,
  // so the guarded bump/flip both match 0 rows (RETURNING empty -> the 409 branch).
  const realBatch = env.DB.batch.bind(env.DB);
  let raced = false;
  env.DB.batch = async (statements) => {
    if (!raced) {
      raced = true;
      db.prepare("UPDATE entitlement_devices SET status = 'revoked' WHERE device_key_id = 'dk_a'").run();
    }
    return realBatch(statements);
  };

  const rel = await call(env, "POST", "/api/portal/devices/release", { cookie, body: { device_key_id: "dk_a" } });
  assert.equal(rel.status, 409, "a lost race yields the guarded-transition conflict");
  assert.equal(rel.body.code, "device_status_conflict");

  // The guarded write matched 0 rows, so the release recorded NOTHING: the audit is gated on the
  // bump succeeding, and the revocation_seq is untouched. A phantom audit row here would misattribute
  // a slot change that never happened.
  const auditCount = db.prepare("SELECT COUNT(*) AS n FROM entitlement_events WHERE reason = 'portal_device_release'").get();
  assert.equal(auditCount.n, 0, "a lost-race 409 emits no audit row");
  const seqAfter = db.prepare("SELECT revocation_seq FROM entitlements WHERE license_fingerprint = ?").get(FP_A).revocation_seq;
  assert.equal(seqAfter, seqBefore, "a lost-race 409 does not bump the revocation_seq");
  db.close();
});

// =================================================================================================
// ACTIONS — server-resolve the tuple; forged body ignored; no oracle
// =================================================================================================

test("A's checkout on A's tuple proxies the SERVER-RESOLVED fingerprint with a real bearer", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    const r = await call(env, "POST", "/api/portal/checkout", { cookie, body: { entitlement_id: id, client_instance_id: "i1", nonce: "e".repeat(64) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.code, "ok");
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/v1\/checkout$/);
    assert.match(stub.calls[0].auth, /^Bearer lcca_/, "a real ephemeral account token is presented");
    assert.equal(stub.calls[0].body.license_fingerprint, FP_A, "the server-resolved fingerprint is proxied");
    // The minted token row is real, scope-pinned, and 120s-lived.
    const tok = db.prepare("SELECT scopes_json, expires_at, customer_id FROM account_tokens WHERE customer_id = 'A' ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(tok.customer_id, "A");
    const scopes = JSON.parse(tok.scopes_json);
    assert.deepEqual(scopes.projects, ["DEFAULT"]);
    assert.deepEqual(scopes.features, ["DEFAULT"]);
    // R2.5 least privilege: the token is scoped to EXACTLY the one operation being proxied, not all
    // five action ops (deepEqual, not includes -- the un-narrowed mint would carry all five here).
    assert.deepEqual(scopes.operations, ["checkout"]);
    assert.ok(scopes.allow_all === undefined, "never allow_all");
    assert.ok(!scopes.projects.includes("*") && !scopes.features.includes("*"), "scope axes are never *");
    // ~120s TTL; +5 slop absorbs a Date.now() second-boundary between NOW capture and the worker call.
    assert.ok(tok.expires_at > NOW && tok.expires_at <= NOW + 125, "~120s TTL");
    db.close();
  } finally {
    stub.restore();
  }
});

test("A -> B: a checkout referencing B's tuple is a GENERIC not_found (no oracle, no proxy, no mint)", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    // A references B's project/feature pair — but B's entitlement is not owned by A. The server
    // resolves WHERE customer_id='A' AND project/feature -> 0 rows -> generic not_found.
    // (Here both use DEFAULT/DEFAULT, so the discriminator is the OWNER; we instead seed a B-only
    //  feature to make the cross-owner reference explicit.)
    seedEntitlement(db, { feature: "BONLY", fingerprint: "c".repeat(64), customerId: "B" });
    const r = await call(env, "POST", "/api/portal/checkout", { cookie, body: { entitlement_id: entitlementId("DEFAULT", "BONLY", "c".repeat(64)), client_instance_id: "i1", nonce: "e".repeat(64) } });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "not_found", "the SAME generic not_found as an absent tuple (no existence oracle)");
    assert.equal(stub.calls.length, 0, "no proxy for a foreign tuple");
    // No account token minted for A against a foreign feature.
    const minted = db.prepare("SELECT COUNT(*) AS c FROM account_tokens WHERE customer_id = 'A'").get();
    assert.equal(minted.c, 0, "no token minted for a denied action");
    db.close();
  } finally {
    stub.restore();
  }
});

test("a forged body customer_id is IGNORED; the mint binds the SESSION customer only (invariant 2)", async () => {
  const { db, env } = baseFixture();
  const stub = installBackendStub();
  try {
    const cookie = await cookieFor(env, "A");
    const id = await ownedEntitlementId(env, cookie);
    // Forge customer_id=B AND license_fingerprint=B's in the body. Both must be ignored: the handler
    // server-resolves A's own fingerprint and the mint takes the session (customer A) ONLY.
    const r = await call(env, "POST", "/api/portal/checkout", {
      cookie,
      body: { entitlement_id: id, customer_id: "B", license_fingerprint: FP_B, client_instance_id: "i1", nonce: "e".repeat(64) },
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls[0].body.license_fingerprint, FP_A, "the forged B fingerprint is ignored; A's is used");
    // The minted token is for A, never B.
    const forB = db.prepare("SELECT COUNT(*) AS c FROM account_tokens WHERE customer_id = 'B'").get();
    assert.equal(forB.c, 0, "no token ever minted for the forged customer_id");
    const forA = db.prepare("SELECT customer_id FROM account_tokens ORDER BY created_at DESC LIMIT 1").get();
    assert.equal(forA.customer_id, "A");
    db.close();
  } finally {
    stub.restore();
  }
});

// HARD invariant-2 test: the mint chokepoint signature accepts the SESSION ONLY — no request/body arg.
test("HARD: mintSessionToken's call site passes ONLY the session (no body/request field)", async () => {
  const { mintSessionToken } = await import("../src/auth/portal_token.mjs");
  // The function takes (env, session, options). options has NO customer/tuple field. We prove the
  // SOURCE of the worker's call passes the resolved session object, not a request-derived value, by
  // inspecting the function's parameter shape + that a forged session.customer_id is the ONLY lever.
  const src = (await import("node:fs")).readFileSync(new URL("../src/worker/routes/self-service.ts", import.meta.url), "utf8");
  // Every mintSessionToken call in the worker passes `session` as the 2nd arg (never a body object).
  const calls = [...src.matchAll(/mintSessionToken\(\s*env\s*,\s*([A-Za-z0-9_]+)\s*,/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, "the worker mints in at least the action + download paths");
  for (const arg of calls) {
    assert.equal(arg, "session", "mintSessionToken's 2nd arg is ALWAYS the verified session object");
  }
  // And the function itself never reads a request/body — its only identity input is session.customer_id.
  const tokenSrc = (await import("node:fs")).readFileSync(new URL("../src/auth/portal_token.mjs", import.meta.url), "utf8");
  assert.ok(/session\?\.customer_id/.test(tokenSrc), "the mint reads customer_id from the session ONLY");
  assert.ok(!/options\.(customer|customer_id|license_fingerprint|tuple)/.test(tokenSrc), "the mint never reads a client tuple/customer field");
  void mintSessionToken;
});
