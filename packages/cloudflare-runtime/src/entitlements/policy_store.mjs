// D1 publication adapter for the portable policy stamp.

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
