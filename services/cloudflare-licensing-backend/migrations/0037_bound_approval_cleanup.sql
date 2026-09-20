-- Recovery ciphertext has a shorter lifetime than the authorization record.
CREATE INDEX idx_bound_approval_cleanup
ON device_bound_authorizations(code_expires_at)
WHERE approval_ciphertext IS NOT NULL;
