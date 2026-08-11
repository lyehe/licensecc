import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assembleReleaseArtifacts, createCppSourceArchive, inspectReleaseDirectory, planWorkerAssembly } from "./assemble-release-artifacts.mjs";

const PLATFORM_VERSION = "0.1.0-rc.1";
const PYTHON_VERSION = "0.1.0rc1";

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `${executable} ${args.join(" ")}`);
}

function write(root, path, contents) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function releaseFixture() {
  const root = join(tmpdir(), `licensecc-release-fixture-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  for (const [path, contents] of [
    ["package.json", "{}"], ["package-lock.json", JSON.stringify({ packages: { "node_modules/wrangler": { version: "4.120.0" } } })], ["node_modules/wrangler/bin/wrangler.js", "// local wrangler\n"], ["node_modules/npm/bin/npm-cli.js", "// local npm\n"], ["version.json", JSON.stringify({ platform_version: PLATFORM_VERSION })],
    ["CMakeLists.txt", "cmake_minimum_required(VERSION 3.16)\nproject (licensecc VERSION 2.1.0 LANGUAGES CXX)\n"], ["LICENSE", "AGPL"], ["cmake/config.cmake", "# cmake"], ["include/licensecc/licensecc.h", "// header"], ["src/library/runtime.cpp", "// committed runtime"],
    ["extern/license-generator/CMakeLists.txt", "cmake_minimum_required(VERSION 3.16)\nproject(lccgen)\n"], ["extern/license-generator/LICENSE", "BSD 3-Clause License"], ["extern/license-generator/PROVENANCE.md", "reviewed vendor provenance"], ["extern/license-generator/cmake/lccgen-config.cmake", "# config"], ["extern/license-generator/src/license_generator/main.cpp", "// generator"],
    ["sdks/python/LICENSE", "AGPL"], ["sdks/python/pyproject.toml", `[project]\nversion = \"${PYTHON_VERSION}\"\n`], ["sdks/dotnet/src/Licensecc.Client/LICENSE", "AGPL"], ["sdks/dotnet/Licensecc.Client.sln", "solution"], ["sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj", "project"],
  ]) write(root, path, contents);
  command("git", ["init", "--quiet"], root); command("git", ["config", "user.email", "release@test.invalid"], root); command("git", ["config", "user.name", "Release Test"], root); command("git", ["add", "--", "."], root); command("git", ["commit", "--quiet", "-m", "fixture"], root);
  return root;
}

function stagedRunner(commands, { symbols = true } = {}) {
  return (entry) => {
    commands.push(entry);
    const valueAfter = (flag) => entry.args[entry.args.indexOf(flag) + 1];
    const put = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); };
    if (entry.label.includes("UI build")) put(join(valueAfter("--outDir"), "index.html"), "ui");
    if (entry.label.includes("Worker dry-run")) put(join(valueAfter("--outdir"), "worker.js"), "bundle");
    if (entry.label.includes("Python")) { const out = valueAfter("--out-dir"); put(join(out, `licensecc-${PYTHON_VERSION}-py3-none-any.whl`), "wheel"); put(join(out, `licensecc-${PYTHON_VERSION}.tar.gz`), "sdist"); }
    if (entry.label.includes("NuGet package")) { const out = valueAfter("--output"); put(join(out, `Licensecc.Client.${PLATFORM_VERSION}.nupkg`), "package"); if (symbols) put(join(out, `Licensecc.Client.${PLATFORM_VERSION}.snupkg`), "symbols"); }
    return { status: 0 };
  };
}

