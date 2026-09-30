import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeEntitlementId,
  entitlementId,
  withId,
} from "../src/entitlements/contracts.mjs";
import { POLICY_TYPES, stampFromPolicy } from "../src/entitlements/policy.mjs";
import { canonicalEntitlementEvent, computeSegmentDigest } from "../src/audit/audit_digest.mjs";
import {
  catalogImportManifestDigest,
  catalogImportManifestSnapshot,
  isCatalogImportPreviewId,
} from "../src/catalog/import_preview.mjs";
import {
  MAX_SUPPORT_UNTIL_EPOCH_SECONDS,
  classifyPlanProjection,
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
  "@licensecc/licensing-domain/orders/intents",
];

test("every explicit domain export resolves without Worker bindings", async () => {
  const modules = await Promise.all(DOMAIN_SUBPATHS.map((subpath) => import(subpath)));
  assert.equal(modules.length, DOMAIN_SUBPATHS.length);
});

test("entitlement value contract is stable without a Worker binding", () => {
  const id = entitlementId("project", "FEATURE", "fingerprint");
  assert.deepEqual(decodeEntitlementId(id), { project: "project", feature: "FEATURE", license_fingerprint: "fingerprint" });
  // A grant is protected: a trial or node-locked.
  assert.equal(withId({ project: "project", feature: "FEATURE", license_fingerprint: "fingerprint", is_trial: 0 }).license_mode, "node_locked");
  assert.equal(withId({ project: "project", feature: "FEATURE", license_fingerprint: "fingerprint", is_trial: 1 }).license_mode, "trial");
});

test("policies are trial, node-locked or subscription, and a stamp is pure and carries only a device limit", () => {
  assert.deepEqual([...POLICY_TYPES], ["trial", "node_locked", "subscription"]);
  const stamped = stampFromPolicy({
    type: "trial", trial_expiration_basis: "from_issue", expiry_strategy: "fixed_window", trial_duration_sec: 60,
    valid_from_offset_sec: null, duration_sec: null, max_active_devices: 2,
    trial_one_per_device: 0,
  }, { project: "p", feature: "F", license_fingerprint: "fp" }, 100);
  assert.equal(stamped.input.valid_until, 160);
  assert.deepEqual(stamped.capacity, { max_active_devices: 2 });
  assert.deepEqual(stamped.trial, { is_trial: 1, trial_expiration_basis: "from_issue", trial_duration_sec: 60, trial_one_per_device: 0 });
  assert.deepEqual(Object.keys(stamped.input).sort(), ["customer_id", "feature", "license_fingerprint", "license_id", "notes", "project", "status", "valid_from", "valid_until"]);
});

test("the audit digest core is deterministic without D1", async () => {
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
  // A catalog row names only its device limit.
  const desired = desiredPlanProjectionRow({
    feature_key: "CORE", feature_inclusion: "included", addon_key: null, feature_name: "Core", policy_id_resolved: null,
    max_active_devices: 3,
  }, input, 100);
  assert.deepEqual(desired.capacity, { max_active_devices: 3 });
  assert.deepEqual(Object.keys(desired.input).sort(), ["customer_id", "feature", "license_fingerprint", "license_id", "notes", "project", "status", "valid_from", "valid_until"]);
  assert.deepEqual(desired.trial, { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0 });
  const existing = {
    ...desired.input,
    policy_id: null,
    ...desired.capacity,
    ...desired.trial,
    // Columns plan apply never writes: a grant keeps its own values, so they never make a change.
    revocation_seq: 7,
    lease_seconds: 86_400,
    trial_started_at: null,
    trial_device_key_id: null,
  };

  assert.equal(planProjectionMatchesDesired(existing, desired), true);
  assert.equal(planProjectionMatchesDesired({ ...existing, max_active_devices: 1 }, desired), false);
});

// Every grant has an owner, so a projection without one cannot write any grant: its preview blocks
// each one it would create or update with the reason owner_required, as Apply refuses it. A revoked
// grant keeps its own reason.
test("a plan projection without an owner blocks every grant it would write", () => {
  const plan = { id: "plan_basic", plan_key: "basic" };
  const row = (feature) => ({ feature_key: feature, feature_inclusion: "included", addon_key: null, feature_name: feature, policy_id_resolved: null, max_active_devices: 1 });
  const base = { project: "DEFAULT", license_id: "lic_1", license_fingerprint: "f".repeat(64), plan_key: "basic" };
  const existing = (feature, status, customer_id) => ({ project: "DEFAULT", feature, license_fingerprint: "f".repeat(64), status, customer_id,
    policy_id: null, source: "included", is_trial: 0, max_active_devices: 1, valid_from: null, valid_until: null });
  for (const customer_id of [undefined, null, "  "]) {
    const input = normalizePlanProjectionInput({ ...base, customer_id });
    const desired = ["CORE", "EXTRA", "GONE"].map((feature) => desiredPlanProjectionRow(row(feature), input, 100));
    const preview = classifyPlanProjection({ input, plan, desired, existingRows: [existing("EXTRA", "active", "cus_1"), existing("GONE", "revoked", "cus_1")] });
    assert.deepEqual(preview.blocked.map((item) => [item.feature, item.reason]), [["CORE", "owner_required"], ["EXTRA", "owner_required"], ["GONE", "revoked_entitlement"]]);
    assert.deepEqual([preview.will_create, preview.will_update, preview.unchanged], [[], [], []]);
    assert.equal(preview.summary.blocked, 3);
  }
  const owned = classifyPlanProjection({ input: normalizePlanProjectionInput({ ...base, customer_id: "cus_1" }), plan,
    desired: [desiredPlanProjectionRow(row("CORE"), normalizePlanProjectionInput({ ...base, customer_id: "cus_1" }), 100)], existingRows: [] });
  assert.deepEqual([owned.will_create.map((item) => item.feature), owned.blocked], [["CORE"], []]);
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
