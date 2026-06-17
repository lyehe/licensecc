-- statements.pg.sql
--
-- PostgreSQL translations of the SQL statements the licensing backend issues.
-- Each statement is shown next to a one-line note quoting the ORIGINAL (SQLite/D1) form
-- and its source location, so a reviewer can diff shape-for-shape.
--
-- TWO GROUPS:
--   (A) The FOUR verify-path Worker statements from src/index.ts -- the only SQL the
--       fail-closed online verifier executes per request. These are what db-postgres.mjs
--       must run. Placeholders are shown as $1,$2,... (Postgres-native), since the
--       adapter requires callers to pass numbered placeholders (see db-postgres.mjs).
--   (B) The admin/CLI statements from scripts/entitlement.mjs that contain the
--       SQLite-isms the task flagged (unixepoch(), two-arg max(), randomblob(),
--       conditional ON CONFLICT ... DO UPDATE ... WHERE). These do NOT run in the verify
--       Worker, but they hit the SAME tables, so porting them is required for the data
--       layer to be drop-in. They use literal-embedded values in the original tooling
--       (string-built SQL), so here they are shown parameterized where a value appears.
--
-- Port rules applied:
--   ?                         -> $1, $2, ...
--   unixepoch()               -> EXTRACT(EPOCH FROM now())::bigint
--   max(a, b)  (2-arg scalar) -> GREATEST(a, b)            <-- SILENT-BREAKAGE; see B3 note
--   lower(hex(randomblob(8))) -> encode(gen_random_bytes(8), 'hex')
--   excluded.<col>            -> EXCLUDED.<col>  (Postgres keyword; case-insensitive, upcased for clarity)
--   ON CONFLICT(cols) DO UPDATE ... WHERE <guard>  -> kept; guard references existing row via table name


-- =====================================================================================
-- (A) VERIFY-PATH STATEMENTS  (services/.../src/index.ts) -- the four the adapter runs.
-- =====================================================================================

-- A1. rate_limit_counters upsert with RETURNING  (index.ts lines 303-307, checkD1RateLimitTier)
--   ORIGINAL (D1):
--     INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at)
--     VALUES (?, ?, ?, 1, ?, ?)
--     ON CONFLICT(namespace, rate_key, window_start)
--     DO UPDATE SET request_count = request_count + 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at
--     RETURNING request_count
--   .bind(namespace, key, windowStart, expiresAt, nowSeconds) -> 5 params; request_count literal 1 in VALUES.
--   Atomic read-modify-write is load-bearing (the counter increment). Consumed via .first<{request_count:number}>().
--   NOTE: in the bare DO UPDATE SET, `request_count` (unqualified) resolves to the EXISTING row's value in both
--   SQLite and Postgres, so `request_count = request_count + 1` is the same atomic increment in both engines.
INSERT INTO rate_limit_counters (namespace, rate_key, window_start, request_count, expires_at, updated_at)
VALUES ($1, $2, $3, 1, $4, $5)
ON CONFLICT (namespace, rate_key, window_start)
DO UPDATE SET
  request_count = rate_limit_counters.request_count + 1,
  expires_at    = EXCLUDED.expires_at,
  updated_at    = EXCLUDED.updated_at
RETURNING request_count;
-- (request_count is qualified as rate_limit_counters.request_count above purely for clarity; the unqualified
--  form `request_count = request_count + 1` is equally valid in Postgres and matches the original byte-for-byte.)


-- A2. rate_limit_counters cleanup DELETE  (index.ts line 310, fire-and-forget via .run())
--   ORIGINAL (D1): DELETE FROM rate_limit_counters WHERE expires_at < ?
--   .bind(nowSeconds) -> 1 param. Return value ignored.
DELETE FROM rate_limit_counters WHERE expires_at < $1;


