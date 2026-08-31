#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BACKEND_CONFIG_PATH = resolve(SERVICE_ROOT, "wrangler.toml");
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_INVENTORY_ENTRIES = 256;

export const REQUIRED_BACKEND_SECRET_NAMES = Object.freeze([
  "ACCOUNT_TOKEN_PEPPERS",
  "LEASE_SIGNING_KEY_ID",
  "LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
  "ONLINE_SIGNING_KEY_ID",
  "ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
  "ORDER_HMAC_SECRETS",
  "ORDER_SIGNER_SCOPES",
  "WEBHOOK_SIGNING_KEY_ID",
  "WEBHOOK_SIGNING_SECRETS",
]);

const REQUIRED_MODES = Object.freeze([
  "REQUEST_SIGNATURE_MODE",
  "ACCOUNT_TOKEN_MODE",
  "ORDER_INGEST_MODE",
  "ORDER_SIGNER_SCOPE_MODE",
]);
const PROTECTED_SELECTOR_COUNT = REQUIRED_MODES.length + 3;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SELECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

class InventoryError extends Error {
  constructor(code) {
    super(code);
    this.name = "InventoryError";
    this.code = code;
  }
}

function fail(code) {
  throw new InventoryError(code);
}

function parseProfileArgs(argv) {
  if (argv.length !== 1 || !argv[0].startsWith("--profile=")) {
    fail("invalid_arguments");
  }
  const profile = argv[0].slice("--profile=".length);
  if (profile !== "production" && profile !== "staging") {
    fail("invalid_profile");
  }
  return profile;
}

function extractBasicString(configText, section, key) {
  let currentSection = "";
  let found;
  for (const line of configText.split(/\r?\n/u)) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    if (currentSection !== section) continue;
    const assignment = new RegExp(`^\\s*${key}\\s*=\\s*\"([^\"\\\\]*)\"\\s*(?:#.*)?$`, "u").exec(line);
    if (!assignment) continue;
    if (found !== undefined) fail("invalid_protected_config");
    found = assignment[1];
  }
  if (found === undefined) fail("invalid_protected_config");
  return found;
}

export function validateProtectedConfig(configText, profile) {
  if (typeof configText !== "string" || Buffer.byteLength(configText, "utf8") > MAX_CONFIG_BYTES) {
    fail("invalid_protected_config");
  }
  if (profile !== "production" && profile !== "staging") fail("invalid_profile");

  const expectedName = profile === "production" ? "licensecc-online-verifier" : "licensecc-online-verifier-staging";
  if (extractBasicString(configText, "", "name") !== expectedName) fail("invalid_protected_config");
  for (const mode of REQUIRED_MODES) {
    if (extractBasicString(configText, "vars", mode) !== "required") fail("invalid_protected_config");
  }
  if (extractBasicString(configText, "vars", "DEVICE_PROOF_MODE") !== "off") fail("invalid_protected_config");
  if (extractBasicString(configText, "vars", "ORDER_INGEST_AUDIENCE") !== `licensecc-${profile}`) {
    fail("invalid_protected_config");
  }
  const activePepperId = extractBasicString(configText, "vars", "ACCOUNT_TOKEN_ACTIVE_PEPPER_ID");
  if (!SELECTOR_ID.test(activePepperId) || /^(?:replace|placeholder|example|change-me)/iu.test(activePepperId)) {
    fail("invalid_protected_config");
  }
  return { profile, selectorCount: PROTECTED_SELECTOR_COUNT };
}

async function readProtectedConfig(configPath) {
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch {
    fail("protected_config_unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_CONFIG_BYTES) {
    fail("protected_config_unavailable");
  }
  try {
    return await readFile(configPath, "utf8");
  } catch {
    fail("protected_config_unavailable");
  }
}

export function runBoundedCommand({
  command,
  args,
  cwd = SERVICE_ROOT,
  timeoutMs = COMMAND_TIMEOUT_MS,
  maxStdoutBytes = MAX_STDOUT_BYTES,
  maxStderrBytes = MAX_STDERR_BYTES,
}) {
  return new Promise((resolveCommand, rejectCommand) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    let child;
    let timer;

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectCommand(error);
      else resolveCommand(result);
    };
    const terminate = (code) => {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      settle(new InventoryError(code));
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, WRANGLER_LOG: "error", WRANGLER_WRITE_LOGS: "false" },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      settle(new InventoryError("secret_inventory_command_failed"));
      return;
    }

    timer = setTimeout(() => terminate("secret_inventory_command_timeout"), timeoutMs);
    timer.unref?.();
    child.on("error", () => terminate("secret_inventory_command_failed"));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        terminate("secret_inventory_output_exceeded");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) terminate("secret_inventory_output_exceeded");
      // Wrangler diagnostics are intentionally discarded: they can contain account/target context.
    });
    child.on("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        settle(new InventoryError("secret_inventory_command_failed"));
        return;
      }
      settle(null, { stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8") });
    });
  });
}

