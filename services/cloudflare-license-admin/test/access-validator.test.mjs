import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { test } from "node:test";
import {
  accessHeaders,
  entitlementPayload,
  parseArgs,
  requestJson,
  runAccessAdminValidation,
  validateOptions,
} from "../scripts/validate-access-admin.mjs";
import {
  extractJwt,
  parseArgs as parseDrillArgs,
  readAccessJwt,
  validateDrillOptions,
} from "../scripts/access-admin-drill.mjs";
import { buildSyncPayload } from "../scripts/sync-entitlement.mjs";

const fingerprint = "b".repeat(64);

test("admin static assets carry a restrictive browser security policy", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /Content-Security-Policy: default-src 'none'/u);
  assert.match(headers, /script-src 'self'/u);
  assert.match(headers, /frame-ancestors 'none'/u);
  assert.match(headers, /X-Frame-Options: DENY/u);
  assert.match(headers, /X-Content-Type-Options: nosniff/u);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/iu);
});

function fakeJwt() {
  return ["eyJ" + "a".repeat(12), "b".repeat(22), "c".repeat(22)].join(".");
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body === "" ? {} : JSON.parse(body)));
  });
}

/** `transitions` (when given) captures each revoke/reenable request's path and parsed body, so a
 * test can assert the script actually sends the mandatory owner/revocation-sequence precondition. */
function mockAdminHandler(transitions = []) {
  const idempotency = new Map();
  let row = null;
  return async (request, response) => {
    const token = request.headers["cf-access-jwt-assertion"];
    const url = new URL(request.url, "http://127.0.0.1");
    if (token === undefined) {
      json(response, 401, { ok: false, code: "missing_access_jwt" });
      return;
    }
    if (token === "not-a-jwt") {
      json(response, 403, { ok: false, code: "invalid_access_jwt" });
      return;
    }
    if (token === "reader-token" && request.method !== "GET") {
      json(response, 403, { ok: false, code: "admin_role_required" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      response.end("<!doctype html><html><body><div id=\"root\"></div></body></html>");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/admin/summary") {
      json(response, 200, { ok: true, code: "summary", data: { entitlements: { total: row === null ? 0 : 1 } } });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/customers") {
      json(response, 200, {
        ok: true,
        code: "customer_created",
        data: { id: "cust_1", name: "Access Validator", email: "", login_email: "", status: "active", external_ref: "", created_at: 0, updated_at: 0 },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/customers/cust_1/licenses") {
      json(response, 200, {
        ok: true,
        code: "license_created",
        data: { id: "lic_1", customer_id: "cust_1", project: "DEFAULT", label: "", created_at: 0 },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/entitlements") {
      const key = request.headers["idempotency-key"];
      if (typeof key === "string" && idempotency.has(key)) {
        json(response, 200, idempotency.get(key));
        return;
      }
      const body = await readBody(request);
      row = {
        ...body,
        id: "scratch-id",
        status: "active",
        revocation_seq: 1,
      };
      const envelope = { ok: true, code: "entitlement_saved", data: row };
      if (typeof key === "string") {
        idempotency.set(key, envelope);
      }
      json(response, 200, envelope);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/admin/entitlements/scratch-id") {
      json(response, 200, { ok: true, code: "entitlement", data: row });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/entitlements/scratch-id/revoke") {
      transitions.push({ path: "revoke", body: await readBody(request) });
      row = { ...row, status: "revoked", revocation_seq: 2 };
      json(response, 200, { ok: true, code: "entitlement_revoked", data: row });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/entitlements/scratch-id/reenable") {
      transitions.push({ path: "reenable", body: await readBody(request) });
      json(response, 409, { ok: false, code: "revoked_entitlement_is_terminal" });
      return;
    }
    json(response, 404, { ok: false, code: "not_found" });
  };
}

test("access validator parses token from environment and validates scratch fingerprint", () => {
  const options = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url",
    "https://admin.example",
    "--fingerprint",
    fingerprint,
  ]), { LICENSECC_ACCESS_JWT: "jwt" });
  assert.equal(options.baseUrl.toString(), "https://admin.example/");
  assert.equal(options.accessJwt, "jwt");
  assert.equal(options.fingerprint, fingerprint);
});

test("access validator tolerates npm config and stripped positional argument forwarding", () => {
  const fromNpmConfig = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
  ], {
    npm_config_url: "https://admin.example",
    npm_config_project: "PROJECT",
    npm_config_feature: "FEATURE",
    npm_config_fingerprint: fingerprint,
    npm_config_access_jwt: "jwt",
  }));
  assert.equal(fromNpmConfig.baseUrl.toString(), "https://admin.example/");
  assert.equal(fromNpmConfig.project, "PROJECT");
  assert.equal(fromNpmConfig.feature, "FEATURE");
  assert.equal(fromNpmConfig.fingerprint, fingerprint);
  assert.equal(fromNpmConfig.accessJwt, "jwt");

  const stripped = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "https://admin.example",
    "PROJECT",
    "FEATURE",
    fingerprint,
  ], {
    npm_config_url: "true",
    npm_config_project: "true",
    npm_config_feature: "true",
    npm_config_fingerprint: "true",
  }), {
    LICENSECC_ACCESS_JWT: "jwt",
  });
  assert.equal(stripped.baseUrl.toString(), "https://admin.example/");
  assert.equal(stripped.project, "PROJECT");
  assert.equal(stripped.feature, "FEATURE");
  assert.equal(stripped.fingerprint, fingerprint);
  assert.equal(stripped.accessJwt, "jwt");
});

