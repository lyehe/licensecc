// Unit tests for the PURE order-ingest HMAC verifier (Slice 1).
// Generates REAL HMAC-SHA256 signatures in-test via crypto.subtle so a "valid"
// case actually verifies, and every fail branch is fail-closed with the right code.
//
// Source under test: src/fulfillment/order_hmac.mjs -> verifyOrderHmac.

import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyOrderHmac } from "../../src/fulfillment/order_hmac.mjs";

const textEncoder = new TextEncoder();

const KEY_ID = "order-key-1";
const AUDIENCE = "prod";
// A 32-byte secret (the minimum the loader accepts), base64-encoded for the env map.
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

function secretsJson(map = { [KEY_ID]: SECRET_B64 }) {
  return JSON.stringify(map);
}

function makeEnv(overrides = {}) {
  return {
    ORDER_HMAC_SECRETS: secretsJson(),
    ORDER_INGEST_AUDIENCE: AUDIENCE,
    ORDER_MAX_SKEW_SECONDS: "300",
    ...overrides,
  };
}

// Sign the canonical bytes EXACTLY as the verifier does:
//   "POST\n/v1/orders\n" + audience + "\n" + ts + "\n" + bodyText
async function signOrder({ secretBytes = SECRET_BYTES, audience = AUDIENCE, ts, bodyText }) {
  const signedText = "POST\n/v1/orders\n" + audience + "\n" + ts + "\n" + bodyText;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(signedText));
  return bytesToBase64(new Uint8Array(sig));
}

// OMIT is a distinct sentinel so a header can be explicitly left off; passing
// `undefined` would otherwise trigger the keyId default parameter and silently
// re-add the header. null also means "omit".
const OMIT = Symbol("omit");

