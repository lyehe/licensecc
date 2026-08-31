import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeEqual, generateAccountToken, hashToken } from "../src/auth/primitives.mjs";
import { loadSecretMap, lookupSecret } from "../src/auth/secret_map.mjs";
import { HTML_NONCE_PLACEHOLDER, safeErrorType, safeString, secureHtml } from "../src/http/kit.mjs";

const RUNTIME_SUBPATHS = [
  "@licensecc/cloudflare-runtime/d1/audit_digest",
  "@licensecc/cloudflare-runtime/auth/account_token_issue",
  "@licensecc/cloudflare-runtime/auth/primitives",
  "@licensecc/cloudflare-runtime/auth/secret_map",
  "@licensecc/cloudflare-runtime/d1/plan_projection",
  "@licensecc/cloudflare-runtime/d1/contract",
  "@licensecc/cloudflare-runtime/d1/entitlement_mutation",
  "@licensecc/cloudflare-runtime/d1/idempotency_store",
  "@licensecc/cloudflare-runtime/entitlements/policy_store",
  "@licensecc/cloudflare-runtime/http/kit",
  "@licensecc/cloudflare-runtime/lease/metering",
  "@licensecc/cloudflare-runtime/lease/seat_reclaim",
  "@licensecc/cloudflare-runtime/lease/trial_store",
  "@licensecc/cloudflare-runtime/webhooks/webhook",
];

test("every explicit runtime export resolves without a service import", async () => {
  const modules = await Promise.all(RUNTIME_SUBPATHS.map((subpath) => import(subpath)));
  assert.equal(modules.length, RUNTIME_SUBPATHS.length);
});

test("runtime auth primitives are stateless and fail closed", async () => {
  const raw = new Uint8Array(32).fill(9);
  const map = loadSecretMap(JSON.stringify({ k1: btoa(String.fromCharCode(...raw)) }));
  assert.equal(lookupSecret(map, "k1")?.length, 32);
  assert.equal(loadSecretMap("{}"), null);
  const token = generateAccountToken();
  assert.match(token.raw, /^lcca_[A-Za-z0-9_-]+$/);
  assert.equal(await hashToken(raw, new TextEncoder().encode(token.raw)), await hashToken(raw, new TextEncoder().encode(token.raw)));
  assert.equal(await constantTimeEqual("same", "same"), true);
  assert.equal(await constantTimeEqual("same", "different"), false);
});

test("runtime HTTP helpers keep the existing delimiter guard", () => {
  assert.equal(safeString("safe", 10), "safe");
  assert.equal(safeString("unsafe=value", 20), null);
});

test("runtime error classification is closed against writable exception names", () => {
  assert.equal(safeErrorType(new TypeError("expected detail")), "TypeError");
  assert.equal(safeErrorType("UnknownThrownValue"), "UnknownThrownValue");
  const custom = new Error("provider detail");
  custom.name = "Bearer secret-from-provider";
  assert.equal(safeErrorType(custom), "Error");
  assert.equal(safeErrorType({ name: "TypeError" }), "UnknownThrownValue");
});

test("secure HTML binds its inline blocks to one unpredictable CSP nonce", async () => {
  const template = `<style nonce="${HTML_NONCE_PLACEHOLDER}"></style><script nonce="${HTML_NONCE_PLACEHOLDER}"></script>`;
  const first = secureHtml(template);
  const second = secureHtml(template);
  const firstPolicy = first.headers.get("content-security-policy") ?? "";
  const secondPolicy = second.headers.get("content-security-policy") ?? "";
  const firstNonce = /script-src 'nonce-([^']+)'/u.exec(firstPolicy)?.[1];
  const secondNonce = /script-src 'nonce-([^']+)'/u.exec(secondPolicy)?.[1];
  assert.ok(firstNonce);
  assert.ok(secondNonce);
  assert.notEqual(firstNonce, secondNonce);
  assert.ok(firstPolicy.includes(`style-src 'nonce-${firstNonce}'`));
  assert.equal((await first.text()).split(`nonce="${firstNonce}"`).length - 1, 2);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.equal(first.headers.get("x-frame-options"), "DENY");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  assert.throws(() => secureHtml("<script></script>"), /exactly one style nonce and one script nonce/u);
});
