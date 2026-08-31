import assert from "node:assert/strict";
import test from "node:test";

import {
  SafeRollbackHealthError,
  checkWorkerRollbackHealth,
  parseRollbackHealthArguments,
  safeRollbackHealthFailureEvidence,
} from "./check-worker-rollback-health.mjs";

const commitSha = "0123456789abcdef0123456789abcdef01234567";
const accessJwt = "header.payload.signature";
const serviceOrigins = Object.freeze({
  backend: "https://backend.licensecc.net",
  admin: "https://admin.licensecc.net",
  portal: "https://portal.licensecc.net",
  backup: "https://backup.licensecc.net",
});

function argumentsFor(overrides = {}) {
  const values = { environment: "production", ...serviceOrigins, ...overrides };
  return [
    "--environment", values.environment,
    "--backend-url", values.backend,
    "--admin-url", values.admin,
    "--portal-url", values.portal,
    "--backup-url", values.backup,
  ];
}

function optionsFor(argumentOverrides = {}, environmentOverrides = {}) {
  return parseRollbackHealthArguments(argumentsFor(argumentOverrides), {
    GITHUB_SHA: commitSha,
    LICENSECC_ACCESS_JWT: accessJwt,
    ...environmentOverrides,
  });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function openApi(secret) {
  return {
    openapi: "3.1.0",
    info: { title: "Licensecc", version: "0.1.0-rc.1" },
    paths: { "/health": { get: { responses: { "200": { description: "ok" } } } } },
    "x-private-test-value": secret,
  };
}

function successfulFetch({ calls = [], secret = "body-value-must-not-appear" } = {}) {
  return async (url, init) => {
    calls.push({ url: url.toString(), init });
    if (url.pathname === "/openapi.json") return json(openApi(secret));
    if (url.hostname === "backend.licensecc.net" && url.pathname === "/health") {
      return json({ ok: true, service: "licensecc-online-verifier", account_token_mode: "required", internal: secret });
    }
    if (url.hostname === "admin.licensecc.net" && url.pathname === "/api/admin/summary") {
      return json({ ok: true, code: "summary", data: { internal: secret } });
    }
    if (url.hostname === "portal.licensecc.net" && url.pathname === "/health") {
      return json({ ok: true, code: "healthy", data: { account_token_mode_required: true, internal: secret } });
    }
    if (url.hostname === "backup.licensecc.net" && url.pathname === "/health") {
      return json({ ok: true, code: "backup_ready", database_name: secret, backup_prefix: secret });
    }
    assert.fail(`unexpected request: ${url}`);
  };
}

test("post-rollback readiness uses GET-only bounded contracts and emits redacted evidence", async () => {
  const calls = [];
  const privateBodyValue = "private-body-value";
  const evidence = await checkWorkerRollbackHealth(optionsFor(), {
    fetchImpl: successfulFetch({ calls, secret: privateBodyValue }),
    now: (() => {
      const values = [1_000, 1_075];
      return () => values.shift();
    })(),
  });

  assert.equal(evidence.status, "succeeded");
  assert.equal(evidence.storage_action, "none");
  assert.equal(evidence.exact_commit_sha, commitSha);
  assert.equal(evidence.elapsed_ms, 75);
  assert.deepEqual(Object.keys(evidence.services), ["backend", "admin", "portal", "backup"]);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.accept, "application/json");
    assert.equal(call.init.body, undefined);
  }

  const adminCalls = calls.filter((call) => new URL(call.url).hostname === "admin.licensecc.net");
  assert.equal(adminCalls.length, 2);
  for (const call of adminCalls) {
    assert.equal(call.init.headers["cf-access-jwt-assertion"], accessJwt);
    assert.equal(call.init.headers.cookie, `CF_Authorization=${accessJwt}`);
  }
  for (const call of calls.filter((call) => !adminCalls.includes(call))) {
    assert.equal(call.init.headers["cf-access-jwt-assertion"], undefined);
    assert.equal(call.init.headers.cookie, undefined);
  }

  assert.equal(evidence.services.backend.health.code, "backend_ready");
  assert.equal(evidence.services.admin.health.code, "summary");
  assert.equal(evidence.services.portal.health.code, "healthy");
  assert.equal(evidence.services.backup.health.code, "backup_ready");
  assert.equal(evidence.services.backup.contract.code, "backup_ready_envelope");
  assert.equal(evidence.services.backend.contract.code, "openapi_3_1");
  assert.equal(evidence.services.backend.contract.path_count, 1);
  for (const service of Object.values(evidence.services)) {
    assert.equal(service.canonical_origin, "<redacted>");
    assert.match(service.canonical_origin_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(service.health.request_method, "GET");
    assert.equal(service.health.redirect_policy, "reject");
    assert.match(service.health.response_sha256, /^[0-9a-f]{64}$/u);
  }

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /licensecc\.net|header\.payload|private-body-value|database_name|backup_prefix/u);
});