export function parseSecretInventory(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
    fail("invalid_secret_inventory");
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("invalid_secret_inventory");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_INVENTORY_ENTRIES) fail("invalid_secret_inventory");
  const names = new Set();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !SECRET_NAME.test(entry.name ?? "")) {
      fail("invalid_secret_inventory");
    }
    if (Object.keys(entry).some((key) => key !== "name" && key !== "type")) fail("invalid_secret_inventory");
    if (Object.hasOwn(entry, "type") && entry.type !== "secret_text") fail("invalid_secret_inventory");
    if (names.has(entry.name)) fail("invalid_secret_inventory");
    names.add(entry.name);
  }
  return names;
}

function evidence({ profile, discoveredCount, missingSecretNames, verdict, failureCode, configValidated = false }) {
  const result = {
    schema_version: "licensecc.backend-secret-inventory.v1",
    check: "protected_backend_secret_inventory",
    environment: profile ?? "unknown",
    target: "redacted",
    required_secret_count: REQUIRED_BACKEND_SECRET_NAMES.length,
    discovered_secret_count: discoveredCount,
    protected_config: {
      status: configValidated ? "validated" : "not_validated",
      required_selector_count: PROTECTED_SELECTOR_COUNT,
    },
    missing_required_secret_names: missingSecretNames,
    verdict,
  };
  if (failureCode) result.failure_code = failureCode;
  return result;
}

export async function inspectBackendSecretInventory({
  profile,
  configPath = BACKEND_CONFIG_PATH,
  commandRunner = runBoundedCommand,
} = {}) {
  try {
    const configText = await readProtectedConfig(configPath);
    validateProtectedConfig(configText, profile);
    const executable = process.platform === "win32" ? "npx.cmd" : "npx";
    const commandResult = await commandRunner({
      command: executable,
      args: ["--no-install", "wrangler", "secret", "list", "--format", "json", "--config", configPath],
      cwd: SERVICE_ROOT,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      maxStderrBytes: MAX_STDERR_BYTES,
    });
    const names = parseSecretInventory(commandResult.stdout);
    const missing = REQUIRED_BACKEND_SECRET_NAMES.filter((name) => !names.has(name));
    return {
      ok: missing.length === 0,
      evidence: evidence({
        profile,
        discoveredCount: names.size,
        missingSecretNames: missing,
        verdict: missing.length === 0 ? "pass" : "fail",
        failureCode: missing.length === 0 ? undefined : "required_secrets_missing",
        configValidated: true,
      }),
    };
  } catch (error) {
    const failureCode = error instanceof InventoryError ? error.code : "secret_inventory_check_failed";
    return {
      ok: false,
      evidence: evidence({
        profile,
        discoveredCount: null,
        missingSecretNames: [],
        verdict: "fail",
        failureCode,
      }),
    };
  }
}

async function main() {
  let profile;
  try {
    profile = parseProfileArgs(process.argv.slice(2));
  } catch (error) {
    const failureCode = error instanceof InventoryError ? error.code : "invalid_arguments";
    process.stdout.write(`${JSON.stringify(evidence({
      profile: undefined,
      discoveredCount: null,
      missingSecretNames: [],
      verdict: "fail",
      failureCode,
    }))}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await inspectBackendSecretInventory({ profile });
  process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify(evidence({
      profile: undefined,
      discoveredCount: null,
      missingSecretNames: [],
      verdict: "fail",
      failureCode: "secret_inventory_check_failed",
    }))}\n`);
    process.exitCode = 1;
  });
}
