import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCAL_WRANGLER_VERSION = "4.120.0";
const WORKERS = [
  { name: "licensing-backend", directory: "services/cloudflare-licensing-backend", config: "wrangler.example.toml", entry: "src/index.ts" },
  { name: "license-admin", directory: "services/cloudflare-license-admin", config: "wrangler.example.jsonc" },
  { name: "customer-portal", directory: "services/cloudflare-customer-portal", config: "wrangler.example.jsonc" },
  { name: "d1-backup", directory: "services/cloudflare-d1-backup", config: "wrangler.example.jsonc" },
];
const CPP_SOURCE_INPUTS = ["CMakeLists.txt", "LICENSE", "cmake", "include", "src"];
const FORBIDDEN_SEGMENTS = new Set([".git", ".wrangler", "node_modules", "build", "dist", "dist-worker", "bin", "obj", "install", "projects", "test-results", "coverage", "database", "databases"]);
const FORBIDDEN_FILE_NAMES = /(?:^\.dev\.vars(?:$|\.)|^wrangler\.(?:toml|jsonc)$|^id_rsa(?:\.pub)?$|private[-_.]?key|secret|\.pem$|\.key$|\.pfx$|\.p12$|\.rsa$|\.(?:db|sqlite|sqlite3)$)/i;

function assertSafeRelativePath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0") || isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate)) {
    throw new Error(`unsafe artifact path: ${JSON.stringify(candidate)}`);
  }
  const normalized = candidate.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || FORBIDDEN_SEGMENTS.has(segment.toLowerCase()) || FORBIDDEN_FILE_NAMES.test(segment))) {
    throw new Error(`unsafe artifact path: ${JSON.stringify(candidate)}`);
  }
  return normalized;
}

function assertSafeTree(root, current = root) {
  const stat = lstatSync(current);
  const treeRelative = relative(root, current);
  if (treeRelative) assertSafeRelativePath(treeRelative);
  if (stat.isSymbolicLink()) {
    throw new Error(`release inputs may not contain symbolic links: ${treeRelative || "."}`);
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(current)) {
      assertSafeTree(root, join(current, entry));
    }
  }
}

function safeConsumerKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error("--consumer-key must be a lowercase consumer identifier (letters, digits, hyphens)");
  }
  return value;
}

function safeVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value)) {
    throw new Error("--version must be a simple release identifier");
  }
  return value;
}

function planWorkerDryRuns(outputDirectory, root = repositoryRoot) {
  return WORKERS.map((worker) => {
    const output = join(outputDirectory, "workers", worker.name);
    const args = ["<local-wrangler-bin>", "deploy"];
    if (worker.entry !== undefined) args.push(worker.entry);
    args.push("--dry-run", "--outdir", output, "--config", worker.config);
    return {
      executable: process.execPath,
      args,
      cwd: join(root, worker.directory),
      label: `${worker.name} Worker dry-run bundle`,
    };
  });
}

function localWranglerBinary(root = repositoryRoot) {
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lockfile.packages?.["node_modules/wrangler"]?.version !== LOCAL_WRANGLER_VERSION) {
    throw new Error(`release assembly requires local wrangler ${LOCAL_WRANGLER_VERSION}`);
  }
  const require = createRequire(join(root, "package.json"));
  return require.resolve("wrangler/bin/wrangler.js");
}

function defaultRun(command) {
  const result = spawnSync(command.executable, command.args, { cwd: command.cwd, encoding: "utf8" });
  if (result.error) throw new Error(`${command.label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command.label} failed with exit code ${result.status ?? "unknown"}`);
  return result;
}

function defaultToolAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function runWorkerDryRuns({ root = repositoryRoot, outputDirectory, run = defaultRun }) {
  const wrangler = localWranglerBinary(root);
  for (const command of planWorkerDryRuns(outputDirectory, root)) {
    const args = command.args.map((arg) => arg === "<local-wrangler-bin>" ? wrangler : arg);
    run({ ...command, args });
  }
}

