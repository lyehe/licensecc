import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_RESPONSE_BYTES,
  gateConfig,
  parseArgs,
  publicFailure,
  readBoundedJson,
  runBackupGate,
} from "../scripts/run-and-wait.mjs";

const BASE_URL = "https://backup.example.workers.dev";
const TOKEN = "trigger-token-that-must-never-be-logged";
const DATABASE_ID = "database-456";
const DATABASE_NAME = "licensecc-online-verifier";

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function started(id = "manual-test-instance") {
  return jsonResponse({ ok: true, code: "backup_started", id }, 202);
}

function status(state, output, id = "manual-test-instance") {
  return jsonResponse({
    ok: true,
    code: "backup_status",
    id,
    details: {
      status: state,
      ...(output === undefined ? {} : { output }),
    },
  });
}

function completedBackup(overrides = {}) {
  const objectKey = "d1/licensecc/2026-08-30/bookmark-1/database.sql";
  const timestamp = new Date().toISOString();
  const digest = "a".repeat(64);
  return {
    database_id: DATABASE_ID,
    database_name: DATABASE_NAME,
    bookmark: "bookmark-1",
    object_key: objectKey,
    manifest_key: `${objectKey}.metadata.json`,
    snapshot_requested_at: timestamp,
    created_at: timestamp,
    content_integrity: {
      algorithm: "sha256",
      digest_hex: digest,
      size_bytes: 1234,
      r2_etag: "opaque-r2-etag",
      r2_version: "opaque-r2-version",
      r2_size_bytes: 1234,
      r2_sha256_hex: digest,
    },
    snapshot_inventory: {
      algorithm: "d1-export-sql-insert-count-v1",
      table_counts: {
        entitlements: 2,
        entitlement_events: 5,
      },
    },
    ...overrides,
  };
}

function redactedCompletion(output) {
  return {
    database_id: output.database_id,
    database_name: output.database_name,
    bookmark: output.bookmark,
    object_key: output.object_key,
    manifest_key: output.manifest_key,
    snapshot_requested_at: output.snapshot_requested_at,
    created_at: output.created_at,
    backup_age_seconds: 0,
    content_integrity: {
      algorithm: "sha256",
      size_bytes: output.content_integrity.size_bytes,
      r2_object_metadata_bound: true,
      r2_sha256_reported: true,
    },
    snapshot_inventory: {
      algorithm: "d1-export-sql-insert-count-v1",
      counted_table_count: 2,
    },
  };
}

function config(overrides = {}) {
  return {
    baseUrl: BASE_URL,
    token: TOKEN,
    databaseId: DATABASE_ID,
    databaseName: DATABASE_NAME,
    timeoutMs: 10_000,
    initialDelayMs: 100,
    maxDelayMs: 400,
    ...overrides,
  };
}

