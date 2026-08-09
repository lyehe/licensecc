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
import "./worker/transition-contracts.test.mjs";
import { PAGINATION_ROUTE_OPTIONS } from "../dist-worker/worker/query.js";
import { API_ROUTES, ALL_ROUTES, META_ROUTES } from "../dist-worker/worker/routes.js";
import { API_BINDING_KEYS } from "../dist-worker/worker/index.js";
import { POLICY_TYPES } from "@licensecc/licensing-domain/entitlements/policy";
import { MAX_SUPPORT_UNTIL_EPOCH_SECONDS } from "@licensecc/licensing-domain/catalog/plan_projection";

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

test("plan projection Apply documents the canonical opaque preview-id grammar and conflict responses", () => {
  const input = openApiDocument.components.schemas.PlanProjectionApplyInput;
  assert.equal(input.properties.preview_id.pattern, "^ppv_[A-Za-z0-9_-]{1,124}$");
  const apply = openApiDocument.paths["/api/admin/license-plans/apply"].post;
  const projectionErrors = JSON.stringify(apply.responses["409"]);
  assert.match(projectionErrors, /license_fingerprint_conflict/);
  assert.match(projectionErrors, /projection_preview_grant_expired/);
  assert.match(projectionErrors, /assignment-or-entitlement identity/i);
});

test("plan projection documents the bounded epoch contract without exposing private cache policy", () => {
  const input = openApiDocument.components.schemas.PlanProjectionInput;
  assert.equal(input.properties.support_until.minimum, 0);
  assert.equal(input.properties.support_until.maximum, MAX_SUPPORT_UNTIL_EPOCH_SECONDS);
  assert.match(input.properties.support_until.description, /9999-12-31T23:59:59Z/);
  assert.equal(Object.hasOwn(openApiDocument.components.schemas.PlanProjectionItem.properties, "cache_ttl_seconds"), false);
});

