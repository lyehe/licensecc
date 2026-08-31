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
import { normalizeOrderEventForReplay } from "../../src/fulfillment/order_event.mjs";

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
function stubDb({ nonceState = "fresh", failBatch = true, existingEvent = null, seenNonceIds = null } = {}) {
  const calls = { batch: 0, prepare: 0, nonceBinds: [] };
  const db = {
    prepare(sql) {
      calls.prepare += 1;
      let boundValues = [];
      return {
        bind(...values) {
          boundValues = values;
          if (sql.includes("order_ingest_nonces")) calls.nonceBinds.push(values);
          return this;
        },
        async first() {
          if (sql.includes("order_ingest_nonces")) {
            if (nonceState === "error") throw new Error("nonce store down");
            if (seenNonceIds instanceof Set) {
              const nonceId = `${boundValues[0]}:${boundValues[1]}`;
              if (seenNonceIds.has(nonceId)) return null;
              seenNonceIds.add(nonceId);
              return { event_id: nonceId };
            }
            return nonceState === "replayed" ? null : { event_id: "x" };
          }
          if (sql.includes("FROM order_events WHERE event_id")) {
            return existingEvent;
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

async function signOrderBytes({ ts, bodyBytes, audience = AUDIENCE, secretBytes = SECRET_BYTES }) {
  const framing = textEncoder.encode("POST\n/v1/orders\n" + audience + "\n" + ts + "\n");
  const signedBytes = new Uint8Array(framing.byteLength + bodyBytes.byteLength);
  signedBytes.set(framing);
  signedBytes.set(bodyBytes, framing.byteLength);
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, signedBytes);
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

function streamedRequest({ keyId = KEY_ID, ts, signature, chunks, contentLength }) {
  const headers = new Headers();
  if (keyId !== null) headers.set("X-LCC-Key-Id", keyId);
  if (ts !== null) headers.set("X-LCC-Timestamp", ts);
  if (signature !== null) headers.set("X-LCC-Signature", signature);
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));

  let cancelled = false;
  let next = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (next >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[next]);
      next += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    request: new Request("https://verifier.example/v1/orders", { method: "POST", headers, body: stream, duplex: "half" }),
    wasCancelled: () => cancelled,
  };
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

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

async function normalizedOrderDigest(bodyText, now) {
  const order = normalizeOrderEventForReplay(JSON.parse(bodyText), now);
  assert.equal(order.error, undefined);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(stableStringify(order))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rawBodyDigest(bodyText) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(bodyText)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

test("oversize Content-Length -> 413 and cancels the body before reading it", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  const streamed = streamedRequest({
    ts: "0",
    signature: "ignored",
    contentLength: 16385,
    chunks: [new Uint8Array(16385).fill(0x78)],
  });
  const res = await handleOrderIngest(streamed.request, env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "payload_too_large");
  assert.equal(streamed.wasCancelled(), true);
  assert.equal(calls.prepare, 0);
});

test("chunked body is assembled as raw bytes and accepts the canonical signer", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db, ORDER_INGEST_MODE: "soft" });
  const bodyText = validBody();
  const bodyBytes = textEncoder.encode(bodyText);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await signOrderBytes({ ts, bodyBytes });
  const streamed = streamedRequest({
    ts,
    signature,
    chunks: [bodyBytes.slice(0, 7), bodyBytes.slice(7, 31), bodyBytes.slice(31)],
  });

  const res = await handleOrderIngest(streamed.request, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, "observed");
  assert.equal(calls.prepare, 0, "soft mode remains non-mutating after raw-byte authentication");
});

test("a UTF-8 code point split across chunks remains raw-byte authenticated and decodes only after assembly", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db, ORDER_INGEST_MODE: "soft" });
  const bodyBytes = textEncoder.encode(validBody({ customer: { name: "€" } }));
  const euroStart = bodyBytes.indexOf(0xe2);
  assert.ok(euroStart >= 0);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await signOrderBytes({ ts, bodyBytes });
  const streamed = streamedRequest({
    ts,
    signature,
    chunks: [bodyBytes.slice(0, euroStart + 1), bodyBytes.slice(euroStart + 1, euroStart + 2), bodyBytes.slice(euroStart + 2)],
  });
  const response = await handleOrderIngest(streamed.request, env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "observed");
  assert.equal(calls.prepare, 0);
});

