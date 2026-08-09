// D1 adapter for a server-bound catalog plan-projection protocol.
//
// A preview is a persisted capability, not a client-side hash.  It captures a
// normalized input, exact actions, one effective time, and a conservative
// source generation. Apply never reads the live catalog/form again: it claims
// that preview and performs every write in one D1 batch.
import {
  ENTITLEMENT_COLUMNS,
  REVOCATION_SEQ_BUMP,
  batchReturnedRow,
  entitlementId,
  withId,
} from "./entitlement_mutation.mjs";
import { entitlementCurrentJsonSql } from "./entitlement_json.mjs";
import {
  classifyPlanProjection,
  desiredPlanProjectionRow,
  isPlanProjectionPreviewId,
  normalizePlanProjectionInput,
  planProjectionMatchesDesired,
} from "@licensecc/licensing-domain/catalog/plan_projection";

const PREVIEW_SCOPE = "catalog";
const PREVIEW_TTL_SECONDS = 300;
const PREVIEW_CLEANUP_BATCH_SIZE = 25;
// A desired action needs at most four D1 statements during Apply (mutation,
// policy stamp, audit, and assertion). Nine actions are 45 batch statements
// with the atomic claim-failure classifier and idempotency path. The winning
// request performs 47 top-level D1 statements (replay lookup + preview decode
// + batch); a stale concurrent loser that replays performs 48. Both remain
// below the Workers Free 50-query limit, and therefore Paid's 1,000-query
// limit. Never chunk Apply: reject a larger preview before it becomes a
// capability.
const MAX_ATOMIC_ACTIONS = 9;
const APPLY_CODE = "license_plan_projection_applied";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function resultsOf(result) {
  return Array.isArray(result?.results) ? result.results : [];
}

function firstResult(result) {
  return resultsOf(result)[0] ?? null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "";
}

function parseJson(value, errorCode) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
}

function requireBatch(env) {
  if (typeof env.DB.batch !== "function") {
    throw new Error("projection_batch_required");
  }
}

function planFilterSql(byId) {
  return byId ? "cp.id = ?" : "cp.plan_key = ?";
}

function planStatement(env, input) {
  const byId = input.plan_id !== null;
  return env.DB.prepare(
    byId
      ? "SELECT id, project, plan_key, name, status, version, description, created_at, updated_at FROM catalog_plans WHERE project = ? AND id = ? LIMIT 1"
      : "SELECT id, project, plan_key, name, status, version, description, created_at, updated_at FROM catalog_plans WHERE project = ? AND plan_key = ? LIMIT 1",
  ).bind(input.project, byId ? input.plan_id : input.plan_key);
}

