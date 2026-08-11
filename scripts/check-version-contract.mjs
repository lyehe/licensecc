import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contractPath = "version.json";
const releaseToolchainsPath = "release-toolchains.json";
const globalJsonPath = "global.json";
const nodeManifestPaths = [
  "package.json",
  "packages/cloudflare-runtime/package.json",
  "packages/licensing-domain/package.json",
  "services/cloudflare-customer-portal/package.json",
  "services/cloudflare-d1-backup/package.json",
  "services/cloudflare-license-admin/package.json",
  "services/cloudflare-licensing-backend/package.json",
];
const openApiSourcePaths = [
  "services/cloudflare-licensing-backend/src/openapi/document.ts",
  "services/cloudflare-license-admin/src/worker/openapi/document.ts",
  "services/cloudflare-customer-portal/src/worker/openapi/document.ts",
];
const openApiBindings = {
  "services/cloudflare-licensing-backend/src/openapi/document.ts": "openApiSpec",
  "services/cloudflare-license-admin/src/worker/openapi/document.ts": "openApiDocument",
  "services/cloudflare-customer-portal/src/worker/openapi/document.ts": "openApiDocument",
};
const openApiSnapshotPaths = {
  "test/contracts/backend.json": ["openApiSpec", "info", "version"],
  "test/contracts/admin.json": ["openApiDocument", "info", "version"],
  "test/contracts/portal.json": ["openApiDocument", "info", "version"],
};
const platformTextPaths = ["README.md", "CHANGELOG.md", "sdks/dotnet/README.md"];
const maintainedPlatformDocPaths = [
  "doc/capabilities/index.rst",
  "doc/development/Build-the-library.md",
  "doc/development/Build-the-library-windows.rst",
  "doc/other/QA.md",
];
const capabilityRegistryPath = "doc/capabilities/registry.json";
const cppPaths = ["CMakeLists.txt", "include/licensecc/licensecc.h", "doc/conf.py"];
/**
 * The only machine-readable platform authority.  Consumers that need release
 * names must use `readVersionAuthorities` below instead of recreating a
 * permissive version parser beside their packaging logic.
 */
export const versionContractSchema = Object.freeze({
  schemaVersion: 1,
  fields: Object.freeze(["platform_version", "schema_version"]),
});
/** Exact release-toolchain authority; platform version remains version.json only. */
export const releaseToolchainSchema = Object.freeze({
  schemaVersion: 1,
  fields: Object.freeze(["dotnet_sdk_version", "python_version", "schema_version", "uv_version"]),
});
const requiredVersionPaths = [
  contractPath,
  releaseToolchainsPath,
  globalJsonPath,
  ...nodeManifestPaths,
  "package-lock.json",
  ...openApiSourcePaths,
  ...Object.keys(openApiSnapshotPaths),
  "sdks/python/pyproject.toml",
  "sdks/python/uv.lock",
  "sdks/python/src/licensecc/__init__.py",
  "sdks/python/src/licensecc/http_client.py",
  "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj",
  ...platformTextPaths,
  ...maintainedPlatformDocPaths,
  capabilityRegistryPath,
  ...cppPaths,
];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/u;
const exactToolVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function trackedPathsFromGit(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map(normalize);
}

function sourceAt(root, path) {
  return readFileSync(resolve(root, path), "utf8");
}

function mismatch(errors, path, expected, actual, code = "version_mismatch") {
  if (actual !== expected) errors.push({ code, path, expected, actual: actual ?? null });
}

function parsedJson(root, path, errors) {
  try {
    return JSON.parse(sourceAt(root, path));
  } catch {
    errors.push({ code: "invalid_version_source", path, expected: null, actual: null });
    return null;
  }
}

function nestedValue(value, keys) {
  let current = value;
  for (const key of keys) current = current?.[key];
  return current;
}

function javascriptTokens(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/u.test(character)) {
      cursor += 1;
    } else if (character === "/" && next === "/") {
      cursor = source.indexOf("\n", cursor + 2);
      if (cursor === -1) break;
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
    } else if (character === '"' || character === "'" || character === "`") {
      const delimiter = character;
      let value = "";
      let plain = true;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          value += source[cursor + 1] ?? "";
          cursor += 2;
        } else if (delimiter === "`" && source[cursor] === "$" && source[cursor + 1] === "{") {
          plain = false;
          cursor += 2;
        } else if (source[cursor] === delimiter) {
          cursor += 1;
          break;
        } else {
          value += source[cursor];
          cursor += 1;
        }
      }
      tokens.push({ kind: plain ? "string" : "template", value });
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