function makeRequest({ keyId = KEY_ID, ts, signature }) {
  const headers = new Headers();
  if (keyId !== OMIT && keyId !== undefined && keyId !== null) headers.set("X-LCC-Key-Id", keyId);
  if (ts !== OMIT && ts !== undefined && ts !== null) headers.set("X-LCC-Timestamp", ts);
  if (signature !== OMIT && signature !== undefined && signature !== null) headers.set("X-LCC-Signature", signature);
  return new Request("https://verifier.example/v1/orders", { method: "POST", headers });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Build a fully-valid (request, env, bodyText) triple.
async function validTriple(overrides = {}) {
  const bodyText = overrides.bodyText ?? JSON.stringify({ event_id: "e", seq: 1 });
  const ts = overrides.ts ?? String(nowSeconds());
  const audience = overrides.audience ?? AUDIENCE;
  const signature = overrides.signature ?? (await signOrder({ ts, bodyText, audience }));
  const request = makeRequest({ keyId: overrides.keyId ?? KEY_ID, ts, signature });
  const env = makeEnv(overrides.env);
  return { request, env, bodyText };
}

// --- happy path --------------------------------------------------------------

test("verifyOrderHmac accepts a valid signature", async () => {
  const { request, env, bodyText } = await validTriple();
  const out = await verifyOrderHmac(request, env, bodyText);
  assert.equal(out.ok, true);
  assert.equal(out.code, "ok");
  assert.equal(out.keyId, KEY_ID);
});

test("verifyOrderHmac is raw-bytes exact (signs over the exact body bytes)", async () => {
  // Two bodies that JSON.parse to the same object but are different bytes must NOT
  // be interchangeable: a signature over body A must fail for body B.
  const bodyA = '{"event_id":"e","seq":1}';
  const bodyB = '{"seq":1,"event_id":"e"}'; // same object, different bytes
  const ts = String(nowSeconds());
  const sigA = await signOrder({ ts, bodyText: bodyA });
  const request = makeRequest({ ts, signature: sigA });
  const env = makeEnv();

  const okA = await verifyOrderHmac(request, env, bodyA);
  assert.equal(okA.ok, true, "signature verifies over the exact signed bytes");

  const badB = await verifyOrderHmac(request, env, bodyB);
  assert.equal(badB.ok, false, "same-JSON different-bytes body is NOT accepted");
  assert.equal(badB.code, "bad_signature");
});

// --- tamper / wrong key ------------------------------------------------------

test("verifyOrderHmac rejects a tampered body", async () => {
  const { request, env } = await validTriple({ bodyText: JSON.stringify({ event_id: "e", seq: 1 }) });
  const out = await verifyOrderHmac(request, env, JSON.stringify({ event_id: "e", seq: 999 }));
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_signature");
});

test("verifyOrderHmac rejects a signature made with the wrong secret", async () => {
  const wrongSecret = new Uint8Array(32).fill(0xab);
  const ts = String(nowSeconds());
  const bodyText = JSON.stringify({ event_id: "e", seq: 1 });
  const signature = await signOrder({ secretBytes: wrongSecret, ts, bodyText });
  const request = makeRequest({ ts, signature });
  const out = await verifyOrderHmac(request, makeEnv(), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_signature");
});

test("verifyOrderHmac rejects an unknown key_id", async () => {
  const ts = String(nowSeconds());
  const bodyText = JSON.stringify({ event_id: "e", seq: 1 });
  const signature = await signOrder({ ts, bodyText });
  const request = makeRequest({ keyId: "no-such-key", ts, signature });
  const out = await verifyOrderHmac(request, makeEnv(), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "unknown_key_id");
  assert.equal(out.keyId, null);
});

test("verifyOrderHmac rejects a missing key_id header", async () => {
  const ts = String(nowSeconds());
  const bodyText = "{}";
  const signature = await signOrder({ ts, bodyText });
  const request = makeRequest({ keyId: OMIT, ts, signature });
  const out = await verifyOrderHmac(request, makeEnv(), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "unknown_key_id");
});

// --- timestamp / skew --------------------------------------------------------

test("verifyOrderHmac rejects an expired (out-of-skew) timestamp", async () => {
  const ts = String(nowSeconds() - 10_000); // far outside the 300s window
  const bodyText = JSON.stringify({ event_id: "e", seq: 1 });
  const signature = await signOrder({ ts, bodyText });
  const request = makeRequest({ ts, signature });
  const out = await verifyOrderHmac(request, makeEnv(), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "stale_timestamp");
});

test("verifyOrderHmac rejects a future timestamp beyond skew (symmetric)", async () => {
  const ts = String(nowSeconds() + 10_000);
  const bodyText = "{}";
  const signature = await signOrder({ ts, bodyText });
  const request = makeRequest({ ts, signature });
  const out = await verifyOrderHmac(request, makeEnv(), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "stale_timestamp");
});

test("verifyOrderHmac rejects non-canonical timestamp spellings", async () => {
  for (const bad of ["123.0", " 123", "123 ", "+123", "0x7b", "01", "", "abc"]) {
    const bodyText = "{}";
    // Sign over the bad string itself so only the canonicalization gate can reject it.
    const signature = await signOrder({ ts: bad, bodyText });
    const request = makeRequest({ ts: bad, signature });
    const out = await verifyOrderHmac(request, makeEnv(), bodyText);
    assert.equal(out.ok, false, `ts "${bad}" must be rejected`);
    assert.equal(out.code, "stale_timestamp", `ts "${bad}" -> stale_timestamp`);
  }
});

test("verifyOrderHmac respects the ORDER_MAX_SKEW_SECONDS cap (3600)", async () => {
  // A configured skew above the cap is clamped to 3600; 5000s out must still fail.
  const ts = String(nowSeconds() - 5000);
  const bodyText = "{}";
  const signature = await signOrder({ ts, bodyText });
  const request = makeRequest({ ts, signature });
  const out = await verifyOrderHmac(request, makeEnv({ ORDER_MAX_SKEW_SECONDS: "999999" }), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "stale_timestamp");
});

// --- audience ----------------------------------------------------------------

test("verifyOrderHmac rejects an audience mismatch (cross-env replay)", async () => {
  // Signed for 'staging' but the verifier env expects 'prod' -> signature won't match.
  const ts = String(nowSeconds());
  const bodyText = JSON.stringify({ event_id: "e", seq: 1 });
  const signature = await signOrder({ ts, bodyText, audience: "staging" });
  const request = makeRequest({ ts, signature });
  const out = await verifyOrderHmac(request, makeEnv({ ORDER_INGEST_AUDIENCE: "prod" }), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_signature");
});

test("verifyOrderHmac fails closed when audience is unconfigured", async () => {
  const { request, bodyText } = await validTriple();
  const out = await verifyOrderHmac(request, makeEnv({ ORDER_INGEST_AUDIENCE: "" }), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "config_error");
});

// --- key map fail-closed -----------------------------------------------------

test("verifyOrderHmac fails closed on an empty key map", async () => {
  const { request, bodyText } = await validTriple();
  const out = await verifyOrderHmac(request, makeEnv({ ORDER_HMAC_SECRETS: "{}" }), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "config_error");
});

test("verifyOrderHmac fails closed on a missing / non-JSON key map", async () => {
  const { request, bodyText } = await validTriple();
  const missing = await verifyOrderHmac(request, makeEnv({ ORDER_HMAC_SECRETS: undefined }), bodyText);
  assert.equal(missing.code, "config_error");
  const garbage = await verifyOrderHmac(request, makeEnv({ ORDER_HMAC_SECRETS: "not json" }), bodyText);
  assert.equal(garbage.code, "config_error");
  const arr = await verifyOrderHmac(request, makeEnv({ ORDER_HMAC_SECRETS: "[]" }), bodyText);
  assert.equal(arr.code, "config_error");
});

test("verifyOrderHmac fails closed on an empty-string secret", async () => {
  const { request, bodyText } = await validTriple();
  const out = await verifyOrderHmac(request, makeEnv({ ORDER_HMAC_SECRETS: secretsJson({ [KEY_ID]: "" }) }), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "config_error");
});

test("verifyOrderHmac fails closed on a <32-byte secret", async () => {
  const shortB64 = bytesToBase64(new Uint8Array(16).fill(1)); // 16 bytes < 32
  const { request, bodyText } = await validTriple();
  const out = await verifyOrderHmac(request, makeEnv({ ORDER_HMAC_SECRETS: secretsJson({ [KEY_ID]: shortB64 }) }), bodyText);
  assert.equal(out.ok, false);
  assert.equal(out.code, "config_error");
});

// --- prototype-pollution shaped key ids -------------------------------------

test("verifyOrderHmac: __proto__/constructor key_id is not a forgery", async () => {
  // The attacker presents key_id "__proto__" with no matching secret entry. The
  // null-prototype map + hasOwnProperty lookup must treat it as unknown, never as a
  // function/object pulled off Object.prototype.
  for (const evil of ["__proto__", "constructor", "hasOwnProperty", "prototype"]) {
    const ts = String(nowSeconds());
    const bodyText = "{}";
    const signature = await signOrder({ ts, bodyText });
    const request = makeRequest({ keyId: evil, ts, signature });
    const out = await verifyOrderHmac(request, makeEnv(), bodyText);
    assert.equal(out.ok, false, `key_id "${evil}" must not authenticate`);
    assert.equal(out.code, "unknown_key_id", `key_id "${evil}" -> unknown_key_id`);
  }
});

test("verifyOrderHmac: a __proto__ entry IN the map is usable as ordinary data", async () => {
  // If the operator legitimately names a key "__proto__", it must work as a normal
  // key (null-prototype map keeps it a data property) and NOT pollute anything.
  const ts = String(nowSeconds());
  const bodyText = "{}";
  const signature = await signOrder({ ts, bodyText });
  const request = makeRequest({ keyId: "__proto__", ts, signature });
  // A `{ __proto__: ... }` object LITERAL sets the prototype, not an own key, so it
  // would JSON.stringify to "{}". Build the JSON text directly so the map carries a
  // genuine own property named "__proto__" (what a malicious/edge-case operator
  // secret would actually look like on the wire).
  const env = makeEnv({ ORDER_HMAC_SECRETS: `{"__proto__":${JSON.stringify(SECRET_B64)}}` });
  const out = await verifyOrderHmac(request, env, bodyText);
  assert.equal(out.ok, true, "a real __proto__ key entry verifies as ordinary data");
  assert.equal(out.keyId, "__proto__");
});

// --- missing / malformed signature ------------------------------------------

test("verifyOrderHmac rejects a missing signature header", async () => {
  const ts = String(nowSeconds());
  const request = makeRequest({ ts, signature: OMIT });
  const out = await verifyOrderHmac(request, makeEnv(), "{}");
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_signature");
});

test("verifyOrderHmac rejects a malformed (non-base64 / wrong-length) signature", async () => {
  const ts = String(nowSeconds());
  // Valid base64 but the wrong byte length for an HMAC-SHA256 (32-byte) tag.
  const request = makeRequest({ ts, signature: btoa("short") });
  const out = await verifyOrderHmac(request, makeEnv(), "{}");
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_signature");
});
