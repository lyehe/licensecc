import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { PURGE_EXPIRED_BOUND_EPHEMERA_SQL, purgeExpiredBoundEphemera, EXPIRE_BOUND_RECOVERY_SQL, expireBoundRecovery, PURGE_EXPIRED_BOUND_LEASES_SQL } from "../../src/device/bound_cleanup.mjs";

function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  let now = 1000;
  sql.function("unixepoch", () => now);
  sql.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
  const db = { prepare(query) { return { async run() { return { meta: sql.prepare(query).run() }; } }; } };
  const challenge = (id, deadline, consumed = null) => sql.prepare(`INSERT INTO device_bound_challenges
    (id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at,consumed_invocation_id)
    VALUES(?,'exchange','attempt','key','operation',?,1,?,?)`).run(id,id,deadline,consumed);
  const attempt = (id, deadline) => sql.prepare(`INSERT INTO device_bound_authorizations
    (handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,created_at,expires_at)
    VALUES(?,'client','APP','key','spki','redirect','state','pkce',1,?)`).run(id,deadline);
  return { sql, db, challenge, attempt, clock(value) { now=value; } };
}

test("lease cleanup uses its global acceptance deadline index", t => {
  const f=fixture(t);
  const plan=f.sql.prepare(`EXPLAIN QUERY PLAN ${PURGE_EXPIRED_BOUND_LEASES_SQL}`).all();
  assert.ok(plan.some(row=>row.detail.includes('idx_bound_lease_cleanup')));
});

test("expired ephemera purge uses expiry indexes and exclusive database deadlines", async t => {
  const f=fixture(t);
  for(const [i,index] of ['idx_bound_challenges_expiry','idx_bound_unconsumed_attempt_cleanup'].entries()) {
    const plan=f.sql.prepare(`EXPLAIN QUERY PLAN ${PURGE_EXPIRED_BOUND_EPHEMERA_SQL[i]}`).all();
    assert.ok(plan.some(row=>row.detail.includes(index)));
  }
  f.challenge('expired',999); f.challenge('equality',1000,'used'); f.challenge('live',1001);
  f.attempt('expired',999); f.attempt('equality',1000); f.attempt('live',1001);
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:2,attempts:2});
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:0,attempts:0});
  assert.equal(f.sql.prepare('SELECT id FROM device_bound_challenges').get().id,'live');
  f.clock(1001);
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:1,attempts:1});
});

test("each tick is bounded and the next tick resumes the backlog", async t => {
  const f=fixture(t);
  f.sql.exec('BEGIN');
  for(let i=0;i<10001;i++) { f.challenge(`c${i}`,999); f.attempt(`a${i}`,999); }
  f.sql.exec('COMMIT');
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:10000,attempts:10000});
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:1,attempts:1});
});

test("a partial sweep is repeatable and never deletes consumed recovery attempts", async t => {
  const f=fixture(t); f.attempt('consumed',999); f.attempt('pending',999); f.challenge('expired',999);
  f.sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1);
    UPDATE device_bound_authorizations SET status='approved',revision=revision+1,customer_id='owner',feature='DEFAULT',license_fingerprint='fp',
      code_hash='hash',code_expires_at=900 WHERE handle_hash='consumed';
    UPDATE device_bound_authorizations SET status='consumed',revision=revision+1,
      consumed_invocation_id='invocation',consumed_operation_id='op',recovery_until=2000
      WHERE handle_hash='consumed'`);
  const before=f.sql.prepare("SELECT * FROM device_bound_authorizations WHERE handle_hash='consumed'").get();
  const failed={prepare(query){if(query.includes('DELETE FROM device_bound_authorizations'))throw new Error('injected');return f.db.prepare(query);}};
  await assert.rejects(purgeExpiredBoundEphemera(failed),/injected/);
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:0,attempts:1});
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_authorizations').get(),before);
});

test("recovery expiry erases payloads at equality while preserving immutable operation identity",async t=>{
  const f=fixture(t);
  f.sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1);
    INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,response_json,committed_at,retain_until)
    VALUES('key','renew','op','invocation','digest','owner','binding','original-response',1,2000);
    UPDATE device_bound_operations SET status='complete';`);
  for(const [i,index] of ['idx_bound_operation_payload_cleanup','idx_bound_consumed_attempt_cleanup'].entries()){
    assert.ok(f.sql.prepare(`EXPLAIN QUERY PLAN ${EXPIRE_BOUND_RECOVERY_SQL[i]}`).all().some(row=>row.detail.includes(index)));
  }
  const before=f.sql.prepare('SELECT * FROM device_bound_operations').get();
  assert.throws(()=>f.sql.exec("UPDATE device_bound_operations SET response_json=''"),/operation_result_immutable/);
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:0,attempts:0});
  f.sql.exec(`INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,response_json,committed_at,retain_until)
    VALUES('key','renew','prepared','prepared-invocation','digest','owner','binding','uncommitted',1,1999)`);
  f.clock(2000);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_operations SET response_json='',request_digest='changed' WHERE operation_id='op'"),/operation_result_immutable/);
  assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_operations WHERE operation_id='op'").get(),before);
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:1,attempts:0});
  assert.deepEqual({...f.sql.prepare('SELECT * FROM device_bound_operations').get()},{...before,response_json:''});
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:0,attempts:0});
  assert.equal(f.sql.prepare("SELECT response_json FROM device_bound_operations WHERE status='prepared'").get().response_json,'uncommitted');
  assert.throws(()=>f.sql.exec("UPDATE device_bound_operations SET response_json='restored' WHERE operation_id='op'"),/operation_result_immutable/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_operations SET request_digest='new' WHERE operation_id='op'"),/operation_result_immutable/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_operations SET retain_until=3000 WHERE operation_id='op'"),/operation_result_immutable/);
  assert.throws(()=>f.sql.exec("DELETE FROM device_bound_operations WHERE operation_id='op'"),/operation_tombstone_required/);
  assert.throws(()=>f.sql.exec(`INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,response_json,committed_at,retain_until)
    VALUES('key','renew','op','new-invocation','new-digest','owner','binding','new-response',2000,3000)`),/operation_tombstone_required/);
  f.sql.exec('PRAGMA recursive_triggers=OFF');
  for(const [op,invocation] of [['op','new-invocation'],['new-op','invocation']]){
    assert.throws(()=>f.sql.prepare(`INSERT OR REPLACE INTO device_bound_operations
      (key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,response_json,committed_at,retain_until)
      VALUES('key','renew',?,?,'digest','owner','binding','replacement',2000,3000)`).run(op,invocation),/operation_tombstone_required/);
  }
});

test("consumed attempts survive until their recovery deadline even after original expiry",async t=>{
  const f=fixture(t); f.attempt('consumed',999);
  f.sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1);
    UPDATE device_bound_authorizations SET status='approved',revision=1,customer_id='owner',feature='DEFAULT',license_fingerprint='fp',code_hash='hash',code_expires_at=900;
    UPDATE device_bound_authorizations SET status='consumed',revision=2,consumed_invocation_id='invocation',consumed_operation_id='op',recovery_until=2000;`);
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:0,attempts:0});
  f.clock(2000);
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:0,attempts:1});
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:0,attempts:0});
});
