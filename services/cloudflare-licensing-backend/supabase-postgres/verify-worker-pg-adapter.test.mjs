import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../dist/index.js";
import { requestProofFixture, testKeyEnv, validBody } from "../test/contexts/fixtures.mjs";
import { PostgresDatabase } from "./db-postgres.mjs";
import { translateWorkerSqlToPg } from "./sql-translate.mjs";
import { VERIFY_SQL } from "../src/db/verify-statements.mjs";

function postgresVerifyDatabase({ entitlement, device }) {
  const consumed = new Set();
  const calls = [];
  const translated = Object.fromEntries(
    Object.entries(VERIFY_SQL).map(([name, sql]) => [name, translateWorkerSqlToPg(sql)]),
  );
  const pool = {
    async unsafe(sql, params) {
      calls.push({ sql, params: [...params] });
      if (sql === translated.entitlementLookup) return entitlement === null ? [] : [entitlement];
      if (sql === translated.entitlementDeviceLookup) {
        return device !== null && device.device_key_id === params[3] ? [device] : [];
      }
      if (sql === translated.requestProofNonceConsume) {
        const key = params.slice(0, 5).join("|");
        if (consumed.has(key)) return [];
        consumed.add(key);
        return [{ nonce: params[4] }];
      }
      if (sql === translated.requestProofNonceCleanup) return [];
      throw new Error(`unexpected verify SQL: ${sql}`);
    },
  };
  return { DB: new PostgresDatabase(pool, true), calls, translated };
}

test("the unmodified required-mode Worker consumes and rejects a replay through the PostgreSQL adapter", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const entitlement = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 3,
      valid_from: null,
      valid_until: null,
    };
    const proof = await requestProofFixture();
    const base = await testKeyEnv(entitlement, { REQUEST_SIGNATURE_MODE: "required" });
    const postgres = postgresVerifyDatabase({ entitlement, device: proof.deviceRow });
    const env = { ...base, DB: postgres.DB };
    const send = () => worker.fetch(new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proof.body),
    }), env);

    const fresh = await send();
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).ok, true);

    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: false, code: "request_proof_invalid", server_time: 1_000_000 });

    assert.equal(postgres.calls.filter((call) => call.sql === postgres.translated.requestProofNonceConsume).length, 2);
    assert.equal(postgres.calls.filter((call) => call.sql === postgres.translated.requestProofNonceCleanup).length, 1);
    assert.ok(postgres.calls.every((call) => !call.sql.includes("?")));
  } finally {
    Date.now = originalNow;
  }
});