-- A3. entitlement lookup SELECT  (index.ts line 604, lookupEntitlement)
--   ORIGINAL (D1):
--     SELECT project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds,
--            cache_ttl_seconds, revocation_seq, valid_from, valid_until
--     FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ? LIMIT 1
--   .bind(request.project, request.feature, request.license_fingerprint) -> 3 params.
--   Consumed via .first<EntitlementRow>() -> row or null.
SELECT project, feature, license_fingerprint, device_hash, status, assertion_ttl_seconds,
       cache_ttl_seconds, revocation_seq, valid_from, valid_until
FROM entitlements
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3
LIMIT 1;


-- A4. entitlement_device lookup SELECT  (index.ts line 615, lookupEntitlementDevice)
--   ORIGINAL (D1):
--     SELECT device_key_id, public_key_spki_der_base64, status
--     FROM entitlement_devices
--     WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ? LIMIT 1
--   .bind(request.project, request.feature, request.license_fingerprint, request.request_proof.device_key_id) -> 4 params.
--   Short-circuits to null (no DB hit) when request_proof === undefined. Consumed via .first<EntitlementDeviceRow>().
SELECT device_key_id, public_key_spki_der_base64, status
FROM entitlement_devices
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND device_key_id = $4
LIMIT 1;


-- =====================================================================================
-- (B) ADMIN / CLI STATEMENTS  (services/.../scripts/entitlement.mjs)
--     Not run by the verify Worker, but they mutate the same tables. Shown parameterized;
--     the original tooling string-builds these with embedded literals.
-- =====================================================================================

-- B1. entitlement upsert (conditional ON CONFLICT guard)  (entitlement.mjs line 219, command 'upsert')
--   ORIGINAL (D1):
--     INSERT INTO entitlements (... created_at, updated_at)
--     VALUES (..., unixepoch(), unixepoch())
--     ON CONFLICT(project, feature, license_fingerprint) DO UPDATE SET
--       device_hash = excluded.device_hash, status = excluded.status, ...,
--       revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE ...), revocation_seq)) + 1,
--       ..., updated_at = unixepoch()
--     WHERE entitlements.status != 'revoked'        <-- conditional-upsert guard (dropped only with --allow-revoked-override)
--   The guard makes a revoked row TERMINAL: the DO UPDATE is skipped when the existing row is revoked.
--   In Postgres the guard predicate in `ON CONFLICT ... DO UPDATE ... WHERE` references the EXISTING row via the
--   table name `entitlements.status` (NOT EXCLUDED) -- identical to the SQLite text, and it ports verbatim.
INSERT INTO entitlements (
  project, feature, license_fingerprint, device_hash, status,
  assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
  valid_from, valid_until, customer_id, license_id, created_at, updated_at
)
VALUES (
  $1, $2, $3, $4, $5,
  $6, $7,
  -- nextInsertedRevocationSeqSql: COALESCE((SELECT MAX(revocation_seq)+1 FROM entitlement_events WHERE ...), 1)
  COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events
            WHERE project = $1 AND feature = $2 AND license_fingerprint = $3), 1),
  $8, $9, $10, $11,
  EXTRACT(EPOCH FROM now())::bigint,    -- unixepoch() -> created_at
  EXTRACT(EPOCH FROM now())::bigint     -- unixepoch() -> updated_at
)
ON CONFLICT (project, feature, license_fingerprint) DO UPDATE SET
  device_hash           = EXCLUDED.device_hash,
  status                = EXCLUDED.status,
  assertion_ttl_seconds = EXCLUDED.assertion_ttl_seconds,
  cache_ttl_seconds     = EXCLUDED.cache_ttl_seconds,
  -- B3 transform applied here: SQLite scalar max(a,b) -> Postgres GREATEST(a,b)
  revocation_seq        = GREATEST(
                            entitlements.revocation_seq,
                            COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
                                      WHERE project = entitlements.project
                                        AND feature = entitlements.feature
                                        AND license_fingerprint = entitlements.license_fingerprint),
                                     entitlements.revocation_seq)
                          ) + 1,
  valid_from            = EXCLUDED.valid_from,
  valid_until           = EXCLUDED.valid_until,
  customer_id           = EXCLUDED.customer_id,
  license_id            = EXCLUDED.license_id,
  updated_at            = EXTRACT(EPOCH FROM now())::bigint   -- unixepoch()