test("access validator accepts equals-form arguments", () => {
  const options = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url=https://admin.example",
    "--project=PROJECT",
    "--feature=FEATURE",
    `--fingerprint=${fingerprint}`,
  ]), { LICENSECC_ACCESS_JWT: "jwt" });
  assert.equal(options.baseUrl.toString(), "https://admin.example/");
  assert.equal(options.project, "PROJECT");
  assert.equal(options.feature, "FEATURE");
  assert.equal(options.fingerprint, fingerprint);
});

test("access validator accepts a production-safe read-only mode", () => {
  const options = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url=https://admin.example",
    "--read-only",
  ]), { LICENSECC_ACCESS_JWT: "jwt" });
  assert.equal(options.readOnly, true);

  const environment = { LICENSECC_ACCESS_JWT: "jwt", LICENSECC_ADMIN_READ_ONLY: "1" };
  const fromEnvironment = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url=https://admin.example",
  ], environment), environment);
  assert.equal(fromEnvironment.readOnly, true);
});

test("access validator reads optional non-admin token from environment", () => {
  const options = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url",
    "https://admin.example",
    "--access-jwt",
    "admin-jwt",
  ]), { LICENSECC_NON_ADMIN_ACCESS_JWT: "reader-jwt" });
  assert.equal(options.nonAdminAccessJwt, "reader-jwt");
});

test("access validator can require a real non-admin identity for protected staging", () => {
  assert.throws(() => validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url",
    "https://admin.example",
    "--require-non-admin",
  ]), { LICENSECC_ACCESS_JWT: "admin-jwt" }), /non-admin Access JWT is required/u);
  const options = validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url",
    "https://admin.example",
    "--require-non-admin",
  ]), {
    LICENSECC_ACCESS_JWT: "admin-jwt",
    LICENSECC_NON_ADMIN_ACCESS_JWT: "reader-jwt",
  });
  assert.equal(options.requireNonAdmin, true);
  assert.equal(options.nonAdminAccessJwt, "reader-jwt");
});

test("access validator rejects invalid scratch fingerprint", () => {
  assert.throws(() => validateOptions(parseArgs([
    "node",
    "validate-access-admin.mjs",
    "--url",
    "https://admin.example",
    "--access-jwt",
    "jwt",
    "--fingerprint",
    "bad",
  ])), /fingerprint/);
});

test("access validator builds a safe active entitlement payload", () => {
  const payload = entitlementPayload({
    project: "DEFAULT",
    feature: "DEFAULT",
    fingerprint,
  }, "cust_1", "lic_1");
  assert.equal(payload.status, "active");
  assert.equal(payload.license_fingerprint, fingerprint);
  assert.equal(payload.enforcement_mode, "device_bound_v1");
  assert.equal(payload.customer_id, "cust_1");
  assert.equal(payload.license_id, "lic_1");
  assert.equal("assertion_ttl_seconds" in payload, false);
});

