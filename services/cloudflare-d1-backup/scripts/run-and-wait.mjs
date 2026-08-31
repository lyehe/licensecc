#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_ENV_NAME = "BACKUP_TRIGGER_TOKEN";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INSTANCE_ID_LENGTH = 100;
const MAX_IDENTITY_LENGTH = 512;
const MAX_OBJECT_KEY_LENGTH = 2048;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const PENDING_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
]);

class BackupGateError extends Error {
  constructor(code) {
    super(code);
    this.name = "BackupGateError";
    this.code = code;
  }
}

function fail(code) {
  throw new BackupGateError(code);
}

function usage() {
  return `usage:
  npm run backup:pre-migration -- --url <backup-worker-url> --database-id <database-id> --database-name <database-name> [--timeout-seconds <seconds>] [--initial-delay-ms <milliseconds>] [--max-delay-ms <milliseconds>]

Runs an authenticated pre-migration backup and waits for its Workflow to
complete. ${TOKEN_ENV_NAME} must be supplied through the environment; token
arguments are deliberately unsupported. Output is redacted JSON and never
contains the token or Worker URL.`;
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`${option.slice(2).replaceAll("-", "_")}_required`);
  }
  return value;
}

function positiveInteger(value, code, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(code);
  }
  return parsed;
}

function requiredIdentity(value, code) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_IDENTITY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code);
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("backup_url_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    fail("backup_url_invalid");
  }
  return parsed.origin;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    const optionNames = new Map([
      ["--url", "url"],
      ["--database-id", "databaseId"],
      ["--database-name", "databaseName"],
      ["--timeout-seconds", "timeoutSeconds"],
      ["--initial-delay-ms", "initialDelayMs"],
      ["--max-delay-ms", "maxDelayMs"],
    ]);
    const property = optionNames.get(arg);
    if (property === undefined) {
      fail("unknown_argument");
    }
    options[property] = valueAfter(argv, index, arg);
    index += 1;
  }
  return options;
}

