// Unit tests for the lease signer (scripts/lease-sign.mjs).
//
// The headline tests assert byte-for-byte parity between the JS canonical payload
// builder and the checked-in C++ golden vectors (test/vectors/v201/*.payload.hex,
// produced by the C++ build) -- so a drift between the JS signer and the C++
// verifier's canonical format is caught here, not in production. The full
// sign-in-JS / verify-in-C++ round trip lives in the cross-language e2e suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { generateKeyPairSync, createHash, subtle } from "node:crypto";

import {
  buildV201CanonicalPayload,
  signV201Lease,
  utcDateFromEpoch,
  CANONICAL_ORDER,
} from "../scripts/lease-sign.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function fixtureHex(name) {
  return readFileSync(resolve(repoRoot, "test/vectors/v201", name), "utf8").replace(/\s+/g, "");
}

const GOLDEN_KEY_ID = "sha256:9d1797cf21f0341f364b7af016a745580fd36b78b17cd1630d1049879fe9ecf2";

const minimalFields = {
  "lic_ver": "201",
  "canonical-v": "1",
  "sig-v": "1",
  "sig-alg": "rsa-pkcs1-sha256",
  "key-id": GOLDEN_KEY_ID,
  "project": "MY_PRODUCT",
  "feature": "MY_PRODUCT",
};

const fullFields = {
  ...minimalFields,
  "valid-from": "2024-01-02",
  "valid-to": "2035-12-31",
  "start-version": "1.2.3",
  "end-version": "9.9.9",
  "client-signature": "AEBC-Q0RF-Rkc=",
  "client-signature-source-strength": "strong-disk-serial-or-uuid",
  "extra-data": "alpha",
};

test("canonical payload matches the C++ minimal golden vector (cross-language parity)", () => {
  const { hex } = buildV201CanonicalPayload(minimalFields);
  assert.equal(hex, fixtureHex("minimal.payload.hex"));
});

test("canonical payload matches the C++ full golden vector (cross-language parity)", () => {
  const { hex } = buildV201CanonicalPayload(fullFields);
  assert.equal(hex, fixtureHex("full.payload.hex"));
});

test("field order is canonical regardless of input key order", () => {
  const shuffled = {};
  for (const key of [...CANONICAL_ORDER].reverse()) {
    if (fullFields[key] !== undefined) shuffled[key] = fullFields[key];
  }
  assert.equal(buildV201CanonicalPayload(shuffled).hex, fixtureHex("full.payload.hex"));
});

test("rejects malformed / missing / inconsistent fields", () => {
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "lic_ver": "200" }), /lic_ver must be 201/);
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "key-id": "sha256:nothex" }), /key-id/);
  assert.throws(() => { const f = { ...minimalFields }; delete f.project; buildV201CanonicalPayload(f); }, /missing required/);
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "valid-from": "2030-01-01", "valid-to": "2020-01-01" }), /valid-from must not be after/);
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "valid-to": "2030-13-01" }), /calendar date/);
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "client-signature": "AEBC-Q0RF-Rkc=" }), /present together/);
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "extra-data": "badbyte" }), /non-printable/);
  assert.throws(() => buildV201CanonicalPayload({ ...minimalFields, "unknown-field": "x" }), /unknown canonical field/);
});

test("utcDateFromEpoch projects an instant to a UTC calendar date", () => {
  assert.equal(utcDateFromEpoch(0), "1970-01-01");
  assert.equal(utcDateFromEpoch(1_704_153_600), "2024-01-02"); // 2024-01-02T00:00:00Z
  assert.equal(utcDateFromEpoch(1_704_153_600 + 86_399), "2024-01-02"); // same UTC day
  assert.throws(() => utcDateFromEpoch(-1), /non-negative/);
});

test("signV201Lease produces a self-consistent, verifiable v201 license", async () => {
  const { publicKey: pkcs1Der, privateKey: pkcs8Pem } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const keyId = "sha256:" + createHash("sha256").update(pkcs1Der).digest("hex");

  const result = await signV201Lease({
    project: "DEFAULT",
    feature: "DEFAULT",
    keyId,
    privateKeyPem: pkcs8Pem,
    validFrom: "2026-06-20",
    validTo: "2026-07-20",
    clientSignature: "AEBC-Q0RF-Rkc=",
    clientSignatureSourceStrength: "strong-disk-serial-or-uuid",
  });

  // License structure
  assert.match(result.license, /^\[DEFAULT\]\n/);
  assert.match(result.license, /\nlic_ver = 201\n/);
  assert.match(result.license, new RegExp(`\\nkey-id = ${keyId}\\n`));
  assert.match(result.license, /\nvalid-from = 2026-06-20\n/);
  assert.match(result.license, /\nvalid-to = 2026-07-20\n/);
  assert.match(result.license, /\nsig = [A-Za-z0-9+/=]+\n/);
  // project/feature are implicit, never written as INI storage lines
  assert.doesNotMatch(result.license, /\nproject = /);
  assert.doesNotMatch(result.license, /\nfeature = /);

  // The detached signature verifies against the public key over the canonical payload.
  const { bytes } = buildV201CanonicalPayload({
    "lic_ver": "201", "canonical-v": "1", "sig-v": "1", "sig-alg": "rsa-pkcs1-sha256",
    "key-id": keyId, "project": "DEFAULT", "feature": "DEFAULT",
    "valid-from": "2026-06-20", "valid-to": "2026-07-20",
    "client-signature": "AEBC-Q0RF-Rkc=", "client-signature-source-strength": "strong-disk-serial-or-uuid",
  });
  assert.equal(result.payloadHex, Buffer.from(bytes).toString("hex"));

  // Import the PKCS#1 public DER as SPKI for verify by wrapping; use node's KeyObject instead.
  const { createPublicKey, verify } = await import("node:crypto");
  const pubKey = createPublicKey({ key: Buffer.from(pkcs1Der), format: "der", type: "pkcs1" });
  const ok = verify("RSA-SHA256", Buffer.from(bytes), pubKey, Buffer.from(result.signatureB64, "base64"));
  assert.equal(ok, true, "signature verifies over the canonical payload");
});

test("signV201Lease requires valid-from and valid-to (mandatory lease bounds)", async () => {
  const { privateKey: pkcs8Pem } = generateKeyPairSync("rsa", {
    modulusLength: 3072, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "der" },
  });
  await assert.rejects(
    signV201Lease({ project: "DEFAULT", feature: "DEFAULT", keyId: GOLDEN_KEY_ID, privateKeyPem: pkcs8Pem, validTo: "2026-07-20" }),
    /validFrom is mandatory/,
  );
});
