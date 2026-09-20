const BOUND_CLEANUP_BATCH_SIZE = 1000;
const BOUND_CLEANUP_MAX_BATCHES = 10;
export const BOUND_CLEANUP_MAX_ROWS = BOUND_CLEANUP_BATCH_SIZE * BOUND_CLEANUP_MAX_BATCHES;

// Fixed, indexed batches; database time owns the exclusive approval deadline.
// Only recovery ciphertext is erased. Identity, revisions and slot holds survive.
export const ERASE_EXPIRED_BOUND_APPROVALS_SQL = `UPDATE device_bound_authorizations
SET approval_ciphertext = NULL
WHERE handle_hash IN (
  SELECT handle_hash FROM device_bound_authorizations
  WHERE approval_ciphertext IS NOT NULL AND code_expires_at <= unixepoch()
  ORDER BY code_expires_at LIMIT 1000
) AND approval_ciphertext IS NOT NULL AND code_expires_at <= unixepoch()`;

export async function purgeExpiredBoundApprovals(db) {
  const [responses] = await drainBoundCleanup(db, [ERASE_EXPIRED_BOUND_APPROVALS_SQL]);
  return { responses };
}

// These rows have no authority after their exclusive deadline. Consumed
// attempts belong to the separate 48-hour operation-recovery lifecycle.
export const PURGE_EXPIRED_BOUND_EPHEMERA_SQL = Object.freeze([
  `DELETE FROM device_bound_challenges WHERE id IN (
    SELECT id FROM device_bound_challenges WHERE expires_at<=unixepoch()
    ORDER BY expires_at LIMIT 1000) AND expires_at<=unixepoch()`,
  `DELETE FROM device_bound_authorizations WHERE handle_hash IN (
    SELECT handle_hash FROM device_bound_authorizations INDEXED BY idx_bound_unconsumed_attempt_cleanup
    WHERE expires_at<=unixepoch() AND status IN ('pending','approved','denied')
    ORDER BY expires_at LIMIT 1000)
    AND expires_at<=unixepoch() AND status IN ('pending','approved','denied')`,
]);

export async function purgeExpiredBoundEphemera(db) {
  const removed = await drainBoundCleanup(db, PURGE_EXPIRED_BOUND_EPHEMERA_SQL);
  return { challenges: removed[0], attempts: removed[1] };
}

export const EXPIRE_BOUND_RECOVERY_SQL = Object.freeze([
  `UPDATE device_bound_operations SET response_json='' WHERE invocation_id IN (
    SELECT invocation_id FROM device_bound_operations WHERE status='complete' AND retain_until<=unixepoch() AND response_json<>''
    ORDER BY retain_until LIMIT 1000) AND status='complete' AND retain_until<=unixepoch() AND response_json<>''`,
  `DELETE FROM device_bound_authorizations WHERE handle_hash IN (
    SELECT handle_hash FROM device_bound_authorizations WHERE status='consumed' AND recovery_until<=unixepoch()
    ORDER BY recovery_until LIMIT 1000) AND status='consumed' AND recovery_until<=unixepoch()`,
]);

export async function expireBoundRecovery(db) {
  const removed = await drainBoundCleanup(db, EXPIRE_BOUND_RECOVERY_SQL);
  return { responses: removed[0], attempts: removed[1] };
}

export const PURGE_EXPIRED_BOUND_LEASES_SQL = `DELETE FROM device_bound_leases WHERE id IN (
  SELECT id FROM device_bound_leases WHERE accept_until<=unixepoch()
  ORDER BY accept_until LIMIT 1000) AND accept_until<=unixepoch()`;

export async function purgeExpiredBoundLeases(db) {
  const [leases] = await drainBoundCleanup(db, [PURGE_EXPIRED_BOUND_LEASES_SQL]);
  return { leases };
}

// One post-sweep snapshot, six index seeks: no row data or full-table counts.
// These read projections deliberately use the same exclusive deadlines and
// lifecycle predicates as the mutations above. Presence at equality has age zero.
export const BOUND_CLEANUP_BACKLOG_SQL = `SELECT unixepoch() AS measured_at,
  (SELECT code_expires_at FROM device_bound_authorizations INDEXED BY idx_bound_approval_cleanup
    WHERE approval_ciphertext IS NOT NULL AND code_expires_at<=unixepoch()
    ORDER BY code_expires_at LIMIT 1) AS approval_responses,
  (SELECT expires_at FROM device_bound_challenges INDEXED BY idx_bound_challenges_expiry WHERE expires_at<=unixepoch()
    ORDER BY expires_at LIMIT 1) AS ephemera_challenges,
  (SELECT expires_at FROM device_bound_authorizations INDEXED BY idx_bound_unconsumed_attempt_cleanup
    WHERE expires_at<=unixepoch() AND status IN ('pending','approved','denied')
    ORDER BY expires_at LIMIT 1) AS ephemera_attempts,
  (SELECT retain_until FROM device_bound_operations INDEXED BY idx_bound_operation_payload_cleanup
    WHERE status='complete' AND retain_until<=unixepoch() AND response_json<>''
    ORDER BY retain_until LIMIT 1) AS recovery_responses,
  (SELECT recovery_until FROM device_bound_authorizations INDEXED BY idx_bound_consumed_attempt_cleanup
    WHERE status='consumed' AND recovery_until<=unixepoch()
    ORDER BY recovery_until LIMIT 1) AS recovery_attempts,
  (SELECT accept_until FROM device_bound_leases INDEXED BY idx_bound_lease_cleanup WHERE accept_until<=unixepoch()
    ORDER BY accept_until LIMIT 1) AS lease_leases`;

const BACKLOG_TARGETS = Object.freeze([
  ['approval','responses'], ['ephemera','challenges'], ['ephemera','attempts'],
  ['recovery','responses'], ['recovery','attempts'], ['lease','leases'],
]);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value,-0);

export async function measureBoundCleanupBacklog(db) {
  const primary = db.withSession ? db.withSession('first-primary') : db;
  const row = await primary.prepare(BOUND_CLEANUP_BACKLOG_SQL).first();
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 7 || !Object.hasOwn(row,'measured_at') || !timestamp(row.measured_at)) {
    throw new Error('Invalid cleanup measurement');
  }
  // Validate every target before publishing any healthy-looking observation.
  return BACKLOG_TARGETS.map(([source,target]) => {
    const deadline = row[`${source}_${target}`];
    if (!Object.hasOwn(row,`${source}_${target}`) || (deadline !== null && (!timestamp(deadline) || deadline > row.measured_at))) throw new Error('Invalid cleanup measurement');
    return { source, target, measured_at: row.measured_at, backlog_present: deadline !== null,
      oldest_expired_at: deadline, backlog_age_seconds: deadline === null ? null : row.measured_at-deadline };
  });
}

async function drainBoundCleanup(db, statements) {
  const removed = [];
  for (const sql of statements) {
    let total = 0;
    for (let batch = 0; batch < BOUND_CLEANUP_MAX_BATCHES; batch++) {
      const result = await db.prepare(sql).run();
      const changes = Number(result.meta?.changes ?? 0);
      total += changes;
      if (changes < BOUND_CLEANUP_BATCH_SIZE) break;
    }
    removed.push(total);
  }
  return removed;
}
