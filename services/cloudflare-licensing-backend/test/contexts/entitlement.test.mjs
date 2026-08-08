import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../dist/index.js";
import { testKeyEnv, validBody } from "./fixtures.mjs";

test("unknown entitlement returns unsigned denial by default", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    await testKeyEnv(null),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "entitlement_denied");
  assert.equal(body.assertion, undefined);
});

test("inactive entitlement states return unsigned denial by default", async () => {
  for (const status of ["disabled", "revoked"]) {
    const row = {
      ...validBody(),
      status,
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 4,
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
    assert.equal(body.ok, false);
    assert.equal(body.code, "entitlement_denied");
    assert.equal(body.assertion, undefined);
    assert.equal(typeof body.server_time, "number");
  }
});

test("device mismatch returns unsigned denial by default", async () => {
  const row = {
    ...validBody(),
    device_hash: "c".repeat(64),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 5,
  };
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ device_hash: "d".repeat(64) })),
    }),
    await testKeyEnv(row),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "entitlement_denied");
  assert.equal(body.assertion, undefined);
});

test("validity windows are enforced and clamp assertion lifetime", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const activeRow = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 9,
      valid_from: 900,
      valid_until: 1050,
    };
    const active = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv(activeRow),
    );
    assert.equal(active.status, 200);
    const activeBody = await active.json();
    assert.equal(activeBody.ok, true);
    const activePayload = Buffer.from(activeBody.assertion.split(".")[1], "base64").toString("utf8");
    assert.match(activePayload, /expires-at=1050\n/);
    assert.match(activePayload, /cache-until=1050\n/);

    const expired = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv({ ...activeRow, valid_until: 1000 }),
    );
    assert.equal(expired.status, 200);
    assert.deepEqual(await expired.json(), { ok: false, code: "entitlement_denied", server_time: 1000 });

    const notYetValid = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv({ ...activeRow, valid_from: 1001, valid_until: 1100 }),
    );
    assert.equal(notYetValid.status, 200);
    assert.deepEqual(await notYetValid.json(), { ok: false, code: "entitlement_denied", server_time: 1000 });
  } finally {
    Date.now = originalNow;
  }
});

test("malformed and oversized requests are rejected", async () => {
  const env = await testKeyEnv(null);
  const malformed = await worker.fetch(
    new Request("https://example.test/v1/verify", { method: "POST", body: "{" }),
    env,
  );
  assert.equal(malformed.status, 400);

  const oversized = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-length": "4097" },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(oversized.status, 413);
});

test("D1 and signing failures return controlled errors", async () => {
  const d1FailureEnv = await testKeyEnv(null, {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("simulated D1 outage");
              },
            };
          },
        };
      },
    },
  });
  const d1Failure = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    d1FailureEnv,
  );
  assert.equal(d1Failure.status, 500);
  assert.deepEqual(await d1Failure.json(), { ok: false, code: "verification_error" });

  const signingFailureRow = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const signingFailureEnv = await testKeyEnv(signingFailureRow, {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "not a private key",
  });
  const signingFailure = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    signingFailureEnv,
  );
  assert.equal(signingFailure.status, 500);
  assert.deepEqual(await signingFailure.json(), { ok: false, code: "verification_error" });
});
