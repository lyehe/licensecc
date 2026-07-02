// policy.mjs — license-policy/template STAMP mechanics (essential-features Workstream A keystone).
// Worker-safe: no node:/Buffer, only standard globals. Runs raw under node --test.
//
// A policy is a reusable template. `stampFromPolicy` is a PURE function: policy + operator overrides +
// now -> the EXISTING EntitlementInput shape (which createEntitlement writes byte-identically) PLUS the
// capacity + frozen-trial side-state. `buildPolicyStampStatement` produces the single UPDATE that writes
// that side-state onto the just-inserted row; it rides createEntitlement's `extraStatements` seam so it
// commits in the SAME atomic batch as the INSERT — the INSERT SQL + ENTITLEMENT_COLUMNS are never touched.
//
// Policies are STAMP-TIME templates (frozen): the entitlement copies the defaults at create time and is
// thereafter its own source of truth; entitlements.policy_id is advisory provenance (no FK, no live-link).
// Trial timing for from_first_activation/from_first_use is computed at /v1/activate, NOT here.
//
// Design: docs/superpowers/plans/2026-06-25-essential-features-implementation-plan.md (Workstream A).

const TRIAL_BASES = new Set(["from_issue", "from_first_activation", "from_first_use"]);

/**
 * Pure stamp. `overrides` MUST carry the target tuple (project, feature, license_fingerprint) and MAY
 * override any default. Returns { input, capacity, trial }:
 *   input    -> EntitlementInput for createEntitlement (status forced 'active' on a fresh stamp)
 *   capacity -> { pool_size, max_active_devices, max_borrow_sec }
 *   trial    -> { is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device, trial_require_device_proof }
 */
export function stampFromPolicy(policy, overrides, now) {
  const isTrial = policy.type === "trial";
  const basis = TRIAL_BASES.has(policy.trial_expiration_basis) ? policy.trial_expiration_basis : "from_issue";
  const nonExpiring = policy.expiry_strategy === "non_expiring";

  // valid_from: explicit override wins; else policy offset from now; else open start.
  let validFrom =
    overrides.valid_from !== undefined
      ? overrides.valid_from
      : typeof policy.valid_from_offset_sec === "number"
        ? now + policy.valid_from_offset_sec
        : null;

  // valid_until: explicit override wins; else non-expiring -> null; else trial/subscription duration.
  let validUntil;
  if (overrides.valid_until !== undefined) {
    validUntil = overrides.valid_until;
  } else if (nonExpiring) {
    validUntil = null;
  } else if (isTrial) {
    // from_issue: clock starts now. from_first_activation/from_first_use: open until first activation
    // clamps it (server-side, in /v1/activate) — so leave null at stamp time.
    validUntil = basis === "from_issue" && policy.trial_duration_sec > 0 ? (validFrom ?? now) + policy.trial_duration_sec : null;
  } else if (typeof policy.duration_sec === "number") {
    validUntil = (validFrom ?? now) + policy.duration_sec;
  } else {
    validUntil = null;
  }

  // Never surface valid_from >= valid_until (mirrors order-ingest createFields): open the start instead.
  if (validFrom !== null && validUntil !== null && validFrom >= validUntil) {
    validFrom = null;
  }

  const input = {
    project: overrides.project,
    feature: overrides.feature,
    license_fingerprint: overrides.license_fingerprint,
    device_hash: overrides.device_hash ?? "",
    status: "active",
    assertion_ttl_seconds: overrides.assertion_ttl_seconds ?? policy.assertion_ttl_seconds,
    valid_from: validFrom,
    valid_until: validUntil,
    notes: overrides.notes ?? "",
    customer_id: overrides.customer_id ?? null,
    license_id: overrides.license_id ?? null,
  };

  const capacity = {
    pool_size: overrides.pool_size ?? policy.pool_size,
    max_active_devices: overrides.max_active_devices ?? policy.max_active_devices,
    max_borrow_sec: overrides.max_borrow_sec ?? policy.max_borrow_sec,
    // Metering quota (audit R6.3): a stamped entitlement inherits the policy's per-period consumption
    // quota + window, so a "metered" policy makes meterUsage enforce it end-to-end.
    meter_quota: overrides.meter_quota ?? policy.meter_quota ?? 0,
    meter_period_sec: overrides.meter_period_sec ?? policy.meter_period_sec ?? 2592000,
  };

  const trial = isTrial
    ? {
        is_trial: 1,
        trial_expiration_basis: basis,
        trial_duration_sec: policy.trial_duration_sec,
        trial_one_per_device: policy.trial_one_per_device,
        trial_require_device_proof: policy.trial_require_device_proof,
      }
    : { is_trial: 0, trial_expiration_basis: null, trial_duration_sec: 0, trial_one_per_device: 0, trial_require_device_proof: 0 };

  return { input, capacity, trial };
}

/**
 * The atomic capacity + frozen-trial + provenance side-write, applied to the row createEntitlement just
 * inserted. Passed to createEntitlement(..., extraStatements=[this]) so it lands in the SAME batch. Does
 * NOT bump revocation_seq or updated_at (the INSERT already did) — it only sets the side-state columns,
 * none of which are in ENTITLEMENT_COLUMNS.
 */
export function buildPolicyStampStatement(env, key, policyId, capacity, trial) {
  return env.DB.prepare(
    "UPDATE entitlements SET policy_id = ?, pool_size = ?, max_active_devices = ?, max_borrow_sec = ?, " +
      "meter_quota = ?, meter_period_sec = ?, " +
      "is_trial = ?, trial_expiration_basis = ?, trial_duration_sec = ?, trial_one_per_device = ?, trial_require_device_proof = ? " +
      "WHERE project = ? AND feature = ? AND license_fingerprint = ?",
  ).bind(
    policyId,
    capacity.pool_size,
    capacity.max_active_devices,
    capacity.max_borrow_sec,
    capacity.meter_quota,
    capacity.meter_period_sec,
    trial.is_trial,
    trial.trial_expiration_basis,
    trial.trial_duration_sec,
    trial.trial_one_per_device,
    trial.trial_require_device_proof,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
}
