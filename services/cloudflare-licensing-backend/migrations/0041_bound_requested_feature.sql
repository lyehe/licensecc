-- NULL preserves enrollment by older clients. New clients bind consent to the
-- configured feature before registration; approval cannot broaden that intent.
ALTER TABLE device_bound_authorizations ADD COLUMN requested_feature TEXT
  CHECK(requested_feature IS NULL OR (length(requested_feature) BETWEEN 1 AND 15
    AND requested_feature NOT GLOB '*[^A-Za-z0-9_.:-]*'));

CREATE TRIGGER tr_bound_requested_feature_immutable BEFORE UPDATE OF requested_feature ON device_bound_authorizations
WHEN NEW.requested_feature IS NOT OLD.requested_feature
BEGIN SELECT RAISE(ABORT, 'authorization_intent_immutable'); END;

CREATE TRIGGER tr_bound_requested_feature_insert BEFORE INSERT ON device_bound_authorizations
WHEN NEW.requested_feature IS NOT NULL AND NEW.feature IS NOT NULL AND NEW.feature<>NEW.requested_feature
BEGIN SELECT RAISE(ABORT, 'authorization_feature_mismatch'); END;

CREATE TRIGGER tr_bound_requested_feature_update BEFORE UPDATE OF feature,requested_feature ON device_bound_authorizations
WHEN NEW.requested_feature IS NOT NULL AND NEW.feature IS NOT NULL AND NEW.feature<>NEW.requested_feature
BEGIN SELECT RAISE(ABORT, 'authorization_feature_mismatch'); END;
