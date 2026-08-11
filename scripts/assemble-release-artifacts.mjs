import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";

import { checkVersionContract, readReleaseToolchainAuthorities, readVersionAuthorities } from "./check-version-contract.mjs";

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
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_MEMBER_BYTES = 128 * 1024 * 1024;
const parsedWorkerSources = new Map();

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
  const toolchainAuthority = readReleaseToolchainAuthorities({ root, readSource: (path) => gitBlob(root, path).toString("utf8") });
  const authorityErrors = [...authority.errors, ...toolchainAuthority.errors];
  if (!authority.versions || !toolchainAuthority.toolchains || authorityErrors.length > 0 || !authority.versions.cppVersion) throw new Error(`tracked release version authority is invalid: ${authorityErrors.map((error) => error.path).join(", ")}`);
  const commit = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/iu.test(commit)) throw new Error("release assembly requires a full Git HEAD commit");
  const seconds = Number(git(root, ["show", "-s", "--format=%ct", "HEAD"]).toString("utf8").trim());
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Git commit timestamp is invalid");
  return {
    ...authority.versions,
    toolchains: toolchainAuthority.toolchains,
    dotnetPackageId: readDotnetPackageId((path) => gitBlob(root, path).toString("utf8")),
    commit,
    sourceDate: new Date(seconds * 1000).toISOString(),
    sourceDateEpoch: seconds,
  };
}

/** Check every tracked release projection from the immutable canonical HEAD tree. */
function assertCanonicalVersionContract({ sourceRoot, canonicalRoot }) {
  const trackedPaths = gitHeadEntries(sourceRoot).map((entry) => entry.path);
  const { errors } = checkVersionContract({ root: canonicalRoot, trackedPaths });
  if (errors.length > 0) {
    const locations = errors.map((error) => error.path).filter(Boolean).sort(ordinal).join(", ");
    throw new Error(`complete tracked version contract is invalid in canonical HEAD: ${locations}`);
  }
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

function assertSafePackageMemberPath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:\//u.test(value)) throw new Error(`${label} has an unsafe member path`);
  const directory = value.endsWith("/");
  const normalized = directory ? value.slice(0, -1) : value;
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === ".." || FORBIDDEN_SEGMENTS.has(part.toLowerCase()) || FORBIDDEN_ARTIFACT_NAME.test(part))) throw new Error(`${label} has an unsafe or forbidden member path`);
  return directory ? `${normalized}/` : normalized;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipError(label) {
  return new Error(`${label} is not a valid non-empty ZIP archive`);
}

/** Parse ZIP central/local records and contents without extracting or invoking archive tools. */
function readZipArchive(archivePath, label) {
  const archive = readFileSync(archivePath);
  if (archive.length < 22) throw zipError(label);
  let eocd = -1;
  const start = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw zipError(label);
  const disk = archive.readUInt16LE(eocd + 4);
  const directoryDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entries = archive.readUInt16LE(eocd + 10);
  const directoryBytes = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries || entries === 0 || entries > MAX_ARCHIVE_ENTRIES || directoryOffset + directoryBytes !== eocd) throw zipError(label);

  const files = new Map();
  const seen = new Set();
  let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== 0x02014b50) throw zipError(label);
    const flags = archive.readUInt16LE(cursor + 8);
    const compression = archive.readUInt16LE(cursor + 10);
    const storedCrc = archive.readUInt32LE(cursor + 16);
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const uncompressedBytes = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || diskStart !== 0 || compressedBytes > MAX_ARCHIVE_MEMBER_BYTES || uncompressedBytes > MAX_ARCHIVE_MEMBER_BYTES) throw zipError(label);
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = assertSafePackageMemberPath(strictUtf8(nameBytes, `${label} ZIP member name`), label);
    if (seen.has(name)) throw new Error(`${label} contains duplicate ZIP members`);
    seen.add(name);
    const mode = (externalAttributes >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new Error(`${label} contains a non-regular ZIP member`);
    if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) throw zipError(label);
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localCompression = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localCompression !== compression || dataOffset + compressedBytes > directoryOffset || !archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) throw zipError(label);
    if ((flags & 0x0008) === 0 && (archive.readUInt32LE(localOffset + 14) !== storedCrc || archive.readUInt32LE(localOffset + 18) !== compressedBytes || archive.readUInt32LE(localOffset + 22) !== uncompressedBytes)) throw zipError(label);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedBytes);
    let contents;
    try {
      contents = compression === 0 ? Buffer.from(compressed) : compression === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_MEMBER_BYTES }) : null;
    } catch {
      throw zipError(label);
    }
    if (!contents || contents.length !== uncompressedBytes || crc32(contents) !== storedCrc) throw zipError(label);
    if (name.endsWith("/")) {
      if (contents.length !== 0) throw zipError(label);
    } else {
      files.set(name, contents);
    }
    cursor = next;
  }
  if (cursor !== eocd || files.size === 0) throw zipError(label);
  return files;
}

function tarDistributionError(label) {
  return new Error(`${label} is not a valid non-empty source archive`);
}

function paxAttributes(bytes, label) {
  const source = strictUtf8(bytes, `${label} PAX header`);
  const values = {};
  let cursor = 0;
  while (cursor < source.length) {
    const space = source.indexOf(" ", cursor);
    if (space < cursor + 1 || !/^\d+$/u.test(source.slice(cursor, space))) throw tarDistributionError(label);
    const size = Number(source.slice(cursor, space));
    const end = cursor + size;
    if (!Number.isSafeInteger(size) || end > source.length || source[end - 1] !== "\n") throw tarDistributionError(label);
    const record = source.slice(space + 1, end - 1);
    const equals = record.indexOf("=");
    if (equals < 1) throw tarDistributionError(label);
    values[record.slice(0, equals)] = record.slice(equals + 1);
    cursor = end;
  }
  return values;
}

/** Parse the regular-file subset of a gzip source distribution without extracting it. */
function readSdistArchive(archivePath, label) {
  let archive;
  try {
    archive = gunzipSync(readFileSync(archivePath), { maxOutputLength: MAX_ARCHIVE_MEMBER_BYTES });
  } catch {
    throw tarDistributionError(label);
  }
  if (archive.length < 1024) throw tarDistributionError(label);
  const files = new Map();
  const seen = new Set();
  let offset = 0;
  let pendingPax = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = tarOctal(header, 148, 8, "header checksum");
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    if (copy.reduce((sum, byte) => sum + byte, 0) !== stored) throw tarDistributionError(label);
    const size = tarOctal(header, 124, 12, "member size");
    const dataOffset = offset + 512;
    const padded = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(padded) || size > MAX_ARCHIVE_MEMBER_BYTES || dataOffset + padded > archive.length) throw tarDistributionError(label);
    const type = header[156];
    const name = tarString(header, 0, 100, "member name");
    const prefix = tarString(header, 345, 155, "member prefix");
    const data = archive.subarray(dataOffset, dataOffset + size);
    if (type === 120) {
      if (pendingPax) throw tarDistributionError(label);
      pendingPax = paxAttributes(data, label);
    } else {
      if (type !== 0 && type !== 48 && type !== 53) throw new Error(`${label} contains a non-regular archive member`);
      const raw = pendingPax?.path ?? (prefix ? `${prefix}/${name}` : name);
      pendingPax = null;
      const member = assertSafePackageMemberPath(raw, label);
      if (seen.has(member)) throw new Error(`${label} contains duplicate archive members`);
      seen.add(member);
      if (type === 53 || member.endsWith("/")) {
        if (data.length !== 0) throw tarDistributionError(label);
      } else {
        files.set(member, data);
      }
    }
    offset = dataOffset + padded;
  }
  // POSIX requires two zero blocks; Python's tarfile also commonly pads the
  // final record to 10 KiB.  Accept only an all-zero tail of at least two
  // blocks, never arbitrary trailing bytes.
  const tail = archive.subarray(offset);
  if (pendingPax || tail.length < 1024 || !tail.every((byte) => byte === 0) || files.size === 0) throw tarDistributionError(label);
  return files;
}

function requiredArchiveMember(files, member, label) {
  const contents = files.get(member);
  if (!contents || contents.length === 0) throw new Error(`${label} is missing required non-empty member ${member}`);
  return contents;
}

/** Parse the RFC 822-style core metadata header section, not comments/body text. */
function metadataHeaders(contents, label) {
  const source = strictUtf8(contents, label).replaceAll("\r\n", "\n");
  if (source.includes("\r")) throw new Error(`${label} has invalid line endings`);
  const headerBlock = source.split("\n\n", 1)[0];
  if (!headerBlock) throw new Error(`${label} has no metadata headers`);
  const headers = new Map();
  let previous = null;
  for (const line of headerBlock.split("\n")) {
    if (line === "") break;
    if (/^[ \t]/u.test(line)) {
      if (!previous) throw new Error(`${label} has an invalid metadata continuation`);
      headers.get(previous).at(-1).push(line.trim());
      continue;
    }
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/u.exec(line);
    if (!match) throw new Error(`${label} has invalid metadata syntax`);
    const field = match[1].toLowerCase();
    const values = headers.get(field) ?? [];
    values.push([match[2].trim()]);
    headers.set(field, values);
    previous = field;
  }
  return headers;
}

function metadataHeader(contents, field, label) {
  const values = metadataHeaders(contents, label).get(field.toLowerCase()) ?? [];
  if (values.length !== 1) throw new Error(`${label} has invalid ${field} metadata`);
  const value = values[0].join("\n").trim();
  if (!value) throw new Error(`${label} has invalid ${field} metadata`);
  return value;
}

function csvRows(contents, label) {
  const source = strictUtf8(contents, label);
  if (source.includes("\0")) throw new Error(`${label} contains NUL`);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;
  const finishField = () => {
    row.push(field);
    field = "";
    justClosedQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field || justClosedQuote) throw new Error(`${label} has invalid CSV quoting`);
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else if (character === "\r") {
      if (source[index + 1] !== "\n") throw new Error(`${label} has invalid CSV line endings`);
      finishRow();
      index += 1;
    } else {
      if (justClosedQuote) throw new Error(`${label} has invalid CSV quoting`);
      field += character;
    }
  }
  if (quoted) throw new Error(`${label} has unterminated CSV quoting`);
  if (field || row.length > 0) finishRow();
  return rows;
}

