// issuance_sql.mjs
//
// The atomic device-rebind cap statement, shared by the lease Worker and the
// SQLite-backed test so they can never drift. It inserts a lease_issuance row only
// when the count of DISTINCT *other* devices issued within the rebind window is
// below max_active_devices -- evaluated and written in ONE statement, so there is
// no check-then-insert TOCTOU. RETURNING id yields a row iff the insert landed.
//
// Positional bind order (15 params):
//   project, feature, license_fingerprint, device_key_id, lease_key_id,
//   issued_at, valid_from, valid_to, request_id,
//   project, feature, license_fingerprint, window_start, device_key_id, max_active_devices
export const LEASE_ISSUANCE_ATOMIC_SQL =
  "INSERT INTO lease_issuance (project, feature, license_fingerprint, device_key_id, lease_key_id, issued_at, valid_from, valid_to, request_id) " +
  "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? " +
  "WHERE (SELECT COUNT(DISTINCT device_key_id) FROM lease_issuance " +
  "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND issued_at >= ? AND device_key_id <> ?) < ? " +
  "RETURNING id";
