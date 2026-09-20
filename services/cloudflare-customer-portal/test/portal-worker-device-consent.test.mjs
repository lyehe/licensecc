import {test} from "node:test";
import {assert,baseFixture,cookieFor,call as callFixture,NOW} from "./portal-worker-fixtures.mjs";
import worker from "../dist-worker/worker/index.js";

const prefix="/api/portal/device-authorizations/";
const call=(env,method,path,options={})=>callFixture(env,method,path,{...options,headers:{"x-expected-customer-id":"A",...options.headers}});
export const DIRECT_ROUTE_TESTS=["inspect","approve","deny"].map(op=>`POST ${prefix}${op}`);
const handle="A".repeat(43),key="operation_123456789";
const input=op=>({attempt_handle:handle,...(op==="inspect"?{}:{expected_attempt_revision:0}),...(op==="approve"?{entitlement_id:"chosen"}:{})});
function service(calls){return Object.fromEntries(["inspect","approve","deny"].map(op=>[op,async(customer,body)=>{
  const data=op==="inspect"?{app:{name:"Example",project:"APP"},device:{label:"Laptop"},status:"pending",revision:0,expires_at:NOW+300,entitlements:[],has_more:false,next_page_cursor:null,comparison_code:"0000-1111-2222"}
    :op==="approve"?{callback_url:`http://127.0.0.1:1234/callback?code=${handle}&state=${handle}`,expires_at:NOW+60,revision:1}:{status:"authorization_denied",revision:1};
  calls.push({op,customer,body});return {ok:true,status:200,code:op==="inspect"?"authorization_inspected":op==="approve"?"authorization_approved":"authorization_denied",data};
}]));}

test("all consent routes authenticate before RPC and use only session identity",async t=>{
  const calls=[],f=baseFixture({DEVICE_CONSENT:service(calls)});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,"A");
  for(const op of ["inspect","approve","deny"]){
    const unauth=await call(f.env,"POST",prefix+op,{body:input(op)});
    assert.equal(unauth.status,401);assert.equal(unauth.res.headers.get("cache-control"),"no-store");
    const result=await call(f.env,"POST",prefix+op,{cookie,body:input(op),headers:{"idempotency-key":key,"x-customer-id":"B"}});
    assert.equal(result.status,200);assert.equal(result.res.headers.get("cache-control"),"no-store");
    assert.equal(calls.at(-1).customer,"A");
    assert.deepEqual(calls.at(-1).body,{...input(op),...(op==="inspect"?{}:{operation_id:key})});
    const forged=await call(f.env,"POST",prefix+op,{cookie,body:{...input(op),customer_id:"B"},headers:{"idempotency-key":key}});
    assert.equal(forged.status,400);
  }
  assert.equal(calls.length,3);
  for(const op of ["inspect","approve","deny"]){
    const missing=await call(f.env,"POST",prefix+op,{cookie,body:input(op),headers:{"x-expected-customer-id":"","idempotency-key":key}});
    assert.equal(missing.status,400);
    const switched=await call(f.env,"POST",prefix+op,{cookie:await cookieFor(f.env,"B"),body:input(op),headers:{"idempotency-key":key}});
    assert.equal(switched.status,409);assert.equal(switched.body.code,"account_changed");
    assert.equal(switched.res.headers.get("cache-control"),"no-store");
  }
  assert.equal(calls.length,3);
});