function pythonSourceClosure(root) {
  const sourcePrefix = "sdks/python/";
  const topLevel = new Set([".gitignore", "LICENSE", "README.md", "build-constraints.txt", "pyproject.toml"]);
  const entries = [];
  for (const entry of gitHeadEntries(root)) {
    if (entry.type !== "blob" || entry.mode === "120000" || !entry.path.startsWith(sourcePrefix)) continue;
    const rest = entry.path.slice(sourcePrefix.length);
    if (rest === "uv.lock" || topLevel.has(rest)) {
      entries.push({ source: entry.path, sdist: rest });
    } else if (rest.startsWith("src/licensecc/") && rest.length > "src/licensecc/".length) {
      entries.push({ source: entry.path, wheel: rest.slice("src/".length), sdist: rest });
    } else if (rest.startsWith("tests/") && rest.length > "tests/".length) {
      entries.push({ source: entry.path, sdist: rest });
    } else {
      throw new Error(`tracked Python release input is outside the explicit package closure: ${entry.path}`);
    }
  }
  const required = ["LICENSE", "README.md", "build-constraints.txt", "pyproject.toml", "src/licensecc/__init__.py"];
  if (!required.every((path) => entries.some((entry) => entry.sdist === path))) throw new Error("tracked Python release input closure is incomplete");
  return entries.sort((left, right) => ordinal(left.source, right.source));
}

function exactMemberSet(files, expectedMembers, label) {
  const actual = [...files.keys()].sort(ordinal);
  const expected = [...expectedMembers].sort(ordinal);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} member closure is not exact (expected ${expected.length}, got ${actual.length}; actual=${actual.join(",")})`);
}

function assertCanonicalPackageBytes(files, expected, root, label) {
  for (const [member, source] of expected) {
    const actual = requiredArchiveMember(files, member, label);
    const canonical = gitBlob(root, source);
    if (!actual.equals(canonical)) throw new Error(`${label} member differs from canonical HEAD: ${member}`);
  }
}

function validateWheelRecord(wheel, recordMember, label) {
  const rows = csvRows(requiredArchiveMember(wheel, recordMember, label), `${label} RECORD`);
  const seen = new Set();
  for (const row of rows) {
    if (row.length !== 3 || !row[0]) throw new Error(`${label} RECORD has an invalid row`);
    const member = assertSafePackageMemberPath(row[0], `${label} RECORD`);
    if (!wheel.has(member) || seen.has(member)) throw new Error(`${label} RECORD is incomplete or declares an unknown member`);
    seen.add(member);
    if (member === recordMember) {
      if (row[1] !== "" || row[2] !== "") throw new Error(`${label} RECORD must omit its own hash and size`);
      continue;
    }
    const match = /^sha256=([A-Za-z0-9_-]+)$/u.exec(row[1]);
    const contents = wheel.get(member);
    if (!match || row[2] !== String(contents.length) || createHash("sha256").update(contents).digest("base64url") !== match[1]) throw new Error(`${label} RECORD hash or size is invalid for ${member}`);
  }
  if (seen.size !== wheel.size || !seen.has(recordMember)) throw new Error(`${label} RECORD does not cover every wheel member`);
}

function validatePythonArtifacts({ wheelPath, sdistPath, pythonVersion, repositoryRoot: canonicalRoot = repositoryRoot }) {
  const closure = pythonSourceClosure(canonicalRoot);
  const wheelLabel = "Python wheel";
  const wheel = readZipArchive(wheelPath, wheelLabel);
  const distInfo = `licensecc-${pythonVersion}.dist-info`;
  const wheelExpected = new Map(closure.filter((entry) => entry.wheel).map((entry) => [entry.wheel, entry.source]));
  wheelExpected.set(`${distInfo}/licenses/LICENSE`, "sdks/python/LICENSE");
  const recordMember = `${distInfo}/RECORD`;
  exactMemberSet(wheel, [...wheelExpected.keys(), `${distInfo}/METADATA`, `${distInfo}/WHEEL`, recordMember], wheelLabel);
  assertCanonicalPackageBytes(wheel, wheelExpected, canonicalRoot, wheelLabel);
  const wheelMetadata = requiredArchiveMember(wheel, `${distInfo}/METADATA`, wheelLabel);
  if (metadataHeader(wheelMetadata, "Name", `${wheelLabel} metadata`) !== "licensecc" || metadataHeader(wheelMetadata, "Version", `${wheelLabel} metadata`) !== pythonVersion) throw new Error("Python wheel metadata does not carry the expected identity");
  const wheelHeaders = metadataHeaders(requiredArchiveMember(wheel, `${distInfo}/WHEEL`, wheelLabel), `${wheelLabel} WHEEL`);
  const wheelValue = (field) => (wheelHeaders.get(field.toLowerCase()) ?? []).map((value) => value.join("\n").trim());
  if (JSON.stringify(wheelValue("Wheel-Version")) !== JSON.stringify(["1.0"]) || JSON.stringify(wheelValue("Root-Is-Purelib")) !== JSON.stringify(["true"]) || JSON.stringify(wheelValue("Tag")) !== JSON.stringify(["py3-none-any"])) throw new Error("Python wheel WHEEL metadata is invalid");
  validateWheelRecord(wheel, recordMember, wheelLabel);

  const sdistLabel = "Python sdist";
  const sdist = readSdistArchive(sdistPath, sdistLabel);
  const root = `licensecc-${pythonVersion}`;
  const sdistExpected = new Map(closure.map((entry) => [`${root}/${entry.sdist}`, entry.source]));
  exactMemberSet(sdist, [...sdistExpected.keys(), `${root}/PKG-INFO`], sdistLabel);
  assertCanonicalPackageBytes(sdist, sdistExpected, canonicalRoot, sdistLabel);
  const sdistMetadata = requiredArchiveMember(sdist, `${root}/PKG-INFO`, sdistLabel);
  if (metadataHeader(sdistMetadata, "Name", `${sdistLabel} metadata`) !== "licensecc" || metadataHeader(sdistMetadata, "Version", `${sdistLabel} metadata`) !== pythonVersion) throw new Error("Python sdist metadata does not carry the expected identity");
}

function xmlDecode(value, label) {
  let invalid = false;
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/gu.test(value)) throw new Error(`${label} has invalid XML text`);
  const decoded = value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (entity) => {
    const body = entity.slice(1, -1);
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const numeric = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) {
      invalid = true;
      return "";
    }
    return String.fromCodePoint(numeric);
  });
  if (invalid || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded)) throw new Error(`${label} has invalid XML text`);
  return decoded;
}

function xmlName(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value)) throw new Error(`${label} has an invalid XML name`);
  return value;
}

function xmlTagEnd(source, start, label) {
  let quote = null;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return cursor;
    }
  }
  throw new Error(`${label} has an unterminated XML tag`);
}

/** Minimal fail-closed XML parser for package metadata. Comments never become elements. */
function parseXml(contents, label) {
  let source = strictUtf8(contents, label);
  if (source.startsWith("\ufeff")) source = source.slice(1);
  if (!source.trim() || /<!DOCTYPE|<!ENTITY/iu.test(source)) throw new Error(`${label} has unsafe XML syntax`);
  const roots = [];
  const stack = [];
  const appendText = (value) => {
    if (!value) return;
    const decoded = xmlDecode(value, label);
    if (stack.length === 0) {
      if (decoded.trim()) throw new Error(`${label} has XML text outside its root`);
    } else {
      stack.at(-1).text.push(decoded);
    }
  };
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening === -1) {
      appendText(source.slice(cursor));
      break;
    }
    appendText(source.slice(cursor, opening));
    if (source.startsWith("<!--", opening)) {
      const end = source.indexOf("-->", opening + 4);
      if (end === -1 || source.slice(opening + 4, end).includes("--")) throw new Error(`${label} has invalid XML comment syntax`);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", opening)) {
      const end = source.indexOf("?>", opening + 2);
      if (end === -1) throw new Error(`${label} has unterminated XML processing instruction`);
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<![CDATA[", opening)) {
      const end = source.indexOf("]]>", opening + 9);
      if (end === -1) throw new Error(`${label} has unterminated XML CDATA`);
      appendText(source.slice(opening + 9, end));
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<!", opening)) throw new Error(`${label} has unsupported XML declaration`);
    const end = xmlTagEnd(source, opening + 1, label);
    const raw = source.slice(opening + 1, end).trim();
    if (raw.startsWith("/")) {
      const name = xmlName(raw.slice(1).trim(), label);
      const current = stack.pop();
      if (!current || current.name !== name) throw new Error(`${label} has mismatched XML closing tags`);
      cursor = end + 1;
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const nameMatch = /^([^\s/>]+)/u.exec(body);
    if (!nameMatch) throw new Error(`${label} has invalid XML element syntax`);
    const name = xmlName(nameMatch[1], label);
    const attributes = new Map();
    let offset = nameMatch[0].length;
    while (offset < body.length) {
      const whitespace = /^\s+/u.exec(body.slice(offset));
      if (!whitespace) throw new Error(`${label} has invalid XML attribute syntax`);
      offset += whitespace[0].length;
      if (offset >= body.length) break;
      const attribute = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])/u.exec(body.slice(offset));
      if (!attribute) throw new Error(`${label} has invalid XML attribute syntax`);
      const attributeName = xmlName(attribute[1], label);
      offset += attribute[0].length;
      const quote = attribute[2];
      const closing = body.indexOf(quote, offset);
      if (closing === -1) throw new Error(`${label} has unterminated XML attribute`);
      if (attributes.has(attributeName)) throw new Error(`${label} has duplicate XML attribute`);
      attributes.set(attributeName, xmlDecode(body.slice(offset, closing), label));
      offset = closing + 1;
    }
    const node = { name, attributes, children: [], text: [] };
    if (stack.length > 0) stack.at(-1).children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }
  if (stack.length !== 0 || roots.length !== 1) throw new Error(`${label} does not contain exactly one complete XML root`);
  return roots[0];
}

function xmlLocalName(name) {
  return name.slice(name.lastIndexOf(":") + 1);
}

function xmlChildren(node, localName) {
  return node.children.filter((child) => xmlLocalName(child.name) === localName);
}

function xmlSingleText(node, localName, label) {
  const values = xmlChildren(node, localName);
  if (values.length !== 1 || values[0].children.length !== 0) throw new Error(`${label} has invalid ${localName} metadata`);
  const value = values[0].text.join("").trim();
  if (!value) throw new Error(`${label} has invalid ${localName} metadata`);
  return value;
}

function xmlSingleDirectText(node, name, label) {
  const values = node.children.filter((child) => child.name === name);
  if (values.length !== 1 || values[0].children.length !== 0) throw new Error(`${label} has invalid ${name} metadata`);
  const value = values[0].text.join("").trim();
  if (!value) throw new Error(`${label} has invalid ${name} metadata`);
  return value;
}

function xmlAttribute(node, name, label) {
  const value = node.attributes.get(name);
  if (!value) throw new Error(`${label} is missing XML attribute ${name}`);
  return value;
}

function zipDosTimestamp(sourceDateEpoch) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error("release ZIP timestamp is invalid");
  const date = new Date(sourceDateEpoch * 1000);
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

/** Write the regular-file ZIP subset with stable entry order, compression, and time. */
function writeDeterministicZip(archivePath, files, sourceDateEpoch) {
  const entries = [...files.entries()].sort(([left], [right]) => ordinal(left, right));
  if (entries.length === 0 || entries.length > 0xffff) throw new Error("deterministic ZIP has an invalid entry count");
  const timestamp = zipDosTimestamp(sourceDateEpoch);
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const member = assertSafePackageMemberPath(name, "deterministic ZIP");
    if (member.endsWith("/") || !Buffer.isBuffer(contents) || contents.length > MAX_ARCHIVE_MEMBER_BYTES) throw new Error("deterministic ZIP contains an unsafe member");
    const nameBytes = Buffer.from(member, "utf8");
    const compressed = deflateRawSync(contents, { level: 9 });
    if (nameBytes.length > 0xffff || compressed.length > 0xffffffff || contents.length > 0xffffffff || offset > 0xffffffff) throw new Error("deterministic ZIP member exceeds ZIP32 limits");
    const crc = crc32(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(timestamp.time, 10);
    header.writeUInt16LE(timestamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(timestamp.time, 12);
    directory.writeUInt16LE(timestamp.date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(contents.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(0x81a40000, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, compressed);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  if (offset + centralBytes.length + 22 > 0xffffffff) throw new Error("deterministic ZIP exceeds ZIP32 limits");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(archivePath, Buffer.concat([...local, centralBytes, end]));
}

function canonicalNugetRelationships(packageId, corePath) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/${packageId}.nuspec" Id="Rmanifest" />\n  <Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/${corePath}" Id="Rcore" />\n</Relationships>\n`;
}

