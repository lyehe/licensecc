-- Keep oldest eligible-attempt probes and sweeps independent of retained
-- consumed recovery history. No retention or authority transition changes.
CREATE INDEX idx_bound_unconsumed_attempt_cleanup ON device_bound_authorizations(expires_at)
WHERE status IN ('pending','approved','denied');
