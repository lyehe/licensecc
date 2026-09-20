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

test("admin creates a fresh protected grant and exactly replays it without allocating devices", async t => {
  const f = fixture(t), first = await f.send(); assert.equal(first.status, 200);
  const text = await first.text(), body = JSON.parse(text);
  assert.equal(body.data.enforcement_mode, "device_bound_v1");
  assert.equal(body.data.customer_id, "owner"); assert.equal(body.data.max_active_devices, 1);
  const before = f.snapshot(); assert.deepEqual(before.slice(3), [[], [], []]);
  const retry = await f.send(); assert.equal(retry.status, 200); assert.equal(await retry.text(), text);
  assert.equal(retry.headers.get("x-idempotent-replay"), "1");
  assert.equal((await f.send({ ...input, enforcement_mode: "legacy" })).status, 409);
  assert.equal((await f.send({ ...input, feature: "OTHER" })).status, 409);
  assert.deepEqual(f.snapshot(), before);
});

test("omission stays legacy, explicit mismatches cannot convert either mode, and historical replay is not protected success", async t => {
  const f = fixture(t), { enforcement_mode, ...legacy } = input;
  const first = await f.send(legacy); assert.equal((await first.json()).data.enforcement_mode, "legacy");
  const before = f.snapshot();
  assert.equal((await f.send(input, "convert")).status, 409);
  assert.equal((await f.send(input)).status, 409);
  assert.deepEqual(f.snapshot(), before);
  const record = f.sql.prepare("SELECT response_json FROM mutation_idempotency").get();
  const historic = JSON.parse(record.response_json); delete historic.data.enforcement_mode;
  f.sql.prepare("UPDATE mutation_idempotency SET response_json=?").run(JSON.stringify(historic));
  assert.equal((await f.send(input)).status, 409);
  assert.equal((await f.send(legacy)).status, 200);
  const other = { ...input, license_fingerprint: "b".repeat(64), license_id: "second" };
  f.sql.exec("INSERT INTO licenses(id,customer_id,project,created_at,updated_at) VALUES('second','owner','APP',1,1)");
  assert.equal((await f.send(other, "second")).status, 200);
  assert.equal((await f.send({ ...other, enforcement_mode: "legacy" }, "downgrade")).status, 409);
});

for (const change of [{ customer_id: "other" }, { license_id: null }, { device_hash: "d".repeat(64) }]) {
  test(`protected creation rejects ineligible input ${JSON.stringify(change)} without residue`, async t => {
    const f = fixture(t), before = f.snapshot();
    assert.equal((await f.send({ ...input, ...change })).status, 409);
    assert.deepEqual(f.snapshot(), before);
  });
}

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
    assert.equal((await f.send({ ...input, ...(policy ? { policy_id: "policy" } : {}) })).status, 409);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("stale license ownership prevents protected creation", async t => {
  const f = fixture(t), before = f.snapshot();
  f.race(() => f.sql.exec("UPDATE licenses SET customer_id='other' WHERE id='license'"));
  assert.equal((await f.send()).status, 409); assert.deepEqual(f.snapshot(), before);
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

test("floating or unusable trial policy cannot leave a partial protected grant", async t => {
  for (const update of ["type='floating',pool_size=2", "type='trial',trial_expiration_basis='from_first_use',trial_duration_sec=0"]) {
    const f = fixture(t), before = f.snapshot(); f.sql.exec(`UPDATE entitlement_policies SET ${update}`);
    assert.equal((await f.send({ ...input, policy_id: "policy" })).status, 409);
    assert.deepEqual(f.snapshot(), before);
  }
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
    assert.equal((await f.send({ ...input, policy_id: "policy" })).status, 409);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("retained legacy history and a competing legacy insertion cannot become protected", async t => {
  for (const race of [false, true]) {
    const f = fixture(t);
    const insert = () => f.sql.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,status,created_at,updated_at) VALUES('APP','PRO',?,'active',1,1)").run(input.license_fingerprint);
    if (race) f.race(insert);
    else f.sql.prepare("INSERT INTO entitlement_events(project,feature,license_fingerprint,event_type,status,revocation_seq,created_at) VALUES('APP','PRO',?,'create','active',1,1)").run(input.license_fingerprint);
    assert.equal((await f.send()).status, 409);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM entitlements WHERE enforcement_mode='device_bound_v1'").get().n, 0);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM mutation_idempotency").get().n, 0);
  }
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

test("protected identifiers and policy dates must fit the v2 wire contract", async t => {
  const f = fixture(t), before = f.snapshot();
  for (const change of [{ license_fingerprint: "A".repeat(64) }, { license_fingerprint: "a".repeat(64) + "\n" }, { feature: "PRO SPACE" }, { feature: "PRO\u2028" }, { project: "APP\u2029" }, { project: "应用" }, { valid_until: 9007199254740992 }]) {
    assert.equal((await f.send({ ...input, ...change })).status, 400);
    assert.deepEqual(f.snapshot(), before);
  }
  f.sql.exec("UPDATE entitlement_policies SET duration_sec=100");
  assert.equal((await f.send({ ...input, policy_id: "policy", valid_from: Number.MAX_SAFE_INTEGER - 1 })).status, 409);
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
    assert.equal((await f.send({ ...input, policy_id: "policy" }, "shrink")).status, 409);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("a same-key winner is replayed only when its tuple and explicit mode match", async t => {
  for (const change of [{}, { enforcement_mode: "legacy" }, { feature: "OTHER" }]) {
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

test("an explicit legacy create cannot overwrite or claim a competing protected winner", async t => {
  for (const winnerKey of ["create", "other-key"]) {
    const f = fixture(t); let winnerSnapshot;
    f.race(async () => {
      assert.equal((await f.send(input, winnerKey)).status, 200); winnerSnapshot = f.snapshot();
    });
    const response = await f.send({ ...input, enforcement_mode: "legacy" });
    assert.equal(response.status, 409);
    assert.deepEqual(f.snapshot(), winnerSnapshot);
  }
});