const NUGET_CORE_MEMBER = "package/services/metadata/core-properties/licensecc.release.psmdcp";
const NUGET_CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const NUGET_RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const NUGET_NUSPEC_2012_NAMESPACE = "http://schemas.microsoft.com/packaging/2012/06/nuspec.xsd";
const NUGET_NUSPEC_NAMESPACE = "http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd";
const NUGET_CORE_PROPERTIES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DUBLIN_CORE_ELEMENTS_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const DUBLIN_CORE_TERMS_NAMESPACE = "http://purl.org/dc/terms/";
const XML_SCHEMA_INSTANCE_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";
// The pinned SDK emits the 2012/06 nuspec schema.  Only that native schema
// and the current published schema are accepted; a missing/foreign namespace
// is not a valid release package.
const NUGET_NUSPEC_ROOT_NAMESPACES = new Set([NUGET_NUSPEC_2012_NAMESPACE, NUGET_NUSPEC_NAMESPACE]);
const NUGET_CORE_ROOT_NAMESPACES = new Set([NUGET_CORE_PROPERTIES_NAMESPACE]);
const NUGET_CORE_PREFIX_NAMESPACES = new Map([
  ["dc", DUBLIN_CORE_ELEMENTS_NAMESPACE],
  ["dcterms", DUBLIN_CORE_TERMS_NAMESPACE],
  ["xsi", XML_SCHEMA_INSTANCE_NAMESPACE],
]);
const NUGET_RELATIONSHIP_TYPES = Object.freeze({
  manifest: "http://schemas.microsoft.com/packaging/2010/07/manifest",
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
});

function xmlPrefix(name) {
  const separator = name.indexOf(":");
  return separator === -1 ? "" : name.slice(0, separator);
}

/** Require every relevant element to inherit the root's declared XML namespace bindings. */
function assertXmlNamespaceTree(root, { defaultNamespaces, prefixNamespaces = new Map(), label }) {
  const defaultNamespace = root.attributes.get("xmlns") ?? "";
  if (!defaultNamespaces.has(defaultNamespace)) throw new Error(`${label} has an invalid XML default namespace`);
  const bindings = new Map([["", defaultNamespace]]);
  for (const [name, value] of root.attributes) {
    if (!name.startsWith("xmlns:")) continue;
    const prefix = name.slice("xmlns:".length);
    if (prefixNamespaces.get(prefix) !== value) throw new Error(`${label} has an invalid XML namespace binding for ${prefix}`);
    bindings.set(prefix, value);
  }
  const visit = (node, rootNode) => {
    if (!rootNode) {
      for (const name of node.attributes.keys()) {
        if (name === "xmlns" || name.startsWith("xmlns:")) throw new Error(`${label} changes XML namespace bindings below the root`);
      }
    }
    const prefix = xmlPrefix(node.name);
    const namespace = bindings.get(prefix);
    if (!namespace) throw new Error(`${label} has an element with an unbound XML namespace prefix`);
    if (prefix === "" ? !defaultNamespaces.has(namespace) : prefixNamespaces.get(prefix) !== namespace) throw new Error(`${label} has an element in an unexpected XML namespace`);
    for (const child of node.children) visit(child, false);
  };
  visit(root, true);
}

function packageExtension(member) {
  const name = member.slice(member.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index >= 0 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : null;
}

function normalizeOpcTarget(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) throw new Error(`${label} has an unsafe OPC relationship target`);
  return assertSafePackageMemberPath(value.slice(1), label);
}

function validateOpcContentTypes(files, label) {
  const root = parseXml(requiredArchiveMember(files, "[Content_Types].xml", label), `${label} [Content_Types].xml`);
  assertXmlNamespaceTree(root, { defaultNamespaces: new Set([NUGET_CONTENT_TYPES_NAMESPACE]), label: `${label} [Content_Types].xml` });
  if (root.name !== "Types" || root.attributes.get("xmlns") !== NUGET_CONTENT_TYPES_NAMESPACE || root.text.join("").trim()) throw new Error(`${label} has an invalid OPC content-types root`);
  const defaults = new Map();
  const overrides = new Map();
  for (const child of root.children) {
    const local = child.name;
    if ((local !== "Default" && local !== "Override") || child.children.length !== 0 || child.text.join("").trim()) throw new Error(`${label} has an invalid OPC content-types entry`);
    const contentType = xmlAttribute(child, "ContentType", `${label} OPC content types`);
    if (local === "Default") {
      const extension = xmlAttribute(child, "Extension", `${label} OPC content types`).toLowerCase();
      if (!/^[A-Za-z0-9][A-Za-z0-9+.-]*$/u.test(extension) || defaults.has(extension)) throw new Error(`${label} has invalid or duplicate OPC default content type`);
      defaults.set(extension, contentType);
    } else {
      const part = normalizeOpcTarget(xmlAttribute(child, "PartName", `${label} OPC content types`), `${label} OPC content types`);
      if (!files.has(part) || overrides.has(part)) throw new Error(`${label} has invalid or duplicate OPC content-type override`);
      overrides.set(part, contentType);
    }
  }
  for (const member of files.keys()) {
    if (member === "[Content_Types].xml") continue;
    const type = overrides.get(member) ?? defaults.get(packageExtension(member));
    if (!type || /[\r\n]/u.test(type)) throw new Error(`${label} OPC content types do not describe ${member}`);
  }
  for (const member of overrides.keys()) {
    if (!files.has(member)) throw new Error(`${label} OPC content types reference a missing member`);
  }
  if (defaults.get("rels") !== "application/vnd.openxmlformats-package.relationships+xml" || defaults.get("psmdcp") !== "application/vnd.openxmlformats-package.core-properties+xml") throw new Error(`${label} has invalid OPC relationship/core content types`);
}

function validateNugetRelationships(files, packageId, coreMember, label) {
  const root = parseXml(requiredArchiveMember(files, "_rels/.rels", label), `${label} relationships`);
  assertXmlNamespaceTree(root, { defaultNamespaces: new Set([NUGET_RELATIONSHIP_NAMESPACE]), label: `${label} relationships` });
  if (root.name !== "Relationships" || root.attributes.get("xmlns") !== NUGET_RELATIONSHIP_NAMESPACE || root.text.join("").trim()) throw new Error(`${label} relationships have an invalid OPC root`);
  const relationships = root.children.filter((child) => child.name === "Relationship");
  if (relationships.length !== 2 || root.children.length !== relationships.length) throw new Error(`${label} relationships must contain exactly manifest and core bindings`);
  const expected = new Map([
    [NUGET_RELATIONSHIP_TYPES.manifest, `${packageId}.nuspec`],
    [NUGET_RELATIONSHIP_TYPES.core, coreMember],
  ]);
  const seenTypes = new Set();
  const seenIds = new Set();
  for (const relationship of relationships) {
    if (relationship.children.length !== 0 || relationship.text.join("").trim()) throw new Error(`${label} has an invalid OPC relationship`);
    const type = xmlAttribute(relationship, "Type", `${label} relationship`);
    const target = normalizeOpcTarget(xmlAttribute(relationship, "Target", `${label} relationship`), `${label} relationship`);
    const id = xmlAttribute(relationship, "Id", `${label} relationship`);
    if (!expected.has(type) || expected.get(type) !== target || seenTypes.has(type) || seenIds.has(id) || relationship.attributes.has("TargetMode")) throw new Error(`${label} relationships do not bind the expected package metadata`);
    seenTypes.add(type);
    seenIds.add(id);
  }
  if (seenTypes.size !== expected.size) throw new Error(`${label} relationships do not bind the expected package metadata`);
}