function gateConfig(options, env = process.env) {
  const token = env[TOKEN_ENV_NAME];
  if (typeof token !== "string" || token.trim() === "") {
    fail("backup_trigger_token_required");
  }
  const timeoutMs = options.timeoutSeconds === undefined
    ? DEFAULT_TIMEOUT_MS
    : positiveInteger(options.timeoutSeconds, "timeout_seconds_invalid", 24 * 60 * 60) * 1000;
  const initialDelayMs = options.initialDelayMs === undefined
    ? DEFAULT_INITIAL_DELAY_MS
    : positiveInteger(options.initialDelayMs, "initial_delay_invalid", 60_000);
  const maxDelayMs = options.maxDelayMs === undefined
    ? DEFAULT_MAX_DELAY_MS
    : positiveInteger(options.maxDelayMs, "max_delay_invalid", 60_000);
  if (initialDelayMs > maxDelayMs || initialDelayMs >= timeoutMs) {
    fail("polling_configuration_invalid");
  }
  return {
    baseUrl: normalizeBaseUrl(options.url),
    databaseId: requiredIdentity(options.databaseId, "database_id_required"),
    databaseName: requiredIdentity(options.databaseName, "database_name_required"),
    token,
    timeoutMs,
    initialDelayMs,
    maxDelayMs,
  };
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

async function readBoundedJson(response, label, maximumBytes = MAX_RESPONSE_BYTES) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    fail(`${label}_invalid_content_type`);
  }
  const lengthHeader = response.headers?.get?.("content-length");
  if (lengthHeader !== null && lengthHeader !== undefined && lengthHeader !== "") {
    const declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      fail(`${label}_invalid_response`);
    }
    if (declaredLength > maximumBytes) {
      fail(`${label}_response_too_large`);
    }
  }
  if (response.body === null || response.body === undefined) {
    fail(`${label}_invalid_response`);
  }

  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximumBytes);
  let size = 0;
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        fail(`${label}_invalid_response`);
      }
      if (chunk.done) {
        break;
      }
      const value = chunk.value;
      if (!(value instanceof Uint8Array)) {
        fail(`${label}_invalid_response`);
      }
      if (size + value.byteLength > maximumBytes) {
        try {
          await reader.cancel("response_too_large");
        } catch {
          // Rejection is already determined; cancellation errors are not exposed.
        }
        fail(`${label}_response_too_large`);
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } catch {
    fail(`${label}_invalid_response`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}_invalid_json`);
  }
}

async function requestJson(fetchImpl, url, token, options) {
  const controller = new AbortController();
  let requestTimedOut = false;
  const timeout = setTimeout(() => {
    requestTimedOut = true;
    controller.abort();
  }, options.requestTimeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: options.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      fail(requestTimedOut ? "backup_gate_timeout" : `${options.label}_request_failed`);
    }
    if (response.status >= 300 && response.status < 400) {
      fail(`${options.label}_redirect`);
    }
    if (response.status !== options.expectedStatus) {
      fail(`${options.label}_http_${response.status}`);
    }
    return await readBoundedJson(response, options.label);
  } finally {
    clearTimeout(timeout);
  }
}

function parseStarted(value) {
  const body = asRecord(value);
  const id = body?.id;
  if (
    body?.ok !== true ||
    body.code !== "backup_started" ||
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > MAX_INSTANCE_ID_LENGTH ||
    !/^[A-Za-z0-9_.:-]+$/.test(id)
  ) {
    fail("backup_start_invalid_response");
  }
  return id;
}

function parseStatus(value, expectedId) {
  const body = asRecord(value);
  const details = asRecord(body?.details);
  if (
    body?.ok !== true ||
    body.code !== "backup_status" ||
    body.id !== expectedId ||
    details === null ||
    typeof details.status !== "string"
  ) {
    fail("backup_status_invalid_response");
  }
  return details;
}

function safeOpaque(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.includes("://")
  );
}

function safeObjectKey(value) {
  return (
    safeOpaque(value, MAX_OBJECT_KEY_LENGTH) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("backup_timestamp_invalid");
  }
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== value) {
    fail("backup_timestamp_invalid");
  }
  return timestampMs;
}

function integrityOutput(value) {
  const integrity = asRecord(value);
  if (
    integrity?.algorithm !== "sha256" ||
    typeof integrity.digest_hex !== "string" ||
    !/^[0-9a-f]{64}$/.test(integrity.digest_hex) ||
    !Number.isSafeInteger(integrity.size_bytes) ||
    integrity.size_bytes < 1 ||
    integrity.r2_size_bytes !== integrity.size_bytes ||
    !safeOpaque(integrity.r2_etag, MAX_IDENTITY_LENGTH) ||
    !safeOpaque(integrity.r2_version, MAX_IDENTITY_LENGTH)
  ) {
    fail("backup_integrity_invalid");
  }
  if (
    integrity.r2_sha256_hex !== undefined &&
    (typeof integrity.r2_sha256_hex !== "string" ||
      !/^[0-9a-f]{64}$/.test(integrity.r2_sha256_hex) ||
      integrity.r2_sha256_hex !== integrity.digest_hex)
  ) {
    fail("backup_integrity_invalid");
  }
  // Deliberately omit the digest, ETag, and R2 version from public gate output.
  return {
    algorithm: "sha256",
    size_bytes: integrity.size_bytes,
    r2_object_metadata_bound: true,
    r2_sha256_reported: integrity.r2_sha256_hex !== undefined,
  };
}

function snapshotInventoryOutput(value) {
  const inventory = asRecord(value);
  const tableCounts = asRecord(inventory?.table_counts);
  if (
    inventory?.algorithm !== "d1-export-sql-insert-count-v1" ||
    tableCounts === null
  ) {
    fail("backup_snapshot_inventory_invalid");
  }
  const entries = Object.entries(tableCounts);
  if (
    entries.length < 1 ||
    entries.length > 256 ||
    entries.some(([table, count]) =>
      !/^[a-z][a-z0-9_]{0,63}$/.test(table) ||
      !Number.isSafeInteger(count) ||
      Number(count) < 0)
  ) {
    fail("backup_snapshot_inventory_invalid");
  }
  return {
    algorithm: "d1-export-sql-insert-count-v1",
    counted_table_count: entries.length,
  };
}

function completedOutput(details, config, timing = {}) {
  const output = asRecord(details.output);
  if (output === null) {
    fail("backup_completion_invalid");
  }
  if (output.database_id !== config.databaseId || output.database_name !== config.databaseName) {
    fail("backup_database_identity_mismatch");
  }
  if (!safeOpaque(output.bookmark, MAX_IDENTITY_LENGTH)) {
    fail("backup_bookmark_invalid");
  }
  if (!safeObjectKey(output.object_key) || !safeObjectKey(output.manifest_key)) {
    fail("backup_object_identity_invalid");
  }
  if (output.manifest_key !== `${output.object_key}.metadata.json`) {
    fail("backup_object_identity_invalid");
  }
  const nowMs = timing.nowMs ?? Date.now();
  const gateStartedAtMs = timing.gateStartedAtMs ?? nowMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(gateStartedAtMs)) {
    fail("backup_timestamp_invalid");
  }
  const snapshotRequestedAtMs = canonicalTimestamp(output.snapshot_requested_at);
  const createdAtMs = canonicalTimestamp(output.created_at);
  if (
    snapshotRequestedAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS ||
    createdAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS ||
    createdAtMs + MAX_FUTURE_CLOCK_SKEW_MS < snapshotRequestedAtMs
  ) {
    fail("backup_timestamp_invalid");
  }
  if (snapshotRequestedAtMs + MAX_FUTURE_CLOCK_SKEW_MS < gateStartedAtMs) {
    fail("backup_snapshot_stale");
  }
  const backupAgeMs = Math.max(0, nowMs - snapshotRequestedAtMs);
  if (backupAgeMs > config.timeoutMs + MAX_FUTURE_CLOCK_SKEW_MS) {
    fail("backup_snapshot_stale");
  }
  const integrity = integrityOutput(output.content_integrity);
  const snapshotInventory = snapshotInventoryOutput(output.snapshot_inventory);
  return {
    database_id: output.database_id,
    database_name: output.database_name,
    bookmark: output.bookmark,
    object_key: output.object_key,
    manifest_key: output.manifest_key,
    snapshot_requested_at: output.snapshot_requested_at,
    created_at: output.created_at,
    backup_age_seconds: Math.floor(backupAgeMs / 1000),
    content_integrity: integrity,
    snapshot_inventory: snapshotInventory,
  };
}

function statusFailure(status) {
  if (status === "errored") {
    fail("backup_status_errored");
  }
  if (status === "terminated") {
    fail("backup_status_terminated");
  }
  if (status === "paused") {
    fail("backup_status_paused");
  }
  fail("backup_status_unknown");
}

function remainingMilliseconds(deadline, now) {
  return Math.max(0, Math.floor(deadline - now()));
}

async function runBackupGate(config, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const now = deps.now ?? (() => performance.now());
  const wallNow = deps.wallNow ?? (() => Date.now());
  const startedAt = now();
  const gateStartedAtMs = wallNow();
  if (!Number.isFinite(gateStartedAtMs)) {
    fail("backup_timestamp_invalid");
  }
  const deadline = startedAt + config.timeoutMs;

  const startRemaining = remainingMilliseconds(deadline, now);
  if (startRemaining < 1) {
    fail("backup_gate_timeout");
  }
  const started = await requestJson(
    fetchImpl,
    `${config.baseUrl}/backup/run`,
    config.token,
    {
      method: "POST",
      body: { reason: "pre-migration backup" },
      expectedStatus: 202,
      label: "backup_start",
      requestTimeoutMs: Math.min(DEFAULT_REQUEST_TIMEOUT_MS, startRemaining),
    },
  );
  if (remainingMilliseconds(deadline, now) < 1) {
    fail("backup_gate_timeout");
  }
  const instanceId = parseStarted(started);

  let attempts = 0;
  let delayMs = config.initialDelayMs;
  for (;;) {
    const remaining = remainingMilliseconds(deadline, now);
    if (remaining < 1) {
      fail("backup_gate_timeout");
    }
    const statusBody = await requestJson(
      fetchImpl,
      `${config.baseUrl}/backup/status/${encodeURIComponent(instanceId)}`,
      config.token,
      {
        method: "GET",
        expectedStatus: 200,
        label: "backup_status",
        requestTimeoutMs: Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remaining),
      },
    );
    if (remainingMilliseconds(deadline, now) < 1) {
      fail("backup_gate_timeout");
    }
    attempts += 1;
    const details = parseStatus(statusBody, instanceId);
    if (details.status === "complete") {
      const output = completedOutput(details, config, { gateStartedAtMs, nowMs: wallNow() });
      return {
        ok: true,
        code: "pre_migration_backup_completed",
        instance_id: instanceId,
        status: "complete",
        attempts,
        elapsed_ms: Math.max(0, Math.floor(now() - startedAt)),
        ...output,
      };
    }
    if (!PENDING_STATUSES.has(details.status)) {
      statusFailure(details.status);
    }
    const beforeSleep = remainingMilliseconds(deadline, now);
    if (beforeSleep < 1) {
      fail("backup_gate_timeout");
    }
    await sleep(Math.min(delayMs, beforeSleep));
    delayMs = Math.min(config.maxDelayMs, delayMs * 2);
  }
}

function publicFailure(error) {
  return {
    ok: false,
    code: error instanceof BackupGateError ? error.code : "backup_gate_failed",
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help === true) {
      console.log(usage());
      return;
    }
    const result = await runBackupGate(gateConfig(options));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify(publicFailure(error)));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

export {
  BackupGateError,
  MAX_RESPONSE_BYTES,
  TOKEN_ENV_NAME,
  completedOutput,
  gateConfig,
  parseArgs,
  parseStarted,
  parseStatus,
  publicFailure,
  readBoundedJson,
  runBackupGate,
  usage,
};
