import { stampFromPolicy } from "../entitlements/policy.mjs";

const DEFAULT_CAPACITY = Object.freeze({
  pool_size: 0,
  max_active_devices: 1,
  max_borrow_sec: 0,
  meter_quota: 0,
  meter_period_sec: 2592000,
});

const ZERO_TRIAL = Object.freeze({
  is_trial: 0,
  trial_expiration_basis: null,
  trial_duration_sec: 0,
  trial_one_per_device: 0,
  trial_require_device_proof: 0,
});

// Apply accepts an opaque server capability, never a client-selected form
// payload. Keep this grammar shared by runtime, admin validation, UI, and the
// OpenAPI contract: no whitespace, `=`, or line breaks can enter any layer.
export const PLAN_PROJECTION_PREVIEW_ID_PATTERN = /^ppv_[A-Za-z0-9_-]{1,124}$/;

// 9999-12-31T23:59:59Z. This is safely representable by JavaScript and the
// INTEGER/BIGINT storage used by the D1 and PostgreSQL schema ports, while
// keeping an externally supplied support window within a practical epoch.
export const MAX_SUPPORT_UNTIL_EPOCH_SECONDS = 253_402_300_799;

export function isPlanProjectionPreviewId(value) {
  return typeof value === "string" && PLAN_PROJECTION_PREVIEW_ID_PATTERN.test(value);
}

function requiredString(input, field) {
  const value = input?.[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`invalid_${field}`);
  return value.trim();
}

