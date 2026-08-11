import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkVersionContract } from "./check-version-contract.mjs";

const platformVersion = "0.1.0-rc.1";
const pythonVersion = "0.1.0rc1";

function manifest(name) {
  return `${JSON.stringify({ name, version: platformVersion }, null, 2)}\n`;
}

function alignedFiles() {
  const packageNames = {
    "package.json": "licensecc",
    "packages/cloudflare-runtime/package.json": "@licensecc/cloudflare-runtime",
    "packages/licensing-domain/package.json": "@licensecc/licensing-domain",
    "services/cloudflare-customer-portal/package.json": "@licensecc/cloudflare-customer-portal",
    "services/cloudflare-d1-backup/package.json": "@licensecc/cloudflare-d1-backup",
    "services/cloudflare-license-admin/package.json": "@licensecc/cloudflare-license-admin",
    "services/cloudflare-licensing-backend/package.json": "@licensecc/cloudflare-licensing-backend",
  };
  const packages = Object.fromEntries(Object.entries(packageNames).map(([path, name]) => [
    path === "package.json" ? "" : dirname(path).replaceAll("\\", "/"),
    { name, version: platformVersion },
  ]));
  const manifests = Object.fromEntries(Object.entries(packageNames).map(([path, name]) => [path, manifest(name)]));
  manifests["package.json"] = `${JSON.stringify({
    name: "licensecc",
    version: platformVersion,
    workspaces: Object.keys(packageNames).filter((path) => path !== "package.json").map((path) => dirname(path).replaceAll("\\", "/")),
  }, null, 2)}\n`;
  return {
    "version.json": `${JSON.stringify({ schema_version: 1, platform_version: platformVersion }, null, 2)}\n`,
    ...manifests,
    "package-lock.json": `${JSON.stringify({ name: "licensecc", version: platformVersion, lockfileVersion: 3, packages }, null, 2)}\n`,
    "services/cloudflare-licensing-backend/src/openapi/document.ts": `export const openApiSpec = { info: { version: "${platformVersion}" } };\n`,
    "services/cloudflare-license-admin/src/worker/openapi/document.ts": `export const openApiDocument = { info: { version: "${platformVersion}" } };\n`,
    "services/cloudflare-customer-portal/src/worker/openapi/document.ts": `export const openApiDocument = { info: { version: "${platformVersion}" } };\n`,
    "test/contracts/backend.json": `${JSON.stringify({ openApiSpec: { info: { version: platformVersion } } })}\n`,
    "test/contracts/admin.json": `${JSON.stringify({ openApiDocument: { info: { version: platformVersion } } })}\n`,
    "test/contracts/portal.json": `${JSON.stringify({ openApiDocument: { info: { version: platformVersion } } })}\n`,
    "sdks/python/pyproject.toml": `[project]\nname = "licensecc"\nversion = "${pythonVersion}"\n`,
    "sdks/python/uv.lock": `version = 1\n\n[[package]]\nname = "licensecc"\nversion = "${pythonVersion}"\nsource = { editable = "." }\n`,
    "sdks/python/src/licensecc/__init__.py": `__version__ = "${pythonVersion}"\n`,
    "sdks/python/src/licensecc/http_client.py": `user_agent: str = "licensecc-python-sdk/${pythonVersion}",\n`,
    "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj": `<Project><PropertyGroup><Version>${platformVersion}</Version></PropertyGroup></Project>\n`,
    "sdks/dotnet/README.md": `PackageId Licensecc.Client, ${platformVersion}\n`,
    "README.md": `Platform version: ${platformVersion}. C++ version: 2.1.0.\n`,
    "CHANGELOG.md": `Platform packages: ${platformVersion}. C++ library: 2.1.0.\n`,
    "CMakeLists.txt": `project(licensecc VERSION 2.1.0)\n`,
    "include/licensecc/licensecc.h": [
      "#define LCC_VERSION_MAJOR 2",
      "#define LCC_VERSION_MINOR 1",
      "#define LCC_VERSION_PATCH 0",
      '#define LCC_VERSION_STRING "2.1.0"',
      "",
    ].join("\n"),
    "doc/conf.py": `version = '2.1.0'\nrelease = '2.1.0'\n`,
  };
}

function fixture(mutator = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "licensecc-version-contract-"));
  const files = alignedFiles();
  mutator(files);
  for (const [relativePath, source] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return { root, trackedPaths: Object.keys(files), close: () => rmSync(root, { recursive: true, force: true }) };
}

test("accepts every aligned platform projection and the independent C++ stream", () => {
  const sample = fixture();
  try {
    assert.deepEqual(checkVersionContract(sample).errors, []);
  } finally {
    sample.close();
  }
});

const driftCases = [
  ["Node manifest", "packages/licensing-domain/package.json"],
  ["npm lockfile", "package-lock.json"],
  ["OpenAPI source", "services/cloudflare-license-admin/src/worker/openapi/document.ts"],
  ["OpenAPI snapshot", "test/contracts/portal.json"],
  ["Python metadata", "sdks/python/pyproject.toml"],
  ["Python lock", "sdks/python/uv.lock"],
  ["Python runtime", "sdks/python/src/licensecc/__init__.py"],
  ["Python User-Agent", "sdks/python/src/licensecc/http_client.py"],
  [".NET metadata", "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj"],
  [".NET README", "sdks/dotnet/README.md"],
  ["root README", "README.md"],
  ["root changelog", "CHANGELOG.md"],
];

for (const [name, path] of driftCases) {
  test(`rejects ${name} drift`, () => {
    const sample = fixture((files) => { files[path] = files[path].replace(path === "sdks/python/pyproject.toml" || path.startsWith("sdks/python/") ? pythonVersion : platformVersion, "9.9.9"); });
    try {
      assert.ok(checkVersionContract(sample).errors.some((error) => error.code === "version_mismatch" && error.path === path));
    } finally {
      sample.close();
    }
  });
}

test("rejects malformed or extended version contracts", () => {
  const sample = fixture((files) => {
    files["version.json"] = '{"schema_version":1,"platform_version":"0.1","extra":true}\n';
  });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.code === "invalid_contract"));
  } finally {
    sample.close();
  }
});

test("rejects a workspace outside the checked version-source inventory", () => {
  const sample = fixture((files) => {
    const rootManifest = JSON.parse(files["package.json"]);
    rootManifest.workspaces.push("packages/unmanaged");
    files["package.json"] = `${JSON.stringify(rootManifest, null, 2)}\n`;
    files["packages/unmanaged/package.json"] = manifest("@licensecc/unmanaged");
  });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.code === "version_source_inventory"));
  } finally {
    sample.close();
  }
});

test("rejects missing tracked version sources", () => {
  const sample = fixture((files) => { delete files["sdks/python/uv.lock"]; });
  try {
    assert.deepEqual(checkVersionContract(sample).errors, [{ code: "untracked_version_source", path: "sdks/python/uv.lock", expected: null, actual: null }]);
  } finally {
    sample.close();
  }
});

test("keeps the C++ version internally aligned and independent", () => {
  const sample = fixture((files) => { files["include/licensecc/licensecc.h"] = files["include/licensecc/licensecc.h"].replace('"2.1.0"', '"0.1.0"'); });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.code === "cpp_version_mismatch" && error.path === "include/licensecc/licensecc.h"));
  } finally {
    sample.close();
  }
});