function planFeatureStatement(env, input) {
  const byId = input.plan_id !== null;
  return env.DB.prepare(
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
     JOIN catalog_plans cp ON cp.project = pf.project AND cp.id = pf.plan_id
     JOIN catalog_features f ON f.project = pf.project AND f.feature_key = pf.feature_key
     LEFT JOIN entitlement_policies ep ON ep.id = pf.policy_id
     WHERE cp.project = ? AND ${planFilterSql(byId)} AND pf.status = 'active' AND f.status = 'active'
     ORDER BY pf.display_order ASC, pf.feature_key ASC`,
  ).bind(input.project, byId ? input.plan_id : input.plan_key);
}

function managedEntitlementsStatement(env, input) {
  return env.DB.prepare(
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
  ).bind(input.project, input.license_id, input.license_fingerprint);
}

function assignmentSnapshotStatement(env, input) {
  return env.DB.prepare(
    `SELECT license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at
     FROM license_plan_assignments
     WHERE license_id = ? AND project = ?
     LIMIT 1`,
  ).bind(input.license_id, input.project);
}

function cleanupExpiredPreviewsStatement(env, now) {
  // Lazy cleanup is intentionally part of Preview, not Apply: Apply's only
  // mutations must be guarded by its successful claim. The bounded subquery
  // prevents a frequently-used admin endpoint from turning retention work into
  // an unbounded D1 operation.
  return env.DB.prepare(
    `DELETE FROM license_plan_projection_previews
     WHERE id IN (
       SELECT id
       FROM license_plan_projection_previews
       WHERE expires_at <= ? OR consumed_at IS NOT NULL
       ORDER BY expires_at ASC, id ASC
       LIMIT ?
     )`,
  ).bind(now, PREVIEW_CLEANUP_BATCH_SIZE);
}

function selectedPlanRows(rows, plan, addonList) {
  const requested = new Set(addonList);
  const availableAddons = new Set();
  const selected = [];
  for (const row of rows) {
    if (row.plan_policy_id !== null && row.policy_id_resolved === null) throw new Error(`policy_not_found:${row.plan_policy_id}`);
    if (row.policy_id_resolved !== null && row.policy_project !== plan.project) throw new Error(`policy_project_mismatch:${row.policy_id_resolved}`);
    if (row.policy_id_resolved !== null && row.policy_status !== "active") throw new Error(`policy_disabled:${row.policy_id_resolved}`);
    if (row.feature_inclusion === "addon") {
      const addonKey = row.addon_key ?? row.feature_key;
      availableAddons.add(addonKey);
      if (!requested.has(addonKey) && !requested.has(row.feature_key)) continue;
    }
    selected.push(row);
  }
  for (const addon of requested) {
    if (!availableAddons.has(addon) && !selected.some((row) => row.feature_key === addon && row.feature_inclusion === "addon")) {
      throw new Error(`unknown_addon:${addon}`);
    }
  }
  return selected;
}

// All source-dependent Preview reads run in one D1 batch. D1 executes a batch
// atomically, so generation, plan, feature/policy rows, managed entitlement
// rows, and the compatibility-critical assignment snapshot all come from one
// source snapshot rather than a sequence of independently fresh reads. Cleanup
// deliberately follows capacity validation, so an oversized Preview remains
// entirely read-only.
async function buildProjectionSnapshot(env, input, effectiveAt) {
  requireBatch(env);
  const normalized = normalizePlanProjectionInput(input);
  const results = await env.DB.batch([
    env.DB.prepare("SELECT generation FROM license_plan_projection_generations WHERE scope = ? LIMIT 1").bind(PREVIEW_SCOPE),
    planStatement(env, normalized),
    planFeatureStatement(env, normalized),
    managedEntitlementsStatement(env, normalized),
    assignmentSnapshotStatement(env, normalized),
  ]);
  const generationRow = firstResult(results[0]);
  const sourceGeneration = Number(generationRow?.generation);
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) throw new Error("projection_generation_missing");
  const plan = firstResult(results[1]);
  if (plan === null) throw new Error("plan_not_found");
  if (plan.status !== "active") throw new Error("plan_disabled");
  const rows = selectedPlanRows(resultsOf(results[2]), plan, normalized.addons);
  const desired = rows.map((row) => desiredPlanProjectionRow(row, normalized, effectiveAt));
  const existingRows = resultsOf(results[3]).map((row) => withId(row));
  const assignmentSnapshot = firstResult(results[4]);
  if (assignmentSnapshot !== null && assignmentSnapshot.license_fingerprint !== normalized.license_fingerprint) {
    throw new Error("license_fingerprint_conflict");
  }
  return { input: normalized, plan, desired, existingRows, assignmentSnapshot, sourceGeneration };
}

function actionId(desired) {
  return entitlementId(desired.input.project, desired.input.feature, desired.input.license_fingerprint);
}

function deriveActions(projection) {
  const existingByFeature = new Map(projection.existingRows.map((row) => [row.feature, row]));
  const desiredByFeature = new Map(projection.desired.map((row) => [row.input.feature, row]));
  const created = [];
  const updated = [];
  const disabled = [];

  for (const desired of projection.desired) {
    const existing = existingByFeature.get(desired.input.feature) ?? null;
    if (existing === null) {
      created.push({ id: actionId(desired), desired });
    } else if (existing.status !== "revoked" && !planProjectionMatchesDesired(existing, desired)) {
      updated.push({ id: actionId(desired), desired, previous: existing });
    }
  }
  for (const existing of projection.existingRows) {
    if (desiredByFeature.has(existing.feature) || existing.status === "revoked" || existing.status === "disabled") continue;
    disabled.push({ id: entitlementId(existing.project, existing.feature, existing.license_fingerprint), previous: existing });
  }
  return {
    created,
    updated,
    disabled,
  };
}

function assertAtomicActionCapacity(actions) {
  const count = actions.created.length + actions.updated.length + actions.disabled.length;
  if (count > MAX_ATOMIC_ACTIONS) throw new Error("projection_too_large");
}

function previewResponse(projection, previewId, effectiveAt, expiresAt) {
  return {
    ...classifyPlanProjection(projection),
    preview_id: previewId,
    effective_at: effectiveAt,
    expires_at: expiresAt,
    source_generation: projection.sourceGeneration,
  };
}

function insertPreviewStatement(env, previewId, actorSubject, projection, preview, actions, effectiveAt, expiresAt) {
  return env.DB.prepare(
    `INSERT INTO license_plan_projection_previews
       (id, actor_subject, source_generation, normalized_input_json, projection_json, actions_json, effective_at, expires_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM license_plan_projection_generations
       WHERE scope = ? AND generation = ?
     )
     RETURNING id`,
  ).bind(
    previewId,
    actorSubject,
    projection.sourceGeneration,
    JSON.stringify(projection.input),
    JSON.stringify(preview),
    JSON.stringify({ ...actions, assignment: preview.assignment, assignment_snapshot: projection.assignmentSnapshot }),
    effectiveAt,
    expiresAt,
    effectiveAt,
    PREVIEW_SCOPE,
    projection.sourceGeneration,
  );
}

export async function previewPlanProjection(env, input, actorSubject, now = nowSeconds()) {
  if (!nonEmptyString(actorSubject)) throw new Error("invalid_actor");
  const effectiveAt = now;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projection = await buildProjectionSnapshot(env, input, effectiveAt);
    const previewId = `ppv_${crypto.randomUUID()}`;
    const expiresAt = effectiveAt + PREVIEW_TTL_SECONDS;
    const preview = previewResponse(projection, previewId, effectiveAt, expiresAt);
    const actions = deriveActions(projection);
    assertAtomicActionCapacity(actions);
    // This is intentionally after assertAtomicActionCapacity(): an operator
    // who must narrow an over-large scope gets no write attempt at all. Once
    // valid, cleanup and preview persistence share one batch; the INSERT's
    // generation predicate still rejects any source change after the snapshot.
    const persisted = await env.DB.batch([
      cleanupExpiredPreviewsStatement(env, effectiveAt),
      insertPreviewStatement(env, previewId, actorSubject, projection, preview, actions, effectiveAt, expiresAt),
    ]);
    if (resultsOf(persisted[1]).length === 1) return preview;
  }
  throw new Error("projection_snapshot_stale");
}

async function storedPreview(env, previewId) {
  // This decodes only the immutable server-persisted snapshot so we can build
  // the static D1 batch. It intentionally performs no live catalog/source
  // read or comparison: expiration, actor binding, source generation, and the
  // one-time claim are all verified by the first statement of that final batch.
  const row = await env.DB.prepare(
    "SELECT projection_json, actions_json FROM license_plan_projection_previews WHERE id = ? LIMIT 1",
  ).bind(previewId).first();
  if (row === null) throw new Error("stale_projection_preview");
  const preview = parseJson(row.projection_json, "projection_preview_invalid");
  const actions = parseJson(row.actions_json, "projection_preview_invalid");
  if (!Array.isArray(actions.created) || !Array.isArray(actions.updated) || !Array.isArray(actions.disabled) || typeof actions.assignment !== "object" || actions.assignment === null || !Object.prototype.hasOwnProperty.call(actions, "assignment_snapshot")) {
    throw new Error("projection_preview_invalid");
  }
  return { preview, actions };
}

function claimGuardSql() {
  return "EXISTS (SELECT 1 FROM license_plan_projection_previews p WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL)";
}

function assignmentFingerprintConflictSql(previewAlias) {
  return `EXISTS (
    SELECT 1
    FROM license_plan_assignments a
    WHERE a.license_id = json_extract(${previewAlias}.actions_json, '$.assignment.license_id')
      AND a.project = json_extract(${previewAlias}.actions_json, '$.assignment.project')
      AND a.license_fingerprint <> json_extract(${previewAlias}.actions_json, '$.assignment.license_fingerprint')
  )`;
}

function assignmentSnapshotStillMatchesSql(previewAlias) {
  // The generation condition is the primary concurrent-source fence. This
  // snapshot comparison makes the assignment dependency explicit too: an
  // implementation error or future trigger omission cannot silently turn a
  // preview for no assignment (or a prior assignment) into a transfer.
  const snapshot = `${previewAlias}.actions_json`;
  return `(CASE json_type(${snapshot}, '$.assignment_snapshot')
    WHEN 'null' THEN NOT EXISTS (
      SELECT 1 FROM license_plan_assignments a
      WHERE a.license_id = json_extract(${snapshot}, '$.assignment.license_id')
        AND a.project = json_extract(${snapshot}, '$.assignment.project')
    )
    WHEN 'object' THEN EXISTS (
      SELECT 1 FROM license_plan_assignments a
      WHERE a.license_id = json_extract(${snapshot}, '$.assignment_snapshot.license_id')
        AND a.project = json_extract(${snapshot}, '$.assignment_snapshot.project')
        AND a.plan_id = json_extract(${snapshot}, '$.assignment_snapshot.plan_id')
        AND a.license_fingerprint = json_extract(${snapshot}, '$.assignment_snapshot.license_fingerprint')
        AND a.customer_id IS json_extract(${snapshot}, '$.assignment_snapshot.customer_id')
        AND a.status = json_extract(${snapshot}, '$.assignment_snapshot.status')
        AND a.support_until IS json_extract(${snapshot}, '$.assignment_snapshot.support_until')
        AND a.addons_json = json_extract(${snapshot}, '$.assignment_snapshot.addons_json')
        AND a.created_at = json_extract(${snapshot}, '$.assignment_snapshot.created_at')
        AND a.updated_at = json_extract(${snapshot}, '$.assignment_snapshot.updated_at')
    )
    ELSE 0
  END)`;
}

function derivedGrantExpiredSql(previewAlias) {
  return `EXISTS (
    SELECT 1
    FROM json_each(${previewAlias}.projection_json, '$.desired') AS desired
    WHERE json_extract(desired.value, '$.valid_until') IS NOT NULL
      AND CAST(json_extract(desired.value, '$.valid_until') AS INTEGER) <= ?
  )`;
}

function claimStatement(env, previewId, actorSubject, claimToken, now) {
  return env.DB.prepare(
    `UPDATE license_plan_projection_previews AS p
     SET claim_token = ?, claimed_at = ?
     WHERE p.id = ?
       AND p.actor_subject = ?
       AND p.claim_token IS NULL
       AND p.consumed_at IS NULL
       AND p.expires_at > ?
       AND p.source_generation = (
         SELECT generation FROM license_plan_projection_generations WHERE scope = ?
       )
       AND NOT ${assignmentFingerprintConflictSql("p")}
       AND ${assignmentSnapshotStillMatchesSql("p")}
       AND NOT ${derivedGrantExpiredSql("p")}
     RETURNING id`,
  ).bind(claimToken, now, previewId, actorSubject, now, PREVIEW_SCOPE, now);
}

function claimFailureStatement(env, previewId, actorSubject, now) {
  // This is deliberately in the same D1 batch as the conditional claim. It
  // classifies a zero-row claim without reopening a TOCTOU gap; every later
  // mutation checks claimGuardSql(), so this read can never enable writes.
  return env.DB.prepare(
    `SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM license_plan_projection_previews p
         WHERE p.id = ? AND p.actor_subject = ?
           AND ${assignmentFingerprintConflictSql("p")}
       ) THEN 'license_fingerprint_conflict'
       WHEN EXISTS (
         SELECT 1 FROM license_plan_projection_previews p
         WHERE p.id = ? AND p.actor_subject = ?
           AND ${derivedGrantExpiredSql("p")}
       ) THEN 'projection_preview_grant_expired'
       ELSE 'stale_projection_preview'
     END AS projection_claim_error`,
  ).bind(previewId, actorSubject, previewId, actorSubject, now);
}

function valuesForDesired(desired) {
  const input = desired.input;
  return [
    input.project,
    input.feature,
    input.license_fingerprint,
    input.device_hash ?? "",
    input.status,
    input.assertion_ttl_seconds,
    input.valid_from ?? null,
    input.valid_until ?? null,
    input.notes ?? "",
    input.customer_id ?? null,
    input.license_id ?? null,
    desired.policy_id,
    desired.capacity.pool_size,
    desired.capacity.max_active_devices,
    desired.capacity.max_borrow_sec,
    desired.capacity.meter_quota,
    desired.capacity.meter_period_sec,
    desired.trial.is_trial,
    desired.trial.trial_expiration_basis,
    desired.trial.trial_duration_sec,
    desired.trial.trial_one_per_device,
    desired.trial.trial_require_device_proof,
  ];
}

function desiredSatisfiedSql(alias = "e") {
  return `${alias}.device_hash IS ?
    AND ${alias}.status IS ?
    AND ${alias}.assertion_ttl_seconds IS ?
    AND ${alias}.valid_from IS ?
    AND ${alias}.valid_until IS ?
    AND ${alias}.notes IS ?
    AND ${alias}.customer_id IS ?
    AND ${alias}.license_id IS ?
    AND ${alias}.policy_id IS ?
    AND ${alias}.pool_size IS ?
    AND ${alias}.max_active_devices IS ?
    AND ${alias}.max_borrow_sec IS ?
    AND ${alias}.meter_quota IS ?
    AND ${alias}.meter_period_sec IS ?
    AND ${alias}.is_trial IS ?
    AND ${alias}.trial_expiration_basis IS ?
    AND ${alias}.trial_duration_sec IS ?
    AND ${alias}.trial_one_per_device IS ?
    AND ${alias}.trial_require_device_proof IS ?`;
}

function createEntitlementStatement(env, action, now, previewId, claimToken) {
  const input = action.desired.input;
  return env.DB.prepare(
    `INSERT INTO entitlements
       (project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, customer_id, license_id, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?,
       COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events WHERE project = ? AND feature = ? AND license_fingerprint = ?), 1),
       ?, ?, ?, ?, ?, ?, ?
     WHERE ${claimGuardSql()}
     RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    input.project,
    input.feature,
    input.license_fingerprint,
    input.device_hash ?? "",
    input.status,
    input.assertion_ttl_seconds,
    input.assertion_ttl_seconds,
    input.project,
    input.feature,
    input.license_fingerprint,
    input.valid_from ?? null,
    input.valid_until ?? null,
    input.notes ?? "",
    input.customer_id ?? null,
    input.license_id ?? null,
    now,
    now,
    previewId,
    claimToken,
  );
}

