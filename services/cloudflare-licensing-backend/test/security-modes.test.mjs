// Strict security-mode configuration gates. Unknown rollout values must never collapse into
// a permissive mode, and the Worker must reject them before it reaches auth or D1.

import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../dist/app.js";
import { accountAuth, accountTokenMode } from "../src/auth/account_auth.mjs";
import {
  parseAccountTokenMode,
  parseDeviceProofMode,
  parseOrderSignerScopeMode,
  parseRequestSignatureMode,
} from "../src/security_modes.mjs";

function countingDb(calls) {
  return {
    prepare() {
      calls.prepare += 1;
      throw new Error("invalid configuration must not reach D1");
    },
  };
}

function ordersRequest() {
  return new Request("https://example.test/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

test("security-mode parsers preserve legacy empty values and every exact supported value", () => {
  const cases = [
    [parseAccountTokenMode, "ACCOUNT_TOKEN_MODE", ["off", "soft", "required"]],
    [parseRequestSignatureMode, "REQUEST_SIGNATURE_MODE", ["off", "soft", "required"]],
    [parseDeviceProofMode, "DEVICE_PROOF_MODE", ["off", "required"]],
    [parseOrderSignerScopeMode, "ORDER_SIGNER_SCOPE_MODE", ["off", "soft", "required"]],
  ];
  for (const [parse, selector, supported] of cases) {
    for (const raw of [undefined, "", ...supported]) {
      const parsed = parse({ [selector]: raw });
      assert.equal(parsed.valid, true, selector + "=" + JSON.stringify(raw));
      assert.equal(parsed.mode, raw === undefined || raw === "" ? "off" : raw);
    }
  }
});

test("invalid security-mode selectors are observable and block Worker work before D1", async () => {
  const selectors = ["ACCOUNT_TOKEN_MODE", "REQUEST_SIGNATURE_MODE", "DEVICE_PROOF_MODE", "ORDER_SIGNER_SCOPE_MODE"];
  for (const raw of ["typo", "REQUIRED", " required"]) {
    for (const selector of selectors) {
      const calls = { prepare: 0 };
      const originalError = console.error;
      const events = [];
      console.error = (line) => events.push(JSON.parse(String(line)));
      let response;
      try {
        response = await worker.fetch(ordersRequest(), { DB: countingDb(calls), [selector]: raw });
      } finally {
        console.error = originalError;
      }
      assert.equal(response.status, 503, `${selector}=${JSON.stringify(raw)}`);
      assert.deepEqual(await response.json(), { ok: false, code: "config_error" });
      assert.equal(calls.prepare, 0, "config error occurs before DB access");
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
      new Request("https://example.test/", { headers: { authorization: "Bearer secret" } }),
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
