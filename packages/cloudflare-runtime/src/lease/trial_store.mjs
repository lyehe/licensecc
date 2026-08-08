// D1 adapter for the portable trial activation decision.

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
