// D1 publication adapters for the portable policy stamp, and for the device limit a create without
// a policy sets on its own.

// A policy stamps a protected grant's provenance, device limit and trial state.
export function buildPolicyStampStatement(env, key, policyId, capacity, trial) {
  return env.DB.prepare(
    "UPDATE entitlements SET policy_id = ?, max_active_devices = ?, " +
      "is_trial = ?, trial_expiration_basis = ?, trial_duration_sec = ?, trial_one_per_device = ? " +
      // createEntitlement's first batch statement is an optimistic claim. Keep
      // this side-write contingent on that claim so a stale create/upsert cannot
      // stamp a newer entitlement and accidentally enable its audit projection.
      "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND changes() = 1",
  ).bind(
    policyId,
    capacity.max_active_devices,
    trial.is_trial,
    trial.trial_expiration_basis,
    trial.trial_duration_sec,
    trial.trial_one_per_device,
    key.project,
    key.feature,
    key.license_fingerprint,
  );
}

// The no-policy counterpart of the stamp: a create that selects no policy may set its own device
// limit. It is the same claim-contingent side-write (changes() = 1), so a lost claim writes nothing,
// and it runs before the create's audit and replay records so they describe the limit it set.
export function buildDeviceLimitStatement(env, key, maxActiveDevices) {
  return env.DB.prepare(
    "UPDATE entitlements SET max_active_devices = ? WHERE project = ? AND feature = ? AND license_fingerprint = ? AND changes() = 1",
  ).bind(maxActiveDevices, key.project, key.feature, key.license_fingerprint);
}
