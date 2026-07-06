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

// Atomic concurrent-seat checkout (floating licensing). The INSERT lands only when the
// count of LIVE seats (heartbeat_deadline > now) for the entitlement is below the pool
// ceiling -- evaluated and written in ONE statement, so N concurrent checkouts can never
// exceed the pool (the same race-free shape as the rebind cap, counting live rows instead
// of distinct devices). RETURNING yields a row iff the seat was granted.
//
// Positional bind order (13 params):
//   project, feature, license_fingerprint, seat_id, client_instance_id, mode,
//   checked_out_at, heartbeat_deadline,
//   project, feature, license_fingerprint, now, pool_ceiling
export const SEAT_CHECKOUT_ATOMIC_SQL =
  "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) " +
  "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
  "WHERE (SELECT COUNT(*) FROM seat_checkouts " +
  "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ?) < ? " +
  "RETURNING seat_id";

// ============================ Slice 2: account isolation (F2/F3) ============================
//
// The ownership predicate is folded into the *mutating* statement, never the pre-read, so
// there is no read-then-sign TOCTOU (F3) and no wrong-owner existence oracle (F2). Because
// `lease_issuance` and `seat_checkouts` carry NO customer_id, ownership is an EXISTS over the
// `entitlements` row that conjoins, ATOMICALLY with the action:
//   - the entitlement's owning `customer_id` (the isolation binding),
//   - `status='active'` (a revoke between pre-read and write cannot mint a lease/seat),
//   - the validity window (`valid_from`/`valid_until`).
// `NULL = ?` is never true, so a NULL-owner entitlement fails closed; a wrong-owner row is
// indistinguishable from an absent one (no row, no oracle). The device/seat COUNT subqueries
// stay tuple-scoped (foreign seats neither match the EXISTS nor count against the pool).
//
// Mode selects the customer predicate:
//   required: `e.customer_id = ?`                          (NULL/mismatch denied)
//   soft:     `(e.customer_id = ? OR e.customer_id IS NULL)` (NULL allowed+logged; populated
//                                                            mismatch still denied -- B's row
//                                                            never matches A's customer_id)
// The EXISTS binds, in order: project, feature, license_fingerprint, customer_id, now, now.

const OWNERSHIP_CUSTOMER_REQUIRED = "e.customer_id = ?";
const OWNERSHIP_CUSTOMER_SOFT = "(e.customer_id = ? OR e.customer_id IS NULL)";

// Returns the SQL fragment + the customer predicate it should be composed with for a mode.
// `required` and `soft` differ only in the customer conjunct; `off` is not isolation-bound
// (legacy bearer path) and never reaches these builders.
export function ownershipCustomerPredicate(mode) {
  return mode === "soft" ? OWNERSHIP_CUSTOMER_SOFT : OWNERSHIP_CUSTOMER_REQUIRED;
}

// The shared `AND EXISTS (...)` conjunct appended to the mutating WHERE. Binds (5 params):
//   project, feature, license_fingerprint, customer_id, now, now
// (now is bound twice: valid_from <= now AND valid_until > now.)
export function entitlementOwnershipExists(mode) {
  const customer = ownershipCustomerPredicate(mode);
  return (
    "AND EXISTS (SELECT 1 FROM entitlements e " +
    "WHERE e.project = ? AND e.feature = ? AND e.license_fingerprint = ? " +
    `AND ${customer} ` +
    "AND e.status = 'active' " +
    "AND (e.valid_from IS NULL OR e.valid_from <= ?) " +
    "AND (e.valid_until IS NULL OR e.valid_until > ?))"
  );
}

// LEASE_ISSUANCE with the ownership EXISTS folded into the cap guard. Bind order (20 params):
//   ...the 15 LEASE_ISSUANCE_ATOMIC_SQL params (RETURNING id is moved to the very end)...,
//   then the EXISTS 5: ownProject, ownFeature, ownFingerprint, customer_id, now, now
// (i.e. 14 base params before RETURNING + 6 EXISTS params = 20).
export function leaseIssuanceSqlOwned(mode) {
  return (
    "INSERT INTO lease_issuance (project, feature, license_fingerprint, device_key_id, lease_key_id, issued_at, valid_from, valid_to, request_id) " +
    "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? " +
    "WHERE (SELECT COUNT(DISTINCT device_key_id) FROM lease_issuance " +
    "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND issued_at >= ? AND device_key_id <> ?) < ? " +
    entitlementOwnershipExists(mode) +
    " RETURNING id"
  );
}

