// Portable license-policy/template stamp mechanics.
// Worker-safe: no node:/Buffer, only standard globals. Runs raw under node --test.
//
// A policy is a reusable template. `stampFromPolicy` is a PURE function: policy + operator overrides +
// now -> the EXISTING EntitlementInput shape (which createEntitlement writes byte-identically) PLUS the
// capacity + frozen-trial state. The D1 publication statement lives in
// @licensecc/cloudflare-runtime/entitlements/policy_store so this package stays portable.
//
// Policies are STAMP-TIME templates (frozen): the entitlement copies the defaults at create time and is
// thereafter its own source of truth; entitlements.policy_id is advisory provenance (no FK, no live-link).
// Trial timing for from_first_activation/from_first_use is computed at the first protected device activation, NOT here.
//
// Design: docs/superpowers/plans/2026-06-25-essential-features-implementation-plan.md (Workstream A).

const TRIAL_BASES = new Set(["from_issue", "from_first_activation", "from_first_use"]);

/**
 * The three policy types, in canonical order. This is the ONE runtime source of the enum that the
 * admin validators, UI form, OpenAPI spec crosscheck, and SQL CHECK backstops all mirror. A policy
 * stamps a protected grant, which never has a seat pool, so there is no floating type.
 */
export const POLICY_TYPES = /** @type {const} */ (["trial", "node_locked", "subscription"]);

/**
 * Pure stamp. `overrides` MUST carry the target tuple (project, feature, license_fingerprint) and MAY
 * override any default. Returns { input, capacity, trial }:
 *   input    -> EntitlementInput for createEntitlement (status forced 'active' on a fresh stamp)
 *   capacity -> { max_active_devices }: a protected grant takes only its device limit from a policy
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
    // clamps it (server-side, at the first protected device activation) — so leave null at stamp time.
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
    status: "active",
    valid_from: validFrom,
    valid_until: validUntil,
    notes: overrides.notes ?? "",
    customer_id: overrides.customer_id ?? null,
    license_id: overrides.license_id ?? null,
  };

  const capacity = {
    max_active_devices: overrides.max_active_devices ?? policy.max_active_devices,
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
