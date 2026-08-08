import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../dist/index.js";
import {
  captureConsoleEvents,
  requestProofFixture,
  testKeyEnv,
  validBody,
} from "./fixtures.mjs";

// Stateful test env: real entitlement + device rows + an in-memory nonce store so a
// second identical request observes the consumed nonce.
async function replayTestEnv(row, proof, envOverrides = {}) {
  const base = await testKeyEnv(row, {
    REQUEST_SIGNATURE_MODE: "required",
    deviceRows: [proof.deviceRow],
    ...envOverrides,
  });
  const consumed = new Set();
  const innerPrepare = base.DB.prepare.bind(base.DB);
  base.DB.prepare = (sql) => {
    if (sql.includes("INSERT INTO request_proof_nonces")) {
      return {
        bind(project, feature, fingerprint, deviceKeyId, nonce) {
          const key = [project, feature, fingerprint, deviceKeyId, nonce].join("|");
          return {
            async first() {
              if (consumed.has(key)) return null; // ON CONFLICT DO NOTHING -> no row
              consumed.add(key);
              return { nonce };
            },
          };
        },
      };
    }
    if (sql.includes("DELETE FROM request_proof_nonces")) {
      return { bind: () => ({ async run() {} }) };
    }
    return innerPrepare(sql);
  };
  return { env: base, failNonceStore: () => { base.DB.prepare = failingNoncePrepare(innerPrepare); } };
}

function failingNoncePrepare(innerPrepare) {
  return (sql) => {
    if (sql.includes("request_proof_nonces")) {
      return { bind: () => ({ async first() { throw new Error("d1 down"); }, async run() { throw new Error("d1 down"); } }) };
    }
    return innerPrepare(sql);
  };
}

test("required mode denies a replayed request proof on the second identical request", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env } = await replayTestEnv(row, proof);
    const send = () =>
      worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
    const first = await send();
    assert.equal((await first.json()).ok, true);

    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: false, code: "request_proof_invalid", server_time: 1_000_000 });
  } finally {
    Date.now = originalNow;
  }
});

test("required mode fails CLOSED when the nonce store errors", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env, failNonceStore } = await replayTestEnv(row, proof);
    failNonceStore();
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proof.body),
      }),
      env,
    );
    // d1_error on the proof path returns HTTP 500 verification_error (never an allow).
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
  } finally {
    Date.now = originalNow;
  }
});

test("soft mode logs a replayed nonce but still allows", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env } = await replayTestEnv(row, proof, { REQUEST_SIGNATURE_MODE: "soft" });
    const send = () =>
      worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
    await (await send()).json();
    const logs = await captureConsoleEvents(async () => {
      const replay = await send();
      assert.equal((await replay.json()).ok, true); // soft still allows
    });
    const proofLog = logs.find((e) => e.event === "verify.request_proof");
    assert.equal(proofLog?.result, "replayed_nonce");
    assert.equal(proofLog?.mode, "soft");
  } finally {
    Date.now = originalNow;
  }
});
