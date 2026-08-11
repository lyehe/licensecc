import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  assertReleaseOutputBoundary,
  assembleReleaseArtifacts,
  createCanonicalHeadTree,
  createCppSourceArchive,
  inspectReleaseDirectory,
  parseArgs,
  planArchiveVerification,
  planWorkerAssembly,
  validateArchiveMembers,
  verifyArchiveGenerator,
} from "./assemble-release-artifacts.mjs";

const PLATFORM_VERSION = "0.1.0-rc.1";
const PYTHON_VERSION = "0.1.0rc1";
const CPP_VERSION = "2.1.0";
const NPM_VERSION = "10.9.8";

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `${executable} ${args.join(" ")}`);
}

function write(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function releaseFixture() {
  const root = join(tmpdir(), `licensecc-release-fixture-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const workers = [
    ["cloudflare-licensing-backend", "wrangler.example.toml"],
    ["cloudflare-license-admin", "wrangler.example.jsonc"],
    ["cloudflare-customer-portal", "wrangler.example.jsonc"],
    ["cloudflare-d1-backup", "wrangler.example.jsonc"],
  ];
  for (const [path, contents] of [
    ["package.json", JSON.stringify({ name: "fixture", private: true })],
    ["package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/wrangler": { version: "4.120.0" } } })],
    ["version.json", JSON.stringify({ schema_version: 1, platform_version: PLATFORM_VERSION })],
    ["CMakeLists.txt", `cmake_minimum_required(VERSION 3.16)\nproject(licensecc VERSION ${CPP_VERSION} LANGUAGES CXX)\n`],
    ["LICENSE", "AGPL"], ["cmake/config.cmake", "# cmake"], ["include/licensecc/licensecc.h", "// header"], ["src/library/runtime.cpp", "// committed runtime"],
    ["extern/license-generator/CMakeLists.txt", "cmake_minimum_required(VERSION 3.16)\nproject(lccgen)\n"], ["extern/license-generator/LICENSE", "BSD 3-Clause License"], ["extern/license-generator/PROVENANCE.md", "reviewed vendor provenance"], ["extern/license-generator/cmake/lccgen-config.cmake", "# config"], ["extern/license-generator/src/license_generator/main.cpp", "// generator"],
    ["sdks/python/LICENSE", "AGPL"], ["sdks/python/pyproject.toml", `[project]\nname = "licensecc"\nversion = "${PYTHON_VERSION}"\n`],
    ["sdks/dotnet/src/Licensecc.Client/LICENSE", "AGPL"], ["sdks/dotnet/Licensecc.Client.sln", "solution"], ["sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj", `<Project><PropertyGroup><PackageId>Licensecc.Client</PackageId><Version>${PLATFORM_VERSION}</Version></PropertyGroup></Project>`],
  ]) write(root, path, contents);
  for (const [worker, config] of workers) {
    write(root, `services/${worker}/${config}`, "name = \"example\"\n");
    write(root, `services/${worker}/src/index.ts`, "export default {};\n");
    write(root, `services/${worker}/package.json`, JSON.stringify({ name: `@fixture/${worker}`, version: PLATFORM_VERSION }));
  }
  command("git", ["init", "--quiet"], root);
  command("git", ["config", "user.email", "release@test.invalid"], root);
  command("git", ["config", "user.name", "Release Test"], root);
  command("git", ["add", "--", "."], root);
  command("git", ["commit", "--quiet", "-m", "fixture"], root);
  return root;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.ok(index >= 0, `missing ${flag} in ${args.join(" ")}`);
  return args[index + 1];
}

function fakeRun(commands, { symbols = true, failLabel, wrongSymbol = false, wrongPython = false } = {}) {
  return (entry) => {
    commands.push(entry);
    if (entry.label === failLabel) throw new Error(`intentional ${failLabel} failure`);
    const put = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); };
    if (entry.label === "canonical npm version") return { status: 0, stdout: `${NPM_VERSION}\n` };
    if (entry.label === "canonical locked npm ci") {
      const root = entry.cwd;
      put(join(root, "node_modules/wrangler/package.json"), "{}");
      put(join(root, "node_modules/wrangler/bin/wrangler.js"), "// fake wrangler\n");
    }
    if (entry.label.includes("isolated UI build")) put(join(valueAfter(entry.args, "--outDir"), "index.html"), "ui");
    if (entry.label.includes("Worker dry-run")) put(join(valueAfter(entry.args, "--outdir"), "worker.js"), "bundle");
    if (entry.label.includes("Python wheel")) {
      const out = valueAfter(entry.args, "--out-dir");
      const distribution = wrongPython ? "other" : "licensecc";
      put(join(out, `${distribution}-${PYTHON_VERSION}-py3-none-any.whl`), "wheel");
      put(join(out, `${distribution}-${PYTHON_VERSION}.tar.gz`), "sdist");
    }
    if (entry.label.includes("NuGet package")) {
      const out = valueAfter(entry.args, "--output");
      put(join(out, `Licensecc.Client.${PLATFORM_VERSION}.nupkg`), "package");
      if (symbols) put(join(out, wrongSymbol ? `Other.Client.${PLATFORM_VERSION}.snupkg` : `Licensecc.Client.${PLATFORM_VERSION}.snupkg`), "symbols");
    }
    if (entry.label === "build embedded generator from archive") {
      const build = entry.args[1];
      put(join(build, "src/license_generator", process.platform === "win32" ? "lccgen.exe" : "lccgen"), "generator");
    }
    return { status: 0, stdout: "" };
  };
}

function recomputeTarChecksum(bytes, offset = 0) {
  bytes.fill(0x20, offset + 148, offset + 156);
  const sum = bytes.subarray(offset, offset + 512).reduce((total, byte) => total + byte, 0);
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(bytes, offset + 148);
}

function writeTarName(bytes, value, offset = 0) {
  bytes.fill(0, offset, offset + 100);
  Buffer.from(value, "utf8").copy(bytes, offset);
  recomputeTarChecksum(bytes, offset);
}

function firstTarEntryBytes(bytes) {
  const sizeText = bytes.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
  const size = Number.parseInt(sizeText, 8);
  return 512 + Math.ceil(size / 512) * 512;
}

function tryDirectoryLink(target, link) {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

test("release source archive is canonical HEAD data with deterministic headers and dependency closure", () => {
  const root = releaseFixture();
  const first = join(root, "stage-a");
  const second = join(root, "stage-b");
  try {
    const archiveOne = createCppSourceArchive({ root, outputDirectory: first, consumerId: "acme" });
    writeFileSync(join(root, "src/library/runtime.cpp"), "// mutable working tree mutation");
    const archiveTwo = createCppSourceArchive({ root, outputDirectory: second, consumerId: "acme" });
    assert.deepEqual(readFileSync(archiveOne), readFileSync(archiveTwo));
    const contents = readFileSync(archiveTwo).toString("utf8");
    assert.match(contents, /extern\/license-generator\/PROVENANCE\.md/);
    assert.match(contents, /committed runtime/);
    assert.doesNotMatch(contents, /mutable working tree mutation/);
    write(root, "src/untracked-sentinel.cpp", "must reject");
    assert.throws(() => createCppSourceArchive({ root, outputDirectory: join(root, "stage-c"), consumerId: "acme" }), /untracked C\+\+ release input/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical HEAD source excludes mutable ignored configuration and drives every build command", () => {
  const root = releaseFixture();
  const stage = join(root, "build", "release-artifacts", "canonical");
  try {
    mkdirSync(stage, { recursive: true });
    write(root, "services/cloudflare-license-admin/.dev.vars", "CF_API_TOKEN=not-for-release");
    write(root, "services/cloudflare-license-admin/private-key.pem", "not-for-release");
    write(root, "services/cloudflare-license-admin/wrangler.toml", "name = \"real\"\n");
    writeFileSync(join(root, "services/cloudflare-license-admin/src/index.ts"), "// mutable source\n");
    const canonical = createCanonicalHeadTree({ root, destination: join(stage, ".canonical-head") });
    assert.match(readFileSync(join(canonical, "services/cloudflare-license-admin/src/index.ts"), "utf8"), /export default/);
    assert.ok(!existsSync(join(canonical, "services/cloudflare-license-admin/.dev.vars")));
    assert.ok(!existsSync(join(canonical, "services/cloudflare-license-admin/private-key.pem")));
    assert.ok(!existsSync(join(canonical, "services/cloudflare-license-admin/wrangler.toml")));
    assert.ok(!existsSync(join(canonical, "extern/license-generator/test/data/private_key.rsa")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembly uses a sanitized canonical install, four pinned Worker dry-runs, exact identities, and one verifier", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "release-stage");
  const commands = [];
  try {
    const verification = [];
    const manifest = assembleReleaseArtifacts({
      root,
      outputDirectory: output,
      consumerId: "acme",
      expectedPlatformVersion: PLATFORM_VERSION,
      expectedPythonVersion: PYTHON_VERSION,
      run: fakeRun(commands),
      toolAvailable: () => true,
      verifyArchive: (entry) => {
        verification.push(entry);
        assert.ok(existsSync(entry.archivePath), "archive exists before verification");
        assert.ok(!existsSync(join(output, "release-manifest.json")), "metadata is written after verification");
      },
    });
    assert.equal(manifest.incomplete, false);
    assert.equal(typeof manifest.incomplete, "boolean");
    assert.equal(manifest.cpp_version, CPP_VERSION);
    assert.equal(manifest.consumer_id, "acme");
    assert.equal(verification.length, 1, "default release flow calls a supplied verifier exactly once");
    assert.match(manifest.cpp_archive_sha256, /^[0-9a-f]{64}$/);
    const spdx = JSON.parse(readFileSync(join(output, "spdx.json"), "utf8"));
    assert.match(spdx.documentNamespace, new RegExp(manifest.commit));
    assert.match(spdx.documentNamespace, /acme/);
    assert.match(spdx.documentNamespace, new RegExp(PLATFORM_VERSION.replaceAll(".", "\\.")));
    assert.match(spdx.documentNamespace, new RegExp(CPP_VERSION.replaceAll(".", "\\.")));
    assert.match(spdx.documentNamespace, new RegExp(PYTHON_VERSION.replaceAll(".", "\\.")));
    const npmInstall = commands.find((entry) => entry.label === "canonical locked npm ci");
    assert.ok(npmInstall);
    assert.match(npmInstall.cwd, /\.canonical-head$/);
    assert.ok(!Object.keys(npmInstall.env).some((key) => /(?:token|secret|password|cloudflare)/iu.test(key)));
    assert.equal(commands.filter((entry) => entry.label.includes("isolated UI build")).length, 2);
    const workerCommands = commands.filter((entry) => entry.label.includes("Worker dry-run"));
    assert.equal(workerCommands.length, 4);
    for (const entry of workerCommands) {
      assert.equal(entry.executable, process.execPath);
      assert.match(entry.args[0], /\.canonical-head[\\/]node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/);
      assert.ok(entry.args.includes("--dry-run"));
      assert.ok(entry.args.includes("--outdir"));
      assert.ok(entry.args.includes("--config"));
      assert.ok(!entry.args.some((arg) => /wrangler\.(?:toml|jsonc)$/iu.test(arg)));
      assert.ok(!entry.args.includes("--remote"));
    }
    const npmVersion = commands.find((entry) => entry.label === "canonical npm version");
    const uiCommands = commands.filter((entry) => entry.label.includes("isolated UI build"));
    const npmPrefix = npmVersion.args.slice(0, -1);
    assert.ok(uiCommands.every((entry) => entry.executable === npmVersion.executable && JSON.stringify(entry.args.slice(0, npmPrefix.length)) === JSON.stringify(npmPrefix) && !entry.args.some((argument) => String(argument).includes(".canonical-head") && String(argument).includes("npm-cli"))));
    assert.ok(commands.some((entry) => entry.label.includes("Python wheel") && entry.args.includes("--locked") && entry.args.some((arg) => String(arg).includes(".canonical-head"))));
    assert.ok(commands.some((entry) => entry.label.includes("NuGet restore") && entry.args.includes("--locked-mode") && entry.args.some((arg) => String(arg).includes(".canonical-head"))));
    assert.ok(commands.some((entry) => entry.label.includes("NuGet package") && entry.args.includes(`-p:PackageVersion=${PLATFORM_VERSION}`)));
    assert.ok(!existsSync(join(output, ".canonical-head")));
    assert.ok(!existsSync(join(output, ".release-work")));
    inspectReleaseDirectory(output, { root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dotnet is mandatory by default, records an explicit boolean partial manifest, and rejects unrelated symbols", () => {
  const root = releaseFixture();
  const blocked = join(root, "build", "release-artifacts", "blocked");
  const partial = join(root, "build", "release-artifacts", "partial");
  const wrongSymbols = join(root, "build", "release-artifacts", "wrong-symbols");
  const wrongPython = join(root, "build", "release-artifacts", "wrong-python");
  try {
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: blocked, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => false }), /dotnet is required/);
    assert.ok(!existsSync(blocked));
    const manifest = assembleReleaseArtifacts({ root, outputDirectory: partial, consumerId: "acme", allowPartial: true, run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => false });
    assert.equal(manifest.incomplete, true);
    assert.equal(typeof manifest.incomplete, "boolean");
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: wrongSymbols, consumerId: "acme", run: fakeRun([], { wrongSymbol: true }), verifyArchive: () => {}, toolAvailable: () => true }), /NuGet primary and symbols artifacts/);
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: wrongPython, consumerId: "acme", run: fakeRun([], { wrongPython: true }), verifyArchive: () => {}, toolAvailable: () => true }), /python artifacts do not carry the exact expected identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspector deep-compares the canonical manifest, SPDX, identities, and archive hash", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "inspect");
  try {
    assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true });
    const manifestPath = join(output, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.cpp_archive_sha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => inspectReleaseDirectory(output, { root }), /invalid release manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspector rejects a wrong SPDX field, extra payload, and non-boolean incomplete marker", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "spdx");
  try {
    assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true });
    const spdxPath = join(output, "spdx.json");
    const spdx = JSON.parse(readFileSync(spdxPath, "utf8"));
    spdx.packages[0].name = "workers/wrong.js";
    spdx.packages[0].versionInfo = "9.9.9";
    spdx.packages[0].checksums[0].checksumValue = "0".repeat(64);
    writeFileSync(spdxPath, JSON.stringify(spdx));
    assert.throws(() => inspectReleaseDirectory(output, { root }), /invalid SPDX document/);
    const manifestPath = join(output, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.incomplete = "false";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => inspectReleaseDirectory(output, { root }), /invalid release manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two controlled canonical assemblies are byte-identical despite mutable non-C++ checkout drift", () => {
  const root = releaseFixture();
  const first = join(root, "build", "release-artifacts", "first");
  const second = join(root, "build", "release-artifacts", "second");
  try {
    assembleReleaseArtifacts({ root, outputDirectory: first, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true });
    writeFileSync(join(root, "services/cloudflare-license-admin/src/index.ts"), "// mutable drift after first assembly\n");
    write(root, "services/cloudflare-license-admin/.dev.vars", "ignored-secret\n");
    assembleReleaseArtifacts({ root, outputDirectory: second, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true });
    for (const file of ["checksums.sha256", "release-manifest.json", "spdx.json"]) assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)), file);
    const firstCpp = readdirSync(join(first, "cpp"));
    const secondCpp = readdirSync(join(second, "cpp"));
    assert.deepEqual(firstCpp, secondCpp);
    assert.deepEqual(readFileSync(join(first, "cpp", firstCpp[0])), readFileSync(join(second, "cpp", secondCpp[0])));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output boundaries reject source paths and real symlink or junction aliases before assembly", (t) => {
  const root = releaseFixture();
  try {
    assert.throws(() => assertReleaseOutputBoundary({ root, outputDirectory: root }), /release output/);
    assert.throws(() => assertReleaseOutputBoundary({ root, outputDirectory: join(root, "not-build") }), /release output/);
    const releaseRoot = join(root, "build", "release-artifacts");
    mkdirSync(releaseRoot, { recursive: true });
    const internalAlias = join(releaseRoot, "source-alias");
    if (!tryDirectoryLink(root, internalAlias)) t.skip("directory links are unavailable on this host");
    assert.throws(() => assertReleaseOutputBoundary({ root, outputDirectory: join(internalAlias, "stage") }), /reparse|release output/i);
    const external = join(tmpdir(), `licensecc-output-link-${process.pid}-${Date.now()}`);
    mkdirSync(external, { recursive: true });
    const externalAlias = join(external, "source-alias");
    try {
      if (!tryDirectoryLink(root, externalAlias)) t.skip("directory links are unavailable on this host");
      assert.throws(() => assertReleaseOutputBoundary({ root, outputDirectory: join(externalAlias, "stage") }), /reparse|release output/i);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
    if (process.platform === "win32") {
      assert.doesNotThrow(() => assertReleaseOutputBoundary({ root: root.toUpperCase(), outputDirectory: join(root.toUpperCase(), "build", "release-artifacts", "case-safe") }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed staging removes only its owned, revalidated output", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "will-fail");
  const sentinel = join(root, "sentinel.txt");
  try {
    writeFileSync(sentinel, "keep");
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun([], { failLabel: "canonical locked npm ci" }), verifyArchive: () => {}, toolAvailable: () => true }), /intentional/);
    assert.ok(!existsSync(output));
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive verification failure removes its owned staging before metadata can succeed", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "verify-failure");
  try {
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun([]), verifyArchive: () => { throw new Error("verification failed"); }, toolAvailable: () => true }), /verification failed/);
    assert.ok(!existsSync(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive validator rejects traversal, absolute paths, nonregular entries, duplicate members, bad sizes, checksums, and truncation", () => {
  const root = releaseFixture();
  const output = join(root, "stage");
  try {
    const archive = createCppSourceArchive({ root, outputDirectory: output, consumerId: "acme" });
    const original = readFileSync(archive);
    const mutate = (name, change, pattern) => {
      const target = join(output, name);
      const bytes = Buffer.from(original);
      change(bytes);
      writeFileSync(target, bytes);
      assert.throws(() => validateArchiveMembers(target), pattern);
    };
    mutate("bad-checksum.tar", (bytes) => { bytes[0] = 47; }, /checksum/);
    mutate("traversal.tar", (bytes) => writeTarName(bytes, "../../escape"), /unsafe/);
    mutate("absolute.tar", (bytes) => writeTarName(bytes, "/escape"), /unsafe/);
    mutate("nonregular.tar", (bytes) => { bytes[156] = 50; recomputeTarChecksum(bytes); }, /non-regular/);
    mutate("bad-size.tar", (bytes) => { bytes.fill(0, 124, 136); Buffer.from("77777777777\0", "ascii").copy(bytes, 124); recomputeTarChecksum(bytes); }, /truncated/);
    const first = firstTarEntryBytes(original);
    writeFileSync(join(output, "duplicate.tar"), Buffer.concat([original.subarray(0, original.length - 1024), original.subarray(0, first), Buffer.alloc(1024)]));
    assert.throws(() => validateArchiveMembers(join(output, "duplicate.tar")), /duplicate/);
    writeFileSync(join(output, "truncated.tar"), original.subarray(0, original.length - 512));
    assert.throws(() => validateArchiveMembers(join(output, "truncated.tar")), /truncated/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive verification uses only contained no-install command arrays and LCC_LOCATION", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "verify");
  const parent = join(output, ".probe-parent");
  const commands = [];
  try {
    const archive = createCppSourceArchive({ root, outputDirectory: output, consumerId: "acme" });
    mkdirSync(parent, { recursive: true });
    const plan = planArchiveVerification({ archivePath: archive, tempParent: parent });
    assert.equal(plan.length, 4);
    assert.ok(plan.every((entry) => entry.executable === "cmake" && !entry.args.includes("--install") && !entry.args.some((arg) => /(?:^|[\\/])(?:bin|cmake|lib)(?:[\\/]|$)/iu.test(String(arg).replace(/^[A-Za-z]:/u, "")))));
    if (process.platform === "win32") assert.ok(plan.filter((entry) => entry.label.startsWith("configure")).every((entry) => entry.args.includes("Ninja")));
    verifyArchiveGenerator({ archivePath: archive, tempParent: parent, run: fakeRun(commands) });
    const runtime = commands.find((entry) => entry.label === "configure extracted runtime from archive");
    assert.ok(runtime.args.some((arg) => String(arg).startsWith("-DLCC_LOCATION=")));
    assert.ok(!runtime.args.some((arg) => String(arg).startsWith("-Dlccgen_DIR=")));
    assert.ok(runtime.args.some((arg) => String(arg).startsWith("-DCMAKE_INSTALL_PREFIX=")));
    assert.ok(commands.every((entry) => !entry.args.includes("--install")));
    assert.deepEqual(readdirSync(parent), [], "probe cleanup is confined to the owned parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker plan remains explicit about example configs and output isolation", () => {
  const plan = planWorkerAssembly("C:/release-stage", "C:/canonical-head");
  assert.equal(plan.filter((entry) => entry.label.includes("Worker dry-run")).length, 4);
  assert.equal(plan.filter((entry) => entry.label.includes("isolated UI build")).length, 2);
  assert.ok(plan.filter((entry) => entry.label.includes("Worker dry-run")).every((entry) => /wrangler\.example\.(toml|jsonc)$/iu.test(entry.args[entry.args.indexOf("--config") + 1])));
});

test("CLI rejects unknown and duplicate flags", () => {
  assert.throws(() => parseArgs(["node", "script", "--unknown", "x"]), /invalid argument/);
  assert.throws(() => parseArgs(["node", "script", "--output", "a", "--output", "b"]), /invalid argument/);
  assert.throws(() => parseArgs(["node", "script", "--allow-partial", "--allow-partial"]), /duplicate argument/);
  const root = releaseFixture();
  try {
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: join(root, "build", "release-artifacts", "wrong-platform"), consumerId: "acme", expectedPlatformVersion: "9.9.9", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true }), /does not match tracked version authority/);
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: join(root, "build", "release-artifacts", "wrong-python"), consumerId: "acme", expectedPythonVersion: "9.9.9", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true }), /does not match tracked version authority/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