function nugetExpectedMembers(packageId, symbols, coreMember) {
  const common = ["[Content_Types].xml", "_rels/.rels", `${packageId}.nuspec`, coreMember];
  return symbols
    ? [...common, "lib/net8.0/Licensecc.Client.pdb"]
    : [...common, "README.md", "lib/net8.0/Licensecc.Client.dll", "lib/net8.0/Licensecc.Client.xml"];
}

function boundedSlice(bytes, offset, length, label) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) throw new Error(`${label} is truncated or has an invalid range`);
  return bytes.subarray(offset, offset + length);
}

function readU16(bytes, offset, label) {
  return boundedSlice(bytes, offset, 2, label).readUInt16LE(0);
}

function readU32(bytes, offset, label) {
  return boundedSlice(bytes, offset, 4, label).readUInt32LE(0);
}

function readU64(bytes, offset, label) {
  return boundedSlice(bytes, offset, 8, label).readBigUInt64LE(0);
}

function alignFour(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7ffffffc) throw new Error(`${label} has an invalid alignment`);
  return (value + 3) & ~3;
}

function bitCount(value) {
  let count = 0;
  for (let cursor = value; cursor !== 0n; cursor >>= 1n) count += Number(cursor & 1n);
  return count;
}

const CODED_METADATA_INDEXES = Object.freeze({
  HasConstant: { bits: 2, tables: [4, 8, 23] },
  HasCustomAttribute: { bits: 5, tables: [6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43] },
  CustomAttributeType: { bits: 3, tables: [6, 10] },
  HasCustomDebugInformation: { bits: 5, tables: [6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43, 48, 50, 51, 52, 53] },
  HasDeclSecurity: { bits: 2, tables: [2, 6, 32] },
  HasFieldMarshal: { bits: 1, tables: [4, 8] },
  HasSemantics: { bits: 1, tables: [20, 23] },
  Implementation: { bits: 2, tables: [38, 35, 39] },
  MemberForwarded: { bits: 1, tables: [4, 6] },
  MemberRefParent: { bits: 3, tables: [2, 1, 26, 6, 27] },
  MethodDefOrRef: { bits: 1, tables: [6, 10] },
  ResolutionScope: { bits: 2, tables: [0, 26, 35, 1] },
  TypeDefOrRef: { bits: 2, tables: [2, 1, 27] },
  TypeOrMethodDef: { bits: 1, tables: [2, 6] },
});

const METADATA_TABLE_SCHEMAS = new Map([
  [0, ["u2", "string", "guid", "guid", "guid"]],
  [1, ["c:ResolutionScope", "string", "string"]],
  [2, ["u4", "string", "string", "c:TypeDefOrRef", "t:4", "t:6"]],
  [3, ["t:4"]],
  [4, ["u2", "string", "blob"]],
  [5, ["t:6"]],
  [6, ["u4", "u2", "u2", "string", "blob", "t:8"]],
  [7, ["t:8"]],
  [8, ["u2", "u2", "string"]],
  [9, ["t:2", "c:TypeDefOrRef"]],
  [10, ["c:MemberRefParent", "string", "blob"]],
  [11, ["u2", "c:HasConstant", "blob"]],
  [12, ["c:HasCustomAttribute", "c:CustomAttributeType", "blob"]],
  [13, ["c:HasFieldMarshal", "blob"]],
  [14, ["u2", "c:HasDeclSecurity", "blob"]],
  [15, ["u2", "u4", "t:2"]],
  [16, ["u4", "t:4"]],
  [17, ["blob"]],
  [18, ["t:2", "t:20"]],
  [19, ["t:20"]],
  [20, ["u2", "string", "c:TypeDefOrRef"]],
  [21, ["t:2", "t:23"]],
  [22, ["t:23"]],
  [23, ["u2", "string", "blob"]],
  [24, ["u2", "t:6", "c:HasSemantics"]],
  [25, ["t:2", "c:MethodDefOrRef", "c:MethodDefOrRef"]],
  [26, ["string"]],
  [27, ["blob"]],
  [28, ["u2", "c:MemberForwarded", "string", "t:26"]],
  [29, ["u4", "t:4"]],
  [30, ["u4", "u4"]],
  [31, ["u4"]],
  [32, ["u4", "u2", "u2", "u2", "u2", "u4", "blob", "string", "string"]],
  [33, ["u4"]],
  [34, ["u4", "u4", "u4"]],
  [35, ["u2", "u2", "u2", "u2", "u4", "blob", "string", "string", "blob"]],
  [36, ["u4", "t:35"]],
  [37, ["u4", "u4", "u4", "t:35"]],
  [38, ["u4", "string", "blob"]],
  [39, ["u4", "u4", "string", "string", "c:Implementation"]],
  [40, ["u4", "u4", "string", "c:Implementation"]],
  [41, ["t:2", "t:2"]],
  [42, ["u2", "u2", "c:TypeOrMethodDef", "string"]],
  [43, ["c:MethodDefOrRef", "blob"]],
  [44, ["t:42", "c:TypeDefOrRef"]],
  [48, ["blob", "guid", "blob", "guid"]],
  [49, ["t:48", "blob"]],
  [50, ["t:6", "t:53", "t:51", "t:52", "u4", "u4"]],
  [51, ["u2", "u2", "string"]],
  [52, ["string", "blob"]],
  [53, ["t:53", "blob"]],
  [54, ["t:6", "t:6"]],
  [55, ["c:HasCustomDebugInformation", "guid", "blob"]],
]);

function metadataColumnSize(column, rows, heapSizes, label) {
  if (column === "u2") return 2;
  if (column === "u4") return 4;
  if (column === "string") return (heapSizes & 0x01) === 0 ? 2 : 4;
  if (column === "guid") return (heapSizes & 0x02) === 0 ? 2 : 4;
  if (column === "blob") return (heapSizes & 0x04) === 0 ? 2 : 4;
  if (column.startsWith("t:")) {
    const table = Number.parseInt(column.slice(2), 10);
    if (!Number.isInteger(table) || table < 0 || table >= rows.length) throw new Error(`${label} references an invalid metadata table`);
    return rows[table] < 0x10000 ? 2 : 4;
  }
  if (column.startsWith("c:")) {
    const coded = CODED_METADATA_INDEXES[column.slice(2)];
    if (!coded) throw new Error(`${label} references an unsupported coded metadata index`);
    const largest = Math.max(...coded.tables.map((table) => rows[table]));
    return largest < 2 ** (16 - coded.bits) ? 2 : 4;
  }
  throw new Error(`${label} has an unsupported metadata column`);
}

function validateMetadataTables(bytes, label, { typeSystemRows, allowedTables } = {}) {
  if (bytes.length < 24) throw new Error(`${label} metadata tables stream is truncated`);
  if (bytes[4] === 0 || bytes[7] !== 1 || (bytes[6] & ~0x07) !== 0) throw new Error(`${label} metadata tables stream has an invalid header`);
  const valid = readU64(bytes, 8, `${label} metadata tables`);
  // A producer may advertise sortability for an empty table, so `Sorted` is
  // intentionally parsed for bounds but is not required to be a subset of
  // `Valid`.  The row-count and schema closure below are authoritative.
  readU64(bytes, 16, `${label} metadata tables`);
  if (valid === 0n) throw new Error(`${label} metadata tables stream has an invalid table mask`);
  let offset = 24;
  const rows = Array(64).fill(0);
  let totalRows = 0;
  for (let table = 0; table < 64; table += 1) {
    if ((valid & (1n << BigInt(table))) === 0n) continue;
    const rowCount = readU32(bytes, offset, `${label} metadata tables row count`);
    offset += 4;
    rows[table] = rowCount;
    totalRows += rowCount;
    if (!Number.isSafeInteger(totalRows) || totalRows > MAX_ARCHIVE_ENTRIES * MAX_ARCHIVE_ENTRIES) throw new Error(`${label} metadata tables have an unreasonable row count`);
  }
  let required = 0;
  const indexRows = rows.map((rowCount, table) => rowCount || typeSystemRows?.[table] || 0);
  for (let table = 0; table < 64; table += 1) {
    if ((valid & (1n << BigInt(table))) === 0n) continue;
    if (allowedTables && !allowedTables.has(table)) throw new Error(`${label} metadata tables contain a disallowed local table ${table}`);
    const schema = METADATA_TABLE_SCHEMAS.get(table);
    if (!schema) throw new Error(`${label} metadata tables contain an unsupported table`);
    const rowSize = schema.reduce((size, column) => size + metadataColumnSize(column, indexRows, bytes[6], `${label} metadata tables`), 0);
    required += rowSize * rows[table];
    if (!Number.isSafeInteger(required) || required > bytes.length - offset) throw new Error(`${label} metadata tables stream is truncated at table ${table}`);
  }
  const trailing = bytes.length - offset - required;
  if (totalRows === 0 || trailing < 0) throw new Error(`${label} metadata tables stream is truncated (requires ${required} row bytes after ${offset} bytes of headers; has ${bytes.length - offset})`);
  // The pinned Portable-PDB writer preserves one 4-byte stream-alignment tail
  // after table data.  It is not a table row and must remain tightly bounded.
  if (trailing > 4) throw new Error(`${label} metadata tables stream has an oversized trailing region`);
  return rows;
}

function validatePortablePdbStream(bytes, label) {
  if (bytes.length < 32) throw new Error(`${label} #Pdb stream is truncated`);
  const referencedTables = readU64(bytes, 24, `${label} #Pdb stream`);
  const rows = Array(64).fill(0);
  let offset = 32;
  for (let table = 0; table < 64; table += 1) {
    if ((referencedTables & (1n << BigInt(table))) === 0n) continue;
    rows[table] = readU32(bytes, offset, `${label} #Pdb stream`);
    offset += 4;
  }
  if (offset !== 32 + bitCount(referencedTables) * 4 || offset !== bytes.length) throw new Error(`${label} #Pdb stream has invalid trailing data`);
  return rows;
}

