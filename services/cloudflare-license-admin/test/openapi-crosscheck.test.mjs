// Build-time cross-check that PINS three representations of the admin route surface together
// so they cannot silently drift. Zero-dep (node:test only) and — crucially — it compares
// COMPILED ARTIFACTS, not the source text of index.ts. That is what unfreezes extraction from
// the god file: the spec, the canonical inventory, and the live dispatch table must agree, but
// HOW index.ts is organized internally is no longer pinned by a regex-anchor grep.
//
// Three-way equality asserted below:
//   openApiDocument.paths (method+path)  ===  ALL_ROUTES (the canonical inventory)
//   API_ROUTES                           ===  API_BINDING_KEYS (index.ts's live dispatch table)
// The two META_ROUTES (/openapi.json, /docs) live in the spec + inventory but not in the
// binding table: they are served straight from fetch() (before auth), not via handleApi.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "../dist-worker/worker/openapi/assemble.js";
import { openApiDocument } from "../dist-worker/worker/openapi/document.js";
import { API_ROUTES, ALL_ROUTES, META_ROUTES } from "../dist-worker/worker/routes.js";
import { API_BINDING_KEYS } from "../dist-worker/worker/index.js";
import { POLICY_TYPES } from "@licensecc/licensing-domain/entitlements/policy";

// Collect every `enum` array in the spec that describes the policy `type` field. The policy-type
// enum is the only one carrying BOTH "node_locked" and "subscription" (the 3-value license-mode
// enum trial/floating/node_locked is a distinct concept and deliberately excluded). These
// hand-written literals must stay deep-equal to the ONE runtime source, POLICY_TYPES, so the spec
// cannot silently drift from the validators.
function policyTypeEnums(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) policyTypeEnums(item, out);
  } else if (node && typeof node === "object") {
    if (Array.isArray(node.enum) && node.enum.includes("node_locked") && node.enum.includes("subscription")) {
      out.push(node.enum);
    }
    for (const value of Object.values(node)) policyTypeEnums(value, out);
  }
  return out;
}

const SPEC_METHODS = ["get", "post", "patch", "put", "delete"];

test("OpenAPI assembly rejects collisions while allowing legitimate multi-method paths", () => {
  const getFragment = { label: "get", entries: [["/shared", { get: { operationId: "getShared" } }]] };
  const postFragment = { label: "post", entries: [["/shared", { post: { operationId: "postShared" } }]] };
  const before = structuredClone(getFragment);
  const paths = assemblePaths(getFragment, postFragment);
  assert.deepEqual(Object.keys(paths["/shared"]), ["get", "post"]);
  assert.deepEqual(getFragment, before, "assembly must not mutate input fragments");
  assert.throws(
    () => assemblePaths(getFragment, { label: "duplicate", entries: [["/shared", { get: {} }]] }),
    /Duplicate OpenAPI path item field "get"/,
  );
  assert.throws(
    () => assemblePaths({ label: "parameters-1", entries: [["/shared", { parameters: [] }]] }, { label: "parameters-2", entries: [["/shared", { parameters: [] }]] }),
    /Duplicate OpenAPI path item field "parameters"/,
  );
  assert.throws(
    () => assertUniqueOperationIds(assemblePaths(getFragment, { label: "duplicate-operation", entries: [["/other", { post: { operationId: "getShared" } }]] })),
    /Duplicate OpenAPI operationId "getShared"/,
  );
  const schemaComponents = { label: "schemas", namespaces: [["schemas", [["Shared", { type: "object" }]]]] };
  const schemaComponentsBefore = structuredClone(schemaComponents);
  const components = assembleComponents(
    schemaComponents,
    { label: "security", namespaces: [["securitySchemes", [["Shared", { type: "http" }]]]] },
  );
  assert.ok(components.schemas.Shared);
  assert.ok(components.securitySchemes.Shared);
  assert.deepEqual(schemaComponents, schemaComponentsBefore, "component assembly must not mutate input fragments");
  assert.throws(
    () => assembleComponents({ label: "schemas-a", namespaces: [["schemas", [["Shared", {}]]]] }, { label: "schemas-b", namespaces: [["schemas", [["Shared", {}]]]] }),
    /Duplicate OpenAPI component key "Shared" in schemas/,
  );
});