function sequenceFetch(responses, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected request containing ${url} and ${TOKEN}`);
    }
    return typeof next === "function" ? next(url, init) : next;
  };
}

function fakeClock() {
  let time = 0;
  const delays = [];
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
      time += milliseconds;
    },
    delays,
  };
}

async function rejectionCode(action) {
  try {
    await action();
  } catch (error) {
    return publicFailure(error).code;
  }
  assert.fail("expected action to reject");
}

test("gate configuration accepts the trigger token only from the environment", () => {
  const options = parseArgs([
    "--url", BASE_URL,
    "--database-id", DATABASE_ID,
    "--database-name", DATABASE_NAME,
    "--timeout-seconds", "60",
  ]);
  const parsed = gateConfig(options, { BACKUP_TRIGGER_TOKEN: TOKEN });

  assert.equal(parsed.baseUrl, BASE_URL);
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.timeoutMs, 60_000);
  assert.throws(() => parseArgs(["--token", TOKEN]), /unknown_argument/);
  assert.throws(() => gateConfig(options, {}), /backup_trigger_token_required/);
});

test("run-and-wait gate succeeds only with complete output and matching identity", async () => {
  const calls = [];
  const clock = fakeClock();
  const completion = completedBackup();
  const result = await runBackupGate(config(), {
    fetch: sequenceFetch([started(), status("complete", completion)], calls),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, {
    ok: true,
    code: "pre_migration_backup_completed",
    instance_id: "manual-test-instance",
    status: "complete",
    attempts: 1,
    elapsed_ms: 0,
    ...redactedCompletion(completion),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.body, JSON.stringify({ reason: "pre-migration backup" }));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(BASE_URL));
  assert.ok(!JSON.stringify(result).includes(completion.content_integrity.digest_hex));
  assert.ok(!JSON.stringify(result).includes(completion.content_integrity.r2_etag));
  assert.ok(!JSON.stringify(result).includes(completion.content_integrity.r2_version));
});

test("run-and-wait gate follows pending states with bounded exponential backoff", async () => {
  const clock = fakeClock();
  const result = await runBackupGate(config(), {
    fetch: sequenceFetch([
      started(),
      status("queued"),
      status("running"),
      status("waiting"),
      status("waitingForPause"),
      status("complete", completedBackup()),
    ]),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.attempts, 5);
  assert.deepEqual(clock.delays, [100, 200, 400, 400]);
  assert.equal(result.elapsed_ms, 1100);
});

test("run-and-wait gate fails closed for errored, terminated, paused, and unknown states", async () => {
  const expectations = new Map([
    ["errored", "backup_status_errored"],
    ["terminated", "backup_status_terminated"],
    ["paused", "backup_status_paused"],
    ["unknown", "backup_status_unknown"],
    ["rollingBack", "backup_status_unknown"],
  ]);
  for (const [state, expectedCode] of expectations) {
    const code = await rejectionCode(() => runBackupGate(config(), {
      fetch: sequenceFetch([
        started(),
        status(state, { error: `contains ${TOKEN} ${BASE_URL}` }),
      ]),
    }));
    assert.equal(code, expectedCode, state);
  }
});

test("run-and-wait gate times out after bounded polling", async () => {
  const clock = fakeClock();
  let requests = 0;
  const code = await rejectionCode(() => runBackupGate(config({
    timeoutMs: 1000,
    initialDelayMs: 250,
    maxDelayMs: 500,
  }), {
    fetch: async () => {
      requests += 1;
      return requests === 1 ? started() : status("running");
    },
    now: clock.now,
    sleep: clock.sleep,
  }));

  assert.equal(code, "backup_gate_timeout");
  assert.equal(requests, 4);
  assert.deepEqual(clock.delays, [250, 500, 250]);
});

test("run-and-wait gate cannot accept completion after the overall deadline", async () => {
  let time = 0;
  let requests = 0;
  const code = await rejectionCode(() => runBackupGate(config({ timeoutMs: 1000 }), {
    fetch: async () => {
      requests += 1;
      if (requests === 1) {
        return started();
      }
      time = 1001;
      return status("complete", completedBackup());
    },
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
    },
  }));

  assert.equal(code, "backup_gate_timeout");
  assert.equal(requests, 2);
});

test("run-and-wait gate rejects malformed and oversized responses", async () => {
  const malformedCode = await rejectionCode(() => runBackupGate(config(), {
    fetch: sequenceFetch([
      new Response("not-json", { status: 202, headers: { "content-type": "application/json" } }),
    ]),
  }));
  assert.equal(malformedCode, "backup_start_invalid_json");

  const oversizedDeclaredCode = await rejectionCode(() => runBackupGate(config(), {
    fetch: sequenceFetch([
      new Response("{}", {
        status: 202,
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_RESPONSE_BYTES + 1),
        },
      }),
    ]),
  }));
  assert.equal(oversizedDeclaredCode, "backup_start_response_too_large");

  const oversizedBody = jsonResponse({ value: "x".repeat(MAX_RESPONSE_BYTES) }, 202);
  const oversizedStreamCode = await rejectionCode(() => readBoundedJson(oversizedBody, "test"));
  assert.equal(oversizedStreamCode, "test_response_too_large");
});

test("run-and-wait gate rejects start and status redirects without following them", async () => {
  const redirect = () => new Response(null, {
    status: 302,
    headers: { location: `https://redirect.example/?token=${TOKEN}` },
  });
  const startCode = await rejectionCode(() => runBackupGate(config(), {
    fetch: sequenceFetch([redirect()]),
  }));
  assert.equal(startCode, "backup_start_redirect");

  const statusCode = await rejectionCode(() => runBackupGate(config(), {
    fetch: sequenceFetch([started(), redirect()]),
  }));
  assert.equal(statusCode, "backup_status_redirect");
});

