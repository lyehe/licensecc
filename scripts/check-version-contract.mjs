import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contractPath = "version.json";
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
const openApiSnapshotPaths = {
  "test/contracts/backend.json": ["openApiSpec", "info", "version"],
  "test/contracts/admin.json": ["openApiDocument", "info", "version"],
  "test/contracts/portal.json": ["openApiDocument", "info", "version"],
};
const platformTextPaths = ["README.md", "CHANGELOG.md", "sdks/dotnet/README.md"];
const cppPaths = ["CMakeLists.txt", "include/licensecc/licensecc.h", "doc/conf.py"];
const requiredVersionPaths = [
  contractPath,
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
  ...cppPaths,
];
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/u;

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

function cppVersion(root, errors) {
  const source = sourceAt(root, "CMakeLists.txt");
  const version = /\bproject\s*\([\s\S]*?\bVERSION\s+(\d+\.\d+\.\d+)\b/iu.exec(source)?.[1] ?? null;
  if (version === null) errors.push({ code: "invalid_version_source", path: "CMakeLists.txt", expected: null, actual: null });
  return version;
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
  for (const path of ["README.md", "CHANGELOG.md"]) {
    if (!sourceAt(root, path).includes(version)) errors.push({ code: "cpp_version_mismatch", path, expected: version, actual: null });
  }
}

/** Validate every tracked projection of the platform contract and the independent C++ stream. */
export function checkVersionContract({ root = repositoryRoot, trackedPaths = trackedPathsFromGit(root) } = {}) {
  const tracked = new Set(trackedPaths.map(normalize));
  const missing = requiredVersionPaths.filter((path) => !tracked.has(path));
  if (missing.length > 0) {
    return { errors: missing.map((path) => ({ code: "untracked_version_source", path, expected: null, actual: null })) };
  }

  const errors = [];
  const contract = parsedJson(root, contractPath, errors);
  const fields = contract && typeof contract === "object" && !Array.isArray(contract) ? Object.keys(contract).sort() : [];
  const platformVersion = contract?.platform_version;
  if (contract?.schema_version !== 1 || fields.join(",") !== "platform_version,schema_version" || typeof platformVersion !== "string" || !semverPattern.test(platformVersion)) {
    errors.push({ code: "invalid_contract", path: contractPath, expected: "schema 1 supported platform SemVer", actual: platformVersion ?? null });
    return { errors };
  }
  const pythonVersion = pythonVersionFor(platformVersion);

  const expectedWorkspaces = nodeManifestPaths.slice(1).map((path) => path.slice(0, path.lastIndexOf("/"))).sort();
  for (const path of nodeManifestPaths) {
    const manifest = parsedJson(root, path, errors);
    if (!manifest) continue;
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
    mismatch(errors, lockPath, platformVersion, lock.version);
    for (const manifestPath of nodeManifestPaths) {
      const packagePath = manifestPath === "package.json" ? "" : manifestPath.slice(0, manifestPath.lastIndexOf("/"));
      mismatch(errors, lockPath, platformVersion, lock.packages?.[packagePath]?.version);
    }
  }

  for (const path of openApiSourcePaths) {
    const values = [...sourceAt(root, path).matchAll(/\bversion:\s*["']([^"']+)["']/gu)].map((match) => match[1]);
    mismatch(errors, path, platformVersion, values.length === 1 ? values[0] : null);
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
  for (const path of platformTextPaths) {
    mismatch(errors, path, platformVersion, sourceAt(root, path).includes(platformVersion) ? platformVersion : null);
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
