import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

function usage(exitCode = 2) {
  console.error(`usage:
  node scripts/remote-cpp-verify.mjs [--config wrangler.toml] [--build-dir ../../build] [--ctest-config Debug] [--worker-name licensecc-online-cpp-<suffix>] [--keep-worker]

Deploys a temporary verifier Worker with a generated online signing key, creates
a scratch entitlement in the configured remote D1 database, obtains a real
Worker-signed assertion, verifies it with the C++ online verifier test, revokes
the scratch entitlement, and deletes the temporary Worker.`);
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

function runCommand(command, args, options, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function runNodeScript(args, options, label) {
  return runCommand(process.execPath, args, options, label);
}

function runWrangler(args, cwd, label, input) {
  const require = createRequire(import.meta.url);
  const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
  return runCommand(process.execPath, [wranglerBin, ...args], { cwd, input }, label);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workerUrlFromDeploy(output) {
  const matches = [...output.matchAll(/https:\/\/[^\s]+\.workers\.dev/g)].map((match) => match[0]);
  if (matches.length === 0) {
    throw new Error(`could not find workers.dev URL in deploy output\n${output}`);
  }
  return matches[matches.length - 1];
}

async function fetchAssertion(url, body) {
  let last = null;
  for (let attempt = 1; attempt <= 10; ++attempt) {
    const response = await fetch(`${url}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      if (response.ok && parsed.ok === true && typeof parsed.assertion === "string") {
        return parsed.assertion;
      }
      last = { status: response.status, body: parsed };
    } catch {
      last = { status: response.status, body: text.slice(0, 200) };
    }
    await sleep(2000);
  }
  throw new Error(`temporary verifier did not return an assertion: ${JSON.stringify(last)}`);
}

function publicDerHex(publicRecord) {
  return Buffer.from(publicRecord.public_key_der_base64, "base64").toString("hex");
}

function parseConfigDatabase(configPath) {
  const content = readFileSync(configPath, "utf8");
  const name = /database_name\s*[:=]\s*["']([^"']+)["']/.exec(content)?.[1];
  const id = /database_id\s*[:=]\s*["']([^"']+)["']/.exec(content)?.[1];
  if (name === undefined || id === undefined) {
    throw new Error(`could not find database_name and database_id in ${configPath}`);
  }
  return { name, id };
}

function runEntitlement(command, fingerprint, configPath, reason) {
  const args = [
    "scripts/entitlement.mjs",
    command,
    "--fingerprint",
    fingerprint,
    "--actor",
    "remote-cpp-verify",
    "--database",
    "DB",
    "--remote",
    "--config",
    configPath,
  ];
  if (command === "upsert") {
    args.push("--status", "active", "--assertion-ttl", "120");
  }
  if (reason !== undefined) {
    args.push("--reason", reason);
  }
  return runNodeScript(args, { cwd: process.cwd() }, `${command} scratch entitlement`);
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    usage(0);
  }
  const positional = positionalArgs();
  const configPath = resolve(argValue("--config") ?? positional[0] ?? "wrangler.toml");
  const buildDir = resolve(argValue("--build-dir") ?? positional[1] ?? "../../build");
  const ctestConfig = argValue("--ctest-config") ?? positional[2] ?? "Debug";
  const keepWorker = hasFlag("--keep-worker");
  const workerName = argValue("--worker-name") ?? `licensecc-online-cpp-${randomUUID().slice(0, 8)}`;
  const fingerprint = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const tempDir = mkdtempSync(join(tmpdir(), "licensecc-online-cpp-"));
  const database = parseConfigDatabase(configPath);
  let workerUrl = "";
  let deployed = false;
  let entitlementCreated = false;

  try {
    runNodeScript(["scripts/generate-online-key.mjs", "--out-dir", tempDir], { cwd: process.cwd() }, "online key generation");
    const privatePem = readFileSync(join(tempDir, "online_private_key.pkcs8.pem"), "utf8");
    const publicRecord = JSON.parse(readFileSync(join(tempDir, "online_public_key.json"), "utf8"));

    workerUrl = workerUrlFromDeploy(runWrangler([
      "deploy",
      "src/index.ts",
      "--name",
      workerName,
      "--config",
      configPath,
    ], process.cwd(), "temporary verifier deploy"));
    deployed = true;

    runWrangler([
      "secret",
      "put",
      "ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
      "--name",
      workerName,
      "--config",
      configPath,
    ], process.cwd(), "temporary verifier private key secret", privatePem);
    runWrangler([
      "secret",
      "put",
      "ONLINE_SIGNING_KEY_ID",
      "--name",
      workerName,
      "--config",
      configPath,
    ], process.cwd(), "temporary verifier key id secret", publicRecord.key_id);

    runEntitlement("upsert", fingerprint, configPath, "remote C++ verification smoke");
    entitlementCreated = true;

    const assertion = await fetchAssertion(workerUrl, {
      project: "DEFAULT",
      feature: "DEFAULT",
      license_fingerprint: fingerprint,
      nonce,
      client_version: "licensecc-remote-cpp-verify",
    });

    const ctestEnv = {
      ...process.env,
      LCC_REMOTE_ONLINE_ASSERTION: assertion,
      LCC_REMOTE_ONLINE_KEY_ID: publicRecord.key_id,
      LCC_REMOTE_ONLINE_PUBLIC_KEY_DER_HEX: publicDerHex(publicRecord),
      LCC_REMOTE_ONLINE_LICENSE_FINGERPRINT: fingerprint,
      LCC_REMOTE_ONLINE_NONCE: nonce,
      LCC_REMOTE_ONLINE_PROJECT: "DEFAULT",
      LCC_REMOTE_ONLINE_FEATURE: "DEFAULT",
    };
    runCommand("ctest", [
      "--test-dir",
      buildDir,
      "-C",
      ctestConfig,
      "-R",
      "test_online_verification$",
      "--output-on-failure",
    ], { cwd: resolve("../.."), env: ctestEnv }, "C++ remote assertion verification");

    const summary = {
      ok: true,
      worker_name: workerName,
      worker_url: workerUrl,
      database_name: database.name,
      database_id: database.id,
      key_id: publicRecord.key_id,
      fingerprint,
      assertion_prefix: assertion.slice(0, 6),
      ctest: "test_online_verification",
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (entitlementCreated) {
      try {
        runEntitlement("revoke", fingerprint, configPath, "remote C++ verification cleanup");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
    if (deployed && !keepWorker) {
      try {
        runWrangler(["delete", workerName, "--config", configPath, "--force"], process.cwd(), "temporary verifier delete");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
    if (!keepWorker) {
      rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.error(`kept temporary key material in ${tempDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