WHERE entitlements.status != 'revoked';   -- conditional-upsert guard, ported verbatim (references existing row)


-- B2. audit-event insert from current row (randomblob request-id)  (entitlement.mjs line 166, eventSqlFromCurrent)
--   ORIGINAL (D1):
--     INSERT INTO entitlement_events (...) SELECT project, feature, ..., 'cli', 'cli',
--       'cli-' || lower(hex(randomblob(8))), ..., unixepoch() FROM entitlements WHERE ... AND status = ?
--   randomblob(8) -> 8 random bytes; lower(hex(...)) -> 16 lowercase hex chars.
INSERT INTO entitlement_events (
  project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq,
  detail, actor, actor_type, source, request_id, reason, created_at
)
SELECT
  project, feature, license_fingerprint, device_hash,
  $4,                                  -- eventType
  status, revocation_seq,
  $5,                                  -- reason (detail)
  $6,                                  -- actor
  'cli', 'cli',
  'cli-' || encode(gen_random_bytes(8), 'hex'),   -- lower(hex(randomblob(8))) -> 16 lowercase hex chars
  $5,                                  -- reason
  EXTRACT(EPOCH FROM now())::bigint     -- unixepoch()
FROM entitlements
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND status = $7;


-- B3. *** SILENT-BREAKAGE FLAG ***  scalar max(a,b) vs Postgres aggregate max()
--   nextExistingRevocationSeqSql() (entitlement.mjs line 182) emits the SQLite SCALAR two-arg form:
--       max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE ...), revocation_seq)) + 1
--   In SQLite, max(x, y) with >= 2 args is the SCALAR greatest-of function.
--   In Postgres, max(...) is ONLY an AGGREGATE and takes exactly ONE argument. Feeding it two args
--   raises: "function max(bigint, bigint) does not exist". If a porter "fixes" that error by collapsing
--   to a one-arg aggregate or a window/sub-select, the revocation_seq monotonicity invariant breaks
--   SILENTLY (wrong floor -> a replayed/old assertion could be accepted). The correct, behavior-
--   preserving port is the SCALAR GREATEST(a, b):
--       GREATEST(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE ...), revocation_seq)) + 1
--   Note the inner `MAX(revocation_seq)` stays MAX -- it IS a genuine single-column aggregate over
--   entitlement_events and is correct in both engines. Only the OUTER two-arg max -> GREATEST.
--   (Applied inline in B1 above; standalone form for the UPDATE statements:)
--
--   UPDATE entitlements SET
--     status = $4, updated_at = EXTRACT(EPOCH FROM now())::bigint,
--     revocation_seq = GREATEST(
--       entitlements.revocation_seq,
--       COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
--                 WHERE project = entitlements.project AND feature = entitlements.feature
--                   AND license_fingerprint = entitlements.license_fingerprint),
--                entitlements.revocation_seq)
--     ) + 1
--   WHERE project = $1 AND feature = $2 AND license_fingerprint = $3;


-- B4. device upsert  (entitlement.mjs line 247, command 'device-upsert') -- unconditional ON CONFLICT.
--   ORIGINAL (D1):
--     INSERT INTO entitlement_devices (..., created_at, updated_at)
--     VALUES (..., unixepoch(), unixepoch())
--     ON CONFLICT(project, feature, license_fingerprint, device_key_id) DO UPDATE SET
--       public_key_spki_der_base64 = excluded.public_key_spki_der_base64, status = excluded.status, updated_at = unixepoch()
INSERT INTO entitlement_devices (
  project, feature, license_fingerprint, device_key_id,
  public_key_spki_der_base64, status, created_at, updated_at
)
VALUES (
  $1, $2, $3, $4, $5, $6,
  EXTRACT(EPOCH FROM now())::bigint,   -- unixepoch()
  EXTRACT(EPOCH FROM now())::bigint    -- unixepoch()
)
ON CONFLICT (project, feature, license_fingerprint, device_key_id) DO UPDATE SET
  public_key_spki_der_base64 = EXCLUDED.public_key_spki_der_base64,
  status                     = EXCLUDED.status,
  updated_at                 = EXTRACT(EPOCH FROM now())::bigint;   -- unixepoch()


