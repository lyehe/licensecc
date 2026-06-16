import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/remote-d1-atomicity.mjs [--config ../cloudflare-licensing-backend/wrangler.toml] [--worker-name licensecc-d1-atomicity-<suffix>] [--keep-worker]

Deploys a temporary Worker bound to the configured remote D1 database, forces a
failed entitlement+audit D1 batch(), verifies no entitlement or event row
persisted, and deletes the temporary Worker.`);
  process.exit(exitCode);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function positionalArgs() {
  const result = [];
  for (let index = 2; index < process.argv.length; ++index) {
    const arg = process.argv[index];
    if (arg.startsWith("--")) {
      if (arg !== "--keep-worker" && arg !== "--help" && arg !== "-h") {
        ++index;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}

function parseD1Binding(configPath) {
  const content = readFileSync(configPath, "utf8");
  const databaseNameMatch = /database_name\s*[:=]\s*["']([^"']+)["']/.exec(content);
  const databaseIdMatch = /database_id\s*[:=]\s*["']([^"']+)["']/.exec(content);
  if (databaseNameMatch === null || databaseIdMatch === null) {
    throw new Error(`could not find database_name and database_id in ${configPath}`);
  }
  return {
    databaseName: databaseNameMatch[1],
    databaseId: databaseIdMatch[1],
  };
}

function runWrangler(args, cwd, label) {
  const require = createRequire(import.meta.url);
  const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invokeValidation(url, token, fingerprint) {
  let last = null;
  for (let attempt = 1; attempt <= 8; ++attempt) {
    const response = await fetch(`${url}/validate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fingerprint }),
    });
    const text = await response.text();
    try {
      return {
        status: response.status,
        ok: response.ok,
        body: JSON.parse(text),
      };
    } catch {
      last = {
        status: response.status,
        text: text.slice(0, 200),
      };
      if (attempt < 8) {
        await sleep(2000);
      }
    }
  }
  throw new Error(`temporary Worker did not return JSON: ${JSON.stringify(last)}`);
}

function workerSource() {
  return `
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearerToken(request) {
  const header = request.headers.get("authorization");
  const match = header === null ? null : /^Bearer\\s+(.+)$/i.exec(header);
  return match === null ? null : match[1];
}

async function firstNumber(statement, key) {
  const row = await statement.first();
  return row === null ? 0 : Number(row[key] ?? 0);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/validate") {
      return json({ ok: false, code: "not_found" }, 404);
    }
    if (bearerToken(request) !== env.VALIDATION_BEARER) {
      return json({ ok: false, code: "invalid_validation_token" }, 403);
    }
    const body = await request.json();
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      return json({ ok: false, code: "invalid_fingerprint" }, 400);
    }

    const project = "D1_ATOMICITY";
    const feature = "BATCH";
    const cleanupEntitlements = env.DB.prepare(
      "DELETE FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?",
    ).bind(project, feature, fingerprint);
    const cleanupEvents = env.DB.prepare(
      "DELETE FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?",
    ).bind(project, feature, fingerprint);
    await cleanupEvents.run();
    await cleanupEntitlements.run();

    const entitlementWrite = env.DB.prepare(
      "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at) VALUES (?, ?, ?, '', 'active', 60, 60, 1, NULL, NULL, 'remote d1 batch atomicity probe', 'atomicity', 'atomicity', unixepoch(), unixepoch())",
    ).bind(project, feature, fingerprint);
    const failingAuditWrite = env.DB.prepare(
      "INSERT INTO entitlement_events (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json, next_json, reason, idempotency_key, created_at) VALUES (?, ?, ?, '', 'invalid_event_type_for_atomicity_probe', 'active', 1, 'probe', 'remote-d1-atomicity', 'system', 'system', 'probe', '', '', '', 'probe', NULL, unixepoch())",
    ).bind(project, feature, fingerprint);

    let batchFailed = false;
    let failureDetail = "";
    try {
      await env.DB.batch([entitlementWrite, failingAuditWrite]);
    } catch (error) {
      batchFailed = true;
      failureDetail = error instanceof Error ? error.message : String(error);
    }

    const entitlementCountBeforeCleanup = await firstNumber(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?",
    ).bind(project, feature, fingerprint), "count");
    const eventCountBeforeCleanup = await firstNumber(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?",
    ).bind(project, feature, fingerprint), "count");

    await cleanupEvents.run();
    await cleanupEntitlements.run();

    const entitlementCountAfterCleanup = await firstNumber(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?",
    ).bind(project, feature, fingerprint), "count");
    const eventCountAfterCleanup = await firstNumber(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?",
    ).bind(project, feature, fingerprint), "count");

    const rolledBack = batchFailed && entitlementCountBeforeCleanup === 0 && eventCountBeforeCleanup === 0;
    return json({
      ok: rolledBack,
      code: rolledBack ? "d1_batch_atomic" : "d1_batch_not_atomic",
      batch_failed: batchFailed,
      failure_detail: failureDetail,
      entitlement_count_before_cleanup: entitlementCountBeforeCleanup,
      event_count_before_cleanup: eventCountBeforeCleanup,
      entitlement_count_after_cleanup: entitlementCountAfterCleanup,
      event_count_after_cleanup: eventCountAfterCleanup,
    }, rolledBack ? 200 : 500);
  },
};
`;
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage(0);
  }
  const configPath = resolve(argValue("--config") ?? positionalArgs()[0] ?? "../cloudflare-licensing-backend/wrangler.toml");
  const keepWorker = hasFlag("--keep-worker");
  const workerName = argValue("--worker-name") ?? `licensecc-d1-atomicity-${randomUUID().slice(0, 8)}`;
  const token = `validate-${randomBytes(32).toString("hex")}`;
  const fingerprint = randomBytes(32).toString("hex");
  const binding = parseD1Binding(configPath);
  const tempDir = mkdtempSync(join(tmpdir(), "licensecc-d1-atomicity-"));
  let deployed = false;

  try {
    writeFileSync(join(tempDir, "worker.mjs"), workerSource());
    writeFileSync(join(tempDir, "wrangler.jsonc"), JSON.stringify({
      name: workerName,
      main: "worker.mjs",
      compatibility_date: "2026-06-05",
      workers_dev: true,
      preview_urls: false,
      observability: {
        enabled: true,
        head_sampling_rate: 1,
      },
      vars: {
        VALIDATION_BEARER: token,
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: binding.databaseName,
          database_id: binding.databaseId,
        },
      ],
    }, null, 2));

    const deployOutput = runWrangler(["deploy", "--config", "wrangler.jsonc"], tempDir, "temporary Worker deploy");
    deployed = true;
    const urlMatches = [...deployOutput.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map((match) => match[0]);
    if (urlMatches.length === 0) {
      throw new Error(`could not find workers.dev URL in deploy output\n${deployOutput}`);
    }
    const url = urlMatches[urlMatches.length - 1];
    const validation = await invokeValidation(url, token, fingerprint);
    const result = validation.body;
    const summary = {
      ok: validation.ok && result.ok === true,
      worker_name: workerName,
      worker_url: url,
      database_name: binding.databaseName,
      database_id: binding.databaseId,
      fingerprint,
      status: validation.status,
      result,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (deployed && !keepWorker) {
      try {
        runWrangler(["delete", workerName, "--config", "wrangler.jsonc", "--force"], tempDir, "temporary Worker delete");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
    if (!keepWorker) {
      rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.error(`kept temporary Worker files in ${tempDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
