import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { worker,baseEnv,authed,accessEnv,accessAuthed,accessFixture,accessToken } from '../worker/fixtures.mjs';
import { retireBoundBindingAsOperator } from '../../../cloudflare-licensing-backend/src/device/bound_retire.mjs';

const bindingId=n=>{const b=Buffer.alloc(16);b.writeUInt32BE(n,12);return b.toString('base64url');};
const path='/api/admin/customers/owner/bindings';
const operator=encodeURIComponent(JSON.stringify(['dev','dev']));
function fixture(t,count=1,deviceOwner='owner',grantOwner='owner') {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());let now=1000,calls=0;
  sql.function('unixepoch',()=>now);
  sql.exec(readFileSync(new URL('../../../cloudflare-licensing-backend/schema.sql',import.meta.url),'utf8'));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1,1),('other','Other',1,1);
    INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,created_at,updated_at)
    VALUES('APP','DEFAULT','${'a'.repeat(64)}','${grantOwner}','active','device_bound_v1',200,1,1);`);
  for(let n=1;n<=count;n++) {
    sql.prepare(`INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,label,created_at,last_proof_at)
      VALUES(?,?,'APP',?,'spki',?,1,900)`).run(`device-${n}`,deviceOwner,`key-${n}`,`Node ${n}`);
    sql.prepare(`INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,hold_until,created_at,updated_at)
      VALUES(?,'APP','DEFAULT',?,?,2000,1,1)`).run(bindingId(n),'a'.repeat(64),`device-${n}`);
  }
  class Statement {
    constructor(query,args=[]){this.query=query;this.args=args;}
    bind(...args){return new Statement(this.query,args);}
    async first(){return sql.prepare(this.query).get(...this.args)??null;}
    async all(){return {results:sql.prepare(this.query).all(...this.args)};}
  }
  const db={prepare:query=>new Statement(query),withSession(mode){assert.equal(mode,'first-primary');return this;},async batch(statements){
    sql.exec('BEGIN');try{const result=statements.map(s=>({results:sql.prepare(s.query).all(...s.args)}));sql.exec('COMMIT');return result;}
    catch(e){sql.exec('ROLLBACK');throw e;}
  }};
  const env={...baseEnv(db),DEVICE_OPERATOR:{async retire(actor,customer,input){calls++;
    try{return {ok:true,status:200,code:'binding_retired',data:await retireBoundBindingAsOperator(db,actor,customer,input)};}
    catch(e){return {ok:false,status:e.status??503,code:e.code??'temporarily_unavailable'};}
  }}};
  return {sql,db,env,clock:n=>{now=n;},calls:()=>calls};
}
function retireRequest(id=bindingId(1),options={}) {
  return authed(`${path}/${id}/retire${options.query??''}`,{method:'POST',body:options.body??'{"expected_revision":0}',
    headers:{'x-expected-operator':operator,'idempotency-key':options.key??randomBytes(32).toString('base64url'),...options.headers}});
}
async function result(request,env,status,code) {
  const response=await worker.fetch(request,env);assert.equal(response.status,status);
  assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();
  if(code)assert.equal(body.code,code);return body.data;
}

test('protected reads paginate without duplicates and use database time rather than lease expiry',async t=>{
  const f=fixture(t,102);const first=await result(authed(path),f.env,200,'customer_bindings');
  assert.equal(first.items.length,100);assert.equal(first.server_time,1000);
  assert.deepEqual(first.operator,{subject:'dev',actor_type:'dev',role:'admin'});
  const second=await result(authed(`${path}?cursor=${first.next_cursor}`),f.env,200);
  assert.equal(second.items.length,2);assert.equal(second.next_cursor,null);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.binding_id)).size,102);
  f.clock(3000);const active=await result(authed(`${path}?binding_id=${bindingId(1)}&project=APP`),f.env,200);
  assert.equal(active.items[0].state,'active');
  f.sql.prepare("UPDATE device_bound_bindings SET state='retiring' WHERE id=?").run(bindingId(1));
  f.clock(2000);assert.equal((await result(authed(`${path}?binding_id=${bindingId(1)}`),f.env,200)).items[0].state,'released');
  assert.equal((await result(authed(`${path}?project=OTHER`),f.env,200)).items.length,0);
  assert.equal(JSON.stringify(first).includes('spki'),false);
});

test('reads require both ownership joins while disabled customers remain inspectable',async t=>{
  const f=fixture(t);f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");
  assert.equal((await result(authed(path),f.env,200)).customer.status,'disabled');
  for(const owners of [['other','owner'],['owner','other']]) {
    const foreign=fixture(t,1,...owners);
    assert.equal((await result(authed(path),foreign.env,200)).items.length,0);
    await result(authed(`${path}/${bindingId(1)}/events`),foreign.env,404,'binding_unavailable');
  }
  await result(authed('/api/admin/customers/missing/bindings'),f.env,404,'not_found');
});

test('retirement crosses authenticated HTTP into the backend transaction with exact recovery and audit',async t=>{
  const f=fixture(t),key=randomBytes(32).toString('base64url');
  const first=await result(retireRequest(undefined,{key}),f.env,200,'binding_retired');
  assert.deepEqual(first,{binding_id:bindingId(1),state:'retiring',effective_release_at:2000,revision:1,generation:2});
  f.clock(1500);assert.deepEqual(await result(retireRequest(undefined,{key}),f.env,200),first);
  assert.equal(f.sql.prepare('SELECT hold_until FROM device_bound_bindings').get().hold_until,2000);
  const events=await result(authed(`${path}/${bindingId(1)}/events`),f.env,200,'binding_events');
  assert.equal(events.items.length,1);assert.equal(events.items[0].actor,'operator:dev:dev');
  assert.equal(events.items[0].event_type,'retire');
  await result(retireRequest(undefined,{key,body:'{"expected_revision":1}'}),f.env,409,'idempotency_conflict');
  await result(retireRequest(),f.env,409,'revision_conflict');
});

test('strict inputs and displayed-operator precondition fail before any capability invocation',async t=>{
  const f=fixture(t);
  for(const body of ['{}','{"expected_revision":0,"actor":"forged"}','{"expected_revision":0,"expected_revision":0}',
    '{"expected_revision":0.0}','{"expected_revision":-0}','{"expected_revision":9007199254740991}',
    '{"expected_revision":0,"customer_id":"other"}',' '.repeat(16385)])
    await result(retireRequest(undefined,{body}),f.env,400,'invalid_request');
  for(const headers of [{'x-expected-operator':''},{'idempotency-key':'a'.repeat(43)},{'content-type':'text/plain'}])
    await result(retireRequest(undefined,{headers}),f.env,400,'invalid_request');
  await result(retireRequest(undefined,{headers:{'x-expected-operator':'another'}}),f.env,409,'operator_changed');
  for(const query of ['?override=1','?','#fragment'])await result(retireRequest(undefined,{query}),f.env,400,'invalid_request');
  for(const query of ['?cursor=','?cursor=invalid','?project=','?unknown=1','?project=APP&project=APP',`?binding_id=${bindingId(1)}&cursor=${bindingId(2)}`])
    await result(authed(path+query),f.env,400,'invalid_request');
  for(const cursor of ['-1','01','9007199254740992','1e2','1%0A','1%0D%0A','1%20'])
    await result(authed(`${path}/${bindingId(1)}/events?cursor=${cursor}`),f.env,400,'invalid_request');
  assert.equal(f.calls(),0);
});

test('anonymous, reader, sync token and cross-site requests cannot retire; Access subject is authoritative',async t=>{
  const f=fixture(t),access=await accessFixture(t),env={...accessEnv(f.db,access),DEVICE_OPERATOR:f.env.DEVICE_OPERATOR};
  await result(new Request(`https://admin.example${path}`),env,401);
  const reader=await accessToken(access,'reader@example.com');
  await result(accessAuthed(path,reader),env,200);
  await result(accessAuthed(`${path}/${bindingId(1)}/retire`,reader,{method:'POST',body:'{}'}),env,403);
  await result(retireRequest(undefined,{headers:{origin:'https://evil.example'}}),f.env,403,'cross_site_mutation_forbidden');
  await result(retireRequest(undefined,{headers:{authorization:'Bearer sync-secret'}}),{...f.env,SYNC_API_TOKEN:'sync-secret'},401);
  assert.equal(f.calls(),0);
  const admin=await accessToken(access,'admin@example.com',{subject:'verified-subject'});
  const request=accessAuthed(`${path}/${bindingId(1)}/retire`,admin,{method:'POST',body:'{"expected_revision":0}',headers:{
    'x-expected-operator':encodeURIComponent(JSON.stringify(['access','verified-subject'])),
    'idempotency-key':randomBytes(32).toString('base64url')}});
  await result(request,env,200);
  assert.equal(f.sql.prepare('SELECT actor FROM device_bound_events').get().actor,'operator:access:verified-subject');
});

