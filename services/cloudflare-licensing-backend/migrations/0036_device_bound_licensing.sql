-- Protected-mode state is additive. No existing entitlement is opted in.
ALTER TABLE entitlements ADD COLUMN enforcement_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (enforcement_mode IN ('legacy', 'device_bound_v1'));
ALTER TABLE entitlements ADD COLUMN authority_revision INTEGER NOT NULL DEFAULT 0
  CHECK (authority_revision = CAST(authority_revision AS BIGINT) AND authority_revision BETWEEN 0 AND 9007199254740991);
ALTER TABLE customers ADD COLUMN authority_revision INTEGER NOT NULL DEFAULT 0
  CHECK (authority_revision = CAST(authority_revision AS BIGINT) AND authority_revision BETWEEN 0 AND 9007199254740991);

CREATE TABLE device_bound_devices (
  id TEXT NOT NULL PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  project TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  public_key_spki TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  provider_reported TEXT NOT NULL DEFAULT '',
  assurance TEXT NOT NULL DEFAULT 'proof_verified' CHECK (assurance IN ('proof_verified', 'hardware_attested')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision = CAST(revision AS BIGINT) AND revision BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  last_proof_at INTEGER NOT NULL CHECK (last_proof_at = CAST(last_proof_at AS BIGINT) AND last_proof_at BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX idx_bound_devices_customer ON device_bound_devices(customer_id, project, id);

CREATE TABLE device_bound_authorizations (
  handle_hash TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL,
  project TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_spki TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL,
  client_state TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'consumed', 'denied')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision = CAST(revision AS BIGINT) AND revision BETWEEN 0 AND 9007199254740991),
  customer_id TEXT REFERENCES customers(id),
  feature TEXT,
  license_fingerprint TEXT,
  code_hash TEXT,
  code_expires_at INTEGER CHECK (code_expires_at = CAST(code_expires_at AS BIGINT) AND code_expires_at BETWEEN 0 AND 9007199254740991),
  approval_ciphertext TEXT,
  created_at INTEGER NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at = CAST(expires_at AS BIGINT) AND expires_at > created_at AND expires_at <= 9007199254740991),
  consumed_invocation_id TEXT,
  consumed_operation_id TEXT,
  recovery_until INTEGER CHECK (recovery_until = CAST(recovery_until AS BIGINT) AND recovery_until BETWEEN 0 AND 9007199254740991),
  CHECK (
    (status IN ('pending','denied') AND customer_id IS NULL AND feature IS NULL
      AND license_fingerprint IS NULL AND code_hash IS NULL AND code_expires_at IS NULL
      AND approval_ciphertext IS NULL)
    OR (status IN ('approved','consumed') AND customer_id IS NOT NULL AND feature IS NOT NULL
      AND license_fingerprint IS NOT NULL AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL
      AND code_expires_at >= created_at AND code_expires_at <= expires_at)
  ),
  CHECK (
    (status != 'consumed' AND consumed_invocation_id IS NULL AND consumed_operation_id IS NULL AND recovery_until IS NULL)
    OR (status = 'consumed' AND consumed_invocation_id IS NOT NULL AND consumed_operation_id IS NOT NULL
      AND recovery_until IS NOT NULL AND recovery_until > created_at AND approval_ciphertext IS NULL)
  )
);
CREATE INDEX idx_bound_authorizations_expiry ON device_bound_authorizations(expires_at);

CREATE TABLE device_bound_bindings (
  id TEXT NOT NULL PRIMARY KEY,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES device_bound_devices(id),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retiring', 'released')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation = CAST(generation AS BIGINT) AND generation BETWEEN 1 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision = CAST(revision AS BIGINT) AND revision BETWEEN 0 AND 9007199254740991),
  hold_until INTEGER NOT NULL DEFAULT 0 CHECK (hold_until = CAST(hold_until AS BIGINT) AND hold_until BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at = CAST(updated_at AS BIGINT) AND updated_at BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY (project, feature, license_fingerprint) REFERENCES entitlements(project, feature, license_fingerprint)
);
CREATE UNIQUE INDEX idx_bound_bindings_active_device
  ON device_bound_bindings(project, feature, license_fingerprint, device_id) WHERE state = 'active';
CREATE INDEX idx_bound_bindings_capacity ON device_bound_bindings(project, feature, license_fingerprint, state, hold_until);
CREATE INDEX idx_bound_bindings_device ON device_bound_bindings(device_id, state);

CREATE TABLE device_bound_challenges (
  id TEXT NOT NULL PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('exchange', 'renew')),
  subject_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at = CAST(created_at AS BIGINT) AND created_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at = CAST(expires_at AS BIGINT) AND expires_at > created_at AND expires_at <= 9007199254740991),
  consumed_invocation_id TEXT
);
CREATE INDEX idx_bound_challenges_expiry ON device_bound_challenges(expires_at);