// SEAT_CHECKOUT with the ownership EXISTS folded into the pool guard. Bind order (18 params):
//   ...the 13 SEAT_CHECKOUT_ATOMIC_SQL params (RETURNING seat_id moved to the end)...,
//   then the EXISTS 6: ownProject, ownFeature, ownFingerprint, customer_id, now, now.
export function seatCheckoutSqlOwned(mode) {
  return (
    "INSERT INTO seat_checkouts (project, feature, license_fingerprint, seat_id, client_instance_id, mode, checked_out_at, heartbeat_deadline) " +
    "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
    "WHERE (SELECT COUNT(*) FROM seat_checkouts " +
    "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND heartbeat_deadline > ?) < ? " +
    entitlementOwnershipExists(mode) +
    " RETURNING seat_id"
  );
}

// T7 revocation SLA — heartbeat UPDATE that ATOMICALLY re-asserts the entitlement is still
// active AND inside its validity window, so a revoke/disable/expire landing between the handler's
// pre-read and this UPDATE denies the refresh (closing the one-heartbeat TOCTOU the pre-read alone
// left open). Without this, a revoked entitlement's live seats keep extending their deadline forever
// and the revocation never takes effect. The EXISTS correlates to the row being updated (tuple taken
// from seat_checkouts, not re-bound); soft/required additionally fold the customer ownership conjunct
// (so A can never heartbeat B's seat). `off` is NOT customer-bound — it must omit the customer
// predicate (a null customer_id would match nothing and deny every off-mode heartbeat).
//
// Bind order:
//   off:          deadline, project, feature, license_fingerprint, seat_id, now, now, now
//   soft/required: ...the same 8... , customer_id
// (the three trailing `now`s: heartbeat_deadline > now, valid_from <= now, valid_until > now.)
export function seatHeartbeatSql(mode) {
  const customer = mode === "off" ? "" : `AND ${ownershipCustomerPredicate(mode)} `;
  return (
    "UPDATE seat_checkouts SET heartbeat_deadline = ? " +
    "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id = ? " +
    "AND mode = 'live' AND heartbeat_deadline > ? " +
    "AND EXISTS (SELECT 1 FROM entitlements e " +
    "WHERE e.project = seat_checkouts.project AND e.feature = seat_checkouts.feature " +
    "AND e.license_fingerprint = seat_checkouts.license_fingerprint " +
    "AND e.status = 'active' " +
    "AND (e.valid_from IS NULL OR e.valid_from <= ?) " +
    "AND (e.valid_until IS NULL OR e.valid_until > ?) " +
    customer +
    ") RETURNING seat_id"
  );
}

// T7 downgrade reclaim — when an entitlement's capacity is lowered (pool_size / allow_overdraft),
// the existing LIVE seats above the new ceiling keep heartbeating and the downgrade never takes
// effect. This sweep reclaims the overflow: a live seat is deleted when at least `ceiling` OTHER
// still-live seats (any mode — a borrowed seat holds a signed offline slot) outrank it by
// heartbeat_deadline (latest-alive kept, ties broken by seat_id). Reclaiming the row makes the
// client's next heartbeat deny (seat_reclaimed), so over-capacity access ends within one sweep +
// grace. Only `mode='live'` rows are reclaimed (a borrowed seat's signed token can't be recalled).
// Bind order (2 params): now, now.
export const SEAT_OVERCAP_RECLAIM_SQL =
  "DELETE FROM seat_checkouts WHERE seat_id IN (" +
  "SELECT sc.seat_id FROM seat_checkouts sc " +
  "JOIN entitlements e ON e.project = sc.project AND e.feature = sc.feature AND e.license_fingerprint = sc.license_fingerprint " +
  "WHERE sc.mode = 'live' AND sc.heartbeat_deadline > ? " +
  "AND (SELECT COUNT(*) FROM seat_checkouts s2 " +
  "WHERE s2.project = sc.project AND s2.feature = sc.feature AND s2.license_fingerprint = sc.license_fingerprint " +
  "AND s2.heartbeat_deadline > ? " +
  "AND (s2.heartbeat_deadline > sc.heartbeat_deadline OR (s2.heartbeat_deadline = sc.heartbeat_deadline AND s2.seat_id > sc.seat_id))" +
  ") >= (e.pool_size + CASE WHEN e.allow_overdraft > 0 THEN e.allow_overdraft ELSE 0 END)" +
  ") RETURNING project, feature, license_fingerprint, seat_id, heartbeat_deadline";

// Release DELETE with the ownership EXISTS. Bind order (5 params): project, feature,
// license_fingerprint, seat_id, customer_id. 0 rows freed (wrong owner / absent) is idempotent
// {ok:true}; only a real free emits the usage event.
export function seatReleaseSqlOwned(mode) {
  return (
    "DELETE FROM seat_checkouts " +
    "WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id = ? " +
    "AND EXISTS (SELECT 1 FROM entitlements e " +
    "WHERE e.project = seat_checkouts.project AND e.feature = seat_checkouts.feature " +
    "AND e.license_fingerprint = seat_checkouts.license_fingerprint " +
    `AND ${ownershipCustomerPredicate(mode)}) ` +
    "RETURNING seat_id"
  );
}
