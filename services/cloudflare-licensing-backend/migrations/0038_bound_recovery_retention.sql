-- Keep operation identity after erasing the expired response so a retry cannot
-- become a new issuance. Only this irreversible payload-erasure transition is new.
DROP TRIGGER tr_bound_operation_immutable;
CREATE TRIGGER tr_bound_operation_immutable BEFORE UPDATE ON device_bound_operations
WHEN NEW.key_id IS NOT OLD.key_id OR NEW.purpose IS NOT OLD.purpose
  OR NEW.operation_id IS NOT OLD.operation_id OR NEW.invocation_id IS NOT OLD.invocation_id
  OR NEW.request_digest IS NOT OLD.request_digest OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.binding_id IS NOT OLD.binding_id OR NEW.lease_id IS NOT OLD.lease_id
  OR NEW.committed_at IS NOT OLD.committed_at OR NEW.retain_until IS NOT OLD.retain_until
  OR NOT (
    (OLD.status='prepared' AND NEW.status='complete' AND NEW.response_json=OLD.response_json)
    OR (OLD.status='complete' AND NEW.status='complete' AND OLD.retain_until<=unixepoch() AND NEW.response_json='')
  )
BEGIN SELECT RAISE(ABORT, 'operation_result_immutable'); END;

CREATE TRIGGER tr_bound_operation_tombstone BEFORE DELETE ON device_bound_operations
BEGIN SELECT RAISE(ABORT, 'operation_tombstone_required'); END;

-- INSERT OR REPLACE can bypass DELETE triggers when recursive_triggers is off.
CREATE TRIGGER tr_bound_operation_no_replace BEFORE INSERT ON device_bound_operations
WHEN EXISTS (SELECT 1 FROM device_bound_operations o WHERE
  (o.key_id=NEW.key_id AND o.purpose=NEW.purpose AND o.operation_id=NEW.operation_id)
  OR o.invocation_id=NEW.invocation_id)
BEGIN SELECT RAISE(ABORT, 'operation_tombstone_required'); END;

CREATE INDEX idx_bound_operation_payload_cleanup ON device_bound_operations(retain_until)
WHERE status='complete' AND response_json<>'';
CREATE INDEX idx_bound_consumed_attempt_cleanup ON device_bound_authorizations(recovery_until)
WHERE status='consumed';
