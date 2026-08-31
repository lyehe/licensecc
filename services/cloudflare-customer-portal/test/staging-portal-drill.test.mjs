import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CookieJar,
  runStagingPortalDrill,
  splitSetCookieHeader,
  validateOptions,
} from "../scripts/staging-portal-drill.mjs";

test("portal static assets carry a restrictive browser security policy", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /Content-Security-Policy: default-src 'none'/u);
  assert.match(headers, /script-src 'self'/u);
  assert.match(headers, /frame-ancestors 'none'/u);
  assert.match(headers, /X-Frame-Options: DENY/u);
  assert.match(headers, /X-Content-Type-Options: nosniff/u);
  assert.doesNotMatch(headers, /unsafe-inline|unsafe-eval/iu);
});

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeFetch(calls) {
  return async (url, init = {}) => {
    const requestUrl = new URL(String(url));
    const path = requestUrl.pathname;
    const headers = new Headers(init.headers ?? {});
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ path, method: init.method ?? "GET", headers, body });

    if (path === "/") {
      return new Response("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    if (path === "/health") {
      return json({ ok: true, code: "healthy", data: { account_token_mode_required: true } });
    }
    if (path === "/portal/v1/admin/bootstrap-otp") {
      assert.equal(headers.get("authorization"), "Bearer break-glass");
      assert.equal(headers.get("cf-access-jwt-assertion"), "access-jwt");
      assert.equal(body.email, "customer@example.com");
      return json({ ok: true, code: "bootstrap_otp", data: { secret: "bootstrap-secret" } });
    }
    if (path === "/portal/v1/auth/magic-redeem") {
      assert.equal(body.token, "bootstrap-secret");
      return json(
        { ok: true, code: "signed_in", data: { customer_id: "cust_1" } },
        200,
        { "set-cookie": "lccp_session=lccp_from_bootstrap; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400" },
      );
    }
    if (path === "/portal/v1/auth/verify") {
      assert.equal(body.email, "customer@example.com");
      assert.equal(body.code, "123456");
      return json(
        { ok: true, code: "signed_in", data: { customer_id: "cust_1" } },
        200,
        { "set-cookie": "lccp_session=lccp_from_otp; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400" },
      );
    }
    if (path === "/portal/v1/auth/logout") {
      return json({ ok: true, code: "logged_out" }, 200, { "set-cookie": "lccp_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" });
    }

    if (path === "/api/portal/me" && !/lccp_session=/u.test(headers.get("cookie") ?? "")) {
      return json({ ok: false, code: "unauthorized" }, 401);
    }
    assert.match(headers.get("cookie") ?? "", /lccp_session=/);
    if (path === "/api/portal/me") {
      return json({ ok: true, code: "me", data: { customer_id: "cust_1" } });
    }
    if (path === "/api/portal/entitlements") {
      return json({
        ok: true,
        code: "entitlements",
        data: {
          items: [
            { id: "ent_node", license_mode: "node_locked" },
            { id: "ent_float", license_mode: "floating" },
          ],
        },
      });
    }
    if (path === "/api/portal/devices") {
      return json({ ok: true, code: "devices", data: { items: [] } });
    }
    if (path === "/api/portal/usage") {
      return json({ ok: true, code: "usage", data: { items: [{ event_type: "checkout", count: 1 }] } });
    }
    if (path === "/api/portal/checkout") {
      assert.equal(body.entitlement_id, "ent_float");
      return json({ ok: true, code: "checkout_ok", data: { seat_id: "seat_1" } });
    }
    if (path === "/api/portal/heartbeat") {
      assert.equal(body.seat_id, "seat_1");
      return json({ ok: true, code: "heartbeat_ok", data: {} });
    }
    if (path === "/api/portal/release") {
      assert.equal(body.seat_id, "seat_1");
      return json({ ok: true, code: "release_ok", data: {} });
    }
    if (path === "/api/portal/download") {
      assert.equal(body.entitlement_id, "ent_node");
      return new Response("SIGNED-LIC-BYTES", {
        status: 200,
        headers: { "content-type": "text/plain", "content-disposition": "attachment; filename=\"license.lic\"" },
      });
    }
    throw new Error(`unexpected request: ${path}`);
  };
}

test("portal staging drill validates skip and partial configuration", () => {
  assert.deepEqual(validateOptions({}), {
    skipped: true,
    reason: "staging portal drill environment is not configured",
  });
  assert.throws(() => validateOptions({ STAGING_PORTAL_BASE_URL: "https://portal.example" }), /configure STAGING_PORTAL_SESSION_COOKIE/);
});

