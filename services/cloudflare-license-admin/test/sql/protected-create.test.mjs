import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { worker, baseEnv, authed, syncEnv, syncAuthed } from "../worker/fixtures.mjs";

const path = "/api/admin/entitlements";
const input = { project: "APP", feature: "PRO", license_fingerprint: "a".repeat(64), customer_id: "owner", license_id: "license", enforcement_mode: "device_bound_v1" };
function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec(readFileSync(new URL("../../../cloudflare-licensing-backend/schema.sql", import.meta.url), "utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1),('other','Other',1,1);
    INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('license','owner','APP',1,1);
    INSERT INTO entitlement_policies(id,project,name,type,created_at,updated_at) VALUES('policy','APP','Policy','node_locked',1,1);`);
  let beforeBatch = () => {};
  let beforeRead = null;
  const prepare = (query, args = []) => ({ query, args,
    bind(...values) { return prepare(query, values); },
    async first(column) {
      if (beforeRead !== null && query.includes("FROM entitlements")) { const hook = beforeRead; beforeRead = null; await hook(); }
      const row = sql.prepare(query).get(...args); return column ? row?.[column] ?? null : row ?? null;
    },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() { return this.all(); },
  });
  const db = { prepare, withSession() { return this; }, async batch(statements) {
    const hook = beforeBatch; beforeBatch = () => {}; await hook(statements);
    sql.exec("BEGIN");
    try { const result = statements.map(s => ({ results: sql.prepare(s.query).all(...s.args) })); sql.exec("COMMIT"); return result; }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  } };
  const env = { ...baseEnv(db), POLICY_STAMP_MODE: "on" };
  const snapshot = () => ["entitlements", "entitlement_events", "mutation_idempotency", "device_bound_devices", "device_bound_bindings", "device_bound_leases"]
    .map(table => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const send = (body = input, key = "create", url = path, method = "POST") => worker.fetch(authed(url, { method, headers: { "idempotency-key": key }, body: JSON.stringify(body) }), env);
  return { sql, db, send, snapshot, race(fn) { beforeBatch = fn; }, raceRead(fn) { beforeRead = fn; } };
}

// A refused protected create is still 409 protected_creation_conflict; data.reason names the rule.
async function refusedFor(response, reason) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "protected_creation_conflict");
  assert.deepEqual(body.data, { reason });
}

test("admin creates a fresh protected grant and exactly replays it without allocating devices", async t => {
  const f = fixture(t), first = await f.send(); assert.equal(first.status, 200);
  const text = await first.text(), body = JSON.parse(text);
  assert.equal(body.data.enforcement_mode, "device_bound_v1");
  assert.equal(body.data.customer_id, "owner"); assert.equal(body.data.max_active_devices, 1);
  const before = f.snapshot(); assert.deepEqual(before.slice(3), [[], [], []]);
  const retry = await f.send(); assert.equal(retry.status, 200); assert.equal(await retry.text(), text);
  assert.equal(retry.headers.get("x-idempotent-replay"), "1");
  assert.equal((await f.send({ ...input, enforcement_mode: "legacy" })).status, 400);
  assert.equal((await f.send({ ...input, feature: "OTHER" })).status, 409);
  assert.deepEqual(f.snapshot(), before);
});

test("an omitted or legacy mode is refused, a legacy grant is never converted, and a cached reply without the mode is not protected success", async t => {
  const f = fixture(t), { enforcement_mode, ...omitted } = input;
  // Only a direct insert can still hold a legacy grant; the admin API never writes one.
  f.sql.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,license_id,enforcement_mode,created_at,updated_at) VALUES('APP','PRO',?,'active','owner','license','legacy',1,1)").run(input.license_fingerprint);
  const before = f.snapshot();
  const convert = await f.send(input, "convert");
  assert.equal(convert.status, 409); assert.equal((await convert.json()).code, "enforcement_mode_conflict");
  // A policy create takes the same rule: its stamp never supplies a mode.
  for (const [body, key] of [[omitted, "omitted"], [{ ...input, enforcement_mode: "legacy" }, "legacy"],
    [{ ...omitted, policy_id: "policy" }, "policy-omitted"], [{ ...input, policy_id: "policy", enforcement_mode: "legacy" }, "policy-legacy"]]) {
    const refused = await f.send(body, key);
    assert.equal(refused.status, 400); assert.equal((await refused.json()).code, "invalid_request");
  }
  assert.deepEqual(f.snapshot(), before);
  const other = { ...input, license_fingerprint: "b".repeat(64), license_id: "second" };
  f.sql.exec("INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('second','owner','APP',1,1)");
  assert.equal((await f.send(other, "second")).status, 200);
  const record = f.sql.prepare("SELECT response_json FROM mutation_idempotency WHERE idempotency_key='second'").get();
  const historic = JSON.parse(record.response_json); delete historic.data.enforcement_mode;
  f.sql.prepare("UPDATE mutation_idempotency SET response_json=? WHERE idempotency_key='second'").run(JSON.stringify(historic));
  const replay = await f.send(other, "second");
  assert.equal(replay.status, 409); assert.equal((await replay.json()).code, "idempotency_request_conflict");
});

for (const [change, reason] of [[{ customer_id: "other" }, "license_customer_mismatch"], [{ license_id: null }, "license_missing"]]) {
  test(`protected creation rejects ineligible input ${JSON.stringify(change)} without residue`, async t => {
    const f = fixture(t), before = f.snapshot();
    await refusedFor(await f.send({ ...input, ...change }), reason);
    assert.deepEqual(f.snapshot(), before);
  });
}

// A protected grant carries no device hash and no assertion TTL, on a direct or a policy create.
test("a create naming a device hash or an assertion TTL is refused before any write", async t => {
  const f = fixture(t), before = f.snapshot();
  for (const policy of [{}, { policy_id: "policy" }]) {
    for (const field of [{ device_hash: "" }, { device_hash: "d".repeat(64) }, { assertion_ttl_seconds: 300 }]) {
      const refused = await f.send({ ...input, ...policy, ...field }, JSON.stringify({ ...policy, ...field }));
      assert.equal(refused.status, 400, JSON.stringify(field)); assert.equal((await refused.json()).code, "invalid_request");
    }
  }
  assert.deepEqual(f.snapshot(), before);
});

test("policy creation copies standard and trial settings and retries after policy disable", async t => {
  for (const type of ["node_locked", "trial"]) {
    const f = fixture(t);
    f.sql.prepare("UPDATE entitlement_policies SET type=?,trial_expiration_basis='from_first_activation',trial_duration_sec=600").run(type);
    const request = { ...input, policy_id: "policy" };
    const first = await f.send(request); assert.equal(first.status, 200);
    const text = await first.text(), body = JSON.parse(text);
    assert.equal(body.data.enforcement_mode, "device_bound_v1"); assert.equal(body.data.is_trial, type === "trial" ? 1 : 0);
    f.sql.exec("UPDATE entitlement_policies SET status='disabled'");
    const retry = await f.send(request); assert.equal(retry.status, 200); assert.equal(await retry.text(), text);
    for (const policy_id of [[], "p".repeat(129)]) assert.equal((await f.send({ ...request, policy_id })).status, 400);
    assert.equal((await f.send({ ...request, assertion_ttl_seconds: null })).status, 400);
  }
});

test("stale customer and policy eligibility roll back the entire claimed creation", async t => {
  for (const policy of [false, true]) {
    const f = fixture(t), before = f.snapshot();
    f.race(() => f.sql.exec(policy ? "UPDATE entitlement_policies SET max_active_devices=2" : "UPDATE customers SET status='disabled' WHERE id='owner'"));
    await refusedFor(await f.send({ ...input, ...(policy ? { policy_id: "policy" } : {}) }), policy ? "policy_mismatch" : "customer_inactive");
    assert.deepEqual(f.snapshot(), before);
  }
});

test("stale license ownership prevents protected creation", async t => {
  const f = fixture(t), before = f.snapshot();
  f.race(() => f.sql.exec("UPDATE licenses SET customer_id='other' WHERE id='license'"));
  await refusedFor(await f.send(), "license_customer_mismatch"); assert.deepEqual(f.snapshot(), before);
});

test("a committed creation is recoverable even when the winner's grant is subsequently revoked", async t => {
  const f = fixture(t); let winnerText, afterRevoke;
  f.raceRead(async () => {
    const response = await f.send(); assert.equal(response.status, 200); winnerText = await response.text();
    f.sql.exec("UPDATE entitlements SET status='revoked'"); afterRevoke = f.snapshot();
  });
  const response = await f.send(); assert.equal(response.status, 200); assert.equal(await response.text(), winnerText);
  assert.deepEqual(f.snapshot(), afterRevoke);
});

test("an unusable trial policy cannot leave a partial protected grant", async t => {
  const f = fixture(t), before = f.snapshot();
  f.sql.exec("UPDATE entitlement_policies SET type='trial',trial_expiration_basis='from_first_use',trial_duration_sec=0");
  await refusedFor(await f.send({ ...input, policy_id: "policy" }), "invalid_trial");
  assert.deepEqual(f.snapshot(), before);
});

// The stamp writes provenance, the device limit and the trial state only, so a policy that still
// carries a seat pool, borrowing or a meter yields an issuable protected grant without any of them.
test("a policy with a seat pool, borrowing or a meter stamps a protected grant without them", async t => {
  const f = fixture(t);
  f.sql.exec("UPDATE entitlement_policies SET type='floating',pool_size=2,max_active_devices=2,max_borrow_sec=60,meter_quota=10,meter_period_sec=3600,assertion_ttl_seconds=900");
  const created = await f.send({ ...input, policy_id: "policy" }); assert.equal(created.status, 200, await created.clone().text());
  const row = f.sql.prepare("SELECT enforcement_mode,policy_id,pool_size,max_active_devices,max_borrow_sec,meter_quota,meter_period_sec,assertion_ttl_seconds,device_hash FROM entitlements").get();
  assert.deepEqual({ ...row }, { enforcement_mode: "device_bound_v1", policy_id: "policy", pool_size: 0, max_active_devices: 2, max_borrow_sec: 0,
    meter_quota: 0, meter_period_sec: 2592000, assertion_ttl_seconds: 300, device_hash: "" });
});

test("a missing or incorrect policy side-write rolls back the preceding upsert", async t => {
  for (const missing of [true, false]) {
    const f = fixture(t), before = f.snapshot();
    f.race(statements => {
      const stamp = statements.find(s => s.query.startsWith("UPDATE entitlements SET policy_id"));
      assert.ok(stamp);
      if (missing) stamp.query = stamp.query.replace("WHERE project", "WHERE 0 AND project");
      else stamp.args[0] = null;
    });
    // Every rule holds for the row the create meant to write; only the injected fault differs.
    await refusedFor(await f.send({ ...input, policy_id: "policy" }), "unknown");
    assert.deepEqual(f.snapshot(), before);
  }
});

test("a competing legacy insertion cannot become protected", async t => {
  const f = fixture(t);
  f.race(() => f.sql.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,status,enforcement_mode,created_at,updated_at) VALUES('APP','PRO',?,'active','legacy',1,1)").run(input.license_fingerprint));
  await refusedFor(await f.send(), "fingerprint_in_use");
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM entitlements WHERE enforcement_mode='device_bound_v1'").get().n, 0);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM mutation_idempotency").get().n, 0);
});

test("a protected denial does not block re-creating the same grant", async t => {
  const f = fixture(t);
  assert.equal((await f.send()).status, 200);
  // The protected issuer records a refused connection against the grant's key.
  f.sql.prepare("INSERT INTO usage_events(project,feature,license_fingerprint,event_type,device_key_id,reason,ts) VALUES(?,?,?,'denied','key','device_limit_reached',1)")
    .run(input.project, input.feature, input.license_fingerprint);
  const again = await f.send(input, "again");
  assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
});

test("malformed modes and attempts to patch mode are rejected", async t => {
  const f = fixture(t);
  for (const mode of [null, [], "", " device_bound_v1", "floating"]) assert.equal((await f.send({ ...input, enforcement_mode: mode })).status, 400);
  for (const mode of ["legacy", "device_bound_v1"]) {
    const response = await worker.fetch(syncAuthed({ ...input, enforcement_mode: mode }), syncEnv(f.db));
    assert.equal(response.status, 400);
  }
  const first = await f.send(), body = await first.json(); assert.equal(first.status, 200);
  assert.equal((await f.send({ enforcement_mode: "legacy" }, "patch", `${path}/${body.data.id}`, "PATCH")).status, 400);
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});

// A sync writes the same protected grant as an admin create, under the same checks, and never
// reports a grant of another mode as synced.
test("sync runs the protected create checks and never yields a legacy grant", async t => {
  const f = fixture(t), { enforcement_mode: _mode, ...body } = input;
  const sync = (payload, key) => worker.fetch(syncAuthed(payload, { headers: { "idempotency-key": key } }), syncEnv(f.db));
  const before = f.snapshot();
  await refusedFor(await sync({ ...body, customer_id: "other" }, "other-owner"), "license_customer_mismatch");
  assert.deepEqual(f.snapshot(), before, "a refused sync leaves no grant, audit event or replay record");
  const synced = await sync(body, "owned");
  assert.equal(synced.status, 200, await synced.clone().text());
  assert.equal((await synced.json()).data.enforcement_mode, "device_bound_v1");
  // A legacy grant is never converted, and even an unchanged one is a conflict rather than a no-op.
  f.sql.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,license_id,enforcement_mode,created_at,updated_at) VALUES('APP','OLD',?,'active','owner','license','legacy',1,1)")
    .run(input.license_fingerprint);
  const legacy = f.snapshot();
  for (const [payload, key] of [[{ ...body, feature: "OLD" }, "legacy-unchanged"], [{ ...body, feature: "OLD", notes: "changed" }, "legacy-changed"],
    [{ ...body, feature: "OLD", status: "revoked", reason: "ended" }, "legacy-revoked"]]) {
    const conflict = await sync(payload, key);
    assert.equal(conflict.status, 409, key); assert.equal((await conflict.json()).code, "enforcement_mode_conflict");
  }
  assert.deepEqual(f.snapshot(), legacy);
});

// A synced disable or revocation of an existing protected grant always applies, whatever the state
// of its owner, license or row: it changes only the status, as an operator's transition does.
const WITHDRAWAL_CASES = [
  ["the customer is disabled", "UPDATE customers SET status='disabled' WHERE id='owner'"],
  ["the license moved to another customer", "UPDATE licenses SET customer_id='other' WHERE id='license'"],
  ["the license is detached", "UPDATE licenses SET customer_id=NULL WHERE id='license'"],
  ["its from_issue trial has expired", "UPDATE entitlements SET is_trial=1, trial_expiration_basis='from_issue', valid_until=100"],
  ["the protected row carries a seat pool", "UPDATE entitlements SET pool_size=5"],
  ["the protected row carries a stale device hash", `UPDATE entitlements SET device_hash='${"d".repeat(64)}'`],
];
const KEPT_COLUMNS = "customer_id, license_id, notes, valid_from, valid_until, is_trial, pool_size, device_hash, enforcement_mode";

for (const [name, change] of WITHDRAWAL_CASES) {
  for (const status of ["disabled", "revoked"]) {
    test(`a synced ${status === "revoked" ? "revocation" : "disable"} applies when ${name}`, async t => {
      const f = fixture(t), { enforcement_mode: _mode, ...body } = input;
      const sync = (payload, key) => worker.fetch(syncAuthed(payload, { headers: { "idempotency-key": key } }), syncEnv(f.db));
      assert.equal((await sync(body, "create")).status, 200);
      f.sql.exec(change);
      const kept = f.sql.prepare(`SELECT ${KEPT_COLUMNS} FROM entitlements`).get();
      const withdrawn = await sync({ ...body, status, notes: "not written", reason: "subscription ended" }, "withdraw");
      assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
      assert.equal((await withdrawn.json()).data.status, status);
      assert.equal(f.sql.prepare("SELECT status FROM entitlements").get().status, status);
      assert.deepEqual({ ...f.sql.prepare(`SELECT ${KEPT_COLUMNS} FROM entitlements`).get() }, { ...kept }, "only the status changes");
      const event = f.sql.prepare("SELECT event_type, source, reason FROM entitlement_events ORDER BY id DESC LIMIT 1").get();
      assert.deepEqual({ ...event }, { event_type: status === "revoked" ? "revoke" : "disable", source: "sync", reason: "subscription ended" });
    });
  }
}

test("a synced disable or revocation naming another owner keeps the grant's owner and license", async t => {
  const f = fixture(t), { enforcement_mode: _mode, ...body } = input;
  const sync = (payload, key) => worker.fetch(syncAuthed(payload, { headers: { "idempotency-key": key } }), syncEnv(f.db));
  f.sql.exec("INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('license-other','other','APP',1,1)");
  assert.equal((await sync(body, "create")).status, 200);
  const moved = { ...body, customer_id: "other", license_id: "license-other", reason: "subscription ended" };
  for (const status of ["disabled", "revoked"]) {
    const withdrawn = await sync({ ...moved, status }, status);
    assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
    const data = (await withdrawn.json()).data;
    assert.deepEqual([data.status, data.customer_id, data.license_id], [status, "owner", "license"]);
    assert.deepEqual({ ...f.sql.prepare("SELECT status, customer_id, license_id FROM entitlements").get() }, { status, customer_id: "owner", license_id: "license" });
  }
});

// Only a withdrawal skips the checks: a sync that creates a grant, or that leaves or makes one active,
// still has to meet every protected rule.
test("a synced create or reactivation still runs the protected checks", async t => {
  const f = fixture(t), { enforcement_mode: _mode, ...body } = input;
  const sync = (payload, key) => worker.fetch(syncAuthed(payload, { headers: { "idempotency-key": key } }), syncEnv(f.db));
  assert.equal((await sync(body, "create")).status, 200);
  f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");
  await refusedFor(await sync({ ...body, notes: "changed" }, "active-update"), "customer_inactive");
  await refusedFor(await sync({ ...body, feature: "NEW", status: "revoked", reason: "never issued" }, "revoked-create"), "customer_inactive");
  assert.equal((await sync({ ...body, status: "disabled", reason: "paused" }, "disable")).status, 200);
  const disabled = f.snapshot();
  await refusedFor(await sync(body, "reenable"), "customer_inactive");
  assert.deepEqual(f.snapshot(), disabled, "a refused reactivation writes nothing");
});

test("protected identifiers and policy dates must fit the v2 wire contract", async t => {
  const f = fixture(t), before = f.snapshot();
  for (const change of [{ license_fingerprint: "A".repeat(64) }, { license_fingerprint: "a".repeat(64) + "\n" }, { feature: "PRO SPACE" }, { feature: "PRO\u2028" }, { project: "APP\u2029" }, { project: "应用" }, { valid_until: 9007199254740992 }]) {
    assert.equal((await f.send({ ...input, ...change })).status, 400);
    assert.deepEqual(f.snapshot(), before);
  }
  f.sql.exec("UPDATE entitlement_policies SET duration_sec=100");
  await refusedFor(await f.send({ ...input, policy_id: "policy", valid_from: Number.MAX_SAFE_INTEGER - 1 }), "unknown");
  assert.deepEqual(f.snapshot(), before);
});

test("occupied active or retiring capacity returns a conflict without changing authority", async t => {
  for (const state of ["active", "retiring"]) {
    const f = fixture(t); assert.equal((await f.send()).status, 200);
    f.sql.exec(`INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at) VALUES('device','owner','APP','key','synthetic',1,1);
      INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,hold_until,created_at,updated_at)
      VALUES('binding','APP','PRO','${input.license_fingerprint}','device','${state}',4102444800,1,1);
      UPDATE entitlement_policies SET max_active_devices=0;`);
    const before = f.snapshot();
    await refusedFor(await f.send({ ...input, policy_id: "policy" }, "shrink"), "invalid_capacity");
    assert.deepEqual(f.snapshot(), before);
  }
});

test("a same-key winner is replayed only when its tuple matches", async t => {
  for (const change of [{}, { feature: "OTHER" }]) {
    const f = fixture(t); let winnerText, winnerSnapshot;
    f.race(async () => {
      const winner = await f.send({ ...input, ...change }); assert.equal(winner.status, 200);
      winnerText = await winner.text(); winnerSnapshot = f.snapshot();
    });
    const loser = await f.send();
    if (Object.keys(change).length === 0) { assert.equal(loser.status, 200); assert.equal(await loser.text(), winnerText); }
    else { assert.equal(loser.status, 409); assert.equal((await loser.json()).code, "idempotency_request_conflict"); }
    assert.deepEqual(f.snapshot(), winnerSnapshot);
  }
});

// Every refusal names the first rule the create broke. Each case also proves the rule was the
// whole cause: undoing only that condition lets the same request succeed under a new key.
const fp = input.license_fingerprint, otherFp = "b".repeat(64);
const REASON_CASES = [
  { reason: "customer_inactive", setup: "UPDATE customers SET status='disabled' WHERE id='owner'", fix: "UPDATE customers SET status='active' WHERE id='owner'" },
  { reason: "license_missing", body: { license_id: "lic_missing" }, fix: "INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('lic_missing','owner','APP',1,1)" },
  { reason: "license_customer_mismatch", setup: "INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('elsewhere','owner','ELSEWHERE',1,1)",
    body: { license_id: "elsewhere" }, fix: "UPDATE licenses SET project='APP' WHERE id='elsewhere'" },
  { reason: "fingerprint_in_use", name: "fingerprint held by another customer",
    setup: `INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,created_at,updated_at) VALUES('APP','OTHER','${fp}','active','other',1,1)`,
    fix: "DELETE FROM entitlements WHERE feature='OTHER'" },
  { reason: "fingerprint_in_use", name: "license already paired with another fingerprint",
    setup: `INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,license_id,created_at,updated_at) VALUES('APP','OTHER','${otherFp}','active','owner','license',1,1)`,
    fix: "DELETE FROM entitlements WHERE feature='OTHER'" },
  { reason: "plan_assignment_conflict",
    setup: `INSERT INTO catalog_plans(id,project,plan_key,name,created_at,updated_at) VALUES('plan','APP','basic','Basic',1,1);
      INSERT INTO license_plan_assignments(license_id,project,plan_id,license_fingerprint,customer_id,created_at,updated_at) VALUES('license','APP','plan','${otherFp}','owner',1,1)`,
    fix: `UPDATE license_plan_assignments SET license_fingerprint='${fp}'` },
  { reason: "policy_mismatch", body: { policy_id: "policy" }, race: "UPDATE entitlement_policies SET max_borrow_sec=60" },
  // The likeliest trigger: an active policy of another project, which the create never re-checks
  // against the grant's project before the batch guard refuses it.
  { reason: "policy_mismatch", name: "another project's active policy",
    setup: "INSERT INTO entitlement_policies(id,project,name,type,created_at,updated_at) VALUES('elsewhere','ELSEWHERE','Elsewhere','node_locked',1,1)",
    body: { policy_id: "elsewhere" }, fixedBody: { policy_id: "policy" } },
  { reason: "invalid_trial", setup: "UPDATE entitlement_policies SET type='trial',trial_expiration_basis='from_first_activation',trial_duration_sec=1",
    body: { policy_id: "policy" }, fix: "UPDATE entitlement_policies SET trial_duration_sec=600" },
  { reason: "invalid_capacity", setup: "UPDATE entitlement_policies SET max_active_devices=0", body: { policy_id: "policy" }, fix: "UPDATE entitlement_policies SET max_active_devices=1" },
  // The owner-change trigger also aborts with capacity_in_use. A move to another customer while a
  // device is connected is its own rule; a higher device limit cannot fix it.
  { reason: "devices_connected", name: "a move to another customer while a device is connected",
    setup: `INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,license_id,enforcement_mode,max_active_devices,created_at,updated_at)
        VALUES('APP','PRO','${fp}','active','owner','license','device_bound_v1',5,1,1);
      INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('license-other','other','APP',1,1);
      INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at) VALUES('device','owner','APP','key','synthetic',1,1);
      INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,hold_until,created_at,updated_at)
        VALUES('binding','APP','PRO','${fp}','device','active',0,1,1)`,
    body: { customer_id: "other", license_id: "license-other" }, fix: "UPDATE device_bound_bindings SET state='retiring'" },
  // A policy window pushed past the largest safe time breaks only the integrity rule.
  { reason: "unknown", setup: "UPDATE entitlement_policies SET duration_sec=100", body: { policy_id: "policy", valid_from: Number.MAX_SAFE_INTEGER - 1 },
    fixedBody: { policy_id: "policy" } },
  // A re-create keeps the stored device hash, so a stale one breaks the integrity rule; the diagnostic
  // must read it from the stored row rather than from the create's empty input.
  { reason: "unknown", name: "a stored stale device hash",
    setup: `INSERT INTO entitlements(project,feature,license_fingerprint,device_hash,status,customer_id,license_id,enforcement_mode,created_at,updated_at)
      VALUES('APP','PRO','${fp}','${"d".repeat(64)}','active','owner','license','device_bound_v1',1,1)`,
    fix: "UPDATE entitlements SET device_hash=''" },
];

for (const { reason, name = reason, setup, race, body = {}, fix, fixedBody = body } of REASON_CASES) {
  test(`a protected create refused by ${name} reports ${reason}, and succeeds once only that is fixed`, async t => {
    const f = fixture(t);
    if (setup) f.sql.exec(setup);
    if (race) f.race(() => f.sql.exec(race));
    const before = f.snapshot();
    await refusedFor(await f.send({ ...input, ...body }, "refused"), reason);
    assert.deepEqual(f.snapshot(), before, "a refusal leaves no grant, audit event, or replay record");
    if (fix) f.sql.exec(fix);
    const retried = await f.send({ ...input, ...fixedBody }, "fixed");
    assert.equal(retried.status, 200, JSON.stringify(await retried.clone().json()));
  });
}

test("a refused re-create of an existing protected grant reports the broken rule, not the grant it would update", async t => {
  const f = fixture(t);
  assert.equal((await f.send()).status, 200);
  f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");
  await refusedFor(await f.send(input, "again"), "customer_inactive");
  f.sql.exec("UPDATE customers SET status='active' WHERE id='owner'");
  assert.equal((await f.send(input, "again-active")).status, 200);
});

test("a create without a policy is judged with the trial state it keeps from the existing grant", async t => {
  const f = fixture(t);
  f.sql.exec("UPDATE entitlement_policies SET type='trial',trial_expiration_basis='from_issue',trial_duration_sec=600");
  assert.equal((await f.send({ ...input, policy_id: "policy" })).status, 200);
  const before = f.snapshot();
  // The upsert rewrites valid_until but leaves is_trial/from_issue in place, so an ended trial is refused.
  await refusedFor(await f.send({ ...input, valid_until: 1000 }, "expired-trial"), "invalid_trial");
  assert.deepEqual(f.snapshot(), before);
});

// Differential net for the diagnostic: the would-be row it rebuilds from a create's inputs must equal
// the row that create then commits. The would-be row is read BEFORE the final create, from the state
// a refused batch rolls back to; read afterwards, its LEFT JOIN would see the committed row and hide
// the gap. A new side-write the would-be row does not model (for example a create-time device limit)
// therefore fails here instead of making every refusal of that create read as unknown. Policies here
// keep stamped validity independent of time.
const WOULD_BE_ROW_CASES = [
  { name: "a fresh grant without a policy", creates: [{}] },
  { name: "a fresh grant stamped from a policy", policy: "type='trial',trial_expiration_basis='from_first_activation',trial_duration_sec=600,max_active_devices=3,max_borrow_sec=60", creates: [{ policy_id: "policy" }] },
  { name: "a grant re-created without a policy over a stamped one", policy: "type='trial',trial_expiration_basis='from_first_activation',trial_duration_sec=600,max_active_devices=3", creates: [{ policy_id: "policy" }, { notes: "again" }] },
  { name: "a grant re-created from a policy over an unstamped one", policy: "max_active_devices=4,meter_quota=9", creates: [{}, { policy_id: "policy" }] },
  // A create without a policy may set its own device limit in the same batch.
  { name: "a fresh grant with its own device limit", creates: [{ max_active_devices: 3 }] },
  { name: "a grant re-created with its own device limit over a stamped one", policy: "max_active_devices=4", creates: [{ policy_id: "policy" }, { max_active_devices: 7 }] },
];

for (const { name, policy, creates } of WOULD_BE_ROW_CASES) {
  test(`the diagnostic's would-be row equals the committed row for ${name}`, async t => {
    const { protectedWouldBeRowQuery } = await import("../../dist-worker/worker/groups/entitlements/protected-checks.js");
    const { stampFromPolicy } = await import("@licensecc/licensing-domain/entitlements/policy");
    const f = fixture(t);
    if (policy) f.sql.exec(`UPDATE entitlement_policies SET ${policy}`);
    for (const [index, change] of creates.slice(0, -1).entries()) assert.equal((await f.send({ ...input, ...change }, `create-${index}`)).status, 200);
    const last = { ...input, ...creates.at(-1) };
    const policyRow = last.policy_id === undefined ? undefined : f.sql.prepare("SELECT * FROM entitlement_policies WHERE id=?").get(last.policy_id);
    // The Worker hands the diagnostic what createFromPolicy stamped, or the validated body otherwise.
    const used = policyRow === undefined ? last : { ...stampFromPolicy(policyRow, last, 0).input, enforcement_mode: last.enforcement_mode };
    const { sql, binds } = protectedWouldBeRowQuery(used, policyRow);
    const wouldBe = f.sql.prepare(`${sql} SELECT * FROM e`).get(...binds);
    assert.equal((await f.send(last, "final")).status, 200);
    const committed = f.sql.prepare(`SELECT ${Object.keys(wouldBe).join(", ")} FROM entitlements WHERE project=? AND feature=? AND license_fingerprint=?`)
      .get(input.project, input.feature, input.license_fingerprint);
    assert.ok(Object.keys(wouldBe).length >= 19);
    assert.deepEqual({ ...wouldBe }, { ...committed });
  });
}

test("the diagnostic's unwritten columns fall back to the schema's own entitlement defaults", async t => {
  const { STAMP_COLUMN_DEFAULTS } = await import("../../dist-worker/worker/groups/entitlements/protected-checks.js");
  const f = fixture(t);
  const defaults = new Map(f.sql.prepare("PRAGMA table_info(entitlements)").all().map(column => [column.name, column.dflt_value]));
  for (const [column, value] of Object.entries(STAMP_COLUMN_DEFAULTS)) {
    const declared = defaults.get(column);
    assert.equal(declared === null ? null : Number(declared), value, column);
  }
});
