// Build-time CROSS-CHECK that PINS the OpenAPI spec to the Worker's actual routes so the two cannot
// silently drift. This is a "doc-of-existing" guard, not a generator. It compares COMPILED artifacts
// — the route inventory (dist-worker/worker/routes.js, the single source of truth), the dispatch
// keys the Worker actually serves (dist-worker/worker/index.js PORTAL_ROUTE_KEYS), and the spec —
// instead of grepping the TypeScript source, so refactoring handler code can never break this test;
// only a real route/spec divergence can.
//
// Zero-dep node:test. Every portal route is a static literal (no path parameters).

import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleComponents, assemblePaths, assertUniqueOperationIds } from "../dist-worker/worker/openapi/assemble.js";
import { openApiDocument } from "../dist-worker/worker/openapi/document.js";
import { ALL_ROUTES, META_ROUTES, PUBLIC_ROUTES, SESSION_ROUTES } from "../dist-worker/worker/routes.js";
import worker, { PORTAL_ROUTE_KEYS } from "../dist-worker/worker/index.js";

const keyOf = (r) => `${r.method} ${r.path}`;

function documentedErrorCodes(path, status, method = "post") {
  const response = openApiDocument.paths[path]?.[method]?.responses?.[String(status)];
  const code = response?.content?.["application/json"]?.schema?.properties?.code;
  if (typeof code?.const === "string") return [code.const];
  if (Array.isArray(code?.enum) && code.enum.every((value) => typeof value === "string")) return code.enum;
  throw new Error(`${path} ${status} does not declare an exact error-code schema`);
}

