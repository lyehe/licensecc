import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../dist/app.js";
import { configConsistencyCleanEnv, protectedDeviceEnv } from "../helpers/protected-device-env.mjs";

// One signer for the whole file. Each test spreads it into a fresh env object, so the
// per-env readiness result is never shared between tests. Also warning-free for
// /health's config-consistency check (a signer-scope map plus both edge limiters), so
// a test that wants one specific warning removes just that one field.
const PROTECTED = { ...(await protectedDeviceEnv()), ...configConsistencyCleanEnv() };

async function health(env) {
  const response = await worker.fetch(new Request("https://example.test/health"), env);
  return { status: response.status, body: await response.json() };
}

test("health route returns status", async () => {
  const result = await health({ ...PROTECTED });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, service: "licensecc-online-verifier", protected_device_ready: true });
});

test("health reports protected_device_ready false and 503 without BOUND_DEVICE_CONFIG", async () => {
  const { BOUND_DEVICE_CONFIG: _registry, ...withoutRegistry } = PROTECTED;
  const { BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM: _signer, ...withoutSigner } = PROTECTED;
  for (const [label, env] of [
    ["no registry", withoutRegistry],
    ["invalid registry", { ...PROTECTED, BOUND_DEVICE_CONFIG: "{}" }],
    ["no signer", withoutSigner],
    ["invalid global rate limit", { ...PROTECTED, BOUND_GLOBAL_RATE_LIMIT: "12.5" }],
  ]) {
    const result = await health(env);
    assert.equal(result.status, 503, `${label} fails readiness`);
    assert.deepEqual(result.body, { ok: false, service: "licensecc-online-verifier", protected_device_ready: false }, label);
    assert.doesNotMatch(JSON.stringify(result.body), /KEY|licenses\.example|12\.5/u, `${label} reflects no configuration`);
  }
});

test("an empty env fails readiness and also warns on every missing config-consistency check", async () => {
  const result = await health({});
  assert.equal(result.status, 503);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.protected_device_ready, false);
  assert.ok(Array.isArray(result.body.config_warnings));
  assert.equal(result.body.config_warnings.length, 3);
  assert.ok(result.body.config_warnings.some((w) => w.includes("ORDER_SIGNER_SCOPES")));
  assert.ok(result.body.config_warnings.some((w) => w.includes("BOUND_REGISTRATION_RATE_LIMITER")));
  assert.ok(result.body.config_warnings.some((w) => w.includes("BOUND_SESSION_RATE_LIMITER")));
});

test("/health has no config_warnings for a fully configured deploy", async () => {
  const result = await health({ ...PROTECTED });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.config_warnings, undefined);
});

test("/health warns when ORDER_SIGNER_SCOPES is missing", async () => {
  const { ORDER_SIGNER_SCOPES: _scopes, ...withoutScopes } = PROTECTED;
  const result = await health(withoutScopes);
  assert.equal(result.status, 200, "a missing signer-scope map is a warning, not a readiness failure");
  assert.equal(result.body.ok, true);
  assert.ok(Array.isArray(result.body.config_warnings));
  assert.ok(result.body.config_warnings.some((w) => w.includes("ORDER_SIGNER_SCOPES")));
});

test("/health warns when BOUND_REGISTRATION_RATE_LIMITER is unbound", async () => {
  const { BOUND_REGISTRATION_RATE_LIMITER: _limiter, ...withoutLimiter } = PROTECTED;
  const result = await health(withoutLimiter);
  assert.equal(result.status, 200, "an unbound edge limiter is a warning, not a readiness failure");
  assert.ok(result.body.config_warnings.some((w) => w.includes("BOUND_REGISTRATION_RATE_LIMITER")));
});

test("/health warns when BOUND_SESSION_RATE_LIMITER is unbound", async () => {
  const { BOUND_SESSION_RATE_LIMITER: _limiter, ...withoutLimiter } = PROTECTED;
  const result = await health(withoutLimiter);
  assert.equal(result.status, 200, "an unbound edge limiter is a warning, not a readiness failure");
  assert.ok(result.body.config_warnings.some((w) => w.includes("BOUND_SESSION_RATE_LIMITER")));
});
