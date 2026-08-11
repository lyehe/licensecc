// The complete SQL inventory used by the PostgreSQL-fenced /v1/verify path.
// Keep these D1/SQLite statements single-sourced: the Worker executes them
// directly and the PostgreSQL adapter translates this exact closed set.

export const VERIFY_SQL = Object.freeze({
  rateLimitUpsert:
    "INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(namespace, rate_key, window_start) DO UPDATE SET request_count = request_count + 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at RETURNING request_count",
  rateLimitCleanup: "DELETE FROM rate_limit_counters WHERE expires_at < ?",
  entitlementLookup:
    "SELECT project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1",
  entitlementDeviceLookup:
    "SELECT device_key_id, public_key_spki_der_base64, status FROM entitlement_devices WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? LIMIT 1",
  requestProofNonceConsume:
    "INSERT INTO request_proof_nonces (project, feature, license_fingerprint, device_key_id, nonce, request_timestamp, consumed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, feature, license_fingerprint, device_key_id, nonce) DO NOTHING RETURNING nonce",
  requestProofNonceCleanup: "DELETE FROM request_proof_nonces WHERE expires_at < ?",
});

export const VERIFY_SQL_NAMES = Object.freeze(Object.keys(VERIFY_SQL));
export const VERIFY_SQL_STATEMENTS = Object.freeze(Object.values(VERIFY_SQL));
