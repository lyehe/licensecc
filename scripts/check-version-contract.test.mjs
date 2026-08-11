import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkVersionContract, readReleaseToolchainAuthorities, readVersionAuthorities, releaseToolchainSchema, versionContractSchema } from "./check-version-contract.mjs";

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
  const workspacePaths = Object.keys(packageNames).filter((path) => path !== "package.json").map((path) => dirname(path).replaceAll("\\", "/"));
  const packages = Object.fromEntries(Object.entries(packageNames).map(([path, name]) => [
    path === "package.json" ? "" : dirname(path).replaceAll("\\", "/"),
    { name, version: platformVersion },
  ]));
  packages[""].workspaces = workspacePaths;
  for (const [path, name] of Object.entries(packageNames).filter(([path]) => path !== "package.json")) {
    packages[`node_modules/${name}`] = { resolved: dirname(path).replaceAll("\\", "/"), link: true };
  }
  const manifests = Object.fromEntries(Object.entries(packageNames).map(([path, name]) => [path, manifest(name)]));
  manifests["package.json"] = `${JSON.stringify({
    name: "licensecc",
    version: platformVersion,
    workspaces: workspacePaths,
  }, null, 2)}\n`;
  return {
    "version.json": `${JSON.stringify({ schema_version: 1, platform_version: platformVersion }, null, 2)}\n`,
    "release-toolchains.json": `${JSON.stringify({ schema_version: 1, python_version: "3.12.8", uv_version: "0.5.15", dotnet_sdk_version: "8.0.423" }, null, 2)}\n`,
    "global.json": `${JSON.stringify({ sdk: { version: "8.0.423", rollForward: "disable", allowPrerelease: false } }, null, 2)}\n`,
    ...manifests,
    "package-lock.json": `${JSON.stringify({ name: "licensecc", version: platformVersion, lockfileVersion: 3, packages }, null, 2)}\n`,
    "services/cloudflare-licensing-backend/src/openapi/document.ts": `export const openApiSpec: OpenApiDocument = { info: { version: "${platformVersion}" } };\n`,
    "services/cloudflare-license-admin/src/worker/openapi/document.ts": `export const openApiDocument: OpenApiDocument = { info: { version: "${platformVersion}" } };\n`,
    "services/cloudflare-customer-portal/src/worker/openapi/document.ts": `export const openApiDocument: OpenApiDocument = { info: { version: "${platformVersion}" } };\n`,
    "test/contracts/backend.json": `${JSON.stringify({ openApiSpec: { info: { version: platformVersion } } })}\n`,
    "test/contracts/admin.json": `${JSON.stringify({ openApiDocument: { info: { version: platformVersion } } })}\n`,
    "test/contracts/portal.json": `${JSON.stringify({ openApiDocument: { info: { version: platformVersion } } })}\n`,
    "sdks/python/pyproject.toml": `[project]\nname = "licensecc"\nversion = "${pythonVersion}"\n`,
    "sdks/python/uv.lock": `version = 1\n\n[[package]]\nname = "licensecc"\nversion = "${pythonVersion}"\nsource = { editable = "." }\n`,
    "sdks/python/src/licensecc/__init__.py": `__version__ = "${pythonVersion}"\n`,
    "sdks/python/src/licensecc/http_client.py": `user_agent: str = "licensecc-python-sdk/${pythonVersion}",\n`,
    "sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj": `<Project><PropertyGroup><Version>${platformVersion}</Version></PropertyGroup></Project>\n`,
    "sdks/dotnet/README.md": `  src/Licensecc.Client/            # the library (PackageId Licensecc.Client, ${platformVersion})\n`,
    "README.md": `**Versioning:** The C++ library carries version (\`2.1.0\` in CMake); the platform packages are \`${platformVersion}\`.\n`,
    "CHANGELOG.md": `- **C++ library** (\`CMakeLists.txt\`): \`2.1.0\` — lineage.\n- **Platform packages** (release set): \`${platformVersion}\` (Python \`${pythonVersion}\`).\n`,
    "doc/capabilities/index.rst": `The platform is at **${platformVersion}** (a prerelease).\n`,
    "doc/development/Build-the-library.md": `The platform is at **${platformVersion}** (a prerelease).\n`,
    "doc/development/Build-the-library-windows.rst": `The platform is at **${platformVersion}** (a prerelease).\n`,
    "doc/other/QA.md": `The platform is at **${platformVersion}** (a prerelease).\n`,
    "doc/capabilities/registry.json": `${JSON.stringify({
      schema_version: 1,
      capabilities: [
        { id: "platform", status: "shipped", availability: { release: `Platform ${platformVersion}` } },
        { id: "mixed", status: "experimental", availability: { release: `C++ 2.1.0 lineage; platform ${platformVersion}` } },
        { id: "cpp", status: "planned", availability: { release: "C++ 2.1.0 lineage" } },
      ],
    })}\n`,
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

test("exports the strict release authority reader used by artifact assembly", () => {
  const sample = fixture();
  try {
    assert.deepEqual(versionContractSchema, { schemaVersion: 1, fields: ["platform_version", "schema_version"] });
    assert.deepEqual(readVersionAuthorities({ root: sample.root }), {
      versions: { platformVersion, pythonVersion, cppVersion: "2.1.0" },
      errors: [],
    });
    assert.deepEqual(releaseToolchainSchema, { schemaVersion: 1, fields: ["dotnet_sdk_version", "python_version", "schema_version", "uv_version"] });
    assert.deepEqual(readReleaseToolchainAuthorities({ root: sample.root }), {
      toolchains: { pythonVersion: "3.12.8", uvVersion: "0.5.15", dotnetSdkVersion: "8.0.423" },
      errors: [],
    });
  } finally {
    sample.close();
  }
});

test("rejects missing, floating, or inconsistent release toolchain authorities", () => {
  const cases = [
    ["missing uv exact version", (files) => { files["release-toolchains.json"] = `${JSON.stringify({ schema_version: 1, python_version: "3.12", uv_version: "0.5.15", dotnet_sdk_version: "8.0.423" })}\n`; }, "release-toolchains.json"],
    ["global SDK mismatch", (files) => { files["global.json"] = `${JSON.stringify({ sdk: { version: "8.0.424", rollForward: "disable", allowPrerelease: false } })}\n`; }, "global.json"],
    ["floating SDK roll forward", (files) => { files["global.json"] = `${JSON.stringify({ sdk: { version: "8.0.423", rollForward: "latestFeature", allowPrerelease: false } })}\n`; }, "global.json"],
  ];
  for (const [name, mutate, path] of cases) {
    const sample = fixture(mutate);
    try {
      assert.ok(checkVersionContract(sample).errors.some((error) => error.path === path), name);
    } finally {
      sample.close();
    }
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
      assert.ok(checkVersionContract(sample).errors.some((error) => error.path === path));
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

const lockDriftCases = [
  ["root package name drift", (lock) => { lock.packages[""].name = "wrong-root"; }],
  ["omitted root workspace", (lock) => { lock.packages[""].workspaces.pop(); }],
  ["extra root workspace", (lock) => { lock.packages[""].workspaces.push("packages/unmanaged"); }],
  ["omitted workspace entry", (lock) => { delete lock.packages["packages/licensing-domain"]; }],
  ["workspace name drift", (lock) => { lock.packages["packages/licensing-domain"].name = "@licensecc/repointed"; }],
  ["repointed workspace link", (lock) => { lock.packages["node_modules/@licensecc/licensing-domain"].resolved = "packages/cloudflare-runtime"; }],
];

for (const [name, mutate] of lockDriftCases) {
  test(`rejects ${name} in package-lock`, () => {
    const sample = fixture((files) => {
      const lock = JSON.parse(files["package-lock.json"]);
      mutate(lock);
      files["package-lock.json"] = `${JSON.stringify(lock, null, 2)}\n`;
    });
    try {
      assert.ok(checkVersionContract(sample).errors.some((error) => error.code.startsWith("lockfile_")), JSON.stringify(checkVersionContract(sample).errors));
    } finally {
      sample.close();
    }
  });
}

test("OpenAPI parsing ignores comments and unrelated version properties", () => {
  const sample = fixture((files) => {
    files["services/cloudflare-license-admin/src/worker/openapi/document.ts"] = [
      `// version: "9.9.9"`,
      `const unrelated = { version: "9.9.9" };`,
      `export const openApiDocument: OpenApiDocument = { info: { version: "${platformVersion}" } };`,
      "",
    ].join("\n");
  });
  try {
    assert.deepEqual(checkVersionContract(sample).errors, []);
  } finally {
    sample.close();
  }
});

test("OpenAPI parsing rejects a comment-only or wrong-section version", () => {
  for (const replacement of [
    `// version: "${platformVersion}"\nexport const openApiDocument = { info: { title: "missing" } };\n`,
    `export const openApiDocument = { info: { title: "missing" }, components: { version: "${platformVersion}" } };\n`,
  ]) {
    const sample = fixture((files) => { files["services/cloudflare-license-admin/src/worker/openapi/document.ts"] = replacement; });
    try {
      assert.ok(checkVersionContract(sample).errors.some((error) => error.path === "services/cloudflare-license-admin/src/worker/openapi/document.ts"));
    } finally {
      sample.close();
    }
  }
});

test("OpenAPI parsing rejects duplicate exported document assignments", () => {
  const sample = fixture((files) => {
    files["services/cloudflare-license-admin/src/worker/openapi/document.ts"] = [
      `export const openApiDocument = { info: { version: "${platformVersion}" } };`,
      `export const openApiDocument = { info: { version: "${platformVersion}" } };`,
      "",
    ].join("\n");
  });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.path === "services/cloudflare-license-admin/src/worker/openapi/document.ts"));
  } finally {
    sample.close();
  }
});

test("CMake parsing ignores commented and quoted fake projects", () => {
  const sample = fixture((files) => {
    files["CMakeLists.txt"] = `# project(fake VERSION 9.9.9)\nset(example "project(fake VERSION 9.9.9)")\nproject(licensecc VERSION 2.1.0)\n`;
  });
  try {
    assert.deepEqual(checkVersionContract(sample).errors, []);
  } finally {
    sample.close();
  }
});

test("CMake parsing rejects a comment-only project version", () => {
  const sample = fixture((files) => { files["CMakeLists.txt"] = "# project(licensecc VERSION 2.1.0)\n"; });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.code === "invalid_version_source" && error.path === "CMakeLists.txt"));
  } finally {
    sample.close();
  }
});

