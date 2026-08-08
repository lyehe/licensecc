import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import worker from "../../dist/index.js";
import {
  canonicalPayloadForTests,
  resetSigningKeyCacheForTests,
  signingKeyImportCountForTests,
} from "../../dist/routes/verify.js";
import { testKeyEnv, validBody } from "./fixtures.mjs";

test("canonical online assertion payload is byte exact", () => {
  const payload = canonicalPayloadForTests({
    purpose: "licensecc-online-assertion",
    version: "1",
    alg: "rsa-pkcs1-sha256",
    keyId: "sha256:test-key",
    project: "DEFAULT",
    feature: "EXPORT",
    licenseFingerprint: "a".repeat(64),
    deviceHash: "b".repeat(64),
    nonce: "c".repeat(64),
    status: "ok",
    issuedAt: 1000,
    expiresAt: 1300,
    cacheUntil: 1600,
    revocationSeq: 42,
  });
  assert.equal(
    payload,
    [
      "purpose=licensecc-online-assertion",
      "version=1",
      "alg=rsa-pkcs1-sha256",
      "key-id=sha256:test-key",
      "project=DEFAULT",
      "feature=EXPORT",
      `license-fingerprint=${"a".repeat(64)}`,
      `device-hash=${"b".repeat(64)}`,
      `nonce=${"c".repeat(64)}`,
      "status=ok",
      "issued-at=1000",
      "expires-at=1300",
      "cache-until=1600",
      "revocation-seq=42",
      "",
    ].join("\n"),
  );
});

test("canonical online assertion payload matches shared golden fixture", () => {
  const fixtureDir = join(process.cwd(), "../../test/vectors/online_assertion");
  const keyId = readFileSync(join(fixtureDir, "golden.key_id"), "utf8").trim();
  const fixturePayload = readFileSync(join(fixtureDir, "golden.payload"), "utf8");
  const fixtureAssertion = readFileSync(join(fixtureDir, "golden.assertion"), "utf8").trim();
  const payload = canonicalPayloadForTests({
    purpose: "licensecc-online-assertion",
    version: "1",
    alg: "rsa-pkcs1-sha256",
    keyId,
    project: "DEFAULT",
    feature: "EXPORT",
    licenseFingerprint: "a".repeat(64),
    deviceHash: "b".repeat(64),
    nonce: "c".repeat(64),
    status: "ok",
    issuedAt: 1000,
    expiresAt: 1300,
    cacheUntil: 1600,
    revocationSeq: 42,
  });
  assert.equal(payload, fixturePayload);
  assert.equal(Buffer.from(fixtureAssertion.split(".")[1], "base64").toString("utf8"), fixturePayload);
});

test("signing key import is cached for a stable key", async () => {
  resetSigningKeyCacheForTests();
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const env = await testKeyEnv(row);
  for (let i = 0; i < 2; ++i) {
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody({ nonce: `${i}${"b".repeat(63)}` })),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  assert.equal(signingKeyImportCountForTests(), 1);
});

test("valid entitlement returns signed assertion with nonce", async () => {
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    await testKeyEnv(row),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.assertion, /^lccoa1\./);
  const payload = Buffer.from(body.assertion.split(".")[1], "base64").toString("utf8");
  assert.match(payload, /status=ok\n/);
  assert.match(payload, new RegExp(`nonce=${"b".repeat(64)}\\n`));
});

test("cache-until grace window exceeds expires-at when cache ttl is larger", async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000_000;
  try {
    const row = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 7,
    };
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv(row),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    const payload = Buffer.from(body.assertion.split(".")[1], "base64").toString("utf8");
    const issuedAt = Number(payload.match(/issued-at=(\d+)\n/)[1]);
    const expiresAt = Number(payload.match(/expires-at=(\d+)\n/)[1]);
    const cacheUntil = Number(payload.match(/cache-until=(\d+)\n/)[1]);
    assert.equal(expiresAt, issuedAt + 120);
    assert.equal(cacheUntil, issuedAt + 600);
    assert.ok(cacheUntil > expiresAt, "cache-until must exceed expires-at when cache ttl is larger");
    // C++ client rejects cache_until - issued_at > 86400; stay within the bound.
    assert.ok(cacheUntil - issuedAt <= 86400);
  } finally {
    Date.now = originalNow;
  }
});
