// D1 adapter for the portable trial activation decision (evaluateTrialActivation in
// @licensecc/licensing-domain/lease/trial), and the SQL form of the deadline it enforces.

const SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

// When a legacy trial ends, as SQL over the entitlements row aliased `e`. Keep aligned with
// evaluateTrialActivation: a trial has a clock only for an activation basis with a positive
// duration, ending trial_started_at + trial_duration_sec (NULL until the first activation stamps the
// start; there is no prospective start). Every other trial has no clock, and valid_until alone
// governs. Callers clamp to valid_until as the lease path does. `e` is an owner-controlled alias.
export function legacyTrialDeadlineSql(e) {
  if (!SQL_ALIAS.test(e)) throw new TypeError("legacyTrialDeadlineSql needs an SQL alias");
  return `(CASE WHEN ${e}.trial_expiration_basis IN ('from_first_activation','from_first_use') AND ${e}.trial_duration_sec>0
    THEN ${e}.trial_started_at+${e}.trial_duration_sec ELSE ${e}.valid_until END)`;
}

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