function optionalString(input, field) {
  const value = input?.[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid_${field}`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalInteger(input, field, maximum = Number.MAX_SAFE_INTEGER) {
  const value = input?.[field];
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`invalid_${field}`);
  return value;
}

function rowInteger(row, field) {
  const value = row?.[field];
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeAddons(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("invalid_addons");
  const seen = new Set();
  const addons = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("invalid_addons");
    const trimmed = item.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      addons.push(trimmed);
    }
  }
  return addons;
}

export function normalizePlanProjectionInput(input) {
  const project = requiredString(input, "project");
  const licenseId = requiredString(input, "license_id");
  const licenseFingerprint = requiredString(input, "license_fingerprint");
  const planId = optionalString(input, "plan_id");
  const planKey = optionalString(input, "plan_key");
  if (planId === null && planKey === null) throw new Error("invalid_plan");
  return {
    project,
    license_id: licenseId,
    license_fingerprint: licenseFingerprint,
    customer_id: optionalString(input, "customer_id"),
    plan_id: planId,
    plan_key: planKey,
    support_until: optionalInteger(input, "support_until", MAX_SUPPORT_UNTIL_EPOCH_SECONDS),
    support_until_provided: Object.prototype.hasOwnProperty.call(input ?? {}, "support_until"),
    addons: normalizeAddons(input?.addons),
    notes: optionalString(input, "notes") ?? "",
  };
}

function policyFromCatalogRow(row) {
  if (row.policy_id_resolved === null) return null;
  return {
    id: row.policy_id_resolved,
    project: row.policy_project,
    name: row.policy_name,
    type: row.policy_type,
    status: row.policy_status,
    valid_from_offset_sec: row.policy_valid_from_offset_sec,
    duration_sec: row.policy_duration_sec,
    assertion_ttl_seconds: row.policy_assertion_ttl_seconds,
    pool_size: row.policy_pool_size,
    max_active_devices: row.policy_max_active_devices,
    max_borrow_sec: row.policy_max_borrow_sec,
    meter_quota: row.policy_meter_quota,
    meter_period_sec: row.policy_meter_period_sec,
    expiry_strategy: row.policy_expiry_strategy,
    trial_expiration_basis: row.policy_trial_expiration_basis,
    trial_duration_sec: row.policy_trial_duration_sec,
    trial_one_per_device: row.policy_trial_one_per_device,
    trial_require_device_proof: row.policy_trial_require_device_proof,
    notes: row.policy_notes,
    created_at: row.policy_created_at,
    updated_at: row.policy_updated_at,
  };
}

function capacityOverrides(row) {
  const overrides = {};
  for (const field of ["pool_size", "max_active_devices", "max_borrow_sec", "meter_quota", "meter_period_sec"]) {
    const value = rowInteger(row, field);
    if (value !== undefined) overrides[field] = value;
  }
  return overrides;
}

export function desiredPlanProjectionRow(row, input, now) {
  const base = {
    project: input.project,
    feature: row.feature_key,
    license_fingerprint: input.license_fingerprint,
    device_hash: "",
    status: "active",
    notes: input.notes,
    customer_id: input.customer_id,
    license_id: input.license_id,
  };
  if (input.support_until_provided) base.valid_until = input.support_until;
  const assertionTtl = rowInteger(row, "assertion_ttl_seconds");
  if (assertionTtl !== undefined) base.assertion_ttl_seconds = assertionTtl;

  const overrides = { ...base, ...capacityOverrides(row) };
  const policy = policyFromCatalogRow(row);
  const stamp = policy === null
    ? {
        input: {
          ...base,
          assertion_ttl_seconds: base.assertion_ttl_seconds ?? 300,
          valid_from: null,
          valid_until: input.support_until_provided ? input.support_until : null,
        },
        capacity: { ...DEFAULT_CAPACITY, ...capacityOverrides(row) },
        trial: { ...ZERO_TRIAL },
      }
    : stampFromPolicy(policy, overrides, now);

  return {
    input: stamp.input,
    policy_id: policy?.id ?? null,
    capacity: stamp.capacity,
    trial: stamp.trial,
    source: row.feature_inclusion,
    addon_key: row.feature_inclusion === "addon" ? row.addon_key ?? row.feature_key : null,
    feature_name: row.feature_name,
  };
}

function capabilityMode(capacity, trial) {
  if (Number(trial.is_trial) === 1) return "trial";
  return Number(capacity.pool_size) > 0 ? "floating" : "node_locked";
}

function summarizeDesired(desired) {
  return {
    project: desired.input.project,
    feature: desired.input.feature,
    license_fingerprint: desired.input.license_fingerprint,
    policy_id: desired.policy_id,
    source: desired.source,
    addon_key: desired.addon_key,
    license_mode: capabilityMode(desired.capacity, desired.trial),
    status: desired.input.status,
    valid_from: desired.input.valid_from,
    valid_until: desired.input.valid_until,
    assertion_ttl_seconds: desired.input.assertion_ttl_seconds,
    pool_size: desired.capacity.pool_size,
    max_active_devices: desired.capacity.max_active_devices,
    max_borrow_sec: desired.capacity.max_borrow_sec,
    meter_quota: desired.capacity.meter_quota,
    meter_period_sec: desired.capacity.meter_period_sec,
  };
}

function summarizeExisting(row, reason = "") {
  return {
    project: row.project,
    feature: row.feature,
    license_fingerprint: row.license_fingerprint,
    policy_id: row.policy_id,
    source: "included",
    addon_key: null,
    license_mode: row.license_mode,
    status: row.status,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    assertion_ttl_seconds: row.assertion_ttl_seconds,
    pool_size: row.pool_size,
    max_active_devices: row.max_active_devices,
    max_borrow_sec: row.max_borrow_sec,
    meter_quota: row.meter_quota,
    meter_period_sec: row.meter_period_sec,
    reason,
  };
}

function valuesEqual(left, right) {
  return (left ?? null) === (right ?? null);
}

export function planProjectionMatchesDesired(existing, desired) {
  const input = desired.input;
  const capacity = desired.capacity;
  const trial = desired.trial;
  return existing.status === "active" &&
    valuesEqual(existing.device_hash, input.device_hash ?? "") &&
    Number(existing.assertion_ttl_seconds) === Number(input.assertion_ttl_seconds) &&
    Number(existing.cache_ttl_seconds) === Number(input.assertion_ttl_seconds) &&
    valuesEqual(existing.valid_from, input.valid_from) &&
    valuesEqual(existing.valid_until, input.valid_until) &&
    valuesEqual(existing.notes, input.notes ?? "") &&
    valuesEqual(existing.customer_id, input.customer_id) &&
    valuesEqual(existing.license_id, input.license_id) &&
    valuesEqual(existing.policy_id, desired.policy_id) &&
    Number(existing.pool_size) === Number(capacity.pool_size) &&
    Number(existing.max_active_devices) === Number(capacity.max_active_devices) &&
    Number(existing.max_borrow_sec) === Number(capacity.max_borrow_sec) &&
    Number(existing.meter_quota) === Number(capacity.meter_quota) &&
    Number(existing.meter_period_sec) === Number(capacity.meter_period_sec) &&
    Number(existing.is_trial) === Number(trial.is_trial) &&
    valuesEqual(existing.trial_expiration_basis, trial.trial_expiration_basis) &&
    Number(existing.trial_duration_sec) === Number(trial.trial_duration_sec) &&
    Number(existing.trial_one_per_device) === Number(trial.trial_one_per_device) &&
    Number(existing.trial_require_device_proof) === Number(trial.trial_require_device_proof);
}

export function classifyPlanProjection({ input, plan, desired, existingRows }) {
  const existingByFeature = new Map(existingRows.map((row) => [row.feature, row]));
  const desiredByFeature = new Map(desired.map((row) => [row.input.feature, row]));
  const willCreate = [];
  const willUpdate = [];
  const willDisable = [];
  const blocked = [];
  const unchanged = [];

  for (const target of desired) {
    const existing = existingByFeature.get(target.input.feature) ?? null;
    if (existing === null) {
      willCreate.push(summarizeDesired(target));
    } else if (existing.status === "revoked") {
      blocked.push({ ...summarizeDesired(target), reason: "revoked_entitlement" });
    } else if (planProjectionMatchesDesired(existing, target)) {
      unchanged.push(summarizeDesired(target));
    } else {
      willUpdate.push({ ...summarizeDesired(target), previous_status: existing.status });
    }
  }

  for (const existing of existingRows) {
    if (desiredByFeature.has(existing.feature)) continue;
    if (existing.status === "revoked" || existing.status === "disabled") {
      unchanged.push(summarizeExisting(existing, "not_in_plan"));
    } else {
      willDisable.push(summarizeExisting(existing, "not_in_plan"));
    }
  }

  return {
    plan,
    assignment: {
      project: input.project,
      license_id: input.license_id,
      license_fingerprint: input.license_fingerprint,
      customer_id: input.customer_id,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      support_until: input.support_until,
      addons: input.addons,
    },
    desired: desired.map((row) => summarizeDesired(row)),
    will_create: willCreate,
    will_update: willUpdate,
    will_disable: willDisable,
    blocked,
    unchanged,
    summary: {
      create: willCreate.length,
      update: willUpdate.length,
      disable: willDisable.length,
      blocked: blocked.length,
      unchanged: unchanged.length,
    },
  };
}
