import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readVersionAuthorities } from "./check-version-contract.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCAL_WRANGLER_VERSION = "4.120.0";
const REQUIRED_NPM_VERSION = "10.9.8";
const OWNER_FILE = ".release-artifacts-owner";
const METADATA_FILES = new Set(["checksums.sha256", "release-manifest.json", "spdx.json"]);
const CPP_EXACT = new Set([
  "CMakeLists.txt",
  "LICENSE",
  "extern/license-generator/CMakeLists.txt",
  "extern/license-generator/LICENSE",
  "extern/license-generator/PROVENANCE.md",
]);
const CPP_PREFIXES = ["cmake/", "include/", "src/", "extern/license-generator/cmake/", "extern/license-generator/src/"];
const WORKERS = [
  { name: "licensing-backend", workspace: "@licensecc/cloudflare-licensing-backend", directory: "services/cloudflare-licensing-backend", config: "wrangler.example.toml", entry: "src/index.ts" },
  { name: "license-admin", workspace: "@licensecc/cloudflare-license-admin", directory: "services/cloudflare-license-admin", config: "wrangler.example.jsonc", ui: true },
  { name: "customer-portal", workspace: "@licensecc/cloudflare-customer-portal", directory: "services/cloudflare-customer-portal", config: "wrangler.example.jsonc", ui: true },
  { name: "d1-backup", workspace: "@licensecc/cloudflare-d1-backup", directory: "services/cloudflare-d1-backup", config: "wrangler.example.jsonc" },
];
const FORBIDDEN_SEGMENTS = new Set([".git", ".wrangler", "node_modules", "build", "dist", "dist-worker", "bin", "obj", "install", "projects", "test-results", "coverage", "database", "databases"]);
const FORBIDDEN_ARTIFACT_NAME = /(?:^\.dev\.vars(?:$|\.)|^wrangler\.(?:toml|jsonc)$|^id_rsa(?:\.pub)?$|private[-_.]?key|secret|\.(?:pem|key|pfx|p12|rsa|db|sqlite|sqlite3)$)/iu;
const FORBIDDEN_CANONICAL_NAME = /(?:^\.dev\.vars(?:$|\.)|^wrangler\.(?:toml|jsonc)$|^id_rsa(?:\.pub)?$|\.(?:pem|key|pfx|p12|rsa|db|sqlite|sqlite3)$)/iu;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function ordinal(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) throw new Error(`unsafe artifact path: ${JSON.stringify(value)}`);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === ".." || FORBIDDEN_SEGMENTS.has(part.toLowerCase()) || FORBIDDEN_ARTIFACT_NAME.test(part))) throw new Error(`unsafe artifact path: ${JSON.stringify(value)}`);
  return normalized;
}

function assertSafeCanonicalPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) throw new Error(`unsafe canonical source path: ${JSON.stringify(value)}`);
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === ".." || part === ".git" || FORBIDDEN_CANONICAL_NAME.test(part))) throw new Error(`unsafe canonical source path: ${JSON.stringify(value)}`);
  return normalized;
}

function safeConsumerId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value)) throw new Error("--consumer-id must be a lowercase consumer identifier (letters, digits, hyphens)");
  return value;
}

function safeVersion(value) {
  if (typeof value !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(value)) throw new Error("release versions must be simple identifiers");
  return value;
}

function commandResult(command) {
  const result = spawnSync(command.executable, command.args, { cwd: command.cwd, encoding: "utf8", env: command.env });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4000);
    throw new Error(`${command.label} failed${result.status === null || result.status === undefined ? "" : ` (${result.status})`}${output ? `: ${output}` : ""}`);
  }
  return result;
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "buffer" });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout;
}

function gitBlob(root, path) {
  return git(root, ["cat-file", "blob", `HEAD:${path}`]);
}

function gitHeadEntries(root) {
  return git(root, ["ls-tree", "-r", "-z", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+)\s+(\w+)\s+([0-9a-f]{40})\t(.+)$/u.exec(entry);
      if (!match) throw new Error("invalid Git tree entry while materializing canonical release source");
      return { mode: match[1], type: match[2], object: match[3], path: match[4] };
    })
    .sort((left, right) => ordinal(left.path, right.path));
}

