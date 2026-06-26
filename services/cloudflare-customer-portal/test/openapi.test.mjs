// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker source so the two cannot silently
// drift. This is a "doc-of-existing" guard, not a generator: if someone adds/removes a route in
// src/worker/index.ts (or in the spec) without updating the other, this test fails.
//
// It asserts three things:
//   (a) every path in spec.paths has its literal route present in src/worker/index.ts;
//   (b) every routed path src/worker/index.ts declares is present in spec.paths (via a CANONICAL
//       route list derived from the route inventory — so an ADDED source route that nobody put in
//       the spec, or a REMOVED source route still in the spec, fails);
//   (c) the spec's own set of paths equals that canonical list (keeps the inventory authoritative).
//
// Zero-dep node:test. The spec is imported from the compiled worker output (dist-worker), matching
// the other portal tests which import ../dist-worker/worker/index.js after `npm run build:worker`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../dist-worker/worker/openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "..", "src", "worker", "index.ts"), "utf8");

// The canonical route inventory: { method, path } pairs the Worker is known to serve, derived from
// the code-reading route inventory. The two doc-serving routes (/openapi.json, /docs) are included
// because they are now real routes in the fetch handler. This list is the source of truth the test
// pins BOTH the spec and the source against — keep it in sync with index.ts deliberately.
const CANONICAL_ROUTES = [
  { method: "GET", path: "/openapi.json", inSpec: false },
  { method: "GET", path: "/docs", inSpec: false },
  { method: "GET", path: "/health", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/request", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/verify", inSpec: true },
  { method: "GET", path: "/portal/v1/auth/magic", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/magic-redeem", inSpec: true },
  { method: "POST", path: "/portal/v1/auth/logout", inSpec: true },
  { method: "POST", path: "/portal/v1/admin/bootstrap-otp", inSpec: true },
  { method: "GET", path: "/api/portal/me", inSpec: true },
  { method: "GET", path: "/api/portal/entitlements", inSpec: true },
  { method: "GET", path: "/api/portal/devices", inSpec: true },
  { method: "GET", path: "/api/portal/usage", inSpec: true },
  { method: "POST", path: "/api/portal/checkout", inSpec: true },
  { method: "POST", path: "/api/portal/heartbeat", inSpec: true },
  { method: "POST", path: "/api/portal/release", inSpec: true },
  { method: "POST", path: "/api/portal/download", inSpec: true },
];

// Translate an OpenAPI templated path (e.g. /thing/{id}) to a literal the source would contain.
// This Worker has no path params, but we keep the translation so the guard is correct if any are
// added later: {id} <-> a :id segment or a literal-with-regex segment.
function specPathToSourceLiteral(p) {
  return p.replace(/\{[^/}]+\}/g, ":param");
}

// Does the worker source literally route this path? The portal dispatches on `p === "<path>"` (or,
// for /api/portal/*, `p.startsWith("/api/portal/")` plus a `pathname === "<path>"` branch). We treat
// a route as present if its exact quoted literal appears in a comparison.
function sourceRoutesPath(source, path) {
  const literal = specPathToSourceLiteral(path);
  // Exact-equality dispatch: p === "/x" or pathname === "/x".
  if (source.includes(`=== "${literal}"`)) return true;
  if (source.includes(`"${literal}" ===`)) return true;
  // Prefix dispatch for the /api/portal/* family.
  if (source.includes(`.startsWith("${literal}")`)) return true;
  return false;
}

test("(a) every spec path has its literal route present in index.ts source", () => {
  const specPaths = Object.keys(openApiDocument.paths);
  assert.ok(specPaths.length > 0, "spec has no paths");
  for (const p of specPaths) {
    assert.ok(
      sourceRoutesPath(indexSource, p),
      `spec path ${p} has no matching literal route in src/worker/index.ts (drift: spec lists a route the code does not serve)`,
    );
  }
});

test("(b) every canonical source route is present (source <-> canonical parity)", () => {
  for (const r of CANONICAL_ROUTES) {
    assert.ok(
      sourceRoutesPath(indexSource, r.path),
      `canonical route ${r.method} ${r.path} is missing from src/worker/index.ts (a route was removed without updating the inventory)`,
    );
  }
  // And: the source must not route a path the canonical list does not know about. We scan for every
  // `=== "/..."` and `.startsWith("/api/portal/")` literal and require each to be canonical.
  const literalRe = /(?:===\s*"|"\s*===\s*p\b.*?")(\/[A-Za-z0-9_./:-]*)"/g;
  const startsWithRe = /\.startsWith\("(\/[A-Za-z0-9_./:-]*)"\)/g;
  const canonicalLiterals = new Set(CANONICAL_ROUTES.map((r) => specPathToSourceLiteral(r.path)));
  // /api/portal/ prefix is the dispatch root, not itself a documented route — allow it.
  canonicalLiterals.add("/api/portal/");
  const found = new Set();
  let m;
  while ((m = literalRe.exec(indexSource)) !== null) found.add(m[1]);
  while ((m = startsWithRe.exec(indexSource)) !== null) found.add(m[1]);
  for (const lit of found) {
    assert.ok(
      canonicalLiterals.has(lit),
      `src/worker/index.ts routes ${lit} which is NOT in the canonical route inventory (a route was added without updating the spec/inventory)`,
    );
  }
});

test("(c) spec paths equal the canonical 'inSpec' route set (no spec-only / no missing)", () => {
  const specPaths = new Set(Object.keys(openApiDocument.paths));
  const expected = new Set(CANONICAL_ROUTES.filter((r) => r.inSpec).map((r) => r.path));

  for (const p of expected) {
    assert.ok(specPaths.has(p), `canonical route ${p} is documented in the inventory but MISSING from spec.paths`);
  }
  for (const p of specPaths) {
    assert.ok(expected.has(p), `spec.paths declares ${p} which is NOT in the canonical inventory (spec drifted ahead of code)`);
  }
});

test("each spec operation has the required documentation fields", () => {
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.equal(typeof op.summary, "string", `${method.toUpperCase()} ${path} missing summary`);
      assert.equal(typeof op.operationId, "string", `${method.toUpperCase()} ${path} missing operationId`);
      assert.ok(Array.isArray(op.security), `${method.toUpperCase()} ${path} missing security array`);
      assert.ok(op.responses && typeof op.responses === "object", `${method.toUpperCase()} ${path} missing responses`);
      assert.ok(Object.keys(op.responses).length > 0, `${method.toUpperCase()} ${path} has no responses`);
      // Every documented response must carry a description.
      for (const [code, resp] of Object.entries(op.responses)) {
        assert.equal(typeof resp.description, "string", `${method.toUpperCase()} ${path} ${code} missing description`);
      }
    }
  }
});

test("spec is OpenAPI 3.1.0 with the shared envelope/server conventions", () => {
  assert.equal(openApiDocument.openapi, "3.1.0");
  assert.deepEqual(openApiDocument.servers, [{ url: "/" }]);
  assert.equal(typeof openApiDocument.info.title, "string");
  assert.equal(typeof openApiDocument.info.version, "string");
  assert.ok(openApiDocument.components.schemas.Envelope, "Envelope schema missing");
  assert.ok(openApiDocument.components.schemas.ErrorEnvelope, "ErrorEnvelope schema missing");
  assert.ok(openApiDocument.components.securitySchemes.sessionCookie, "sessionCookie security scheme missing");
});