-- B5. entitlement upsert -- OVERRIDE path (--allow-revoked-override)  (entitlement.mjs line 219, command 'upsert')
--   Identical to B1 EXCEPT the conditional ON CONFLICT guard `WHERE entitlements.status != 'revoked'` is
--   DROPPED (conflictGuard = ""), so a revoked (terminal) row IS reactivated. The matching audit event uses
--   event_type 'revoked-override' (see B2/B6e below). This is the break-glass variant.
INSERT INTO entitlements (
  project, feature, license_fingerprint, device_hash, status,
  assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
  valid_from, valid_until, customer_id, license_id, created_at, updated_at
)
VALUES (
  $1, $2, $3, $4, $5,
  $6, $7,
  -- nextInsertedRevocationSeqSql: COALESCE((SELECT MAX(revocation_seq)+1 FROM entitlement_events WHERE ...), 1)
  COALESCE((SELECT MAX(revocation_seq) + 1 FROM entitlement_events
            WHERE project = $1 AND feature = $2 AND license_fingerprint = $3), 1),
  $8, $9, $10, $11,
  EXTRACT(EPOCH FROM now())::bigint,    -- unixepoch() -> created_at
  EXTRACT(EPOCH FROM now())::bigint     -- unixepoch() -> updated_at
)
ON CONFLICT (project, feature, license_fingerprint) DO UPDATE SET
  device_hash           = EXCLUDED.device_hash,
  status                = EXCLUDED.status,
  assertion_ttl_seconds = EXCLUDED.assertion_ttl_seconds,
  cache_ttl_seconds     = EXCLUDED.cache_ttl_seconds,
  revocation_seq        = GREATEST(
                            entitlements.revocation_seq,
                            COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
                                      WHERE project = entitlements.project
                                        AND feature = entitlements.feature
                                        AND license_fingerprint = entitlements.license_fingerprint),
                                     entitlements.revocation_seq)
                          ) + 1,
  valid_from            = EXCLUDED.valid_from,
  valid_until           = EXCLUDED.valid_until,
  customer_id           = EXCLUDED.customer_id,
  license_id            = EXCLUDED.license_id,
  updated_at            = EXTRACT(EPOCH FROM now())::bigint;   -- NO conflictGuard WHERE (override drops it)


-- B6. status mutation UPDATEs -- revoke / disable / reenable  (entitlement.mjs line 230)
--   ORIGINAL (D1):
--     UPDATE entitlements SET status = '<status>',
--       revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE ...), revocation_seq)) + 1,
--       updated_at = unixepoch()
--     WHERE project = ? AND feature = ? AND license_fingerprint = ?<terminalGuard>
--   <terminalGuard> = " AND status != 'revoked'" for disable AND reenable; "" for revoke (revoke has no guard).
--   $4 = status literal ('revoked' | 'disabled' | 'active'). Each finished form below is the SAME UPDATE body
--   with the per-command terminal guard materialized (B3 only gave the unguarded template).

-- B6a. revoke  (status = 'revoked', NO terminal guard -- revoke can re-revoke any non-terminal-or-terminal row)
UPDATE entitlements SET
  status         = 'revoked',
  revocation_seq = GREATEST(
                     entitlements.revocation_seq,
                     COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
                               WHERE project = entitlements.project
                                 AND feature = entitlements.feature
                                 AND license_fingerprint = entitlements.license_fingerprint),
                              entitlements.revocation_seq)
                   ) + 1,
  updated_at     = EXTRACT(EPOCH FROM now())::bigint
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3;

-- B6b. disable  (status = 'disabled', WITH terminal guard: a revoked row is terminal -> 0 rows changed)
UPDATE entitlements SET
  status         = 'disabled',
  revocation_seq = GREATEST(
                     entitlements.revocation_seq,
                     COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
                               WHERE project = entitlements.project
                                 AND feature = entitlements.feature
                                 AND license_fingerprint = entitlements.license_fingerprint),
                              entitlements.revocation_seq)
                   ) + 1,
  updated_at     = EXTRACT(EPOCH FROM now())::bigint
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND status != 'revoked';

