import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { BOUND_CLEANUP_BACKLOG_SQL, measureBoundCleanupBacklog, purgeExpiredBoundEphemera,
  purgeExpiredBoundApprovals, expireBoundRecovery, purgeExpiredBoundLeases } from '../../src/device/bound_cleanup.mjs';

function fixture(t) {
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  let now = 1000, reads = 0, sessions = 0;
  sql.function('unixepoch', () => now); sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Private customer',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,created_at,updated_at)
    VALUES('APP','PRO','fp','owner','active','device_bound_v1',1,1);
    INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
    VALUES('device','owner','APP','key','private-key-identity',1,1);
    INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,hold_until,created_at,updated_at)
    VALUES('binding','APP','PRO','fp','device',99999,1,1);
    INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at)
    VALUES('event','binding','owner','exchange','private-actor',1);`);
  const db = {
    prepare(query) { return {
      async first() { reads++; return sql.prepare(query).get() ?? null; },
      async run() { return {meta: sql.prepare(query).run()}; },
    }; },
    withSession(mode) { assert.equal(mode,'first-primary'); sessions++; return db; },
  };
  function attempt(id, expires, status='pending', code=null, recovery=null, ciphertext=null) {
    const approved = status==='approved' || status==='consumed';
    sql.prepare(`INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,
      client_state,pkce_challenge,created_at,expires_at,status,customer_id,feature,license_fingerprint,code_hash,code_expires_at,
      approval_ciphertext,consumed_invocation_id,consumed_operation_id,recovery_until)
      VALUES(?,'client','APP','key','spki','redirect','state','pkce',0,?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id,expires,status,approved?'owner':null,approved?'PRO':null,approved?'fp':null,approved?'hash':null,code,ciphertext,
        status==='consumed'?id:null,status==='consumed'?id:null,recovery);
  }
  function challenge(id, expires, consumed=null) {
    sql.prepare(`INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at,consumed_invocation_id)
      VALUES(?,'exchange','attempt','key','operation',?,0,?,?)`).run(id,id,expires,consumed);
  }
  function operation(id, retain, status='complete', response='private-response') {
    sql.prepare(`INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,
      response_json,committed_at,retain_until,status) VALUES('key','renew',?,?,'private-digest','owner','binding',?,0,?,?)`)
      .run(id,id,response,retain,status);
  }
  function lease(id, accept) {
    sql.prepare(`INSERT INTO device_bound_leases(id,binding_id,generation,entitlement_revision,invocation_id,issued_at,expires_at,accept_until,token)
      VALUES(?,'binding',1,0,?,0,?,?,'private-token')`).run(id,id,accept-120,accept);
  }
  return {sql,db,attempt,challenge,operation,lease,clock(value){now=value;},counts(){return{reads,sessions};}};
}
const byTarget = rows => Object.fromEntries(rows.map(row=>[`${row.source}.${row.target}`,row]));

test('one read-only primary snapshot measures exact lifecycles without authority or record data', async t => {
  const f=fixture(t);
  f.attempt('approval',2000,'approved',900,null,'private-ciphertext');
  f.attempt('pending',900); f.attempt('denied',950,'denied');
  f.attempt('consumed',500,'consumed',400,800);
  f.attempt('erased',2000,'approved',1); // No ciphertext: no approval backlog.
  f.challenge('consumed-challenge',900,'used'); f.challenge('live-challenge',1001);
  f.operation('complete',900); f.operation('prepared',1,'prepared'); f.operation('erased',1,'complete','');
  f.lease('equality',1000); f.lease('live',1001);
  const changes = f.sql.prepare('SELECT total_changes() AS n').get().n;
  const rows = await measureBoundCleanupBacklog(f.db);
  assert.deepEqual(rows.map(row=>[row.source,row.target,row.oldest_expired_at,row.backlog_age_seconds]),[
    ['approval','responses',900,100],['ephemera','challenges',900,100],['ephemera','attempts',900,100],
    ['recovery','responses',900,100],['recovery','attempts',800,200],['lease','leases',1000,0],
  ]);
  assert.ok(rows.every(row=>row.measured_at===1000 && row.backlog_present));
  assert.deepEqual(f.counts(),{reads:1,sessions:1});
  assert.equal(f.sql.prepare('SELECT total_changes() AS n').get().n,changes);
  assert.doesNotMatch(JSON.stringify(rows),/private-|binding|owner|hash|token/);
  f.clock(700); // Clock rollback changes eligibility; it never creates a negative age.
  assert.ok((await measureBoundCleanupBacklog(f.db)).every(row=>!row.backlog_present && row.oldest_expired_at===null && row.backlog_age_seconds===null));
});