test("catalog import documents its server-bound Preview/Apply protocol", () => {
  const input = openApiDocument.components.schemas.CatalogImportApplyInput;
  assert.equal(input.properties.preview_id.pattern, "^civ_[A-Za-z0-9_-]{1,124}$");
  const preview = openApiDocument.components.schemas.CatalogImportPreviewResponse;
  assert.deepEqual(preview.required, ["preview_id", "manifest_digest", "manifest", "effects", "effective_at", "expires_at", "source_generation"]);
  const operation = openApiDocument.paths["/api/admin/catalog/import"].post;
  assert.deepEqual(
    operation.requestBody.content["application/json"].schema.oneOf,
    [
      { $ref: "#/components/schemas/CatalogImportManifest" },
      { $ref: "#/components/schemas/CatalogImportApplyInput" },
    ],
  );
  const conflictSchema = operation.responses["409"].content["application/json"].schema;
  assert.equal(conflictSchema.oneOf.length, 3);
  assert.deepEqual(conflictSchema.oneOf[0], {
    allOf: [
      { $ref: "#/components/schemas/ErrorEnvelope" },
      {
        type: "object",
        required: ["code"],
        properties: {
          code: {
            enum: [
              "preview_required",
              "policy_disabled",
              "catalog_import_snapshot_stale",
              "stale_catalog_import_preview",
              "expired_catalog_import_preview",
              "claimed_catalog_import_preview",
            ],
          },
        },
      },
    ],
  });
  assert.deepEqual(conflictSchema.oneOf[1], { $ref: "#/components/schemas/CatalogImportInvalidPlanConfigError" });
  assert.deepEqual(conflictSchema.oneOf[2], { $ref: "#/components/schemas/CatalogImportTooLargeError" });
  assert.deepEqual(openApiDocument.components.schemas.CatalogImportInvalidPlanConfigData, {
    type: "object",
    additionalProperties: false,
    required: ["policy_id"],
    properties: { policy_id: { type: "string" } },
  });
  assert.deepEqual(openApiDocument.components.schemas.CatalogImportInvalidPlanConfigError, {
    allOf: [
      { $ref: "#/components/schemas/ErrorEnvelope" },
      {
        type: "object",
        required: ["code", "data"],
        properties: {
          code: { const: "invalid_plan_config" },
          data: { $ref: "#/components/schemas/CatalogImportInvalidPlanConfigData" },
        },
      },
    ],
  });
  assert.deepEqual(
    operation.responses["409"].content["application/json"].examples.invalid_plan_config.value,
    { ok: false, code: "invalid_plan_config", request_id: "1a2b3c-1", data: { policy_id: "policy_example" } },
  );
  assert.deepEqual(openApiDocument.components.schemas.CatalogImportTooLargeData, {
    type: "object",
    additionalProperties: false,
    required: ["max_mutable_actions", "guidance"],
    properties: {
      max_mutable_actions: { const: 13 },
      guidance: { const: "narrow the manifest and preview again" },
    },
  });
  assert.deepEqual(openApiDocument.components.schemas.CatalogImportTooLargeError, {
    allOf: [
      { $ref: "#/components/schemas/ErrorEnvelope" },
      {
        type: "object",
        required: ["code", "data"],
        properties: {
          code: { const: "catalog_import_too_large" },
          data: { $ref: "#/components/schemas/CatalogImportTooLargeData" },
        },
      },
    ],
  });
  const idempotency = operation.parameters.find((parameter) => parameter.name === "idempotency-key");
  assert.equal(idempotency.description, "Required when applying a preview. For dry_run Preview, a valid header is ignored, but a present empty or over-long header returns 400 invalid_idempotency_key. The same actor/key replay returns the committed Apply response.");
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

test("pagination option matrix matches the route inventory and OpenAPI parameter support", () => {
  const expected = new Set(Object.keys(PAGINATION_ROUTE_OPTIONS));
  const inventory = new Set(API_ROUTES.map((route) => `${route.method} ${route.path}`));
  for (const key of expected) {
    assert.ok(inventory.has(key), `${key} pagination option is not in the canonical route inventory`);
  }
  const documented = new Set();
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of ["get", "post", "patch"]) {
      const operation = item[method];
      if (!operation) continue;
      const parameterNames = (operation.parameters ?? []).filter((parameter) => parameter.in === "query").map((parameter) => parameter.name);
      if (!parameterNames.includes("limit")) continue;
      const key = `${method.toUpperCase()} ${path}`;
      documented.add(key);
      const options = PAGINATION_ROUTE_OPTIONS[key];
      assert.ok(options, `${key} has documented pagination but no runtime pagination options`);
      assert.ok(operation.responses?.["400"], `${key} must document HTTP 400`);
      const examples = operation.responses["400"].content?.["application/json"]?.examples ?? {};
      assert.ok(examples.invalid_request, `${key} must document invalid_request`);
      assert.equal(/\bcursor\b/i.test(operation.responses["400"].description ?? ""), options.includeCursor !== false, `${key} 400 cursor wording`);
      const limit = operation.parameters.find((parameter) => parameter.name === "limit");
      assert.equal(limit.schema?.minimum, 1, `${key} limit minimum`);
      assert.equal(limit.schema?.maximum, options.maxLimit ?? 100, `${key} limit maximum`);
      assert.equal(limit.schema?.default, options.defaultLimit ?? 50, `${key} limit default`);
      assert.equal(limit.allowEmptyValue, options.allowEmptyValue ?? true, `${key} limit empty-value support`);
      const expectedCursor = options.includeCursor !== false;
      assert.equal(parameterNames.includes("cursor"), expectedCursor, `${key} cursor parameter`);
      if (expectedCursor) {
        const cursor = operation.parameters.find((parameter) => parameter.name === "cursor");
        assert.equal(cursor.allowEmptyValue, options.allowEmptyValue ?? true, `${key} cursor empty-value support`);
      }
    }
  }
  assert.deepEqual(documented, expected, "every runtime bounded route option must be documented exactly once");
});
