import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../dist/index.js";
import { testKeyEnv, validBody } from "./fixtures.mjs";

test("rate limited request returns 429 before D1 lookup", async () => {
  let dbPrepareCount = 0;
  const env = await testKeyEnv(null, {
    VERIFY_RATE_LIMITER: {
      async limit(input) {
        assert.equal(input.key, "client:203.0.113.10");
        return { success: false };
      },
    },
    DB: {
      prepare() {
        ++dbPrepareCount;
        throw new Error("D1 should not be used for rate-limited requests");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: "rate_limited" });
  assert.equal(dbPrepareCount, 0);
});

test("D1 client rate limiter returns 429 before entitlement lookup", async () => {
  let entitlementLookupCount = 0;
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    D1_RATE_LIMIT_LIMIT: "20",
    D1_RATE_LIMIT_PERIOD_SECONDS: "60",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind(namespace, key, windowStart, expiresAt, updatedAt) {
              assert.equal(namespace, "verify-v1-client");
              assert.equal(key, "client:203.0.113.10");
              assert.equal(Number.isInteger(windowStart), true);
              assert.equal(Number.isInteger(expiresAt), true);
              assert.equal(Number.isInteger(updatedAt), true);
              return {
                async first() {
                  return { request_count: 21 };
                },
              };
            },
          };
        }
        ++entitlementLookupCount;
        throw new Error("entitlement lookup should not be used for D1-rate-limited requests");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: "rate_limited" });
  assert.equal(entitlementLookupCount, 0);
});

test("D1 entitlement rate limiter returns 429 after client tier passes", async () => {
  let entitlementLookupCount = 0;
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    D1_RATE_LIMIT_LIMIT: "20",
    D1_RATE_LIMIT_PERIOD_SECONDS: "60",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind(namespace, key) {
              if (namespace === "verify-v1-client") {
                assert.equal(key, "client:203.0.113.10");
                return {
                  async first() {
                    return { request_count: 1 };
                  },
                };
              }
              assert.equal(namespace, "verify-v1-entitlement");
              assert.equal(key, `DEFAULT:DEFAULT:${"a".repeat(64)}`);
              return {
                async first() {
                  return { request_count: 21 };
                },
              };
            },
          };
        }
        if (sql.startsWith("DELETE FROM rate_limit_counters")) {
          return {
            bind() {
              return {
                async run() {
                  return {};
                },
              };
            },
          };
        }
        ++entitlementLookupCount;
        throw new Error("entitlement lookup should not be used for D1-rate-limited requests");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: "rate_limited" });
  assert.equal(entitlementLookupCount, 0);
});

test("D1 rate limiter cleans expired counters on first request in window", async () => {
  let cleanupCount = 0;
  let entitlementLookupCount = 0;
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind() {
              return {
                async first() {
                  return { request_count: 1 };
                },
              };
            },
          };
        }
        if (sql.startsWith("DELETE FROM rate_limit_counters")) {
          return {
            bind(nowSeconds) {
              assert.equal(Number.isInteger(nowSeconds), true);
              return {
                async run() {
                  ++cleanupCount;
                  return {};
                },
              };
            },
          };
        }
        if (sql.startsWith("SELECT project, feature, license_fingerprint")) {
          ++entitlementLookupCount;
          return {
            bind() {
              return {
                async first() {
                  return null;
                },
              };
            },
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "entitlement_denied");
  assert.equal(cleanupCount, 2);
  assert.equal(entitlementLookupCount, 1);
});

test("rate limiter failure returns controlled error", async () => {
  const env = await testKeyEnv(null, {
    VERIFY_RATE_LIMITER: {
      async limit() {
        throw new Error("simulated rate limiter outage");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
});

test("D1 rate limiter failure returns controlled error", async () => {
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind() {
              return {
                async first() {
                  throw new Error("simulated D1 limiter outage");
                },
              };
            },
          };
        }
        throw new Error("entitlement lookup should not run after D1 limiter failure");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
});