function updateEntitlementStatement(env, action, now, previewId, claimToken) {
  const input = action.desired.input;
  return env.DB.prepare(
    `UPDATE entitlements
     SET device_hash = ?, status = ?, assertion_ttl_seconds = ?, cache_ttl_seconds = ?, ${REVOCATION_SEQ_BUMP},
         valid_from = ?, valid_until = ?, notes = ?, customer_id = ?, license_id = ?, updated_at = ?
     WHERE project = ? AND feature = ? AND license_fingerprint = ?
       AND ${claimGuardSql()}
     RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(
    input.device_hash ?? "",
    input.status,
    input.assertion_ttl_seconds,
    input.assertion_ttl_seconds,
    input.valid_from ?? null,
    input.valid_until ?? null,
    input.notes ?? "",
    input.customer_id ?? null,
    input.license_id ?? null,
    now,
    input.project,
    input.feature,
    input.license_fingerprint,
    previewId,
    claimToken,
  );
}

function policyStampStatement(env, desired, previewId, claimToken) {
  const input = desired.input;
  return env.DB.prepare(
    `UPDATE entitlements
     SET policy_id = ?, pool_size = ?, max_active_devices = ?, max_borrow_sec = ?, meter_quota = ?, meter_period_sec = ?,
         is_trial = ?, trial_expiration_basis = ?, trial_duration_sec = ?, trial_one_per_device = ?, trial_require_device_proof = ?
     WHERE project = ? AND feature = ? AND license_fingerprint = ?
       AND ${claimGuardSql()}`,
  ).bind(
    desired.policy_id,
    desired.capacity.pool_size,
    desired.capacity.max_active_devices,
    desired.capacity.max_borrow_sec,
    desired.capacity.meter_quota,
    desired.capacity.meter_period_sec,
    desired.trial.is_trial,
    desired.trial.trial_expiration_basis,
    desired.trial.trial_duration_sec,
    desired.trial.trial_one_per_device,
    desired.trial.trial_require_device_proof,
    input.project,
    input.feature,
    input.license_fingerprint,
    previewId,
    claimToken,
  );
}

function disableEntitlementStatement(env, action, now, previewId, claimToken) {
  const previous = action.previous;
  return env.DB.prepare(
    `UPDATE entitlements
     SET status = 'disabled', ${REVOCATION_SEQ_BUMP}, updated_at = ?
     WHERE project = ? AND feature = ? AND license_fingerprint = ?
       AND ${claimGuardSql()}
     RETURNING ${ENTITLEMENT_COLUMNS}`,
  ).bind(now, previous.project, previous.feature, previous.license_fingerprint, previewId, claimToken);
}

function entitlementAuditStatement(env, action, eventType, reason, ctx, now, previewId, claimToken) {
  const desired = action.desired;
  const key = desired === undefined
    ? action.previous
    : desired.input;
  const expected = desired === undefined
    ? "e.status = 'disabled'"
    : desiredSatisfiedSql("e");
  const expectedValues = desired === undefined ? [] : valuesForDesired(desired).slice(3);
  // valuesForDesired starts with the key values; the current-row predicate needs
  // only the 19 persisted target fields that follow them.
  return env.DB.prepare(
    `INSERT INTO entitlement_events
       (project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq, detail, actor, actor_type, source, request_id, ip, prev_json, next_json, reason, idempotency_key, created_at)
     SELECT e.project, e.feature, e.license_fingerprint, e.device_hash, ?, e.status, e.revocation_seq, ?, ?, ?, ?, ?, ?, ?,
       ${entitlementCurrentJsonSql("e", "?")}, ?, ?, ?
     FROM entitlements e
     WHERE e.project = ? AND e.feature = ? AND e.license_fingerprint = ?
       AND ${claimGuardSql()}
       AND ${expected}`,
  ).bind(
    eventType,
    reason,
    ctx.actor.email || ctx.actor.subject,
    ctx.actor.actorType,
    ctx.source === "sync" ? "sync" : "admin",
    ctx.requestId,
    ctx.ip,
    action.previous === undefined ? "" : JSON.stringify(action.previous),
    action.id,
    reason,
    ctx.idempotencyKey,
    now,
    key.project,
    key.feature,
    key.license_fingerprint,
    previewId,
    claimToken,
    ...expectedValues,
  );
}

function actionAssertionStatement(env, action, kind, previewId, claimToken) {
  const desired = action.desired;
  const key = desired === undefined ? action.previous : desired.input;
  const expected = kind === "disabled" ? "e.status = 'disabled'" : desiredSatisfiedSql("e");
  const expectedValues = kind === "disabled" ? [] : valuesForDesired(desired).slice(3);
  return env.DB.prepare(
    `SELECT CASE
       WHEN NOT ${claimGuardSql()} THEN 1
       WHEN EXISTS (
         SELECT 1 FROM entitlements e
         WHERE e.project = ? AND e.feature = ? AND e.license_fingerprint = ? AND ${expected}
       ) THEN 1
       ELSE json('plan_projection_action_not_applied')
     END`,
  ).bind(previewId, claimToken, key.project, key.feature, key.license_fingerprint, ...expectedValues);
}

function assignmentStatement(env, assignment, now, previewId, claimToken) {
  return env.DB.prepare(
    `INSERT INTO license_plan_assignments
       (license_id, project, plan_id, license_fingerprint, customer_id, status, support_until, addons_json, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?
     WHERE ${claimGuardSql()}
     ON CONFLICT(license_id, project) DO UPDATE SET
       plan_id = excluded.plan_id,
       license_fingerprint = excluded.license_fingerprint,
       customer_id = excluded.customer_id,
       status = 'active',
       support_until = excluded.support_until,
       addons_json = excluded.addons_json,
       updated_at = excluded.updated_at`,
  ).bind(
    assignment.license_id,
    assignment.project,
    assignment.plan_id,
    assignment.license_fingerprint,
    assignment.customer_id,
    assignment.support_until,
    JSON.stringify(assignment.addons),
    now,
    now,
    previewId,
    claimToken,
  );
}

function assignmentAssertionStatement(env, assignment, previewId, claimToken) {
  return env.DB.prepare(
    `SELECT CASE
       WHEN NOT ${claimGuardSql()} THEN 1
       WHEN EXISTS (
         SELECT 1 FROM license_plan_assignments a
         WHERE a.license_id = ? AND a.project = ? AND a.plan_id = ?
           AND a.license_fingerprint = ? AND a.customer_id IS ?
           AND a.status = 'active' AND a.support_until IS ? AND a.addons_json IS ?
       ) THEN 1
       ELSE json('plan_projection_assignment_not_applied')
     END`,
  ).bind(
    previewId,
    claimToken,
    assignment.license_id,
    assignment.project,
    assignment.plan_id,
    assignment.license_fingerprint,
    assignment.customer_id,
    assignment.support_until,
    JSON.stringify(assignment.addons),
  );
}

function appliedRowsJsonSql(path) {
  return `json(COALESCE((
    SELECT json_group_array(${entitlementCurrentJsonSql("e", "json_extract(a.value, '$.id')")})
    FROM json_each(p.actions_json, '${path}') AS a
    JOIN entitlements e
      ON e.project = COALESCE(json_extract(a.value, '$.desired.input.project'), json_extract(a.value, '$.previous.project'))
     AND e.feature = COALESCE(json_extract(a.value, '$.desired.input.feature'), json_extract(a.value, '$.previous.feature'))
     AND e.license_fingerprint = COALESCE(json_extract(a.value, '$.desired.input.license_fingerprint'), json_extract(a.value, '$.previous.license_fingerprint'))
  ), '[]'))`;
}

function appliedResponseDataSql() {
  return `json_set(
    p.projection_json,
    '$.applied',
    json_object(
      'created', ${appliedRowsJsonSql("$.created")},
      'updated', ${appliedRowsJsonSql("$.updated")},
      'disabled', ${appliedRowsJsonSql("$.disabled")},
      'assignment', (
        SELECT json_object(
          'license_id', a.license_id,
          'project', a.project,
          'plan_id', a.plan_id,
          'license_fingerprint', a.license_fingerprint,
          'customer_id', a.customer_id,
          'status', a.status,
          'support_until', a.support_until,
          'addons_json', a.addons_json,
          'created_at', a.created_at,
          'updated_at', a.updated_at
        )
        FROM license_plan_assignments a
        WHERE a.license_id = json_extract(p.actions_json, '$.assignment.license_id')
          AND a.project = json_extract(p.actions_json, '$.assignment.project')
        LIMIT 1
      )
    )
  )`;
}

function responseStatement(env, previewId, claimToken, requestId) {
  return env.DB.prepare(
    `UPDATE license_plan_projection_previews AS p
     SET applied_response_json = json_object(
       'ok', json('true'),
       'code', ?,
       'request_id', ?,
       'data', ${appliedResponseDataSql()}
     )
     WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL`,
  ).bind(APPLY_CODE, requestId, previewId, claimToken);
}

function idempotencyStatement(env, idempotency, ctx, now, previewId, claimToken) {
  if (idempotency === null || ctx.idempotencyKey === null) return null;
  return env.DB.prepare(
    `INSERT INTO mutation_idempotency (scope, idempotency_key, response_json, created_at)
     SELECT ?, ?, p.applied_response_json, ?
     FROM license_plan_projection_previews p
     WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL AND p.applied_response_json IS NOT NULL
     ON CONFLICT(scope, idempotency_key) DO NOTHING`,
  ).bind(idempotency.scope, ctx.idempotencyKey, now, previewId, claimToken);
}

function idempotencyAssertionStatement(env, idempotency, ctx, previewId, claimToken) {
  if (idempotency === null || ctx.idempotencyKey === null) return null;
  return env.DB.prepare(
    `SELECT CASE
       WHEN NOT ${claimGuardSql()} THEN 1
       WHEN EXISTS (
         SELECT 1
         FROM mutation_idempotency i
         JOIN license_plan_projection_previews p ON p.id = ? AND p.claim_token = ? AND p.consumed_at IS NULL
         WHERE i.scope = ? AND i.idempotency_key = ? AND i.response_json = p.applied_response_json
       ) THEN 1
       ELSE json('plan_projection_idempotency_conflict')
     END`,
  ).bind(previewId, claimToken, previewId, claimToken, idempotency.scope, ctx.idempotencyKey);
}

function consumeStatement(env, previewId, claimToken, now) {
  return env.DB.prepare(
    `UPDATE license_plan_projection_previews
     SET consumed_at = ?
     WHERE id = ? AND claim_token = ? AND consumed_at IS NULL AND applied_response_json IS NOT NULL`,
  ).bind(now, previewId, claimToken);
}

function finalResponseStatement(env, previewId, claimToken, now) {
  return env.DB.prepare(
    `SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM license_plan_projection_previews p
         WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at = ? AND p.applied_response_json IS NOT NULL
       ) THEN (
         SELECT p.applied_response_json
         FROM license_plan_projection_previews p
         WHERE p.id = ? AND p.claim_token = ? AND p.consumed_at = ?
         LIMIT 1
       )
       WHEN EXISTS (
         SELECT 1 FROM license_plan_projection_previews p WHERE p.id = ? AND p.claim_token = ?
       ) THEN json('plan_projection_preview_not_finalized')
       ELSE NULL
     END AS applied_response_json`,
  ).bind(previewId, claimToken, now, previewId, claimToken, now, previewId, claimToken);
}

function appendDesiredActionStatements(statements, env, action, kind, ctx, now, previewId, claimToken) {
  statements.push(kind === "create"
    ? createEntitlementStatement(env, action, now, previewId, claimToken)
    : updateEntitlementStatement(env, action, now, previewId, claimToken));
  statements.push(policyStampStatement(env, action.desired, previewId, claimToken));
  statements.push(entitlementAuditStatement(env, action, kind, "plan_projection", ctx, now, previewId, claimToken));
  statements.push(actionAssertionStatement(env, action, kind, previewId, claimToken));
}

function appendDisableActionStatements(statements, env, action, ctx, now, previewId, claimToken) {
  statements.push(disableEntitlementStatement(env, action, now, previewId, claimToken));
  statements.push(entitlementAuditStatement(env, action, "disable", "plan_projection_removed", ctx, now, previewId, claimToken));
  statements.push(actionAssertionStatement(env, action, "disabled", previewId, claimToken));
}

export async function applyPlanProjection(env, previewId, ctx, idempotency, now = nowSeconds()) {
  requireBatch(env);
  if (!isPlanProjectionPreviewId(previewId)) throw new Error("invalid_preview_id");
  const { preview, actions } = await storedPreview(env, previewId);
  if (Array.isArray(preview.blocked) && preview.blocked.length > 0) {
    throw new Error("projection_blocked_revoked_entitlement");
  }
  const claimToken = crypto.randomUUID();
  const statements = [
    claimStatement(env, previewId, ctx.actor.subject, claimToken, now),
    claimFailureStatement(env, previewId, ctx.actor.subject, now),
  ];
  for (const action of actions.created) appendDesiredActionStatements(statements, env, action, "create", ctx, now, previewId, claimToken);
  for (const action of actions.updated) appendDesiredActionStatements(statements, env, action, "update", ctx, now, previewId, claimToken);
  for (const action of actions.disabled) appendDisableActionStatements(statements, env, action, ctx, now, previewId, claimToken);
  statements.push(assignmentStatement(env, actions.assignment, now, previewId, claimToken));
  statements.push(assignmentAssertionStatement(env, actions.assignment, previewId, claimToken));
  statements.push(responseStatement(env, previewId, claimToken, ctx.requestId));
  const idempotencyWrite = idempotencyStatement(env, idempotency, ctx, now, previewId, claimToken);
  if (idempotencyWrite !== null) statements.push(idempotencyWrite);
  const idempotencyAssert = idempotencyAssertionStatement(env, idempotency, ctx, previewId, claimToken);
  if (idempotencyAssert !== null) statements.push(idempotencyAssert);
  statements.push(consumeStatement(env, previewId, claimToken, now));
  statements.push(finalResponseStatement(env, previewId, claimToken, now));

  const results = await env.DB.batch(statements);
  if (batchReturnedRow(results[0]) === null) {
    const failure = batchReturnedRow(results[1]);
    const code = typeof failure?.projection_claim_error === "string" ? failure.projection_claim_error : "stale_projection_preview";
    throw new Error(code);
  }
  const final = batchReturnedRow(results.at(-1));
  if (final === null || typeof final.applied_response_json !== "string") throw new Error("projection_apply_failed");
  const envelope = parseJson(final.applied_response_json, "projection_apply_failed");
  if (envelope?.code !== APPLY_CODE || envelope?.data === undefined) throw new Error("projection_apply_failed");
  return envelope.data;
}