test("completion validation rejects mismatched identity, timestamps, RPO, and integrity metadata", async () => {
  const validIntegrity = completedBackup().content_integrity;
  const validSnapshotInventory = completedBackup().snapshot_inventory;
  const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const cases = [
    [completedBackup({ database_id: "other-database" }), "backup_database_identity_mismatch"],
    [completedBackup({ bookmark: "" }), "backup_bookmark_invalid"],
    [completedBackup({ object_key: "https://secret.example/dump.sql" }), "backup_object_identity_invalid"],
    [completedBackup({ manifest_key: "d1/licensecc/wrong.metadata.json" }), "backup_object_identity_invalid"],
    [completedBackup({ snapshot_requested_at: undefined }), "backup_timestamp_invalid"],
    [completedBackup({ created_at: "not-a-time" }), "backup_timestamp_invalid"],
    [completedBackup({ snapshot_requested_at: staleTimestamp }), "backup_snapshot_stale"],
    [completedBackup({ content_integrity: undefined }), "backup_integrity_invalid"],
    [completedBackup({ content_integrity: { ...validIntegrity, algorithm: "md5" } }), "backup_integrity_invalid"],
    [completedBackup({ content_integrity: { ...validIntegrity, digest_hex: "a".repeat(63) } }), "backup_integrity_invalid"],
    [completedBackup({ content_integrity: { ...validIntegrity, size_bytes: 0 } }), "backup_integrity_invalid"],
    [completedBackup({ content_integrity: { ...validIntegrity, r2_size_bytes: 99 } }), "backup_integrity_invalid"],
    [completedBackup({ content_integrity: { ...validIntegrity, r2_version: "" } }), "backup_integrity_invalid"],
    [completedBackup({ content_integrity: { ...validIntegrity, r2_sha256_hex: "b".repeat(64) } }), "backup_integrity_invalid"],
    [completedBackup({ snapshot_inventory: undefined }), "backup_snapshot_inventory_invalid"],
    [completedBackup({ snapshot_inventory: { ...validSnapshotInventory, algorithm: "other" } }), "backup_snapshot_inventory_invalid"],
    [completedBackup({ snapshot_inventory: { algorithm: "d1-export-sql-insert-count-v1", table_counts: {} } }), "backup_snapshot_inventory_invalid"],
    [completedBackup({ snapshot_inventory: { algorithm: "d1-export-sql-insert-count-v1", table_counts: { entitlements: -1 } } }), "backup_snapshot_inventory_invalid"],
  ];
  for (const [output, expectedCode] of cases) {
    const code = await rejectionCode(() => runBackupGate(config(), {
      fetch: sequenceFetch([started(), status("complete", output)]),
    }));
    assert.equal(code, expectedCode);
  }
});

test("public failure JSON never exposes response errors, tokens, or URLs", async () => {
  const sensitiveError = new Error(`request failed for ${BASE_URL} using ${TOKEN}`);
  const unknown = JSON.stringify(publicFailure(sensitiveError));
  assert.equal(unknown, JSON.stringify({ ok: false, code: "backup_gate_failed" }));
  assert.ok(!unknown.includes(TOKEN));
  assert.ok(!unknown.includes(BASE_URL));

  const remoteFailure = await rejectionCode(() => runBackupGate(config(), {
    fetch: async () => {
      throw sensitiveError;
    },
  }));
  const serialized = JSON.stringify({ ok: false, code: remoteFailure });
  assert.equal(remoteFailure, "backup_start_request_failed");
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes(BASE_URL));
});