function collectFiles(root, input) {
  const fullPath = resolve(root, input);
  const sourceRelative = relative(root, fullPath);
  assertSafeRelativePath(sourceRelative);
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) throw new Error(`release inputs may not contain symbolic links: ${sourceRelative}`);
  if (stat.isFile()) return [{ path: fullPath, relativePath: sourceRelative }];
  if (!stat.isDirectory()) throw new Error(`unsupported C++ source input: ${sourceRelative}`);
  const files = [];
  for (const entry of readdirSync(fullPath)) {
    files.push(...collectFiles(root, join(sourceRelative, entry)));
  }
  return files;
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const index = fileName.lastIndexOf("/");
    if (index <= 0 || Buffer.byteLength(fileName.slice(0, index)) > 155 || Buffer.byteLength(fileName.slice(index + 1)) > 100) {
      throw new Error(`tar entry name is too long: ${fileName}`);
    }
    prefix = fileName.slice(0, index);
    fileName = fileName.slice(index + 1);
  }
  const writeText = (value, offset, length) => header.write(value, offset, length, "utf8");
  const writeOctal = (value, offset, length) => writeText(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  writeText(fileName, 0, 100);
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(size, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText("ustar\0", 257, 6);
  writeText("00", 263, 2);
  writeText(prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function createCppSourceArchive({ root = repositoryRoot, outputDirectory, consumerKey, version }) {
  const consumer = safeConsumerKey(consumerKey);
  const releaseVersion = safeVersion(version);
  const archiveName = `licensecc-cpp-sdk-${consumer}-${releaseVersion}.tar`;
  const archivePath = join(outputDirectory, "cpp", archiveName);
  const archiveRoot = `licensecc-cpp-sdk-${consumer}-${releaseVersion}`;
  const inputs = CPP_SOURCE_INPUTS.flatMap((input) => collectFiles(root, input))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const chunks = [];
  for (const input of inputs) {
    const memberName = assertSafeRelativePath(`${archiveRoot}/${input.relativePath}`);
    const contents = readFileSync(input.path);
    chunks.push(tarHeader(memberName, contents.length), contents);
    const remainder = contents.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, Buffer.concat(chunks));
  return archivePath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function walkFiles(root, current = root) {
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`release staging may not contain symbolic links: ${relative(root, current) || "."}`);
  if (stat.isFile()) return [current];
  if (!stat.isDirectory()) throw new Error(`unsupported release staging entry: ${relative(root, current)}`);
  return readdirSync(current).flatMap((entry) => walkFiles(root, join(current, entry)));
}

function assertReleaseAllowlist(root, filePath) {
  const artifactPath = assertSafeRelativePath(relative(root, filePath).split(sep).join("/"));
  if (["checksums.sha256", "release-manifest.json", "spdx-inputs.json"].includes(artifactPath)) return artifactPath;
  if (/^workers\/(?:licensing-backend|license-admin|customer-portal|d1-backup)\/.+/.test(artifactPath)) return artifactPath;
  if (/^python\/[^/]+\.(?:whl|tar\.gz)$/.test(artifactPath)) return artifactPath;
  if (/^dotnet\/[^/]+\.(?:nupkg|snupkg)$/.test(artifactPath)) return artifactPath;
  if (/^cpp\/licensecc-cpp-sdk-[a-z0-9][a-z0-9-]*-[0-9A-Za-z][0-9A-Za-z.+_-]*\.tar$/.test(artifactPath)) return artifactPath;
  throw new Error(`release artifact is outside the allowlist: ${artifactPath}`);
}

function releasePayloadRecords(outputDirectory) {
  return walkFiles(outputDirectory)
    .map((filePath) => assertReleaseAllowlist(outputDirectory, filePath))
    .filter((path) => !["checksums.sha256", "release-manifest.json", "spdx-inputs.json"].includes(path))
    .sort()
    .map((path) => ({ path, sha256: sha256(join(outputDirectory, path)), bytes: lstatSync(join(outputDirectory, path)).size }));
}

function spdxInputs(root = repositoryRoot) {
  return [
    ["LICENSE", "AGPL-3.0-or-later"],
    ["sdks/python/LICENSE", "AGPL-3.0-or-later"],
    ["sdks/dotnet/src/Licensecc.Client/LICENSE", "AGPL-3.0-or-later"],
  ].map(([path, license]) => ({ path, sha256: sha256(join(root, path)), license }));
}

function writeReleaseMetadata({ root = repositoryRoot, outputDirectory, version, unavailableToolchains = [] }) {
  const artifacts = releasePayloadRecords(outputDirectory);
  if (!artifacts.some((artifact) => artifact.path.startsWith("cpp/"))) throw new Error("release staging is missing the consumer-keyed C++ source archive");
  if (!artifacts.some((artifact) => artifact.path.startsWith("workers/"))) throw new Error("release staging is missing Worker dry-run bundles");
  if (!artifacts.some((artifact) => artifact.path.startsWith("python/") && artifact.path.endsWith(".whl")) || !artifacts.some((artifact) => artifact.path.startsWith("python/") && artifact.path.endsWith(".tar.gz"))) {
    throw new Error("release staging is missing the Python wheel or source distribution");
  }
  if (!unavailableToolchains.includes("dotnet") && (!artifacts.some((artifact) => artifact.path.startsWith("dotnet/") && artifact.path.endsWith(".nupkg")) || !artifacts.some((artifact) => artifact.path.startsWith("dotnet/") && /(?:\.snupkg|\.symbols\.nupkg)$/.test(artifact.path)))) {
    throw new Error("release staging is missing the NuGet package or symbols package");
  }
  const checksums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n";
  writeFileSync(join(outputDirectory, "checksums.sha256"), checksums);
  writeFileSync(join(outputDirectory, "spdx-inputs.json"), `${JSON.stringify({ spdx_version: "SPDX-2.3", inputs: spdxInputs(root) }, null, 2)}\n`);
  const manifest = {
    SPDXID: "SPDXRef-DOCUMENT",
    SPDXVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    name: `licensecc-release-${safeVersion(version)}`,
    artifacts,
    unavailable_toolchains: [...unavailableToolchains].sort(),
    spdx_inputs: "spdx-inputs.json",
  };
  writeFileSync(join(outputDirectory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function inspectReleaseDirectory(outputDirectory) {
  const root = resolve(outputDirectory);
  assertSafeTree(root);
  const files = walkFiles(root);
  for (const filePath of files) assertReleaseAllowlist(root, filePath);
  const manifestPath = join(root, "release-manifest.json");
  const checksumsPath = join(root, "checksums.sha256");
  const spdxPath = join(root, "spdx-inputs.json");
  if (![manifestPath, checksumsPath, spdxPath].every(existsSync)) throw new Error("release staging is missing metadata or checksums");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.SPDXVersion !== "SPDX-2.3" || manifest.spdx_inputs !== "spdx-inputs.json" || !Array.isArray(manifest.artifacts)) throw new Error("release manifest is not a supported SPDX input manifest");
  for (const artifact of manifest.artifacts) {
    const path = assertReleaseAllowlist(root, join(root, artifact.path));
    if (sha256(join(root, path)) !== artifact.sha256) throw new Error(`checksum mismatch: ${path}`);
  }
  const expectedChecksums = manifest.artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n";
  if (readFileSync(checksumsPath, "utf8") !== expectedChecksums) throw new Error("release checksums do not match the manifest");
  return manifest;
}

function assembleReleaseArtifacts({ root = repositoryRoot, outputDirectory, version, consumerKey, run = defaultRun, toolAvailable = defaultToolAvailable }) {
  const output = resolve(outputDirectory);
  const repositoryStagingRoot = join(root, "build", "release-artifacts");
  if (output === root || (output.startsWith(`${root}${sep}`) && !output.startsWith(`${repositoryStagingRoot}${sep}`))) {
    throw new Error("release staging must be outside source inputs or beneath build/release-artifacts");
  }
  if (existsSync(output)) throw new Error(`release staging output already exists: ${output}`);
  safeVersion(version);
  safeConsumerKey(consumerKey);
  mkdirSync(output, { recursive: true });
  runWorkerDryRuns({ root, outputDirectory: output, run });
  run({ executable: "uv", args: ["build", "--directory", join(root, "sdks/python"), "--wheel", "--sdist", "--out-dir", join(output, "python")], cwd: root, label: "Python wheel and sdist" });
  const unavailableToolchains = [];
  if (toolAvailable("dotnet")) {
    run({ executable: "dotnet", args: ["pack", join(root, "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj"), "--configuration", "Release", "--no-restore", "--include-symbols", "--include-source", "--output", join(output, "dotnet")], cwd: root, label: "NuGet package and symbols" });
  } else {
    unavailableToolchains.push("dotnet");
  }
  createCppSourceArchive({ root, outputDirectory: output, consumerKey, version });
  writeReleaseMetadata({ root, outputDirectory: output, version, unavailableToolchains });
  return inspectReleaseDirectory(output);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!argument.startsWith("--")) throw new Error(`unexpected positional argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log("usage: node scripts/assemble-release-artifacts.mjs --output <build/release-artifacts/...|outside-source-staging-dir> --version <release> --consumer-key <consumer>");
    return;
  }
  if (!options.output || !options.version || !options["consumer-key"]) throw new Error("--output, --version, and --consumer-key are required");
  const manifest = assembleReleaseArtifacts({ outputDirectory: options.output, version: options.version, consumerKey: options["consumer-key"] });
  console.log(JSON.stringify({ ok: true, artifacts: manifest.artifacts.map((artifact) => artifact.path) }, null, 2));
}

export {
  CPP_SOURCE_INPUTS,
  WORKERS,
  assembleReleaseArtifacts,
  assertReleaseAllowlist,
  assertSafeRelativePath,
  createCppSourceArchive,
  inspectReleaseDirectory,
  planWorkerDryRuns,
  releasePayloadRecords,
  runWorkerDryRuns,
  safeConsumerKey,
  safeVersion,
  writeReleaseMetadata,
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