test("CMake parsing binds the independent version to project licensecc", () => {
  const sample = fixture((files) => {
    files["CMakeLists.txt"] = "project(decoy VERSION 2.1.0)\nproject(licensecc LANGUAGES CXX)\n";
  });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.code === "invalid_version_source" && error.path === "CMakeLists.txt"));
  } finally {
    sample.close();
  }
});

test("maintained prose requires the version in its release anchor", () => {
  const sample = fixture((files) => {
    files["README.md"] = `An unrelated example mentions ${platformVersion} and C++ 2.1.0.\n`;
    files["CHANGELOG.md"] = `An unrelated example mentions ${platformVersion}, ${pythonVersion}, and C++ 2.1.0.\n`;
    files["sdks/dotnet/README.md"] = `Historical note: ${platformVersion}.\n`;
  });
  try {
    const errors = checkVersionContract(sample).errors;
    assert.ok(errors.some((error) => error.path === "README.md"));
    assert.ok(errors.some((error) => error.path === "CHANGELOG.md"));
    assert.ok(errors.some((error) => error.path === "sdks/dotnet/README.md"));
    assert.ok(errors.some((error) => error.code === "cpp_version_mismatch" && error.path === "README.md"));
    assert.ok(errors.some((error) => error.code === "cpp_version_mismatch" && error.path === "CHANGELOG.md"));
  } finally {
    sample.close();
  }
});

