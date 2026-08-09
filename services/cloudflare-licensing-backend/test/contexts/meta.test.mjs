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
    assert.equal(response.status, 200, "backend liveness remains independent of account-token rollout mode");
    return response.json();
  };

  assert.equal((await health("required")).account_token_mode, "required");
  assert.equal((await health("soft")).account_token_mode, "soft");
  assert.equal((await health("off")).account_token_mode, "off");
  assert.equal((await health(undefined)).account_token_mode, "off");
  assert.equal((await health("not-a-mode")).account_token_mode, "off");
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
