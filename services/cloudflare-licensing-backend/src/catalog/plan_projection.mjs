import {
  ENTITLEMENT_COLUMNS,
  createEntitlement,
  transitionEntitlement,
  withId,
} from "../entitlements/entitlement_mutation.mjs";
import { buildPolicyStampStatement, stampFromPolicy } from "../entitlements/policy.mjs";

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

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function resultsOf(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function requiredString(input, field) {
  const value = input?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid_${field}`);
  }
  return value.trim();
}

function optionalString(input, field) {
  const value = input?.[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid_${field}`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalInteger(input, field) {
  const value = input?.[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function rowInteger(row, field) {
  const value = row?.[field];
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeAddons(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("invalid_addons");
  }
  const seen = new Set();
  const addons = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("invalid_addons");
    }
    const trimmed = item.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      addons.push(trimmed);
    }
  }
  return addons;
}

function normalizeInput(input) {
  const project = requiredString(input, "project");
  const licenseId = requiredString(input, "license_id");
  const licenseFingerprint = requiredString(input, "license_fingerprint");
  const planId = optionalString(input, "plan_id");
  const planKey = optionalString(input, "plan_key");
  if (planId === null && planKey === null) {
    throw new Error("invalid_plan");
  }
  const supportUntilProvided = Object.prototype.hasOwnProperty.call(input ?? {}, "support_until");
  return {
    project,
    license_id: licenseId,
    license_fingerprint: licenseFingerprint,
    customer_id: optionalString(input, "customer_id"),
    plan_id: planId,
    plan_key: planKey,
    support_until: optionalInteger(input, "support_until"),
    support_until_provided: supportUntilProvided,
    addons: normalizeAddons(input?.addons),
    notes: optionalString(input, "notes") ?? "",
  };
}

function policyFromRow(row) {
  if (row.policy_id_resolved === null) {
    return null;
  }
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
    if (value !== undefined) {
      overrides[field] = value;
    }
  }
  return overrides;
}