function parseManagedMetadata(bytes, label, { portablePdb = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.subarray(0, 4).toString("ascii") !== "BSJB") throw new Error(`${label} is not managed metadata`);
  const major = readU16(bytes, 4, `${label} metadata`);
  const minor = readU16(bytes, 6, `${label} metadata`);
  if (major === 0 || minor > 0xff) throw new Error(`${label} metadata has an invalid version header`);
  const versionLength = readU32(bytes, 12, `${label} metadata`);
  if (versionLength === 0 || versionLength > 1024) throw new Error(`${label} metadata has an invalid version string length`);
  const version = strictUtf8(boundedSlice(bytes, 16, versionLength, `${label} metadata version`), `${label} metadata version`).replace(/\0+$/u, "");
  if (portablePdb ? !/^PDB v\d+\.\d+(?:\.\d+)?$/u.test(version) : !/^v\d+\.\d+(?:\.\d+)?$/u.test(version)) throw new Error(`${label} metadata has an invalid version string`);
  const header = alignFour(16 + versionLength, `${label} metadata`);
  readU16(bytes, header, `${label} metadata flags`);
  const streamCount = readU16(bytes, header + 2, `${label} metadata`);
  if (streamCount < 4 || streamCount > 64) throw new Error(`${label} metadata has an invalid stream count`);
  let offset = header + 4;
  const streams = new Map();
  const ranges = [];
  const allowedStreams = new Set(["#~", "#-", "#Strings", "#US", "#GUID", "#Blob", "#Pdb"]);
  for (let stream = 0; stream < streamCount; stream += 1) {
    const streamOffset = readU32(bytes, offset, `${label} metadata stream`);
    const streamLength = readU32(bytes, offset + 4, `${label} metadata stream`);
    const nameStart = offset + 8;
    const maximumNameEnd = Math.min(bytes.length, nameStart + 64);
    let nameEnd = -1;
    for (let cursor = nameStart; cursor < maximumNameEnd; cursor += 1) {
      if (bytes[cursor] === 0) {
        nameEnd = cursor;
        break;
      }
    }
    if (nameEnd < 0) throw new Error(`${label} metadata has an unterminated stream name`);
    const name = bytes.subarray(nameStart, nameEnd).toString("ascii");
    if (!allowedStreams.has(name) || streams.has(name)) throw new Error(`${label} metadata has an unsupported or duplicate stream`);
    offset = alignFour(nameEnd + 1, `${label} metadata stream header`);
    if (streamOffset < offset || streamLength === 0) throw new Error(`${label} metadata stream has an invalid range`);
    const contents = boundedSlice(bytes, streamOffset, streamLength, `${label} metadata stream ${name}`);
    streams.set(name, contents);
    ranges.push({ start: streamOffset, end: streamOffset + streamLength });
  }
  if (ranges.some((range) => range.start < offset)) throw new Error(`${label} metadata stream overlaps its header table`);
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) throw new Error(`${label} metadata streams overlap`);
  }
  const tableStreams = ["#~", "#-"].filter((name) => streams.has(name));
  if (tableStreams.length !== 1 || !streams.has("#Strings") || !streams.has("#GUID") || !streams.has("#Blob")) throw new Error(`${label} metadata has an incomplete stream table`);
  let typeSystemRows;
  if (portablePdb) {
    if (!streams.has("#Pdb")) throw new Error(`${label} is missing its portable PDB stream`);
    typeSystemRows = validatePortablePdbStream(streams.get("#Pdb"), label);
  }
  const tableRows = validateMetadataTables(streams.get(tableStreams[0]), label, {
    typeSystemRows,
    allowedTables: portablePdb ? new Set([48, 49, 50, 51, 52, 53, 54, 55]) : undefined,
  });
  return { streams, tableRows };
}

function validatePeDll(contents, label) {
  if (!Buffer.isBuffer(contents) || contents.length < 0x100 || contents.subarray(0, 2).toString("ascii") !== "MZ") throw new Error(`${label} is not a PE DLL`);
  const peOffset = readU32(contents, 0x3c, `${label} DOS header`);
  if (peOffset < 0x40 || boundedSlice(contents, peOffset, 24, `${label} PE header`).subarray(0, 4).toString("ascii") !== "PE\0\0") throw new Error(`${label} is not a PE DLL`);
  const machine = readU16(contents, peOffset + 4, `${label} COFF header`);
  const sectionCount = readU16(contents, peOffset + 6, `${label} COFF header`);
  const optionalSize = readU16(contents, peOffset + 20, `${label} COFF header`);
  const characteristics = readU16(contents, peOffset + 22, `${label} COFF header`);
  const optional = peOffset + 24;
  const magic = readU16(contents, optional, `${label} optional header`);
  if (![0x14c, 0x8664, 0xaa64].includes(machine) || sectionCount === 0 || sectionCount > 96 || (characteristics & 0x2000) === 0 || ![0x10b, 0x20b].includes(magic)) throw new Error(`${label} is not a PE DLL`);
  const dataDirectoryOffset = optional + (magic === 0x10b ? 96 : 112);
  const dataDirectoryCountOffset = optional + (magic === 0x10b ? 92 : 108);
  const minimumOptionalSize = dataDirectoryOffset - optional + 15 * 8;
  if (optionalSize < minimumOptionalSize || readU32(contents, dataDirectoryCountOffset, `${label} optional header`) < 15) throw new Error(`${label} PE header does not expose a CLR metadata directory`);
  const headersEnd = optional + optionalSize + sectionCount * 40;
  boundedSlice(contents, optional, optionalSize, `${label} optional header`);
  boundedSlice(contents, optional + optionalSize, sectionCount * 40, `${label} section table`);
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = optional + optionalSize + index * 40;
    const virtualSize = readU32(contents, header + 8, `${label} section`);
    const virtualAddress = readU32(contents, header + 12, `${label} section`);
    const rawSize = readU32(contents, header + 16, `${label} section`);
    const rawOffset = readU32(contents, header + 20, `${label} section`);
    const span = Math.max(virtualSize, rawSize);
    if (virtualAddress === 0 || span === 0 || (rawSize > 0 && rawOffset < headersEnd)) throw new Error(`${label} PE section table is invalid`);
    if (rawSize > 0) boundedSlice(contents, rawOffset, rawSize, `${label} section`);
    sections.push({ virtualAddress, span, rawOffset, rawSize });
  }
  sections.sort((left, right) => left.virtualAddress - right.virtualAddress);
  for (let index = 1; index < sections.length; index += 1) {
    if (sections[index - 1].virtualAddress + sections[index - 1].span > sections[index].virtualAddress) throw new Error(`${label} PE sections overlap`);
  }
  const rvaToOffset = (rva, length, rangeLabel) => {
    const section = sections.find((entry) => rva >= entry.virtualAddress && rva < entry.virtualAddress + entry.span);
    if (!section) throw new Error(`${rangeLabel} is outside the PE sections`);
    const relativeOffset = rva - section.virtualAddress;
    if (relativeOffset + length > section.rawSize) throw new Error(`${rangeLabel} exceeds its PE section bounds`);
    return section.rawOffset + relativeOffset;
  };
  const clrDirectory = dataDirectoryOffset + 14 * 8;
  const clrRva = readU32(contents, clrDirectory, `${label} CLR directory`);
  const clrSize = readU32(contents, clrDirectory + 4, `${label} CLR directory`);
  if (clrRva === 0 || clrSize < 0x48 || clrSize > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`${label} has no bounded CLR metadata directory`);
  const clrOffset = rvaToOffset(clrRva, clrSize, `${label} CLR header`);
  const clrHeader = boundedSlice(contents, clrOffset, 0x48, `${label} CLR header`);
  if (readU32(clrHeader, 0, `${label} CLR header`) < 0x48) throw new Error(`${label} CLR header is invalid`);
  const metadataRva = readU32(clrHeader, 8, `${label} CLR metadata`);
  const metadataSize = readU32(clrHeader, 12, `${label} CLR metadata`);
  if (metadataRva === 0 || metadataSize === 0 || metadataSize > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`${label} CLR metadata directory is invalid`);
  const metadataOffset = rvaToOffset(metadataRva, metadataSize, `${label} CLR metadata`);
  const metadata = parseManagedMetadata(boundedSlice(contents, metadataOffset, metadataSize, `${label} CLR metadata`), `${label} CLR metadata`);
  if (metadata.tableRows[0] !== 1 || metadata.tableRows[32] !== 1) throw new Error(`${label} must contain exactly one Module and exactly one Assembly metadata row`);
}

function validatePortablePdb(contents, label) {
  parseManagedMetadata(contents, label, { portablePdb: true });
}

function nugetCoreMember(files, label, requireCanonicalCore) {
  const members = [...files.keys()].filter((path) => /^package\/services\/metadata\/core-properties\/[^/]+\.psmdcp$/u.test(path));
  if (members.length !== 1) throw new Error(`${label} must contain exactly one core-properties document`);
  if (requireCanonicalCore && members[0] !== NUGET_CORE_MEMBER) throw new Error(`${label} core-properties member is not canonical`);
  return members[0];
}

