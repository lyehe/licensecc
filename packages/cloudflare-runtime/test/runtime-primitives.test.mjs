import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeEqual, generateAccountToken, hashToken } from "../src/auth/primitives.mjs";
import { loadSecretMap, lookupSecret } from "../src/auth/secret_map.mjs";
import { safeString } from "../src/http/kit.mjs";

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