function matchingToken(tokens, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === opening) depth += 1;
    else if (tokens[index].value === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function objectPropertyValues(tokens, objectStart, name) {
  const objectEnd = matchingToken(tokens, objectStart, "{", "}");
  if (objectEnd === -1) return [];
  const values = [];
  let depth = 0;
  for (let index = objectStart + 1; index < objectEnd; index += 1) {
    const value = tokens[index].value;
    if (value === "{" || value === "[" || value === "(") depth += 1;
    else if (value === "}" || value === "]" || value === ")") depth -= 1;
    else if (depth === 0 && value === name && tokens[index + 1]?.value === ":") values.push(index + 2);
  }
  return values;
}

function openApiInfoVersion(source, binding) {
  const tokens = javascriptTokens(source);
  const initializers = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index].value !== "export" || tokens[index + 1].value !== "const" || tokens[index + 2].value !== binding) continue;
    let assignment = index + 3;
    while (assignment < tokens.length && tokens[assignment].value !== "=" && tokens[assignment].value !== ";") assignment += 1;
    if (tokens[assignment]?.value === "=" && tokens[assignment + 1]?.value === "{") initializers.push(assignment + 1);
  }
  if (initializers.length !== 1) return null;
  const infoValues = objectPropertyValues(tokens, initializers[0], "info");
  if (infoValues.length !== 1 || tokens[infoValues[0]]?.value !== "{") return null;
  const versionValues = objectPropertyValues(tokens, infoValues[0], "version");
  if (versionValues.length !== 1 || tokens[versionValues[0]]?.kind !== "string") return null;
  return tokens[versionValues[0]].value;
}

function maskCmakeNonCode(source) {
  const output = [...source];
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === "#") {
      const bracket = /^#\[(=*)\[/u.exec(source.slice(cursor));
      if (bracket) {
        const closing = `]${bracket[1]}]`;
        const end = source.indexOf(closing, cursor + bracket[0].length);
        const next = end === -1 ? source.length : end + closing.length;
        mask(cursor, next);
        cursor = next;
      } else {
        const end = source.indexOf("\n", cursor + 1);
        const next = end === -1 ? source.length : end;
        mask(cursor, next);
        cursor = next;
      }
    } else if (source[cursor] === '"') {
      const start = cursor;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === '"') {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      mask(start, cursor);
    } else {
      const bracket = /^\[(=*)\[/u.exec(source.slice(cursor));
      if (!bracket) {
        cursor += 1;
        continue;
      }
      const closing = `]${bracket[1]}]`;
      const end = source.indexOf(closing, cursor + bracket[0].length);
      const next = end === -1 ? source.length : end + closing.length;
      mask(cursor, next);
      cursor = next;
    }
  }
  return output.join("");
}

function maskMatchedText(value) {
  return value.replace(/[^\r\n]/gu, " ");
}

function maskProseComments(source, path) {
  let visible = source.replace(/<!--[\s\S]*?(?:-->|$)/gu, maskMatchedText);
  if (!path.endsWith(".rst")) return visible;

  const lines = visible.match(/.*(?:\r?\n|$)/gu) ?? [];
  let commentIndent = null;
  visible = lines.map((line) => {
    const body = line.replace(/\r?\n$/u, "");
    const indentation = /^\s*/u.exec(body)?.[0].length ?? 0;
    const startsComment = /^\s*\.\.(?:\s|$)/u.test(body);
    if (startsComment) commentIndent = indentation;
    else if (commentIndent !== null && body.trim() !== "" && indentation <= commentIndent) commentIndent = null;
    if (commentIndent !== null) return maskMatchedText(line);
    return line;
  }).join("");
  return visible;
}

function proseAt(root, path) {
  return maskProseComments(sourceAt(root, path), path);
}

function pythonVersionFor(platformVersion) {
  const match = semverPattern.exec(platformVersion);
  if (!match) return null;
  const [, major, minor, patch, prerelease, prereleaseNumber] = match;
  if (!prerelease) return `${major}.${minor}.${patch}`;
  const marker = prerelease === "alpha" ? "a" : prerelease === "beta" ? "b" : "rc";
  return `${major}.${minor}.${patch}${marker}${prereleaseNumber}`;
}