test("maintained docs and registry reject generic platform prerelease projections", () => {
  const sample = fixture((files) => {
    files["doc/other/QA.md"] = "The platform is at **0.1.0 prerelease**.\n";
    const registry = JSON.parse(files["doc/capabilities/registry.json"]);
    registry.capabilities[0].availability.release = "Platform 0.1.0 prerelease";
    files["doc/capabilities/registry.json"] = `${JSON.stringify(registry)}\n`;
  });
  try {
    const errors = checkVersionContract(sample).errors;
    assert.ok(errors.some((error) => error.path === "doc/other/QA.md"));
    assert.ok(errors.some((error) => error.path === "doc/capabilities/registry.json"));
  } finally {
    sample.close();
  }
});

test("every non-planned capability remains bound to the platform release", () => {
  const sample = fixture((files) => {
    const registry = JSON.parse(files["doc/capabilities/registry.json"]);
    registry.capabilities[0].availability.release = "C++ 2.1.0 lineage";
    files["doc/capabilities/registry.json"] = `${JSON.stringify(registry)}\n`;
  });
  try {
    assert.ok(checkVersionContract(sample).errors.some((error) => error.path === "doc/capabilities/registry.json"));
  } finally {
    sample.close();
  }
});

test("maintained prose rejects release anchors hidden in HTML or RST comments", () => {
  const sample = fixture((files) => {
    files["README.md"] = `<!--\n**Versioning:** The C++ library carries version (\`2.1.0\` in CMake); the platform packages are \`${platformVersion}\`.\n-->\n`;
    files["CHANGELOG.md"] = `<!--\n- **C++ library** (\`CMakeLists.txt\`): \`2.1.0\` — lineage.\n- **Platform packages** (release set): \`${platformVersion}\` (Python \`${pythonVersion}\`).\n-->\n`;
    files["doc/capabilities/index.rst"] = `..\n   The platform is at **${platformVersion}** (a prerelease).\n`;
  });
  try {
    const errors = checkVersionContract(sample).errors;
    assert.ok(errors.some((error) => error.path === "README.md"));
    assert.ok(errors.some((error) => error.path === "CHANGELOG.md"));
    assert.ok(errors.some((error) => error.path === "doc/capabilities/index.rst"));
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