-- A fresh invocation identity prevents a cached operation from authorizing a
-- second execution of dependent writes. No raw code, verifier or proof is kept.
CREATE TABLE device_bound_operations (
  key_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('exchange', 'renew', 'retire')),
  operation_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  binding_id TEXT NOT NULL,
  lease_id TEXT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'complete')),
  response_json TEXT NOT NULL,
  committed_at INTEGER NOT NULL CHECK (committed_at = CAST(committed_at AS BIGINT) AND committed_at BETWEEN 0 AND 9007199254740991),
  retain_until INTEGER NOT NULL CHECK (retain_until = CAST(retain_until AS BIGINT) AND retain_until > committed_at AND retain_until <= 9007199254740991),
  PRIMARY KEY (key_id, purpose, operation_id)
);
CREATE INDEX idx_bound_operations_retention ON device_bound_operations(retain_until);

CREATE TABLE device_bound_leases (
  id TEXT NOT NULL PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES device_bound_bindings(id),
  generation INTEGER NOT NULL CHECK (generation = CAST(generation AS BIGINT) AND generation BETWEEN 1 AND 9007199254740991),
  entitlement_revision INTEGER NOT NULL CHECK (entitlement_revision = CAST(entitlement_revision AS BIGINT) AND entitlement_revision BETWEEN 0 AND 9007199254740991),
  invocation_id TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL CHECK (issued_at = CAST(issued_at AS BIGINT) AND issued_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK (expires_at = CAST(expires_at AS BIGINT) AND expires_at > issued_at AND expires_at - issued_at <= 86400),
  accept_until INTEGER NOT NULL CHECK (accept_until = CAST(accept_until AS BIGINT) AND accept_until = expires_at + 120 AND accept_until <= 9007199254740991),
  token TEXT NOT NULL
);
CREATE INDEX idx_bound_leases_binding_expiry ON device_bound_leases(binding_id, accept_until);

CREATE TABLE device_bound_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL UNIQUE,
  binding_id TEXT NOT NULL REFERENCES device_bound_bindings(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('exchange', 'renew', 'retire')),
  actor TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at = CAST(occurred_at AS BIGINT) AND occurred_at BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX idx_bound_events_customer ON device_bound_events(customer_id, id);

-- Used only inside a batch and deleted before commit. A failing CHECK forces
-- the complete transaction to roll back, including a zero-row authorization.
CREATE TABLE device_bound_commit_checks (
  invocation_id TEXT NOT NULL PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Authoritative revisions must advance even for existing operator/fulfillment
-- writers that do not yet know about the new column.
CREATE TRIGGER tr_bound_entitlement_revision AFTER UPDATE ON entitlements
WHEN NEW.status IS NOT OLD.status OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.valid_from IS NOT OLD.valid_from OR NEW.valid_until IS NOT OLD.valid_until
  OR NEW.max_active_devices IS NOT OLD.max_active_devices OR NEW.lease_seconds IS NOT OLD.lease_seconds
  OR NEW.enforcement_mode IS NOT OLD.enforcement_mode OR NEW.revocation_seq IS NOT OLD.revocation_seq
  OR NEW.pool_size IS NOT OLD.pool_size OR NEW.is_trial IS NOT OLD.is_trial
  OR NEW.trial_started_at IS NOT OLD.trial_started_at OR NEW.trial_duration_sec IS NOT OLD.trial_duration_sec
  OR NEW.trial_expiration_basis IS NOT OLD.trial_expiration_basis
  OR NEW.trial_one_per_device IS NOT OLD.trial_one_per_device
  OR NEW.trial_require_device_proof IS NOT OLD.trial_require_device_proof
  OR NEW.trial_device_hash IS NOT OLD.trial_device_hash
BEGIN
  UPDATE entitlements SET authority_revision = OLD.authority_revision + 1
  WHERE project = NEW.project AND feature = NEW.feature AND license_fingerprint = NEW.license_fingerprint;
END;

CREATE TRIGGER tr_bound_mode_no_downgrade BEFORE UPDATE OF enforcement_mode ON entitlements
WHEN OLD.enforcement_mode = 'device_bound_v1' AND NEW.enforcement_mode != OLD.enforcement_mode
BEGIN SELECT RAISE(ABORT, 'protected_mode_downgrade'); END;

-- Existing v201 leases have local-calendar/clock semantics and issuance/seat
-- history may already have been pruned. Empty tables cannot establish drain.
-- Backend/release owner: replace this guard only with the Phase 7 reviewed
-- cutover-evidence protocol and its restore/legacy-client acceptance tests.
-- New protected-only cohorts can be inserted; no old entitlement auto-converts.
CREATE TRIGGER tr_bound_mode_requires_migration BEFORE UPDATE OF enforcement_mode ON entitlements
WHEN OLD.enforcement_mode = 'legacy' AND NEW.enforcement_mode = 'device_bound_v1'
BEGIN SELECT RAISE(ABORT, 'protected_mode_migration_required'); END;

CREATE TRIGGER tr_bound_entitlement_revision_no_reset BEFORE UPDATE OF authority_revision ON entitlements
WHEN NEW.authority_revision < OLD.authority_revision
BEGIN SELECT RAISE(ABORT, 'authority_revision_cannot_shrink'); END;
CREATE TRIGGER tr_bound_customer_revision AFTER UPDATE OF status ON customers
WHEN NEW.status IS NOT OLD.status
BEGIN UPDATE customers SET authority_revision=OLD.authority_revision+1 WHERE id=NEW.id; END;
CREATE TRIGGER tr_bound_customer_revision_no_reset BEFORE UPDATE OF authority_revision ON customers
WHEN NEW.authority_revision < OLD.authority_revision
BEGIN SELECT RAISE(ABORT, 'authority_revision_cannot_shrink'); END;

CREATE TRIGGER tr_bound_capacity_decrease BEFORE UPDATE OF max_active_devices ON entitlements
WHEN NEW.enforcement_mode = 'device_bound_v1' AND NEW.max_active_devices < (
  SELECT COUNT(*) FROM device_bound_bindings b WHERE b.project = OLD.project
  AND b.feature = OLD.feature AND b.license_fingerprint = OLD.license_fingerprint
  AND (b.state = 'active' OR (b.state = 'retiring' AND b.hold_until > unixepoch()))
)
BEGIN SELECT RAISE(ABORT, 'capacity_in_use'); END;

CREATE TRIGGER tr_bound_owner_change BEFORE UPDATE OF customer_id ON entitlements
WHEN NEW.customer_id IS NOT OLD.customer_id AND EXISTS (
  SELECT 1 FROM device_bound_bindings b WHERE b.project = OLD.project
  AND b.feature = OLD.feature AND b.license_fingerprint = OLD.license_fingerprint
  AND (b.state = 'active' OR (b.state = 'retiring' AND b.hold_until > unixepoch()))
)
BEGIN SELECT RAISE(ABORT, 'capacity_in_use'); END;

CREATE TRIGGER tr_bound_device_identity_immutable BEFORE UPDATE OF id, customer_id, project, key_id, public_key_spki ON device_bound_devices
WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.project IS NOT OLD.project
  OR NEW.key_id IS NOT OLD.key_id OR NEW.public_key_spki IS NOT OLD.public_key_spki
BEGIN SELECT RAISE(ABORT, 'device_identity_immutable'); END;

CREATE TRIGGER tr_bound_binding_identity_immutable BEFORE UPDATE OF id, project, feature, license_fingerprint, device_id ON device_bound_bindings
WHEN NEW.id IS NOT OLD.id OR NEW.project IS NOT OLD.project OR NEW.feature IS NOT OLD.feature
  OR NEW.license_fingerprint IS NOT OLD.license_fingerprint OR NEW.device_id IS NOT OLD.device_id
BEGIN SELECT RAISE(ABORT, 'binding_identity_immutable'); END;

CREATE TRIGGER tr_bound_binding_hold_monotonic BEFORE UPDATE OF hold_until ON device_bound_bindings
WHEN NEW.hold_until < OLD.hold_until
BEGIN SELECT RAISE(ABORT, 'binding_hold_cannot_shrink'); END;

CREATE TRIGGER tr_bound_binding_revision_no_reset BEFORE UPDATE OF revision,generation ON device_bound_bindings
WHEN NEW.revision < OLD.revision OR NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT, 'binding_revision_cannot_shrink'); END;
CREATE TRIGGER tr_bound_device_revision_no_reset BEFORE UPDATE OF revision ON device_bound_devices
WHEN NEW.revision < OLD.revision
BEGIN SELECT RAISE(ABORT, 'device_revision_cannot_shrink'); END;
CREATE TRIGGER tr_bound_attempt_revision_no_reset BEFORE UPDATE OF revision ON device_bound_authorizations
WHEN NEW.revision < OLD.revision
BEGIN SELECT RAISE(ABORT, 'authorization_revision_cannot_shrink'); END;

CREATE TRIGGER tr_bound_binding_no_resurrection BEFORE UPDATE OF state ON device_bound_bindings
WHEN (OLD.state = 'retiring' AND NEW.state = 'active') OR (OLD.state = 'released' AND NEW.state != 'released')
BEGIN SELECT RAISE(ABORT, 'binding_retirement_terminal'); END;

CREATE TRIGGER tr_bound_binding_no_early_release BEFORE UPDATE OF state ON device_bound_bindings
WHEN NEW.state = 'released' AND (OLD.state = 'active' OR OLD.hold_until > unixepoch())
BEGIN SELECT RAISE(ABORT, 'binding_hold_active'); END;

CREATE TRIGGER tr_bound_binding_keep_tombstone BEFORE DELETE ON device_bound_bindings
BEGIN SELECT RAISE(ABORT, 'binding_tombstone_required'); END;
CREATE TRIGGER tr_bound_device_keep_tombstone BEFORE DELETE ON device_bound_devices
BEGIN SELECT RAISE(ABORT, 'device_tombstone_required'); END;
CREATE TRIGGER tr_bound_device_disable AFTER UPDATE OF status ON device_bound_devices
WHEN NEW.status != OLD.status
BEGIN
  UPDATE device_bound_devices SET revision=OLD.revision+1 WHERE id=NEW.id;
  UPDATE device_bound_bindings SET state='retiring',generation=generation+1,revision=revision+1,updated_at=unixepoch()
    WHERE device_id=NEW.id AND state='active' AND NEW.status='disabled';
END;

CREATE TRIGGER tr_bound_attempt_intent_immutable BEFORE UPDATE OF handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,created_at,expires_at ON device_bound_authorizations
WHEN NEW.handle_hash IS NOT OLD.handle_hash OR NEW.client_id IS NOT OLD.client_id
  OR NEW.project IS NOT OLD.project OR NEW.key_id IS NOT OLD.key_id OR NEW.public_key_spki IS NOT OLD.public_key_spki
  OR NEW.redirect_uri IS NOT OLD.redirect_uri OR NEW.client_state IS NOT OLD.client_state
  OR NEW.pkce_challenge IS NOT OLD.pkce_challenge OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'authorization_intent_immutable'); END;
