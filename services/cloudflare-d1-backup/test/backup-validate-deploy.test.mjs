import assert from "node:assert/strict";
import test from "node:test";
import {
  isHealthReady,
  isManualTriggerFailClosed,
  parseArgs,
  parseSecretList,
  secretPresence,
  validateDeployment,
} from "../scripts/validate-deploy.mjs";

test("deploy validator parses required arguments and defaults workflow name", () => {
  const options = parseArgs([
    "--url",
    "https://backup.example.workers.dev/",
    "--worker-name",
    "licensecc-d1-backup",
    "--require-d1-rest-token",
  ], {});
  assert.equal(options.url, "https://backup.example.workers.dev");
  assert.equal(options.workerName, "licensecc-d1-backup");
  assert.equal(options.workflowName, "licensecc-d1-backup");
  assert.equal(options.requireD1RestToken, true);
});

test("deploy validator tolerates npm positional/config argument forwarding", () => {
  const options = parseArgs([
    "https://backup.example.workers.dev",
    "licensecc-d1-backup",
    "licensecc-d1-backup-workflow",
  ], {
    npm_config_json: "true",
    npm_config_require_d1_rest_token: "true",
  });
  assert.equal(options.url, "https://backup.example.workers.dev");
  assert.equal(options.workerName, "licensecc-d1-backup");
  assert.equal(options.workflowName, "licensecc-d1-backup-workflow");
  assert.equal(options.json, true);
  assert.equal(options.requireD1RestToken, true);
});

test("deploy validator ignores boolean npm config placeholders for valued options", () => {
  const options = parseArgs([
    "https://backup.example.workers.dev",
    "licensecc-d1-backup",
  ], {
    npm_config_url: "true",
    npm_config_worker_name: "true",
    npm_config_json: "true",
  });
  assert.equal(options.url, "https://backup.example.workers.dev");
  assert.equal(options.workerName, "licensecc-d1-backup");
  assert.equal(options.workflowName, "licensecc-d1-backup");
  assert.equal(options.json, true);
});

test("deploy validator secret parsing reports names only", () => {
  const names = parseSecretList(JSON.stringify([
    { name: "D1_REST_API_TOKEN", type: "secret_text" },
    { name: "BACKUP_TRIGGER_TOKEN", type: "secret_text" },
  ]));
  assert.deepEqual(names, ["D1_REST_API_TOKEN", "BACKUP_TRIGGER_TOKEN"]);
  assert.deepEqual(secretPresence(names), {
    D1_REST_API_TOKEN: true,
    BACKUP_TRIGGER_TOKEN: true,
  });
});

test("deploy validator recognizes ready health and fail-closed manual trigger", () => {
  assert.equal(isHealthReady({ status: 200, body: { ok: true, code: "backup_ready" } }), true);
  assert.equal(isHealthReady({ status: 500, body: { ok: false, code: "backup_misconfigured" } }), false);
  assert.equal(isManualTriggerFailClosed({ status: 401, body: { code: "backup_trigger_not_configured" } }), true);
  assert.equal(isManualTriggerFailClosed({ status: 403, body: { code: "invalid_backup_trigger_token" } }), true);
  assert.equal(isManualTriggerFailClosed({ status: 202, body: { code: "backup_started" } }), false);
});

test("deploy validator succeeds without requiring absent optional secrets", async () => {
  const calls = [];
  const result = await validateDeployment({
    url: "https://backup.example.workers.dev",
    workerName: "licensecc-d1-backup",
    workflowName: "licensecc-d1-backup",
  }, {
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({
          ok: true,
          code: "backup_ready",
          database_name: "licensecc-online-verifier-test",
          backup_prefix: "d1/licensecc-online-verifier-test",
          retention_days: 90,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, code: "backup_trigger_not_configured" }), { status: 401 });
    },
    runCommand: async (_command, args) => {
      if (args.includes("secret")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      return { status: 0, stdout: "Name: licensecc-d1-backup", stderr: "" };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.secrets, {
    D1_REST_API_TOKEN: false,
    BACKUP_TRIGGER_TOKEN: false,
  });
  assert.equal(calls.length, 2);
});

test("deploy validator fails when required D1 token is absent", async () => {
  const result = await validateDeployment({
    url: "https://backup.example.workers.dev",
    workerName: "licensecc-d1-backup",
    workflowName: "licensecc-d1-backup",
    requireD1RestToken: true,
  }, {
    fetch: async (url) => {
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, code: "backup_ready" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, code: "backup_trigger_not_configured" }), { status: 401 });
    },
    runCommand: async (_command, args) => {
      if (args.includes("secret")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      return { status: 0, stdout: "Name: licensecc-d1-backup", stderr: "" };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.blocking.join("\n"), /D1_REST_API_TOKEN/);
});
