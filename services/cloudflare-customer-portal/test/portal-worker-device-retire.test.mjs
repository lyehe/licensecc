import {test} from 'node:test';
import {assert,baseFixture,cookieFor,call as request,NOW} from './portal-worker-fixtures.mjs';
import worker from '../dist-worker/worker/index.js';

const path='/api/portal/device-bindings/retire';
export const DIRECT_ROUTE_TESTS=[`POST ${path}`];
const body={binding_id:Buffer.alloc(16,1).toString('base64url'),expected_revision:0};
const key=Buffer.alloc(32,2).toString('base64url');
const headers={'x-expected-customer-id':'A','idempotency-key':key};
const result={ok:true,status:200,code:'binding_retired',data:{binding_id:body.binding_id,state:'retiring',effective_release_at:NOW+120,revision:1,generation:2}};
const call=(env,cookie,options={})=>request(env,'POST',path,{cookie,body,...options,headers:{...headers,...options.headers}});

test('retirement requires session, exact displayed account, origin and bounded intent before RPC',async t=>{
  const calls=[],f=baseFixture({DEVICE_CONSENT:{retire:async(customer,input)=>{calls.push({customer,input});return result;}}});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,'A');
  assert.equal((await call(f.env,undefined)).status,401);
  for(const [options,status] of [
    [{headers:{origin:'https://evil.test'}},403],
    [{headers:{'sec-fetch-site':'cross-site'}},403],
    [{headers:{'x-expected-customer-id':'B'}},409],
    [{headers:{'x-expected-customer-id':''}},400],
    [{headers:{'idempotency-key':'bad'}},400],
    [{headers:{'idempotency-key':Buffer.alloc(16).toString('base64url')}},400],
    [{headers:{'idempotency-key':'A'.repeat(42)+'B'}},400],
    [{body:{...body,customer_id:'B'}},400],
    [{body:{...body,operation_id:key}},400],
    [{body:{...body,binding_id:'bad'}},400],
    [{body:{...body,expected_revision:9007199254740991}},400],
  ]) assert.equal((await call(f.env,cookie,options)).status,status);
  assert.equal(calls.length,0);
  const ok=await call(f.env,cookie,{headers:{'x-customer-id':'B'}});
  assert.equal(ok.status,200);assert.equal(ok.res.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls,[{customer:'A',input:{...body,operation_id:key}}]);
  assert.deepEqual(ok.body.data,result.data);
  assert.equal((await call(f.env,await cookieFor(f.env,'B'))).body.code,'account_changed');
});

test('retirement rejects malformed JSON and preserves no-store failures',async t=>{
  let calls=0;const f=baseFixture({DEVICE_CONSENT:{retire:async()=>{calls++;return result;}}});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,'A');
  for(const raw of [`{"binding_id":"${body.binding_id}","expected_revision":-0}`,`{"binding_id":"${body.binding_id}","expected_revision":0.0}`,
    `{"binding_id":"${body.binding_id}","expected_revision":0,"expected_revision":1}`,JSON.stringify({...body,binding_id:'A'.repeat(17000)})]) {
    const response=await worker.fetch(new Request('https://portal.test'+path,{method:'POST',headers:{...headers,cookie,origin:'https://portal.test','content-type':'application/json'},body:raw}),f.env);
    assert.equal(response.status,400);assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.equal(calls,0);
  assert.equal((await call({...f.env,DEVICE_CONSENT:undefined},cookie)).status,503);
  f.db.exec('DROP TABLE portal_sessions');
  const failed=await call(f.env,cookie);assert.equal(failed.status,503);assert.equal(failed.body.code,'temporarily_unavailable');
  assert.equal(failed.res.headers.get('cache-control'),'no-store');
});

test('retirement validates backend response identity and errors without leaking details',async t=>{
  const f=baseFixture({DEVICE_CONSENT:{retire:async()=>result}});t.after(()=>f.db.close());const cookie=await cookieFor(f.env,'A');
  for(const patch of [{binding_id:'other'},{revision:2},{state:'released'},{generation:1},{effective_release_at:-1},{extra:'secret'}]) {
    f.env.DEVICE_CONSENT.retire=async()=>({...result,data:{...result.data,...patch}});
    assert.equal((await call(f.env,cookie)).status,503);
  }
  for(const [code,status] of [['binding_unavailable',404],['revision_conflict',409],['idempotency_conflict',409],['access_denied',403]]) {
    f.env.DEVICE_CONSENT.retire=async()=>({ok:false,code,status,data:{secret:true}});
    const response=await call(f.env,cookie);assert.equal(response.status,status);assert.equal(response.body.data,undefined);
  }
  for(const [code,status] of [['authorization_expired',410],['authorization_unavailable',404],['__proto__',400],['binding_unavailable',200]]) {
    f.env.DEVICE_CONSENT.retire=async()=>({ok:false,code,status});
    assert.equal((await call(f.env,cookie)).status,503);
  }
  f.env.DEVICE_CONSENT.retire=async()=>{throw new Error('secret backend detail');};
  const failed=await call(f.env,cookie);assert.equal(failed.status,503);assert.equal(JSON.stringify(failed.body).includes('secret'),false);
});

test('retirement shares protected-device budgets and fails closed without counters',async t=>{
  t.mock.method(Date,'now',()=>NOW*1000);
  let calls=0;const f=baseFixture({DEVICE_CONSENT:{retire:async()=>{calls++;return result;}}});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,'A');
  f.db.prepare("INSERT INTO rate_limit_counters(namespace,rate_key,window_start,request_count,expires_at,updated_at) VALUES('portal','device-consent:customer:A',?,20,?,?)").run(Math.floor(NOW/60)*60,NOW+120,NOW);
  const limited=await call(f.env,cookie);assert.equal(limited.status,429);assert.equal(limited.res.headers.get('retry-after'),'60');
  f.db.exec('DROP TABLE rate_limit_counters');assert.equal((await call(f.env,cookie)).status,429);assert.equal(calls,0);
});