function isCppPath(path) {
  return CPP_EXACT.has(path) || CPP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function trackedCppFiles(root) {
  const tracked = gitHeadEntries(root).filter((entry) => entry.type === "blob" && entry.mode !== "120000" && isCppPath(entry.path)).map((entry) => assertSafeRelativePath(entry.path));
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "CMakeLists.txt", "LICENSE", "cmake", "include", "src", "extern/license-generator"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (untracked.length > 0) throw new Error(`untracked C++ release input: ${untracked.sort(ordinal).join(", ")}`);
  return tracked.sort(ordinal);
}

function readDotnetPackageId(readSource) {
  const source = readSource("sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj");
  const values = [...source.matchAll(/<PackageId>\s*([^<\s]+)\s*<\/PackageId>/gu)].map((match) => match[1]);
  if (values.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u.test(values[0])) throw new Error("tracked .NET package identity is invalid");
  return values[0];
}

function repositoryVersions(root) {
  const authority = readVersionAuthorities({ root, readSource: (path) => gitBlob(root, path).toString("utf8") });
  if (!authority.versions || authority.errors.length > 0 || !authority.versions.cppVersion) throw new Error(`tracked release version authority is invalid: ${authority.errors.map((error) => error.path).join(", ")}`);
  const commit = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error("release assembly requires a full Git HEAD commit");
  const seconds = Number(git(root, ["show", "-s", "--format=%ct", "HEAD"]).toString("utf8").trim());
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Git commit timestamp is invalid");
  return {
    ...authority.versions,
    dotnetPackageId: readDotnetPackageId((path) => gitBlob(root, path).toString("utf8")),
    commit,
    sourceDate: new Date(seconds * 1000).toISOString(),
  };
}

function realpath(value) {
  return realpathSync.native ? realpathSync.native(value) : realpathSync(value);
}

function samePath(left, right) {
  const normalized = (value) => resolve(value).replaceAll("/", "\\").replace(/[\\/]+$/u, "");
  const first = normalized(left);
  const second = normalized(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function pathWithin(child, parent, { allowEqual = false } = {}) {
  const distance = relative(resolve(parent), resolve(child));
  if (distance === "") return allowEqual;
  return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

function nearestExistingAncestor(value) {
  let cursor = resolve(value);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (samePath(parent, cursor)) throw new Error(`no existing ancestor for release output: ${value}`);
    cursor = parent;
  }
  return cursor;
}

/** Reject symlink and Windows junction/reparse components before cleanup can touch them. */
function assertNoReparseComponents(value) {
  const absolute = resolve(value);
  const parsed = parse(absolute);
  let cursor = parsed.root;
  const segments = relative(parsed.root, absolute).split(/[\\/]/u).filter(Boolean);
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`release output traverses a symlink or junction: ${cursor}`);
    if (process.platform === "win32" && !samePath(realpath(cursor), cursor)) throw new Error(`release output traverses a reparse alias: ${cursor}`);
  }
}

/**
 * An output is either wholly outside the checkout or a child of the one
 * repository-owned release staging root.  Lexical and physical checks are both
 * necessary because a junction can make an apparently safe spelling point back
 * at source.
 */
function assertReleaseOutputBoundary({ root = repositoryRoot, outputDirectory, requireExists = false }) {
  const source = resolve(root);
  if (!existsSync(source)) throw new Error(`release source does not exist: ${source}`);
  const output = resolve(outputDirectory);
  const permitted = resolve(source, "build", "release-artifacts");
  const sourceReal = realpath(source);
  const lexicalInsideSource = pathWithin(output, source, { allowEqual: true });
  if (samePath(output, source) || (lexicalInsideSource && !pathWithin(output, permitted))) throw new Error("release output must be outside the repository or beneath build/release-artifacts");

  const ancestor = nearestExistingAncestor(output);
  assertNoReparseComponents(ancestor);
  const ancestorReal = realpath(ancestor);
  if (!lexicalInsideSource && pathWithin(ancestorReal, sourceReal, { allowEqual: true })) throw new Error("release output resolves into the repository through an alias");
  if (lexicalInsideSource && !pathWithin(ancestorReal, sourceReal, { allowEqual: true })) throw new Error("release output leaves the repository through an alias");

  if (requireExists) {
    if (!existsSync(output)) throw new Error(`release staging output does not exist: ${output}`);
    assertNoReparseComponents(output);
    const outputReal = realpath(output);
    if (lexicalInsideSource) {
      const permittedReal = realpath(permitted);
      if (!pathWithin(outputReal, permittedReal)) throw new Error("release output escaped build/release-artifacts through an alias");
    } else if (pathWithin(outputReal, sourceReal, { allowEqual: true })) {
      throw new Error("release output resolves into the repository through an alias");
    }
  }
  return { source, output, permitted };
}

function ownerText({ source, output }) {
  return `licensecc-release-artifacts-v1\n${source}\n${output}\n`;
}

function claimOwnedOutput({ root, outputDirectory }) {
  const verified = assertReleaseOutputBoundary({ root, outputDirectory, requireExists: true });
  const marker = join(verified.output, OWNER_FILE);
  writeFileSync(marker, ownerText(verified), { flag: "wx" });
  return { ...verified, marker, owner: ownerText(verified) };
}

function prepareOwnedOutput({ root, outputDirectory }) {
  const boundary = assertReleaseOutputBoundary({ root, outputDirectory });
  if (existsSync(boundary.output)) throw new Error(`release staging output already exists: ${boundary.output}`);
  mkdirSync(boundary.output, { recursive: true });
  return claimOwnedOutput({ root, outputDirectory: boundary.output });
}

/** Keep MSVC's CMake probe short while still confining it below build/. */
function prepareOwnedVerifierOutput(root) {
  const source = resolve(root);
  const parent = join(source, "build", "release-artifacts");
  const ancestor = nearestExistingAncestor(parent);
  assertNoReparseComponents(ancestor);
  mkdirSync(parent, { recursive: true });
  assertNoReparseComponents(parent);
  const output = mkdtempSync(join(parent, ".rv-"));
  try {
    return claimOwnedOutput({ root: source, outputDirectory: output });
  } catch (error) {
    if (existsSync(output) && !lstatSync(output).isSymbolicLink()) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function ownsStaging(staging) {
  try {
    const checked = assertReleaseOutputBoundary({ root: staging.source, outputDirectory: staging.output, requireExists: true });
    const marker = join(checked.output, OWNER_FILE);
    return lstatSync(marker).isFile() && readFileSync(marker, "utf8") === staging.owner;
  } catch {
    return false;
  }
}

function removeOwnedChild(staging, child) {
  if (!pathWithin(child, staging.output) || !ownsStaging(staging) || !existsSync(child)) return;
  const stat = lstatSync(child);
  if (stat.isSymbolicLink()) throw new Error("owned release staging child became a symlink");
  rmSync(child, { recursive: true, force: true });
}

function cleanupOwnedStaging(staging) {
  if (!staging || !ownsStaging(staging)) return;
  rmSync(staging.output, { recursive: true, force: true });
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const cut = fileName.lastIndexOf("/");
    if (cut < 1 || Buffer.byteLength(fileName.slice(0, cut)) > 155) throw new Error(`tar path too long: ${name}`);
    prefix = fileName.slice(0, cut);
    fileName = fileName.slice(cut + 1);
  }
  const text = (value, at, length) => header.write(value, at, length, "utf8");
  const octal = (value, at, length) => text(`${value.toString(8).padStart(length - 1, "0")}\0`, at, length);
  text(fileName, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  text("ustar\0", 257, 6);
  text("00", 263, 2);
  text(prefix, 345, 155);
  text(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}

function archiveRootName({ consumerId, cppVersion, platformVersion }) {
  return `licensecc-cpp-sdk-${safeConsumerId(consumerId)}-cpp-${safeVersion(cppVersion)}-platform-${safeVersion(platformVersion)}`;
}

function createCppSourceArchive({ root = repositoryRoot, outputDirectory, consumerId, cppVersion = repositoryVersions(root).cppVersion, platformVersion = repositoryVersions(root).platformVersion }) {
  const archiveRoot = archiveRootName({ consumerId, cppVersion, platformVersion });
  const archivePath = join(outputDirectory, "cpp", `${archiveRoot}.tar`);
  const chunks = [];
  for (const path of trackedCppFiles(root)) {
    const bytes = gitBlob(root, path);
    const member = assertSafeRelativePath(`${archiveRoot}/${path}`);
    chunks.push(tarHeader(member, bytes.length), bytes);
    if (bytes.length % 512) chunks.push(Buffer.alloc(512 - (bytes.length % 512)));
  }
  chunks.push(Buffer.alloc(1024));
  mkdirSync(dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, Buffer.concat(chunks));
  return archivePath;
}

function tarString(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const value = field.subarray(0, nul === -1 ? length : nul);
  const suffix = nul === -1 ? Buffer.alloc(0) : field.subarray(nul + 1);
  if (suffix.some((byte) => byte !== 0 && byte !== 0x20) || value.includes(0)) throw new Error(`release archive has malformed ${label}`);
  const text = value.toString("utf8");
  if (text.includes("�")) throw new Error(`release archive has malformed ${label}`);
  return text;
}

function tarOctal(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const text = field.toString("ascii").replace(/[\0 ]+$/u, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`release archive has malformed ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`release archive has malformed ${label}`);
  return value;
}

function parseArchive(archivePath, { expectedRoot, expectedMembers } = {}) {
  const archive = readFileSync(archivePath);
  const entries = [];
  const seen = new Set();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = tarOctal(header, 148, 8, "header checksum");
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    if (copy.reduce((sum, byte) => sum + byte, 0) !== stored) throw new Error("release archive has an invalid header checksum");
    const name = tarString(header, 0, 100, "member name");
    const prefix = tarString(header, 345, 155, "member prefix");
    const type = header[156];
    if (type !== 0 && type !== 48) throw new Error("release archive contains a non-regular entry");
    const size = tarOctal(header, 124, 12, "member size");
    const member = assertSafeRelativePath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(member)) throw new Error("release archive contains duplicate members");
    const dataOffset = offset + 512;
    const padded = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(padded) || dataOffset + padded > archive.length) throw new Error("release archive is truncated");
    seen.add(member);
    entries.push({ member, size, dataOffset, contents: archive.subarray(dataOffset, dataOffset + size) });
    offset = dataOffset + padded;
  }
  if (offset + 1024 !== archive.length || !archive.subarray(offset, offset + 1024).every((byte) => byte === 0)) throw new Error("release archive is truncated or has trailing data");

  if (expectedRoot) {
    const prefix = `${expectedRoot}/`;
    if (entries.some((entry) => !entry.member.startsWith(prefix))) throw new Error("release archive member is outside its expected root");
    if (expectedMembers) {
      const actual = entries.map((entry) => entry.member.slice(prefix.length)).sort(ordinal);
      const expected = [...expectedMembers].sort(ordinal);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`release archive member set does not match canonical C++ inputs (expected ${expected.length}, got ${actual.length}; root=${expectedRoot})`);
    }
  }
  return entries;
}

function validateArchiveMembers(archivePath, options) {
  return parseArchive(archivePath, options);
}

function extractValidatedArchive({ archivePath, destination, expectedRoot, expectedMembers }) {
  const entries = parseArchive(archivePath, { expectedRoot, expectedMembers });
  const target = resolve(destination);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || readdirSync(target).length !== 0) throw new Error(`release archive extraction destination is not an empty owned directory: ${target}`);
  } else {
    mkdirSync(target, { recursive: true });
  }
  for (const entry of entries) {
    const file = resolve(target, entry.member);
    if (!pathWithin(file, target)) throw new Error("release archive extraction escaped its temporary root");
    const parent = dirname(file);
    mkdirSync(parent, { recursive: true });
    assertNoReparseComponents(parent);
    writeFileSync(file, entry.contents, { flag: "wx" });
  }
  return entries;
}

function findBuiltGenerator(root) {
  const names = new Set(process.platform === "win32" ? ["lccgen.exe"] : ["lccgen"]);
  const candidates = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("generator build created a symlink in release verification");
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && names.has(entry.name)) candidates.push(child);
    }
  };
  visit(root);
  if (candidates.length !== 1) throw new Error("embedded generator build did not produce one lccgen executable");
  return candidates[0];
}

function assertVerificationCommand(command, probe) {
  const inside = (value) => {
    if (!pathWithin(value, probe, { allowEqual: true })) throw new Error("release verifier command escaped its temporary root");
  };
  if (command.executable !== "cmake" || command.args.includes("--install")) throw new Error("release verifier may configure/build only; install is forbidden");
  for (let index = 0; index < command.args.length; index += 1) {
    const argument = String(command.args[index]);
    if (argument === "-S" || argument === "-B") inside(command.args[index + 1]);
    if (argument.startsWith("-DLCC_LOCATION=")) inside(argument.slice("-DLCC_LOCATION=".length));
    if (argument.startsWith("-DLCC_PROJECTS_BASE_DIR=")) inside(argument.slice("-DLCC_PROJECTS_BASE_DIR=".length));
    if (argument.startsWith("-DCMAKE_INSTALL_PREFIX=")) inside(argument.slice("-DCMAKE_INSTALL_PREFIX=".length));
  }
}

function planArchiveVerification({ archivePath, tempParent, probeDirectory, generatorExecutable } = {}) {
  const archive = resolve(archivePath);
  const parent = resolve(tempParent ?? dirname(archive));
  const archiveRoot = archive.replace(/\.tar$/iu, "").slice(archive.lastIndexOf(sep) + 1);
  const probe = resolve(probeDirectory ?? join(parent, "licensecc-release-cpp-probe-plan"));
  if (!pathWithin(probe, parent)) throw new Error("release verifier probe is not beneath its temporary parent");
  const source = join(probe, archiveRoot);
  const generatorBuild = join(probe, "generator-build");
  const runtimeBuild = join(probe, "runtime-build");
  const projects = join(runtimeBuild, "projects");
  const generator = generatorExecutable ?? join(generatorBuild, "src", "license_generator", process.platform === "win32" ? "lccgen.exe" : "lccgen");
  // The Visual Studio generator creates deeply nested try-compile projects and
  // exceeds the legacy MAX_PATH limit in a safely-contained release probe.
  // Ninja keeps the same CMake configure/build semantics without widening the
  // probe outside build/release-artifacts on Windows.
  const generatorSelection = process.platform === "win32" ? ["-G", "Ninja"] : [];
  const commands = [
    { executable: "cmake", args: ["-S", join(source, "extern/license-generator"), "-B", generatorBuild, ...generatorSelection, "-DBUILD_TESTING=OFF", `-DCMAKE_INSTALL_PREFIX=${join(probe, "generator-install")}`], cwd: probe, label: "configure embedded generator from archive" },
    { executable: "cmake", args: ["--build", generatorBuild, "--target", "lccgen", "--config", "Release"], cwd: probe, label: "build embedded generator from archive" },
    { executable: "cmake", args: ["-S", source, "-B", runtimeBuild, ...generatorSelection, "-DBUILD_TESTING=OFF", `-DLCC_LOCATION=${generator}`, `-DLCC_PROJECTS_BASE_DIR=${projects}`, `-DCMAKE_INSTALL_PREFIX=${join(probe, "runtime-install")}`], cwd: probe, label: "configure extracted runtime from archive" },
    { executable: "cmake", args: ["--build", runtimeBuild, "--target", "licensecc_static", "--config", "Release"], cwd: probe, label: "build extracted runtime from archive" },
  ];
  for (const command of commands) assertVerificationCommand(command, probe);
  return commands;
}

/** Build only inside an owned temporary probe; never install anything. */
function verifyArchiveGenerator({ archivePath, tempParent = dirname(archivePath), expectedSha256, expectedMembers, run = commandResult, env } = {}) {
  const archive = resolve(archivePath);
  const parent = resolve(tempParent);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  assertNoReparseComponents(parent);
  if (!pathWithin(archive, dirname(archive), { allowEqual: true })) throw new Error("release archive path is invalid");
  if (expectedSha256 !== undefined && sha256(readFileSync(archive)) !== expectedSha256) throw new Error("release archive changed before verification");
  const archiveRoot = archive.replace(/\.tar$/iu, "").slice(archive.lastIndexOf(sep) + 1);
  if (!/^licensecc-cpp-sdk-[a-z0-9][a-z0-9-]*-cpp-[0-9A-Za-z.+_-]+-platform-[0-9A-Za-z.+_-]+$/u.test(archiveRoot)) throw new Error("archive path is not an explicit release archive");
  const probe = mkdtempSync(join(parent, "licensecc-release-cpp-probe-"));
  if (!pathWithin(probe, parent)) throw new Error("release verifier probe escaped its temporary parent");
  try {
    extractValidatedArchive({ archivePath: archive, destination: probe, expectedRoot: archiveRoot, expectedMembers });
    const initial = planArchiveVerification({ archivePath: archive, tempParent: parent, probeDirectory: probe });
    for (const command of initial.slice(0, 2)) run({ ...command, env });
    const generator = findBuiltGenerator(join(probe, "generator-build"));
    const finalPlan = planArchiveVerification({ archivePath: archive, tempParent: parent, probeDirectory: probe, generatorExecutable: generator });
    for (const command of finalPlan.slice(2)) run({ ...command, env });
  } finally {
    // `probe` was freshly created below the already-validated parent; no
    // install command or cleanup target can resolve outside that parent.
    if (pathWithin(probe, parent) && existsSync(probe) && !lstatSync(probe).isSymbolicLink()) rmSync(probe, { recursive: true, force: true });
  }
}

function shouldExcludeCanonicalEntry(path) {
  // The release source never configures generator tests.  Excluding their
  // fixture keys prevents even vendored test keys from entering the temporary
  // release build tree while retaining every production source input.
  return path.startsWith("extern/license-generator/test/");
}

/** Materialize regular Git HEAD blobs only.  No mutable checkout files survive. */
function createCanonicalHeadTree({ root = repositoryRoot, destination }) {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error(`canonical release source already exists: ${target}`);
  mkdirSync(target, { recursive: true });
  try {
    for (const entry of gitHeadEntries(root)) {
      if (shouldExcludeCanonicalEntry(entry.path)) continue;
      if (entry.type !== "blob" || entry.mode === "120000") throw new Error(`canonical release source rejects non-regular Git entry: ${entry.path}`);
      const path = assertSafeCanonicalPath(entry.path);
      const file = resolve(target, path);
      if (!pathWithin(file, target)) throw new Error("canonical release source escaped its temporary tree");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, gitBlob(root, path), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    return target;
  } catch (error) {
    if (existsSync(target) && !lstatSync(target).isSymbolicLink()) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function sanitizedEnvironment(canonicalRoot) {
  const home = join(canonicalRoot, ".release-tool-home");
  const temporary = join(canonicalRoot, ".release-tool-temp");
  const cache = join(canonicalRoot, ".release-npm-cache");
  const userConfig = join(canonicalRoot, ".release-npmrc");
  mkdirSync(home, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  mkdirSync(cache, { recursive: true });
  writeFileSync(userConfig, "audit=false\nfund=false\nupdate-notifier=false\n");
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const env = {
    PATH: inheritedPath,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    CI: "true",
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.platform === "win32") env.Path = inheritedPath;
  return env;
}

function bootstrapNpmCommand() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(dirname(process.execPath)), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && existsSync(candidate));
  if (candidates.length > 0) return { executable: process.execPath, prefix: [resolve(candidates[0])] };
  return { executable: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
}

function runCanonicalNpmInstall({ root, run, env }) {
  const npm = bootstrapNpmCommand();
  const version = run({ executable: npm.executable, args: [...npm.prefix, "--version"], cwd: root, env, label: "canonical npm version" });
  if (typeof version?.stdout !== "string" || version.stdout.trim() !== REQUIRED_NPM_VERSION) throw new Error(`release assembly requires npm ${REQUIRED_NPM_VERSION} for the canonical locked install`);
  run({ executable: npm.executable, args: [...npm.prefix, "ci"], cwd: root, env, label: "canonical locked npm ci" });
  return npm;
}

function resolveLocalModule(root, request, label) {
  try {
    return createRequire(join(root, "package.json")).resolve(request);
  } catch {
    throw new Error(`canonical locked install did not provide ${label}`);
  }
}

function localWranglerBinary(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lock.packages?.["node_modules/wrangler"]?.version !== LOCAL_WRANGLER_VERSION) throw new Error(`release assembly requires local wrangler ${LOCAL_WRANGLER_VERSION}`);
  return resolveLocalModule(root, "wrangler/bin/wrangler.js", "the pinned local Wrangler CLI");
}

function assertCanonicalWorkerInputs(root) {
  for (const worker of WORKERS) {
    const directory = join(root, worker.directory);
    const example = join(directory, worker.config);
    if (!existsSync(example) || lstatSync(example).isSymbolicLink()) throw new Error(`canonical Worker example config is missing or unsafe: ${worker.directory}/${worker.config}`);
    for (const realConfig of ["wrangler.toml", "wrangler.jsonc"]) {
      if (existsSync(join(directory, realConfig))) throw new Error(`canonical release source contains a real Wrangler config: ${worker.directory}/${realConfig}`);
    }
  }
}

function planWorkerAssembly(outputDirectory, root = repositoryRoot) {
  const work = join(outputDirectory, ".release-work");
  const plan = [];
  for (const worker of WORKERS) {
    const outdir = join(outputDirectory, "workers", worker.name);
    if (worker.ui) plan.push({ executable: process.execPath, args: ["<resolved-npm-cli>", "run", "build:ui", "--workspace", worker.workspace, "--", "--outDir", join(work, "ui", worker.name)], cwd: root, label: `${worker.name} isolated UI build` });
    const args = ["<local-wrangler-bin>", "deploy"];
    if (worker.entry) args.push(worker.entry);
    args.push("--dry-run", "--outdir", outdir, "--config", join(root, worker.directory, worker.config));
    if (worker.ui) args.push("--assets", join(work, "ui", worker.name));
    plan.push({ executable: process.execPath, args, cwd: join(root, worker.directory), label: `${worker.name} Worker dry-run bundle`, outdir });
  }
  return plan;
}

function directoryHasFiles(directory) {
  return existsSync(directory) && readdirSync(directory, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile());
}

function runWorkerAssembly({ root, outputDirectory, run, env, staging, npm }) {
  assertCanonicalWorkerInputs(root);
  const localWrangler = localWranglerBinary(root);
  try {
    for (const command of planWorkerAssembly(outputDirectory, root)) {
      if (command.args[0] === "<resolved-npm-cli>") {
        run({ ...command, executable: npm.executable, args: [...npm.prefix, ...command.args.slice(1)], env });
      } else {
        const args = command.args.map((argument) => argument === "<local-wrangler-bin>" ? localWrangler : argument);
        run({ ...command, args, env });
      }
      if (command.outdir && !directoryHasFiles(command.outdir)) throw new Error(`${command.label} produced no bundle files`);
    }
  } finally {
    removeOwnedChild(staging, join(outputDirectory, ".release-work"));
  }
}

function artifactPath(root, file) {
  return assertSafeRelativePath(relative(root, file).split(sep).join("/"));
}

function walk(root, current = root) {
  const stat = lstatSync(current);
  const rel = relative(root, current);
  if (rel) assertSafeRelativePath(rel);
  if (stat.isSymbolicLink()) throw new Error(`release staging may not contain symbolic links: ${rel || "."}`);
  if (stat.isFile()) return [current];
  if (!stat.isDirectory()) throw new Error(`unsupported release staging entry: ${rel || "."}`);
  return readdirSync(current, { withFileTypes: true }).sort((left, right) => ordinal(left.name, right.name)).flatMap((entry) => walk(root, join(current, entry.name)));
}

function assertReleaseAllowlist(root, file, { allowOwnerMarker = false } = {}) {
  const path = artifactPath(root, file);
  if (allowOwnerMarker && path === OWNER_FILE) return path;
  if (METADATA_FILES.has(path)) return path;
  if (/^workers\/(?:licensing-backend|license-admin|customer-portal|d1-backup)\/.+/u.test(path) || /^python\/[^/]+\.(?:whl|tar\.gz)$/u.test(path) || /^dotnet\/[^/]+\.(?:nupkg|snupkg)$/u.test(path) || /^cpp\/licensecc-cpp-sdk-[a-z0-9][a-z0-9-]*-cpp-[0-9A-Za-z.+_-]+-platform-[0-9A-Za-z.+_-]+\.tar$/u.test(path)) return path;
  throw new Error(`release artifact is outside the allowlist: ${path}`);
}

function payloadRecords(outputDirectory, options) {
  return walk(outputDirectory)
    .map((file) => assertReleaseAllowlist(outputDirectory, file, options))
    .filter((path) => !METADATA_FILES.has(path) && path !== OWNER_FILE)
    .sort(ordinal)
    .map((path) => {
      const bytes = readFileSync(join(outputDirectory, path));
      return { path, bytes: bytes.length, sha256: sha256(bytes) };
    });
}

function licenseInputs(root) {
  return [
    ["LICENSE", "AGPL-3.0-or-later"],
    ["sdks/python/LICENSE", "AGPL-3.0-or-later"],
    ["sdks/dotnet/src/Licensecc.Client/LICENSE", "AGPL-3.0-or-later"],
    ["extern/license-generator/LICENSE", "BSD-3-Clause"],
    ["extern/license-generator/PROVENANCE.md", "NOASSERTION"],
  ].map(([path, licenseConcluded]) => ({ path, licenseConcluded, sha256: sha256(gitBlob(root, path)) }));
}

function expectedArtifactIdentity({ consumerId, versions }) {
  const archiveRoot = archiveRootName({ consumerId, cppVersion: versions.cppVersion, platformVersion: versions.platformVersion });
  return {
    cpp: `cpp/${archiveRoot}.tar`,
    python: [
      `python/licensecc-${versions.pythonVersion}-py3-none-any.whl`,
      `python/licensecc-${versions.pythonVersion}.tar.gz`,
    ],
    dotnet: [
      `dotnet/${versions.dotnetPackageId}.${versions.platformVersion}.nupkg`,
      `dotnet/${versions.dotnetPackageId}.${versions.platformVersion}.snupkg`,
    ],
  };
}

function verifyPackageVersions(records, versions, consumerId, { incomplete = false, payloadRoot, repositoryRoot: canonicalRepositoryRoot } = {}) {
  const identity = expectedArtifactIdentity({ consumerId, versions });
  const exactSubset = (prefix, expected) => {
    const actual = records.filter((record) => record.path.startsWith(prefix)).map((record) => record.path).sort(ordinal);
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(ordinal))) throw new Error(`${prefix.slice(0, -1)} artifacts do not carry the exact expected identity`);
  };
  exactSubset("python/", identity.python);
  if (incomplete) {
    if (records.some((record) => record.path.startsWith("dotnet/"))) throw new Error("incomplete release must not contain a partial NuGet payload");
  } else {
    const actual = records.filter((record) => record.path.startsWith("dotnet/")).map((record) => record.path).sort(ordinal);
    if (JSON.stringify(actual) !== JSON.stringify(identity.dotnet)) throw new Error(`NuGet primary and symbols artifacts must carry ${versions.platformVersion} for ${versions.dotnetPackageId}`);
  }
  const cpp = records.filter((record) => record.path.startsWith("cpp/"));
  if (cpp.length !== 1 || cpp[0].path !== identity.cpp) throw new Error("C++ archive does not carry the exact consumer and version identity");
  if (payloadRoot && canonicalRepositoryRoot) validateArchiveMembers(join(payloadRoot, cpp[0].path), { expectedRoot: identity.cpp.slice("cpp/".length, -".tar".length), expectedMembers: trackedCppFiles(canonicalRepositoryRoot) });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort(ordinal).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function expectedReleaseMetadata({ root, outputDirectory, consumerId, versions, incomplete, allowOwnerMarker = false }) {
  const consumer = safeConsumerId(consumerId);
  if (typeof incomplete !== "boolean") throw new Error("release manifest incomplete must be a boolean");
  const artifacts = payloadRecords(outputDirectory, { allowOwnerMarker });
  verifyPackageVersions(artifacts, versions, consumer, { incomplete, payloadRoot: outputDirectory, repositoryRoot: root });
  if (!WORKERS.every((worker) => artifacts.some((artifact) => artifact.path.startsWith(`workers/${worker.name}/`)))) throw new Error("release staging is missing a required Worker payload");
  const cppArchive = artifacts.find((artifact) => artifact.path.startsWith("cpp/"));
  const checksums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n";
  const inputs = licenseInputs(root);
  const packageIds = artifacts.map((_, index) => `SPDXRef-Package-${index + 1}`);
  const packageVersion = (artifact) => artifact.path.startsWith("python/") ? versions.pythonVersion : artifact.path.startsWith("cpp/") ? versions.cppVersion : versions.platformVersion;
  const spdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `licensecc-${versions.platformVersion}`,
    documentNamespace: `https://github.com/open-license-manager/licensecc/releases/${versions.platformVersion}/${versions.cppVersion}/${versions.pythonVersion}/${consumer}/${versions.commit}/spdx`,
    creationInfo: { created: versions.sourceDate, creators: ["Tool: licensecc-release-artifacts"] },
    documentDescribes: packageIds,
    packages: artifacts.map((artifact, index) => ({
      SPDXID: packageIds[index],
      name: artifact.path,
      versionInfo: packageVersion(artifact),
      supplier: "NOASSERTION",
      originator: "NOASSERTION",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
    })),
    files: inputs.map((input, index) => ({
      SPDXID: `SPDXRef-License-Input-${index + 1}`,
      fileName: input.path,
      checksums: [{ algorithm: "SHA256", checksumValue: input.sha256 }],
      licenseConcluded: input.licenseConcluded,
      licenseInfoInFiles: [input.licenseConcluded],
      copyrightText: "NOASSERTION",
    })),
  };
  const manifest = {
    format: "licensecc-release-manifest-v1",
    platform_version: versions.platformVersion,
    python_version: versions.pythonVersion,
    cpp_version: versions.cppVersion,
    consumer_id: consumer,
    commit: versions.commit,
    source_date: versions.sourceDate,
    incomplete,
    cpp_archive_sha256: cppArchive.sha256,
    artifacts,
    spdx: "spdx.json",
  };
  return { artifacts, checksums, manifest, spdx };
}

function writeReleaseMetadata({ root = repositoryRoot, outputDirectory, consumerId, versions = repositoryVersions(root), incomplete = false, allowOwnerMarker = false }) {
  const metadata = expectedReleaseMetadata({ root, outputDirectory, consumerId, versions, incomplete, allowOwnerMarker });
  writeFileSync(join(outputDirectory, "checksums.sha256"), metadata.checksums);
  writeFileSync(join(outputDirectory, "spdx.json"), `${JSON.stringify(metadata.spdx, null, 2)}\n`);
  writeFileSync(join(outputDirectory, "release-manifest.json"), `${JSON.stringify(metadata.manifest, null, 2)}\n`);
  return metadata.manifest;
}

function readJson(path, message) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(message);
  }
}

function inspectReleaseDirectory(outputDirectory, { root = repositoryRoot, allowOwnerMarker = false } = {}) {
  const output = resolve(outputDirectory);
  for (const file of walk(output)) assertReleaseAllowlist(output, file, { allowOwnerMarker });
  for (const metadata of METADATA_FILES) if (!existsSync(join(output, metadata))) throw new Error(`release staging is missing ${metadata}`);
  const manifest = readJson(join(output, "release-manifest.json"), "invalid release manifest");
  if (typeof manifest?.consumer_id !== "string" || typeof manifest?.incomplete !== "boolean") throw new Error("invalid release manifest");
  let expected;
  try {
    expected = expectedReleaseMetadata({ root, outputDirectory: output, consumerId: manifest.consumer_id, versions: repositoryVersions(root), incomplete: manifest.incomplete, allowOwnerMarker });
  } catch {
    throw new Error("invalid release manifest");
  }
  if (stableJson(manifest) !== stableJson(expected.manifest)) throw new Error("invalid release manifest");
  if (readFileSync(join(output, "checksums.sha256"), "utf8") !== expected.checksums) throw new Error("release checksums do not match payloads");
  const spdx = readJson(join(output, "spdx.json"), "invalid SPDX document");
  if (stableJson(spdx) !== stableJson(expected.spdx)) throw new Error("invalid SPDX document");
  return expected.manifest;
}

function assembleReleaseArtifacts({ root = repositoryRoot, outputDirectory, consumerId, expectedPlatformVersion, expectedPythonVersion, allowPartial = false, run = commandResult, verifyArchive = verifyArchiveGenerator, toolAvailable = (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0 }) {
  const versions = repositoryVersions(root);
  if ((expectedPlatformVersion !== undefined && expectedPlatformVersion !== versions.platformVersion) || (expectedPythonVersion !== undefined && expectedPythonVersion !== versions.pythonVersion)) throw new Error("supplied expected version does not match tracked version authority");
  safeConsumerId(consumerId);
  const staging = prepareOwnedOutput({ root, outputDirectory });
  try {
    const canonical = createCanonicalHeadTree({ root, destination: join(staging.output, ".canonical-head") });
    const env = sanitizedEnvironment(canonical);
    try {
      const npm = runCanonicalNpmInstall({ root: canonical, run, env });
      runWorkerAssembly({ root: canonical, outputDirectory: staging.output, run, env, staging, npm });
      run({ executable: "uv", args: ["build", "--locked", "--directory", join(canonical, "sdks/python"), "--wheel", "--sdist", "--out-dir", join(staging.output, "python")], cwd: canonical, env, label: "locked Python wheel and sdist" });
      const hasDotnet = toolAvailable("dotnet");
      if (!hasDotnet && !allowPartial) throw new Error("dotnet is required; use --allow-partial only for an explicitly incomplete manifest");
      if (hasDotnet) {
        run({ executable: "dotnet", args: ["restore", join(canonical, "sdks/dotnet/Licensecc.Client.sln"), "--locked-mode"], cwd: canonical, env, label: "locked NuGet restore" });
        run({ executable: "dotnet", args: ["pack", join(canonical, "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj"), "--configuration", "Release", "--no-restore", "--include-symbols", "--include-source", `-p:PackageVersion=${versions.platformVersion}`, "--output", join(staging.output, "dotnet")], cwd: canonical, env, label: "NuGet package and symbols" });
      }
    } finally {
      removeOwnedChild(staging, canonical);
    }
    const archive = createCppSourceArchive({ root, outputDirectory: staging.output, consumerId, cppVersion: versions.cppVersion, platformVersion: versions.platformVersion });
    const verifierStaging = prepareOwnedVerifierOutput(root);
    try {
      verifyArchive({ archivePath: archive, expectedSha256: sha256(readFileSync(archive)), expectedMembers: trackedCppFiles(root), tempParent: verifierStaging.output, run, env: sanitizedEnvironment(verifierStaging.output) });
    } finally {
      cleanupOwnedStaging(verifierStaging);
    }
    const manifest = writeReleaseMetadata({ root, outputDirectory: staging.output, consumerId, versions, incomplete: !toolAvailable("dotnet"), allowOwnerMarker: true });
    inspectReleaseDirectory(staging.output, { root, allowOwnerMarker: true });
    rmSync(staging.marker, { force: true });
    return inspectReleaseDirectory(staging.output, { root });
  } catch (error) {
    cleanupOwnedStaging(staging);
    throw error;
  }
}

function parseArgs(argv) {
  const values = {};
  const known = new Set(["output", "consumer-id", "expect-platform-version", "expect-python-version"]);
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-partial") {
      if (values.allowPartial) throw new Error("duplicate argument: --allow-partial");
      values.allowPartial = true;
      continue;
    }
    if (argument === "--help") return { help: true };
    const key = argument.startsWith("--") ? argument.slice(2) : "";
    if (!known.has(key) || values[key] !== undefined || argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new Error(`invalid argument: ${argument}`);
    values[key] = argv[++index];
  }
  return values;
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) return console.log("usage: node scripts/assemble-release-artifacts.mjs --output <stage> --consumer-id <consumer> [--expect-platform-version <semver>] [--expect-python-version <pep440>] [--allow-partial]");
  if (!options.output || !options["consumer-id"]) throw new Error("--output and --consumer-id are required");
  console.log(JSON.stringify(assembleReleaseArtifacts({ outputDirectory: options.output, consumerId: options["consumer-id"], expectedPlatformVersion: options["expect-platform-version"], expectedPythonVersion: options["expect-python-version"], allowPartial: options.allowPartial }), null, 2));
}

export {
  assertReleaseAllowlist,
  assertReleaseOutputBoundary,
  assertSafeRelativePath,
  assembleReleaseArtifacts,
  createCanonicalHeadTree,
  createCppSourceArchive,
  inspectReleaseDirectory,
  parseArgs,
  planArchiveVerification,
  planWorkerAssembly,
  repositoryVersions,
  safeConsumerId,
  trackedCppFiles,
  validateArchiveMembers,
  verifyArchiveGenerator,
  writeReleaseMetadata,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