function validateNugetArtifact({ archivePath, packageId, platformVersion, symbols, requireCanonicalCore = true }) {
  const label = symbols ? "NuGet symbols" : "NuGet package";
  const files = readZipArchive(archivePath, label);
  const coreMember = nugetCoreMember(files, label, requireCanonicalCore);
  exactMemberSet(files, nugetExpectedMembers(packageId, symbols, coreMember), label);
  validateOpcContentTypes(files, label);
  validateNugetRelationships(files, packageId, coreMember, label);

  const packageRoot = parseXml(requiredArchiveMember(files, `${packageId}.nuspec`, label), `${label} metadata`);
  const nuspecNamespace = packageRoot.attributes.get("xmlns") ?? "";
  assertXmlNamespaceTree(packageRoot, { defaultNamespaces: NUGET_NUSPEC_ROOT_NAMESPACES, label: `${label} metadata` });
  if (packageRoot.name !== "package" || !NUGET_NUSPEC_ROOT_NAMESPACES.has(nuspecNamespace) || packageRoot.text.join("").trim()) throw new Error(`${label} metadata has an invalid nuspec root (${packageRoot.name}, ${JSON.stringify(nuspecNamespace)})`);
  const metadata = packageRoot.children.filter((child) => child.name === "metadata");
  if (metadata.length !== 1 || packageRoot.children.length !== 1) throw new Error(`${label} metadata has an invalid nuspec metadata element`);
  if (xmlSingleDirectText(metadata[0], "id", `${label} metadata`) !== packageId || xmlSingleDirectText(metadata[0], "version", `${label} metadata`) !== platformVersion) throw new Error(`${label} metadata does not carry the expected identity`);
  const packageTypes = metadata[0].children.filter((node) => node.name === "packageTypes");
  const symbolTypes = packageTypes.flatMap((node) => node.children.filter((child) => child.name === "packageType")).filter((node) => node.attributes.get("name") === "SymbolsPackage");
  if (symbols ? symbolTypes.length !== 1 : packageTypes.length !== 0) throw new Error(symbols ? "NuGet symbols metadata does not declare exactly one SymbolsPackage" : "NuGet package metadata must not declare a symbols package type");

  const core = parseXml(requiredArchiveMember(files, coreMember, label), `${label} core metadata`);
  assertXmlNamespaceTree(core, { defaultNamespaces: NUGET_CORE_ROOT_NAMESPACES, prefixNamespaces: NUGET_CORE_PREFIX_NAMESPACES, label: `${label} core metadata` });
  if (core.name !== "coreProperties" || !NUGET_CORE_ROOT_NAMESPACES.has(core.attributes.get("xmlns") ?? "") || core.attributes.get("xmlns:dc") !== DUBLIN_CORE_ELEMENTS_NAMESPACE || core.text.join("").trim() || xmlSingleDirectText(core, "dc:identifier", `${label} core metadata`) !== packageId || xmlSingleDirectText(core, "version", `${label} core metadata`) !== platformVersion) throw new Error(`${label} core metadata does not carry the expected identity`);
  if (symbols) validatePortablePdb(requiredArchiveMember(files, "lib/net8.0/Licensecc.Client.pdb", label), `${label} PDB`);
  else validatePeDll(requiredArchiveMember(files, "lib/net8.0/Licensecc.Client.dll", label), `${label} DLL`);
  return { files, coreMember };
}

/** Normalize only NuGet's generated relationship names and ZIP container metadata. */
function canonicalizeNugetArtifact({ archivePath, packageId, platformVersion, symbols, sourceDateEpoch }) {
  const label = symbols ? "NuGet symbols" : "NuGet package";
  if (!existsSync(archivePath) || lstatSync(archivePath).isSymbolicLink() || !lstatSync(archivePath).isFile()) throw new Error(`${label} output is missing its expected artifact`);
  const validated = validateNugetArtifact({ archivePath, packageId, platformVersion, symbols, requireCanonicalCore: false });
  const { files, coreMember } = validated;
  const core = requiredArchiveMember(files, coreMember, label);
  files.delete(coreMember);
  files.set(NUGET_CORE_MEMBER, core);
  files.set("_rels/.rels", Buffer.from(canonicalNugetRelationships(packageId, NUGET_CORE_MEMBER), "utf8"));
  writeDeterministicZip(archivePath, files, sourceDateEpoch);
  validateNugetArtifact({ archivePath, packageId, platformVersion, symbols });
  const normalized = readZipArchive(archivePath, label);
  if (!normalized.has(NUGET_CORE_MEMBER) || !normalized.get("_rels/.rels").equals(Buffer.from(canonicalNugetRelationships(packageId, NUGET_CORE_MEMBER), "utf8"))) throw new Error(`${label} deterministic normalization did not persist expected metadata`);
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

function planArchiveVerification({ archivePath, tempParent, probeDirectory, sourceDirectory, generatorExecutable } = {}) {
  const archive = resolve(archivePath);
  const parent = resolve(tempParent ?? dirname(archive));
  const archiveRoot = archive.replace(/\.tar$/iu, "").slice(archive.lastIndexOf(sep) + 1);
  const probe = resolve(probeDirectory ?? join(parent, "licensecc-release-cpp-probe-plan"));
  if (!pathWithin(probe, parent)) throw new Error("release verifier probe is not beneath its temporary parent");
  const source = resolve(sourceDirectory ?? join(probe, archiveRoot));
  if (!pathWithin(source, probe)) throw new Error("release verifier source is not beneath its temporary probe");
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
  const probe = mkdtempSync(join(parent, "p-"));
  if (!pathWithin(probe, parent)) throw new Error("release verifier probe escaped its temporary parent");
  try {
    extractValidatedArchive({ archivePath: archive, destination: probe, expectedRoot: archiveRoot, expectedMembers });
    // Keep the archive's explicit release identity in the tar, but shorten the
    // extracted root before CMake creates nested probe paths on Windows.
    const extractedSource = join(probe, archiveRoot);
    const source = join(probe, "src");
    if (!existsSync(extractedSource) || lstatSync(extractedSource).isSymbolicLink() || !lstatSync(extractedSource).isDirectory()) throw new Error("validated release archive did not extract a regular source root");
    renameSync(extractedSource, source);
    if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) throw new Error("validated release archive source root could not be safely shortened");
    assertNoReparseComponents(source);
    const initial = planArchiveVerification({ archivePath: archive, tempParent: parent, probeDirectory: probe, sourceDirectory: source });
    for (const command of initial.slice(0, 2)) run({ ...command, env });
    const generator = findBuiltGenerator(join(probe, "generator-build"));
    const finalPlan = planArchiveVerification({ archivePath: archive, tempParent: parent, probeDirectory: probe, sourceDirectory: source, generatorExecutable: generator });
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

function sanitizedEnvironment(canonicalRoot, sourceDateEpoch) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error("release assembly requires a non-negative Git source timestamp");
  const home = join(canonicalRoot, ".release-tool-home");
  const appData = join(home, "appdata", "roaming");
  const localAppData = join(home, "appdata", "local");
  const programData = join(home, "appdata", "programdata");
  const programFiles = join(home, "appdata", "programfiles");
  const programFilesX86 = join(home, "appdata", "programfiles-x86");
  const nugetPackages = join(home, "nuget-packages");
  const nugetHttpCache = join(home, "nuget-http-cache");
  const nugetPluginsCache = join(home, "nuget-plugins-cache");
  const nugetScratch = join(home, "nuget-scratch");
  const nugetConfig = join(home, "NuGet.Config");
  const temporary = join(canonicalRoot, ".release-tool-temp");
  const cache = join(canonicalRoot, ".release-npm-cache");
  const userConfig = join(canonicalRoot, ".release-npmrc");
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(programData, { recursive: true });
  mkdirSync(programFiles, { recursive: true });
  mkdirSync(programFilesX86, { recursive: true });
  mkdirSync(nugetPackages, { recursive: true });
  mkdirSync(nugetHttpCache, { recursive: true });
  mkdirSync(nugetPluginsCache, { recursive: true });
  mkdirSync(nugetScratch, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  mkdirSync(cache, { recursive: true });
  writeFileSync(userConfig, "audit=false\nfund=false\nupdate-notifier=false\n");
  writeFileSync(nugetConfig, "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<configuration>\n  <packageSources>\n    <clear />\n    <add key=\"nuget.org\" value=\"https://api.nuget.org/v3/index.json\" protocolVersion=\"3\" />\n  </packageSources>\n</configuration>\n");
  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const env = {
    PATH: inheritedPath,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    // NuGet's Windows configuration defaults discover a machine-wide config
    // below ProgramData.  Keep that discovery local to canonical staging too.
    ProgramData: programData,
    ALLUSERSPROFILE: programData,
    // NuGet's default configuration probes ProgramFiles before honoring a
    // supplied config file.  Point those probes at empty canonical paths so
    // host-wide NuGet configuration cannot affect release contents.
    ProgramFiles: programFiles,
    ProgramW6432: programFiles,
    "ProgramFiles(x86)": programFilesX86,
    DOTNET_CLI_HOME: home,
    NUGET_PACKAGES: nugetPackages,
    NUGET_HTTP_CACHE_PATH: nugetHttpCache,
    NUGET_PLUGINS_CACHE_PATH: nugetPluginsCache,
    NUGET_SCRATCH: nugetScratch,
    NUGET_CONFIG_FILE: nugetConfig,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    TZ: "UTC",
    PYTHONHASHSEED: "0",
    // The release build supplies one verified interpreter explicitly to uv;
    // forbid its managed download fallback as a second line of defense.
    UV_PYTHON_DOWNLOADS: "never",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    NUGET_XMLDOC_MODE: "skip",
    CI: "true",
  };
  const hostRuntimeVariables = ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"];
  if (process.platform === "win32") {
    // CMake's Ninja generator invokes the already-selected MSVC compiler
    // directly, so it needs this explicit, non-secret SDK/toolchain lookup
    // set.  All source, profile, cache, and NuGet configuration paths remain
    // canonical-local above.
    hostRuntimeVariables.push("LIB", "INCLUDE", "VCINSTALLDIR", "VCToolsInstallDir", "WindowsSdkDir", "WindowsSDKVersion", "UniversalCRTSdkDir", "UCRTVersion", "VSCMD_ARG_TGT_ARCH", "VSCMD_ARG_HOST_ARCH", "ExtensionSdkDir", "WindowsLibPath");
  }
  for (const key of hostRuntimeVariables) {
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
  // Wrangler and the UI build tools are pinned workspace devDependencies.  Be
  // explicit so a hosting environment's production-default config cannot turn
  // a clean source projection into an incomplete Worker build.
  run({ executable: npm.executable, args: [...npm.prefix, "ci", "--include=dev"], cwd: root, env, label: "canonical locked npm ci" });
  return npm;
}

function assertExactToolVersion({ executable, args = ["--version"], expected, prefix, label, root, run, env }) {
  const result = run({ executable, args, cwd: root, env, label });
  const output = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const expression = prefix ? new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s+${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\s|$)`, "u") : new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
  if (!expression.test(output)) throw new Error(`${label} must be exactly ${expected}; received ${output || "<no version output>"}`);
  return output;
}

function verifiedPythonExecutable({ root, run, env }) {
  const result = run({
    executable: "python",
    args: ["-c", "import os, sys; print(os.path.realpath(sys.executable))"],
    cwd: root,
    env,
    label: "release Python executable",
  });
  const output = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (!output || /[\r\n\0]/u.test(output) || !isAbsolute(output) || !existsSync(output)) throw new Error("release Python executable must resolve to one existing absolute file");
  const executable = realpathSync(output);
  if (!lstatSync(executable).isFile()) throw new Error("release Python executable must resolve to a regular file");
  return executable;
}

function assertReleaseToolchains({ root, run, env, toolchains, hasDotnet }) {
  const pythonExecutable = verifiedPythonExecutable({ root, run, env });
  assertExactToolVersion({ executable: pythonExecutable, expected: toolchains.pythonVersion, prefix: "Python", label: "release Python version", root, run, env });
  assertExactToolVersion({ executable: "uv", expected: toolchains.uvVersion, prefix: "uv", label: "release uv version", root, run, env });
  if (hasDotnet) assertExactToolVersion({ executable: "dotnet", expected: toolchains.dotnetSdkVersion, label: "release .NET SDK version", root, run, env });
  return { pythonExecutable };
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
  // Resolve the package's exported CLI entry from the canonical installation.
  // Wrangler 4 no longer exports its historical bin/wrangler.js subpath.
  return resolveLocalModule(root, "wrangler", "the pinned local Wrangler CLI");
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

function canonicalPythonBuildConstraint(root) {
  const constraint = join(root, "sdks", "python", "build-constraints.txt");
  if (!existsSync(constraint) || lstatSync(constraint).isSymbolicLink() || readFileSync(constraint).length === 0) throw new Error("canonical Python build constraint is missing or unsafe");
  return constraint;
}

/** Copy only the two expected Python distributions out of tool-private output. */
function stagePythonArtifacts({ canonicalRoot, toolOutput, stagingOutput, pythonVersion }) {
  const source = resolve(toolOutput);
  const destination = resolve(stagingOutput, "python");
  if (!pathWithin(source, canonicalRoot)) throw new Error("Python tool output escaped the canonical source tree");
  if (!pathWithin(destination, stagingOutput)) throw new Error("Python release artifacts escaped release staging");
  if (!existsSync(source) || lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) throw new Error("Python tool output is missing or unsafe");
  assertNoReparseComponents(source);
  const expectedNames = [
    `licensecc-${pythonVersion}-py3-none-any.whl`,
    `licensecc-${pythonVersion}.tar.gz`,
  ];
  const expected = new Set(expectedNames);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    // uv may add this VCS hygiene marker to a user-selected output directory.
    // It remains tool-private and is never copied into the release payload.
    if (entry.name === ".gitignore" && entry.isFile()) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) throw new Error(`Python tool output contains an unexpected entry: ${entry.name}`);
  }
  mkdirSync(destination, { recursive: true });
  assertNoReparseComponents(destination);
  for (const name of expectedNames) {
    const artifact = join(source, name);
    if (!existsSync(artifact) || lstatSync(artifact).isSymbolicLink() || !lstatSync(artifact).isFile()) throw new Error(`Python tool output is missing expected artifact: ${name}`);
    copyFileSync(artifact, join(destination, name));
  }
}

function planWorkerAssembly(outputDirectory, root = repositoryRoot) {
  const work = join(outputDirectory, ".release-work");
  const plan = [];
  for (const worker of WORKERS) {
    const outdir = join(outputDirectory, "workers", worker.name);
    if (worker.ui) {
      const uiOutdir = join(work, "ui", worker.name);
      plan.push({ executable: process.execPath, args: ["<resolved-npm-cli>", "run", "build:ui", "--workspace", worker.workspace, "--", "--outDir", uiOutdir], cwd: root, label: `${worker.name} isolated UI build`, uiOutdir });
    }
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

/** Require a nonempty HTML entry and actual built UI asset before Wrangler sees it. */
function validateUiAssets(directory, label) {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error(`${label} output directory is missing or unsafe`);
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => ordinal(left.name, right.name))) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} output contains a symbolic link`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const member = assertSafePackageMemberPath(relative(directory, child).split(sep).join("/"), `${label} output`);
        if (readFileSync(child).length === 0) throw new Error(`${label} output contains an empty file: ${member}`);
        files.push(member);
      } else throw new Error(`${label} output contains an unsupported filesystem entry`);
    }
  };
  visit(directory);
  if (!files.includes("index.html") || !files.some((member) => /^assets\/[^/]+\.(?:css|js|mjs)$/iu.test(member))) throw new Error(`${label} output must contain nonempty index.html and a built CSS or JavaScript asset`);
}

function strictUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

/** Parse, but never execute, a module bundle with the same Node parser used by release tooling. */
function parseWorkerModule(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE_MEMBER_BYTES) throw new Error(`${label} is empty or too large`);
  const cacheKey = sha256(bytes);
  const cached = parsedWorkerSources.get(cacheKey);
  if (cached !== undefined) return cached;
  const source = strictUtf8(bytes, label);
  const parsed = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (parsed.error || parsed.status !== 0) throw new Error(`${label} does not parse as an ES module`);
  if (parsedWorkerSources.size < 256) parsedWorkerSources.set(cacheKey, source);
  return source;
}

function workerTokens(source) {
  const tokens = [];
  const regexMayStartAfter = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">", "return", "throw", "case", "delete", "void", "typeof", "new", "in", "of", "yield", "await"]);
  const skipQuoted = (cursor, quote) => {
    for (let index = cursor + 1; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
      } else if (source[index] === quote) {
        return index + 1;
      }
    }
    return source.length;
  };
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/u.test(character)) {
      cursor += 1;
    } else if (character === "/" && next === "/") {
      const end = source.indexOf("\n", cursor + 2);
      cursor = end === -1 ? source.length : end + 1;
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
    } else if (character === '"' || character === "'") {
      let value = "";
      let index = cursor + 1;
      for (; index < source.length; index += 1) {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 1;
        } else if (source[index] === character) {
          index += 1;
          break;
        } else value += source[index];
      }
      tokens.push({ kind: "string", value });
      cursor = index;
    } else if (character === "`") {
      cursor = skipQuoted(cursor, "`");
    } else if (character === "/" && regexMayStartAfter.has(tokens.at(-1)?.value)) {
      cursor = skipQuoted(cursor, "/");
      while (/[A-Za-z]/u.test(source[cursor] ?? "")) cursor += 1;
    } else if (/[A-Za-z_$]/u.test(character)) {
      const match = /^[A-Za-z_$][\w$]*/u.exec(source.slice(cursor));
      tokens.push({ kind: "identifier", value: match[0] });
      cursor += match[0].length;
    } else {
      tokens.push({ kind: "punctuator", value: character });
      cursor += 1;
    }
  }
  return tokens;
}

/** Ask Node's module parser for exports without evaluating the bundle. */
function moduleExportsDefault(source) {
  const inspector = [
    'import vm from "node:vm";',
    'import { readFileSync } from "node:fs";',
    'const source = readFileSync(0, "utf8");',
    'const module = new vm.SourceTextModule(source);',
    'await module.link(() => { throw new Error("static import is not expected in a Worker bundle"); });',
    'process.stdout.write(JSON.stringify(Object.getOwnPropertyNames(module.namespace)));',
  ].join("");
  const parsed = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", inspector], {
    input: source,
    encoding: "utf8",
    windowsHide: true,
  });
  if (parsed.error || parsed.status !== 0) return false;
  try {
    return JSON.parse(parsed.stdout).includes("default");
  } catch {
    return false;
  }
}

function hasWorkerEntrypoint(source) {
  if (moduleExportsDefault(source)) return true;
  const tokens = workerTokens(source);
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "{") {
      depth += 1;
      continue;
    }
    if (token.value === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (token.value === "export" && tokens[index + 1]?.value === "default") return true;
    if (token.value === "export" && tokens[index + 1]?.value === "{") {
      let braceDepth = 0;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        if (tokens[cursor].value === "{") braceDepth += 1;
        else if (tokens[cursor].value === "}") {
          braceDepth -= 1;
          if (braceDepth === 0) break;
        } else if (braceDepth === 1 && (tokens[cursor].value === "default" || (tokens[cursor].value === "as" && tokens[cursor + 1]?.value === "default"))) return true;
      }
    }
    if (token.value === "addEventListener" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.kind === "string" && tokens[index + 2]?.value === "fetch") return true;
  }
  return false;
}

/** Require a parsed non-empty JavaScript bundle and an explicit Worker fetch/module entrypoint. */
function validateWorkerBundle(directory, label = "Worker bundle") {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) throw new Error(`${label} directory is missing or unsafe`);
  const javascript = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => ordinal(left.name, right.name))) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /\.(?:mjs|cjs|js)$/iu.test(entry.name)) javascript.push(child);
      else if (!entry.isFile()) throw new Error(`${label} contains an unsupported filesystem entry`);
    }
  };
  visit(directory);
  if (javascript.length === 0) throw new Error(`${label} has no JavaScript entrypoint`);
  const sources = javascript.map((file) => parseWorkerModule(readFileSync(file), `${label} ${relative(directory, file)}`));
  if (!sources.some(hasWorkerEntrypoint)) throw new Error(`${label} has no Worker fetch or module default entrypoint`);
}