CREATE TRIGGER tr_bound_attempt_terminal BEFORE UPDATE OF status ON device_bound_authorizations
WHEN NEW.status != OLD.status AND NOT ((OLD.status='pending' AND NEW.status IN ('approved','denied'))
  OR (OLD.status='approved' AND NEW.status='consumed'))
BEGIN SELECT RAISE(ABORT, 'authorization_transition_invalid'); END;

CREATE TRIGGER tr_bound_attempt_approval_immutable BEFORE UPDATE OF customer_id,feature,license_fingerprint,code_hash,code_expires_at ON device_bound_authorizations
WHEN OLD.status IN ('approved','consumed') AND (NEW.customer_id IS NOT OLD.customer_id
  OR NEW.feature IS NOT OLD.feature OR NEW.license_fingerprint IS NOT OLD.license_fingerprint
  OR NEW.code_hash IS NOT OLD.code_hash OR NEW.code_expires_at IS NOT OLD.code_expires_at)
BEGIN SELECT RAISE(ABORT, 'authorization_approval_immutable'); END;

CREATE TRIGGER tr_bound_attempt_consumption_immutable BEFORE UPDATE OF consumed_invocation_id,consumed_operation_id,recovery_until ON device_bound_authorizations
WHEN OLD.status='consumed' AND (NEW.consumed_invocation_id IS NOT OLD.consumed_invocation_id
  OR NEW.consumed_operation_id IS NOT OLD.consumed_operation_id OR NEW.recovery_until IS NOT OLD.recovery_until)