function tomlSection(source, heading) {
  const start = source.indexOf(`[${heading}]`);
  if (start === -1) return "";
  const remainder = source.slice(start + heading.length + 2);
  const next = remainder.search(/^\[/mu);
  return next === -1 ? remainder : remainder.slice(0, next);
}

function assignment(source, name) {
  return new RegExp(`^${name}\\s*=\\s*["']([^"']+)["']\\s*$`, "mu").exec(source)?.[1] ?? null;
}

function pythonLockVersion(source) {
  for (const block of source.split(/^\[\[package\]\]\s*$/mu).slice(1)) {
    if (assignment(block, "name") === "licensecc") return assignment(block, "version");
  }
  return null;
}

function cppVersionFromSource(source, errors) {
  const projectCalls = [...maskCmakeNonCode(source).matchAll(/\bproject\s*\(([^)]*)\)/giu)];
  const licenseccCalls = projectCalls.filter((match) => /^\s*licensecc(?:\s|$)/iu.test(match[1]));
  const versions = licenseccCalls.map((match) => /\bVERSION\s+(\d+\.\d+\.\d+)\b/iu.exec(match[1])?.[1]).filter(Boolean);
  const version = licenseccCalls.length === 1 && versions.length === 1 ? versions[0] : null;
  if (version === null) errors.push({ code: "invalid_version_source", path: "CMakeLists.txt", expected: null, actual: null });
  return version;
}

function cppVersion(root, errors) {
  return cppVersionFromSource(sourceAt(root, "CMakeLists.txt"), errors);
}

/**
 * Read the three independent release authorities with the same strict grammar
 * used by the repository-wide contract checker.  `readSource` lets release
 * tooling supply canonical Git blobs rather than a mutable worktree.
 */
export function readVersionAuthorities({ root = repositoryRoot, readSource = (path) => sourceAt(root, path) } = {}) {
  const errors = [];
  let contract;
  try {
    contract = JSON.parse(readSource(contractPath));
  } catch {
    errors.push({ code: "invalid_version_source", path: contractPath, expected: null, actual: null });
    return { versions: null, errors };
  }

  const fields = contract && typeof contract === "object" && !Array.isArray(contract) ? Object.keys(contract).sort() : [];
  const platformVersion = contract?.platform_version;
  if (contract?.schema_version !== versionContractSchema.schemaVersion || fields.join(",") !== versionContractSchema.fields.join(",") || typeof platformVersion !== "string" || !semverPattern.test(platformVersion)) {
    errors.push({ code: "invalid_contract", path: contractPath, expected: "schema 1 supported platform SemVer", actual: platformVersion ?? null });
    return { versions: null, errors };
  }

  const pythonVersion = pythonVersionFor(platformVersion);
  let pyproject;
  try {
    pyproject = readSource("sdks/python/pyproject.toml");
  } catch {
    errors.push({ code: "invalid_version_source", path: "sdks/python/pyproject.toml", expected: null, actual: null });
  }
  mismatch(errors, "sdks/python/pyproject.toml", pythonVersion, pyproject === undefined ? null : assignment(tomlSection(pyproject, "project"), "version"));

  let cppSource;
  try {
    cppSource = readSource("CMakeLists.txt");
  } catch {
    errors.push({ code: "invalid_version_source", path: "CMakeLists.txt", expected: null, actual: null });
  }
  const cpp = cppSource === undefined ? null : cppVersionFromSource(cppSource, errors);
  // Keep a valid platform authority available even when an independent
  // projection drifts.  The repository checker must still report every other
  // platform projection in that situation; release assembly rejects any
  // returned authority errors below.
  return { versions: { platformVersion, pythonVersion, cppVersion: cpp }, errors };
}

/**
 * Read the exact release toolchain authority and its independent .NET SDK
 * selector.  This is intentionally separate from version.json: tools are
 * build inputs, not package-version authorities.
 */