test("access validator sends Access token as origin header and edge cookie", () => {
  const headers = accessHeaders("admin-token", { "idempotency-key": "request-key" });
  assert.equal(headers["cf-access-jwt-assertion"], "admin-token");
  assert.equal(headers.cookie, "CF_Authorization=admin-token");
  assert.equal(headers["idempotency-key"], "request-key");
});

test("access admin drill resolves options from CLI and environment", () => {
  const options = validateDrillOptions(parseDrillArgs([
    "node",
    "access-admin-drill.mjs",
    "--use-cloudflared",
  ]), {
    LICENSECC_ADMIN_URL: "https://admin.example",
  });
  assert.equal(options.baseUrl.toString(), "https://admin.example/");
  assert.equal(options.useCloudflared, true);
  assert.equal(options.login, false);
});

test("access admin drill extracts JWTs without printing token values", () => {
  const token = fakeJwt();
  assert.equal(extractJwt(`token: ${token}\n`), token);
  assert.equal(extractJwt("no token here"), null);
});

test("access admin drill prefers env token and can read cached cloudflared token", () => {
  const envToken = fakeJwt();
  const options = validateDrillOptions(parseDrillArgs([
    "node",
    "access-admin-drill.mjs",
    "--url",
    "https://admin.example",
    "--use-cloudflared",
  ]));
  assert.deepEqual(readAccessJwt(options, { LICENSECC_ACCESS_JWT: envToken }), {
    token: envToken,
    source: "env",
  });

  const cachedToken = fakeJwt();
  const calls = [];
  const token = readAccessJwt(options, {}, (bin, args) => {
    calls.push([bin, args]);
    return cachedToken;
  });
  assert.equal(token.token, cachedToken);
  assert.equal(token.source, "cloudflared");
  assert.deepEqual(calls, [["cloudflared", ["access", "token", "--app", "https://admin.example/"]]]);
});

test("access admin drill can run cloudflared login before reading token", () => {
  const options = validateDrillOptions(parseDrillArgs([
    "node",
    "access-admin-drill.mjs",
    "--url",
    "https://admin.example",
    "--login",
  ]));
  const calls = [];
  const token = readAccessJwt(options, {}, (bin, args) => {
    calls.push([bin, args]);
    return args[1] === "token" ? fakeJwt() : "";
  });
  assert.equal(token.source, "cloudflared");
  assert.deepEqual(calls, [
    ["cloudflared", ["access", "login", "https://admin.example/"]],
    ["cloudflared", ["access", "token", "--app", "https://admin.example/"]],
  ]);
});

test("access admin drill fails closed when no token source is configured", () => {
  const options = validateDrillOptions(parseDrillArgs([
    "node",
    "access-admin-drill.mjs",
    "--url",
    "https://admin.example",
  ]));
  assert.throws(() => readAccessJwt(options, {}), /LICENSECC_ACCESS_JWT is missing/);
});