test("a raw-body read error cancels the reader before returning invalid_order", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  let cancelled = false;
  const request = {
    headers: new Headers(),
    body: {
      getReader() {
        return {
          async read() {
            throw new Error("stream failed");
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    },
  };
  const response = await handleOrderIngest(request, env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_order");
  assert.equal(cancelled, true);
  assert.equal(calls.prepare, 0);
});

test("actual stream size, not a lying low Content-Length, controls the order body cap and cancellation", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  const overflow = new Uint8Array(16385).fill(0x78);
  const streamed = streamedRequest({
    ts: "0",
    signature: "ignored",
    contentLength: 1,
    chunks: [overflow.slice(0, 8000), overflow.slice(8000)],
  });

  const res = await handleOrderIngest(streamed.request, env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, "payload_too_large");
  assert.equal(streamed.wasCancelled(), true, "overflow cancels the unread request stream");
  assert.equal(calls.prepare, 0, "oversized payload never reaches nonce or persistence work");
});

test("missing Content-Length still cancels an actual raw-byte overflow", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  const overflow = new Uint8Array(16385).fill(0x78);
  const streamed = streamedRequest({
    ts: "0",
    signature: "ignored",
    chunks: [overflow],
  });

  const res = await handleOrderIngest(streamed.request, env);
  assert.equal(res.status, 413);
  assert.equal(streamed.wasCancelled(), true);
  assert.equal(calls.prepare, 0);
});

test("an exact-limit chunked body is accepted even when Content-Length lies low", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db, ORDER_INGEST_MODE: "soft" });
  const unpadded = validBody();
  const bodyText = `${unpadded.slice(0, -1)}${" ".repeat(16384 - textEncoder.encode(unpadded).byteLength)}}`;
  const bodyBytes = textEncoder.encode(bodyText);
  assert.equal(bodyBytes.byteLength, 16384);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await signOrderBytes({ ts, bodyBytes });
  const streamed = streamedRequest({
    ts,
    signature,
    contentLength: 1,
    chunks: [bodyBytes.slice(0, 8192), bodyBytes.slice(8192)],
  });

  const res = await handleOrderIngest(streamed.request, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, "observed");
  assert.equal(streamed.wasCancelled(), false);
  assert.equal(calls.prepare, 0);
});

