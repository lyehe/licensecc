import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_SERVICE_DEBT_KEYS,
  evaluateArchitecture,
  normalizeRepoPath,
  parseModuleSpecifiers,
} from "./check-architecture.mjs";

function config(overrides = {}) {
  return {
    version: 1,
    assertCurrentServiceDebt: false,
    serviceImportAllowances: [],
    hygieneAllowances: [],
    ...overrides,
  };
}

function serviceManifest(name, dependencies = {}, exports = { ".": "./src/index.ts" }) {
  return { root: `services/${name}`, json: { name: `@fixture/${name}`, dependencies, exports } };
}

function packageManifest(name, dependencies = {}, exports = { ".": "./src/index.ts" }) {
  return { root: `packages/${name}`, json: { name: `@fixture/${name}`, dependencies, exports } };
}

function fixture({ sourceFiles = [], manifests = [], trackedPaths = [], checkerConfig = config() } = {}) {
  const normalizedSourceFiles = sourceFiles.map(([path, source]) => ({ path, source }));
  return evaluateArchitecture({
    sourceFiles: normalizedSourceFiles,
    manifests,
    trackedPaths: [...trackedPaths, ...normalizedSourceFiles.map(({ path }) => path)],
    config: checkerConfig,
    now: new Date("2026-08-08T00:00:00.000Z"),
  });
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

test("tokenizes static, re-export, require, and literal dynamic imports while ignoring comments and strings", () => {
  const source = `
    // import "./comment.js";
    /* export * from "./comment-export.js"; */
    const text = "import('./string.js')";
    import type { Item } from "./types.js";
    import "./side-effect.js";
    export { Item as Reexported } from "./reexport.js";
    const loaded = import("./dynamic.js");
    const required = require("./required.js");
  `;

  assert.deepEqual(parseModuleSpecifiers(source).map(({ specifier }) => specifier), [
    "./types.js",
    "./side-effect.js",
    "./reexport.js",
    "./dynamic.js",
    "./required.js",
  ]);
});

test("normalizes Windows and Ubuntu repository paths identically", () => {
  assert.equal(normalizeRepoPath("services\\alpha\\src\\main.ts"), "services/alpha/src/main.ts");
  assert.equal(normalizeRepoPath("./services/alpha/src/../src/main.ts"), "services/alpha/src/main.ts");

  const result = fixture({
    sourceFiles: [
      ["services\\alpha\\src\\main.ts", 'import "./local.js";'],
      ["services/alpha/src/local.ts", "export const local = true;"],
    ],
    manifests: [serviceManifest("alpha")],
  });
  assert.equal(result.exitCode, 0, result.diagnostics.join("\n"));
});

test("resolves TypeScript .js fallbacks without reading untracked source", () => {
  const result = fixture({
    sourceFiles: [
      ["services/alpha/src/main.ts", 'import "./local.js";'],
      ["services/alpha/src/local.ts", "export const local = true;"],
    ],
    manifests: [serviceManifest("alpha")],
  });
  assert.equal(result.exitCode, 0, result.diagnostics.join("\n"));
});

test("rejects unresolved relative imports", () => {
  const result = fixture({
    sourceFiles: [["services/alpha/src/main.ts", 'import "./missing.js";']],
    manifests: [serviceManifest("alpha")],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_UNRESOLVED_RELATIVE"]);
});

test("rejects a package importing a deployable service", () => {
  const result = fixture({
    sourceFiles: [["packages/domain/src/main.ts", 'import "@fixture/backend/api";']],
    manifests: [
      packageManifest("domain", { "@fixture/backend": "workspace:*" }),
      serviceManifest("backend", {}, { "./api": "./src/api.ts" }),
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_PACKAGE_TO_SERVICE"]);
});

test("rejects service-to-service imports without an exact debt allowance", () => {
  const result = fixture({
    sourceFiles: [["services/admin/src/main.ts", 'import "@fixture/backend/api";']],
    manifests: [
      serviceManifest("admin", { "@fixture/backend": "workspace:*" }),
      serviceManifest("backend", {}, { "./api": "./src/api.ts" }),
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_SERVICE_TO_SERVICE"]);
  assert.equal(result.errors[0].line, 1);
  assert.equal(result.errors[0].specifier, "@fixture/backend/api");
  assert.match(result.diagnostics[0], /services\/admin\/src\/main\.ts:1 -> @fixture\/backend\/api/);
});

test("allows only a documented exact service debt edge", () => {
  const result = fixture({
    sourceFiles: [["services/admin/src/main.ts", 'import "@fixture/backend/api";']],
    manifests: [
      serviceManifest("admin", { "@fixture/backend": "workspace:*" }),
      serviceManifest("backend", {}, { "./api": "./src/api.ts" }),
    ],
    checkerConfig: config({
      serviceImportAllowances: [{
        from: "services/admin/src/main.ts",
        specifier: "@fixture/backend/api",
        reason: "Temporary shared backend implementation.",
        removeBy: "org/04-shared-packages",
      }],
    }),
  });
  assert.equal(result.exitCode, 0, result.diagnostics.join("\n"));
});

test("rejects undeclared workspace dependencies", () => {
  const result = fixture({
    sourceFiles: [["packages/consumer/src/main.ts", 'import "@fixture/provider/api";']],
    manifests: [
      packageManifest("consumer"),
      packageManifest("provider", {}, { "./api": "./src/api.ts" }),
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_UNDECLARED_WORKSPACE_DEPENDENCY"]);
});

test("rejects unresolved workspace package subpaths", () => {
  const result = fixture({
    sourceFiles: [["packages/consumer/src/main.ts", 'import "@fixture/provider/not-exported";']],
    manifests: [
      packageManifest("consumer", { "@fixture/provider": "workspace:*" }),
      packageManifest("provider", {}, { "./api": "./src/api.ts" }),
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_UNRESOLVED_WORKSPACE_SUBPATH"]);
});

test("rejects UI-to-worker relative imports", () => {
  const result = fixture({
    sourceFiles: [
      ["services/admin/src/ui/main.ts", 'import "../worker/handler.js";'],
      ["services/admin/src/worker/handler.ts", "export const handler = true;"],
    ],
    manifests: [serviceManifest("admin")],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_UI_TO_WORKER"]);
});

test("rejects UI imports of a workspace export implemented by Worker source", () => {
  const result = fixture({
    sourceFiles: [["services/admin/src/ui/main.ts", 'import "@fixture/admin/worker";']],
    manifests: [serviceManifest("admin", { "@fixture/admin": "workspace:*" }, { "./worker": "./src/worker/handler.ts" })],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_UI_TO_WORKER"]);
});

test("rejects a relative import that crosses workspace roots", () => {
  const result = fixture({
    sourceFiles: [
      ["packages/consumer/src/main.ts", 'import "../../provider/src/api.js";'],
      ["packages/provider/src/api.ts", "export const api = true;"],
    ],
    manifests: [packageManifest("consumer"), packageManifest("provider")],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_CROSS_WORKSPACE_RELATIVE"]);
});

test("rejects static literal dynamic imports across services", () => {
  const result = fixture({
    sourceFiles: [["services/admin/src/main.ts", 'await import("@fixture/backend/api");']],
    manifests: [
      serviceManifest("admin", { "@fixture/backend": "workspace:*" }),
      serviceManifest("backend", {}, { "./api": "./src/api.ts" }),
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_SERVICE_TO_SERVICE"]);
});

test("fails closed for expired and unused allowances", () => {
  const expired = fixture({
    sourceFiles: [["services/admin/src/main.ts", 'import "@fixture/backend/api";']],
    manifests: [
      serviceManifest("admin", { "@fixture/backend": "workspace:*" }),
      serviceManifest("backend", {}, { "./api": "./src/api.ts" }),
    ],
    checkerConfig: config({
      serviceImportAllowances: [{
        from: "services/admin/src/main.ts",
        specifier: "@fixture/backend/api",
        reason: "Temporary shared backend implementation.",
        removeBy: "org/04-shared-packages",
        expiresOn: "2000-01-01",
      }],
    }),
  });
  assert.equal(expired.exitCode, 1);
  assert.deepEqual(errorCodes(expired), ["ARCH_EXPIRED_ALLOWANCE"]);

  const unused = fixture({
    sourceFiles: [["services/admin/src/main.ts", "export const local = true;"]],
    manifests: [serviceManifest("admin")],
    checkerConfig: config({
      serviceImportAllowances: [{
        from: "services/admin/src/main.ts",
        specifier: "@fixture/backend/api",
        reason: "Temporary shared backend implementation.",
        removeBy: "org/04-shared-packages",
      }],
    }),
  });
  assert.equal(unused.exitCode, 1);
  assert.deepEqual(errorCodes(unused), ["ARCH_UNUSED_ALLOWANCE"]);
});

test("rejects wildcard and malformed temporary debt configuration as setup errors", () => {
  const result = fixture({
    checkerConfig: config({
      serviceImportAllowances: [{
        from: "services/*/src/main.ts",
        specifier: "@fixture/backend/api",
        reason: "Wildcard debt is not reviewable.",
        removeBy: "org/04-shared-packages",
      }],
    }),
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(errorCodes(result), ["ARCH_MALFORMED_ALLOWANCE"]);
});

test("hygiene reads the tracked list and permits only documented deterministic exceptions", () => {
  const result = fixture({
    trackedPaths: [
      "build/.gitkeep",
      "pyvenv.cfg",
      "services/admin/wrangler.example.jsonc",
      "test/vectors/deterministic.lic",
      "test/vectors/public_key.pkcs1.der.hex",
    ],
    checkerConfig: config({
      hygieneAllowances: [{
        path: "pyvenv.cfg",
        reason: "Temporary root Python environment marker pending source-tree-purity work.",
        owner: "org/02-build-purity",
        removeBy: "org/02-build-purity",
      }],
    }),
  });
  assert.equal(result.exitCode, 0, result.diagnostics.join("\n"));
});

test("hygiene rejects generated tracked paths, local Wrangler configuration, and generated credentials", () => {
  const result = fixture({
    trackedPaths: [
      "build/output.bin",
      "services/admin/dist/app.js",
      "services/admin/.wrangler/state.json",
      "services/admin/node_modules/pkg/index.js",
      "services/admin/.env.local",
      "services/admin/wrangler.toml",
      "services/admin/wrangler.local.toml",
      "wrangler.toml",
      "private_key.pem",
      "license.lic",
      "pyvenv.cfg",
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), [
    "ARCH_GENERATED_LICENSE",
    "ARCH_GENERATED_PRIVATE_KEY",
    "ARCH_LOCAL_ENVIRONMENT_SECRET",
    "ARCH_LOCAL_WRANGLER_CONFIG",
    "ARCH_LOCAL_WRANGLER_CONFIG",
    "ARCH_LOCAL_WRANGLER_CONFIG",
    "ARCH_ROOT_PYVENV",
    "ARCH_TRACKED_BUILD_ARTIFACT",
    "ARCH_TRACKED_DIST_ARTIFACT",
    "ARCH_TRACKED_NODE_MODULES",
    "ARCH_TRACKED_WRANGLER_STATE",
  ]);
});

test("hygiene rejects private keys even when a path is under test/vectors", () => {
  const result = fixture({ trackedPaths: ["test/vectors/private_key.pem"] });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), ["ARCH_GENERATED_PRIVATE_KEY"]);
});

test("hygiene debt also fails when it is expired or unused", () => {
  const expired = fixture({
    trackedPaths: ["pyvenv.cfg"],
    checkerConfig: config({
      hygieneAllowances: [{
        path: "pyvenv.cfg",
        reason: "Temporary root marker.",
        owner: "org/02-build-purity",
        removeBy: "org/02-build-purity",
        expiresOn: "2000-01-01",
      }],
    }),
  });
  assert.equal(expired.exitCode, 1);
  assert.deepEqual(errorCodes(expired), ["ARCH_EXPIRED_HYGIENE_ALLOWANCE"]);

  const unused = fixture({
    checkerConfig: config({
      hygieneAllowances: [{
        path: "pyvenv.cfg",
        reason: "Temporary root marker.",
        owner: "org/02-build-purity",
        removeBy: "org/02-build-purity",
      }],
    }),
  });
  assert.equal(unused.exitCode, 1);
  assert.deepEqual(errorCodes(unused), ["ARCH_UNUSED_HYGIENE_ALLOWANCE"]);
});

test("documents no service-to-service debt after shared-package extraction", () => {
  assert.equal(CURRENT_SERVICE_DEBT_KEYS.length, 0);
});

test("the completed inventory rejects a newly added service allowance", () => {
  const result = fixture({
    sourceFiles: [["services/admin/src/main.ts", 'import "@fixture/backend/api";']],
    manifests: [
      serviceManifest("admin", { "@fixture/backend": "file:../backend" }),
      serviceManifest("backend", {}, { "./api": "./src/api.ts" }),
    ],
    checkerConfig: config({
      assertCurrentServiceDebt: true,
      serviceImportAllowances: [{
        from: "services/admin/src/main.ts",
        specifier: "@fixture/backend/api",
        reason: "A deliberately unreviewed fixture edge.",
        removeBy: "org/04-shared-packages",
      }],
    }),
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(errorCodes(result), ["ARCH_DEBT_INVENTORY_DRIFT"]);
});
