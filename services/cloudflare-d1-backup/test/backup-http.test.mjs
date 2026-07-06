import assert from "node:assert/strict";
import { test } from "node:test";
import { handleBackupRequest } from "../dist/http.js";

async function json(response) {
  return response.json();
}

class MockWorkflow {
  constructor() {
    this.created = [];
    this.instances = new Map();
  }

  async create(options = {}) {
    const id = options.id ?? "manual-test-id";
    const params = options.params ?? {};
    const instance = {
      id,
      params,
      status: async () => ({ state: "running", params }),
    };
    this.created.push({ id, params });
    this.instances.set(id, instance);
    return instance;
  }

  async get(id) {
    const instance = this.instances.get(id);
    if (instance === undefined) {
      throw new Error("not found");
    }
    return instance;
  }
}

function baseEnv(overrides = {}) {
  return {
    ACCOUNT_ID: "account-123",
    DATABASE_ID: "database-456",
    DATABASE_NAME: "licensecc-online-verifier",
    BACKUP_PREFIX: "d1/licensecc",
    BACKUP_RETENTION_DAYS: "30",
    BACKUP_TRIGGER_TOKEN: "trigger-secret",
    D1_BACKUP_WORKFLOW: new MockWorkflow(),
    ...overrides,
  };
}

function request(path, options = {}) {
  return new Request(`https://backup.example${path}`, options);
}

test("backup health reports normalized configuration", async () => {
  const response = await handleBackupRequest(request("/health"), baseEnv());
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    ok: true,
    code: "backup_ready",
    database_name: "licensecc-online-verifier",
    backup_prefix: "d1/licensecc",
    retention_days: 30,
  });
});

test("backup health fails closed when configuration is invalid", async () => {
  const response = await handleBackupRequest(request("/health"), baseEnv({ ACCOUNT_ID: "" }));
  assert.equal(response.status, 500);
  const body = await json(response);
  assert.equal(body.ok, false);
  assert.equal(body.code, "backup_misconfigured");
  assert.match(body.detail, /ACCOUNT_ID_required/);
});

test("manual backup trigger requires configured bearer token", async () => {
  const notConfigured = await handleBackupRequest(request("/backup/run", { method: "POST" }), baseEnv({ BACKUP_TRIGGER_TOKEN: "" }));
  assert.equal(notConfigured.status, 401);
  assert.equal((await json(notConfigured)).code, "backup_trigger_not_configured");

  const invalid = await handleBackupRequest(request("/backup/run", {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
  }), baseEnv());
  assert.equal(invalid.status, 403);
  assert.equal((await json(invalid)).code, "invalid_backup_trigger_token");
});

test("manual backup trigger starts workflow with bounded reason", async () => {
  const env = baseEnv();
  const response = await handleBackupRequest(request("/backup/run", {
    method: "POST",
    headers: {
      authorization: "Bearer trigger-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "x".repeat(300) }),
  }), env);
  assert.equal(response.status, 202);
  const body = await json(response);
  assert.equal(body.code, "backup_started");
  assert.match(body.id, /^manual-/);
  assert.equal(env.D1_BACKUP_WORKFLOW.created.length, 1);
  assert.equal(env.D1_BACKUP_WORKFLOW.created[0].params.trigger, "manual");
  assert.equal(env.D1_BACKUP_WORKFLOW.created[0].params.reason.length, 256);
});

test("manual backup trigger rejects oversized JSON body before workflow creation", async () => {
  const env = baseEnv();
  const response = await handleBackupRequest(request("/backup/run", {
    method: "POST",
    headers: {
      authorization: "Bearer trigger-secret",
      "content-type": "application/json",
      "content-length": "1025",
    },
    body: "{}",
  }), env);
  assert.equal(response.status, 400);
  assert.equal((await json(response)).code, "request_too_large");
  assert.equal(env.D1_BACKUP_WORKFLOW.created.length, 0);
});

test("backup status lookup is authenticated and returns workflow state", async () => {
  const workflow = new MockWorkflow();
  await workflow.create({ id: "manual-existing", params: { trigger: "manual", reason: "pre-migration" } });
  const env = baseEnv({ D1_BACKUP_WORKFLOW: workflow });

  const ok = await handleBackupRequest(request("/backup/status/manual-existing", {
    headers: { authorization: "Bearer trigger-secret" },
  }), env);
  assert.equal(ok.status, 200);
  const okBody = await json(ok);
  assert.equal(okBody.code, "backup_status");
  assert.equal(okBody.id, "manual-existing");
  assert.equal(okBody.details.state, "running");

  const missing = await handleBackupRequest(request("/backup/status/missing", {
    headers: { authorization: "Bearer trigger-secret" },
  }), env);
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).code, "backup_instance_not_found");
});
