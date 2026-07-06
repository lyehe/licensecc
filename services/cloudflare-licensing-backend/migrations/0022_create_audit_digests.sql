-- Tamper-EVIDENT audit log (audit R6.4). entitlement_events is append-only by convention but not
-- tamper-evident: any D1 write path (or operator) could alter/delete history undetectably. This adds
-- a hash-chained digest: a cron segment covers new events (id > the last cursor) and stores
-- digest = sha256(prev_digest + canonical(events)). Altering or deleting a covered event changes its
-- segment digest, which breaks the chain from that point on -- detectable by replaying the events
-- (verifyAuditChain in src/audit/audit_digest.mjs). The digests are cheap, append-only, and READ the
-- event log only; no mutator/event-write path changes.
CREATE TABLE IF NOT EXISTS audit_digests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT    NOT NULL,
  up_to_id    INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  prev_digest TEXT    NOT NULL DEFAULT '',
  digest      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_digests_source ON audit_digests(source, id);
