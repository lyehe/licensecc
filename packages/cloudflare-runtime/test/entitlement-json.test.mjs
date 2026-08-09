import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  D1_SQLITE_MAX_FUNCTION_ARGS,
  assertD1JsonFunctionArity,
  d1JsonFunctionArgumentCounts,
  entitlementCurrentJsonSql,
} from "../src/d1/entitlement_json.mjs";
import {
  entitlementId,
  eventFromCurrentStatement,
  idempotencyFromCurrentStatement,
} from "../src/d1/entitlement_mutation.mjs";
import { applyPlanProjection } from "../src/d1/plan_projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const backendRoot = join(repoRoot, "services", "cloudflare-licensing-backend");

class CapturedStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    const bound = new CapturedStatement(this.db, this.sql, params);
    this.db.bound.push(bound);
    return bound;
  }

  async first() {
    return this.db.first(this);
  }

  async all() {
    return { results: [] };
  }

  async run() {
    return { success: true };
  }
}

class CapturingD1 {
  constructor({ storedPreview = null, appliedResponse = null } = {}) {
    this.storedPreview = storedPreview;
    this.appliedResponse = appliedResponse;
    this.bound = [];
    this.batches = [];
  }

  prepare(sql) {
    return new CapturedStatement(this, sql);
  }

  async first(statement) {
    if (statement.sql.includes("SELECT projection_json, actions_json FROM license_plan_projection_previews")) {
      return this.storedPreview;
    }
    return null;
  }

  async batch(statements) {
    this.batches.push(statements);
    return statements.map((_, index) => {
      if (index === 0) return { results: [{ id: "claimed" }] };
      if (index === statements.length - 1) return { results: [{ applied_response_json: this.appliedResponse }] };
      return { results: [] };
    });
  }
}

function projectionProbe() {
  const fingerprint = "a".repeat(64);
  const previewId = "ppv_probe_1";
  const claimToken = "claim-probe";
  const now = 1_900_000_000;
  const assignment = {
    project: "DEFAULT",
    license_id: "lic_probe",
    license_fingerprint: fingerprint,
    customer_id: null,
    plan_id: "plan_probe",
    plan_key: "probe",
    support_until: null,
    addons: [],
  };
  const desired = {
    input: {
      project: "DEFAULT",
      feature: "core",
      license_fingerprint: fingerprint,
      device_hash: "",
      status: "active",
      assertion_ttl_seconds: 600,
      valid_from: null,
      valid_until: null,
      notes: "probe",
      customer_id: null,
      license_id: "lic_probe",
    },
    policy_id: "pol_probe",
    capacity: { pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, meter_quota: 0, meter_period_sec: 2592000 },
    trial: { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0, trial_require_device_proof: 0 },
    source: "included",
    addon_key: null,
    feature_name: "Core",
  };
  const action = { id: entitlementId("DEFAULT", "core", fingerprint), desired };
  const projection = {
    plan: { id: "plan_probe", project: "DEFAULT", plan_key: "probe", name: "Probe", status: "active", version: 1 },
    assignment,
    desired: [{
      project: "DEFAULT", feature: "core", license_fingerprint: fingerprint, policy_id: "pol_probe", source: "included", addon_key: null,
      license_mode: "node_locked", status: "active", valid_from: null, valid_until: null, assertion_ttl_seconds: 600,
      pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, meter_quota: 0, meter_period_sec: 2592000,
    }],
    will_create: [], will_update: [], will_disable: [], blocked: [], unchanged: [],
    summary: { create: 1, update: 0, disable: 0, blocked: 0, unchanged: 0 },
    preview_id: previewId, effective_at: now, expires_at: now + 300, source_generation: 1,
  };
  const actions = { created: [action], updated: [], disabled: [], assignment, assignment_snapshot: null };
  const entitlement = {
    project: "DEFAULT", feature: "core", license_fingerprint: fingerprint, device_hash: "", status: "active",
    assertion_ttl_seconds: 600, cache_ttl_seconds: 600, revocation_seq: 1, valid_from: null, valid_until: null,
    notes: "probe", customer_id: null, license_id: "lic_probe", policy_id: "pol_probe", is_trial: 0,
    trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0, trial_require_device_proof: 0,
    trial_started_at: null, trial_device_hash: null, max_active_devices: 1, lease_seconds: 0, rebind_window_sec: 0,
    pool_size: 0, heartbeat_grace_sec: 300, max_borrow_sec: 0, allow_overdraft: 0, meter_quota: 0,
    meter_period_sec: 2592000, created_at: now, updated_at: now,
  };
  const previewRow = {
    id: previewId, actor_subject: "admin", source_generation: 1, normalized_input_json: "{}",
    projection_json: JSON.stringify(projection), actions_json: JSON.stringify(actions), effective_at: now,
    expires_at: now + 300, claim_token: claimToken, claimed_at: now, consumed_at: null,
    applied_response_json: null, created_at: now,
  };
  const assignmentRow = {
    license_id: "lic_probe", project: "DEFAULT", plan_id: "plan_probe", license_fingerprint: fingerprint,
    customer_id: null, status: "active", support_until: null, addons_json: "[]", created_at: now, updated_at: now,
  };
  const catalogPlan = {
    id: "plan_probe", project: "DEFAULT", plan_key: "probe", name: "Probe", status: "active",
    version: 1, description: "", created_at: now, updated_at: now,
  };
  return { fingerprint, previewId, claimToken, now, desired, action, projection, actions, entitlement, previewRow, assignmentRow, catalogPlan };
}

