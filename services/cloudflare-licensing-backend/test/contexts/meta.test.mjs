import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../dist/app.js";
import { protectedDeviceEnv } from "../helpers/protected-device-env.mjs";

// One signer for the whole file. Each test spreads it into a fresh env object, so the
// per-env readiness result is never shared between tests.
const PROTECTED = await protectedDeviceEnv();

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
    ["empty env", {}],
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

test("an invalid security selector fails health even when protected licensing is ready", async () => {
  const invalid = await health({ ...PROTECTED, ORDER_SIGNER_SCOPE_MODE: "not-a-mode" });
  assert.equal(invalid.status, 503, "invalid security configuration fails readiness");
  assert.equal(invalid.body.ok, false);
  assert.equal(invalid.body.protected_device_ready, true);
  assert.equal(invalid.body.code, "config_error");
  assert.deepEqual(invalid.body.invalid_config_modes, ["ORDER_SIGNER_SCOPE_MODE"]);
  assert.doesNotMatch(JSON.stringify(invalid.body), /not-a-mode/, "health never reflects raw configuration values");
});

test("/health exposes every invalid security-mode selector without its raw value", async () => {
  const selectors = ["ORDER_SIGNER_SCOPE_MODE"];
  // Treat typos, case changes, and whitespace changes as configuration errors. Each
  // one could otherwise normalize into an unintentionally permissive mode.
  for (const raw of ["typo", "REQUIRED", " required"]) {
    for (const selector of selectors) {
      const response = await worker.fetch(new Request("https://example.test/health"), { ...PROTECTED, [selector]: raw });
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
  // A secret present but its enforcing mode left off -> a permissive posture the operator likely
  // did not intend. Marker-free non-empty values (the check only tests presence, never parses).
  const env = {
    ...PROTECTED,
    ORDER_SIGNER_SCOPES: "configured",
    ORDER_SIGNER_SCOPE_MODE: "off",
  };
  const res = await worker.fetch(new Request("https://example.test/health"), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.config_warnings));
  assert.ok(body.config_warnings.some((w) => w.includes("ORDER_SIGNER_SCOPE_MODE")));
});

test("/health has no config_warnings when enforcing modes match the configured secrets (R2.3)", async () => {
  const env = {
    ...PROTECTED,
    ORDER_SIGNER_SCOPES: "configured",
    ORDER_SIGNER_SCOPE_MODE: "required",
  };
  const res = await worker.fetch(new Request("https://example.test/health"), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.config_warnings, undefined);
});

test("/health normalizes empty, unset, and off paired-mode values before emitting half-config warnings", async () => {
  for (const raw of [undefined, "", "off"]) {
    const env = { ...PROTECTED, ORDER_SIGNER_SCOPES: "configured" };
    if (raw !== undefined) env.ORDER_SIGNER_SCOPE_MODE = raw;
    const response = await worker.fetch(new Request("https://example.test/health"), env);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.config_warnings.some((warning) => warning.includes("ORDER_SIGNER_SCOPE_MODE")));
  }
});

test("/health treats an invalid paired mode as a readiness error rather than a permissive warning", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), {
    ORDER_SIGNER_SCOPES: "configured",
    ORDER_SIGNER_SCOPE_MODE: "not-a-mode",
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body.invalid_config_modes, ["ORDER_SIGNER_SCOPE_MODE"]);
  assert.ok(body.config_warnings.some((warning) => warning.includes("invalid value")));
  assert.equal(body.config_warnings.some((warning) => warning.includes("order signer scoping is not enforced")), false);
});