-- B6c. reenable  (status = 'active', WITH terminal guard: a revoked row stays revoked -> 0 rows changed)
UPDATE entitlements SET
  status         = 'active',
  revocation_seq = GREATEST(
                     entitlements.revocation_seq,
                     COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
                               WHERE project = entitlements.project
                                 AND feature = entitlements.feature
                                 AND license_fingerprint = entitlements.license_fingerprint),
                              entitlements.revocation_seq)
                   ) + 1,
  updated_at     = EXTRACT(EPOCH FROM now())::bigint
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND status != 'revoked';


-- B7. update-event insert from current row with device-existence guard  (entitlement.mjs line 174, updateEventSqlFromCurrent)
--   ORIGINAL (D1):
--     INSERT INTO entitlement_events (...) SELECT project, feature, ..., 'update', status, revocation_seq,
--       '<detail>', '<actor>', 'cli', 'cli', 'cli-' || lower(hex(randomblob(8))), '<reason>', unixepoch()
--     FROM entitlements WHERE project = ? AND feature = ? AND license_fingerprint = ?
--       AND EXISTS (SELECT 1 FROM entitlement_devices WHERE ... AND device_key_id = ?)
--   Distinct from B2 (eventSqlFromCurrent): event_type is the LITERAL 'update' (not a param), the filter is the
--   device EXISTS(...) guard (NOT `status = ?`), and detail/reason are separate params ($5=detail, $6=reason).
--   Used by device-upsert / device-disable / device-revoke. Writes 0 events when the device row does not exist.
INSERT INTO entitlement_events (
  project, feature, license_fingerprint, device_hash, event_type, status, revocation_seq,
  detail, actor, actor_type, source, request_id, reason, created_at
)
SELECT
  project, feature, license_fingerprint, device_hash,
  'update',                            -- event_type LITERAL (updateEventSqlFromCurrent)
  status, revocation_seq,
  $5,                                  -- detail
  $6,                                  -- actor
  'cli', 'cli',
  'cli-' || encode(gen_random_bytes(8), 'hex'),   -- lower(hex(randomblob(8)))
  $7,                                  -- reason
  EXTRACT(EPOCH FROM now())::bigint     -- unixepoch()
FROM entitlements
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3
  AND EXISTS (
    SELECT 1 FROM entitlement_devices
    WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND device_key_id = $4
  );


-- B8. parent entitlement revocation_seq bump, GUARDED by device existence  (entitlement.mjs line 248 / 259)
--   ORIGINAL (D1):
--     UPDATE entitlements SET
--       revocation_seq = max(revocation_seq, COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events WHERE ...), revocation_seq)) + 1,
--       updated_at = unixepoch()
--     WHERE project = ? AND feature = ? AND license_fingerprint = ?
--       AND EXISTS (SELECT 1 FROM entitlement_devices WHERE ... AND device_key_id = ?)
--   Shared by device-upsert (statement 2) and device-disable / device-revoke (statement 2). The EXISTS guard
--   means a device mutation against an UNKNOWN device bumps nothing (and B7 writes no event) -- the no-op path.
--   B3's standalone template lacked this EXISTS guard; this is the finished, guarded form.
UPDATE entitlements SET
  revocation_seq = GREATEST(
                     entitlements.revocation_seq,
                     COALESCE((SELECT MAX(revocation_seq) FROM entitlement_events
                               WHERE project = entitlements.project
                                 AND feature = entitlements.feature
                                 AND license_fingerprint = entitlements.license_fingerprint),
                              entitlements.revocation_seq)
                   ) + 1,
  updated_at     = EXTRACT(EPOCH FROM now())::bigint
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3
  AND EXISTS (
    SELECT 1 FROM entitlement_devices
    WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND device_key_id = $4
  );