export function readReleaseToolchainAuthorities({ root = repositoryRoot, readSource = (path) => sourceAt(root, path) } = {}) {
  const errors = [];
  let contract;
  let global;
  try {
    contract = JSON.parse(readSource(releaseToolchainsPath));
  } catch {
    errors.push({ code: "invalid_toolchain_source", path: releaseToolchainsPath, expected: null, actual: null });
  }
  try {
    global = JSON.parse(readSource(globalJsonPath));
  } catch {
    errors.push({ code: "invalid_toolchain_source", path: globalJsonPath, expected: null, actual: null });
  }
  if (!contract || !global) return { toolchains: null, errors };
  const fields = typeof contract === "object" && !Array.isArray(contract) ? Object.keys(contract).sort() : [];
  const pythonVersion = contract.python_version;
  const uvVersion = contract.uv_version;
  const dotnetSdkVersion = contract.dotnet_sdk_version;
  if (contract.schema_version !== releaseToolchainSchema.schemaVersion || fields.join(",") !== releaseToolchainSchema.fields.join(",") || ![pythonVersion, uvVersion, dotnetSdkVersion].every((value) => typeof value === "string" && exactToolVersionPattern.test(value))) {
    errors.push({ code: "invalid_toolchain_contract", path: releaseToolchainsPath, expected: "schema 1 with exact Python, uv, and .NET x.y.z versions", actual: null });
    return { toolchains: null, errors };
  }
  const globalFields = typeof global === "object" && !Array.isArray(global) ? Object.keys(global).sort() : [];
  const sdk = global.sdk;
  const sdkFields = sdk && typeof sdk === "object" && !Array.isArray(sdk) ? Object.keys(sdk).sort() : [];
  if (globalFields.join(",") !== "sdk" || sdkFields.join(",") !== "allowPrerelease,rollForward,version" || sdk.version !== dotnetSdkVersion || sdk.rollForward !== "disable" || sdk.allowPrerelease !== false) {
    errors.push({ code: "dotnet_sdk_authority_mismatch", path: globalJsonPath, expected: `${dotnetSdkVersion} with rollForward=disable`, actual: sdk?.version ?? null });
  }
  return { toolchains: { pythonVersion, uvVersion, dotnetSdkVersion }, errors };
}

function checkCppProjections(root, errors) {
  const version = cppVersion(root, errors);
  if (version === null) return;
  const [major, minor, patch] = version.split(".");
  const headerPath = "include/licensecc/licensecc.h";
  const header = sourceAt(root, headerPath);
  const headerValues = {
    major: /^#define LCC_VERSION_MAJOR\s+(\d+)\s*$/mu.exec(header)?.[1] ?? null,
    minor: /^#define LCC_VERSION_MINOR\s+(\d+)\s*$/mu.exec(header)?.[1] ?? null,
    patch: /^#define LCC_VERSION_PATCH\s+(\d+)\s*$/mu.exec(header)?.[1] ?? null,
    version: /^#define LCC_VERSION_STRING\s+"([^"]+)"\s*$/mu.exec(header)?.[1] ?? null,
  };
  if (headerValues.major !== major || headerValues.minor !== minor || headerValues.patch !== patch || headerValues.version !== version) {
    errors.push({ code: "cpp_version_mismatch", path: headerPath, expected: version, actual: headerValues.version });
  }

  const confPath = "doc/conf.py";
  const conf = sourceAt(root, confPath);
  const shortVersion = assignment(conf, "version");
  const releaseVersion = assignment(conf, "release");
  if (shortVersion !== version || releaseVersion !== version) {
    errors.push({ code: "cpp_version_mismatch", path: confPath, expected: version, actual: releaseVersion });
  }
  const readmeVersioning = /^\*\*Versioning:\*\*[^\n]*(?:\n(?!\s*$)[^\n]*)*/mu.exec(proseAt(root, "README.md"))?.[0] ?? "";
  if (!readmeVersioning.includes(`\`${version}\` in CMake`)) errors.push({ code: "cpp_version_mismatch", path: "README.md", expected: version, actual: null });
  const changelogCpp = /^- \*\*C\+\+ library\*\*[^\n]*(?:\n {2}[^\n]*)*/mu.exec(proseAt(root, "CHANGELOG.md"))?.[0] ?? "";
  if (!changelogCpp.includes(`\`${version}\``)) errors.push({ code: "cpp_version_mismatch", path: "CHANGELOG.md", expected: version, actual: null });
}

