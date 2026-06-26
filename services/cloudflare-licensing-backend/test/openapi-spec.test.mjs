// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker's actual routes so the doc cannot
// silently drift. Zero-dep (node:test + node:fs). It asserts, bidirectionally:
//   (a) every path in openApiSpec.paths has its literal route dispatched in src/index.ts, and
//   (b) every route src/index.ts dispatches is present in openApiSpec.paths,
// against a CANONICAL route list derived from the hand-verified inventory. If index.ts adds or
// removes a route without a matching spec edit (or vice versa), this test fails in CI.
//
// This Worker has NO path parameters -- every route is a static literal -- so the cross-check is a
// literal-set comparison. (If a templated `{id}` route is ever added, extend the normalizer below to
// map `{id}` <-> the source's `:id` / pathname regex before comparing.)

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiSpec } from "../dist/openapi.js";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

// --- The canonical route list (method + path), derived from the inventory. Maintaining this list is
// the human-checked contract: a route may be served by the Worker only if it is here, and every
// entry here MUST be both routed in index.ts AND documented in the spec. ---
const CANONICAL_ROUTES = [
  // meta (the two doc routes added with the spec, plus health)
  ["GET", "/openapi.json"],
  ["GET", "/docs"],
  ["GET", "/health"],
  // client + fulfillment
  ["POST", "/v1/verify"],
  ["POST", "/v1/orders"],
  // account-token scoped lease/seat/report
  ["POST", "/v1/activate"],
  ["POST", "/v1/renew"],
  ["POST", "/v1/checkout"],
  ["POST", "/v1/heartbeat"],
  ["POST", "/v1/release"],
  ["GET", "/v1/admin/report"],
  // emergency break-glass overrides (/v1/emergency + the scoped target)
  ["POST", "/v1/emergency/v1/activate"],
  ["POST", "/v1/emergency/v1/renew"],
  ["POST", "/v1/emergency/v1/checkout"],
  ["POST", "/v1/emergency/v1/heartbeat"],
  ["POST", "/v1/emergency/v1/release"],
  ["GET", "/v1/emergency/v1/admin/report"],
];

const CANONICAL_PATHS = new Set(CANONICAL_ROUTES.map(([, p]) => p));

// ---------------------------------------------------------------------------
// Source-side route extraction. The dispatcher matches static literals via
//   url.pathname === "/literal"     (top-level routes)
//   target === "/literal"           (emergency sub-routes, after stripping /v1/emergency)
//   url.pathname.startsWith("/v1/emergency/")   (the emergency prefix gate)
// We reconstruct the full emergency paths as "/v1/emergency" + target.
// ---------------------------------------------------------------------------
function extractSourceRoutes(src) {
  const top = new Set();
  for (const m of src.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)) top.add(m[1]);

  const emergencyTargets = new Set();
  for (const m of src.matchAll(/\btarget\s*===\s*"([^"]+)"/g)) emergencyTargets.add(m[1]);

  const usesEmergencyPrefix = /url\.pathname\.startsWith\(\s*"\/v1\/emergency\/"\s*\)/.test(src);

  const full = new Set(top);
  if (usesEmergencyPrefix) {
    for (const t of emergencyTargets) full.add("/v1/emergency" + t);
  }
  return { full, top, emergencyTargets, usesEmergencyPrefix };
}

const source = extractSourceRoutes(indexSource);

test("source declares the emergency prefix gate", () => {
  assert.ok(
    source.usesEmergencyPrefix,
    "expected src/index.ts to gate emergency routes via url.pathname.startsWith(\"/v1/emergency/\")",
  );
});

test("canonical route list matches the literals the source dispatches", () => {
  // Every canonical path must be present as a routed literal in the source.
  const missingInSource = [...CANONICAL_PATHS].filter((p) => !source.full.has(p));
  assert.deepEqual(
    missingInSource,
    [],
    `canonical routes not found in ${indexPath}: ${missingInSource.join(", ")}`,
  );

  // Every routed literal in the source must be a known canonical path. This is what catches a NEW
  // route added to index.ts without updating the canonical list + spec.
  const unexpectedInSource = [...source.full].filter((p) => !CANONICAL_PATHS.has(p));
  assert.deepEqual(
    unexpectedInSource,
    [],
    `src/index.ts routes a path absent from the canonical list (add it to the spec + CANONICAL_ROUTES): ${unexpectedInSource.join(", ")}`,
  );
});

test("(a) every spec path has its literal route present in the source", () => {
  const specPaths = Object.keys(openApiSpec.paths);
  const orphanInSpec = specPaths.filter((p) => !source.full.has(p));
  assert.deepEqual(
    orphanInSpec,
    [],
    `spec documents paths the Worker does not route: ${orphanInSpec.join(", ")}`,
  );
});

test("(b) every routed path the source declares is present in spec.paths", () => {
  const specPaths = new Set(Object.keys(openApiSpec.paths));
  const undocumented = [...source.full].filter((p) => !specPaths.has(p));
  assert.deepEqual(
    undocumented,
    [],
    `Worker routes paths missing from the spec: ${undocumented.join(", ")}`,
  );
});

test("spec.paths == canonical route set (no drift in either direction)", () => {
  const specPaths = new Set(Object.keys(openApiSpec.paths));
  const onlyInCanonical = [...CANONICAL_PATHS].filter((p) => !specPaths.has(p));
  const onlyInSpec = [...specPaths].filter((p) => !CANONICAL_PATHS.has(p));
  assert.deepEqual(onlyInCanonical, [], `canonical paths missing from spec: ${onlyInCanonical.join(", ")}`);
  assert.deepEqual(onlyInSpec, [], `spec paths missing from canonical list: ${onlyInSpec.join(", ")}`);
});

test("each spec path+method is the method the canonical list declares", () => {
  const canonicalByPath = new Map(CANONICAL_ROUTES.map(([m, p]) => [p, m.toLowerCase()]));
  for (const [p, ops] of Object.entries(openApiSpec.paths)) {
    const methods = Object.keys(ops).filter((k) => ["get", "post", "put", "delete", "patch"].includes(k));
    assert.equal(methods.length, 1, `spec path ${p} should document exactly one method`);
    assert.equal(
      methods[0],
      canonicalByPath.get(p),
      `spec path ${p} documents ${methods[0]} but the route is ${canonicalByPath.get(p)}`,
    );
  }
});

test("spec is OpenAPI 3.1 with a root server and reusable error envelope", () => {
  assert.equal(openApiSpec.openapi, "3.1.0");
  assert.deepEqual(openApiSpec.servers, [{ url: "/" }]);
  assert.ok(openApiSpec.components.schemas.ErrorEnvelope, "ErrorEnvelope schema must exist");
});

test("the /openapi.json and /docs routes are served before any auth in the fetch handler", () => {
  // Both doc routes must be dispatched ahead of the first authenticated route so they need no
  // credentials. We compare source offsets: the doc handlers must precede /v1/verify dispatch.
  const openapiIdx = indexSource.indexOf('url.pathname === "/openapi.json"');
  const docsIdx = indexSource.indexOf('url.pathname === "/docs"');
  const verifyIdx = indexSource.indexOf('url.pathname === "/v1/verify"');
  assert.ok(openapiIdx > 0, "/openapi.json route not found in source");
  assert.ok(docsIdx > 0, "/docs route not found in source");
  assert.ok(verifyIdx > 0, "/v1/verify route not found in source");
  assert.ok(openapiIdx < verifyIdx, "/openapi.json must be dispatched before /v1/verify");
  assert.ok(docsIdx < verifyIdx, "/docs must be dispatched before /v1/verify");
});
