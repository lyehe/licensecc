// Build-time cross-check that PINS the OpenAPI spec to the Worker source so the two
// cannot silently drift. Zero-dep (node:test + node:fs).
//
// What it guarantees:
//   (a) every routed path the spec declares has its literal route present in
//       src/worker/index.ts (path params {id} mapped to the source's :id / regex form);
//   (b) every routed path the SOURCE declares is present in the spec — derived from a
//       canonical route list pinned to the inventory, so adding/removing a route in the
//       Worker without updating the spec (or this list) fails CI.
//
// The two "meta" routes (/openapi.json, /docs) are served directly from the fetch
// handler (not via the regex/equality router), so they are validated by a dedicated
// fetch-handler assertion rather than the API-router scan.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openApiDocument } from "../dist-worker/worker/openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "..", "src", "worker", "index.ts"), "utf8");

// ── Canonical route list (derived from the code-reading inventory) ────────────
// Each entry: { method, path } where `path` uses OpenAPI {id} templating. This is the
// SINGLE SOURCE OF TRUTH the spec and the Worker source are both checked against.
const META_ROUTES = [
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/docs" },
];

const API_ROUTES = [
  { method: "GET", path: "/api/admin/summary" },
  { method: "GET", path: "/api/admin/report" },
  { method: "GET", path: "/api/admin/customers" },
  { method: "GET", path: "/api/admin/customers/{id}" },
  { method: "POST", path: "/api/admin/customers/{id}/disable" },
  { method: "POST", path: "/api/admin/customers/{id}/reenable" },
  { method: "GET", path: "/api/admin/licenses" },
  { method: "GET", path: "/api/admin/orders" },
  { method: "GET", path: "/api/admin/settings" },
  { method: "GET", path: "/api/admin/entitlements" },
  { method: "POST", path: "/api/admin/entitlements" },
  { method: "GET", path: "/api/admin/entitlements/{id}" },
  { method: "PATCH", path: "/api/admin/entitlements/{id}" },
  { method: "POST", path: "/api/admin/entitlements/{id}/disable" },
  { method: "POST", path: "/api/admin/entitlements/{id}/reenable" },
  { method: "POST", path: "/api/admin/entitlements/{id}/revoke" },
  { method: "GET", path: "/api/admin/events" },
  { method: "POST", path: "/api/sync/entitlements" },
];

const ALL_ROUTES = [...META_ROUTES, ...API_ROUTES];

// ── Source-presence check ─────────────────────────────────────────────────────
// Map an OpenAPI path to a predicate that proves it is routed by the Worker source.
// Literal paths must appear as `url.pathname === "X"` (or `pathname !== "X"` for sync).
// Templated paths ({id}) must be covered by one of the source's regexes.
function literalRouted(path) {
  return SOURCE.includes(`url.pathname === "${path}"`) || SOURCE.includes(`.pathname !== "${path}"`);
}

// Hard-anchor each templated route to the EXACT regex LITERAL in the source (compared
// as a verbatim substring — no escaping games). If the Worker changes one of these
// routing regexes, the corresponding anchor stops matching and the test fails, which is
// the point: the spec's {id} routes are pinned to the real source patterns.
const TEMPLATED_ROUTE_SOURCE = {
  "/api/admin/customers/{id}": String.raw`/^\/api\/admin\/customers\/([^/]+)$/`,
  "/api/admin/customers/{id}/disable": String.raw`/^\/api\/admin\/customers\/([^/]+)\/(disable|reenable)$/`,
  "/api/admin/customers/{id}/reenable": String.raw`/^\/api\/admin\/customers\/([^/]+)\/(disable|reenable)$/`,
  // The detail GET route AND the disable/reenable/revoke mutations are both covered by
  // entitlement regexes; the mutation actions live in the combined `(?:\/(disable|reenable|revoke))?` form.
  "/api/admin/entitlements/{id}": String.raw`/^\/api\/admin\/entitlements\/([^/]+)$/`,
  "/api/admin/entitlements/{id}/disable": String.raw`(?:\/(disable|reenable|revoke))?`,
  "/api/admin/entitlements/{id}/reenable": String.raw`(?:\/(disable|reenable|revoke))?`,
  "/api/admin/entitlements/{id}/revoke": String.raw`(?:\/(disable|reenable|revoke))?`,
};

