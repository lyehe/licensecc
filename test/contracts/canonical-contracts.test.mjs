import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
