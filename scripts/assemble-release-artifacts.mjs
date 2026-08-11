import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCAL_WRANGLER_VERSION = "4.120.0";
const METADATA_FILES = new Set(["checksums.sha256", "release-manifest.json", "spdx.json"]);
const CPP_EXACT = new Set(["CMakeLists.txt", "LICENSE", "extern/license-generator/CMakeLists.txt", "extern/license-generator/LICENSE", "extern/license-generator/PROVENANCE.md"]);
const CPP_PREFIXES = ["cmake/", "include/", "src/", "extern/license-generator/cmake/", "extern/license-generator/src/"];
const WORKERS = [
  { name: "licensing-backend", workspace: "@licensecc/cloudflare-licensing-backend", directory: "services/cloudflare-licensing-backend", config: "wrangler.example.toml", entry: "src/index.ts" },
  { name: "license-admin", workspace: "@licensecc/cloudflare-license-admin", directory: "services/cloudflare-license-admin", config: "wrangler.example.jsonc", ui: true },
  { name: "customer-portal", workspace: "@licensecc/cloudflare-customer-portal", directory: "services/cloudflare-customer-portal", config: "wrangler.example.jsonc", ui: true },
  { name: "d1-backup", workspace: "@licensecc/cloudflare-d1-backup", directory: "services/cloudflare-d1-backup", config: "wrangler.example.jsonc" },
];
const FORBIDDEN_SEGMENTS = new Set([".git", ".wrangler", "node_modules", "build", "dist", "dist-worker", "bin", "obj", "install", "projects", "test-results", "coverage", "database", "databases"]);
const FORBIDDEN_NAME = /(?:^\.dev\.vars(?:$|\.)|^wrangler\.(?:toml|jsonc)$|^id_rsa(?:\.pub)?$|private[-_.]?key|secret|\.(?:pem|key|pfx|p12|rsa|db|sqlite|sqlite3)$)/i;

