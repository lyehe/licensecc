import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { retireBoundBinding, retireBoundBindingAsOperator, BOUND_RETIRE_SQL } from '../../src/device/bound_retire.mjs';
import { expireBoundRecovery } from '../../src/device/bound_cleanup.mjs';
import { boundRandomId,boundSecretHash } from '../../src/device/bound_enrollment.mjs';

function fixture(t) {
  const sql=new DatabaseSync(':memory:'); t.after(()=>sql.close()); let now=1000,before=()=>{};
  sql.function('unixepoch',()=>now); sql.exec('PRAGMA foreign_keys=ON');
  sql.exec(readFileSync(new URL('../../schema.sql',import.meta.url),'utf8'));
  const id=boundRandomId(16),fp='a'.repeat(64);
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1),('other','Other',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,created_at,updated_at)
    VALUES('APP','DEFAULT','${fp}','owner','active','device_bound_v1',1,1,1);
    INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at)
    VALUES('device','owner','APP','key','spki',1,1);`);
  sql.prepare(`INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,hold_until,created_at,updated_at)
    VALUES(?,'APP','DEFAULT',?,'device',2000,1,1)`).run(id,fp);
  class Statement {
    constructor(query,args=[]){this.query=query;this.args=args;}
    bind(...args){return new Statement(this.query,args);}
    async first(){before(this.query);return sql.prepare(this.query).get(...this.args)??null;}
    async run(){return {meta:sql.prepare(this.query).run(...this.args)};}
  }
  const db={prepare:query=>new Statement(query),async batch(statements){
    sql.exec('BEGIN');try{const results=statements.map(s=>{before(s.query);return {results:sql.prepare(s.query).all(...s.args)};});sql.exec('COMMIT');return results;}
    catch(error){sql.exec('ROLLBACK');throw error;}
  }};
  return {sql,db,id,input:{binding_id:id,expected_revision:0,operation_id:boundRandomId(32)},
    clock(value){now=value;},before(callback){before=callback;},binding(){return sql.prepare('SELECT * FROM device_bound_bindings').get();}};
}
const count=(f,table)=>f.sql.prepare(`SELECT count(*) n FROM ${table}`).get().n;

test('operator retirement records its principal and scopes recovery independently of customer self-service',async t=>{
  const f=fixture(t),actor={subject:'operator-subject',actor_type:'access',role:'admin'};
  const result=await retireBoundBindingAsOperator(f.db,actor,'owner',f.input);
  assert.equal(result.effective_release_at,2000);assert.equal(f.binding().hold_until,2000);
  assert.equal(f.sql.prepare("SELECT actor FROM device_bound_events").get().actor,'operator:access:operator-subject');
  assert.deepEqual(await retireBoundBindingAsOperator(f.db,actor,'owner',f.input),result);
  await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='idempotency_conflict');
  await assert.rejects(retireBoundBindingAsOperator(f.db,{...actor,subject:'other'},'owner',f.input),e=>e.code==='idempotency_conflict');
  await assert.rejects(retireBoundBindingAsOperator(f.db,{...actor,actor_type:'dev'},'owner',f.input),e=>e.code==='idempotency_conflict');
  assert.equal(count(f,'device_bound_events'),1);assert.equal(f.binding().generation,2);
});

test('operator retirement rejects reader, sync, malformed principal and foreign binding before mutation',async t=>{
  const f=fixture(t),actor={subject:'operator',actor_type:'access',role:'admin'};
  for(const invalid of [null,{}, {...actor,role:'reader'},{...actor,actor_type:'sync'},{...actor,subject:''},
    {...actor,subject:'x'.repeat(257)},{...actor,subject:'operator\nforged'},{...actor,subject:'\ud800'},{...actor,email:'not-required'}])
    await assert.rejects(retireBoundBindingAsOperator(f.db,invalid,'owner',f.input),e=>e.code==='access_denied');
  await assert.rejects(retireBoundBindingAsOperator(f.db,actor,'other',f.input),e=>e.code==='binding_unavailable');
  assert.equal(f.binding().state,'active');assert.equal(count(f,'device_bound_operations'),0);
});

test('operator audit principal mismatch rolls back the entire staged retirement',async t=>{
  const f=fixture(t),before=f.binding();
  f.before(query=>{if(query===BOUND_RETIRE_SQL[4])f.sql.exec("UPDATE device_bound_events SET actor='customer'");});
  await assert.rejects(retireBoundBindingAsOperator(f.db,{subject:'operator',actor_type:'access',role:'admin'},'owner',f.input),e=>e.code==='temporarily_unavailable');
  assert.deepEqual(f.binding(),before);
  for(const table of ['device_bound_events','device_bound_operations','device_bound_commit_checks'])assert.equal(count(f,table),0);
});

test('retirement advances generation once, preserves hold and recovers exact results',async t=>{
  const f=fixture(t),before=f.binding();
  const result=await retireBoundBinding(f.db,'owner',f.input);
  assert.equal(f.sql.prepare('SELECT request_digest FROM device_bound_operations').get().request_digest,
    await boundSecretHash(JSON.stringify(['lcc-binding-retire-v1','owner',f.id,0])));
  assert.equal(f.sql.prepare('SELECT actor FROM device_bound_events').get().actor,'customer');
  assert.deepEqual(result,{binding_id:f.id,state:'retiring',effective_release_at:2000,revision:1,generation:2});
  assert.deepEqual({...f.binding()},{...before,state:'retiring',revision:1,generation:2,updated_at:1000});
  f.clock(1500);assert.deepEqual(await retireBoundBinding(f.db,'owner',f.input),result);
  assert.equal(count(f,'device_bound_operations'),1);assert.equal(count(f,'device_bound_events'),1);
  assert.equal(count(f,'device_bound_leases'),0);assert.equal(count(f,'device_bound_commit_checks'),0);
  const occupied=()=>f.sql.prepare("SELECT count(*) n FROM device_bound_bindings WHERE state='active' OR (state='retiring' AND hold_until>unixepoch())").get().n;
  assert.equal(occupied(),1);f.clock(2000);assert.equal(occupied(),0);
  f.sql.exec("UPDATE device_bound_bindings SET state='released',revision=revision+1");
  assert.deepEqual(await retireBoundBinding(f.db,'owner',f.input),result);
});

test('retirement after hold expiry reports the commit time and recovers the exact result',async t=>{
  const f=fixture(t);f.clock(3000);
  const result=await retireBoundBinding(f.db,'owner',f.input);
  assert.equal(result.effective_release_at,3000);assert.equal(f.binding().hold_until,2000);
  f.clock(4000);assert.deepEqual(await retireBoundBinding(f.db,'owner',f.input),result);
  f.sql.exec("UPDATE device_bound_bindings SET state='released',revision=revision+1");
  assert.deepEqual(await retireBoundBinding(f.db,'owner',f.input),result);
  assert.equal(count(f,'device_bound_events'),1);
});

test('retirement retries bind identity and reject expired or erased operation results',async t=>{
  const f=fixture(t);await retireBoundBinding(f.db,'owner',f.input);
  await assert.rejects(retireBoundBinding(f.db,'owner',{...f.input,expected_revision:1}),e=>e.code==='idempotency_conflict');
  await assert.rejects(retireBoundBinding(f.db,'other',f.input),e=>e.code==='binding_unavailable');
  f.clock(173800);
  await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='idempotency_conflict');
  await expireBoundRecovery(f.db);f.clock(1000);
  await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='idempotency_conflict');
  assert.equal(f.binding().generation,2);assert.equal(count(f,'device_bound_events'),1);
});

test('retirement allows stopping an expired or disabled entitlement without releasing early',async t=>{
  const f=fixture(t);f.sql.exec("UPDATE entitlements SET status='disabled',valid_until=2");
  assert.equal((await retireBoundBinding(f.db,'owner',f.input)).effective_release_at,2000);
  assert.equal(f.binding().state,'retiring');
});

test('cleanup between retirement cache reads returns a conflict even after clock rollback',async t=>{
  const f=fixture(t);await retireBoundBinding(f.db,'owner',f.input);let erased=false;
  f.before(query=>{
    if(!erased && query.includes('JOIN device_bound_operations o ON o.key_id=?')) {
      erased=true;f.clock(173800);f.sql.exec("UPDATE device_bound_operations SET response_json='' WHERE purpose='retire'");f.clock(1000);
    }
  });
  await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='idempotency_conflict' && e.status===409);
  assert.equal(erased,true);assert.equal(f.binding().generation,2);assert.equal(count(f,'device_bound_events'),1);
});

test('each failed retirement statement rolls back operation, binding and audit',async t=>{
  for(const statement of BOUND_RETIRE_SQL.slice(1)) {
    const f=fixture(t),before=f.binding();let injected=false;
    f.before(query=>{if(query===statement && !injected){injected=true;throw new Error('injected database failure');}});
    await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='temporarily_unavailable');
    assert.deepEqual(f.binding(),before);
    for(const table of ['device_bound_operations','device_bound_events','device_bound_commit_checks'])assert.equal(count(f,table),0);
  }
});

test('renewal and authority changes between primary read and retirement cannot commit stale intent',async t=>{
  for(const mutation of ["UPDATE device_bound_bindings SET revision=revision+1,hold_until=3000",
    "UPDATE customers SET status='disabled' WHERE id='owner'", "UPDATE entitlements SET valid_until=5000"]){
    const f=fixture(t);let applied=false;
    // Apply outside the simulated transaction, immediately before batch admission.
    const batch=f.db.batch;f.db.batch=async statements=>{if(!applied){applied=true;f.sql.exec(mutation);}return batch(statements);};
    await assert.rejects(retireBoundBinding(f.db,'owner',f.input));
    assert.equal(f.binding().state,'active');assert.equal(count(f,'device_bound_operations'),0);assert.equal(count(f,'device_bound_events'),0);
  }
});

test('lost batch result recovers only the committed retirement',async t=>{
  const f=fixture(t),batch=f.db.batch;
  f.db.batch=async statements=>{await batch(statements);throw new Error('lost response');};
  assert.equal((await retireBoundBinding(f.db,'owner',f.input)).generation,2);
  assert.equal(count(f,'device_bound_events'),1);
});

test('missing causal writes force rollback before any successful retirement is returned',async t=>{
  for(const skipped of BOUND_RETIRE_SQL.slice(0,4)) {
    const f=fixture(t),batch=f.db.batch,before=f.binding();
    f.db.batch=statements=>batch(statements.filter(statement=>statement.query!==skipped));
    await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='temporarily_unavailable');
    assert.deepEqual(f.binding(),before);
    assert.equal(count(f,'device_bound_operations'),0);assert.equal(count(f,'device_bound_events'),0);
  }
});

test('retirement syntax, revision overflow and disabled customers fail closed',async t=>{
  const f=fixture(t);
  for(const patch of [{expected_revision:-0},{expected_revision:-1},{expected_revision:Number.MAX_SAFE_INTEGER},
    {expected_revision:'0'},{operation_id:'bad'},{binding_id:'bad'},{extra:true}])
    await assert.rejects(retireBoundBinding(f.db,'owner',{...f.input,...patch}),e=>e.code==='invalid_request');
  f.sql.exec('UPDATE device_bound_bindings SET generation=9007199254740991');
  await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='revision_conflict');
  f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");
  await assert.rejects(retireBoundBinding(f.db,'owner',f.input),e=>e.code==='binding_unavailable');
  assert.equal(count(f,'device_bound_operations'),0);
});