test("consent rejects CSRF, missing idempotency, malformed JSON and backend failures",async t=>{
  const calls=[],f=baseFixture({DEVICE_CONSENT:service(calls)});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,"A");
  assert.equal((await call(f.env,"POST",prefix+"approve",{cookie,body:input("approve")})).status,400);
  assert.equal((await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect"),headers:{origin:"https://evil.test"}})).status,403);
  for(const raw of ['{"attempt_handle":"one","attempt_handle":"two"}','{"attempt_handle":"a","expected_attempt_revision":0.0}','{"attempt_handle":"'+"a".repeat(17000)+'"}']){
    const response=await worker.fetch(new Request("https://portal.test"+prefix+"inspect",{method:"POST",headers:{cookie,origin:"https://portal.test","content-type":"application/json","x-expected-customer-id":"A"},body:raw}),f.env);
    assert.equal(response.status,400);
  }
  assert.equal(calls.length,0);
  assert.equal((await call({...f.env,DEVICE_CONSENT:undefined},"POST",prefix+"inspect",{cookie,body:input("inspect")})).status,503);
  for(const origin of ["null","http://portal.test","https://portal.test/path"]){
    assert.equal((await call({...f.env,PORTAL_PUBLIC_ORIGIN:origin},"POST",prefix+"inspect",{cookie,body:input("inspect")})).status,503);
  }
  f.env.DEVICE_CONSENT.inspect=async()=>{throw new Error("secret backend detail");};
  const failed=await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect")});
  assert.equal(failed.status,503);assert.equal(JSON.stringify(failed.body).includes("secret"),false);
  f.env.DEVICE_CONSENT.inspect=async()=>({ok:true,status:200,code:"authorization_inspected",data:{unexpected:true}});
  assert.equal((await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect")})).status,503);
  for(const malformed of [{ok:false,code:"unknown"},{ok:false,code:"access_denied",status:200},{ok:false,code:"__proto__"},{ok:false,code:"binding_unavailable",status:404}]){
    f.env.DEVICE_CONSENT.inspect=async()=>malformed;
    const result=await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect")});
    assert.equal(result.status,503);assert.equal(result.body.ok,false);
  }
});

test("consent session infrastructure failures and malformed callbacks fail closed",async t=>{
  const calls=[],f=baseFixture({DEVICE_CONSENT:service(calls)});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,"A");
  for(const callback_url of [`http://127.0.0.1:0/callback?code=${handle}&state=${handle}`,`http://127.0.0.1:1234/callback?code=${handle}&state=${handle}#`,`http://127.0.0.1:1234/callback?code=${"a".repeat(43)}&state=${handle}`]){
    f.env.DEVICE_CONSENT.approve=async()=>({ok:true,status:200,code:"authorization_approved",data:{callback_url,expires_at:NOW+60,revision:1}});
    assert.equal((await call(f.env,"POST",prefix+"approve",{cookie,body:input("approve"),headers:{"idempotency-key":key}})).status,503);
  }
  f.db.exec("DROP TABLE portal_sessions");
  const failed=await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect")});
  assert.equal(failed.status,503);assert.equal(failed.res.headers.get("cache-control"),"no-store");
  assert.equal(failed.body.code,"temporarily_unavailable");
});

test("consent budgets reject before RPC and counter failure is closed",async t=>{
  t.mock.method(Date,"now",()=>NOW*1000);
  const calls=[],f=baseFixture({DEVICE_CONSENT:service(calls)});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,"A"),window=Math.floor(NOW/60)*60;
  f.db.prepare("INSERT INTO rate_limit_counters(namespace,rate_key,window_start,request_count,expires_at,updated_at) VALUES('portal','device-consent:customer:A',?,20,?,?)").run(window,NOW+120,NOW);
  const result=await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect")});
  assert.equal(result.status,429);assert.equal(result.res.headers.get("retry-after"),"60");assert.equal(calls.length,0);
  f.db.exec("DROP TABLE rate_limit_counters");
  assert.equal((await call(f.env,"POST",prefix+"inspect",{cookie,body:input("inspect")})).status,429);
  assert.equal(calls.length,0);
});

test("consent inspection forwards only a bounded optional cursor and validates page/comparison output",async t=>{
  const calls=[],f=baseFixture({DEVICE_CONSENT:service(calls)});t.after(()=>f.db.close());
  const cookie=await cookieFor(f.env,"A"),body={attempt_handle:handle,page_cursor:"cGFnZTI"};
  assert.equal((await call(f.env,"POST",prefix+"inspect",{cookie,body})).status,200);
  assert.deepEqual(calls.at(-1).body,body);
  for(const page_cursor of [null,"",4,"a".repeat(513),"abc="]){
    assert.equal((await call(f.env,"POST",prefix+"inspect",{cookie,body:{...body,page_cursor}})).status,400);
  }
  assert.equal(calls.length,1);
  const valid=await f.env.DEVICE_CONSENT.inspect("A",{attempt_handle:handle});
  for(const duration of [2,86400,0,1,-1,1.5,'86400',null]){
    const entitlement={id:'trial',feature:'DEFAULT',valid_until:null,device_limit:1,activation_trial_seconds:duration};
    f.env.DEVICE_CONSENT.inspect=async()=>({...valid,data:{...valid.data,entitlements:[entitlement]}});
    const reply=await call(f.env,'POST',prefix+'inspect',{cookie,body:{attempt_handle:handle}});
    assert.equal(reply.status,typeof duration==='number' && Number.isSafeInteger(duration) && duration>=2?200:503);
    if(reply.status===200)assert.deepEqual(reply.body.data.entitlements,[entitlement]);
  }
  for(const patch of [{comparison_code:"3885-783e-2c02"},{comparison_code:undefined},{next_page_cursor:"cGFnZTI"},{has_more:true,next_page_cursor:"cGFnZTI"},{entitlements:[{id:"duplicate",feature:"DEFAULT",valid_until:null,device_limit:1},{id:"duplicate",feature:"DEFAULT",valid_until:null,device_limit:1}]}]){
    f.env.DEVICE_CONSENT.inspect=async()=>({...valid,data:{...valid.data,...patch}});
    assert.equal((await call(f.env,"POST",prefix+"inspect",{cookie,body:{attempt_handle:handle}})).status,503);
  }
});
