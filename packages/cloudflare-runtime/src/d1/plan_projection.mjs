// D1 adapter for the portable plan-projection contract.
import {
  ENTITLEMENT_COLUMNS,
  createEntitlement,
  transitionEntitlement,
  withId,
} from "./entitlement_mutation.mjs";
import { buildPolicyStampStatement } from "../entitlements/policy_store.mjs";
import {
  classifyPlanProjection,
  desiredPlanProjectionRow,
  normalizePlanProjectionInput,
  planProjectionMatchesDesired,
} from "@licensecc/licensing-domain/catalog/plan_projection";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function resultsOf(result) {
  return Array.isArray(result?.results) ? result.results : [];
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
  if (row === null) throw new Error("plan_not_found");
  if (row.status !== "active") throw new Error("plan_disabled");
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
    if (row.plan_policy_id !== null && row.policy_id_resolved === null) throw new Error(`policy_not_found:${row.plan_policy_id}`);
    if (row.policy_id_resolved !== null && row.policy_project !== plan.project) throw new Error(`policy_project_mismatch:${row.policy_id_resolved}`);
    if (row.policy_id_resolved !== null && row.policy_status !== "active") throw new Error(`policy_disabled:${row.policy_id_resolved}`);
    if (row.feature_inclusion === "addon") {
      const addonKey = row.addon_key ?? row.feature_key;
      availableAddons.add(addonKey);
      if (!requested.has(addonKey) && !requested.has(row.feature_key)) continue;
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

async function buildProjection(env, input, now) {
  const normalized = normalizePlanProjectionInput(input);
  const plan = await resolvePlan(env, normalized);
  const rows = await loadPlanFeatureRows(env, plan, normalized.addons);
  const desired = rows.map((row) => desiredPlanProjectionRow(row, normalized, now));
  const existingRows = await listExistingManagedEntitlements(env, normalized);
  return { input: normalized, plan, desired, existingRows };
}

export async function previewPlanProjection(env, input, now = nowSeconds()) {
  return classifyPlanProjection(await buildProjection(env, input, now));
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
  const preview = classifyPlanProjection(projection);
  if (preview.blocked.length > 0) throw new Error("projection_blocked_revoked_entitlement");

  const existingByFeature = new Map(projection.existingRows.map((row) => [row.feature, row]));
  const desiredByFeature = new Map(projection.desired.map((row) => [row.input.feature, row]));
  const created = [];
  const updated = [];
  const disabled = [];

  for (const desired of projection.desired) {
    const existing = existingByFeature.get(desired.input.feature) ?? null;
    if (existing !== null && planProjectionMatchesDesired(existing, desired)) continue;
    const result = await createEntitlement(
      env,
      desired.input,
      ctx,
      "plan_projection",
      existing === null ? "create" : "update",
      null,
      [desiredStampStatement(env, desired)],
    );
    if (existing === null) created.push(result.data);
    else updated.push(result.data);
  }

  for (const existing of projection.existingRows) {
    if (desiredByFeature.has(existing.feature)) continue;
    if (existing.status === "revoked" || existing.status === "disabled") continue;
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
    if (result !== null) disabled.push(result.data);
  }

  const assignment = await writeAssignment(env, projection, now);
  return { ...preview, applied: { created, updated, disabled, assignment } };
}
