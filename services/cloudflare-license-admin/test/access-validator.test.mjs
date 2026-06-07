import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  accessHeaders,
  entitlementPayload,
  parseArgs,
  runAccessAdminValidation,
  validateOptions,
} from "../scripts/validate-access-admin.mjs";
import {
  extractJwt,
  parseArgs as parseDrillArgs,
  readAccessJwt,
  validateDrillOptions,
} from "../scripts/access-admin-drill.mjs";

const fingerprint = "b".repeat(64);

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

function mockAdminHandler() {
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
    if (request.method === "GET" && url.pathname === "/api/admin/summary") {
      json(response, 200, { ok: true, code: "summary", data: { entitlements: { total: row === null ? 0 : 1 } } });
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
      row = { ...row, status: "revoked", revocation_seq: 2 };
      json(response, 200, { ok: true, code: "entitlement_revoked", data: row });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/admin/entitlements/scratch-id/reenable") {
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
  });
  assert.equal(payload.status, "active");
  assert.equal(payload.license_fingerprint, fingerprint);
  assert.equal(payload.customer_id, "access-validator");
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
    ["cloudflared", ["access", "login", "--quiet", "--auto-close", "--app", "https://admin.example/"]],
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
  await withServer(mockAdminHandler(), async (baseUrl) => {
    const summary = await runAccessAdminValidation({
      baseUrl: new URL(baseUrl),
      accessJwt: "admin-token",
      nonAdminAccessJwt: "reader-token",
      project: "DEFAULT",
      feature: "DEFAULT",
      fingerprint,
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.created_revocation_seq, 1);
    assert.equal(summary.replay_revocation_seq, 1);
    assert.equal(summary.revoked_revocation_seq, 2);
    assert.equal(summary.unauthenticated_status, 401);
    assert.equal(summary.malformed_status, 403);
    assert.equal(summary.non_admin_status, 403);
    assert.equal(summary.final_status, "revoked");
  });
});
