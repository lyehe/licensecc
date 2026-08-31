import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertNoDuplicateEntries,
  assertNoDuplicateOpenApiObjectKeys,
  canonicalize,
  findDuplicateOpenApiObjectKeys,
  loadTypeScript,
  resolveTypeScriptCompilerPath,
  validateOpenApiDocument,
  validateRouteInventory,
} from "../../scripts/canonical-contracts.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("canonicalization recursively sorts objects and preserves reviewed array order", () => {
  const input = {
    z: { beta: 2, alpha: 1 },
    array: [{ z: true, a: false }, "second", "first"],
    a: "first",
  };
  assert.deepEqual(canonicalize(input), {
    a: "first",
    array: [{ a: false, z: true }, "second", "first"],
    z: { alpha: 1, beta: 2 },
  });
});

test("route inventories fail closed for duplicate route keys", () => {
  assert.throws(
    () => validateRouteInventory([{ method: "GET", path: "/v1/licenses" }, { method: "GET", path: "/v1/licenses" }], ["GET /v1/licenses"], "fixture"),
    /duplicate route key/i,
  );
});

test("OpenAPI validation rejects duplicate operation identifiers", () => {
  assert.throws(
    () => validateOpenApiDocument({
      paths: {
        "/one": { get: { operationId: "same" } },
        "/two": { post: { operationId: "same" } },
      },
      components: {},
    }, "fixture"),
    /duplicate OpenAPI operation/i,
  );
});

test("component-entry validation rejects duplicate keys before assembly", () => {
  assert.throws(
    () => assertNoDuplicateEntries([["Policy", {}], ["Policy", {}]], "fixture components.schemas"),
    /duplicate component key/i,
  );
});

test("compiled OpenAPI checks resolve TypeScript from the authoritative root workspace install", () => {
  const rootCompilerPath = path.join(REPOSITORY_ROOT, "node_modules", "typescript", "lib", "typescript.js");
  assert.ok(existsSync(rootCompilerPath), "root workspace TypeScript must be installed before contract checks");
  assert.equal(resolveTypeScriptCompilerPath(REPOSITORY_ROOT), rootCompilerPath);
});

test("compiled OpenAPI source detects duplicate component and path-method literals before JavaScript overwrites them", async () => {
  const compiler = await loadTypeScript(REPOSITORY_ROOT);
  const fixturePath = path.join(REPOSITORY_ROOT, "test", "contracts", "fixtures", "duplicate-openapi.mjs");
  const source = await readFile(fixturePath, "utf8");
  const duplicates = findDuplicateOpenApiObjectKeys(source, fixturePath, compiler);
  assert.deepEqual(duplicates.map(({ kind, key }) => ({ kind, key })), [
    { kind: "component key", key: "Policy" },
    { kind: "OpenAPI operation key", key: "get" },
  ]);
  assert.throws(
    () => assertNoDuplicateOpenApiObjectKeys(source, fixturePath, compiler),
    /Duplicate component key "Policy"/,
  );
});

test("backup VM capture links a shared dependency graph and the exact node:crypto shim", () => {
  const root = mkdtempSync(path.join(tmpdir(), "licensecc-contract-vm-"));
  const dist = path.join(root, "services", "cloudflare-d1-backup", "dist");
  try {
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, "shared.js"), `
      import { createHash } from "node:crypto";
      export const digest = createHash("sha256").update("fixture").digest("hex");
    `, "utf8");
    writeFileSync(path.join(dist, "left.js"), `
      import { digest } from "./shared.js";
      export const left = digest.length;
    `, "utf8");
    writeFileSync(path.join(dist, "right.js"), `
      import { digest } from "./shared.js";
      export const right = digest.slice(0, 1);
    `, "utf8");
    writeFileSync(path.join(dist, "index.js"), `
      import { left } from "./left.js";
      import { right } from "./right.js";
      export class D1BackupWorkflow { run() { return left + right.length; } }
      export default { async fetch() {}, async scheduled() {} };
    `, "utf8");

    const capture = spawnSync(process.execPath, [
      "--experimental-vm-modules",
      path.join(REPOSITORY_ROOT, "scripts", "canonical-contracts.mjs"),
      "--capture-backup",
      root,
    ], { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false, windowsHide: true });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    assert.deepEqual(JSON.parse(capture.stdout), {
      compiledEntry: "services/cloudflare-d1-backup/dist/index.js",
      defaultHandlerMethods: ["fetch", "scheduled"],
      namedExports: ["D1BackupWorkflow", "default"],
      service: "cloudflare-d1-backup",
      workflow: {
        export: "D1BackupWorkflow",
        prototypeMethods: ["run"],
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
