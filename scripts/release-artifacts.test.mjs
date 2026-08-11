import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import test from "node:test";
import { gzipSync } from "node:zlib";

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
  verifyReleaseArtifactReproducibility,
  verifyArchiveGenerator,
  writeReleaseMetadata,
} from "./assemble-release-artifacts.mjs";

const PLATFORM_VERSION = "0.1.0-rc.1";
const PYTHON_VERSION = "0.1.0rc1";
const CPP_VERSION = "2.1.0";
const NPM_VERSION = "10.9.8";
const repositoryRoot = resolve(import.meta.dirname, "..");

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `${executable} ${args.join(" ")}`);
}

function write(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const files = entries.map(({ name, contents }) => ({ name: Buffer.from(name, "utf8"), contents: Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8") }));
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(file.contents), 14);
    header.writeUInt32LE(file.contents.length, 18);
    header.writeUInt32LE(file.contents.length, 22);
    header.writeUInt16LE(file.name.length, 26);
    locals.push(header, file.name, file.contents);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(file.contents), 16);
    directory.writeUInt32LE(file.contents.length, 20);
    directory.writeUInt32LE(file.contents.length, 24);
    directory.writeUInt16LE(file.name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, file.name);
    offset += header.length + file.name.length + file.contents.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function tarHeader(name, contents) {
  const header = Buffer.alloc(512);
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const writeOctal = (value, start, length) => Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii").copy(header, start);
  Buffer.from(name, "utf8").copy(header, 0);
  writeOctal(0o644, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(data.length, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

function tarGzip(entries, { trailingZeroBlocks = 2 } = {}) {
  return gzipSync(Buffer.concat([...entries.flatMap(({ name, contents }) => tarHeader(name, contents)), Buffer.alloc(512 * trailingZeroBlocks)]));
}

function recordHash(contents) {
  return createHash("sha256").update(contents).digest("base64url");
}

function wheelArtifact({ version = PYTHON_VERSION, name = "licensecc", metadataName = name, recordContents, recordTransform, extraEntries = [] } = {}) {
  const distInfo = `${name}-${version}.dist-info`;
  const entries = [
    { name: `${distInfo}/METADATA`, contents: `Metadata-Version: 2.3\nName: ${metadataName}\nVersion: ${version}\n` },
    { name: `${distInfo}/WHEEL`, contents: "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: `${distInfo}/licenses/LICENSE`, contents: "AGPL\n" },
    { name: `${name}/__init__.py`, contents: `__version__ = "${version}"\n` },
    { name: `${name}/http_client.py`, contents: `user_agent: str = "licensecc-python-sdk/${version}"\n` },
    ...extraEntries,
  ];
  const generatedRecord = [...entries]
    .map(({ name: member, contents }) => {
      const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
      return `${member},sha256=${recordHash(bytes)},${bytes.length}`;
    })
    .concat(`${distInfo}/RECORD,,`)
    .join("\n") + "\n";
  const record = recordContents ?? (recordTransform ? recordTransform(generatedRecord) : generatedRecord);
  return zip([...entries, { name: `${distInfo}/RECORD`, contents: record }]);
}

function sdistArtifact({ version = PYTHON_VERSION, name = "licensecc", metadataName = name, trailingZeroBlocks, extraEntries = [] } = {}) {
  const root = `${name}-${version}`;
  return tarGzip([
    { name: `${root}/PKG-INFO`, contents: `Metadata-Version: 2.3\nName: ${metadataName}\nVersion: ${version}\n` },
    { name: `${root}/.gitignore`, contents: "\n" },
    { name: `${root}/LICENSE`, contents: "AGPL\n" },
    { name: `${root}/README.md`, contents: "# fixture\n" },
    { name: `${root}/build-constraints.txt`, contents: "hatchling==1.27.0 --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000\n" },
    { name: `${root}/pyproject.toml`, contents: `[project]\nname = "${name}"\nversion = "${version}"\n\n[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "hatchling.build"\n` },
    { name: `${root}/uv.lock`, contents: `version = 1\n\n[[package]]\nname = "${name}"\nversion = "${version}"\n` },
    { name: `${root}/src/${name}/__init__.py`, contents: `__version__ = "${version}"\n` },
    { name: `${root}/src/${name}/http_client.py`, contents: `user_agent: str = "licensecc-python-sdk/${version}"\n` },
    { name: `${root}/tests/test_http_client.py`, contents: "def test_fixture():\n    assert True\n" },
    ...extraEntries,
  ], { trailingZeroBlocks });
}

function nuspec({ id = "Licensecc.Client", version = PLATFORM_VERSION, symbols = false } = {}) {
  return `<?xml version="1.0"?><package><metadata><id>${id}</id><version>${version}</version><authors>fixture</authors>${symbols ? "<packageTypes><packageType name=\"SymbolsPackage\" /></packageTypes>" : ""}</metadata></package>`;
}

function fakePeDll() {
  const bytes = Buffer.alloc(0x200);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "ascii");
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xe0, 0x94);
  bytes.writeUInt16LE(0x2002, 0x96);
  bytes.writeUInt16LE(0x20b, 0x98);
  return bytes;
}

function fakePortablePdb() {
  const bytes = Buffer.alloc(32);
  bytes.write("BSJB", 0, "ascii");
  bytes.writeUInt16LE(1, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(8, 12);
  bytes.write("PDB v1.0", 16, "ascii");
  return bytes;
}

function contentTypes(files) {
  const extensions = [...new Set(files.map(({ name }) => name.split(".").at(-1)).filter((extension) => extension && !extension.includes("/")))];
  const type = (extension) => extension === "rels"
    ? "application/vnd.openxmlformats-package.relationships+xml"
    : extension === "psmdcp"
      ? "application/vnd.openxmlformats-package.core-properties+xml"
      : "application/octet-stream";
  return `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${extensions.map((extension) => `<Default Extension="${extension}" ContentType="${type(extension)}"/>`).join("")}</Types>`;
}

function nugetArtifact({ id = "Licensecc.Client", metadataId = id, version = PLATFORM_VERSION, symbols = false, coreNonce = "licensecc.release", binaryContents, extraEntries = [], nuspecContents, contentTypesContents } = {}) {
  const core = `package/services/metadata/core-properties/${coreNonce}.psmdcp`;
  const relationships = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/${id}.nuspec" Id="R${coreNonce}Manifest"/><Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/${core}" Id="R${coreNonce}Core"/></Relationships>`;
  const coreProperties = `<?xml version="1.0"?><coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier>${metadataId}</dc:identifier><version>${version}</version></coreProperties>`;
  const files = [
    { name: "_rels/.rels", contents: relationships },
    { name: `${id}.nuspec`, contents: nuspecContents ?? nuspec({ id: metadataId, version, symbols }) },
    { name: core, contents: coreProperties },
  ];
  if (symbols) files.push({ name: "lib/net8.0/Licensecc.Client.pdb", contents: binaryContents ?? fakePortablePdb() });
  else files.push(
    { name: "lib/net8.0/Licensecc.Client.dll", contents: binaryContents ?? fakePeDll() },
    { name: "lib/net8.0/Licensecc.Client.xml", contents: "<?xml version=\"1.0\"?><doc/>" },
    { name: "README.md", contents: "# fixture\n" },
  );
  const all = [...files, ...extraEntries];
  return zip([{ name: "[Content_Types].xml", contents: contentTypesContents ?? contentTypes(all) }, ...all]);
}

function releaseFixture({ contractDrift = false, omitDotnetLock = false } = {}) {
  const root = join(tmpdir(), `licensecc-release-fixture-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const workers = [
    ["cloudflare-licensing-backend", "wrangler.example.toml"],
    ["cloudflare-license-admin", "wrangler.example.jsonc"],
    ["cloudflare-customer-portal", "wrangler.example.jsonc"],
    ["cloudflare-d1-backup", "wrangler.example.jsonc"],
  ];
  const workspacePaths = [
    ["packages/cloudflare-runtime", "@fixture/cloudflare-runtime"],
    ["packages/licensing-domain", "@fixture/licensing-domain"],
    ["services/cloudflare-customer-portal", "@fixture/cloudflare-customer-portal"],
    ["services/cloudflare-d1-backup", "@fixture/cloudflare-d1-backup"],
    ["services/cloudflare-license-admin", "@fixture/cloudflare-license-admin"],
    ["services/cloudflare-licensing-backend", "@fixture/cloudflare-licensing-backend"],
  ];
  const workspaceNames = workspacePaths.map(([path]) => path);
  const rootManifest = { name: "fixture", version: PLATFORM_VERSION, private: true, workspaces: workspaceNames };
  const lockPackages = {
    "": { name: rootManifest.name, version: PLATFORM_VERSION, workspaces: workspaceNames },
    "node_modules/wrangler": { version: "4.120.0" },
  };
  for (const [path, name] of workspacePaths) {
    lockPackages[path] = { name, version: PLATFORM_VERSION };
    lockPackages[`node_modules/${name}`] = { link: true, resolved: path };
  }
  for (const [path, contents] of [
    ["package.json", JSON.stringify(rootManifest)],
    ["package-lock.json", JSON.stringify({ name: rootManifest.name, version: PLATFORM_VERSION, lockfileVersion: 3, packages: lockPackages })],
    ["version.json", JSON.stringify({ schema_version: 1, platform_version: PLATFORM_VERSION })],
    ["release-toolchains.json", JSON.stringify({ schema_version: 1, python_version: "3.12.8", uv_version: "0.5.15", dotnet_sdk_version: "8.0.423" })],
    ["global.json", JSON.stringify({ sdk: { version: "8.0.423", rollForward: "disable", allowPrerelease: false } })],
    ["CMakeLists.txt", `cmake_minimum_required(VERSION 3.16)\nproject(licensecc VERSION ${CPP_VERSION} LANGUAGES CXX)\n`],
    ["LICENSE", "AGPL"], ["cmake/config.cmake", "# cmake"], ["include/licensecc/licensecc.h", `#define LCC_VERSION_MAJOR 2\n#define LCC_VERSION_MINOR 1\n#define LCC_VERSION_PATCH 0\n#define LCC_VERSION_STRING "${CPP_VERSION}"\n`], ["src/library/runtime.cpp", "// committed runtime"],
    ["extern/license-generator/CMakeLists.txt", "cmake_minimum_required(VERSION 3.16)\nproject(lccgen)\n"], ["extern/license-generator/LICENSE", "BSD 3-Clause License"], ["extern/license-generator/PROVENANCE.md", "reviewed vendor provenance"], ["extern/license-generator/cmake/lccgen-config.cmake", "# config"], ["extern/license-generator/src/license_generator/main.cpp", "// generator"],
    ["sdks/python/.gitignore", "\n"], ["sdks/python/LICENSE", "AGPL\n"], ["sdks/python/README.md", "# fixture\n"], ["sdks/python/pyproject.toml", `[project]\nname = "licensecc"\nversion = "${PYTHON_VERSION}"\n\n[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "hatchling.build"\n`], ["sdks/python/build-constraints.txt", "hatchling==1.27.0 --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000\n"], ["sdks/python/uv.lock", `version = 1\n\n[[package]]\nname = "licensecc"\nversion = "${PYTHON_VERSION}"\n`], ["sdks/python/src/licensecc/__init__.py", `__version__ = "${PYTHON_VERSION}"\n`], ["sdks/python/src/licensecc/http_client.py", `user_agent: str = "licensecc-python-sdk/${PYTHON_VERSION}"\n`], ["sdks/python/tests/test_http_client.py", "def test_fixture():\n    assert True\n"],
    ["sdks/dotnet/src/Licensecc.Client/LICENSE", "AGPL"], ["sdks/dotnet/Licensecc.Client.sln", "solution"], ["sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj", `<Project><PropertyGroup><PackageId>Licensecc.Client</PackageId><Version>${PLATFORM_VERSION}</Version><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`], ...(omitDotnetLock ? [] : [["sdks/dotnet/src/Licensecc.Client/packages.lock.json", JSON.stringify({ version: 1, dependencies: { "net8.0": {} } })]]),
    ["services/cloudflare-licensing-backend/src/openapi/document.ts", `export const openApiSpec = { info: { version: "${PLATFORM_VERSION}" } };\n`], ["services/cloudflare-license-admin/src/worker/openapi/document.ts", `export const openApiDocument = { info: { version: "${PLATFORM_VERSION}" } };\n`], ["services/cloudflare-customer-portal/src/worker/openapi/document.ts", `export const openApiDocument = { info: { version: "${PLATFORM_VERSION}" } };\n`], ["test/contracts/backend.json", JSON.stringify({ openApiSpec: { info: { version: PLATFORM_VERSION } } })], ["test/contracts/admin.json", JSON.stringify({ openApiDocument: { info: { version: PLATFORM_VERSION } } })], ["test/contracts/portal.json", JSON.stringify({ openApiDocument: { info: { version: PLATFORM_VERSION } } })],
    ["README.md", `**Versioning:** Platform packages use \`${PLATFORM_VERSION}\`; C++ uses \`${CPP_VERSION}\` in CMake.\n`], ["CHANGELOG.md", `- **Platform packages** \`${PLATFORM_VERSION}\` Python \`${PYTHON_VERSION}\`\n- **C++ library** \`${CPP_VERSION}\`\n`], ["sdks/dotnet/README.md", `  src/Licensecc.Client/ # the library (PackageId Licensecc.Client, ${PLATFORM_VERSION})\n`], ["doc/conf.py", `version = "${CPP_VERSION}"\nrelease = "${CPP_VERSION}"\n`], ["doc/capabilities/index.rst", `The platform is at **${PLATFORM_VERSION}** (a prerelease)\n`], ["doc/development/Build-the-library.md", `The platform is at **${PLATFORM_VERSION}** (a prerelease)\n`], ["doc/development/Build-the-library-windows.rst", `The platform is at **${PLATFORM_VERSION}** (a prerelease)\n`], ["doc/other/QA.md", `The platform is at **${PLATFORM_VERSION}** (a prerelease)\n`], ["doc/capabilities/registry.json", JSON.stringify({ capabilities: [] })],
  ]) write(root, path, contents);
  for (const [path, name] of workspacePaths) write(root, `${path}/package.json`, JSON.stringify({ name, version: PLATFORM_VERSION }));
  for (const [worker, config] of workers) {
    write(root, `services/${worker}/${config}`, "name = \"example\"\n");
    write(root, `services/${worker}/src/index.ts`, "export default {};\n");
  }
  if (contractDrift) write(root, "README.md", "**Versioning:** drifted platform prose only\n");
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

function fakeRun(commands, { symbols = true, failLabel, wrongSymbol = false, wrongPython = false, invalidArtifact, workerVariant = false, workerEphemera = false, nugetEphemera = false, pythonAuxiliaryFile = false, standardTarPadding = false, uiMissingAsset = false, workerEntryDecoy = false, toolVersionDrift = false } = {}) {
  return (entry) => {
    commands.push(entry);
    if (entry.label === failLabel) throw new Error(`intentional ${failLabel} failure`);
    const put = (path, contents) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); };
    if (entry.label === "canonical npm version") return { status: 0, stdout: `${NPM_VERSION}\n` };
    if (entry.label === "release Python version") return { status: 0, stdout: toolVersionDrift ? "Python 3.12.9\n" : "Python 3.12.8\n" };
    if (entry.label === "release uv version") return { status: 0, stdout: "uv 0.5.15\n" };
    if (entry.label === "release .NET SDK version") return { status: 0, stdout: "8.0.423\n" };
    if (entry.label === "canonical locked npm ci") {
      const root = entry.cwd;
      put(join(root, "node_modules/wrangler/package.json"), JSON.stringify({ exports: { ".": "./wrangler-dist/cli.js" } }));
      put(join(root, "node_modules/wrangler/wrangler-dist/cli.js"), "// fake wrangler\n");
    }
    if (entry.label.includes("isolated UI build")) {
      const uiOut = valueAfter(entry.args, "--outDir");
      put(join(uiOut, "index.html"), "<!doctype html><script src=\"/assets/app.js\"></script>");
      if (!uiMissingAsset) put(join(uiOut, "assets", "app.js"), "console.log('fixture ui');\n");
    }
    if (entry.label.includes("Worker dry-run")) {
      const contents = invalidArtifact === "worker-empty" ? "" : invalidArtifact === "worker-malformed" ? "export default {" : workerEntryDecoy ? "const decoy = \"export default\"; /* addEventListener('fetch') */ export const harmless = true;\n" : `export default { fetch() { return new Response("ok"); } };${workerVariant ? "\n// independently valid variant\n" : "\n"}`;
      const out = valueAfter(entry.args, "--outdir");
      put(join(out, "worker.js"), contents);
      if (workerEphemera) {
        const timestamp = out.includes("first") ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:00:01.000Z";
        put(join(out, "README.md"), `This folder contains the built output assets for the worker "fixture" generated at ${timestamp}.\n`);
        put(join(out, "worker.js.map"), JSON.stringify({ version: 3, sourceRoot: out, sources: ["worker.ts"], names: [], mappings: "" }));
      }
    }
    if (entry.label.includes("Python wheel")) {
      const out = valueAfter(entry.args, "--out-dir");
      const distribution = wrongPython ? "other" : "licensecc";
      const wheel = invalidArtifact === "wheel-empty" ? Buffer.alloc(0) : invalidArtifact === "wheel-truncated" ? wheelArtifact({ name: distribution }).subarray(0, 8) : wheelArtifact({ name: distribution, metadataName: invalidArtifact === "wheel-metadata" ? "other" : distribution });
      const sdist = invalidArtifact === "sdist-empty" ? Buffer.alloc(0) : invalidArtifact === "sdist-truncated" ? sdistArtifact({ name: distribution }).subarray(0, 8) : sdistArtifact({ name: distribution, metadataName: invalidArtifact === "sdist-metadata" ? "other" : distribution, trailingZeroBlocks: standardTarPadding ? 20 : undefined });
      if (pythonAuxiliaryFile) put(join(out, ".gitignore"), "# tool-private output\n");
      put(join(out, `${distribution}-${PYTHON_VERSION}-py3-none-any.whl`), wheel);
      put(join(out, `${distribution}-${PYTHON_VERSION}.tar.gz`), sdist);
    }
    if (entry.label.includes("NuGet package")) {
      const out = valueAfter(entry.args, "--output");
      const nonce = nugetEphemera ? Buffer.from(out, "utf8").toString("hex").slice(-16) : "stable";
      const primary = invalidArtifact === "nupkg-empty" ? Buffer.alloc(0) : invalidArtifact === "nupkg-truncated" ? nugetArtifact().subarray(0, 8) : nugetArtifact({ metadataId: invalidArtifact === "nupkg-metadata" ? "Other.Client" : "Licensecc.Client", coreNonce: nonce });
      const symbolsPackage = invalidArtifact === "snupkg-empty" ? Buffer.alloc(0) : invalidArtifact === "snupkg-truncated" ? nugetArtifact({ symbols: true }).subarray(0, 8) : nugetArtifact({ metadataId: invalidArtifact === "snupkg-metadata" ? "Other.Client" : "Licensecc.Client", symbols: true, coreNonce: nonce });
      put(join(out, `Licensecc.Client.${PLATFORM_VERSION}.nupkg`), primary);
      if (symbols) put(join(out, wrongSymbol ? `Other.Client.${PLATFORM_VERSION}.snupkg` : `Licensecc.Client.${PLATFORM_VERSION}.snupkg`), symbolsPackage);
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

test("release packaging pins the Hatchling backend by hash and forces NuGet snupkg symbols", () => {
  const pyproject = readFileSync(join(repositoryRoot, "sdks/python/pyproject.toml"), "utf8");
  const constraints = readFileSync(join(repositoryRoot, "sdks/python/build-constraints.txt"), "utf8");
  const project = readFileSync(join(repositoryRoot, "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj"), "utf8");
  assert.match(pyproject, /requires\s*=\s*\["hatchling==1\.27\.0"\]/u);
  assert.match(constraints, /^hatchling==1\.27\.0\s+--hash=sha256:[0-9a-f]{64}\s+--hash=sha256:[0-9a-f]{64}$/mu);
  assert.match(project, /<IncludeSymbols>true<\/IncludeSymbols>/u);
  assert.match(project, /<SymbolPackageFormat>snupkg<\/SymbolPackageFormat>/u);
});

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
      run: fakeRun(commands, { pythonAuxiliaryFile: true, standardTarPadding: true }),
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
    const pythonVersion = commands.find((entry) => entry.label === "release Python version");
    const uvVersion = commands.find((entry) => entry.label === "release uv version");
    const dotnetVersion = commands.find((entry) => entry.label === "release .NET SDK version");
    assert.deepEqual(pythonVersion?.args, ["--version"]);
    assert.deepEqual(uvVersion?.args, ["--version"]);
    assert.deepEqual(dotnetVersion?.args, ["--version"]);
    assert.equal(pythonVersion?.executable, "python");
    assert.equal(uvVersion?.executable, "uv");
    assert.equal(dotnetVersion?.executable, "dotnet");
    const npmInstall = commands.find((entry) => entry.label === "canonical locked npm ci");
    assert.ok(npmInstall);
    assert.match(npmInstall.cwd, /\.canonical-head$/);
    assert.ok(npmInstall.args.includes("--include=dev"), "the canonical install retains pinned workspace build tools such as Wrangler");
    const pythonBuildOutput = commands.find((entry) => entry.label === "locked Python wheel and sdist");
    assert.match(valueAfter(pythonBuildOutput.args, "--out-dir"), /\.canonical-head[\\/]\.release-python-output$/);
    assert.ok(!existsSync(join(output, "python", ".gitignore")), "tool-private Python auxiliary files never enter the release inventory");
    assert.ok(!Object.keys(npmInstall.env).some((key) => /(?:token|secret|password|cloudflare)/iu.test(key)));
    assert.match(npmInstall.env.DOTNET_CLI_HOME, /\.canonical-head[\\/]\.release-tool-home$/);
    assert.match(npmInstall.env.NUGET_PACKAGES, /\.canonical-head[\\/]\.release-tool-home[\\/]nuget-packages$/);
    assert.match(npmInstall.env.APPDATA, /\.canonical-head[\\/]\.release-tool-home[\\/]appdata[\\/]roaming$/);
    assert.match(npmInstall.env.LOCALAPPDATA, /\.canonical-head[\\/]\.release-tool-home[\\/]appdata[\\/]local$/);
    assert.match(npmInstall.env.ProgramData, /\.canonical-head[\\/]\.release-tool-home[\\/]appdata[\\/]programdata$/);
    assert.match(npmInstall.env["ProgramFiles(x86)"], /\.canonical-head[\\/]\.release-tool-home[\\/]appdata[\\/]programfiles-x86$/);
    assert.match(npmInstall.env.ProgramFiles, /\.canonical-head[\\/]\.release-tool-home[\\/]appdata[\\/]programfiles$/);
    assert.match(npmInstall.env.NUGET_HTTP_CACHE_PATH, /\.canonical-head[\\/]\.release-tool-home[\\/]nuget-http-cache$/);
    if (process.platform === "win32") {
      assert.equal(npmInstall.env.LIB, process.env.LIB, "the Windows C++ verifier keeps its explicit library search path");
      assert.equal(npmInstall.env.INCLUDE, process.env.INCLUDE, "the Windows C++ verifier keeps its explicit include search path");
    }
    assert.equal(commands.filter((entry) => entry.label.includes("isolated UI build")).length, 2);
    const workerCommands = commands.filter((entry) => entry.label.includes("Worker dry-run"));
    assert.equal(workerCommands.length, 4);
    for (const entry of workerCommands) {
      assert.equal(entry.executable, process.execPath);
      assert.match(entry.args[0], /\.canonical-head[\\/]node_modules[\\/]wrangler[\\/]wrangler-dist[\\/]cli\.js$/);
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
    const pythonLock = commands.find((entry) => entry.label === "locked Python dependency check");
    assert.ok(pythonLock, "the canonical Python lock is checked before building distributions");
    assert.deepEqual(pythonLock.args.slice(0, 2), ["lock", "--check"]);
    assert.ok(pythonLock.args.some((arg) => String(arg).includes(".canonical-head")));
    const pythonBuild = commands.find((entry) => entry.label.includes("Python wheel"));
    assert.ok(pythonBuild.args.includes("--build-constraint"));
    assert.ok(pythonBuild.args.includes("--require-hashes"));
    const nugetRestore = commands.find((entry) => entry.label.includes("NuGet restore"));
    assert.ok(nugetRestore && nugetRestore.args.includes("--locked-mode") && nugetRestore.args.includes("--disable-build-servers") && nugetRestore.args.some((arg) => String(arg).includes(".canonical-head")));
    assert.match(nugetRestore.args[1], /[\\/]sdks[\\/]dotnet[\\/]src[\\/]Licensecc\.Client[\\/]Licensecc\.Client\.csproj$/u);
    assert.doesNotMatch(nugetRestore.args[1], /\.sln$/iu);
    assert.ok(existsSync(join(root, "sdks", "dotnet", "src", "Licensecc.Client", "packages.lock.json")), "the exact restored pack project carries its tracked lockfile");
    const nugetPack = commands.find((entry) => entry.label.includes("NuGet package"));
    assert.ok(nugetPack.args.includes("--disable-build-servers"));
    assert.ok(nugetPack.args.includes(`-p:PackageVersion=${PLATFORM_VERSION}`));
    assert.ok(nugetPack.args.includes("-p:SymbolPackageFormat=snupkg"));
    assert.ok(nugetPack.args.includes("-p:DeterministicSourcePaths=true"));
    assert.ok(nugetPack.args.some((argument) => String(argument).startsWith("-p:PathMap=") && String(argument).endsWith("=/src")));
    assert.equal(npmInstall.env.SOURCE_DATE_EPOCH, String(Math.floor(new Date(manifest.source_date).getTime() / 1000)));
    assert.equal(npmInstall.env.TZ, "UTC");
    assert.ok(!existsSync(join(output, ".canonical-head")));
    assert.ok(!existsSync(join(output, ".release-work")));
    inspectReleaseDirectory(output, { root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembly validates the complete canonical version contract before invoking build tools", () => {
  const root = releaseFixture({ contractDrift: true });
  const output = join(root, "build", "release-artifacts", "contract-drift");
  const commands = [];
  try {
    assert.throws(
      () => assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun(commands), verifyArchive: () => {}, toolAvailable: () => true }),
      /complete tracked version contract/i,
    );
    assert.deepEqual(commands, [], "canonical contract drift must stop before install or build commands");
    assert.ok(!existsSync(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembly rejects a runtime toolchain version that differs from its tracked authority", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "toolchain-drift");
  const commands = [];
  try {
    assert.throws(
      () => assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun(commands, { toolVersionDrift: true }), verifyArchive: () => {}, toolAvailable: () => true }),
      /Python.*3\.12\.8|toolchain/i,
    );
    assert.ok(commands.some((entry) => entry.label === "release Python version"));
    assert.ok(!commands.some((entry) => entry.label === "canonical locked npm ci"), "toolchain drift stops before dependency installation");
    assert.ok(!existsSync(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NuGet restore requires the exact pack target and its tracked packages lock inventory", () => {
  const root = releaseFixture({ omitDotnetLock: true });
  const output = join(root, "build", "release-artifacts", "missing-dotnet-lock");
  const commands = [];
  try {
    assert.throws(
      () => assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun(commands), verifyArchive: () => {}, toolAvailable: () => true }),
      /packages\.lock\.json/i,
    );
    assert.equal(commands.filter((entry) => entry.label === "locked NuGet restore").length, 0, "restore cannot fall back to a solution or another project lockfile");
    assert.ok(!existsSync(output));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker assembly rejects missing UI assets and lexical comment or string entrypoint decoys", () => {
  const root = releaseFixture();
  const missingUi = join(root, "build", "release-artifacts", "missing-ui");
  const decoy = join(root, "build", "release-artifacts", "entrypoint-decoy");
  try {
    assert.throws(
      () => assembleReleaseArtifacts({ root, outputDirectory: missingUi, consumerId: "acme", run: fakeRun([], { uiMissingAsset: true }), verifyArchive: () => {}, toolAvailable: () => true }),
      /UI|asset/i,
    );
    assert.ok(!existsSync(missingUi));
    assert.throws(
      () => assembleReleaseArtifacts({ root, outputDirectory: decoy, consumerId: "acme", run: fakeRun([], { workerEntryDecoy: true }), verifyArchive: () => {}, toolAvailable: () => true }),
      /Worker.*entrypoint|fetch|default/i,
    );
    assert.ok(!existsSync(decoy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspector parses Worker, wheel, sdist, NuGet, and symbol payload bytes rather than trusting filenames", () => {
  const cases = [
    ["workers/license-admin/worker.js", Buffer.alloc(0), /Worker bundle/i],
    ["workers/license-admin/worker.js", Buffer.from("export default {"), /Worker bundle/i],
    [`python/licensecc-${PYTHON_VERSION}-py3-none-any.whl`, Buffer.alloc(0), /wheel/i],
    [`python/licensecc-${PYTHON_VERSION}-py3-none-any.whl`, wheelArtifact().subarray(0, 8), /ZIP|wheel/i],
    [`python/licensecc-${PYTHON_VERSION}-py3-none-any.whl`, wheelArtifact({ metadataName: "other" }), /wheel metadata/i],
    [`python/licensecc-${PYTHON_VERSION}.tar.gz`, Buffer.alloc(0), /sdist/i],
    [`python/licensecc-${PYTHON_VERSION}.tar.gz`, sdistArtifact().subarray(0, 8), /sdist|archive/i],
    [`python/licensecc-${PYTHON_VERSION}.tar.gz`, sdistArtifact({ metadataName: "other" }), /sdist metadata/i],
    [`dotnet/Licensecc.Client.${PLATFORM_VERSION}.nupkg`, Buffer.alloc(0), /NuGet package/i],
    [`dotnet/Licensecc.Client.${PLATFORM_VERSION}.nupkg`, nugetArtifact().subarray(0, 8), /ZIP|NuGet package/i],
    [`dotnet/Licensecc.Client.${PLATFORM_VERSION}.nupkg`, nugetArtifact({ metadataId: "Other.Client" }), /NuGet package metadata/i],
    [`dotnet/Licensecc.Client.${PLATFORM_VERSION}.snupkg`, Buffer.alloc(0), /NuGet symbols/i],
    [`dotnet/Licensecc.Client.${PLATFORM_VERSION}.snupkg`, nugetArtifact({ symbols: true }).subarray(0, 8), /ZIP|NuGet symbols/i],
    [`dotnet/Licensecc.Client.${PLATFORM_VERSION}.snupkg`, nugetArtifact({ metadataId: "Other.Client", symbols: true }), /NuGet symbols metadata/i],
  ];
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "inspect-payloads");
  try {
    assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true });
    for (const [path, invalidBytes, pattern] of cases) {
      const target = join(output, ...path.split("/"));
      const original = readFileSync(target);
      try {
        writeFileSync(target, invalidBytes);
        assert.throws(
          () => inspectReleaseDirectory(output, { root }),
          pattern,
          path,
        );
      } finally {
        writeFileSync(target, original);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inner archive inspection rejects comment decoys, incomplete RECORD data, text binaries, and secret members", () => {
  const root = releaseFixture();
  const output = join(root, "build", "release-artifacts", "inner-archive-negatives");
  const wheelPath = join(output, "python", `licensecc-${PYTHON_VERSION}-py3-none-any.whl`);
  const sdistPath = join(output, "python", `licensecc-${PYTHON_VERSION}.tar.gz`);
  const primaryPath = join(output, "dotnet", `Licensecc.Client.${PLATFORM_VERSION}.nupkg`);
  const symbolsPath = join(output, "dotnet", `Licensecc.Client.${PLATFORM_VERSION}.snupkg`);
  const cases = [
    [wheelPath, wheelArtifact({ recordContents: "licensecc/__init__.py,sha256=not-a-real-hash,1\nlicensecc-0.1.0rc1.dist-info/RECORD,,\n" }), /RECORD|wheel/i],
    [wheelPath, wheelArtifact({ recordTransform: (record) => record.replace(/sha256=[^,]+/u, "sha256=AAAA") }), /RECORD|hash|wheel/i],
    [wheelPath, wheelArtifact({ recordTransform: (record) => record.replace(/,(\d+)\n/u, ",999999\n") }), /RECORD|size|wheel/i],
    [wheelPath, wheelArtifact({ extraEntries: [{ name: "private-key.pem", contents: "never package this" }] }), /unsafe|forbidden|RECORD|wheel/i],
    [sdistPath, sdistArtifact({ extraEntries: [{ name: `licensecc-${PYTHON_VERSION}/secret.db`, contents: "never package this" }] }), /unsafe|forbidden|sdist|archive/i],
    [primaryPath, nugetArtifact({ binaryContents: "plain text is not a DLL" }), /PE|DLL|NuGet package/i],
    [primaryPath, nugetArtifact({ extraEntries: [{ name: "private-key.pem", contents: "never package this" }] }), /unsafe|forbidden|NuGet package/i],
    [symbolsPath, nugetArtifact({ symbols: true, binaryContents: "plain text is not a PDB" }), /PDB|NuGet symbols/i],
    [symbolsPath, nugetArtifact({ symbols: true, extraEntries: [{ name: "private-key.pem", contents: "never package this" }] }), /unsafe|forbidden|NuGet symbols/i],
    [primaryPath, nugetArtifact({ nuspecContents: "<?xml version=\"1.0\"?><package><metadata><!-- <id>Licensecc.Client</id><version>0.1.0-rc.1</version> --></metadata></package>" }), /metadata|NuGet package/i],
    [primaryPath, nugetArtifact({ contentTypesContents: "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/></Types>" }), /content.types|OPC|NuGet package/i],
  ];
  try {
    assembleReleaseArtifacts({ root, outputDirectory: output, consumerId: "acme", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true });
    for (const [target, replacement, pattern] of cases) {
      const original = readFileSync(target);
      try {
        writeFileSync(target, replacement);
        assert.throws(() => writeReleaseMetadata({ root, outputDirectory: output, consumerId: "acme" }), pattern);
      } finally {
        writeFileSync(target, original);
        writeReleaseMetadata({ root, outputDirectory: output, consumerId: "acme" });
      }
    }
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
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: wrongSymbols, consumerId: "acme", run: fakeRun([], { wrongSymbol: true }), verifyArchive: () => {}, toolAvailable: () => true }), /NuGet symbols output is missing/);
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: wrongPython, consumerId: "acme", run: fakeRun([], { wrongPython: true }), verifyArchive: () => {}, toolAvailable: () => true }), /Python tool output contains an unexpected entry/);
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
  const variant = join(root, "build", "release-artifacts", "variant");
  try {
    assembleReleaseArtifacts({ root, outputDirectory: first, consumerId: "acme", run: fakeRun([], { workerEphemera: true, nugetEphemera: true }), verifyArchive: () => {}, toolAvailable: () => true });
    writeFileSync(join(root, "services/cloudflare-license-admin/src/index.ts"), "// mutable drift after first assembly\n");
    write(root, "services/cloudflare-license-admin/.dev.vars", "ignored-secret\n");
    assembleReleaseArtifacts({ root, outputDirectory: second, consumerId: "acme", run: fakeRun([], { workerEphemera: true, nugetEphemera: true }), verifyArchive: () => {}, toolAvailable: () => true });
    for (const file of ["checksums.sha256", "release-manifest.json", "spdx.json"]) assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)), file);
    const firstCpp = readdirSync(join(first, "cpp"));
    const secondCpp = readdirSync(join(second, "cpp"));
    assert.deepEqual(firstCpp, secondCpp);
    assert.deepEqual(readFileSync(join(first, "cpp", firstCpp[0])), readFileSync(join(second, "cpp", secondCpp[0])));
    assert.doesNotThrow(() => verifyReleaseArtifactReproducibility({ firstDirectory: first, secondDirectory: second, root }));
    assembleReleaseArtifacts({ root, outputDirectory: variant, consumerId: "acme", run: fakeRun([], { workerVariant: true, workerEphemera: true, nugetEphemera: true }), verifyArchive: () => {}, toolAvailable: () => true });
    assert.throws(() => verifyReleaseArtifactReproducibility({ firstDirectory: first, secondDirectory: variant, root }), /not reproducible: workers\//);
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
    const shortProbe = join(parent, "p");
    const shortSource = join(shortProbe, "src");
    const shortPlan = planArchiveVerification({ archivePath: archive, tempParent: parent, probeDirectory: shortProbe, sourceDirectory: shortSource });
    assert.equal(shortPlan[0].args[shortPlan[0].args.indexOf("-S") + 1], join(shortSource, "extern", "license-generator"));
    assert.equal(shortPlan[2].args[shortPlan[2].args.indexOf("-S") + 1], shortSource);
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
  assert.throws(() => parseArgs(["node", "script", "--repeat-output", "a", "--repeat-output", "b"]), /invalid argument/);
  assert.throws(() => parseArgs(["node", "script", "--allow-partial", "--allow-partial"]), /duplicate argument/);
  const root = releaseFixture();
  try {
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: join(root, "build", "release-artifacts", "wrong-platform"), consumerId: "acme", expectedPlatformVersion: "9.9.9", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true }), /does not match tracked version authority/);
    assert.throws(() => assembleReleaseArtifacts({ root, outputDirectory: join(root, "build", "release-artifacts", "wrong-python"), consumerId: "acme", expectedPythonVersion: "9.9.9", run: fakeRun([]), verifyArchive: () => {}, toolAvailable: () => true }), /does not match tracked version authority/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
