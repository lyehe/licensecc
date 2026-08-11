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
    version: 2,
    assertCurrentServiceDebt: false,
    serviceImportAllowances: [],
    hygieneAllowances: [],
    compositionRoots: COMPOSITION_ROOTS,
    ...overrides,
  };
}

const COMPOSITION_ROOTS = {
  backend: {
    entry: "services/cloudflare-licensing-backend/src/index.ts",
    entryImports: ["./app.js"],
    app: "services/cloudflare-licensing-backend/src/app.ts",
    appImports: ["./env.js", "./maintenance/**", "./observability/**", "./routes.js", "./routes/**"],
  },
  admin: {
    entry: "services/cloudflare-license-admin/src/worker/index.ts",
    entryImports: ["./module-worker.js"],
    adapter: "services/cloudflare-license-admin/src/worker/module-worker.ts",
    adapterImports: ["./app.js", "./operations.js", "./env.js"],
    app: "services/cloudflare-license-admin/src/worker/app.ts",
    appImports: ["./auth.js", "./context.js", "./dispatch.js", "./env.js", "./response.js"],
  },
  portal: {
    entry: "services/cloudflare-customer-portal/src/worker/index.ts",
    entryImports: ["./app.js"],
    app: "services/cloudflare-customer-portal/src/worker/app.ts",
    appImports: ["./env.js", "./support.js", "./routes.js", "./routes/**"],
  },
  adminUi: {
    mount: "services/cloudflare-license-admin/src/ui/main.tsx",
    mountImports: ["./app/App"],
    app: "services/cloudflare-license-admin/src/ui/app/App.tsx",
    appImports: ["./types", "../features/**", "../shared/**", "../styles.css"],
    appForbiddenTargets: ["services/cloudflare-license-admin/src/ui/shared/api.ts"],
    appForbiddenSuffixes: ["/workflow.ts"],
  },
};