test("access validator exercises read, mutation, replay, revoke, and terminal denial", async () => {
  const transitions = [];
  await withServer(mockAdminHandler(transitions), async (baseUrl) => {
    const summary = await runAccessAdminValidation({
      baseUrl: new URL(baseUrl),
      accessJwt: "admin-token",
      nonAdminAccessJwt: "reader-token",
      project: "DEFAULT",
      feature: "DEFAULT",
      fingerprint,
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.ui_status, 200);
    assert.equal(summary.mode, "mutation_drill");
    assert.equal(summary.mutation_performed, true);
    assert.equal(summary.created_revocation_seq, 1);
    assert.equal(summary.replay_revocation_seq, 1);
    assert.equal(summary.revoked_revocation_seq, 2);
    assert.equal(summary.unauthenticated_status, 401);
    assert.equal(summary.malformed_status, 403);
    assert.equal(summary.non_admin_status, 403);
    assert.equal(summary.final_status, "revoked");
    assert.equal("project" in summary, false);
    assert.equal("feature" in summary, false);
    assert.equal("fingerprint" in summary, false);
  });
  // The revoke and reenable calls each send the mandatory owner/revocation-sequence precondition
  // observed from the row they act on, not just a reason.
  assert.deepEqual(transitions.map((t) => t.path), ["revoke", "reenable"]);
  assert.equal(transitions[0].body.expected_customer_id, "cust_1");
  assert.equal(transitions[0].body.expected_revocation_seq, 1);
  assert.equal(transitions[1].body.expected_customer_id, "cust_1");
  assert.equal(transitions[1].body.expected_revocation_seq, 2);
});

test("access validator read-only mode validates UI and summary without mutation", async () => {
  await withServer(mockAdminHandler(), async (baseUrl) => {
    const summary = await runAccessAdminValidation({
      baseUrl: new URL(baseUrl),
      accessJwt: "admin-token",
      nonAdminAccessJwt: "reader-token",
      readOnly: true,
      project: "DEFAULT",
      feature: "DEFAULT",
      fingerprint,
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.mode, "read_only");
    assert.equal(summary.mutation_performed, false);
    assert.equal(summary.ui_status, 200);
    assert.equal(summary.summary_code, "summary");
    assert.equal(summary.final_status, "not_mutated");
    assert.equal(summary.created_revocation_seq, null);
    assert.equal(summary.non_admin_status, null);
    assert.equal("project" in summary, false);
    assert.equal("feature" in summary, false);
    assert.equal("fingerprint" in summary, false);
  });
});

test("access validator errors expose only status and envelope shape", async () => {
  const secret = "customer-entitlement-must-not-appear";
  await withServer((request, response) => {
    const token = request.headers["cf-access-jwt-assertion"];
    const url = new URL(request.url, "http://127.0.0.1");
    if (token === undefined) return json(response, 401, { ok: false, code: "missing_access_jwt" });
    if (token === "not-a-jwt") return json(response, 403, { ok: false, code: "invalid_access_jwt" });
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html></html>");
      return;
    }
    return json(response, 503, { ok: false, code: secret, data: { license: secret } });
  }, async (baseUrl) => {
    await assert.rejects(
      runAccessAdminValidation({
        baseUrl: new URL(baseUrl),
        accessJwt: "admin-token",
        readOnly: true,
        project: "sensitive-project",
        feature: "sensitive-feature",
        fingerprint,
      }),
      (error) => error instanceof Error
        && /status=503; response_ok=false; envelope_ok=false; code_matches=false/u.test(error.message)
        && !error.message.includes(secret),
    );
  });
});

test("access validator rejects oversized responses without reporting their content", async () => {
  const secret = "oversized-admin-data-must-not-appear";
  await withServer((_request, response) => {
    json(response, 200, { value: secret.repeat(20_000) });
  }, async (baseUrl) => {
    await assert.rejects(
      requestJson(new URL(baseUrl), "/oversized"),
      (error) => error instanceof Error
        && /GET \/oversized exceeded the bounded response limit/u.test(error.message)
        && !error.message.includes(secret),
    );
  });
});

// Every synced grant is protected: the CLI names its customer and license, and never sends a device
// hash or an assertion TTL, which the Worker refuses.
const syncOptions = { fingerprint: "A".repeat(64), "customer-id": "cus_1", "license-id": "lic_1" };

test("sync CLI payload names the grant's owner and license, and nothing a protected grant lacks", () => {
  assert.deepEqual(buildSyncPayload(syncOptions), {
    project: "DEFAULT", feature: "DEFAULT", license_fingerprint: "a".repeat(64), status: "active", valid_from: null, valid_until: null,
    customer_id: "cus_1", license_id: "lic_1", notes: "", reason: "",
  });
  const revoked = buildSyncPayload({ ...syncOptions, status: "revoked", reason: "chargeback", "valid-until": "2000" });
  assert.deepEqual([revoked.status, revoked.reason, revoked.valid_until], ["revoked", "chargeback", 2000]);
});

test("sync CLI refuses a payload without a customer or license, or with a device hash or assertion TTL", () => {
  for (const [option, pattern] of [["customer-id", /customer-id is required/u], ["license-id", /license-id is required/u]]) {
    for (const value of [undefined, ""]) {
      const options = { ...syncOptions, [option]: value };
      if (value === undefined) delete options[option];
      assert.throws(() => buildSyncPayload(options), pattern, `${option}=${String(value)}`);
    }
  }
  for (const option of ["device-hash", "assertion-ttl"]) {
    assert.throws(() => buildSyncPayload({ ...syncOptions, [option]: option === "device-hash" ? "b".repeat(64) : "300" }),
      new RegExp(`--${option} is not a sync field`, "u"));
  }
  assert.throws(() => buildSyncPayload({ ...syncOptions, status: "revoked" }), /reason is required/u);
});