test("arguments require four distinct canonical HTTPS origins, exact commit identity, and an environment-only admin credential", () => {
  assert.equal(optionsFor({ environment: "staging" }).environment, "staging");
  for (const backend of [
    "http://backend.licensecc.net",
    "https://user@backend.licensecc.net",
    "https://backend.licensecc.net:8443",
    "https://backend.licensecc.net/path",
    "https://backend.licensecc.net?query=1",
    "https://backend.example.com",
    " https://backend.licensecc.net",
  ]) {
    assert.throws(
      () => optionsFor({ backend }),
      (error) => error instanceof SafeRollbackHealthError && error.code === "INVALID_CANONICAL_ORIGIN" && error.service === "backend",
    );
  }
  assert.throws(
    () => optionsFor({ admin: serviceOrigins.backend }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "DUPLICATE_SERVICE_ORIGIN",
  );
  assert.throws(
    () => parseRollbackHealthArguments([...argumentsFor(), "--unknown", "value"], { GITHUB_SHA: commitSha, LICENSECC_ACCESS_JWT: accessJwt }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "UNKNOWN_ARGUMENT",
  );
  assert.throws(
    () => optionsFor({}, { GITHUB_SHA: "not-a-commit" }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "INVALID_COMMIT_IDENTITY",
  );
  assert.throws(
    () => optionsFor({}, { LICENSECC_ACCESS_JWT: "" }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "MISSING_ADMIN_ACCESS_CREDENTIAL",
  );
});

test("a failed or oversized probe fails closed with only completed, redacted evidence", async () => {
  const rawFailure = "https://portal.licensecc.net/?token=raw-secret";
  const options = optionsFor();
  const baseFetch = successfulFetch();
  const fetchImpl = async (url, init) => {
    if (url.hostname === "portal.licensecc.net" && url.pathname === "/health") {
      throw new Error(rawFailure);
    }
    return baseFetch(url, init);
  };

  let failure;
  await assert.rejects(
    checkWorkerRollbackHealth(options, { fetchImpl, now: (() => { const times = [2_000, 2_050]; return () => times.shift(); })() }),
    (error) => {
      failure = error;
      return error instanceof SafeRollbackHealthError && error.code === "REQUEST_FAILED";
    },
  );
  const evidence = safeRollbackHealthFailureEvidence(failure);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.storage_action, "none");
  assert.deepEqual(Object.keys(evidence.services), ["backend", "admin"]);
  assert.deepEqual(evidence.error, { code: "REQUEST_FAILED", service: "portal", check: "health" });
  assert.doesNotMatch(JSON.stringify(evidence), /raw-secret|licensecc\.net|header\.payload/u);

  const oversizedFetch = async (url, init) => {
    if (url.hostname === "backend.licensecc.net" && url.pathname === "/health") {
      return json({ ok: true }, 200, { "content-length": String(healthBodyLimitForTest()) });
    }
    return baseFetch(url, init);
  };
  await assert.rejects(
    checkWorkerRollbackHealth(options, { fetchImpl: oversizedFetch }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "RESPONSE_TOO_LARGE" && error.service === "backend",
  );
});

function healthBodyLimitForTest() {
  return 16 * 1024 + 1;
}

test("malformed readiness and OpenAPI responses are terminal and generic failure evidence never reflects raw errors", async () => {
  const badHealth = async (url, init) => {
    if (url.hostname === "backup.licensecc.net" && url.pathname === "/health") {
      return json({ ok: true, code: "wrong", secret: "do-not-reflect" });
    }
    return successfulFetch()(url, init);
  };
  await assert.rejects(
    checkWorkerRollbackHealth(optionsFor(), { fetchImpl: badHealth }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "READINESS_CONTRACT_FAILED" && error.service === "backup",
  );

  const badContract = async (url, init) => {
    if (url.hostname === "admin.licensecc.net" && url.pathname === "/openapi.json") {
      return json({ openapi: "3.0.0", info: { version: "private" }, paths: {} });
    }
    return successfulFetch()(url, init);
  };
  await assert.rejects(
    checkWorkerRollbackHealth(optionsFor(), { fetchImpl: badContract }),
    (error) => error instanceof SafeRollbackHealthError && error.code === "OPENAPI_CONTRACT_FAILED" && error.service === "admin",
  );

  const generic = safeRollbackHealthFailureEvidence(new Error("raw secret and URL"));
  assert.deepEqual(generic.error, { code: "UNEXPECTED_FAILURE" });
  assert.doesNotMatch(JSON.stringify(generic), /raw secret|URL/u);
});