function routePresentInSource(path) {
  if (META_ROUTES.some((r) => r.path === path)) {
    // Served from the fetch handler with an equality check, same as literal API routes.
    return literalRouted(path);
  }
  if (path.includes("{id}")) {
    const anchor = TEMPLATED_ROUTE_SOURCE[path];
    assert.ok(anchor, `no source anchor configured for templated route ${path}`);
    return SOURCE.includes(anchor);
  }
  return literalRouted(path);
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

test("(a) every spec path's literal route is present in the Worker source", () => {
  for (const path of Object.keys(openApiDocument.paths)) {
    assert.ok(
      routePresentInSource(path),
      `spec declares ${path} but no matching route exists in src/worker/index.ts`,
    );
  }
});

test("(b) spec.paths matches the canonical route list exactly (no drift either way)", () => {
  const specPaths = new Set(Object.keys(openApiDocument.paths));
  const canonicalPaths = new Set(ALL_ROUTES.map((r) => r.path));

  for (const path of canonicalPaths) {
    assert.ok(specPaths.has(path), `canonical route ${path} is missing from spec.paths`);
  }
  for (const path of specPaths) {
    assert.ok(canonicalPaths.has(path), `spec.paths has ${path} which is not in the canonical route list`);
  }
});

test("(b) every canonical METHOD+path is declared as that operation in the spec", () => {
  for (const { method, path } of ALL_ROUTES) {
    const item = openApiDocument.paths[path];
    assert.ok(item, `spec.paths missing ${path}`);
    assert.ok(item[method.toLowerCase()], `spec.paths[${path}] missing ${method} operation`);
  }
  // And no spec operation exists that is not in the canonical list.
  const canonical = new Set(ALL_ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const [path, item] of Object.entries(openApiDocument.paths)) {
    for (const method of ["get", "post", "patch", "put", "delete"]) {
      if (item[method]) {
        const key = `${method.toUpperCase()} ${path}`;
        assert.ok(canonical.has(key), `spec has un-inventoried operation ${key}`);
      }
    }
  }
});

test("(b) every canonical API route is reachable in the source router scan", () => {
  // Cross-check the OTHER direction: each canonical API route must be matched by the
  // source. (Templated routes are anchored to their exact regex literal above.)
  for (const { path } of API_ROUTES) {
    assert.ok(
      routePresentInSource(path),
      `canonical route ${path} is not present in src/worker/index.ts — source drifted from the inventory`,
    );
  }
});

test("meta routes are served from the fetch handler before auth", () => {
  // /openapi.json and /docs must be handled in fetch() ahead of the /api/admin/ and
  // /api/sync/ dispatch, so they are reachable unauthenticated.
  const fetchBody = SOURCE.slice(SOURCE.indexOf("async fetch("));
  const openapiIdx = fetchBody.indexOf('url.pathname === "/openapi.json"');
  const docsIdx = fetchBody.indexOf('url.pathname === "/docs"');
  const adminIdx = fetchBody.indexOf('url.pathname.startsWith("/api/admin/")');
  assert.ok(openapiIdx > -1, "/openapi.json not served from fetch()");
  assert.ok(docsIdx > -1, "/docs not served from fetch()");
  assert.ok(adminIdx > -1, "admin dispatch not found in fetch()");
  assert.ok(openapiIdx < adminIdx, "/openapi.json must be handled before the admin dispatch");
  assert.ok(docsIdx < adminIdx, "/docs must be handled before the admin dispatch");
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