async function generatedStatements() {
  const probe = projectionProbe();
  const appliedResponse = JSON.stringify({ ok: true, code: "license_plan_projection_applied", request_id: "req-probe", data: {} });
  const planDb = new CapturingD1({
    storedPreview: { projection_json: JSON.stringify(probe.projection), actions_json: JSON.stringify(probe.actions) },
    appliedResponse,
  });
  await applyPlanProjection(
    { DB: planDb },
    probe.previewId,
    {
      actor: { subject: "admin", email: "admin@example.test", role: "admin", actorType: "access" },
      requestId: "req-probe",
      ip: "",
      idempotencyKey: "probe-key",
      source: "admin",
    },
    { scope: "POST:/api/admin/license-plans/apply:admin", responseCode: "license_plan_projection_applied" },
    probe.now,
  );
  const planBatch = planDb.batches.at(-1);
  probe.claimToken = planBatch[0].params[0];
  probe.previewRow.claim_token = probe.claimToken;
  const planAudit = planBatch.find((statement) => statement.sql.startsWith("INSERT INTO entitlement_events"));
  const planResponse = planBatch.find((statement) => statement.sql.includes("SET applied_response_json"));
  assert.ok(planAudit, "plan-projection must generate an entitlement audit statement");
  assert.ok(planResponse, "plan-projection must generate an applied-response statement");

  const mutationDb = new CapturingD1();
  const mutationCtx = {
    actor: { subject: "admin", email: "admin@example.test", role: "admin", actorType: "access" },
    requestId: "req-mutation",
    ip: "",
    idempotencyKey: "mutation-key",
    source: "admin",
  };
  const key = { project: "DEFAULT", feature: "core", license_fingerprint: probe.fingerprint };
  const mutationAudit = eventFromCurrentStatement({ DB: mutationDb }, mutationCtx, "update", key, null, "probe", probe.now);
  const mutationIdempotency = idempotencyFromCurrentStatement(
    { DB: mutationDb },
    mutationCtx,
    key,
    { scope: "PATCH:/api/admin/entitlements/probe", responseCode: "entitlement_updated" },
    probe.now,
  );
  assert.ok(mutationIdempotency, "entitlement mutation must generate its idempotency response statement");
  return { probe, planAudit, planResponse, mutationAudit, mutationIdempotency };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function literalizeBoundSql(sql, params) {
  let cursor = 0;
  let output = "";
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote !== null) {
      output += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          output += sql[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
    } else if (char === "?") {
      assert.ok(cursor < params.length, "every SQL placeholder needs a bound value");
      output += sqlLiteral(params[cursor]);
      cursor += 1;
    } else {
      output += char;
    }
  }
  assert.equal(cursor, params.length, "every bound value must be represented in the exact SQL probe");
  return output;
}

