import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { boundTrialState, boundTrialSql, boundTrialDeadlineSql } from "@licensecc/cloudflare-runtime/device/bound_trial";

const key = `sha256:${"a".repeat(64)}`;
const base = { is_trial: 1, trial_expiration_basis: "from_first_activation", trial_duration_sec: 100,
  trial_one_per_device: 1, trial_started_at: null, trial_device_key_id: null, valid_until: null };

test("protected trial SQL and JS agree on timing, malformed policy and key locks", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const fields = Object.keys(base).map(f => `json_extract(?, '$.${f}') AS ${f}`);
  const query = allow => db.prepare(`WITH e AS (SELECT ${fields.join(",")}), p AS (SELECT ? AS key, ? AS now)
    SELECT ${boundTrialSql("e", "p.key", "p.now", allow)} AS allowed,
      ${boundTrialDeadlineSql("e", "p.now")} AS deadline FROM e,p`);
  const statements = [query(false), query(true)];
  const cases = [
    {}, { trial_expiration_basis: "from_first_use" }, { trial_expiration_basis: "unknown" },
    { trial_expiration_basis: "from_issue", valid_until: 1100 },
    { trial_expiration_basis: "from_issue", valid_until: 1000 },
    { trial_expiration_basis: "from_issue", valid_until: 1100.5 },
    { trial_expiration_basis: "from_issue" }, { trial_duration_sec: 0 }, { trial_duration_sec: 1 },
    { trial_duration_sec: 2 }, { trial_duration_sec: 100.5 }, { trial_duration_sec: "100" },
    { trial_duration_sec: Number.MAX_SAFE_INTEGER }, { trial_one_per_device: 2 },
    { trial_device_key_id: key },
    { trial_started_at: 900 }, { trial_started_at: 900, trial_device_key_id: key },
    { trial_started_at: 901, trial_device_key_id: key }, { trial_started_at: 1001, trial_device_key_id: key },
    { trial_started_at: 999.5, trial_device_key_id: key }, { trial_started_at: -1, trial_device_key_id: key },
    { trial_started_at: 950, trial_device_key_id: key + "\n" },
    { trial_started_at: 950, trial_device_key_id: key + "\0suffix", trial_one_per_device: 0 },
    { trial_started_at: 950, trial_device_key_id: key.slice(0,-1) + "\0", trial_one_per_device: 0 },
    { trial_started_at: 950, trial_device_key_id: `sha256:${"b".repeat(64)}` },
    { trial_started_at: 950, trial_device_key_id: `sha256:${"b".repeat(64)}`, trial_one_per_device: 0 },
    { is_trial: 0 }, { is_trial: 2 },
  ];
  for (const patch of cases) for (const allow of [false, true]) for (const proven of [key, key + "\n", key + "\0suffix", key.slice(0,-1) + "\0"]) {
    const row = { ...base, ...patch }, encoded = JSON.stringify(row);
    const js = boundTrialState(row, proven, 1000, allow);
    const sql = statements[Number(allow)].get(...Object.keys(base).map(() => encoded), proven, 1000);
    const context = JSON.stringify({ patch, allow, proven });
    assert.equal(Boolean(sql.allowed), js !== null, context);
    if (js && row.is_trial === 1) assert.equal(sql.deadline, js.expiresAt, context);
  }
});

test("a started trial never derives a later deadline from a retry time", () => {
  const row = { ...base, trial_started_at: 1000, trial_device_key_id: key };
  assert.deepEqual(boundTrialState(row, key, 1050), { stamp: 0, expiresAt: 1100 });
  assert.equal(boundTrialState(row, key, 1100), null);
  assert.deepEqual(boundTrialState({ ...row, trial_expiration_basis: "from_issue", valid_until: 1200 }, key, 1100),
    { stamp: 0, expiresAt: 1200 });
});

// The customer portal shows when a trial ends with no prospective start: a trial that starts at its
// first activation and has not started yet has no end to show.
test("a NULL prospective start leaves an unstarted activation trial without an end", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const fields = Object.keys(base).map(f => `json_extract(?, '$.${f}') AS ${f}`);
  const statement = db.prepare(`WITH e AS (SELECT ${fields.join(",")}) SELECT ${boundTrialDeadlineSql("e", "NULL")} AS ends FROM e`);
  const endOf = patch => {
    const encoded = JSON.stringify({ ...base, ...patch });
    return statement.get(...Object.keys(base).map(() => encoded)).ends;
  };
  assert.equal(endOf({}), null);
  assert.equal(endOf({ trial_expiration_basis: "from_first_use" }), null);
  assert.equal(endOf({ trial_started_at: 900, trial_device_key_id: key }), 1000);
  assert.equal(endOf({ trial_expiration_basis: "from_issue", valid_until: 1100 }), 1100);
});
