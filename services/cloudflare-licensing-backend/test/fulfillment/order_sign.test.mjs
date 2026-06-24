// Round-trip: the offline order signer (scripts/order-sign.mjs) and the in-Worker
// verifier (src/fulfillment/order_hmac.mjs) MUST agree on the canonical bytes. They
// share canonicalOrderSignedText, so this proves the framing/HMAC compose end to end
// and guards against signer<->verifier drift (the classic webhook-auth bug).

import assert from "node:assert/strict";
import { test } from "node:test";
import { signOrder } from "../../scripts/order-sign.mjs";
import { verifyOrderHmac } from "../../src/fulfillment/order_hmac.mjs";

const AUDIENCE = "prod";
const KEY_ID = "k1";

function freshSecretB64() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

function requestFrom(headers, body) {
  return new Request("https://verifier.example/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function envFor(secretB64) {
  return {
    ORDER_HMAC_SECRETS: JSON.stringify({ [KEY_ID]: secretB64 }),
    ORDER_INGEST_AUDIENCE: AUDIENCE,
  };
}

test("a freshly signed order verifies", async () => {
  const secretB64 = freshSecretB64();
  const body = JSON.stringify({ event_id: "e1", subscription_id: "sub_A", seq: 1, intent: "subscription.active" });
  const signed = await signOrder({ keyId: KEY_ID, secretB64, audience: AUDIENCE, body, timestamp: Math.floor(Date.now() / 1000) });
  const res = await verifyOrderHmac(requestFrom(signed.headers, body), envFor(secretB64), body);
  assert.equal(res.ok, true);
  assert.equal(res.code, "ok");
  assert.equal(res.keyId, KEY_ID);
});

test("a tampered body fails the signature", async () => {
  const secretB64 = freshSecretB64();
  const body = JSON.stringify({ event_id: "e1", subscription_id: "sub_A", seq: 1, intent: "subscription.active" });
  const signed = await signOrder({ keyId: KEY_ID, secretB64, audience: AUDIENCE, body, timestamp: Math.floor(Date.now() / 1000) });
  const tampered = body.replace("sub_A", "sub_B");
  const res = await verifyOrderHmac(requestFrom(signed.headers, tampered), envFor(secretB64), tampered);
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_signature");
});

test("a signature for a different audience does not verify against prod", async () => {
  const secretB64 = freshSecretB64();
  const body = JSON.stringify({ event_id: "e1" });
  const signed = await signOrder({ keyId: KEY_ID, secretB64, audience: "staging", body, timestamp: Math.floor(Date.now() / 1000) });
  const res = await verifyOrderHmac(requestFrom(signed.headers, body), envFor(secretB64), body);
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_signature");
});

test("signOrder rejects a too-short secret", async () => {
  await assert.rejects(
    () => signOrder({ keyId: KEY_ID, secretB64: Buffer.from("short").toString("base64"), audience: AUDIENCE, body: "{}" }),
    />= 32 bytes/,
  );
});
