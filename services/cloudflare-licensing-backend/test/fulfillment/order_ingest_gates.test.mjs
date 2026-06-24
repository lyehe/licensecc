// Handler-gate coverage for handleOrderIngest (Slice 1 order-ingest, POST /v1/orders).
// These are the Step-0 branches that resolve BEFORE any entitlement mutation: the
// ORDER_INGEST_MODE gate (off/soft/required), the body-size ceiling, the HMAC
// fail-closed family (config/unknown-key/stale/bad-signature), invalid_order, and the
// replay-nonce spend. They need no real SQLite — a tiny stub DB suffices (and a stub
// whose .batch THROWS proves a rejected request never reaches the mutator). The full
// guarded accept/apply matrix lives in order_ingest_exactly_once.test.mjs (SQL-backed).
//
// Runs in the default `test` glob (no --experimental-sqlite needed).

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleOrderIngest } from "../../src/fulfillment/order_ingest.mjs";

const textEncoder = new TextEncoder();
const KEY_ID = "order-key-1";
const AUDIENCE = "prod";

const SECRET_BYTES = new Uint8Array(32);
for (let i = 0; i < SECRET_BYTES.length; i += 1) {
  SECRET_BYTES[i] = (i * 7 + 3) & 0xff;
}
function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
const SECRET_B64 = bytesToBase64(SECRET_BYTES);

function baseEnv(overrides = {}) {
  return {
    ORDER_HMAC_SECRETS: JSON.stringify({ [KEY_ID]: SECRET_B64 }),
    ORDER_INGEST_AUDIENCE: AUDIENCE,
    ORDER_INGEST_MODE: "required",
    ORDER_MAX_SKEW_SECONDS: "300",
    ...overrides,
  };
}

// A stub DB. Step-0 gates that reject before mutation must never call .batch.
// nonceState controls the (key_id,event_id) replay nonce spend result:
//   "fresh"   -> INSERT ... RETURNING yields a row,
//   "replayed"-> yields null,
//   "error"   -> the prepare/first throws.
function stubDb({ nonceState = "fresh", failBatch = true } = {}) {
  const calls = { batch: 0 };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes("order_ingest_nonces")) {
            if (nonceState === "error") throw new Error("nonce store down");
            return nonceState === "replayed" ? null : { event_id: "x" };
          }
          if (sql.includes("FROM order_events WHERE event_id")) {
            return null; // no prior event (dedup miss)
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
    },
    batch() {
      calls.batch += 1;
      if (failBatch) throw new Error("batch must not be reached for a rejected request");
      return Promise.resolve([]);
    },
  };
  return { db, calls };
}

async function signOrder({ ts, bodyText, audience = AUDIENCE, secretBytes = SECRET_BYTES }) {
  const signedText = "POST\n/v1/orders\n" + audience + "\n" + ts + "\n" + bodyText;
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signedText));
  return bytesToBase64(new Uint8Array(sig));
}

function makeRequest({ keyId = KEY_ID, ts, signature, body, contentLength }) {
  const headers = new Headers();
  if (keyId !== null) headers.set("X-LCC-Key-Id", keyId);
  if (ts !== null) headers.set("X-LCC-Timestamp", ts);
  if (signature !== null) headers.set("X-LCC-Signature", signature);
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return new Request("https://verifier.example/v1/orders", { method: "POST", headers, body });
}

function validBody(overrides = {}) {
  return JSON.stringify({
    event_id: "evt_1",
    subscription_id: "sub_A",
    project: "DEFAULT",
    feature: "DEFAULT",
    intent: "subscription.active",
    seq: 1,
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    ...overrides,
  });
}

async function signedRequest(env, bodyText, { ts = Math.floor(Date.now() / 1000) } = {}) {
  const signature = await signOrder({ ts: String(ts), bodyText });
  return makeRequest({ ts: String(ts), signature, body: bodyText });
}

test("mode=off -> 404 (endpoint does not exist in dev-only off mode)", async () => {
  const { db } = stubDb();
  const env = baseEnv({ ORDER_INGEST_MODE: "off", DB: db });
  const res = await handleOrderIngest(makeRequest({ body: validBody() }), env);
  assert.equal(res.status, 404);
});

test("oversize Content-Length -> 413 before reading the body", async () => {
  const { db } = stubDb();
  const env = baseEnv({ DB: db });
  const res = await handleOrderIngest(makeRequest({ body: "x", contentLength: 16385 }), env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "payload_too_large");
});

test("missing HMAC secrets map -> 503 config_error (fail-closed)", async () => {
  const { db } = stubDb();
  const env = baseEnv({ ORDER_HMAC_SECRETS: undefined, DB: db });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "config_error");
});

test("unknown key_id -> 401 unknown_key_id", async () => {
  const { db } = stubDb();
  const env = baseEnv({ DB: db });
  const bodyText = validBody();
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await signOrder({ ts, bodyText });
  const res = await handleOrderIngest(makeRequest({ keyId: "nope", ts, signature, body: bodyText }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "unknown_key_id");
});

test("stale timestamp -> 401 stale_timestamp", async () => {
  const { db } = stubDb();
  const env = baseEnv({ DB: db });
  const bodyText = validBody();
  const staleTs = String(Math.floor(Date.now() / 1000) - 100000);
  const signature = await signOrder({ ts: staleTs, bodyText });
  const res = await handleOrderIngest(makeRequest({ ts: staleTs, signature, body: bodyText }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "stale_timestamp");
});

test("tampered signature -> 401 bad_signature", async () => {
  const { db } = stubDb();
  const env = baseEnv({ DB: db });
  const bodyText = validBody();
  const ts = String(Math.floor(Date.now() / 1000));
  // Sign a DIFFERENT body, then submit validBody -> signature will not verify.
  const signature = await signOrder({ ts, bodyText: validBody({ seq: 999 }) });
  const res = await handleOrderIngest(makeRequest({ ts, signature, body: bodyText }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "bad_signature");
});

test("valid HMAC but unknown intent -> 400 invalid_order (no mutation)", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  const bodyText = validBody({ intent: "subscription.teleported" });
  const res = await handleOrderIngest(await signedRequest(env, bodyText), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_order");
  assert.equal(calls.batch, 0, "invalid_order never reaches the mutator");
});

test("replayed nonce -> 401 replayed", async () => {
  const { db } = stubDb({ nonceState: "replayed" });
  const env = baseEnv({ DB: db });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "replayed");
});

test("nonce store error -> 503 write_failed (fail-closed)", async () => {
  const { db } = stubDb({ nonceState: "error" });
  const env = baseEnv({ DB: db });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "write_failed");
});

test("soft mode observes (verify+normalize) but NEVER mutates", async () => {
  // failBatch:true ensures any mutation attempt throws; soft must return before it.
  const { db, calls } = stubDb({ nonceState: "fresh", failBatch: true });
  const env = baseEnv({ ORDER_INGEST_MODE: "soft", DB: db });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.code, "observed");
  assert.equal(body.license_fingerprint, null);
  assert.equal(calls.batch, 0, "soft mode never mutates");
});
