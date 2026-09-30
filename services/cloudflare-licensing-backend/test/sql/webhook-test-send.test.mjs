// The operator "Send test event" path the WebhookOperator entrypoint runs, against an in-memory
// SQLite built from the shared migrations with fetch mocked. It must:
//   - load only an ACTIVE endpoint (unknown/disabled -> not_found, nothing sent),
//   - re-check the stored URL is https before sending,
//   - sign with the same key and signer real deliveries use (the real verifier accepts it),
//   - never follow a redirect, give up after 5 s, and report only a status class,
//   - allow one test per endpoint per 60 s (rate_limit_counters, its own namespace).
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadSecretMap } from "@licensecc/cloudflare-runtime/auth/secret_map";
import { signWebhookBody, verifyWebhookSignature } from "@licensecc/cloudflare-runtime/webhooks/webhook";
import { sendWebhookTestEvent, WEBHOOK_TEST_RATE_NAMESPACE } from "../../src/webhooks/test_event.mjs";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

class PreparedStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new PreparedStatement(this.db, this.sql, values.map((value) => (value === undefined ? null : value)));
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async run() {
    this.db.prepare(this.sql).all(...this.params);
    return { success: true };
  }
}

function freshDb(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const name of readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

function addEndpoint(db, id, { url = `https://hooks.test/${id}`, status = "active" } = {}) {
  db.prepare(
    "INSERT INTO webhook_endpoints (id, url, event_types, status, description, created_at, updated_at, scope_kind) VALUES (?,?,'',?,'',1,1,'global')",
  ).run(id, url, status);
}

const OLD_SECRET = Buffer.alloc(32, 3).toString("base64");
const ACTIVE_SECRET = Buffer.alloc(32, 7).toString("base64");
const SIGNING = {
  WEBHOOK_SIGNING_SECRETS: JSON.stringify({ old: OLD_SECRET, k2: ACTIVE_SECRET }),
  WEBHOOK_SIGNING_KEY_ID: "k2",
};

function environment(t, extra = {}) {
  const db = freshDb(t);
  return { db, env: { DB: { prepare: (sql) => new PreparedStatement(db, sql) }, ...SIGNING, ...extra } };
}

function recordingFetch(respond = () => new Response("receiver body", { status: 200 })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, fetch };
}

function counterRows(db) {
  return db.prepare("SELECT namespace, rate_key FROM rate_limit_counters ORDER BY rate_key").all().map((row) => ({ ...row }));
}

test("a test event is signed with the active delivery key and the real verifier accepts it", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "ep1");
  const { calls, fetch } = recordingFetch();

  const result = await sendWebhookTestEvent(env, "ep1", { now: 1000, fetch });

  assert.deepEqual(result, { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "2xx" } });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://hooks.test/ep1");
  assert.equal(init.method, "POST");
  assert.equal(init.body, '{"type":"test","endpoint_id":"ep1","sent_at":1000}');
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["Licensecc-Event-Source"], "test");
  assert.match(init.headers["Licensecc-Webhook-Id"], /^test-[0-9a-f-]{36}$/);

  const header = init.headers["Licensecc-Signature"];
  assert.match(header, /^t=1000,keyid=k2,v1=[0-9a-f]{64}$/);
  // The exact header the real delivery signer produces for these bytes: there is no second signer.
  assert.equal(header, await signWebhookBody(loadSecretMap(SIGNING.WEBHOOK_SIGNING_SECRETS), "k2", init.body, 1000));
  assert.equal(await verifyWebhookSignature(init.body, header, loadSecretMap(JSON.stringify({ k2: ACTIVE_SECRET })), 1000), true);
  assert.equal(await verifyWebhookSignature(init.body, header, loadSecretMap(JSON.stringify({ k2: OLD_SECRET })), 1000), false);
  assert.equal(await verifyWebhookSignature(`${init.body} `, header, loadSecretMap(SIGNING.WEBHOOK_SIGNING_SECRETS), 1000), false);

  // Nothing secret-bearing or receiver-controlled comes back to the caller.
  const serialized = JSON.stringify(result);
  for (const forbidden of [ACTIVE_SECRET, OLD_SECRET, header, "v1=", "receiver body", "k2"]) {
    assert.equal(serialized.includes(forbidden), false, `result leaked ${forbidden}`);
  }
});

test("a stored non-https URL is rejected before anything is signed or sent", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "plain", { url: "http://hooks.test/plain" });
  addEndpoint(db, "odd", { url: "ftp://hooks.test/odd" });
  const { calls, fetch } = recordingFetch();

  assert.deepEqual(await sendWebhookTestEvent(env, "plain", { now: 1000, fetch }), { ok: false, status: 400, code: "invalid_url" });
  assert.deepEqual(await sendWebhookTestEvent(env, "odd", { now: 1000, fetch }), { ok: false, status: 400, code: "invalid_url" });
  assert.equal(calls.length, 0);
  assert.deepEqual(counterRows(db), [], "a rejected URL does not spend the endpoint's test allowance");
});

