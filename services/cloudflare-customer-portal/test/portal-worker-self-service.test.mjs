import { test } from "node:test";
import { assert, FP_B, cookieFor, call, baseFixture, seedCustomer, seedEntitlement, NOW } from "./portal-worker-fixtures.mjs";

test("A's /api/portal/entitlements returns ONLY A's entitlements", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
    const r = await call(env, "GET", "/api/portal/entitlements", { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.items.length, 1);
    assert.equal(r.body.data.items[0].project, "DEFAULT");
    assert.equal(r.body.data.items[0].license_mode, "node_locked");
    // Every grant is protected, so a row names no mode.
    assert.equal(Object.hasOwn(r.body.data.items[0], "enforcement_mode"), false);
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

// =================================================================================================
// /api/portal/me EMAIL RESOLUTION — one read, precedence: customers.email, then
// portal_passwords.email_lower, then the EARLIEST portal_identities.email, else null. Additive: the
// route still reports customer_id exactly as before; email is a new sibling field.
// =================================================================================================

test("/api/portal/me resolves email from customers.email when it is non-empty", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.customer_id, "A", "customer_id is unchanged (additive response)");
  assert.equal(r.body.data.email, "a@x.com", "customers.email wins when it is non-empty");
  db.close();
});

test("/api/portal/me falls back to portal_passwords.email_lower when customers.email is empty (admin-created user)", async () => {
  const { db, env } = baseFixture();
  seedCustomer(db, "PW", "");
  db.prepare(
    "INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)",
  ).run("PW", "admin-created@x.com", NOW, NOW);
  const cookie = await cookieFor(env, "PW");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.email, "admin-created@x.com", "portal_passwords.email_lower is used when customers.email is empty");
  db.close();
});

test("/api/portal/me falls back to the sole portal_identities.email when there is no customers.email or password", async () => {
  const { db, env } = baseFixture();
  seedCustomer(db, "ID", "");
  db.prepare(
    "INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES ('google', 'sub-1', ?, ?, ?)",
  ).run("ID", "identity-only@x.com", NOW);
  const cookie = await cookieFor(env, "ID");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.email, "identity-only@x.com", "the sole portal_identities.email is used as a last resort");
  db.close();
});

test("/api/portal/me picks the EARLIEST portal_identities row by created_at when a customer has two identities", async () => {
  const { db, env } = baseFixture();
  seedCustomer(db, "ID2", "");
  // Insert the LATER identity first so a correct implementation must be driven by created_at, never
  // by insertion/rowid order.
  db.prepare(
    "INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES ('github', 'sub-later', ?, ?, ?)",
  ).run("ID2", "later@x.com", NOW + 100);
  db.prepare(
    "INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES ('google', 'sub-earlier', ?, ?, ?)",
  ).run("ID2", "earlier@x.com", NOW);
  const cookie = await cookieFor(env, "ID2");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.email, "earlier@x.com", "the earliest created_at identity wins, not insertion order");
  db.close();
});

test("/api/portal/me returns email: null when customers.email, portal_passwords, and portal_identities all give nothing", async () => {
  const { db, env } = baseFixture();
  seedCustomer(db, "NONE", "");
  const cookie = await cookieFor(env, "NONE");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.customer_id, "NONE");
  assert.equal(r.body.data.email, null, "no source resolves an email");
  assert.ok(Object.hasOwn(r.body.data, "email"), "the email key is present (additive), even when its value is null");
  db.close();
});

// The four tests above each seed exactly ONE source per customer, so they cannot distinguish the
// correct precedence from a COALESCE with scrambled argument order (any single-source fallback still
// "wins" trivially). These two seed ALL applicable sources on ONE customer, each with a DISTINCT
// address, so picking the wrong source is directly visible in the asserted email.

test("/api/portal/me: when customers.email, a password, and an identity all exist on one customer, customers.email wins over BOTH", async () => {
  const { db, env } = baseFixture();
  seedCustomer(db, "COEXIST1", "primary@x.com");
  db.prepare(
    "INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)",
  ).run("COEXIST1", "password-loses-1@x.com", NOW, NOW);
  db.prepare(
    "INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES ('google', 'sub-coexist1', ?, ?, ?)",
  ).run("COEXIST1", "identity-loses-1@x.com", NOW);
  const cookie = await cookieFor(env, "COEXIST1");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.email, "primary@x.com", "customers.email wins even when a password and an identity also exist on the same customer");
  db.close();
});

test("/api/portal/me: when customers.email is empty but a password AND an identity both exist, the password wins over the identity", async () => {
  const { db, env } = baseFixture();
  seedCustomer(db, "COEXIST2", "");
  db.prepare(
    "INSERT INTO portal_passwords (customer_id, email_lower, password_hash, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?)",
  ).run("COEXIST2", "password-wins-2@x.com", NOW, NOW);
  db.prepare(
    "INSERT INTO portal_identities (provider, subject, customer_id, email, created_at) VALUES ('google', 'sub-coexist2', ?, ?, ?)",
  ).run("COEXIST2", "identity-loses-2@x.com", NOW);
  const cookie = await cookieFor(env, "COEXIST2");
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.email, "password-wins-2@x.com", "portal_passwords wins over portal_identities when customers.email is empty and both exist");
  db.close();
});

export const DIRECT_ROUTE_TESTS = Object.freeze([
  "GET /api/portal/me",
  "GET /api/portal/entitlements",
]);


