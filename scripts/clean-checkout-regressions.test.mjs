import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const services = [
  "cloudflare-licensing-backend",
  "cloudflare-license-admin",
  "cloudflare-customer-portal",
  "cloudflare-d1-backup",
];

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
}

function writeFixtureFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function createWranglerFixture(repository) {
  writeFixtureFile(
    join(repository, "package.json"),
    JSON.stringify({ name: "clean-checkout-fixture", private: true, type: "module" }),
  );

  const helper = readFileSync(resolve(repositoryRoot, "scripts/generate-wrangler-types.mjs"), "utf8");
  writeFixtureFile(join(repository, "scripts/generate-wrangler-types.mjs"), helper);

  // The shared helper invokes this pinned entrypoint directly.  It deliberately
  // does not create the output file's parent, so the helper must do that first.
  writeFixtureFile(
    join(repository, "node_modules/wrangler/bin/wrangler.js"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      "writeFileSync(resolve(process.cwd(), process.argv[3]), \"fixture generated\");",
      "",
    ].join("\n"),
  );

  // A raw `wrangler types ...` command must not accidentally pass because a
  // globally installed executable happens to be available on the runner.
  const commandBin = join(repository, "bin");
  writeFixtureFile(join(commandBin, "wrangler"), "#!/bin/sh\nexit 97\n");
  writeFixtureFile(join(commandBin, "wrangler.cmd"), "@echo off\r\nexit /b 97\r\n");
  if (process.platform !== "win32") {
    chmodSync(join(commandBin, "wrangler"), 0o755);
  }

  return commandBin;
}

function fixtureEnvironment(commandBin) {
  const path = [commandBin, process.env.PATH].filter(Boolean).join(delimiter);
  return { ...process.env, PATH: path, ...(process.platform === "win32" ? { Path: path } : {}) };
}

test("all Worker type generators use the shared helper from an empty checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "licensecc clean checkout "));
  try {
    const commandBin = createWranglerFixture(fixture);

    for (const service of services) {
      const manifest = readJson(`services/${service}/package.json`);
      const serviceRoot = join(fixture, "services", service);
      writeFixtureFile(
        join(serviceRoot, "package.json"),
        JSON.stringify({
          name: `clean-checkout-${service}`,
          private: true,
          type: "module",
          scripts: { "generate:wrangler-types": manifest.scripts?.["generate:wrangler-types"] },
        }),
      );

      const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
      const result = spawnSync(npmCommand, ["run", "--silent", "generate:wrangler-types"], {
        cwd: serviceRoot,
        encoding: "utf8",
        env: fixtureEnvironment(commandBin),
        shell: true,
        timeout: 30_000,
      });
      assert.equal(
        result.status,
        0,
        `${service} generator failed in an empty checkout:\n${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
      );

      const generatedTypes = join(serviceRoot, ".wrangler", "worker-configuration.d.ts");
      assert.ok(existsSync(generatedTypes), `${service} generator did not create its output`);
      assert.equal(readFileSync(generatedTypes, "utf8"), "fixture generated");
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
