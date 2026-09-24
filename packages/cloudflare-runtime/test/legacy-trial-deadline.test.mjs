import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { evaluateTrialActivation } from "@licensecc/licensing-domain/lease/trial";
import { legacyTrialDeadlineSql } from "@licensecc/cloudflare-runtime/lease/trial_store";

const NOW = 1_000_000;
const base = { is_trial: 1, trial_expiration_basis: "from_first_activation", trial_duration_sec: 0,
  trial_one_per_device: 0, trial_require_device_proof: 0, trial_started_at: null, trial_device_hash: null, valid_until: null };

// The end the legacy lease path enforces for a row, with no prospective start: a trial clock that
// has not started has no end yet, and a trial with no clock of its own ends with the license, at
// valid_until.
function enforcedEnd(row) {
  const decision = evaluateTrialActivation(row, "device-key", false, NOW);
  assert.equal(decision.trial, true);
  assert.equal(decision.deny, undefined);
  if (decision.stamp && decision.trialExpiresAt !== null) return null;
  return decision.trialExpiresAt ?? row.valid_until;
}

function deadlineStatement(db) {
  const fields = Object.keys(base).map((field) => `json_extract(?, '$.${field}') AS ${field}`);
  const statement = db.prepare(`WITH e AS (SELECT ${fields.join(",")}) SELECT ${legacyTrialDeadlineSql("e")} AS ends FROM e`);
  return (row) => statement.get(...Object.keys(base).map(() => JSON.stringify(row))).ends;
}

test("legacy trial deadline SQL agrees with evaluateTrialActivation across basis, duration and start", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const endOf = deadlineStatement(db);
  for (const basis of ["from_issue", "from_first_activation", "from_first_use", null]) {
    for (const duration of [0, 3600]) {
      for (const started of [null, NOW - 60]) {
        for (const validUntil of [null, NOW + 86_400]) {
          const row = { ...base, trial_expiration_basis: basis, trial_duration_sec: duration, trial_started_at: started,
            trial_device_hash: started === null ? null : "device-key", valid_until: validUntil };
          assert.equal(endOf(row), enforcedEnd(row), JSON.stringify({ basis, duration, started, validUntil }));
        }
      }
    }
  }
});

test("a legacy trial has a clock only with an activation basis and a positive duration", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const endOf = deadlineStatement(db);
  const started = NOW - 60, validUntil = NOW + 86_400;
  assert.equal(endOf({ ...base, trial_duration_sec: 3600, trial_started_at: started, trial_device_hash: "device-key" }), started + 3600);
  assert.equal(endOf({ ...base, trial_expiration_basis: "from_first_use", trial_duration_sec: 3600 }), null, "the clock has not started");
  assert.equal(endOf({ ...base, trial_started_at: started, trial_device_hash: "device-key", valid_until: validUntil }), validUntil,
    "a zero-duration trial has no clock: the license end governs");
  assert.equal(endOf({ ...base, trial_expiration_basis: "from_issue", trial_duration_sec: 3600, valid_until: validUntil }), validUntil);
  assert.equal(endOf({ ...base, trial_expiration_basis: "from_issue" }), null, "the admin's default trial has no end at all");
});

test("the legacy trial deadline is built only for an SQL alias", () => {
  for (const alias of ["", "e.x", "e; DROP TABLE x", "1e", "e f"]) assert.throws(() => legacyTrialDeadlineSql(alias), /alias/);
});
