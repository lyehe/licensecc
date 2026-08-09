import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../dist/index.js";
import { testKeyEnv } from "./fixtures.mjs";

test("health route returns status", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), await testKeyEnv(null));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("/health exposes the backend's normalized account-token enforcement mode without secrets", async () => {
  const health = async (ACCOUNT_TOKEN_MODE) => {
    const response = await worker.fetch(new Request("https://example.test/health"), { ACCOUNT_TOKEN_MODE });
    return { status: response.status, body: await response.json() };
  };

  for (const mode of ["required", "soft", "off", undefined]) {
    const healthResult = await health(mode);
    assert.equal(healthResult.status, 200);
    assert.equal(healthResult.body.account_token_mode, mode ?? "off");
  }

  const invalid = await health("not-a-mode");
  assert.equal(invalid.status, 503, "invalid security configuration fails readiness");
  assert.equal(invalid.body.ok, false);
  assert.equal(invalid.body.code, "config_error");
  assert.equal(invalid.body.account_token_mode, "invalid");
  assert.deepEqual(invalid.body.invalid_config_modes, ["ACCOUNT_TOKEN_MODE"]);
  assert.doesNotMatch(JSON.stringify(invalid.body), /not-a-mode/, "health never reflects raw configuration values");
});

test("/health exposes every invalid security-mode selector without its raw value", async () => {
  const selectors = ["ACCOUNT_TOKEN_MODE", "REQUEST_SIGNATURE_MODE", "DEVICE_PROOF_MODE", "ORDER_SIGNER_SCOPE_MODE"];
  // Treat typos, case changes, and whitespace changes as configuration errors. Each
  // one could otherwise normalize into an unintentionally permissive mode.
  for (const raw of ["typo", "REQUIRED", " required"]) {
    for (const selector of selectors) {
      const response = await worker.fetch(new Request("https://example.test/health"), { [selector]: raw });
      assert.equal(response.status, 503, `${selector}=${JSON.stringify(raw)} fails readiness`);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.code, "config_error");
      assert.deepEqual(body.invalid_config_modes, [selector]);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("/health surfaces config-consistency warnings for a half-configured deploy (R2.3)", async () => {
  // Secrets present but their enforcing modes left off -> a permissive posture the operator likely
  // did not intend. Marker-free non-empty values (the check only tests presence, never parses).
  const env = {
    ACCOUNT_TOKEN_PEPPERS: "configured",
    ACCOUNT_TOKEN_MODE: "off",
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "present",
    REQUEST_SIGNATURE_MODE: "off",
    ORDER_SIGNER_SCOPES: "configured",
    ORDER_SIGNER_SCOPE_MODE: "off",
  };
  const res = await worker.fetch(new Request("https://example.test/health"), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.config_warnings));
  assert.ok(body.config_warnings.some((w) => w.includes("ACCOUNT_TOKEN_MODE")));
  assert.ok(body.config_warnings.some((w) => w.includes("REQUEST_SIGNATURE_MODE")));
  assert.ok(body.config_warnings.some((w) => w.includes("ORDER_SIGNER_SCOPE_MODE")));
});

test("/health has no config_warnings when enforcing modes match the configured secrets (R2.3)", async () => {
  const env = {
    ACCOUNT_TOKEN_PEPPERS: "configured",
    ACCOUNT_TOKEN_MODE: "required",
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "present",
    REQUEST_SIGNATURE_MODE: "required",
  };
  const res = await worker.fetch(new Request("https://example.test/health"), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.config_warnings, undefined);
});