function anchoredPlatformProjections(root, platformVersion, pythonVersion, errors) {
  const readmeVersioning = /^\*\*Versioning:\*\*[^\n]*(?:\n(?!\s*$)[^\n]*)*/mu.exec(proseAt(root, "README.md"))?.[0] ?? "";
  mismatch(errors, "README.md", platformVersion, readmeVersioning.includes(`\`${platformVersion}\``) ? platformVersion : null);

  const changelogPlatform = /^- \*\*Platform packages\*\*[^\n]*(?:\n {2}[^\n]*)*/mu.exec(proseAt(root, "CHANGELOG.md"))?.[0] ?? "";
  const changelogAligned = changelogPlatform.includes(`\`${platformVersion}\``) && changelogPlatform.includes(`\`${pythonVersion}\``);
  mismatch(errors, "CHANGELOG.md", platformVersion, changelogAligned ? platformVersion : null);

  const dotnetPath = "sdks/dotnet/README.md";
  const dotnetPattern = new RegExp(`^ {2}src/Licensecc\\.Client/\\s+# the library \\(PackageId Licensecc\\.Client, ${platformVersion.replaceAll(".", "\\.")}\\)\\s*$`, "mu");
  mismatch(errors, dotnetPath, platformVersion, dotnetPattern.test(proseAt(root, dotnetPath)) ? platformVersion : null);

  const escapedPlatformVersion = platformVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const docMarker = new RegExp(`The platform is at\\s+\\*\\*${escapedPlatformVersion}\\*\\* \\(a prerelease\\)`, "mu");
  for (const path of maintainedPlatformDocPaths) mismatch(errors, path, platformVersion, docMarker.test(proseAt(root, path)) ? platformVersion : null);

  const registry = parsedJson(root, capabilityRegistryPath, errors);
  if (!registry) return;
  const platformStatuses = new Set(["shipped", "platform_limited", "experimental"]);
  for (const capability of registry.capabilities ?? []) {
    const release = capability?.availability?.release;
    if (!platformStatuses.has(capability?.status)) continue;
    if (typeof release !== "string") {
      errors.push({ code: "version_mismatch", path: capabilityRegistryPath, expected: platformVersion, actual: release ?? null });
      continue;
    }
    const versions = [...release.matchAll(/\bplatform\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+prerelease)?/giu)];
    if (versions.length !== 1 || versions[0][1] !== platformVersion || /\bplatform\s+\S+\s+prerelease\b/iu.test(release)) {
      errors.push({ code: "version_mismatch", path: capabilityRegistryPath, expected: platformVersion, actual: release });
    }
  }
}