function specOperationKeys() {
  const keys = new Set();
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of SPEC_METHODS) {
      if (item[method]) {
        keys.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return keys;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("spec is OpenAPI 3.1 with the expected envelope schemas", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.deepEqual(openApiDocument.servers, [{ url: "/" }]);
  assert.ok(openApiDocument.components.schemas.SuccessEnvelope, "SuccessEnvelope schema present");
  assert.ok(openApiDocument.components.schemas.ErrorEnvelope, "ErrorEnvelope schema present");
  for (const scheme of ["cloudflareAccess", "devBearer", "syncBearer"]) {
    assert.ok(openApiDocument.components.securitySchemes[scheme], `securityScheme ${scheme} present`);
  }
});

test("spec operations equal the canonical route inventory exactly (no drift either way)", () => {
  const spec = specOperationKeys();
  const inventory = new Set(ALL_ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const key of inventory) {
    assert.ok(spec.has(key), `canonical route ${key} is missing from the spec`);
  }
  for (const key of spec) {
    assert.ok(inventory.has(key), `spec has un-inventoried operation ${key}`);
  }
});

test("the live binding table equals the API route inventory (dispatcher is the inventory)", () => {
  const bindings = new Set(API_BINDING_KEYS);
  const apiInventory = new Set(API_ROUTES.map((r) => `${r.method} ${r.path}`));
  assert.equal(bindings.size, API_BINDING_KEYS.length, "binding keys must be unique");
  for (const key of apiInventory) {
    assert.ok(bindings.has(key), `API route ${key} has no binding in index.ts — dispatcher drifted from the inventory`);
  }
  for (const key of bindings) {
    assert.ok(apiInventory.has(key), `index.ts binds ${key} which is not in API_ROUTES`);
  }
});

test("meta routes are inventoried and specced but served outside the API binding table", () => {
  const bindings = new Set(API_BINDING_KEYS);
  const spec = specOperationKeys();
  for (const r of META_ROUTES) {
    const key = `${r.method} ${r.path}`;
    assert.ok(spec.has(key), `meta route ${key} missing from the spec`);
    assert.ok(!bindings.has(key), `meta route ${key} must NOT be in the API binding table (served from fetch())`);
  }
});

test("every policy-type enum in the spec matches the single-sourced POLICY_TYPES", () => {
  const enums = policyTypeEnums(openApiDocument);
  assert.ok(enums.length >= 3, `expected the policy type enum in at least 3 spec spots, found ${enums.length}`);
  for (const e of enums) {
    assert.deepEqual([...e], [...POLICY_TYPES]);
  }
});

test("each operation documents 200 plus the auth/error statuses the handler returns", () => {
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of ["get", "post", "patch"]) {
      const op = item[method];
      if (!op) continue;
      const responses = op.responses ?? {};
      assert.ok(responses["200"], `${method.toUpperCase()} ${path} missing 200 response`);
      // Authenticated routes (everything except the meta routes) must document 401 + 403.
      if (path !== "/openapi.json" && path !== "/docs") {
        assert.ok(responses["401"], `${method.toUpperCase()} ${path} missing 401 response`);
        assert.ok(responses["403"], `${method.toUpperCase()} ${path} missing 403 response`);
      }
    }
  }
});

test("operation identifiers and auth declarations are unique and match route ownership", () => {
  assertUniqueOperationIds(openApiDocument.paths);
  assert.deepEqual(openApiDocument.security, [{ cloudflareAccess: [] }, { devBearer: [] }]);
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of SPEC_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      assert.equal(typeof operation.operationId, "string", `${method.toUpperCase()} ${path} is missing operationId`);
    }
  }
  for (const route of META_ROUTES) {
    const operation = openApiDocument.paths[route.path][route.method.toLowerCase()];
    assert.deepEqual(operation.security, [], `${route.path} must remain public`);
  }
  const sync = openApiDocument.paths["/api/sync/entitlements"].post;
  assert.deepEqual(sync.security, [{ syncBearer: [] }]);
});