function capabilityMode(capacity, trial) {
  if (Number(trial.is_trial) === 1) {
    return "trial";
  }
  if (Number(capacity.pool_size) > 0) {
    return "floating";
  }
  return "node_locked";
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

function valuesEqual(a, b) {
  return (a ?? null) === (b ?? null);
}

function matchesDesired(existing, desired) {
  const input = desired.input;
  const capacity = desired.capacity;
  const trial = desired.trial;
  return (
    existing.status === "active" &&
    valuesEqual(existing.device_hash, input.device_hash ?? "") &&
    Number(existing.assertion_ttl_seconds) === Number(input.assertion_ttl_seconds) &&
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
    Number(existing.trial_require_device_proof) === Number(trial.trial_require_device_proof)
  );
}

async function resolvePlan(env, input) {
  const byId = input.plan_id !== null;
  const row = await env.DB.prepare(
    byId
      ? "SELECT id, project, plan_key, name, status, version, description, created_at, updated_at FROM catalog_plans WHERE project = ? AND id = ? LIMIT 1"
      : "SELECT id, project, plan_key, name, status, version, description, created_at, updated_at FROM catalog_plans WHERE project = ? AND plan_key = ? LIMIT 1",
  )
    .bind(input.project, byId ? input.plan_id : input.plan_key)
    .first();
  if (row === null) {
    throw new Error("plan_not_found");
  }
  if (row.status !== "active") {
    throw new Error("plan_disabled");
  }
  return row;
}

async function loadPlanFeatureRows(env, plan, addonList) {
  const result = await env.DB.prepare(
    `SELECT
       pf.project,
       pf.plan_id,
       pf.feature_key,
       pf.feature_inclusion,
       pf.addon_key,
       pf.policy_id AS plan_policy_id,
       pf.assertion_ttl_seconds,
       pf.pool_size,
       pf.max_active_devices,
       pf.max_borrow_sec,
       pf.meter_quota,
       pf.meter_period_sec,
       f.name AS feature_name,
       f.status AS feature_status,
       ep.id AS policy_id_resolved,
       ep.project AS policy_project,
       ep.name AS policy_name,
       ep.type AS policy_type,
       ep.status AS policy_status,
       ep.valid_from_offset_sec AS policy_valid_from_offset_sec,
       ep.duration_sec AS policy_duration_sec,
       ep.assertion_ttl_seconds AS policy_assertion_ttl_seconds,
       ep.pool_size AS policy_pool_size,
       ep.max_active_devices AS policy_max_active_devices,
       ep.max_borrow_sec AS policy_max_borrow_sec,
       ep.meter_quota AS policy_meter_quota,
       ep.meter_period_sec AS policy_meter_period_sec,
       ep.expiry_strategy AS policy_expiry_strategy,
       ep.trial_expiration_basis AS policy_trial_expiration_basis,
       ep.trial_duration_sec AS policy_trial_duration_sec,
       ep.trial_one_per_device AS policy_trial_one_per_device,
       ep.trial_require_device_proof AS policy_trial_require_device_proof,
       ep.notes AS policy_notes,
       ep.created_at AS policy_created_at,
       ep.updated_at AS policy_updated_at
     FROM catalog_plan_features pf
     JOIN catalog_features f ON f.project = pf.project AND f.feature_key = pf.feature_key
     LEFT JOIN entitlement_policies ep ON ep.id = pf.policy_id
     WHERE pf.project = ? AND pf.plan_id = ? AND pf.status = 'active' AND f.status = 'active'
     ORDER BY pf.display_order ASC, pf.feature_key ASC`,
  )
    .bind(plan.project, plan.id)
    .all();

  const requested = new Set(addonList);
  const availableAddons = new Set();
  const rows = [];
  for (const row of resultsOf(result)) {
    if (row.plan_policy_id !== null && row.policy_id_resolved === null) {
      throw new Error(`policy_not_found:${row.plan_policy_id}`);
    }
    if (row.policy_id_resolved !== null && row.policy_project !== plan.project) {
      throw new Error(`policy_project_mismatch:${row.policy_id_resolved}`);
    }
    if (row.policy_id_resolved !== null && row.policy_status !== "active") {
      throw new Error(`policy_disabled:${row.policy_id_resolved}`);
    }
    if (row.feature_inclusion === "addon") {
      const addonKey = row.addon_key ?? row.feature_key;
      availableAddons.add(addonKey);
      if (!requested.has(addonKey) && !requested.has(row.feature_key)) {
        continue;
      }
    }
    rows.push(row);
  }
  for (const addon of requested) {
    if (!availableAddons.has(addon) && !rows.some((row) => row.feature_key === addon && row.feature_inclusion === "addon")) {
      throw new Error(`unknown_addon:${addon}`);
    }
  }
  return rows;
}

async function listExistingManagedEntitlements(env, input) {
  const result = await env.DB.prepare(
    `SELECT ${ENTITLEMENT_COLUMNS}
     FROM entitlements e
     WHERE e.project = ?
       AND e.license_id = ?
       AND e.license_fingerprint = ?
       AND EXISTS (
         SELECT 1 FROM catalog_features f
         WHERE f.project = e.project AND f.feature_key = e.feature
       )
     ORDER BY e.feature ASC`,
  )
    .bind(input.project, input.license_id, input.license_fingerprint)
    .all();
  return resultsOf(result).map((row) => withId(row));
}

function desiredFromRow(row, input, now) {
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
  if (input.support_until_provided) {
    base.valid_until = input.support_until;
  }
  const assertionTtl = rowInteger(row, "assertion_ttl_seconds");
  if (assertionTtl !== undefined) {
    base.assertion_ttl_seconds = assertionTtl;
  }

  const overrides = { ...base, ...capacityOverrides(row) };
  const policy = policyFromRow(row);
  const stamp =
    policy === null
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

async function buildProjection(env, input, now) {
  const normalized = normalizeInput(input);
  const plan = await resolvePlan(env, normalized);
  const rows = await loadPlanFeatureRows(env, plan, normalized.addons);
  const desired = rows.map((row) => desiredFromRow(row, normalized, now));
  const existingRows = await listExistingManagedEntitlements(env, normalized);
  const existingByFeature = new Map(existingRows.map((row) => [row.feature, row]));
  const desiredByFeature = new Map(desired.map((row) => [row.input.feature, row]));
  return { input: normalized, plan, desired, existingRows, existingByFeature, desiredByFeature };
}

function classifyProjection(projection) {
  const willCreate = [];
  const willUpdate = [];
  const willDisable = [];
  const blocked = [];
  const unchanged = [];

  for (const desired of projection.desired) {
    const existing = projection.existingByFeature.get(desired.input.feature) ?? null;
    if (existing === null) {
      willCreate.push(summarizeDesired(desired));
      continue;
    }
    if (existing.status === "revoked") {
      blocked.push({ ...summarizeDesired(desired), reason: "revoked_entitlement" });
      continue;
    }
    if (matchesDesired(existing, desired)) {
      unchanged.push(summarizeDesired(desired));
    } else {
      willUpdate.push({ ...summarizeDesired(desired), previous_status: existing.status });
    }
  }

  for (const existing of projection.existingRows) {
    if (projection.desiredByFeature.has(existing.feature)) {
      continue;
    }
    if (existing.status === "revoked" || existing.status === "disabled") {
      unchanged.push(summarizeExisting(existing, "not_in_plan"));
      continue;
    }
    willDisable.push(summarizeExisting(existing, "not_in_plan"));
  }

  return {
    plan: projection.plan,
    assignment: {
      project: projection.input.project,
      license_id: projection.input.license_id,
      license_fingerprint: projection.input.license_fingerprint,
      customer_id: projection.input.customer_id,
      plan_id: projection.plan.id,
      plan_key: projection.plan.plan_key,
      support_until: projection.input.support_until,
      addons: projection.input.addons,
    },
    desired: projection.desired.map((row) => summarizeDesired(row)),
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

export async function previewPlanProjection(env, input, now = nowSeconds()) {
  return classifyProjection(await buildProjection(env, input, now));
}

function desiredStampStatement(env, desired) {
  const key = {
    project: desired.input.project,
    feature: desired.input.feature,
    license_fingerprint: desired.input.license_fingerprint,
  };
  return buildPolicyStampStatement(env, key, desired.policy_id, desired.capacity, desired.trial);
}

async function writeAssignment(env, projection, now) {
  await env.DB.prepare(
    `INSERT INTO license_plan_assignments
       (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
     ON CONFLICT(license_id, project) DO UPDATE SET
       plan_id = excluded.plan_id,
       license_fingerprint = excluded.license_fingerprint,
       customer_id = excluded.customer_id,
       status = 'active',
       support_until = excluded.support_until,
       addons_json = excluded.addons_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      projection.input.license_id,
      projection.input.project,
      projection.plan.id,
      projection.input.license_fingerprint,
      projection.input.customer_id,
      projection.input.support_until,
      JSON.stringify(projection.input.addons),
      now,
      now,
    )
    .run();
  return env.DB.prepare(
    "SELECT license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at FROM license_plan_assignments WHERE license_id = ? AND project = ? LIMIT 1",
  )
    .bind(projection.input.license_id, projection.input.project)
    .first();
}

export async function applyPlanProjection(env, input, ctx, now = nowSeconds()) {
  const projection = await buildProjection(env, input, now);
  const preview = classifyProjection(projection);
  if (preview.blocked.length > 0) {
    throw new Error("projection_blocked_revoked_entitlement");
  }

  const created = [];
  const updated = [];
  const disabled = [];

  for (const desired of projection.desired) {
    const existing = projection.existingByFeature.get(desired.input.feature) ?? null;
    if (existing !== null && matchesDesired(existing, desired)) {
      continue;
    }
    const result = await createEntitlement(
      env,
      desired.input,
      ctx,
      "plan_projection",
      existing === null ? "create" : "update",
      null,
      [desiredStampStatement(env, desired)],
    );
    if (existing === null) {
      created.push(result.data);
    } else {
      updated.push(result.data);
    }
  }

  for (const existing of projection.existingRows) {
    if (projection.desiredByFeature.has(existing.feature)) {
      continue;
    }
    if (existing.status === "revoked" || existing.status === "disabled") {
      continue;
    }
    const result = await transitionEntitlement(
      env,
      {
        project: existing.project,
        feature: existing.feature,
        license_fingerprint: existing.license_fingerprint,
      },
      "disabled",
      "disable",
      "plan_projection_removed",
      ctx,
      null,
    );
    if (result !== null) {
      disabled.push(result.data);
    }
  }

  const assignment = await writeAssignment(env, projection, now);
  return {
    ...preview,
    applied: {
      created,
      updated,
      disabled,
      assignment,
    },
  };
}
