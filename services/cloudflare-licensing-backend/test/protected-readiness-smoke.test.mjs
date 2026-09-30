import assert from "node:assert/strict";
import { test } from "node:test";
import { main, parseSmokeArguments, runProtectedReadinessSmoke } from "../scripts/protected-readiness-smoke.mjs";

const ORIGIN = "https://api.licensecc-prod.net";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

const READY = { ok: true, service: "licensecc-online-verifier", protected_device_ready: true };
const NOT_READY = { ok: false, service: "licensecc-online-verifier", protected_device_ready: false };
const DENIED = { ok: false, code: "authorization_unavailable", request_id: "req-1" };

function decodedLength(value) {
  assert.match(value, /^[A-Za-z0-9_-]+$/u, "base64url without padding");
  return Buffer.from(value, "base64url").length;
}

// A fake backend that answers like a deployed protected backend unless told otherwise.
function fakeBackend({ health = () => json(READY), challenge = () => json(DENIED, 404) } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url: url.href, method: init.method ?? "GET", redirect: init.redirect, headers: new Headers(init.headers), body: init.body };
    calls.push(call);
    if (url.pathname === "/health" && call.method === "GET") return health(call);
    if (url.pathname === "/v2/device-challenges" && call.method === "POST") return challenge(call);
    assert.fail(`unexpected request ${call.method} ${url.pathname}`);
  };
  return { calls, fetchImpl };
}

async function runMain(argv, fetchImpl) {
  let output = "";
  const code = await main(argv, { fetchImpl, stdout: { write: (chunk) => { output += chunk; return true; } } });
  return { code, output, evidence: JSON.parse(output) };
}

test("protected smoke passes against a ready backend and prints redacted evidence", async () => {
  const backend = fakeBackend();
  const { code, output, evidence } = await runMain(["--url", ORIGIN], backend.fetchImpl);
  assert.equal(code, 0);
  assert.equal(output.split("\n").filter(Boolean).length, 1, "one JSON evidence line");
  assert.equal(evidence.schema_version, "licensecc.protected-readiness-smoke.v1");
  assert.equal(evidence.status, "succeeded");
  assert.equal(evidence.backend_origin, "<redacted>");
  assert.match(evidence.backend_origin_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(evidence.checks.health, { request_method: "GET", status: 200, protected_device_ready: true });
  assert.deepEqual(evidence.checks.unauthenticated_challenge, { request_method: "POST", status: 404, code: "authorization_unavailable" });

  assert.deepEqual(backend.calls.map((call) => `${call.method} ${call.url}`), [
    `GET ${ORIGIN}/health`,
    `POST ${ORIGIN}/v2/device-challenges`,
  ]);
  for (const call of backend.calls) {
    assert.equal(call.redirect, "manual", "redirects are never followed");
    assert.equal(call.headers.get("authorization"), null, "the smoke carries no credential");
    assert.equal(call.headers.get("cookie"), null);
  }
  const challenge = backend.calls[1];
  assert.equal(challenge.headers.get("content-type"), "application/json");
  const body = JSON.parse(challenge.body);
  assert.deepEqual(Object.keys(body), ["purpose", "attempt_handle", "operation_id"]);
  assert.equal(body.purpose, "exchange");
  assert.equal(decodedLength(body.attempt_handle), 32);
  assert.equal(decodedLength(body.operation_id), 32);
  assert.notEqual(body.attempt_handle, body.operation_id);
  for (const value of [body.attempt_handle, body.operation_id, "licensecc-prod.net", "req-1"]) {
    assert.equal(output.includes(value), false, "evidence never echoes the origin, handles or response bodies");
  }

  const again = fakeBackend();
  await runProtectedReadinessSmoke({ origin: ORIGIN }, { fetchImpl: again.fetchImpl });
  assert.notEqual(JSON.parse(again.calls[1].body).attempt_handle, body.attempt_handle, "every run uses fresh random handles");
});

test("protected smoke fails when health reports protected_device_ready false", async () => {
  const cases = [
    ["503 not ready", () => json(NOT_READY, 503)],
    ["200 not ready", () => json({ ...READY, protected_device_ready: false })],
    ["legacy account-token readiness", () => json({ ok: true, service: "licensecc-online-verifier", account_token_mode: "required" })],
    ["string readiness", () => json({ ...READY, protected_device_ready: "true" })],
    ["wrong service", () => json({ ...READY, service: "other-worker" })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://attacker.test/health" } })],
    ["not JSON", () => new Response("ready", { status: 200, headers: { "content-type": "text/plain" } })],
    ["oversized", () => json({ ...READY, padding: "x".repeat(20_000) })],
  ];
  for (const [label, health] of cases) {
    const backend = fakeBackend({ health });
    const { code, evidence } = await runMain([`--url=${ORIGIN}`], backend.fetchImpl);
    assert.equal(code, 1, label);
    assert.equal(evidence.status, "failed", label);
    assert.equal(evidence.error.check, "health", label);
    assert.deepEqual(backend.calls.map((call) => call.method), ["GET"], `${label}: no challenge after a failed health check`);
    assert.doesNotMatch(JSON.stringify(evidence), /attacker|licensecc-prod|padding|other-worker/u, label);
  }
});

test("protected smoke fails unless an unauthenticated challenge is denied with authorization_unavailable", async () => {
  const cases = [
    ["temporarily unavailable", () => json({ ok: false, code: "temporarily_unavailable", request_id: "r" }, 503)],
    ["challenge issued", () => json({ ok: true, code: "challenge_created", request_id: "r", data: {} })],
    ["other 404", () => json({ ok: false, code: "not_found" }, 404)],
    ["rate limited", () => json({ ok: false, code: "rate_limited", request_id: "r" }, 429)],
  ];
  for (const [label, challenge] of cases) {
    const { code, evidence } = await runMain(["--url", ORIGIN], fakeBackend({ challenge }).fetchImpl);
    assert.equal(code, 1, label);
    assert.equal(evidence.error.check, "unauthenticated_challenge", label);
  }
  const unreachable = await runMain(["--url", ORIGIN], async () => { throw new Error(`connect ${ORIGIN} secret-detail`); });
  assert.equal(unreachable.code, 1);
  assert.deepEqual(unreachable.evidence.error, { code: "REQUEST_FAILED", check: "health" });
  assert.doesNotMatch(unreachable.output, /secret-detail|licensecc-prod/u);
});

test("protected smoke accepts only one canonical HTTPS backend origin", async () => {
  assert.deepEqual(parseSmokeArguments(["--url", ORIGIN]), { origin: ORIGIN });
  assert.deepEqual(parseSmokeArguments([`--url=${ORIGIN}/`]), { origin: ORIGIN });
  for (const argv of [
    [],
    ["--url"],
    ["--url", "http://api.licensecc-prod.net"],
    ["--url", "https://user:pass@api.licensecc-prod.net"],
    ["--url", "https://api.licensecc-prod.net:8443"],
    ["--url", "https://api.licensecc-prod.net/v2"],
    ["--url", "https://api.licensecc-prod.net/?x=1"],
    ["--url", "not a url"],
    ["--url", ORIGIN, "--extra"],
  ]) {
    assert.throws(() => parseSmokeArguments(argv), /usage/u, JSON.stringify(argv));
    const { code, evidence } = await runMain(argv, async () => assert.fail("no request before valid arguments"));
    assert.equal(code, 2, JSON.stringify(argv));
    assert.deepEqual(evidence.error, { code: "INVALID_ARGUMENTS" });
  }
});
