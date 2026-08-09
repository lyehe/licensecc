// Strict security-mode configuration gates. Unknown rollout values must never collapse into
// a permissive mode, and the Worker must reject them before it reaches auth, D1, or signing.

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../dist/index.js";
import {
  checkDeviceProof,
  resetSigningKeyCacheForTests,
  signingKeyImportCountForTests,
} from "../dist/routes/verify.js";
import { accountAuth, accountTokenMode } from "../src/auth/account_auth.mjs";

function countingDb(calls) {
  return {
    prepare() {
      calls.prepare += 1;
      throw new Error("invalid configuration must not reach D1");
    },
  };
}

function verifyRequest() {
  return new Request("https://example.test/v1/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: "a".repeat(64),
      device_hash: "",
      nonce: "b".repeat(64),
    }),
  });
}

test("invalid security-mode selectors are observable and block Worker work before D1 or signing", async () => {
  const selectors = ["ACCOUNT_TOKEN_MODE", "REQUEST_SIGNATURE_MODE", "DEVICE_PROOF_MODE", "ORDER_SIGNER_SCOPE_MODE"];
  for (const raw of ["typo", "REQUIRED", " required"]) {
    for (const selector of selectors) {
      const calls = { prepare: 0 };
      resetSigningKeyCacheForTests();
      const originalError = console.error;
      const events = [];
      console.error = (line) => events.push(JSON.parse(String(line)));
      let response;
      try {
        response = await worker.fetch(verifyRequest(), { DB: countingDb(calls), [selector]: raw });
      } finally {
        console.error = originalError;
      }
      assert.equal(response.status, 503, `${selector}=${JSON.stringify(raw)}`);
      assert.deepEqual(await response.json(), { ok: false, code: "config_error" });
      assert.equal(calls.prepare, 0, "config error occurs before DB access");
      assert.equal(signingKeyImportCountForTests(), 0, "config error occurs before assertion signing/import");
      assert.ok(events.some((event) => event.event === "config.invalid_security_modes" && event.invalid_config_modes.includes(selector)));
      assert.doesNotMatch(JSON.stringify(events), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "logs omit raw values");
    }
  }
});

test("account-token mode parser rejects unknown values before bearer auth or token lookup", async () => {
  for (const raw of ["typo", "REQUIRED", " required"]) {
    const calls = { prepare: 0 };
    const env = { ACCOUNT_TOKEN_MODE: raw, DB: countingDb(calls), LEASE_ISSUE_BEARER: "secret" };
    assert.equal(accountTokenMode(env), "invalid");
    const result = await accountAuth(
      new Request("https://example.test/v1/activate", { headers: { authorization: "Bearer secret" } }),
      env,
      "activate",
      "DEFAULT",
      "DEFAULT",
      1,
    );
    assert.deepEqual(result, { ok: false, status: 503, code: "config_error" });
    assert.equal(calls.prepare, 0);
  }
});

test("device-proof mode parser rejects unknown values before device lookup", async () => {
  for (const raw of ["typo", "REQUIRED", " required"]) {
    const calls = { prepare: 0 };
    const result = await checkDeviceProof(
      { DEVICE_PROOF_MODE: raw, DB: countingDb(calls) },
      {
        project: "DEFAULT",
        feature: "DEFAULT",
        license_fingerprint: "a".repeat(64),
        device_hash: "",
        nonce: "b".repeat(64),
      },
      undefined,
      1,
      "licensecc-seat-request",
    );
    assert.deepEqual(result, { ok: false, code: "config_error", proven: false });
    assert.equal(calls.prepare, 0);
  }
});