test('every probe uses its required deadline index and missing migration fails instead of scanning history', async t => {
  const f=fixture(t);
  const plan=f.sql.prepare(`EXPLAIN QUERY PLAN ${BOUND_CLEANUP_BACKLOG_SQL}`).all().map(row=>row.detail).join('\n');
  for(const index of ['idx_bound_approval_cleanup','idx_bound_challenges_expiry','idx_bound_unconsumed_attempt_cleanup',
    'idx_bound_operation_payload_cleanup','idx_bound_consumed_attempt_cleanup','idx_bound_lease_cleanup']) {
    assert.match(plan,new RegExp(`(?:COVERING )?INDEX ${index} `));
  }
  assert.doesNotMatch(plan,/SCAN device_bound_|USE TEMP B-TREE/);
  f.sql.exec('DROP INDEX idx_bound_unconsumed_attempt_cleanup');
  await assert.rejects(measureBoundCleanupBacklog(f.db),/no such index/);
});

for(const count of [10000,10001]) test(`${count} eligible rows distinguishes a full budget from a remaining backlog`,async t=>{
  const f=fixture(t);
  f.sql.exec('BEGIN'); for(let i=0;i<count;i++) f.challenge(`c${i}`,999); f.sql.exec('COMMIT');
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:10000,attempts:0});
  const first=byTarget(await measureBoundCleanupBacklog(f.db))['ephemera.challenges'];
  assert.equal(first.backlog_present,count===10001);
  assert.equal(first.backlog_age_seconds,count===10001?1:null);
  await purgeExpiredBoundEphemera(f.db);
  assert.equal(byTarget(await measureBoundCleanupBacklog(f.db))['ephemera.challenges'].backlog_present,false);
  assert.equal(f.sql.prepare('SELECT hold_until FROM device_bound_bindings').get().hold_until,99999);
});

test('partial sweep failure leaves measurable work and all enforcement identity intact',async t=>{
  const f=fixture(t); f.challenge('expired',900); f.attempt('expired',800);
  const before=f.sql.prepare('SELECT * FROM device_bound_bindings').get();
  const failed={prepare(query){if(query.includes('DELETE FROM device_bound_authorizations'))throw new Error('private-failure');return f.db.prepare(query);}};
  await assert.rejects(purgeExpiredBoundEphemera(failed),/private-failure/);
  const rows=byTarget(await measureBoundCleanupBacklog(f.db));
  assert.equal(rows['ephemera.challenges'].backlog_present,false);
  assert.equal(rows['ephemera.attempts'].backlog_age_seconds,200);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_bindings').get(),before);
});

test('invalid snapshots and primary-session failure never become empty measurements',async()=>{
  const clear={measured_at:1000,approval_responses:null,ephemera_challenges:null,ephemera_attempts:null,
    recovery_responses:null,recovery_attempts:null,lease_leases:null};
  const malformed=[null,[],{}, {...clear,extra:'private'}, {...clear,measured_at:'1000'}, {...clear,measured_at:-0},
    ...[undefined,'900',true,-1,-0,0.5,NaN,Infinity,1001,Number.MAX_SAFE_INTEGER+1].map(value=>({...clear,lease_leases:value}))];
  for(const row of malformed) await assert.rejects(measureBoundCleanupBacklog({prepare(){return{async first(){return row;}}}}),/Invalid cleanup measurement/);
  let fallback=false;
  await assert.rejects(measureBoundCleanupBacklog({withSession(){throw new Error('primary unavailable');},prepare(){fallback=true;}}),/primary unavailable/);
  assert.equal(fallback,false);
});

test('device audit history is retained regardless of age and excluded from cleanup backlog',async t=>{
  const f=fixture(t);
  const before=f.sql.prepare('SELECT * FROM device_bound_events').all();
  f.clock(2_000_000_000);
  await purgeExpiredBoundApprovals(f.db); await purgeExpiredBoundEphemera(f.db);
  await expireBoundRecovery(f.db); await purgeExpiredBoundLeases(f.db);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_events').all(),before);
  assert.equal(f.sql.prepare('SELECT hold_until FROM device_bound_bindings').get().hold_until,99999);
  assert.ok((await measureBoundCleanupBacklog(f.db)).every(row=>!row.backlog_present));
});