test("portal staging drill supports bootstrap auth and optional seat/download checks", async () => {
  const calls = [];
  const result = await runStagingPortalDrill(validateOptions({
    STAGING_PORTAL_BASE_URL: "https://portal.example",
    STAGING_PORTAL_EMAIL: "customer@example.com",
    STAGING_PORTAL_BOOTSTRAP_BEARER: "break-glass",
    STAGING_PORTAL_ACCESS_JWT: "access-jwt",
    STAGING_PORTAL_ALLOW_SEAT_MUTATION: "1",
    STAGING_PORTAL_ALLOW_DOWNLOAD: "1",
    STAGING_PORTAL_DOWNLOAD_ENTITLEMENT_ID: "ent_node",
    STAGING_PORTAL_DEVICE_KEY_ID: "device_1",
  }), { fetchFn: makeFetch(calls) });

  assert.equal(result.ok, true);
  assert.equal(result.auth_mode, "bootstrap_bearer");
  assert.equal(result.ui_status, 200);
  assert.equal(result.unauthenticated_status, 401);
  assert.equal(result.session_cookie_policy_checked, true);
  assert.equal(result.post_logout_status, 401);
  assert.equal(result.customer_id_present, true);
  assert.equal(result.entitlement_count, 2);
  assert.equal(result.seat_cycle.enabled, true);
  assert.equal(result.download.enabled, true);
  assert.equal(result.logout_performed, true);
  assert.deepEqual(calls.map((call) => call.path), [
    "/",
    "/health",
    "/api/portal/me",
    "/portal/v1/admin/bootstrap-otp",
    "/portal/v1/auth/magic-redeem",
    "/api/portal/me",
    "/api/portal/entitlements",
    "/api/portal/devices",
    "/api/portal/usage",
    "/api/portal/checkout",
    "/api/portal/heartbeat",
    "/api/portal/release",
    "/api/portal/download",
    "/portal/v1/auth/logout",
    "/api/portal/me",
  ]);
});

test("portal staging drill accepts an existing session cookie without logging it out", async () => {
  const calls = [];
  const result = await runStagingPortalDrill(validateOptions({
    LICENSECC_PORTAL_URL: "https://portal.example",
    LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=lccp_existing; Path=/; HttpOnly",
  }), { fetchFn: makeFetch(calls), cookieJar: new CookieJar() });

  assert.equal(result.auth_mode, "session_cookie");
  assert.equal(result.unauthenticated_status, 401);
  assert.equal(result.session_cookie_policy_checked, false);
  assert.equal(result.post_logout_status, null);
  assert.equal(result.seat_cycle.enabled, false);
  assert.equal(result.download.enabled, false);
  assert.equal(result.logout_performed, false);
  assert.equal(calls.some((call) => call.path === "/portal/v1/auth/logout"), false);
});

test("portal staging drill rejects an insecure session cookie policy", async () => {
  const calls = [];
  const fallback = makeFetch(calls);
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === "/portal/v1/auth/magic-redeem") {
      return json(
        { ok: true, code: "signed_in", data: { customer_id: "cust_1" } },
        200,
        { "set-cookie": "lccp_session=insecure; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" },
      );
    }
    return fallback(url, init);
  };

  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      STAGING_PORTAL_BASE_URL: "https://portal.example",
      STAGING_PORTAL_EMAIL: "customer@example.com",
      STAGING_PORTAL_BOOTSTRAP_BEARER: "break-glass",
      STAGING_PORTAL_ACCESS_JWT: "access-jwt",
    }), { fetchFn }),
    /did not issue the required secure session cookie policy/u,
  );
});

test("cookie helpers keep only cookie pairs and split combined Set-Cookie headers", () => {
  assert.deepEqual(splitSetCookieHeader("a=1; Path=/, b=2; Path=/"), ["a=1; Path=/", " b=2; Path=/"]);
  const jar = new CookieJar();
  jar.add("a=1; Path=/; HttpOnly");
  jar.add("b=2; Path=/");
  assert.equal(jar.header(), "a=1; b=2");
});

test("portal drill failure diagnostics do not echo response data", async () => {
  const secret = "customer-license-data-must-not-appear";
  const calls = [];
  const fallback = makeFetch(calls);
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === "/health") {
      return json({ ok: false, code: secret, data: { license: secret } }, 503);
    }
    return fallback(url, init);
  };
  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      LICENSECC_PORTAL_URL: "https://portal.example",
      LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=existing",
    }), { fetchFn }),
    (error) => error instanceof Error
      && /status=503; response_ok=false; envelope_ok=false; code_matches=false/u.test(error.message)
      && !error.message.includes(secret),
  );
});

test("portal drill rejects oversized JSON without retaining or reporting its body", async () => {
  const secret = "oversized-customer-data-must-not-appear";
  const calls = [];
  const fallback = makeFetch(calls);
  const fetchFn = async (url, init) => {
    if (new URL(String(url)).pathname === "/health") {
      return new Response(JSON.stringify({ secret: secret.repeat(20_000) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fallback(url, init);
  };
  await assert.rejects(
    runStagingPortalDrill(validateOptions({
      LICENSECC_PORTAL_URL: "https://portal.example",
      LICENSECC_PORTAL_SESSION_COOKIE: "lccp_session=existing",
    }), { fetchFn }),
    (error) => error instanceof Error
      && /GET \/health exceeded the bounded response limit/u.test(error.message)
      && !error.message.includes(secret),
  );
});