/** Validate every tracked projection of the platform contract and the independent C++ stream. */
export function checkVersionContract({ root = repositoryRoot, trackedPaths = trackedPathsFromGit(root) } = {}) {
  const tracked = new Set(trackedPaths.map(normalize));
  const missing = requiredVersionPaths.filter((path) => !tracked.has(path));
  if (missing.length > 0) {
    return { errors: missing.map((path) => ({ code: "untracked_version_source", path, expected: null, actual: null })) };
  }

  const authority = readVersionAuthorities({ root });
  const errors = [...authority.errors];
  const toolchainAuthority = readReleaseToolchainAuthorities({ root });
  errors.push(...toolchainAuthority.errors);
  if (!authority.versions) return { errors };
  const { platformVersion, pythonVersion, cppVersion: authoritativeCppVersion } = authority.versions;

  const expectedWorkspaces = nodeManifestPaths.slice(1).map((path) => path.slice(0, path.lastIndexOf("/"))).sort();
  const manifests = new Map();
  for (const path of nodeManifestPaths) {
    const manifest = parsedJson(root, path, errors);
    if (!manifest) continue;
    manifests.set(path, manifest);
    mismatch(errors, path, platformVersion, manifest.version);
    if (path === "package.json") {
      const actualWorkspaces = Array.isArray(manifest.workspaces) ? [...manifest.workspaces].sort() : [];
      if (JSON.stringify(actualWorkspaces) !== JSON.stringify(expectedWorkspaces)) {
        errors.push({ code: "version_source_inventory", path, expected: expectedWorkspaces.join(","), actual: actualWorkspaces.join(",") });
      }
    }
  }

  const lockPath = "package-lock.json";
  const lock = parsedJson(root, lockPath, errors);
  if (lock) {
    const rootManifest = manifests.get("package.json");
    if (lock.name !== rootManifest?.name || lock.version !== platformVersion || lock.packages?.[""]?.name !== rootManifest?.name || lock.packages?.[""]?.version !== platformVersion) {
      errors.push({ code: "lockfile_root_mismatch", path: lockPath, expected: `${rootManifest?.name}@${platformVersion}`, actual: `${lock.packages?.[""]?.name ?? lock.name ?? "<none>"}@${lock.packages?.[""]?.version ?? lock.version ?? "<none>"}` });
    }
    const manifestWorkspaces = rootManifest?.workspaces ?? [];
    if (JSON.stringify(lock.packages?.[""]?.workspaces) !== JSON.stringify(manifestWorkspaces)) {
      errors.push({ code: "lockfile_workspaces_mismatch", path: lockPath, expected: manifestWorkspaces.join(","), actual: lock.packages?.[""]?.workspaces?.join(",") ?? null });
    }
    for (const manifestPath of nodeManifestPaths.slice(1)) {
      const packagePath = manifestPath === "package.json" ? "" : manifestPath.slice(0, manifestPath.lastIndexOf("/"));
      const manifest = manifests.get(manifestPath);
      const entry = lock.packages?.[packagePath];
      if (entry?.name !== manifest?.name || entry?.version !== platformVersion) {
        errors.push({ code: "lockfile_workspace_mismatch", path: lockPath, expected: `${packagePath}:${manifest?.name}@${platformVersion}`, actual: entry ? `${entry.name ?? "<none>"}@${entry.version ?? "<none>"}` : null });
      }
      const link = lock.packages?.[`node_modules/${manifest?.name}`];
      if (link?.link !== true || link?.resolved !== packagePath) {
        errors.push({ code: "lockfile_link_mismatch", path: lockPath, expected: `${manifest?.name}->${packagePath}`, actual: link?.resolved ?? null });
      }
    }
  }

  for (const path of openApiSourcePaths) {
    mismatch(errors, path, platformVersion, openApiInfoVersion(sourceAt(root, path), openApiBindings[path]));
  }
  for (const [path, keys] of Object.entries(openApiSnapshotPaths)) {
    const snapshot = parsedJson(root, path, errors);
    if (snapshot) mismatch(errors, path, platformVersion, nestedValue(snapshot, keys));
  }

  const pyprojectPath = "sdks/python/pyproject.toml";
  mismatch(errors, pyprojectPath, pythonVersion, assignment(tomlSection(sourceAt(root, pyprojectPath), "project"), "version"));
  const uvLockPath = "sdks/python/uv.lock";
  mismatch(errors, uvLockPath, pythonVersion, pythonLockVersion(sourceAt(root, uvLockPath)));
  const pythonRuntimePath = "sdks/python/src/licensecc/__init__.py";
  mismatch(errors, pythonRuntimePath, pythonVersion, assignment(sourceAt(root, pythonRuntimePath), "__version__"));
  const userAgentPath = "sdks/python/src/licensecc/http_client.py";
  const userAgent = /user_agent:\s*str\s*=\s*["']licensecc-python-sdk\/([^"']+)["']/u.exec(sourceAt(root, userAgentPath))?.[1] ?? null;
  mismatch(errors, userAgentPath, pythonVersion, userAgent);

  const dotnetPath = "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj";
  const dotnetVersion = /<Version>([^<]+)<\/Version>/u.exec(sourceAt(root, dotnetPath))?.[1] ?? null;
  mismatch(errors, dotnetPath, platformVersion, dotnetVersion);
  anchoredPlatformProjections(root, platformVersion, pythonVersion, errors);

  // The authority reader above is deliberately the only CMake grammar used by
  // release consumers.  Keep these projection checks, which validate the
  // public C++ surfaces against that already-parsed independent value.
  if (cppVersion(root, []) !== authoritativeCppVersion) {
    errors.push({ code: "invalid_version_source", path: "CMakeLists.txt", expected: null, actual: null });
  }
  checkCppProjections(root, errors);
  return { errors };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { errors } = checkVersionContract();
  if (errors.length > 0) {
    for (const error of errors) console.error(`version-contract ${error.code}: ${error.path} expected=${error.expected ?? "<none>"} actual=${error.actual ?? "<none>"}`);
    process.exitCode = 1;
  }
}
