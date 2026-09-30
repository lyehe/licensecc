import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeEntitlementId,
  entitlementId,
  withId,
} from "../src/entitlements/contracts.mjs";
import { policyCapacityViolation, stampFromPolicy } from "../src/entitlements/policy.mjs";
import { canonicalEntitlementEvent, computeSegmentDigest } from "../src/audit/audit_digest.mjs";
import {
  catalogImportManifestDigest,
  catalogImportManifestSnapshot,
  isCatalogImportPreviewId,
} from "../src/catalog/import_preview.mjs";
import { summarizeUsage } from "../src/usage/usage_report.mjs";
import {
  MAX_SUPPORT_UNTIL_EPOCH_SECONDS,
  desiredPlanProjectionRow,
  normalizePlanProjectionInput,
  planProjectionMatchesDesired,
} from "../src/catalog/plan_projection.mjs";
import { KNOWN_INTENTS, ORDER_INTENTS } from "../src/orders/intents.mjs";

const DOMAIN_SUBPATHS = [
  "@licensecc/licensing-domain/audit/audit_digest",
  "@licensecc/licensing-domain/catalog/import_preview",
  "@licensecc/licensing-domain/catalog/plan_projection",
  "@licensecc/licensing-domain/entitlements/contracts",
  "@licensecc/licensing-domain/entitlements/policy",
  "@licensecc/licensing-domain/lease/canonical_payload",
  "@licensecc/licensing-domain/lease/trial",
  "@licensecc/licensing-domain/usage/usage_report",
  "@licensecc/licensing-domain/orders/intents",
];

test("every explicit domain export resolves without Worker bindings", async () => {
  const modules = await Promise.all(DOMAIN_SUBPATHS.map((subpath) => import(subpath)));
  assert.equal(modules.length, DOMAIN_SUBPATHS.length);
});

test("entitlement value contract is stable without a Worker binding", () => {
  const id = entitlementId("project", "FEATURE", "fingerprint");
  assert.deepEqual(decodeEntitlementId(id), { project: "project", feature: "FEATURE", license_fingerprint: "fingerprint" });
  assert.equal(withId({ project: "project", feature: "FEATURE", license_fingerprint: "fingerprint", pool_size: 2, cache_ttl_seconds: 30 }).license_mode, "floating");
});

test("policy stamps retain capacity invariants and pure output", () => {
  assert.equal(policyCapacityViolation("floating", 0), "floating_requires_pool");
  const stamped = stampFromPolicy({
    type: "trial", trial_expiration_basis: "from_issue", expiry_strategy: "fixed_window", trial_duration_sec: 60,
    valid_from_offset_sec: null, duration_sec: null, assertion_ttl_seconds: 300, pool_size: 0,
    max_active_devices: 1, max_borrow_sec: 0, meter_quota: 0, meter_period_sec: 2592000,
    trial_one_per_device: 0, trial_require_device_proof: 0,
  }, { project: "p", feature: "F", license_fingerprint: "fp" }, 100);
  assert.equal(stamped.input.valid_until, 160);
});

test("usage and audit cores are deterministic without D1", async () => {
  assert.equal(summarizeUsage([{ event_type: "checkout", ts: 1, seat_id: "s", device_key_id: "d" }]).peak_concurrent, 1);
  const event = canonicalEntitlementEvent({ id: 1, created_at: 2, project: "p", feature: "F", license_fingerprint: "fp", event_type: "create", status: "active", revocation_seq: 1 });
  assert.equal(await computeSegmentDigest("", [event]), await computeSegmentDigest("", [event]));
});

test("catalog import preview values have a stable opaque grammar and canonical digest", async () => {
  const unordered = {
    features: [
      { project: "DEFAULT", feature_key: "zeta", name: "Zeta" },
      { project: "DEFAULT", feature_key: "alpha", name: "Alpha" },
    ],
    plans: [],
  };
  const ordered = {
    format_version: 1,
    features: [
      { project: "DEFAULT", feature_key: "alpha", name: "Alpha", description: "", category: "", status: "active" },
      { project: "DEFAULT", feature_key: "zeta", name: "Zeta", description: "", category: "", status: "active" },
    ],
    plans: [],
  };
  assert.equal(catalogImportManifestSnapshot(unordered), catalogImportManifestSnapshot(ordered));
  assert.equal(await catalogImportManifestDigest(unordered), await catalogImportManifestDigest(ordered));
  assert.equal(isCatalogImportPreviewId("civ_server_bound"), true);
  assert.equal(isCatalogImportPreviewId("civ_not=safe"), false);
});

test("a plan-projected grant takes only its device limit from the catalog, and a change is judged on what apply writes", () => {
  const input = normalizePlanProjectionInput({ project: "DEFAULT", license_id: "lic_1", license_fingerprint: "f".repeat(64), plan_key: "basic" });
  // A catalog row that still carries seat, borrow, meter and TTL overrides.
  const desired = desiredPlanProjectionRow({
    feature_key: "CORE", feature_inclusion: "included", addon_key: null, feature_name: "Core", policy_id_resolved: null,
    assertion_ttl_seconds: 600, pool_size: 5, max_active_devices: 3, max_borrow_sec: 60, meter_quota: 10, meter_period_sec: 3600,
  }, input, 100);
  assert.deepEqual(desired.capacity, { max_active_devices: 3 });
  assert.equal("device_hash" in desired.input, false);
  assert.equal("assertion_ttl_seconds" in desired.input, false);
  const existing = {
    ...desired.input,
    policy_id: null,
    ...desired.capacity,
    ...desired.trial,
    // Columns plan apply never writes: a grant keeps its own values, so they never make a change.
    device_hash: "",
    assertion_ttl_seconds: 900,
    cache_ttl_seconds: 86_400,
    pool_size: 0,
    max_borrow_sec: 0,
    meter_quota: 0,
    meter_period_sec: 2_592_000,
  };

  assert.equal(planProjectionMatchesDesired(existing, desired), true);
  assert.equal(planProjectionMatchesDesired({ ...existing, max_active_devices: 1 }, desired), false);
});

test("plan projection support_until is a safe, bounded epoch second", () => {
  const base = { project: "DEFAULT", license_id: "lic_1", license_fingerprint: "f".repeat(64), plan_key: "basic" };
  assert.equal(normalizePlanProjectionInput({ ...base, support_until: 0 }).support_until, 0);
  assert.equal(normalizePlanProjectionInput({ ...base, support_until: MAX_SUPPORT_UNTIL_EPOCH_SECONDS }).support_until, MAX_SUPPORT_UNTIL_EPOCH_SECONDS);
  for (const support_until of [MAX_SUPPORT_UNTIL_EPOCH_SECONDS + 1, 1e100, 1.5]) {
    assert.throws(() => normalizePlanProjectionInput({ ...base, support_until }), /invalid_support_until/);
  }
});

test("order intents form a frozen closed set backing KNOWN_INTENTS", () => {
  assert.ok(Object.isFrozen(ORDER_INTENTS));
  assert.equal(KNOWN_INTENTS.size, ORDER_INTENTS.length);
  for (const intent of ORDER_INTENTS) {
    assert.equal(KNOWN_INTENTS.has(intent), true);
  }
  assert.equal(KNOWN_INTENTS.has("subscription.active"), true);
  assert.equal(KNOWN_INTENTS.has("not_a_real_intent"), false);
});