function sha256(contents) { return createHash("sha256").update(contents).digest("hex"); }
function assertSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) throw new Error(`unsafe artifact path: ${JSON.stringify(value)}`);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === ".." || FORBIDDEN_SEGMENTS.has(part.toLowerCase()) || FORBIDDEN_NAME.test(part))) throw new Error(`unsafe artifact path: ${JSON.stringify(value)}`);
  return normalized;
}
function safeConsumerId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error("--consumer-id must be a lowercase consumer identifier (letters, digits, hyphens)");
  return value;
}
function safeVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)) throw new Error("release versions must be simple identifiers");
  return value;
}
function commandResult(command) {
  const result = spawnSync(command.executable, command.args, { cwd: command.cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${command.label} failed${result.status === null || result.status === undefined ? "" : ` (${result.status})`}`);
  return result;
}
function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "buffer" });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}
function trackedCppFiles(root) {
  const tracked = git(root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean)
    .filter((path) => CPP_EXACT.has(path) || CPP_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "CMakeLists.txt", "LICENSE", "cmake", "include", "src", "extern/license-generator"]).toString("utf8").split("\0").filter(Boolean);
  if (untracked.length) throw new Error(`untracked C++ release input: ${untracked.sort().join(", ")}`);
  return tracked.map(assertSafeRelativePath).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function gitBlob(root, path) { return git(root, ["cat-file", "blob", `HEAD:${path}`]); }
function repositoryVersions(root) {
  // These are strict readers of the independent tracked authorities; do not
  // widen their syntax here. Version-contract integration may replace them.
  const platformVersion = JSON.parse(gitBlob(root, "version.json").toString("utf8")).platform_version;
  const pythonVersion = /(?:^|\n)version\s*=\s*"([^"]+)"/m.exec(gitBlob(root, "sdks/python/pyproject.toml").toString("utf8"))?.[1];
  const cppVersion = /project\s*\(\s*licensecc\s+VERSION\s+([0-9]+(?:\.[0-9]+){2})/is.exec(gitBlob(root, "CMakeLists.txt").toString("utf8"))?.[1];
  if (!safeVersion(platformVersion) || !safeVersion(pythonVersion) || !safeVersion(cppVersion)) throw new Error("tracked release versions are invalid");
  const derivedPython = platformVersion.replace(/-rc\.(\d+)$/, "rc$1").replace(/-beta\.(\d+)$/, "b$1").replace(/-alpha\.(\d+)$/, "a$1");
  if (pythonVersion !== derivedPython) throw new Error(`Python version ${pythonVersion} does not match platform ${platformVersion}`);
  return { platformVersion, pythonVersion, cppVersion, commit: git(root, ["rev-parse", "HEAD"]).toString("utf8").trim(), sourceDate: new Date(Number(git(root, ["show", "-s", "--format=%ct", "HEAD"]).toString("utf8").trim()) * 1000).toISOString() };
}
function tarHeader(name, size) {
  const header = Buffer.alloc(512); let fileName = name; let prefix = "";
  if (Buffer.byteLength(fileName) > 100) { const cut = fileName.lastIndexOf("/"); if (cut < 1 || Buffer.byteLength(fileName.slice(0, cut)) > 155) throw new Error(`tar path too long: ${name}`); prefix = fileName.slice(0, cut); fileName = fileName.slice(cut + 1); }
  const text = (value, at, sizeOf) => header.write(value, at, sizeOf, "utf8");
  const octal = (value, at, sizeOf) => text(`${value.toString(8).padStart(sizeOf - 1, "0")}\0`, at, sizeOf);
  text(fileName, 0, 100); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12); header.fill(0x20, 148, 156); header[156] = 48; text("ustar\0", 257, 6); text("00", 263, 2); text(prefix, 345, 155);
  text(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8); return header;
}
function createCppSourceArchive({ root = repositoryRoot, outputDirectory, consumerId, cppVersion = repositoryVersions(root).cppVersion, platformVersion = repositoryVersions(root).platformVersion }) {
  const archiveRoot = `licensecc-cpp-sdk-${safeConsumerId(consumerId)}-cpp-${safeVersion(cppVersion)}-platform-${safeVersion(platformVersion)}`;
  const archivePath = join(outputDirectory, "cpp", `${archiveRoot}.tar`); const chunks = [];
  for (const path of trackedCppFiles(root)) { const bytes = gitBlob(root, path); const member = assertSafeRelativePath(`${archiveRoot}/${path}`); chunks.push(tarHeader(member, bytes.length), bytes); if (bytes.length % 512) chunks.push(Buffer.alloc(512 - (bytes.length % 512))); }
  chunks.push(Buffer.alloc(1024)); mkdirSync(dirname(archivePath), { recursive: true }); writeFileSync(archivePath, Buffer.concat(chunks)); return archivePath;
}
function validateArchiveMembers(archivePath) {
  const archive = readFileSync(archivePath); let offset = 0; const members = new Set();
  while (offset + 512 <= archive.length) { const header = archive.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break; const stored = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(), 8); const copy = Buffer.from(header); copy.fill(0x20, 148, 156); if (!Number.isInteger(stored) || copy.reduce((sum, byte) => sum + byte, 0) !== stored) throw new Error("release archive has an invalid header checksum"); const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, ""); const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, ""); const type = header[156]; const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(); const size = Number.parseInt(sizeText || "0", 8); if (type !== 0 && type !== 48 || !Number.isSafeInteger(size) || size < 0) throw new Error("release archive contains a non-regular or malformed entry"); const member = assertSafeRelativePath(prefix ? `${prefix}/${name}` : name); if (members.has(member)) throw new Error("release archive contains duplicate members"); members.add(member); offset += 512 + Math.ceil(size / 512) * 512; }
  if (offset > archive.length || archive.length - offset < 1024) throw new Error("release archive is truncated");
}
function verifyArchiveGenerator({ archivePath, tempParent = tmpdir(), run = commandResult }) {
  const parent = resolve(tempParent); const probe = mkdtempSync(join(parent, "licensecc-release-cpp-probe-")); const archive = resolve(archivePath);
  if (!archive.startsWith(`${parent}${sep}`) && !archive.includes("licensecc-cpp-sdk-")) throw new Error("archive path is not an explicit release archive");
  try {
    validateArchiveMembers(archive);
    run({ executable: "tar", args: ["-xf", archive, "-C", probe], cwd: probe, label: "extract C++ release archive" });
    const source = readdirSync(probe).map((entry) => join(probe, entry)).find((entry) => lstatSync(entry).isDirectory()); const build = join(probe, "generator-build");
    if (!source || !source.startsWith(`${probe}${sep}`) || !build.startsWith(`${probe}${sep}`)) throw new Error("archive probe paths escaped temporary root");
    run({ executable: "cmake", args: ["-S", join(source, "extern/license-generator"), "-B", build, "-DBUILD_TESTING=OFF"], cwd: probe, label: "configure embedded generator from archive" });
    run({ executable: "cmake", args: ["--build", build, "--target", "lccgen"], cwd: probe, label: "build embedded generator from archive" });
    const rootBuild = join(probe, "runtime-build"); const projects = join(probe, "runtime-projects");
    if (!rootBuild.startsWith(`${probe}${sep}`) || !projects.startsWith(`${probe}${sep}`)) throw new Error("runtime probe paths escaped temporary root");
    run({ executable: "cmake", args: ["-S", source, "-B", rootBuild, "-DBUILD_TESTING=OFF", `-Dlccgen_DIR=${build}`, `-DLCC_PROJECTS_BASE_DIR=${projects}`], cwd: probe, label: "configure extracted runtime from archive" });
    run({ executable: "cmake", args: ["--build", rootBuild, "--target", "licensecc_static"], cwd: probe, label: "build extracted runtime from archive" });
  } finally { rmSync(probe, { recursive: true, force: true }); }
}
function localWranglerBinary(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lock.packages?.["node_modules/wrangler"]?.version !== LOCAL_WRANGLER_VERSION) throw new Error(`release assembly requires local wrangler ${LOCAL_WRANGLER_VERSION}`);
  return createRequire(join(root, "package.json")).resolve("wrangler/bin/wrangler.js");
}
function planWorkerAssembly(outputDirectory, root = repositoryRoot) {
  const work = join(outputDirectory, ".release-work"); const plan = [];
  for (const worker of WORKERS) {
    const outdir = join(outputDirectory, "workers", worker.name);
    if (worker.ui) plan.push({ executable: process.execPath, args: ["<local-npm-cli>", "run", "build:ui", "--workspace", worker.workspace, "--", "--outDir", join(work, "ui", worker.name)], cwd: root, label: `${worker.name} isolated UI build` });
    const args = ["<local-wrangler-bin>", "deploy"]; if (worker.entry) args.push(worker.entry); args.push("--dry-run", "--outdir", outdir, "--config", worker.config); if (worker.ui) args.push("--assets", join(work, "ui", worker.name));
    plan.push({ executable: process.execPath, args, cwd: join(root, worker.directory), label: `${worker.name} Worker dry-run bundle`, outdir });
  }
  return plan;
}
function directoryHasFiles(directory) { return existsSync(directory) && readdirSync(directory, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile()); }
function runWorkerAssembly({ root = repositoryRoot, outputDirectory, run = commandResult }) {
  const localWrangler = localWranglerBinary(root);
  const localNpm = createRequire(join(root, "package.json")).resolve("npm/bin/npm-cli.js");
  for (const command of planWorkerAssembly(outputDirectory, root)) { const args = command.args.map((arg) => arg === "<local-wrangler-bin>" ? localWrangler : arg === "<local-npm-cli>" ? localNpm : arg); run({ ...command, args }); if (command.outdir && !directoryHasFiles(command.outdir)) throw new Error(`${command.label} produced no bundle files`); }
  rmSync(join(outputDirectory, ".release-work"), { recursive: true, force: true });
}
function artifactPath(root, file) { return assertSafeRelativePath(relative(root, file).split(sep).join("/")); }
function walk(root, current = root) { const stat = lstatSync(current); const rel = relative(root, current); if (rel) assertSafeRelativePath(rel); if (stat.isSymbolicLink()) throw new Error(`release staging may not contain symbolic links: ${rel || "."}`); if (stat.isFile()) return [current]; if (!stat.isDirectory()) throw new Error(`unsupported release staging entry: ${rel}`); return readdirSync(current).flatMap((entry) => walk(root, join(current, entry))); }
function assertReleaseAllowlist(root, file) {
  const path = artifactPath(root, file); if (METADATA_FILES.has(path)) return path;
  if (/^workers\/(?:licensing-backend|license-admin|customer-portal|d1-backup)\/.+/.test(path) || /^python\/[^/]+\.(?:whl|tar\.gz)$/.test(path) || /^dotnet\/[^/]+\.(?:nupkg|snupkg)$/.test(path) || /^cpp\/licensecc-cpp-sdk-[a-z0-9][a-z0-9-]*-[0-9A-Za-z][0-9A-Za-z.+_-]*\.tar$/.test(path)) return path;
  throw new Error(`release artifact is outside the allowlist: ${path}`);
}
function payloadRecords(outputDirectory) { return walk(outputDirectory).map((file) => assertReleaseAllowlist(outputDirectory, file)).filter((path) => !METADATA_FILES.has(path)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((path) => { const bytes = readFileSync(join(outputDirectory, path)); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }); }
function licenseInputs(root) {
  return [
    ["LICENSE", "AGPL-3.0-or-later"], ["sdks/python/LICENSE", "AGPL-3.0-or-later"], ["sdks/dotnet/src/Licensecc.Client/LICENSE", "AGPL-3.0-or-later"], ["extern/license-generator/LICENSE", "BSD-3-Clause"], ["extern/license-generator/PROVENANCE.md", "NOASSERTION"],
  ].map(([path, licenseConcluded]) => ({ path, licenseConcluded, sha256: sha256(gitBlob(root, path)) }));
}
function verifyPackageVersions(records, platformVersion, pythonVersion, requireDotnet = true) {
  if (!records.some((record) => record.path.startsWith("python/") && record.path.includes(`-${pythonVersion}`) && record.path.endsWith(".whl")) || !records.some((record) => record.path.startsWith("python/") && record.path.includes(`-${pythonVersion}`) && record.path.endsWith(".tar.gz"))) throw new Error(`Python artifacts do not carry ${pythonVersion}`);
  const nugetBase = `Licensecc.Client.${platformVersion}`;
  if (requireDotnet && (!records.some((record) => record.path === `dotnet/${nugetBase}.nupkg`) || !records.some((record) => record.path === `dotnet/${nugetBase}.snupkg` || record.path === `dotnet/${nugetBase}.symbols.nupkg`))) throw new Error(`NuGet primary and symbols artifacts must carry ${platformVersion}`);
}
function writeReleaseMetadata({ root = repositoryRoot, outputDirectory, consumerId, versions = repositoryVersions(root), incomplete = false }) {
  const { platformVersion, pythonVersion, cppVersion, commit, sourceDate } = versions; const consumer = safeConsumerId(consumerId); const artifacts = payloadRecords(outputDirectory); verifyPackageVersions(artifacts, platformVersion, pythonVersion, !incomplete);
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length || !WORKERS.every((worker) => artifacts.some((artifact) => artifact.path.startsWith(`workers/${worker.name}/`))) || !artifacts.some((artifact) => artifact.path.startsWith("cpp/"))) throw new Error("release staging is missing a required payload");
  writeFileSync(join(outputDirectory, "checksums.sha256"), artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n");
  const inputs = licenseInputs(root); const packageIds = artifacts.map((_, index) => `SPDXRef-Package-${index + 1}`); const packageVersion = (artifact) => artifact.path.startsWith("python/") ? pythonVersion : artifact.path.startsWith("cpp/") ? cppVersion : platformVersion; const spdx = { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `licensecc-${platformVersion}`, documentNamespace: `https://github.com/open-license-manager/licensecc/releases/${platformVersion}/${cppVersion}/${pythonVersion}/${consumer}/${commit}/spdx`, creationInfo: { created: sourceDate, creators: ["Tool: licensecc-release-artifacts"] }, documentDescribes: packageIds, packages: artifacts.map((artifact, index) => ({ SPDXID: packageIds[index], name: artifact.path, versionInfo: packageVersion(artifact), supplier: "NOASSERTION", originator: "NOASSERTION", downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION", checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }] })), files: inputs.map((input, index) => ({ SPDXID: `SPDXRef-License-Input-${index + 1}`, fileName: input.path, checksums: [{ algorithm: "SHA256", checksumValue: input.sha256 }], licenseConcluded: input.licenseConcluded, licenseInfoInFiles: [input.licenseConcluded], copyrightText: "NOASSERTION" })) };
  writeFileSync(join(outputDirectory, "spdx.json"), `${JSON.stringify(spdx, null, 2)}\n`);
  const manifest = { format: "licensecc-release-manifest-v1", platform_version: platformVersion, python_version: pythonVersion, cpp_version: cppVersion, consumer_id: consumer, commit, incomplete, artifacts, spdx: "spdx.json" };
  writeFileSync(join(outputDirectory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`); return manifest;
}
function inspectReleaseDirectory(outputDirectory, { root = repositoryRoot } = {}) {
  const files = walk(outputDirectory); for (const file of files) assertReleaseAllowlist(outputDirectory, file);
  for (const metadata of METADATA_FILES) if (!existsSync(join(outputDirectory, metadata))) throw new Error(`release staging is missing ${metadata}`);
  const manifest = JSON.parse(readFileSync(join(outputDirectory, "release-manifest.json"), "utf8")); const versions = repositoryVersions(root); if (manifest.format !== "licensecc-release-manifest-v1" || manifest.spdx !== "spdx.json" || !Array.isArray(manifest.artifacts) || manifest.platform_version !== versions.platformVersion || manifest.python_version !== versions.pythonVersion || manifest.cpp_version !== versions.cppVersion || manifest.commit !== versions.commit || !safeConsumerId(manifest.consumer_id)) throw new Error("unsupported release manifest");
  const actual = payloadRecords(outputDirectory); if (JSON.stringify(actual) !== JSON.stringify(manifest.artifacts)) throw new Error("release manifest payload set does not exactly match staging"); verifyPackageVersions(actual, manifest.platform_version, manifest.python_version, !manifest.incomplete);
  const expectedChecksums = actual.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n"; if (readFileSync(join(outputDirectory, "checksums.sha256"), "utf8") !== expectedChecksums) throw new Error("release checksums do not match payloads");
  const spdx = JSON.parse(readFileSync(join(outputDirectory, "spdx.json"), "utf8")); const expectedPackages = actual.map((artifact, index) => ({ SPDXID: `SPDXRef-Package-${index + 1}`, name: artifact.path, versionInfo: artifact.path.startsWith("python/") ? versions.pythonVersion : artifact.path.startsWith("cpp/") ? versions.cppVersion : versions.platformVersion, checksumValue: artifact.sha256 })); const expectedNamespace = `https://github.com/open-license-manager/licensecc/releases/${versions.platformVersion}/${versions.cppVersion}/${versions.pythonVersion}/${manifest.consumer_id}/${versions.commit}/spdx`; if (spdx.spdxVersion !== "SPDX-2.3" || spdx.documentNamespace !== expectedNamespace || spdx.creationInfo?.created !== versions.sourceDate || JSON.stringify(spdx.documentDescribes) !== JSON.stringify(expectedPackages.map((entry) => entry.SPDXID)) || JSON.stringify(spdx.packages?.map((entry) => ({ SPDXID: entry.SPDXID, name: entry.name, versionInfo: entry.versionInfo, checksumValue: entry.checksums?.[0]?.checksumValue }))) !== JSON.stringify(expectedPackages) || !Array.isArray(spdx.files)) throw new Error("invalid SPDX document");
  const expectedInputs = licenseInputs(root).map(({ path, sha256: hash, licenseConcluded }) => ({ path, sha256: hash, licenseConcluded })); if (JSON.stringify(spdx.files.map(({ fileName, checksums, licenseConcluded }) => ({ path: fileName, sha256: checksums[0]?.checksumValue, licenseConcluded }))) !== JSON.stringify(expectedInputs)) throw new Error("SPDX license inputs are not authentic canonical blobs"); return manifest;
}
function assembleReleaseArtifacts({ root = repositoryRoot, outputDirectory, consumerId, expectedPlatformVersion, expectedPythonVersion, allowPartial = false, run = commandResult, verifyArchive = verifyArchiveGenerator, toolAvailable = (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0 }) {
  const output = resolve(outputDirectory); const source = resolve(root); const permittedInternal = resolve(source, "build", "release-artifacts"); const equal = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; const within = (child, parent) => equal(child.slice(0, parent.length), parent) && child.length > parent.length && child[parent.length] === sep; if (equal(output, source) || (within(output, source) && !within(output, permittedInternal))) throw new Error("release output must be outside the repository or beneath build/release-artifacts"); const versions = repositoryVersions(root); if ((expectedPlatformVersion !== undefined && expectedPlatformVersion !== versions.platformVersion) || (expectedPythonVersion !== undefined && expectedPythonVersion !== versions.pythonVersion)) throw new Error("supplied expected version does not match tracked version authority"); if (existsSync(output)) throw new Error(`release staging output already exists: ${output}`); safeConsumerId(consumerId); mkdirSync(output, { recursive: true });
  try {
    runWorkerAssembly({ root, outputDirectory: output, run });
    run({ executable: "uv", args: ["build", "--locked", "--directory", join(root, "sdks/python"), "--wheel", "--sdist", "--out-dir", join(output, "python")], cwd: root, label: "locked Python wheel and sdist" });
    const hasDotnet = toolAvailable("dotnet"); if (!hasDotnet && !allowPartial) throw new Error("dotnet is required; use --allow-partial only for an explicitly incomplete manifest");
    if (hasDotnet) { run({ executable: "dotnet", args: ["restore", join(root, "sdks/dotnet/Licensecc.Client.sln"), "--locked-mode"], cwd: root, label: "locked NuGet restore" }); run({ executable: "dotnet", args: ["pack", join(root, "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj"), "--configuration", "Release", "--no-restore", "--include-symbols", "--include-source", `-p:PackageVersion=${versions.platformVersion}`, "--output", join(output, "dotnet")], cwd: root, label: "NuGet package and symbols" }); }
    const archive = createCppSourceArchive({ root, outputDirectory: output, consumerId, cppVersion: versions.cppVersion, platformVersion: versions.platformVersion }); verifyArchive({ archivePath: archive }); const manifest = writeReleaseMetadata({ root, outputDirectory: output, consumerId, versions, incomplete: !hasDotnet }); return inspectReleaseDirectory(output, { root });
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}
function parseArgs(argv) { const values = {}; const known = new Set(["output", "consumer-id", "expect-platform-version", "expect-python-version"]); for (let i = 2; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--allow-partial") { if (values.allowPartial) throw new Error("duplicate argument: --allow-partial"); values.allowPartial = true; continue; } if (arg === "--help") return { help: true }; const key = arg.startsWith("--") ? arg.slice(2) : ""; if (!known.has(key) || values[key] !== undefined || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`invalid argument: ${arg}`); values[key] = argv[++i]; } return values; }
function main() { const options = parseArgs(process.argv); if (options.help) return console.log("usage: node scripts/assemble-release-artifacts.mjs --output <stage> --consumer-id <consumer> [--expect-platform-version <semver>] [--expect-python-version <pep440>] [--allow-partial]"); if (!options.output || !options["consumer-id"]) throw new Error("--output and --consumer-id are required"); console.log(JSON.stringify(assembleReleaseArtifacts({ outputDirectory: options.output, consumerId: options["consumer-id"], expectedPlatformVersion: options["expect-platform-version"], expectedPythonVersion: options["expect-python-version"], allowPartial: options.allowPartial }), null, 2)); }

export { assertReleaseAllowlist, assertSafeRelativePath, assembleReleaseArtifacts, createCppSourceArchive, inspectReleaseDirectory, parseArgs, planWorkerAssembly, repositoryVersions, safeConsumerId, trackedCppFiles, validateArchiveMembers, verifyArchiveGenerator, writeReleaseMetadata };
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; } }