test("portal entitlement projection lists each owned protected grant without exposing another owner", async () => {
  const { db, env } = baseFixture();
  try {
    db.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,enforcement_mode,status,max_active_devices,created_at,updated_at) VALUES ('PROTECTED','DEFAULT',?,'A','device_bound_v1','active',1,?,?)").run("c".repeat(64), NOW, NOW);
    const result = await call(env, "GET", "/api/portal/entitlements", { cookie: await cookieFor(env, "A") });
    assert.equal(result.status, 200);
    const listed = result.body.data.items.find(row => row.project === "PROTECTED");
    assert.ok(listed); assert.equal(Object.hasOwn(listed, "enforcement_mode"), false);
    assert.ok(!JSON.stringify(result.body).includes(FP_B));
  } finally { db.close(); }
});

// =================================================================================================
// TRIAL END — each row says when its trial ends by the protected-device trial rule. A trial never
// outlives its license (valid_until wins), a clock not yet started has no end (null), and
// trial_starts_on_activation says whether the first activation starts one.
// =================================================================================================

const TRIAL_KEY = `sha256:${"e".repeat(64)}`;
const DAY = 86400;

// A protected trial grant owned by A, inserted with its trial columns and, once started, the trial key.
function seedProtectedTrial(db, feature, fingerprint, { basis, duration, started = null, validUntil = null }) {
  db.prepare(
    "INSERT INTO entitlements (project, feature, license_fingerprint, customer_id, enforcement_mode, status, max_active_devices, " +
      "valid_until, is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, " +
      "trial_started_at, trial_device_hash, created_at, updated_at) " +
      "VALUES ('DEFAULT', ?, ?, 'A', 'device_bound_v1', 'active', 1, ?, 1, ?, ?, 1, ?, ?, ?, ?)",
  ).run(feature, fingerprint, validUntil, basis, duration, started, started === null ? null : TRIAL_KEY, NOW, NOW);
}

test("each row's trial end follows the protected trial rule and never outlives the license", async () => {
  const { db, env } = baseFixture();
  try {
    seedProtectedTrial(db, "PSTARTED", "9".repeat(64), { basis: "from_first_activation", duration: 7 * DAY, started: NOW - DAY });
    seedProtectedTrial(db, "PENDED", "2".repeat(64), { basis: "from_first_activation", duration: 7 * DAY, started: NOW - 30 * DAY });
    seedProtectedTrial(db, "PPENDING", "0".repeat(64), { basis: "from_first_activation", duration: 7 * DAY });
    seedProtectedTrial(db, "PCLAMPED", "d".repeat(64), { basis: "from_first_use", duration: 30 * DAY, started: NOW - DAY, validUntil: NOW + 7 * DAY });
    seedProtectedTrial(db, "PSHORT", "c".repeat(64), { basis: "from_first_activation", duration: 1 });
    seedProtectedTrial(db, "PISSUED", "f".repeat(64), { basis: "from_issue", duration: 7 * DAY, validUntil: NOW + 7 * DAY });
    seedProtectedTrial(db, "POPEN", "7".repeat(64), { basis: "from_issue", duration: 0 });
    seedEntitlement(db, { feature: "PAID", fingerprint: "5".repeat(64), customerId: "A", validUntil: NOW + 30 * DAY });
    const r = await call(env, "GET", "/api/portal/entitlements", { cookie: await cookieFor(env, "A") });
    assert.equal(r.status, 200);
    const trialOf = (feature, endsAt, startsOnActivation, why) => {
      const row = r.body.data.items.find((item) => item.feature === feature);
      assert.equal(row.trial_ends_at, endsAt, `${feature}: ${why}`);
      assert.equal(row.trial_starts_on_activation, startsOnActivation, `${feature}: ${why}`);
    };
    trialOf("PSTARTED", NOW + 6 * DAY, false, "a started protected trial ends its duration after it started");
    trialOf("PENDED", NOW - 23 * DAY, false, "an ended protected clock still reports when it ended");
    trialOf("PPENDING", null, true, "a protected trial the first activation starts has no end yet");
    trialOf("PCLAMPED", NOW + 7 * DAY, false, "a trial never outlives its license: valid_until wins, so the Mode label and the Valid column agree");
    trialOf("PSHORT", null, false, "the protected rule refuses a duration under 2 seconds, so no activation will start this clock");
    trialOf("PISSUED", NOW + 7 * DAY, false, "a protected from_issue trial ends with the license");
    trialOf("POPEN", null, false, "a from_issue trial with no end date has no end and no activation clock");
    trialOf("PAID", null, false, "a license that is not a trial has no trial end");
    trialOf("DEFAULT", null, false, "the node-locked license is not a trial either");
    for (const row of r.body.data.items) {
      assert.equal(row.license_mode, row.feature === "PAID" || row.feature === "DEFAULT" ? "node_locked" : "trial", `${row.feature} license mode`);
    }
    // Only the derived values reach the browser, never the columns they are computed from.
    for (const row of r.body.data.items) {
      for (const column of ["trial_started_at", "trial_duration_sec", "trial_expiration_basis", "trial_device_hash"]) {
        assert.ok(!Object.hasOwn(row, column), `${row.feature} must not expose ${column}`);
      }
    }
  } finally { db.close(); }
});

// The Worker-wide catch-all (app.ts's default export): any unhandled exception, from any route,
// becomes a 500 "portal_error" envelope that never leaks the exception's own text to the browser.
// This is the only test exercising that path, on a kept session route.
test("an unhandled DB exception on a kept route becomes a 500 portal_error envelope with no exception text", async () => {
  const { db, env } = baseFixture();
  const cookie = await cookieFor(env, "A");
  const failure = "boom-db-unavailable-9f3c";
  env.DB.prepare = () => {
    throw new Error(failure);
  };
  const r = await call(env, "GET", "/api/portal/me", { cookie });
  assert.equal(r.status, 500);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "portal_error");
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes(failure), "the response body must not leak the exception message");
  assert.ok(!raw.includes("Error"), "the response body must not leak the exception name/stack");
  db.close();
});