test("valid HMAC over malformed UTF-8 returns invalid_order without persistence", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  const bodyBytes = new Uint8Array([0x7b, 0xff, 0x7d]); // { <invalid UTF-8> }
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await signOrderBytes({ ts, bodyBytes });
  const res = await handleOrderIngest(makeRequest({ ts, signature, body: bodyBytes }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_order");
  assert.equal(calls.prepare, 0);
});

test("a signature over UTF-8 replacement bytes never authenticates malformed wire bytes", async () => {
  const { db, calls } = stubDb();
  const env = baseEnv({ DB: db });
  const malformedBytes = new Uint8Array([0x7b, 0xff, 0x7d]);
  const replacementBytes = textEncoder.encode(new TextDecoder().decode(malformedBytes));
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await signOrderBytes({ ts, bodyBytes: replacementBytes });
  const res = await handleOrderIngest(makeRequest({ ts, signature, body: malformedBytes }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "bad_signature");
  assert.equal(calls.prepare, 0);
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

test("empty or misspelled quantity cannot consume the order floor", async () => {
  for (const quantity of [{}, { lease_seconds: 60 }, { pool_szie: 5 }]) {
    const { db, calls } = stubDb({ failBatch: true });
    const env = baseEnv({ DB: db });
    const bodyText = validBody({ intent: "quantity.changed", quantity });
    const res = await handleOrderIngest(await signedRequest(env, bodyText), env);
    assert.equal(res.status, 400, JSON.stringify(quantity));
    assert.equal((await res.json()).code, "invalid_order", JSON.stringify(quantity));
    assert.equal(calls.prepare, 0, "invalid quantity is rejected before nonce or order state");
    assert.equal(calls.batch, 0);
  }
});

test("replayed nonce -> 401 replayed", async () => {
  const { db, calls } = stubDb({ nonceState: "replayed" });
  const env = baseEnv({ DB: db });
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await handleOrderIngest(await signedRequest(env, validBody(), { ts: timestamp }), env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "replayed");
  assert.equal(calls.nonceBinds.length, 1);
  assert.match(calls.nonceBinds[0][1], new RegExp(`^${timestamp}:[0-9a-f]{64}$`, "u"));
  assert.equal(calls.nonceBinds[0][2], timestamp, "the persisted timestamp is the authenticated signed timestamp");
});

test("an exact signed replay is denied while a freshly signed logical retry reaches the durable cache", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyText = validBody();
  const digest = await normalizedOrderDigest(bodyText, timestamp);
  const attemptDigest = await rawBodyDigest(bodyText);
  const seenNonceIds = new Set([`${KEY_ID}:${timestamp}:${attemptDigest}`]);
  const { db, calls } = stubDb({
    seenNonceIds,
    existingEvent: {
      status: "processed",
      payload_digest: digest,
      result_json: JSON.stringify({ ok: true, code: "applied" }),
    },
  });
  const env = baseEnv({ DB: db });

  const exactReplay = await handleOrderIngest(await signedRequest(env, bodyText, { ts: timestamp }), env);
  assert.equal(exactReplay.status, 401);
  assert.equal((await exactReplay.json()).code, "replayed");

  const freshRetry = await handleOrderIngest(await signedRequest(env, bodyText, { ts: timestamp + 1 }), env);
  assert.equal(freshRetry.status, 200);
  assert.equal((await freshRetry.json()).code, "applied");
  assert.equal(seenNonceIds.size, 2);
  assert.equal(calls.batch, 0, "the fresh retry was served from the durable processed-event cache");
});

test("independently signed JSON serializations at the same timestamp are distinct attempts", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const parsed = JSON.parse(validBody());
  const compactBody = JSON.stringify(parsed);
  const prettyBody = JSON.stringify(parsed, null, 2);
  const digest = await normalizedOrderDigest(compactBody, timestamp);
  const seenNonceIds = new Set();
  const { db, calls } = stubDb({
    seenNonceIds,
    existingEvent: {
      status: "processed",
      payload_digest: digest,
      result_json: JSON.stringify({ ok: true, code: "applied" }),
    },
  });
  const env = baseEnv({ DB: db });

  const compact = await handleOrderIngest(await signedRequest(env, compactBody, { ts: timestamp }), env);
  const pretty = await handleOrderIngest(await signedRequest(env, prettyBody, { ts: timestamp }), env);

  assert.equal(compact.status, 200);
  assert.equal(pretty.status, 200);
  assert.equal((await compact.json()).code, "applied");
  assert.equal((await pretty.json()).code, "applied");
  assert.equal(seenNonceIds.size, 2, "the replay key hashes exact signed body bytes, not normalized JSON");
  assert.equal(calls.batch, 0, "both distinct attempts were served from the durable event cache");
});

test("a historical event can reach a matching durable cache but cannot enter as a new event", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyText = validBody({ current_period_end: timestamp - 2 * 86_400 });
  const digest = await normalizedOrderDigest(bodyText, timestamp);
  const cached = stubDb({
    seenNonceIds: new Set(),
    existingEvent: {
      status: "processed",
      payload_digest: digest,
      result_json: JSON.stringify({ ok: true, code: "applied" }),
    },
  });
  const cachedResponse = await handleOrderIngest(
    await signedRequest(baseEnv(), bodyText, { ts: timestamp }),
    baseEnv({ DB: cached.db }),
  );
  assert.equal(cachedResponse.status, 200);
  assert.equal((await cachedResponse.json()).code, "applied");

  const unseen = stubDb({ seenNonceIds: new Set() });
  const unseenResponse = await handleOrderIngest(
    await signedRequest(baseEnv(), bodyText, { ts: timestamp + 1 }),
    baseEnv({ DB: unseen.db }),
  );
  assert.equal(unseenResponse.status, 400);
  assert.equal((await unseenResponse.json()).code, "invalid_order");
  assert.equal(unseen.calls.batch, 0);
});

test("a malformed terminal cache fails closed instead of throwing or returning an invalid body", async () => {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyText = validBody();
  const digest = await normalizedOrderDigest(bodyText, timestamp);
  for (const resultJson of ["{", "null", JSON.stringify({ code: "applied" })]) {
    const { db } = stubDb({
      seenNonceIds: new Set(),
      existingEvent: { status: "processed", payload_digest: digest, result_json: resultJson },
    });
    const response = await handleOrderIngest(
      await signedRequest(baseEnv(), bodyText, { ts: timestamp }),
      baseEnv({ DB: db }),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "write_failed");
  }
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

test("soft mode rejects a historical new event exactly as required mode would", async () => {
  const { db, calls } = stubDb({ failBatch: true });
  const env = baseEnv({ ORDER_INGEST_MODE: "soft", DB: db });
  const historical = validBody({ current_period_end: Math.floor(Date.now() / 1000) - 2 * 86_400 });
  const res = await handleOrderIngest(await signedRequest(env, historical), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_order");
  assert.equal(calls.prepare, 0, "soft mode evaluates new-event policy without reading or mutating durable state");
  assert.equal(calls.batch, 0);
});

// --- R2.1 signer-scope authz -------------------------------------------------

test("signer scope required + out-of-project -> 403 signer_scope_forbidden (no mutation)", async () => {
  const { db, calls } = stubDb({ failBatch: true });
  const env = baseEnv({
    DB: db,
    ORDER_SIGNER_SCOPE_MODE: "required",
    ORDER_SIGNER_SCOPES: JSON.stringify({ [KEY_ID]: { project: "OTHER" } }),
  });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "signer_scope_forbidden");
  assert.equal(calls.batch, 0, "an out-of-scope signer never reaches the mutator");
});

test("unknown signer-scope modes fail closed before HMAC or DB work", async () => {
  for (const mode of ["typo", "REQUIRED", " required"]) {
    const { db, calls } = stubDb();
    const env = baseEnv({ DB: db, ORDER_SIGNER_SCOPE_MODE: mode });
    const res = await handleOrderIngest(makeRequest({ body: validBody() }), env);
    assert.equal(res.status, 503, `ORDER_SIGNER_SCOPE_MODE=${JSON.stringify(mode)}`);
    assert.equal((await res.json()).code, "config_error");
    assert.equal(calls.prepare, 0, "invalid configuration precedes nonce/persistence work");
  }
});

test("signer scope required + no scope entry for the key -> 403 (fail-closed)", async () => {
  const { db } = stubDb();
  const env = baseEnv({
    DB: db,
    ORDER_SIGNER_SCOPE_MODE: "required",
    ORDER_SIGNER_SCOPES: JSON.stringify({ "some-other-key": { project: "DEFAULT" } }),
  });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "signer_scope_forbidden");
});

test("prototype-named signer keys require their own explicit scope entry", async () => {
  for (const keyId of ["__proto__", "constructor", "toString"]) {
    const { db } = stubDb();
    const env = baseEnv({
      DB: db,
      ORDER_HMAC_SECRETS: JSON.stringify({ [keyId]: SECRET_B64 }),
      ORDER_SIGNER_SCOPE_MODE: "required",
      ORDER_SIGNER_SCOPES: JSON.stringify({ "some-other-key": { project: "DEFAULT" } }),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const bodyText = validBody();
    const signature = await signOrder({ ts, bodyText });
    const res = await handleOrderIngest(makeRequest({ keyId, ts, signature, body: bodyText }), env);
    assert.equal(res.status, 403, keyId);
    assert.equal((await res.json()).code, "signer_scope_forbidden", keyId);
  }
});

test("an own __proto__ signer scope is data and still enforces its constraints", async () => {
  const keyId = "__proto__";
  const { db, calls } = stubDb({ failBatch: true });
  const env = baseEnv({
    DB: db,
    ORDER_HMAC_SECRETS: JSON.stringify({ [keyId]: SECRET_B64 }),
    ORDER_SIGNER_SCOPE_MODE: "required",
    ORDER_SIGNER_SCOPES: JSON.stringify({ [keyId]: { project: "OTHER", customer_id: "cus_other" } }),
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyText = validBody({ customer: { id: "cus_default" } });
  const signature = await signOrder({ ts, bodyText });
  const res = await handleOrderIngest(makeRequest({ keyId, ts, signature, body: bodyText }), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "signer_scope_forbidden");
  assert.equal(calls.batch, 0);
});

test("signer scope required but no scope map -> 503 config_error", async () => {
  const { db } = stubDb();
  const env = baseEnv({ DB: db, ORDER_SIGNER_SCOPE_MODE: "required" });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "config_error");
});

test("empty or misspelled signer constraints fail configuration closed", async () => {
  for (const scope of [{}, { projet: "DEFAULT" }, { project: "DEFAULT", typo: "x" }]) {
    const { db, calls } = stubDb();
    const env = baseEnv({
      DB: db,
      ORDER_SIGNER_SCOPE_MODE: "required",
      ORDER_SIGNER_SCOPES: JSON.stringify({ [KEY_ID]: scope }),
    });
    const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
    assert.equal(res.status, 503, JSON.stringify(scope));
    assert.equal((await res.json()).code, "config_error", JSON.stringify(scope));
    assert.equal(calls.prepare, 0, "bad scope config is rejected before persistence");
  }
});

test("signer scope required + in-scope project -> passes the scope gate", async () => {
  const { db } = stubDb({ failBatch: false });
  const env = baseEnv({
    DB: db,
    ORDER_SIGNER_SCOPE_MODE: "required",
    ORDER_SIGNER_SCOPES: JSON.stringify({ [KEY_ID]: { project: "DEFAULT" } }),
  });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.notEqual(res.status, 403);
  assert.notEqual((await res.json()).code, "signer_scope_forbidden");
});

test("signer scope soft + out-of-project -> observes, does NOT block", async () => {
  const { db, calls } = stubDb({ failBatch: true });
  const env = baseEnv({
    DB: db,
    ORDER_INGEST_MODE: "soft",
    ORDER_SIGNER_SCOPE_MODE: "soft",
    ORDER_SIGNER_SCOPES: JSON.stringify({ [KEY_ID]: { project: "OTHER" } }),
  });
  const res = await handleOrderIngest(await signedRequest(env, validBody()), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, "observed");
  assert.equal(calls.batch, 0);
});