-- B9. device state UPDATE -- device-disable / device-revoke  (entitlement.mjs line 258, statement 1)
--   ORIGINAL (D1):
--     UPDATE entitlement_devices SET status = '<status>', updated_at = unixepoch()
--     WHERE project = ? AND feature = ? AND license_fingerprint = ? AND device_key_id = ?
--   $5 = status literal ('disabled' for device-disable, 'revoked' for device-revoke). No revocation_seq here
--   (the device row has none); the parent bump (B8) + event (B7) follow as statements 2 and 3.
UPDATE entitlement_devices SET
  status     = $5,
  updated_at = EXTRACT(EPOCH FROM now())::bigint   -- unixepoch()
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3 AND device_key_id = $4;


-- =====================================================================================
-- (B-READS) Read-only SELECTs from the CLI. These run via .all()/.first(); they are NOT
-- the verify-path reads (A3/A4) -- they return the FULL admin column set, including `notes`,
-- and the device-list/list reads order + cap at 100 rows.
-- =====================================================================================

-- B10. get -- single entitlement, full admin columns incl. notes  (entitlement.mjs line 236, command 'get')
--   ORIGINAL (D1): SELECT project, feature, ..., notes, created_at, updated_at FROM entitlements
--     WHERE project = ? AND feature = ? AND license_fingerprint = ?
--   NOTE: includes `notes`, created_at, updated_at -- unlike the verify-path A3 (which omits notes/timestamps
--   and adds LIMIT 1). No LIMIT here (the composite PK makes it at most one row).
SELECT project, feature, license_fingerprint, device_hash, status,
       assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
       valid_from, valid_until, notes, created_at, updated_at
FROM entitlements
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3;


-- B11. list -- entitlements with OPTIONAL project/feature filters  (entitlement.mjs line 277, command 'list')
--   ORIGINAL (D1): SELECT ... FROM entitlements<WHERE> ORDER BY updated_at DESC LIMIT 100
--   <WHERE> is "" / " WHERE project = ?" / " WHERE feature = ?" / " WHERE project = ? AND feature = ?",
--   depending on which of project/feature were passed. The four materialized forms:

-- B11a. list (no filters)
SELECT project, feature, license_fingerprint, device_hash, status,
       assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
       valid_from, valid_until, notes, created_at, updated_at
FROM entitlements
ORDER BY updated_at DESC LIMIT 100;

-- B11b. list (project filter only)
SELECT project, feature, license_fingerprint, device_hash, status,
       assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
       valid_from, valid_until, notes, created_at, updated_at
FROM entitlements
WHERE project = $1
ORDER BY updated_at DESC LIMIT 100;

-- B11c. list (feature filter only)
SELECT project, feature, license_fingerprint, device_hash, status,
       assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
       valid_from, valid_until, notes, created_at, updated_at
FROM entitlements
WHERE feature = $1
ORDER BY updated_at DESC LIMIT 100;

-- B11d. list (project AND feature filters)
SELECT project, feature, license_fingerprint, device_hash, status,
       assertion_ttl_seconds, cache_ttl_seconds, revocation_seq,
       valid_from, valid_until, notes, created_at, updated_at
FROM entitlements
WHERE project = $1 AND feature = $2
ORDER BY updated_at DESC LIMIT 100;


-- B12. device-list -- devices for one entitlement  (entitlement.mjs line 265, command 'device-list')
--   ORIGINAL (D1): SELECT project, feature, license_fingerprint, device_key_id, status,
--     created_at, updated_at, last_seen_at, notes FROM entitlement_devices
--     WHERE project = ? AND feature = ? AND license_fingerprint = ? ORDER BY updated_at DESC LIMIT 100
--   Reads last_seen_at and notes (distinct from the verify-path A4, which selects only
--   device_key_id, public_key_spki_der_base64, status with LIMIT 1).
SELECT project, feature, license_fingerprint, device_key_id, status,
       created_at, updated_at, last_seen_at, notes
FROM entitlement_devices
WHERE project = $1 AND feature = $2 AND license_fingerprint = $3
ORDER BY updated_at DESC LIMIT 100;
