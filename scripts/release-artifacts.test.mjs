import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReleaseAllowlist,
  assertSafeRelativePath,
  createCppSourceArchive,
  inspectReleaseDirectory,
  planWorkerDryRuns,
  runWorkerDryRuns,
  writeReleaseMetadata,
} from "./assemble-release-artifacts.mjs";

test("release artifact assembly uses the pinned local Wrangler dry-run bundle ceremony", () => {
  const plan = planWorkerDryRuns("C:/release-stage");

  assert.equal(plan.length, 4);
  for (const command of plan) {
    assert.equal(command.executable, process.execPath);
    assert.equal(command.args[0], "<local-wrangler-bin>");
    assert.ok(command.args.includes("deploy"));
    assert.ok(command.args.includes("--dry-run"));
    assert.ok(command.args.includes("--outdir"));
    assert.ok(command.args.includes("--config"));
    assert.match(command.args[command.args.indexOf("--config") + 1], /wrangler\.example\.(toml|jsonc)$/);
    assert.doesNotMatch(command.args.join(" "), /wrangler\.(toml|jsonc)(?:\s|$)/);
  }
});

test("release artifact paths reject traversal, keys, real Wrangler config, databases, and build output", () => {
  for (const path of [
    "../escape.txt",
    "workers/../escape.js",
    "workers/license-admin/.dev.vars",
    "workers/license-admin/wrangler.jsonc",
    "workers/license-admin/wrangler.toml",
    "workers/license-admin/production.pem",
    "workers/license-admin/private_key.rsa",
    "workers/license-admin/state.sqlite",
    "workers/license-admin/build/worker.js",
    "workers/license-admin/.wrangler/state",
  ]) {
    assert.throws(() => assertSafeRelativePath(path), /unsafe artifact path/, path);
  }

  const root = mkdtempSync(join(tmpdir(), "licensecc-release-allowlist-"));
  try {
    assert.equal(assertReleaseAllowlist(root, join(root, "cpp/licensecc-cpp-sdk-consumer-1.0.0.tar")), "cpp/licensecc-cpp-sdk-consumer-1.0.0.tar");
    assert.throws(() => assertReleaseAllowlist(root, join(root, "dotnet/worker.exe")), /outside the allowlist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker dry-runs resolve the pinned Wrangler binary from the local workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-release-wrangler-"));
  const output = join(root, "release-output");
  try {
    mkdirSync(join(root, "node_modules/wrangler/bin"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/wrangler": { version: "4.120.0" } } }));
    writeFileSync(join(root, "node_modules/wrangler/bin/wrangler.js"), "// local test binary\n");
    const commands = [];

    runWorkerDryRuns({ root, outputDirectory: output, run: (command) => commands.push(command) });

    assert.equal(commands.length, 4);
    assert.ok(commands.every((command) => command.args[0] === join(root, "node_modules/wrangler/bin/wrangler.js")));
    assert.ok(commands.every((command) => command.args.includes("--dry-run") && command.args.includes("--outdir")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C++ release archive is deterministic source-only and consumer-keyed", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-release-source-"));
  const output = mkdtempSync(join(tmpdir(), "licensecc-release-output-"));
  try {
    for (const directory of ["cmake", "include/licensecc", "src/library", "build", "install", "projects/default"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, "CMakeLists.txt"), "project(licensecc)\n");
    writeFileSync(join(root, "LICENSE"), "AGPL-3.0-or-later\n");
    writeFileSync(join(root, "cmake/config.cmake"), "# source\n");
    writeFileSync(join(root, "include/licensecc/licensecc.h"), "// public header\n");
    writeFileSync(join(root, "src/library/runtime.cpp"), "// source\n");
    writeFileSync(join(root, "build/ci-binary.exe"), "binary");
    writeFileSync(join(root, "install/private_key.rsa"), "private");
    writeFileSync(join(root, "projects/default/private_key.rsa"), "generated");

    const archive = createCppSourceArchive({ root, outputDirectory: output, consumerKey: "acme", version: "1.0.0" });
    const contents = readFileSync(archive).toString("utf8");
    assert.match(archive, /licensecc-cpp-sdk-acme-1\.0\.0\.tar$/);
    assert.match(contents, /licensecc-cpp-sdk-acme-1\.0\.0\/include\/licensecc\/licensecc\.h/);
    assert.match(contents, /licensecc-cpp-sdk-acme-1\.0\.0\/src\/library\/runtime\.cpp/);
    assert.doesNotMatch(contents, /ci-binary|private_key|generated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("release manifest records checksums and SPDX inputs for only allowlisted artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "licensecc-release-manifest-source-"));
  const output = mkdtempSync(join(tmpdir(), "licensecc-release-manifest-output-"));
  try {
    for (const directory of ["sdks/python", "sdks/dotnet/src/Licensecc.Client", "workers/licensing-backend", "python", "dotnet", "cpp"]) {
      mkdirSync(join(directory.startsWith("workers") || ["python", "dotnet", "cpp"].includes(directory) ? output : root, directory), { recursive: true });
    }
    writeFileSync(join(root, "LICENSE"), "AGPL");
    writeFileSync(join(root, "sdks/python/LICENSE"), "AGPL");
    writeFileSync(join(root, "sdks/dotnet/src/Licensecc.Client/LICENSE"), "AGPL");
    writeFileSync(join(output, "workers/licensing-backend/worker.js"), "export default {};");
    writeFileSync(join(output, "python/licensecc-1.0.0.whl"), "wheel");
    writeFileSync(join(output, "python/licensecc-1.0.0.tar.gz"), "sdist");
    writeFileSync(join(output, "dotnet/Licensecc.Client.1.0.0.nupkg"), "nupkg");
    writeFileSync(join(output, "dotnet/Licensecc.Client.1.0.0.symbols.nupkg"), "symbols");
    writeFileSync(join(output, "cpp/licensecc-cpp-sdk-acme-1.0.0.tar"), "source");

    const manifest = writeReleaseMetadata({ root, outputDirectory: output, version: "1.0.0" });
    assert.equal(manifest.SPDXVersion, "SPDX-2.3");
    assert.equal(manifest.artifacts.length, 6);
    assert.equal(inspectReleaseDirectory(output).name, "licensecc-release-1.0.0");
    assert.match(readFileSync(join(output, "checksums.sha256"), "utf8"), /licensecc-cpp-sdk-acme-1\.0\.0\.tar/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