test("release source archive uses only canonical tracked blobs, vendor dependency closure, and deterministic headers", () => {
  const root = releaseFixture(); const first = join(root, "stage-a"); const second = join(root, "stage-b");
  try {
    const archiveOne = createCppSourceArchive({ root, outputDirectory: first, consumerId: "acme" });
    writeFileSync(join(root, "src/library/runtime.cpp"), "// working tree mutation");
    const archiveTwo = createCppSourceArchive({ root, outputDirectory: second, consumerId: "acme" });
    assert.deepEqual(readFileSync(archiveOne), readFileSync(archiveTwo));
    const contents = readFileSync(archiveTwo).toString("utf8");
    assert.match(contents, /extern\/license-generator\/PROVENANCE\.md/);
    assert.match(contents, /committed runtime/);
    assert.doesNotMatch(contents, /working tree mutation/);
    write(root, "src/untracked-sentinel.cpp", "must reject");
    assert.throws(() => createCppSourceArchive({ root, outputDirectory: join(root, "stage-c"), consumerId: "acme" }), /untracked C\+\+ release input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assembly stages clean UI assets, four pinned local Worker bundles, locked SDK packages, and exact SPDX inspection", () => {
  const root = releaseFixture(); const output = join(root, "release-stage"); const commands = [];
  try {
    const manifest = assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", expectedPlatformVersion: PLATFORM_VERSION, expectedPythonVersion: PYTHON_VERSION, run: stagedRunner(commands), toolAvailable: () => true });
    assert.equal(manifest.incomplete, false);
    assert.equal(commands.filter((entry) => entry.label.includes("UI build")).length, 2);
    assert.equal(commands.filter((entry) => entry.label.includes("Worker dry-run")).length, 4);
    assert.ok(commands.filter((entry) => entry.label.includes("Worker dry-run")).every((entry) => entry.args[0] === join(root, "node_modules/wrangler/bin/wrangler.js") && entry.args.includes("--dry-run") && entry.args.includes("--outdir")));
    assert.ok(commands.some((entry) => entry.label.includes("Python") && entry.args.includes("--locked")));
    assert.ok(commands.some((entry) => entry.label.includes("NuGet restore") && entry.args.includes("--locked-mode")));
    assert.ok(commands.some((entry) => entry.label.includes("NuGet package") && entry.args.includes(`-p:PackageVersion=${PLATFORM_VERSION}`)));
    assert.equal(manifest.cpp_version, "2.1.0");
    assert.equal(manifest.consumer_id, "acme");
    assert.ok(!existsSync(join(output, ".release-work")));
    writeFileSync(join(output, "workers/licensing-backend/unlisted.js"), "extra");
    assert.throws(() => inspectReleaseDirectory(output, { root }), /payload set does not exactly match staging/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dotnet is mandatory unless allow-partial records an incomplete release", () => {
  const root = releaseFixture(); const blocked = join(root, "blocked"); const partial = join(root, "partial");
  try {
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: blocked, consumerId: "acme", run: stagedRunner([]), toolAvailable: () => false }), /dotnet is required/);
    assert.ok(!existsSync(blocked));
    const manifest = assembleReleaseArtifacts({ root, outputDirectory: partial, consumerId: "acme", allowPartial: true, run: stagedRunner([]), toolAvailable: () => false });
    assert.equal(manifest.incomplete, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("version authority, NuGet symbols, and SPDX package identity fail closed", () => {
  const root = releaseFixture(); const wrongVersion = join(root, "wrong-version"); const noSymbols = join(root, "no-symbols"); const output = join(root, "spdx");
  try {
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: wrongVersion, consumerId: "acme", expectedPlatformVersion: "9.9.9", run: stagedRunner([]), toolAvailable: () => true }), /does not match tracked version authority/);
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: noSymbols, consumerId: "acme", run: stagedRunner([], { symbols: false }), toolAvailable: () => true }), /NuGet primary and symbols artifacts/);
    assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: stagedRunner([]), toolAvailable: () => true });
    const spdxPath = join(output, "spdx.json"); const spdx = JSON.parse(readFileSync(spdxPath, "utf8"));
    assert.match(spdx.documentNamespace, /acme/); assert.match(spdx.documentNamespace, /2\.1\.0/); assert.ok(spdx.packages.some((entry) => entry.name.startsWith("cpp/") && entry.versionInfo === "2.1.0"));
    spdx.packages[0].checksums[0].checksumValue = "0".repeat(64); writeFileSync(spdxPath, JSON.stringify(spdx));
    assert.throws(() => inspectReleaseDirectory(output, { root }), /invalid SPDX document/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("worker plan uses only example configs and isolated UI output", () => {
  const plan = planWorkerAssembly("C:/release-stage");
  assert.equal(plan.filter((entry) => entry.label.includes("Worker dry-run")).length, 4);
  assert.equal(plan.filter((entry) => entry.label.includes("UI build")).length, 2);
  assert.ok(plan.filter((entry) => entry.label.includes("Worker dry-run")).every((entry) => /wrangler\.example\.(toml|jsonc)$/.test(entry.args[entry.args.indexOf("--config") + 1])));
});