test("a second test to the same endpoint within 60 seconds is rate limited", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "ep1");
  addEndpoint(db, "ep2");
  const { calls, fetch } = recordingFetch();

  assert.equal((await sendWebhookTestEvent(env, "ep1", { now: 1000, fetch })).ok, true);
  assert.deepEqual(await sendWebhookTestEvent(env, "ep1", { now: 1030, fetch }), { ok: false, status: 429, code: "rate_limited", data: { retry_after: 30 } });
  assert.deepEqual(await sendWebhookTestEvent(env, "ep1", { now: 1059, fetch }), { ok: false, status: 429, code: "rate_limited", data: { retry_after: 1 } });
  assert.equal(calls.length, 1, "a limited call sends nothing");

  // Another endpoint has its own allowance, and the first one's reopens a full 60 s after its send.
  assert.equal((await sendWebhookTestEvent(env, "ep2", { now: 1059, fetch })).ok, true);
  assert.equal((await sendWebhookTestEvent(env, "ep1", { now: 1060, fetch })).ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(counterRows(db), [
    { namespace: WEBHOOK_TEST_RATE_NAMESPACE, rate_key: "ep1" },
    { namespace: WEBHOOK_TEST_RATE_NAMESPACE, rate_key: "ep2" },
  ]);
  assert.equal(WEBHOOK_TEST_RATE_NAMESPACE, "webhook-test");
});

test("a redirect is reported as 3xx and never followed", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "ep1");
  addEndpoint(db, "ep2");
  const { calls, fetch } = recordingFetch((url) => url.endsWith("/ep1")
    ? new Response(null, { status: 302, headers: { location: "https://internal.example/admin" } })
    // A browser-style fetch hides a manual redirect behind an opaque status-0 response.
    : { status: 0, type: "opaqueredirect", body: null });

  assert.deepEqual((await sendWebhookTestEvent(env, "ep1", { now: 1000, fetch })).data, { status_class: "3xx" });
  assert.deepEqual((await sendWebhookTestEvent(env, "ep2", { now: 1000, fetch })).data, { status_class: "3xx" });
  assert.equal(calls.length, 2, "the Location target is never requested");
  for (const call of calls) assert.equal(call.init.redirect, "manual");
});

test("receiver answers map to 2xx/4xx/5xx and their bodies are never read", async (t) => {
  const { db, env } = environment(t);
  const cases = [[204, "2xx"], [404, "4xx"], [410, "4xx"], [500, "5xx"], [503, "5xx"]];
  const cancelled = [];
  for (const [status] of cases) addEndpoint(db, `ep${status}`);
  const { fetch } = recordingFetch((url) => {
    const status = Number(url.slice(url.lastIndexOf("ep") + 2));
    const body = status === 204 ? null : new ReadableStream({ cancel() { cancelled.push(status); } });
    return new Response(body, { status });
  });
  for (const [status, statusClass] of cases) {
    assert.deepEqual(await sendWebhookTestEvent(env, `ep${status}`, { now: 1000, fetch }), { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: statusClass } });
  }
  assert.deepEqual(cancelled, [404, 410, 500, 503]);
});

test("a receiver that does not answer within 5 seconds is a network_error", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "slow");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const fetch = (_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    markStarted();
  });

  let settled = false;
  const pending = sendWebhookTestEvent(env, "slow", { now: 1000, fetch }).finally(() => { settled = true; });
  await started;
  t.mock.timers.tick(4999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "still waiting just before 5 s");
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "network_error" } });
  assert.equal(signal.aborted, true);
});

test("a connection failure is a network_error", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "down");
  const fetch = async () => { throw new TypeError("fetch failed: connect ECONNREFUSED"); };
  const result = await sendWebhookTestEvent(env, "down", { now: 1000, fetch });
  assert.deepEqual(result, { ok: true, status: 200, code: "webhook_test_sent", data: { status_class: "network_error" } });
  assert.equal(JSON.stringify(result).includes("ECONNREFUSED"), false, "no receiver or network detail is returned");
});

test("an unknown, disabled or malformed endpoint id is a safe not_found with nothing sent", async (t) => {
  const { db, env } = environment(t);
  addEndpoint(db, "off", { status: "disabled" });
  const { calls, fetch } = recordingFetch();
  for (const id of ["missing", "off", "", "x".repeat(129), 42, null, undefined, { id: "off" }]) {
    assert.deepEqual(await sendWebhookTestEvent(env, id, { now: 1000, fetch }), { ok: false, status: 404, code: "not_found" }, JSON.stringify(id));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(counterRows(db), []);
});

test("missing signing configuration fails closed without sending or spending the allowance", async (t) => {
  for (const signing of [
    { WEBHOOK_SIGNING_SECRETS: undefined, WEBHOOK_SIGNING_KEY_ID: undefined },
    { WEBHOOK_SIGNING_SECRETS: JSON.stringify({ k2: ACTIVE_SECRET }), WEBHOOK_SIGNING_KEY_ID: "absent" },
  ]) {
    const { db, env } = environment(t, signing);
    addEndpoint(db, "ep1");
    const { calls, fetch } = recordingFetch();
    assert.deepEqual(await sendWebhookTestEvent(env, "ep1", { now: 1000, fetch }), { ok: false, status: 503, code: "webhook_signing_unconfigured" });
    assert.equal(calls.length, 0);
    assert.deepEqual(counterRows(db), []);
  }
});

test("a database failure is temporarily_unavailable and nothing is sent", async () => {
  const { calls, fetch } = recordingFetch();
  const env = { DB: { prepare() { throw new Error("D1_ERROR: database unavailable"); } }, ...SIGNING };
  const result = await sendWebhookTestEvent(env, "ep1", { now: 1000, fetch });
  assert.deepEqual(result, { ok: false, status: 503, code: "temporarily_unavailable" });
  assert.equal(calls.length, 0);
});