function insertSql(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => sqlLiteral(row[column])).join(", ")});`;
}

const PYTHON_FUNCTION_LIMIT_PROBE = String.raw`
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
connection = sqlite3.connect(":memory:")
connection.setlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG, 32)
if connection.getlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG) != 32:
    raise RuntimeError("failed to lower SQLITE_LIMIT_FUNCTION_ARG to 32")
connection.executescript("""
CREATE TABLE entitlements (
  project TEXT, feature TEXT, license_fingerprint TEXT, device_hash TEXT, status TEXT,
  assertion_ttl_seconds INTEGER, cache_ttl_seconds INTEGER, revocation_seq INTEGER,
  valid_from INTEGER, valid_until INTEGER, notes TEXT, customer_id TEXT, license_id TEXT,
  policy_id TEXT, is_trial INTEGER, trial_expiration_basis TEXT, trial_duration_sec INTEGER,
  trial_one_per_device INTEGER, trial_require_device_proof INTEGER, trial_started_at INTEGER,
  trial_device_hash TEXT, max_active_devices INTEGER, lease_seconds INTEGER,
  rebind_window_sec INTEGER, pool_size INTEGER, heartbeat_grace_sec INTEGER,
  max_borrow_sec INTEGER, allow_overdraft INTEGER, meter_quota INTEGER,
  meter_period_sec INTEGER, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE entitlement_events (
  project TEXT, feature TEXT, license_fingerprint TEXT, device_hash TEXT, event_type TEXT,
  status TEXT, revocation_seq INTEGER, detail TEXT, actor TEXT, actor_type TEXT, source TEXT,
  request_id TEXT, ip TEXT, prev_json TEXT, next_json TEXT, reason TEXT,
  idempotency_key TEXT, created_at INTEGER
);
CREATE TABLE mutation_idempotency (
  scope TEXT, idempotency_key TEXT, response_json TEXT, created_at INTEGER
);
CREATE TABLE license_plan_projection_previews (
  id TEXT, actor_subject TEXT, source_generation INTEGER, normalized_input_json TEXT,
  projection_json TEXT, actions_json TEXT, effective_at INTEGER, expires_at INTEGER,
  claim_token TEXT, claimed_at INTEGER, consumed_at INTEGER, applied_response_json TEXT,
  created_at INTEGER
);
CREATE TABLE license_plan_assignments (
  license_id TEXT, project TEXT, plan_id TEXT, license_fingerprint TEXT,
  customer_id TEXT, status TEXT, support_until INTEGER, addons_json TEXT,
  created_at INTEGER, updated_at INTEGER
);
""")

for table, row in (("entitlements", payload["entitlement"]), ("license_plan_projection_previews", payload["preview"]), ("license_plan_assignments", payload["assignment"])):
    columns = list(row.keys())
    connection.execute(
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        [row[column] for column in columns],
    )

for name in ("plan_audit", "plan_response", "mutation_audit", "mutation_idempotency"):
    statement = payload["statements"][name]
    connection.execute(statement["sql"], statement["params"])

response = connection.execute("SELECT applied_response_json FROM license_plan_projection_previews").fetchone()[0]
if json.loads(response).get("code") != "license_plan_projection_applied":
    raise RuntimeError("exact plan response statement did not produce the applied envelope")
if connection.execute("SELECT COUNT(*) FROM entitlement_events").fetchone()[0] != 2:
    raise RuntimeError("exact plan and entitlement-mutation audit statements did not both execute")