function compositionConfig(overrides = {}) {
  return {
    version: 2,
    assertCurrentServiceDebt: false,
    serviceImportAllowances: [],
    hygieneAllowances: [],
    compositionRoots: COMPOSITION_ROOTS,
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
      "test/vectors/device_identity/namespace_v1.json",
      "test/vectors/device_proof/v1/manifest.json",
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

test("hygiene permits only the exact reviewed JSON vector fixtures", () => {
  const result = fixture({
    trackedPaths: [
      "test/vectors/device_identity/namespace_v1.json",
      "test/vectors/device_identity/unreviewed.json",
      "test/vectors/device_proof/v1/manifest.json",
      "test/vectors/device_proof/v1/unreviewed.json",
      "test/vectors/other/manifest.json",
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(errorCodes(result), [
    "ARCH_UNAPPROVED_VECTOR_FIXTURE",
    "ARCH_UNAPPROVED_VECTOR_FIXTURE",
    "ARCH_UNAPPROVED_VECTOR_FIXTURE",
  ]);
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

test("hygiene permits only the reviewed vendored generator fixture paths", () => {
  const allowed = fixture({
    trackedPaths: [
      "extern/license-generator/build/.gitkeep",
      "extern/license-generator/test/data/private_key.rsa",
      "extern/license-generator/test/data/v200/legacy_append_noncanonical.lic",
      "extern/license-generator/test/data/v200/legacy_fixed_key.lic",
    ],
  });
  assert.equal(allowed.exitCode, 0, allowed.diagnostics.join("\n"));

  const rejected = fixture({
    trackedPaths: ["extern/license-generator/test/data/v200/unreviewed.lic"],
  });
  assert.equal(rejected.exitCode, 1);
  assert.deepEqual(errorCodes(rejected), ["ARCH_GENERATED_LICENSE"]);
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

test("composition roots reject extra entry and direct implementation edges", () => {
  const valid = fixture({
    sourceFiles: [
      ["services/cloudflare-licensing-backend/src/index.ts", 'export { default } from "./app.js";'],
      ["services/cloudflare-licensing-backend/src/app.ts", 'import "./env.js"; import "./routes/meta.js";'],
      ["services/cloudflare-licensing-backend/src/env.ts", "export const env = true;"],
      ["services/cloudflare-licensing-backend/src/routes/meta.ts", "export const meta = true;"],
    ],
    manifests: [serviceManifest("cloudflare-licensing-backend")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(valid.exitCode, 0, valid.diagnostics.join("\n"));

  const extraEntry = fixture({
    sourceFiles: [
      ["services/cloudflare-licensing-backend/src/index.ts", 'export { default } from "./app.js"; export { operation } from "./operations.js";'],
      ["services/cloudflare-licensing-backend/src/app.ts", "export default {};"],
      ["services/cloudflare-licensing-backend/src/operations.ts", "export const operation = true;"],
    ],
    manifests: [serviceManifest("cloudflare-licensing-backend")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(extraEntry.exitCode, 1);
  assert.deepEqual(errorCodes(extraEntry), ["ARCH_COMPOSITION_ENTRY_IMPORT"]);

  const directDb = fixture({
    sourceFiles: [
      ["services/cloudflare-licensing-backend/src/index.ts", 'export { default } from "./app.js";'],
      ["services/cloudflare-licensing-backend/src/app.ts", 'import "./db/client.js";'],
      ["services/cloudflare-licensing-backend/src/db/client.ts", "export const db = true;"],
    ],
    manifests: [serviceManifest("cloudflare-licensing-backend")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(directDb.exitCode, 1);
  assert.deepEqual(errorCodes(directDb), ["ARCH_COMPOSITION_APP_IMPORT"]);
});

test("composition roots resolve Windows .js-to-TypeScript edges and protect Worker/UI seams", () => {
  const windowsPositive = fixture({
    sourceFiles: [
      ["services\\cloudflare-licensing-backend\\src\\index.ts", 'export { default } from ".\\\\app.js";'],
      ["services/cloudflare-licensing-backend/src/app.ts", 'import ".\\\\env.js"; import ".\\\\routes\\\\meta.js";'],
      ["services/cloudflare-licensing-backend/src/env.ts", "export const env = true;"],
      ["services/cloudflare-licensing-backend/src/routes/meta.ts", "export const meta = true;"],
    ],
    manifests: [serviceManifest("cloudflare-licensing-backend")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(windowsPositive.exitCode, 0, windowsPositive.diagnostics.join("\n"));

  const adminEntry = fixture({
    sourceFiles: [
      ["services/cloudflare-license-admin/src/worker/index.ts", 'export { default } from "./module-worker.js"; export type { Env } from "./env.js";'],
      ["services/cloudflare-license-admin/src/worker/module-worker.ts", "export default {};"],
      ["services/cloudflare-license-admin/src/worker/env.ts", "export type Env = {};"],
    ],
    manifests: [serviceManifest("cloudflare-license-admin")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(adminEntry.exitCode, 1);
  assert.deepEqual(errorCodes(adminEntry), ["ARCH_COMPOSITION_ENTRY_IMPORT"]);

  const adminApp = fixture({
    sourceFiles: [
      ["services/cloudflare-license-admin/src/worker/app.ts", 'import "./operations.js";'],
      ["services/cloudflare-license-admin/src/worker/operations.ts", "export const operation = true;"],
    ],
    manifests: [serviceManifest("cloudflare-license-admin")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(adminApp.exitCode, 1);
  assert.deepEqual(errorCodes(adminApp), ["ARCH_COMPOSITION_APP_IMPORT"]);

  const portalApp = fixture({
    sourceFiles: [
      ["services/cloudflare-customer-portal/src/worker/app.ts", 'import "./auth/session.js";'],
      ["services/cloudflare-customer-portal/src/worker/auth/session.ts", "export const session = true;"],
    ],
    manifests: [serviceManifest("cloudflare-customer-portal")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(portalApp.exitCode, 1);
  assert.deepEqual(errorCodes(portalApp), ["ARCH_COMPOSITION_APP_IMPORT"]);

  const uiMount = fixture({
    sourceFiles: [
      ["services/cloudflare-license-admin/src/ui/main.tsx", 'import "./features/catalog/Catalog";'],
      ["services/cloudflare-license-admin/src/ui/features/catalog/Catalog.tsx", "export const Catalog = true;"],
    ],
    manifests: [serviceManifest("cloudflare-license-admin")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(uiMount.exitCode, 1);
  assert.deepEqual(errorCodes(uiMount), ["ARCH_UI_MOUNT_IMPORT"]);

  const uiApp = fixture({
    sourceFiles: [
      ["services/cloudflare-license-admin/src/ui/app/App.tsx", 'import "../shared/api.js"; fetch("/api/admin/summary");'],
      ["services/cloudflare-license-admin/src/ui/shared/api.ts", "export const api = true;"],
    ],
    manifests: [serviceManifest("cloudflare-license-admin")],
    checkerConfig: compositionConfig(),
  });
  assert.equal(uiApp.exitCode, 1);
  assert.deepEqual(errorCodes(uiApp), ["ARCH_UI_APP_API_IMPORT", "ARCH_UI_APP_DIRECT_FETCH"]);
});