BEGIN SELECT RAISE(ABORT, 'authorization_consumption_immutable'); END;

CREATE TRIGGER tr_bound_challenge_immutable BEFORE UPDATE ON device_bound_challenges
WHEN NEW.id IS NOT OLD.id OR NEW.purpose IS NOT OLD.purpose OR NEW.subject_id IS NOT OLD.subject_id
  OR NEW.key_id IS NOT OLD.key_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.nonce_hash IS NOT OLD.nonce_hash
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.consumed_invocation_id IS NOT NULL OR NEW.consumed_invocation_id IS NULL
BEGIN SELECT RAISE(ABORT, 'challenge_immutable'); END;

CREATE TRIGGER tr_bound_operation_immutable BEFORE UPDATE ON device_bound_operations
WHEN OLD.status!='prepared' OR NEW.status!='complete' OR NEW.key_id IS NOT OLD.key_id
  OR NEW.purpose IS NOT OLD.purpose OR NEW.operation_id IS NOT OLD.operation_id OR NEW.invocation_id IS NOT OLD.invocation_id
  OR NEW.request_digest IS NOT OLD.request_digest OR NEW.customer_id IS NOT OLD.customer_id
  OR NEW.binding_id IS NOT OLD.binding_id OR NEW.lease_id IS NOT OLD.lease_id OR NEW.response_json IS NOT OLD.response_json
  OR NEW.committed_at IS NOT OLD.committed_at OR NEW.retain_until IS NOT OLD.retain_until