/** Remove Wrangler's timestamped note and make source maps portable. */
function normalizeWorkerBundle(directory, staging) {
  const output = resolve(directory);
  if (!pathWithin(output, staging.output) || !ownsStaging(staging)) throw new Error("Worker bundle normalization escaped owned release staging");
  assertNoReparseComponents(output);
  const readme = join(output, "README.md");
  if (existsSync(readme)) {
    if (lstatSync(readme).isSymbolicLink() || !lstatSync(readme).isFile()) throw new Error("Wrangler generated README is unsafe");
    const generated = strictUtf8(readFileSync(readme), "Wrangler generated README");
    if (!/^This folder contains the built output assets for the worker "[^"\r\n]+" generated at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\.\r?\n?$/u.test(generated)) throw new Error("Wrangler generated README does not have the expected ephemeral form");
    rmSync(readme, { force: true });
  }
  for (const map of walk(output).filter((path) => path.endsWith(".js.map"))) {
    let sourceMap;
    try {
      sourceMap = JSON.parse(strictUtf8(readFileSync(map), "Worker source map"));
    } catch {
      throw new Error("Worker source map is invalid");
    }
    if (!sourceMap || Array.isArray(sourceMap) || typeof sourceMap.sourceRoot !== "string" || !Array.isArray(sourceMap.sources)) throw new Error("Worker source map is missing a safe source root");
    // Wrangler writes the staging directory here.  A relative root retains the
    // map's bundle-relative meaning without embedding a volatile host path.
    sourceMap.sourceRoot = ".";
    writeFileSync(map, `${JSON.stringify(sourceMap)}\n`);
  }
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
      if (command.uiOutdir) validateUiAssets(command.uiOutdir, `${command.label} UI`);
      if (command.outdir) {
        if (!directoryHasFiles(command.outdir)) throw new Error(`${command.label} produced no bundle files`);
        normalizeWorkerBundle(command.outdir, staging);
        validateWorkerBundle(command.outdir, `${command.label} Worker bundle`);
      }
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
  if (payloadRoot && canonicalRepositoryRoot) {
    validatePythonArtifacts({
      wheelPath: join(payloadRoot, identity.python[0]),
      sdistPath: join(payloadRoot, identity.python[1]),
      pythonVersion: versions.pythonVersion,
      repositoryRoot: canonicalRepositoryRoot,
    });
    if (!incomplete) {
      validateNugetArtifact({ archivePath: join(payloadRoot, identity.dotnet[0]), packageId: versions.dotnetPackageId, platformVersion: versions.platformVersion, symbols: false });
      validateNugetArtifact({ archivePath: join(payloadRoot, identity.dotnet[1]), packageId: versions.dotnetPackageId, platformVersion: versions.platformVersion, symbols: true });
    }
    validateArchiveMembers(join(payloadRoot, cpp[0].path), { expectedRoot: identity.cpp.slice("cpp/".length, -".tar".length), expectedMembers: trackedCppFiles(canonicalRepositoryRoot) });
  }
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
  for (const worker of WORKERS) validateWorkerBundle(join(outputDirectory, "workers", worker.name), `${worker.name} Worker bundle`);
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid payload";
    throw new Error(`invalid release manifest: ${detail}`);
  }
  if (stableJson(manifest) !== stableJson(expected.manifest)) throw new Error("invalid release manifest");
  if (readFileSync(join(output, "checksums.sha256"), "utf8") !== expected.checksums) throw new Error("release checksums do not match payloads");
  const spdx = readJson(join(output, "spdx.json"), "invalid SPDX document");
  if (stableJson(spdx) !== stableJson(expected.spdx)) throw new Error("invalid SPDX document");
  return expected.manifest;
}

/** Fail closed unless two independently assembled release payloads are byte-for-byte identical. */
function verifyReleaseArtifactReproducibility({ firstDirectory, secondDirectory, root = repositoryRoot }) {
  const first = inspectReleaseDirectory(firstDirectory, { root });
  const second = inspectReleaseDirectory(secondDirectory, { root });
  const firstPaths = first.artifacts.map((artifact) => artifact.path).sort(ordinal);
  const secondPaths = second.artifacts.map((artifact) => artifact.path).sort(ordinal);
  if (JSON.stringify(firstPaths) !== JSON.stringify(secondPaths)) throw new Error("release artifact inventory differs between controlled assemblies");
  // Compare payloads before derived metadata so a changed bundle/package reports
  // its own byte boundary rather than only the checksum file that reflects it.
  const paths = [...first.artifacts.map((artifact) => artifact.path), ...[...METADATA_FILES].sort(ordinal)];
  for (const path of paths) {
    const left = readFileSync(join(firstDirectory, path));
    const right = readFileSync(join(secondDirectory, path));
    if (!left.equals(right)) throw new Error(`release artifact is not reproducible: ${path}`);
  }
  if (stableJson(first) !== stableJson(second)) throw new Error("release artifact manifests differ between controlled assemblies");
  return { artifacts: first.artifacts, commit: first.commit, source_date: first.source_date };
}

function assembleReleaseArtifacts({ root = repositoryRoot, outputDirectory, consumerId, expectedPlatformVersion, expectedPythonVersion, allowPartial = false, run = commandResult, verifyArchive = verifyArchiveGenerator, toolAvailable = (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0 }) {
  const versions = repositoryVersions(root);
  if ((expectedPlatformVersion !== undefined && expectedPlatformVersion !== versions.platformVersion) || (expectedPythonVersion !== undefined && expectedPythonVersion !== versions.pythonVersion)) throw new Error("supplied expected version does not match tracked version authority");
  safeConsumerId(consumerId);
  const staging = prepareOwnedOutput({ root, outputDirectory });
  try {
    const hasDotnet = toolAvailable("dotnet");
    if (!hasDotnet && !allowPartial) throw new Error("dotnet is required; use --allow-partial only for an explicitly incomplete manifest");
    const canonical = createCanonicalHeadTree({ root, destination: join(staging.output, ".canonical-head") });
    try {
      assertCanonicalVersionContract({ sourceRoot: root, canonicalRoot: canonical });
      const env = sanitizedEnvironment(canonical, versions.sourceDateEpoch);
      const tooling = assertReleaseToolchains({ root: canonical, run, env, toolchains: versions.toolchains, hasDotnet });
      const npm = runCanonicalNpmInstall({ root: canonical, run, env });
      runWorkerAssembly({ root: canonical, outputDirectory: staging.output, run, env, staging, npm });
      // `uv build` deliberately has no --locked mode.  Validate the canonical
      // project lock first, then constrain and hash-check the isolated PEP 517
      // backend resolution used for the wheel and sdist.
      run({ executable: "uv", args: ["lock", "--check", "--python", tooling.pythonExecutable, "--no-python-downloads", "--directory", join(canonical, "sdks/python")], cwd: canonical, env, label: "locked Python dependency check" });
      const pythonToolOutput = join(canonical, ".release-python-output");
      run({ executable: "uv", args: ["build", "--python", tooling.pythonExecutable, "--no-python-downloads", "--directory", join(canonical, "sdks/python"), "--build-constraint", canonicalPythonBuildConstraint(canonical), "--require-hashes", "--wheel", "--sdist", "--out-dir", pythonToolOutput], cwd: canonical, env, label: "locked Python wheel and sdist" });
      stagePythonArtifacts({ canonicalRoot: canonical, toolOutput: pythonToolOutput, stagingOutput: staging.output, pythonVersion: versions.pythonVersion });
      if (hasDotnet) {
        const dotnetProject = join(canonical, "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj");
        const dotnetLock = join(dirname(dotnetProject), "packages.lock.json");
        if (!existsSync(dotnetProject) || lstatSync(dotnetProject).isSymbolicLink() || !lstatSync(dotnetProject).isFile() || !existsSync(dotnetLock) || lstatSync(dotnetLock).isSymbolicLink() || !lstatSync(dotnetLock).isFile()) throw new Error("canonical NuGet pack target or its tracked packages.lock.json is missing or unsafe");
        run({ executable: "dotnet", args: ["restore", dotnetProject, "--locked-mode", "--disable-build-servers", "--configfile", env.NUGET_CONFIG_FILE, "--packages", env.NUGET_PACKAGES], cwd: canonical, env, label: "locked NuGet restore" });
        const dotnetOutput = join(staging.output, "dotnet");
        run({ executable: "dotnet", args: ["pack", dotnetProject, "--configuration", "Release", "--no-restore", "--disable-build-servers", "--include-symbols", `-p:PackageVersion=${versions.platformVersion}`, "-p:SymbolPackageFormat=snupkg", "-p:ContinuousIntegrationBuild=true", "-p:Deterministic=true", "-p:DeterministicSourcePaths=true", `-p:PathMap=${canonical}=/src`, `-p:SourceRevisionId=${versions.commit}`, "--output", dotnetOutput], cwd: canonical, env, label: "NuGet package and symbols" });
        canonicalizeNugetArtifact({ archivePath: join(dotnetOutput, `${versions.dotnetPackageId}.${versions.platformVersion}.nupkg`), packageId: versions.dotnetPackageId, platformVersion: versions.platformVersion, symbols: false, sourceDateEpoch: versions.sourceDateEpoch });
        canonicalizeNugetArtifact({ archivePath: join(dotnetOutput, `${versions.dotnetPackageId}.${versions.platformVersion}.snupkg`), packageId: versions.dotnetPackageId, platformVersion: versions.platformVersion, symbols: true, sourceDateEpoch: versions.sourceDateEpoch });
      }
    } finally {
      removeOwnedChild(staging, canonical);
    }
    const archive = createCppSourceArchive({ root, outputDirectory: staging.output, consumerId, cppVersion: versions.cppVersion, platformVersion: versions.platformVersion });
    const verifierStaging = prepareOwnedVerifierOutput(root);
    try {
      verifyArchive({ archivePath: archive, expectedSha256: sha256(readFileSync(archive)), expectedMembers: trackedCppFiles(root), tempParent: verifierStaging.output, run, env: sanitizedEnvironment(verifierStaging.output, versions.sourceDateEpoch) });
    } finally {
      cleanupOwnedStaging(verifierStaging);
    }
    const manifest = writeReleaseMetadata({ root, outputDirectory: staging.output, consumerId, versions, incomplete: !hasDotnet, allowOwnerMarker: true });
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
  const known = new Set(["output", "repeat-output", "consumer-id", "expect-platform-version", "expect-python-version"]);
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
  if (options.help) return console.log("usage: node scripts/assemble-release-artifacts.mjs --output <stage> --consumer-id <consumer> [--repeat-output <second-stage>] [--expect-platform-version <semver>] [--expect-python-version <pep440>] [--allow-partial]");
  if (!options.output || !options["consumer-id"]) throw new Error("--output and --consumer-id are required");
  const assembly = { consumerId: options["consumer-id"], expectedPlatformVersion: options["expect-platform-version"], expectedPythonVersion: options["expect-python-version"], allowPartial: options.allowPartial };
  const manifest = assembleReleaseArtifacts({ ...assembly, outputDirectory: options.output });
  if (options["repeat-output"]) {
    if (samePath(options.output, options["repeat-output"])) throw new Error("--repeat-output must differ from --output");
    assembleReleaseArtifacts({ ...assembly, outputDirectory: options["repeat-output"] });
    verifyReleaseArtifactReproducibility({ firstDirectory: options.output, secondDirectory: options["repeat-output"] });
  }
  console.log(JSON.stringify(manifest, null, 2));
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
  validateWorkerBundle,
  verifyReleaseArtifactReproducibility,
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
