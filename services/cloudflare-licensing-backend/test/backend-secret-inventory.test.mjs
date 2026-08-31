import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  REQUIRED_BACKEND_SECRET_NAMES,
  inspectBackendSecretInventory,
  parseSecretInventory,
  runBoundedCommand,
  validateProtectedConfig,
} from "../scripts/backend-secret-inventory.mjs";

function protectedConfig(profile = "staging", overrides = {}) {
  const name = profile === "production" ? "licensecc-online-verifier" : "licensecc-online-verifier-staging";
  const values = {
    REQUEST_SIGNATURE_MODE: "required",
    DEVICE_PROOF_MODE: "off",
    ACCOUNT_TOKEN_MODE: "required",
    ORDER_INGEST_MODE: "required",
    ORDER_SIGNER_SCOPE_MODE: "required",
    ORDER_INGEST_AUDIENCE: `licensecc-${profile}`,
    ACCOUNT_TOKEN_ACTIVE_PEPPER_ID: "p1",
    ...overrides,
  };
  return [
    `name = "${name}"`,
    'main = "src/index.ts"',
    "",
    "[vars]",
    ...Object.entries(values).map(([key, value]) => `${key} = "${value}"`),
    "",
  ].join("\n");
}

function withConfig(source, fn) {
  const root = mkdtempSync(join(tmpdir(), "licensecc-secret-inventory-"));
  const configPath = join(root, "wrangler.toml");
  writeFileSync(configPath, source, { encoding: "utf8", mode: 0o600 });
  return Promise.resolve(fn(configPath)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function inventory(names = REQUIRED_BACKEND_SECRET_NAMES) {
  return JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));
}

test("protected backend config requires exact security selectors and a structured active pepper id", () => {
  assert.deepEqual(validateProtectedConfig(protectedConfig("production"), "production"), {
    profile: "production",
    selectorCount: 7,
  });
  for (const [key, value] of [
    ["REQUEST_SIGNATURE_MODE", "soft"],
    ["DEVICE_PROOF_MODE", "required"],
    ["ACCOUNT_TOKEN_MODE", "soft"],
    ["ORDER_INGEST_MODE", "soft"],
    ["ORDER_SIGNER_SCOPE_MODE", "off"],
    ["ORDER_INGEST_AUDIENCE", "licensecc-production"],
    ["ACCOUNT_TOKEN_ACTIVE_PEPPER_ID", "change-me"],
    ["ACCOUNT_TOKEN_ACTIVE_PEPPER_ID", "bad pepper"],
  ]) {
    assert.throws(
      () => validateProtectedConfig(protectedConfig("staging", { [key]: value }), "staging"),
      /invalid_protected_config/u,
      `${key}=${value} must fail closed`,
    );
  }
  assert.throws(
    () => validateProtectedConfig(protectedConfig("staging").replace('ACCOUNT_TOKEN_ACTIVE_PEPPER_ID = "p1"', ""), "staging"),
    /invalid_protected_config/u,
  );
});

test("inventory validator invokes one bounded JSON name-only Wrangler command", async () => {
  await withConfig(protectedConfig("staging"), async (configPath) => {
    const calls = [];
    const result = await inspectBackendSecretInventory({
      profile: "staging",
      configPath,
      commandRunner: async (request) => {
        calls.push(request);
        return { stdout: inventory([...REQUIRED_BACKEND_SECRET_NAMES, "UNRELATED_DEPLOYED_SECRET"]) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.evidence.verdict, "pass");
    assert.equal(result.evidence.required_secret_count, 9);
    assert.equal(result.evidence.discovered_secret_count, 10);
    assert.deepEqual(result.evidence.missing_required_secret_names, []);
    assert.deepEqual(calls, [{
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["--no-install", "wrangler", "secret", "list", "--format", "json", "--config", configPath],
      cwd: calls[0].cwd,
      timeoutMs: 30_000,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 16_384,
    }]);
    const serialized = JSON.stringify(result.evidence);
    assert.doesNotMatch(serialized, /UNRELATED_DEPLOYED_SECRET/u);
    assert.doesNotMatch(serialized, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  });
});

test("missing required names fail without exposing discovered extra names or values", async () => {
  await withConfig(protectedConfig("production"), async (configPath) => {
    const missing = ["LEASE_SIGNING_KEY_ID", "LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM"];
    const present = REQUIRED_BACKEND_SECRET_NAMES.filter((name) => !missing.includes(name));
    const result = await inspectBackendSecretInventory({
      profile: "production",
      configPath,
      commandRunner: async () => ({
        stdout: JSON.stringify([...present.map((name) => ({ name })), { name: "CUSTOMER_PAYLOAD_SENTINEL" }]),
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.evidence.failure_code, "required_secrets_missing");
    assert.equal(result.evidence.protected_config.status, "validated");
    assert.deepEqual(result.evidence.missing_required_secret_names, missing);
    const serialized = JSON.stringify(result.evidence);
    assert.doesNotMatch(serialized, /CUSTOMER_PAYLOAD_SENTINEL/u);
  });
});

test("malformed, duplicate, and oversized inventories fail closed", () => {
  for (const source of [
    "not-json",
    "{}",
    JSON.stringify([{ name: "GOOD" }, { name: "GOOD" }]),
    JSON.stringify([{ name: "bad-name" }]),
    JSON.stringify([{ name: "GOOD", value: "secret-content" }]),
    JSON.stringify([{ name: "GOOD", type: { value: "secret-content" } }]),
    JSON.stringify(Array.from({ length: 257 }, (_, index) => ({ name: `SECRET_${index}` }))),
    `[]${" ".repeat(65_537)}`,
  ]) {
    assert.throws(() => parseSecretInventory(source), /invalid_secret_inventory/u);
  }
});

test("protected config failure prevents the remote inventory command and emits generic evidence", async () => {
  await withConfig(protectedConfig("staging", { ACCOUNT_TOKEN_ACTIVE_PEPPER_ID: "placeholder" }), async (configPath) => {
    let invoked = false;
    const result = await inspectBackendSecretInventory({
      profile: "staging",
      configPath,
      commandRunner: async () => {
        invoked = true;
        return { stdout: inventory() };
      },
    });
    assert.equal(invoked, false);
    assert.equal(result.ok, false);
    assert.equal(result.evidence.failure_code, "invalid_protected_config");
    assert.equal(result.evidence.discovered_secret_count, null);
    assert.deepEqual(result.evidence.missing_required_secret_names, []);
  });
});

test("subprocess runner bounds stdout, stderr, and wall time without returning diagnostics", async () => {
  await assert.rejects(
    runBoundedCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    }),
    /secret_inventory_output_exceeded/u,
  );
  await assert.rejects(
    runBoundedCommand({
      command: process.execPath,
      args: ["-e", "process.stderr.write('sensitive-diagnostic'.repeat(100))"],
      timeoutMs: 2_000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 128,
    }),
    /secret_inventory_output_exceeded/u,
  );
  await assert.rejects(
    runBoundedCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
    }),
    /secret_inventory_command_timeout/u,
  );
});
