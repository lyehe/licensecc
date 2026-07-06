// Real-SQLite coverage for the audit payload (TEST-3). The unit suite (admin-worker.test.mjs) and the
// cross-worker e2e both use JS MockD1s that build next_json with JSON.stringify, so the actual SQLite
// json_object() expression in src/worker/index.ts is never executed and its shape/type fidelity is unverified.
// This suite executes the REAL json_object expression (extracted from the worker source) against a database
// built from the shared migrations, and proves a forced audit-insert failure rolls back the entitlement write
// transactionally — the contract the production D1 batch() provides.
//
// Requires node:sqlite (Node >= 22 with --experimental-sqlite). Run via `npm run test:sql`; kept out of the
// default `test` file list so the hermetic unit suite needs no experimental flag.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "cloudflare-licensing-backend", "migrations");
// eventFromCurrentStatement moved into the shared @licensecc/cloudflare-licensing-backend
// entitlement_mutation core (T2 extraction); read the json_object expression from there, not
// from src/worker/index.ts (which no longer contains it). Mirrors the drift-guard in
// admin-worker.test.mjs so both point at the single canonical source.
const mutationSource = fileURLToPath(import.meta.resolve("@licensecc/cloudflare-licensing-backend/entitlements/entitlement_mutation"));

// The audit payload contract: the exact keys the production json_object emits (+ no others).
const NEXT_JSON_KEYS = [
  "project",
  "feature",
  "license_fingerprint",
  "device_hash",
  "status",
  "assertion_ttl_seconds",
  "cache_ttl_seconds",
  "revocation_seq",
  "valid_from",
  "valid_until",
  "notes",
  "customer_id",
  "license_id",
  "policy_id",
  "is_trial",
  "trial_expiration_basis",
  "trial_duration_sec",
  "trial_one_per_device",
  "trial_require_device_proof",
  "trial_started_at",
  "trial_device_hash",
  "max_active_devices",
  "lease_seconds",
  "rebind_window_sec",
  "pool_size",
  "heartbeat_grace_sec",
  "max_borrow_sec",
  "allow_overdraft",
  "meter_quota",
  "meter_period_sec",
  "license_mode",
  "created_at",
  "updated_at",
  "id",
];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return db;
}

// Extract the literal json_object(...) expression from eventFromCurrentStatement so the test runs the SAME
// SQL the Worker ships (not a hand-copied duplicate that could silently drift).
function productionJsonObjectExpression() {
  const src = readFileSync(mutationSource, "utf8");
  const match = /function eventFromCurrentStatement\([\s\S]*?(json_object\([\s\S]*?\)),\s*\n/.exec(src);
  assert.ok(match, "could not locate eventFromCurrentStatement json_object expression");
  // The only bind placeholder inside the expression is the entitlement id ('id', ?); substitute a literal.
  return match[1].replace(/'id',\s*\?/, "'id', 'test-id'");
}

test("real SQLite json_object emits exactly the audit contract keys with preserved types", () => {
  const db = freshDb();
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, valid_from, valid_until, notes, " +
      "customer_id, license_id, created_at, updated_at) VALUES " +
      "('DEFAULT', 'DEFAULT', 'fp', 'dev', 'active', 321, 999, 5, NULL, NULL, 'note', NULL, NULL, 1000, 2000)",
  );
  const expr = productionJsonObjectExpression();
  const { next_json: nextJson } = db
    .prepare(
      `SELECT ${expr} AS next_json FROM entitlements WHERE project = 'DEFAULT' AND feature = 'DEFAULT' AND license_fingerprint = 'fp'`,
    )
    .get();
  const next = JSON.parse(nextJson);

  assert.deepEqual(Object.keys(next).sort(), [...NEXT_JSON_KEYS].sort());
  // Numbers must stay numbers (not stringified) so audit consumers and idempotency replay see the real types.
  assert.equal(typeof next.assertion_ttl_seconds, "number");
  assert.equal(next.assertion_ttl_seconds, 321);
  assert.equal(typeof next.cache_ttl_seconds, "number");
  assert.equal(next.cache_ttl_seconds, 999);
  assert.equal(typeof next.revocation_seq, "number");
  assert.equal(typeof next.created_at, "number");
  assert.equal(typeof next.updated_at, "number");
  // NULL columns must stay JSON null, not "" or absent.
  assert.equal(next.valid_from, null);
  assert.equal(next.valid_until, null);
  assert.equal(next.customer_id, null);
  assert.equal(next.license_id, null);
  assert.equal(next.id, "test-id");
  db.close();
});

test("a failing audit insert rolls back the entitlement write transactionally", () => {
  const db = freshDb();
  db.exec(
    "INSERT INTO entitlements (project, feature, license_fingerprint, device_hash, status, " +
      "assertion_ttl_seconds, cache_ttl_seconds, revocation_seq, created_at, updated_at) VALUES " +
      "('DEFAULT', 'DEFAULT', 'fp', '', 'active', 300, 300, 5, 1000, 1000)",
  );
  // Model the production D1 batch() contract: the entitlement write and audit event are one transaction.
  let threw = false;
  try {
    db.exec("BEGIN");
    db.exec("UPDATE entitlements SET status = 'disabled', updated_at = 3000 WHERE license_fingerprint = 'fp'");
    // event_type CHECK rejects this value, mirroring an audit-insert failure inside the batch.
    db.exec(
      "INSERT INTO entitlement_events (project, feature, license_fingerprint, event_type, status, " +
        "revocation_seq, created_at) VALUES ('DEFAULT', 'DEFAULT', 'fp', 'not_a_valid_event_type', 'active', 6, 3000)",
    );
    db.exec("COMMIT");
  } catch {
    threw = true;
    db.exec("ROLLBACK");
  }
  assert.equal(threw, true);
  const row = db.prepare("SELECT status FROM entitlements WHERE license_fingerprint = 'fp'").get();
  assert.equal(row.status, "active"); // the UPDATE rolled back; no orphaned mutation without an audit event
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entitlement_events").get().c, 0);
  db.close();
});
