import {test} from 'node:test';
import {assert,baseFixture,cookieFor,call,NOW} from './portal-worker-fixtures.mjs';
export const DIRECT_ROUTE_TESTS=['GET /api/portal/device-bindings'];
const path='/api/portal/device-bindings';
function seed(f,index,owner='A',state='active',hold=NOW+120) {
  const id=Buffer.alloc(16,index).toString('base64url'),fp=(owner==='A'?'c':'d').repeat(64);
  f.db.prepare("INSERT OR IGNORE INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,created_at,updated_at) VALUES('APP','DEFAULT',?,?,'active','device_bound_v1',1,1)").run(fp,owner);
  f.db.prepare("INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,label,created_at,last_proof_at) VALUES(?,?,'APP',?,'public','My laptop',1,?)").run(id,owner,id,NOW-30);
  f.db.prepare("INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,state,hold_until,created_at,updated_at) VALUES(?,'APP','DEFAULT',?,?,?,?,1,1)").run(id,fp,id,state,hold);
  return id;
}
const request=(env,cookie,suffix='',headers={})=>call(env,'GET',path+suffix,{cookie,headers:{'x-expected-customer-id':'A',...headers}});

test('binding list authenticates, isolates owners and derives release at exact database hold deadline',async t=>{
  const f=baseFixture();t.after(()=>f.db.close());f.db.function('unixepoch',()=>NOW);
  const active=seed(f,1,'A','active',NOW-1),retiring=seed(f,2,'A','retiring',NOW+1),released=seed(f,3,'A','retiring',NOW);seed(f,4,'B');
  const cookie=await cookieFor(f.env,'A');assert.equal((await request(f.env,undefined)).status,401);
  const response=await request(f.env,cookie);assert.equal(response.status,200);assert.equal(response.res.headers.get('cache-control'),'no-store');
  const data=response.body.data;assert.equal(data.customer_id,'A');assert.equal(data.has_more,false);assert.equal(data.next_cursor,null);
  assert.deepEqual(new Map(data.items.map(row=>[row.binding_id,row.state])),new Map([[active,'active'],[retiring,'retiring'],[released,'released']]));
  assert.equal(data.items.every(row=>!('key_id' in row) && !('public_key_spki' in row) && !('license_fingerprint' in row)),true);
  f.db.exec("UPDATE entitlements SET status='disabled' WHERE project='APP'");
  assert.equal((await request(f.env,cookie)).body.data.items.length,3);
  assert.equal((await request(f.env,await cookieFor(f.env,'B'))).body.code,'account_changed');
});

test('binding pages are bounded, ordered, cursor validated and recheck ownership',async t=>{
  const f=baseFixture();t.after(()=>f.db.close());for(let i=1;i<=102;i++)seed(f,i);
  const cookie=await cookieFor(f.env,'A');const first=(await request(f.env,cookie)).body.data;
  assert.equal(first.items.length,100);assert.equal(first.has_more,true);assert.equal(first.next_cursor,first.items.at(-1).binding_id);
  const second=(await request(f.env,cookie,'?cursor='+first.next_cursor)).body.data;
  assert.equal(second.items.length,2);assert.equal(second.has_more,false);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.binding_id)).size,102);
  const target=second.items.at(-1).binding_id;
  const exact=(await request(f.env,cookie,'?binding_id='+target)).body.data;
  assert.equal(exact.items.length,1);assert.equal(exact.items[0].binding_id,target);assert.equal(exact.has_more,false);
  assert.equal((await request(f.env,cookie,'?cursor='+first.next_cursor+'&binding_id='+target)).status,400);
  for(const suffix of ['?cursor=','?cursor=bad','?customer_id=B','?cursor='+first.next_cursor+'&cursor='+first.next_cursor])assert.equal((await request(f.env,cookie,suffix)).status,400);
  assert.equal((await request(f.env,cookie,'',{'x-expected-customer-id':''})).status,400);
  f.db.exec("UPDATE customers SET status='disabled' WHERE id='A'");assert.equal((await request(f.env,cookie,'?cursor='+first.next_cursor)).status,401);
});

test('binding read infrastructure errors are no-store and do not expose SQL',async t=>{
  const f=baseFixture();t.after(()=>f.db.close());const cookie=await cookieFor(f.env,'A');
  f.db.exec('DROP TABLE device_bound_bindings');
  const result=await request(f.env,cookie);assert.equal(result.status,503);assert.equal(result.body.code,'temporarily_unavailable');assert.equal(result.res.headers.get('cache-control'),'no-store');
});