if connection.execute("SELECT COUNT(*) FROM mutation_idempotency").fetchone()[0] != 1:
    raise RuntimeError("exact entitlement-mutation idempotency statement did not execute")
print("sqlite_function_arg_32_exact_sql_green")
`;

function runPythonFunctionLimitProbe(payload) {
  const result = spawnSync("python", ["-c", PYTHON_FUNCTION_LIMIT_PROBE], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /sqlite_function_arg_32_exact_sql_green/);
}

function runWranglerLocalD1Probe(payload) {
  const temp = mkdtempSync(join(tmpdir(), "licensecc-d1-json-"));
  const wrangler = join(backendRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const config = join(backendRoot, "wrangler.example.toml");
  const schema = join(backendRoot, "schema.sql");
  const probeSql = join(temp, "exact-generated-json.sql");
  try {
    writeFileSync(probeSql, [
      "PRAGMA foreign_keys = OFF;",
      insertSql("catalog_plans", payload.catalog_plan),
      insertSql("entitlements", payload.entitlement),
      insertSql("license_plan_projection_previews", payload.preview),
      insertSql("license_plan_assignments", payload.assignment),
      literalizeBoundSql(payload.statements.plan_audit.sql, payload.statements.plan_audit.params) + ";",
      literalizeBoundSql(payload.statements.plan_response.sql, payload.statements.plan_response.params) + ";",
      literalizeBoundSql(payload.statements.mutation_audit.sql, payload.statements.mutation_audit.params) + ";",
      literalizeBoundSql(payload.statements.mutation_idempotency.sql, payload.statements.mutation_idempotency.params) + ";",
      "SELECT COUNT(*) AS audit_count FROM entitlement_events;",
      "SELECT applied_response_json FROM license_plan_projection_previews;",
    ].join("\n"), "utf8");
    for (const file of [schema, probeSql]) {
      const result = spawnSync(process.execPath, [wrangler, "d1", "execute", "DB", "--config", config, "--local", "--persist-to", temp, "--file", file, "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /"success":\s*true/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("D1-safe entitlement JSON keeps every generated audit/response function at or below 32 arguments", async () => {
  const generated = await generatedStatements();
  const sqlStatements = [
    entitlementCurrentJsonSql("e", "?"),
    entitlementCurrentJsonSql("", "?", { includeCacheTtl: true }),
    generated.planAudit.sql,
    generated.planResponse.sql,
    generated.mutationAudit.sql,
    generated.mutationIdempotency.sql,
  ];
  for (const sql of sqlStatements) {
    assert.doesNotThrow(() => assertD1JsonFunctionArity(sql));
    assert.doesNotMatch(sql, /json_patch/i, "json_patch deletes explicit null fields and is forbidden here");
  }
  const counts = sqlStatements.flatMap((sql) => d1JsonFunctionArgumentCounts(sql));
  assert.ok(counts.length > 0);
  assert.ok(counts.every(({ argumentCount }) => argumentCount <= D1_SQLITE_MAX_FUNCTION_ARGS), JSON.stringify(counts));
});

test("exact generated plan and entitlement-mutation audit/response SQL executes under a 32-argument SQLite engine limit", async () => {
  const generated = await generatedStatements();
  const statement = ({ sql, params }) => ({ sql, params });
  const payload = {
    entitlement: generated.probe.entitlement,
    preview: generated.probe.previewRow,
    assignment: generated.probe.assignmentRow,
    catalog_plan: generated.probe.catalogPlan,
    statements: {
      plan_audit: statement(generated.planAudit),
      plan_response: statement(generated.planResponse),
      mutation_audit: statement(generated.mutationAudit),
      mutation_idempotency: statement(generated.mutationIdempotency),
    },
  };
  runPythonFunctionLimitProbe(payload);
  // Wrangler's local D1 runner is a functional compatibility execution gate.
  // It does not enforce Cloudflare production's 32-argument cap itself; the
  // Python setlimit probe above is the authoritative cap regression guard.
  runWranglerLocalD1Probe(payload);
});