test('backend unavailable or malformed responses never leak data or claim successful retirement',async t=>{
  const f=fixture(t);
  for(const value of [null,{ok:true,status:200,code:'binding_retired',data:{}},{ok:false,status:200,code:'revision_conflict'},
    {ok:false,status:500,code:'secret-internal-error'}]) {
    await result(retireRequest(),{...f.env,DEVICE_OPERATOR:{retire:async()=>value}},503,'temporarily_unavailable');
  }
  await result(retireRequest(),{...f.env,DEVICE_OPERATOR:undefined},503,'temporarily_unavailable');
  await result(authed(path),{...f.env,DB:{prepare(){throw Error('secret');}}},503,'temporarily_unavailable');
  assert.equal(f.sql.prepare('SELECT state FROM device_bound_bindings').get().state,'active');
});

test('event pages remain bounded, ordered, and scoped to the owning customer',async t=>{
  const f=fixture(t);
  for(let i=0;i<102;i++)f.sql.prepare("INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at) VALUES(?,?,'owner','renew','customer',900)").run(`event-${i}`,bindingId(1));
  f.sql.prepare("INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at) VALUES('foreign',?,'other','renew','customer',900)").run(bindingId(1));
  const first=await result(authed(`${path}/${bindingId(1)}/events`),f.env,200);
  assert.equal(first.items.length,100);assert.equal(first.next_cursor,'100');
  const last=await result(authed(`${path}/${bindingId(1)}/events?cursor=${first.next_cursor}`),f.env,200);
  assert.deepEqual(last.items.map(x=>x.id),[101,102]);assert.equal(last.next_cursor,null);
  assert.deepEqual((await result(authed(`${path}/${bindingId(1)}/events?cursor=102`),f.env,200)).items,[]);
});
