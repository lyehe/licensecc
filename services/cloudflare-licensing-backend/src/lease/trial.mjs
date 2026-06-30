// trial.mjs — server-computed trial timing for /v1/activate (Stage 4).
//
// Worker-safe: no node:/Buffer, only standard globals. Runs raw under node --test.
//
// A trial is FROZEN onto the entitlement at policy-stamp time (is_trial + trial_expiration_basis +
// trial_duration_sec + trial_one_per_device + trial_require_device_proof; see policy.mjs). The lease
// hot path reads those columns from the SAME entitlements row (NO join to entitlement_policies) and
// computes the trial deadline server-side at activation:
//
//   - from_issue: the clock already started at stamp time (valid_until was set then). Nothing to
//     stamp here; valid_to clamps to valid_until as usual.
//   - from_first_activation / from_first_use (treated identically in P1): the clock starts on the
//     FIRST activation. We stamp trial_started_at = now WRITE-ONCE (UPDATE ... WHERE
//     trial_started_at IS NULL) and clamp the lease valid_to to
//     min(valid_until, trial_started_at + trial_duration_sec).
//
// Device lock (anti-trial-farming), evaluated BEFORE any mutation, fail-closed:
//   - trial_require_device_proof: a verified ECDSA request-proof is mandatory; absent -> deny
//     (trial_device_proof_required).
//   - trial_one_per_device: once an entitlement has a trial_device_hash, a DIFFERENT lock key is
//     denied (trial_device_locked). The lock key is the PROVEN device_key_id when a request-proof
//     verified, else the self-asserted device_key_id.
//
// Design: docs/superpowers/plans/2026-06-25-essential-features-implementation-plan.md (Stage 4).

export const TRIAL_DEVICE_LOCKED = "trial_device_locked";
export const TRIAL_DEVICE_PROOF_REQUIRED = "trial_device_proof_required";

// Bases whose clock starts at the first activation (vs. from_issue, which started at stamp time).
const ACTIVATION_BASES = new Set(["from_first_activation", "from_first_use"]);

function bounded(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The device lock key for a trial: the PROVEN ECDSA device_key_id when a request-proof verified,
 * else the self-asserted device_key_id from the request. Empty string is never a valid lock key.
 */
export function trialLockKey(deviceKeyId, proofVerified) {
  void proofVerified; // the value is identical; proofVerified gates *requirement*, not the key
  return typeof deviceKeyId === "string" && deviceKeyId.length > 0 ? deviceKeyId : "";
}

/**
 * PURE trial-activation decision. Reads the frozen trial columns off the already-fetched lease
 * entitlement row plus the request's lock key / proof state / now, and returns one of:
 *
 *   { trial:false }
 *       not a trial entitlement -> leave the existing lease flow untouched.
 *
 *   { trial:true, deny:<code> }
 *       fail-closed device-lock denial (caller returns 403, NO mutation).
 *
 *   { trial:true, stamp:boolean, trialExpiresAt:number|null, lockKey:string }
 *       allow. `stamp` => write trial_started_at=now + trial_device_hash=lockKey WRITE-ONCE in the
 *       lease batch. `trialExpiresAt` is the clamp deadline (trial_started_at + trial_duration_sec)
 *       BEFORE the valid_until clamp, or null when the basis needs no activation clock (from_issue).
 *
 * `row` must carry: is_trial, trial_expiration_basis, trial_duration_sec, trial_one_per_device,
 * trial_require_device_proof, trial_started_at, trial_device_hash.
 */
export function evaluateTrialActivation(row, lockKey, proofVerified, now) {
  if (!row || Number(row.is_trial) !== 1) return { trial: false };

  // Fail-closed: a trial that REQUIRES a verified device proof denies without one (before any lock
  // comparison, so the proof requirement cannot be sidestepped by a self-asserted key).
  if (Number(row.trial_require_device_proof) === 1 && !proofVerified) {
    return { trial: true, deny: TRIAL_DEVICE_PROOF_REQUIRED };
  }

  // One-trial-per-device: once a lock key is frozen on the row, a DIFFERENT key is denied. An empty
  // incoming lock key never matches a frozen non-empty one -> denied (fail-closed).
  if (Number(row.trial_one_per_device) === 1) {
    const frozen = typeof row.trial_device_hash === "string" ? row.trial_device_hash : "";
    if (frozen.length > 0 && frozen !== lockKey) {
      return { trial: true, deny: TRIAL_DEVICE_LOCKED };
    }
  }

  const basis = typeof row.trial_expiration_basis === "string" ? row.trial_expiration_basis : "from_issue";
  const durationSec = Number(row.trial_duration_sec) > 0 ? Number(row.trial_duration_sec) : 0;

  // from_issue: the clock started at stamp time (valid_until already encodes it). No activation
  // stamp, no extra deadline beyond the usual valid_until clamp.
  if (!ACTIVATION_BASES.has(basis)) {
    return { trial: true, stamp: false, trialExpiresAt: null, lockKey };
  }

  const started = bounded(row.trial_started_at);
  if (started !== null) {
    // Already activated (idempotent re-activation): the deadline derives from the PERSISTED start.
    const deadline = durationSec > 0 ? started + durationSec : null;
    return { trial: true, stamp: false, trialExpiresAt: deadline, lockKey };
  }

  // First activation: the clock starts now (the WRITE-ONCE stamp persists it).
  const deadline = durationSec > 0 ? now + durationSec : null;
  return { trial: true, stamp: true, trialExpiresAt: deadline, lockKey };
}

/**
 * The WRITE-ONCE trial-activation side-write, gated so it lands ONLY when (a) the clock has not
 * already started (trial_started_at IS NULL) AND (b) the cap-guard lease row for this exact
 * issuance landed in the SAME transaction (EXISTS over lease_issuance at issued_at=now for this
 * device). Riding the same batch as the cap INSERT makes "lease issued" and "trial clock started"
 * atomic: a capped issuance (no lease_issuance row) leaves trial_started_at NULL, and a concurrent
 * second activation cannot double-start the clock (the IS NULL guard).
 *
 * Bind order (8 params):
 *   now (trial_started_at), lockKey (trial_device_hash),
 *   project, feature, license_fingerprint,                 (the entitlement row to update)
 *   project, feature, license_fingerprint, device_key_id, now  (the EXISTS over lease_issuance)
 */
export function buildTrialActivationStamp(env, body, lockKey, now) {
  return env.DB.prepare(
    "UPDATE entitlements SET trial_started_at = ?, trial_device_hash = ? " +
      "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND trial_started_at IS NULL " +
      "AND EXISTS (SELECT 1 FROM lease_issuance li WHERE li.project = ? AND li.feature = ? " +
      "AND li.license_fingerprint = ? AND li.device_key_id = ? AND li.issued_at = ?)",
  ).bind(
    now,
    lockKey,
    body.project,
    body.feature,
    body.license_fingerprint,
    body.project,
    body.feature,
    body.license_fingerprint,
    body.device_key_id,
    now,
  );
}