test("OpenAPI assembly rejects collisions without mutating portal fragments", () => {
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
    () => assemblePaths({ label: "parameters-a", entries: [["/shared", { parameters: [] }]] }, { label: "parameters-b", entries: [["/shared", { parameters: [] }]] }),
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

test("route inventory is well-formed (no duplicates, session routes under the prefix root)", () => {
  const keys = ALL_ROUTES.map(keyOf);
  assert.equal(new Set(keys).size, keys.length, "duplicate method+path in the inventory");
  assert.equal(ALL_ROUTES.length, META_ROUTES.length + PUBLIC_ROUTES.length + SESSION_ROUTES.length);
  for (const r of SESSION_ROUTES) {
    assert.ok(r.path.startsWith("/api/portal/"), `session route outside the dispatch root: ${r.path}`);
  }
});

test("the dispatch tables serve exactly the route inventory (both directions)", () => {
  assert.deepEqual([...PORTAL_ROUTE_KEYS].sort(), ALL_ROUTES.map(keyOf).sort());
});

test("spec.paths equal the canonical 'inSpec' route set (no spec-only / no missing)", () => {
  const specPaths = new Set(Object.keys(openApiDocument.paths));
  const expected = new Set(ALL_ROUTES.filter((r) => r.inSpec).map((r) => r.path));
  for (const p of expected) {
    assert.ok(specPaths.has(p), `canonical route ${p} is documented in the inventory but MISSING from spec.paths`);
  }
  for (const p of specPaths) {
    assert.ok(expected.has(p), `spec.paths declares ${p} which is NOT in the canonical inventory (spec drifted ahead of code)`);
  }
});

test("self-describing meta routes stay served but intentionally outside the document", () => {
  for (const route of META_ROUTES) {
    assert.equal(route.inSpec, false, `${route.path} must keep its explicit inSpec:false exception`);
    assert.equal(openApiDocument.paths[route.path], undefined, `${route.path} must not be self-documented`);
  }
});

test("each spec path documents exactly the method the inventory declares", () => {
  for (const [p, ops] of Object.entries(openApiDocument.paths)) {
    const methods = Object.keys(ops).filter((k) => ["get", "post", "put", "delete", "patch"].includes(k));
    const expected = ALL_ROUTES.filter((r) => r.inSpec && r.path === p).map((r) => r.method.toLowerCase());
    assert.deepEqual(methods.sort(), expected.sort(), `spec methods must exactly match inventory for ${p}`);
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

test("operation identifiers and route-class auth declarations stay exact", () => {
  assertUniqueOperationIds(openApiDocument.paths);
  for (const route of PUBLIC_ROUTES) {
    if (route.path === "/portal/v1/auth/password") continue;
    if (route.path.endsWith("/start") || route.path.startsWith("/portal/v1/auth/identities")) continue;
    if (route.path === "/portal/v1/auth/logout" || route.path === "/portal/v1/admin/bootstrap-otp") continue;
    const operation = openApiDocument.paths[route.path]?.[route.method.toLowerCase()];
    if (!operation) continue;
    assert.deepEqual(operation.security, [], `${route.path} must remain public`);
  }
  for (const route of SESSION_ROUTES) {
    const operation = openApiDocument.paths[route.path][route.method.toLowerCase()];
    assert.deepEqual(operation.security, [{ sessionCookie: [] }], `${route.path} must remain session-scoped`);
  }
  assert.deepEqual(openApiDocument.paths["/portal/v1/auth/logout"].post.security, [{ sessionCookie: [] }, {}]);
  assert.deepEqual(openApiDocument.paths["/portal/v1/admin/bootstrap-otp"].post.security, [{ bootstrapBearer: [] }, { bootstrapBearer: [], cfAccess: [] }]);
});

// GET only ever runs gate() -> authSession() -> the settings row lookup -> the 200 read. POST goes
// on to readJson/throttle/the credential check/the batch write, which is where 400/409/413/429 and
// the extra 401/403 alternatives come from. A shared response map for both verbs (the prior shape)
// let GET claim codes it structurally cannot emit.
test("password settings GET and POST each document only the codes their own handler path can emit", () => {
  const path = "/portal/v1/auth/password";
  const get = openApiDocument.paths[path].get;
  const post = openApiDocument.paths[path].post;
  assert.deepEqual(Object.keys(get.responses).sort(), ["200", "401", "403", "404", "503"]);
  assert.deepEqual(documentedErrorCodes(path, 401, "get"), ["unauthorized"]);
  assert.deepEqual(documentedErrorCodes(path, 403, "get"), ["cross_site_forbidden"]);
  assert.deepEqual(documentedErrorCodes(path, 404, "get"), ["not_found"]);
  assert.deepEqual(documentedErrorCodes(path, 503, "get"), ["config_error"]);

  assert.deepEqual(Object.keys(post.responses).sort(), ["200", "400", "401", "403", "404", "409", "413", "429", "503"]);
  assert.deepEqual([...documentedErrorCodes(path, 400, "post")].sort(), ["invalid_json", "invalid_registration"]);
  assert.deepEqual([...documentedErrorCodes(path, 401, "post")].sort(), ["invalid_credentials", "unauthorized"]);
  assert.deepEqual([...documentedErrorCodes(path, 403, "post")].sort(), ["cross_site_forbidden", "verified_sign_in_required"]);
  assert.deepEqual(documentedErrorCodes(path, 404, "post"), ["not_found"]);
  assert.deepEqual(documentedErrorCodes(path, 409, "post"), ["password_change_conflict"]);
  assert.deepEqual(documentedErrorCodes(path, 413, "post"), ["body_too_large"]);
  assert.deepEqual(documentedErrorCodes(path, 429, "post"), ["rate_limited"]);
  assert.deepEqual(documentedErrorCodes(path, 503, "post"), ["config_error"]);
});

test("password login documents the suspended-account denial separately from invalid credentials", () => {
  const path = "/portal/v1/auth/password/login";
  assert.deepEqual(documentedErrorCodes(path, 401), ["invalid_credentials"]);
  assert.deepEqual([...documentedErrorCodes(path, 403)].sort(), ["account_suspended", "cross_site_forbidden"]);
});

// The handler runs isCrossSite -> authSession -> readJson -> the provider check -> the existence
// read -> one conditional DELETE batch, so these are exactly the statuses it can answer with.
test("provider unlink requires a session and documents every status its handler can emit", () => {
  const path = "/portal/v1/auth/identities/unlink";
  const post = openApiDocument.paths[path]?.post;
  assert.ok(post, `${path} must be documented`);
  assert.deepEqual(post.security, [{ sessionCookie: [] }]);
  assert.deepEqual(post.requestBody.content["application/json"].schema.properties.provider.enum, ["google", "github"]);
  assert.deepEqual(Object.keys(post.responses).sort(), ["200", "400", "401", "403", "404", "409", "413", "503"]);
  assert.equal(post.responses["200"].content["application/json"].schema.properties.code.const, "identity_unlinked");
  assert.deepEqual([...documentedErrorCodes(path, 400)].sort(), ["invalid_json", "invalid_request"]);
  assert.deepEqual(documentedErrorCodes(path, 401), ["unauthorized"]);
  assert.deepEqual(documentedErrorCodes(path, 403), ["cross_site_forbidden"]);
  assert.deepEqual(documentedErrorCodes(path, 404), ["not_found"]);
  assert.deepEqual(documentedErrorCodes(path, 409), ["last_sign_in_method"]);
  assert.deepEqual(documentedErrorCodes(path, 413), ["body_too_large"]);
  assert.deepEqual(documentedErrorCodes(path, 503), ["config_error"]);
});

// The seven auth entry points that now send a real `retry-after` header must document it; the
// password-change 429 (not one of the auth entry points the UI drives its countdown from) and the
// operator break-glass bootstrap route were both deliberately left out of the rollout.
test("the auth 429s that now carry retry-after document it; the untouched 429s do not", () => {
  const withHeader = [
    ["/portal/v1/auth/request", "post"],
    ["/portal/v1/auth/verify", "post"],
    ["/portal/v1/auth/magic-redeem", "post"],
    ["/portal/v1/auth/password/login", "post"],
    ["/portal/v1/auth/password/register", "post"],
    ["/portal/v1/auth/password/reset", "post"],
    ["/portal/v1/auth/password/complete", "post"],
  ];
  for (const [path, method] of withHeader) {
    const response = openApiDocument.paths[path]?.[method]?.responses?.["429"];
    assert.ok(response, `${method.toUpperCase()} ${path} must document 429`);
    assert.ok(response.headers?.["retry-after"], `${method.toUpperCase()} ${path} 429 must document the retry-after header`);
    assert.match(response.description, /retry-after/i, `${method.toUpperCase()} ${path} 429 description must mention retry-after`);
  }
  const settingsChange = openApiDocument.paths["/portal/v1/auth/password"]?.post?.responses?.["429"];
  assert.ok(settingsChange, "password settings POST must still document 429");
  assert.equal(settingsChange.headers, undefined, "the password-change 429 was left out of the retry-after rollout");
  const bootstrap = openApiDocument.paths["/portal/v1/admin/bootstrap-otp"]?.post?.responses?.["429"];
  assert.ok(bootstrap, "bootstrap-otp must still document 429");
  assert.equal(bootstrap.headers, undefined, "the operator break-glass route stays outside the customer-facing retry-after rollout");
});

test("the providers envelope documents its nullable support contact", () => {
  const data = openApiDocument.paths["/portal/v1/auth/providers"].get.responses["200"].content["application/json"].schema.properties.data;
  assert.deepEqual(data.properties.support.type, ["string", "null"]);
  assert.ok(data.required.includes("support"), "the Worker always sends support, as a string or null");
});

test("the entitlements envelope documents each row's nullable trial end and its activation flag", () => {
  const data = openApiDocument.paths["/api/portal/entitlements"].get.responses["200"].content["application/json"].schema.properties.data;
  const row = data.properties.items.items;
  assert.equal(row.properties.enforcement_mode, undefined, "every listed grant is protected, so a row names no mode");
  assert.deepEqual(row.properties.trial_ends_at?.type, ["integer", "null"]);
  const description = row.properties.trial_ends_at.description;
  assert.match(description, /protected-device trial rule that enforces/, "the end follows the protected-device trial rule that enforces every row");
  assert.match(description, /valid_until/, "the end never outlives the license");
  assert.match(description, /not started/, "the description says why an activation trial can have no end yet");
  assert.equal(row.properties.trial_starts_on_activation?.type, "boolean");
  assert.match(row.properties.trial_starts_on_activation.description, /at least 2 seconds/, "the flag says which durations the enforcing rule accepts");
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

test("health OpenAPI documents the backend protected-readiness envelope and status contract", () => {
  const health = openApiDocument.paths["/health"].get;
  assert.deepEqual(Object.keys(health.responses), ["200", "503"]);
  for (const [status, code, ready] of [["200", "healthy", true], ["503", "backend_not_ready", false]]) {
    const schema = health.responses[status].content["application/json"].schema;
    assert.equal(schema.properties.code.const, code, status);
    assert.deepEqual(schema.properties.data.required, ["backend_protected_ready"], status);
    assert.equal(schema.properties.data.properties.backend_protected_ready.const, ready, status);
  }
  assert.doesNotMatch(JSON.stringify(health), /account_token|ACCOUNT_TOKEN/u);
});

test("the doc routes are served without credentials or environment (behavioral)", async () => {
  // The doc handlers must never touch env or auth: they must succeed with an EMPTY env and no
  // cookies. (The SPA fallback and every other route may require env bindings — not these two.)
  const spec = await worker.fetch(new Request("http://test/openapi.json"), {});
  assert.equal(spec.status, 200);
  const body = await spec.json();
  assert.equal(body.openapi, "3.1.0");
  const docs = await worker.fetch(new Request("http://test/docs"), {});
  assert.equal(docs.status, 200);
  assert.match(docs.headers.get("content-type") ?? "", /text\/html/);
  const policy = docs.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)?.[1];
  assert.ok(nonce, "docs must bind inline code to a CSP nonce");
  assert.doesNotMatch(policy, /unsafe-(?:inline|eval)/u);
  const html = await docs.text();
  assert.equal(html.split(`nonce="${nonce}"`).length - 1, 2);
  assert.doesNotMatch(html, /innerHTML/u, "docs renderer must not contain a DOM HTML injection sink");
});
