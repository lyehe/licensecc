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
  normalizePlanProjectionInput,
  planProjectionMatchesDesired,
} from "../src/catalog/plan_projection.mjs";

const DOMAIN_SUBPATHS = [
  "@licensecc/licensing-domain/audit/audit_digest",
  "@licensecc/licensing-domain/catalog/import_preview",
  "@licensecc/licensing-domain/catalog/plan_projection",
  "@licensecc/licensing-domain/entitlements/contracts",
  "@licensecc/licensing-domain/entitlements/policy",
  "@licensecc/licensing-domain/lease/canonical_payload",
  "@licensecc/licensing-domain/lease/trial",
  "@licensecc/licensing-domain/usage/usage_report",
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

test("plan projections treat a persisted cache TTL mismatch as an update without exposing it", () => {
  const desired = {
    input: {
      project: "DEFAULT",
      feature: "CORE",
      license_fingerprint: "f".repeat(64),
      device_hash: "",
      status: "active",
      assertion_ttl_seconds: 300,
      valid_from: null,
      valid_until: null,
      notes: "",
      customer_id: null,
      license_id: "lic_1",
    },
    policy_id: null,
    capacity: { pool_size: 0, max_active_devices: 1, max_borrow_sec: 0, meter_quota: 0, meter_period_sec: 2_592_000 },
    trial: { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0, trial_require_device_proof: 0 },
  };
  const existing = {
    ...desired.input,
    cache_ttl_seconds: 86_400,
    policy_id: null,
    ...desired.capacity,
    ...desired.trial,
  };

  assert.equal(planProjectionMatchesDesired(existing, desired), false);
  assert.equal(planProjectionMatchesDesired({ ...existing, cache_ttl_seconds: 300 }, desired), true);
});

test("plan projection support_until is a safe, bounded epoch second", () => {
  const base = { project: "DEFAULT", license_id: "lic_1", license_fingerprint: "f".repeat(64), plan_key: "basic" };
  assert.equal(normalizePlanProjectionInput({ ...base, support_until: 0 }).support_until, 0);
  assert.equal(normalizePlanProjectionInput({ ...base, support_until: MAX_SUPPORT_UNTIL_EPOCH_SECONDS }).support_until, MAX_SUPPORT_UNTIL_EPOCH_SECONDS);
  for (const support_until of [MAX_SUPPORT_UNTIL_EPOCH_SECONDS + 1, 1e100, 1.5]) {
    assert.throws(() => normalizePlanProjectionInput({ ...base, support_until }), /invalid_support_until/);
  }
});