BEGIN SELECT RAISE(ABORT, 'operation_result_immutable'); END;

-- Old lease and registration writes cannot weaken the protected mode, even
-- through the supported CLI's raw SQL path. Legacy rows are unaffected.
CREATE TRIGGER tr_bound_reject_legacy_lease BEFORE INSERT ON lease_issuance
WHEN EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1')
BEGIN SELECT RAISE(ABORT, 'legacy_protocol_disabled'); END;
CREATE TRIGGER tr_bound_reject_legacy_device_insert BEFORE INSERT ON entitlement_devices
WHEN EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1')
BEGIN SELECT RAISE(ABORT, 'legacy_protocol_disabled'); END;

-- A stale pre-read cannot create or extend a floating seat for protected mode.
-- Enforce this even when account isolation/proof is configured off.
CREATE TRIGGER tr_bound_reject_legacy_seat_insert BEFORE INSERT ON seat_checkouts
WHEN EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1')
BEGIN SELECT RAISE(ABORT, 'legacy_protocol_disabled'); END;
CREATE TRIGGER tr_bound_reject_legacy_seat_update BEFORE UPDATE ON seat_checkouts
WHEN EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1')
BEGIN SELECT RAISE(ABORT, 'legacy_protocol_disabled'); END;
CREATE TRIGGER tr_bound_reject_legacy_device_update BEFORE UPDATE ON entitlement_devices
WHEN EXISTS (SELECT 1 FROM entitlements e WHERE e.project = NEW.project AND e.feature = NEW.feature
  AND e.license_fingerprint = NEW.license_fingerprint AND e.enforcement_mode = 'device_bound_v1')
BEGIN SELECT RAISE(ABORT, 'legacy_protocol_disabled'); END;
