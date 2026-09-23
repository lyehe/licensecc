import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPublicKey, verify } from "node:crypto";
import worker from "../../dist/app.js";
import { boundRandomId, boundSecretHash } from "../../src/device/bound_enrollment.mjs";
import { expireBoundRecovery, purgeExpiredBoundLeases } from "../../src/device/bound_cleanup.mjs";
import { boundSourceIdentity, limitBoundRequest, limitBoundVerified, parseGlobalRateLimit } from "../../src/device/bound_rate.mjs";
import { retireBoundBinding } from "../../src/device/bound_retire.mjs";
import { encodeBase64url, deviceOperationBody, deviceProofSigningInput, decodeDeviceLeaseEnvelope, deviceLeaseSigningInput } from "@licensecc/licensing-domain/lease/device_protocol";
import { sha256Hex, normalizeDeviceSignature, importBoundDeviceKey } from "../../src/device/bound_crypto.mjs";

const signer = await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
const pem = (label,bytes) => `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----`;
const privatePem = pem("PRIVATE KEY",await crypto.subtle.exportKey("pkcs8",signer.privateKey));
const publicPem = pem("PUBLIC KEY",await crypto.subtle.exportKey("spki",signer.publicKey));
const fingerprint="a".repeat(64);
const config={issuer:"https://licenses.example.test/",audience:"desktop",authorization_url:"https://portal.example.test/connect",
  clients:[{client_id:"desktop",project:"APP",display_name:"Example app",callbacks:[{host:"127.0.0.1",path:"/callback"}]}]};

function fixture(t) {
  const sql=new DatabaseSync(":memory:"); t.after(()=>sql.close());
  let now=1000;
  sql.function("unixepoch",()=>BigInt(now)); sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(readFileSync(new URL("../../schema.sql",import.meta.url),"utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('customer','Customer',1000,1000);
    INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,lease_seconds,valid_until,created_at,updated_at)
    VALUES('APP','DEFAULT','${fingerprint}','customer','active','device_bound_v1',1,3600,10000,1000,1000);`);
  class Statement {
    constructor(query,params=[]) { this.query=query; this.params=params; }
    bind(...params) { return new Statement(this.query,params); }
    async first() { return sql.prepare(this.query).get(...this.params) ?? null; }
    async run() { return { meta: sql.prepare(this.query).run(...this.params) }; }
    async all() { return {results:sql.prepare(this.query).all(...this.params)}; }
  }
  const db={prepare:query=>new Statement(query),withSession(mode){assert.equal(mode,"first-primary");return db;},async batch(statements){
    sql.exec("BEGIN IMMEDIATE");
    try { const results=statements.map(s=>({results:sql.prepare(s.query).all(...s.params)})); sql.exec("COMMIT"); return results; }
    catch(error){sql.exec("ROLLBACK");throw error;}
  }};
  const env={DB:db,BOUND_DEVICE_CONFIG:JSON.stringify(config),BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM:privatePem,
    BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM:publicPem,DEVICE_PROOF_MODE:"off",ACCOUNT_TOKEN_MODE:"off",REQUEST_SIGNATURE_MODE:"off",D1_RATE_LIMIT_ENABLED:"0"};
  async function call(path,body,headers={}) {
    const response=await worker.fetch(new Request(`https://untrusted-host.test${path}`,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"127.0.0.2",...headers},body:typeof body==="string"?body:JSON.stringify(body)}),env);
    assert.equal(response.headers.get("cache-control"),"no-store");
    return {status:response.status,headers:response.headers,body:await response.json()};
  }
  return {sql,db,env,call,clock(value){now=value;}};
}

async function enrollment(f,feature="DEFAULT",existingKeys=null) {
  const keys=existingKeys??await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const spki=encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki",keys.publicKey)));
  const verifier=boundRandomId(32),code=boundRandomId(32);
  const pkce=encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier))));
  const redirect="http://127.0.0.1:45678/callback";
  const attempt=await f.call("/v2/device-authorizations",{client_id:"desktop",project:"APP",public_key_spki:spki,device_label:"My PC",redirect_uri:redirect,state:boundRandomId(32),code_challenge:pkce,code_challenge_method:"S256"});
  assert.equal(attempt.status,200,JSON.stringify(attempt.body));
  const handle=attempt.body.data.attempt_handle;
  // Fixture-only browser consent; the production portal entrypoint is Phase 3.
  f.sql.prepare(`UPDATE device_bound_authorizations SET status='approved',revision=revision+1,customer_id='customer',feature=?,license_fingerprint=?,code_hash=?,code_expires_at=unixepoch()+60 WHERE handle_hash=?`)
    .run(feature,fingerprint,await boundSecretHash(code),await boundSecretHash(handle));
  return {keys,keyId:(await importBoundDeviceKey(spki)).keyId,body:{attempt_handle:handle,code,code_verifier:verifier,redirect_uri:redirect,operation_id:boundRandomId(32)}};
}

async function signed(f,device,purpose,body=device.body,patch={}) {
  const subject=purpose==="exchange"?{attempt_handle:body.attempt_handle}:{binding_id:body.binding_id};
  const challenge=await f.call("/v2/device-challenges",{purpose,...subject,operation_id:body.operation_id});
  assert.equal(challenge.status,200,JSON.stringify(challenge.body));
  const c=challenge.body.data;
  const intent={audience:config.audience,method:"POST",path:purpose==="exchange"?"/v2/device-authorizations/exchange":"/v2/device-leases/renew",
    key_id:device.keyId,operation_id:body.operation_id,body_sha256:await sha256Hex(deviceOperationBody(purpose,body)),challenge_id:c.challenge_id,nonce:c.nonce,expires_at:c.expires_at,...patch};
  const signature=encodeBase64url(normalizeDeviceSignature(new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},device.keys.privateKey,deviceProofSigningInput(intent)))));
  return {...body,proof:{key_id:device.keyId,challenge_id:c.challenge_id,nonce:c.nonce,expires_at:c.expires_at,signature}};
}

test("HTTP activation and renewal issue verified dedicated leases and recover exact responses",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const request=await signed(f,d,"exchange");
  const activated=await f.call("/v2/device-authorizations/exchange",request);
  assert.equal(activated.status,200,JSON.stringify(activated.body));
  const token=decodeDeviceLeaseEnvelope(activated.body.data.lease);
  assert.equal(verify("RSA-SHA256",deviceLeaseSigningInput(token.payload),createPublicKey(publicPem),token.signature),true);
  assert.equal(token.claims.issuer,config.issuer);
  assert.equal(token.claims.audience,config.audience);
  assert.equal(token.claims["device-key-id"],d.keyId);
  assert.equal(token.claims["operation-id"],d.body.operation_id);
  assert.equal(token.claims["issued-at"],1000);
  assert.equal(token.claims["expires-at"],4600);
  const binding=()=>f.sql.prepare("SELECT * FROM device_bound_bindings").get();
  const initial=binding(); assert.equal(initial.hold_until,4720);
  assert.equal((await f.call("/v2/device-authorizations/exchange",request)).status,401);
  f.clock(1301);
  const recovered=await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"));
  assert.deepEqual(recovered.body,activated.body);
  assert.deepEqual(binding(),initial);
  const renew={binding_id:initial.id,generation:1,operation_id:boundRandomId(32)};
  const renewed=await f.call("/v2/device-leases/renew",await signed(f,d,"renew",renew));
  assert.equal(renewed.status,200,JSON.stringify(renewed.body));
  assert.equal(renewed.body.data.binding_id,initial.id);
  assert.equal(renewed.body.data.expires_at,4901);
  assert.equal(binding().hold_until,5021);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,2);
  assert.deepEqual((await f.call("/v2/device-leases/renew",await signed(f,d,"renew",renew))).body,renewed.body);
});

test("lease-table pruning preserves exact exchange/renewal recovery and the maximum binding hold",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const activated=await f.call('/v2/device-authorizations/exchange',await signed(f,d,'exchange'));
  f.clock(1300);
  const body={binding_id:activated.body.data.binding_id,generation:1,operation_id:boundRandomId(32)};
  const renewed=await f.call('/v2/device-leases/renew',await signed(f,d,'renew',body));
  assert.equal(renewed.status,200);
  const binding=f.sql.prepare('SELECT * FROM device_bound_bindings').get();
  const operations=f.sql.prepare('SELECT * FROM device_bound_operations ORDER BY invocation_id').all();
  const events=f.sql.prepare('SELECT * FROM device_bound_events').all();
  f.clock(activated.body.data.accept_until-1);
  assert.deepEqual(await purgeExpiredBoundLeases(f.db),{leases:0});
  f.clock(activated.body.data.accept_until);
  assert.deepEqual(await purgeExpiredBoundLeases(f.db),{leases:1});
  assert.equal(f.sql.prepare('SELECT accept_until FROM device_bound_leases').get().accept_until,renewed.body.data.accept_until);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_bindings').get(),binding);
  f.clock(renewed.body.data.accept_until);
  assert.deepEqual(await purgeExpiredBoundLeases(f.db),{leases:1});
  assert.deepEqual(await purgeExpiredBoundLeases(f.db),{leases:0});
  assert.deepEqual((await f.call('/v2/device-authorizations/exchange',await signed(f,d,'exchange'))).body,activated.body);
  assert.deepEqual((await f.call('/v2/device-leases/renew',await signed(f,d,'renew',body))).body,renewed.body);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_bindings').get(),binding);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_operations ORDER BY invocation_id').all(),operations);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_events').all(),events);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM device_bound_leases').get().n,0);
});

test("retirement rejects already prepared renewal and cached exchange proofs without shrinking the hold",async t=>{
  const f=fixture(t),d=await enrollment(f);
  await f.call('/v2/device-authorizations/exchange',await signed(f,d,'exchange'));
  const before=f.sql.prepare('SELECT * FROM device_bound_bindings').get();
  const renewal=await signed(f,d,'renew',{binding_id:before.id,generation:1,operation_id:boundRandomId(32)});
  const recovery=await signed(f,d,'exchange');
  await retireBoundBinding(f.db,'customer',{binding_id:before.id,expected_revision:before.revision,operation_id:boundRandomId(32)});
  for(const [path,request] of [['/v2/device-leases/renew',renewal],['/v2/device-authorizations/exchange',recovery]]) {
    const response=await f.call(path,request);assert.equal(response.status,403);assert.equal(response.body.code,'device_retired');
  }
  const after=f.sql.prepare('SELECT * FROM device_bound_bindings').get();
  assert.equal(after.hold_until,before.hold_until);assert.equal(after.generation,before.generation+1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM device_bound_leases').get().n,1);
});

test("HTTP erased renewal results cannot be reissued after a database clock rollback",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const activated=await f.call('/v2/device-authorizations/exchange',await signed(f,d,'exchange'));
  const body={binding_id:activated.body.data.binding_id,generation:1,operation_id:boundRandomId(32)};
  assert.equal((await f.call('/v2/device-leases/renew',await signed(f,d,'renew',body))).status,200);
  f.clock(173800);await expireBoundRecovery(f.db);
  f.clock(1300);
  const request=await signed(f,d,'renew',body);
  const response=await f.call('/v2/device-leases/renew',request);
  assert.equal(response.status,409);assert.equal(response.body.code,'idempotency_conflict');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM device_bound_leases').get().n,2);
  assert.equal(f.sql.prepare('SELECT consumed_invocation_id FROM device_bound_challenges WHERE id=?').get(request.proof.challenge_id).consumed_invocation_id,null);
});

test("HTTP trials start on exchange and preserve their deadline through renewal and recovery",async t=>{
  for (const basis of ['from_issue','from_first_activation','from_first_use']) {
    const f=fixture(t);
    f.sql.prepare(`UPDATE entitlements SET is_trial=1,trial_expiration_basis=?,trial_duration_sec=1000,
      trial_one_per_device=1,valid_until=?`).run(basis,basis==='from_issue'?1900:null);
    const d=await enrollment(f);
    assert.equal(f.sql.prepare('SELECT trial_started_at FROM entitlements').get().trial_started_at,null);
    const request=await signed(f,d,'exchange');
    assert.equal(f.sql.prepare('SELECT trial_started_at FROM entitlements').get().trial_started_at,null);
    const activated=await f.call('/v2/device-authorizations/exchange',request);
    assert.equal(activated.status,200,JSON.stringify(activated.body));
    const deadline=basis==='from_issue'?1900:2000;
    assert.equal(activated.body.data.expires_at,deadline);
    const token=decodeDeviceLeaseEnvelope(activated.body.data.lease);
    assert.equal(token.claims['expires-at'],deadline);
    assert.equal(verify('RSA-SHA256',deviceLeaseSigningInput(token.payload),createPublicKey(publicPem),token.signature),true);
    const state=()=>f.sql.prepare('SELECT trial_started_at,trial_device_hash,authority_revision FROM entitlements').get();
    const started=state();
    assert.deepEqual({...started},{trial_started_at:1000,trial_device_hash:d.keyId,authority_revision:2});
    f.clock(1300);
    assert.deepEqual((await f.call('/v2/device-authorizations/exchange',await signed(f,d,'exchange'))).body,activated.body);
    const renew={binding_id:activated.body.data.binding_id,generation:1,operation_id:boundRandomId(32)};
    const renewed=await f.call('/v2/device-leases/renew',await signed(f,d,'renew',renew));
    assert.equal(renewed.status,200,JSON.stringify(renewed.body));
    assert.equal(renewed.body.data.expires_at,deadline);
    assert.deepEqual((await f.call('/v2/device-leases/renew',await signed(f,d,'renew',renew))).body,renewed.body);
    assert.deepEqual(state(),started);
    f.clock(deadline-1);
    const pending=await signed(f,d,'renew',{...renew,operation_id:boundRandomId(32)});
    f.clock(deadline);
    // Fresh exchange-recovery proof is available while the operation is retained,
    // but expired trial authority must still deny the recovered response.
    const expired=await f.call('/v2/device-authorizations/exchange',await signed(f,d,'exchange'));
    assert.equal(expired.status,403); assert.equal(expired.body.code,'access_denied');
    const challenge=await f.call('/v2/device-challenges',{purpose:'renew',binding_id:renew.binding_id,operation_id:boundRandomId(32)});
    assert.equal(challenge.status,404);
    const expiredRenewal=await f.call('/v2/device-leases/renew',pending);
    assert.equal(expiredRenewal.status,403); assert.equal(expiredRenewal.body.code,'access_denied');
    assert.deepEqual(state(),started);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM device_bound_leases').get().n,2);
  }
});

test("HTTP proof remains mandatory in legacy off modes and binds audience, body and expiry",async t=>{
  const f=fixture(t),d=await enrollment(f);
  assert.equal((await f.call("/v2/device-authorizations/exchange",d.body)).body.code,"proof_required");
  const wrongAudience=await signed(f,d,"exchange",d.body,{audience:"other"});
  assert.equal((await f.call("/v2/device-authorizations/exchange",wrongAudience)).body.code,"invalid_proof");
  const valid=await signed(f,d,"exchange");
  assert.equal((await f.call("/v2/device-authorizations/exchange",{...valid,code:boundRandomId(32)})).body.code,"invalid_proof");
  f.clock(1060);
  assert.equal((await f.call("/v2/device-authorizations/exchange",valid)).body.code,"challenge_expired");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_bindings").get().n,0);
});

test("HTTP lost commit response requires fresh proof and returns the original committed result",async t=>{
  const f=fixture(t),d=await enrollment(f),request=await signed(f,d,"exchange");
  const batch=f.db.batch;
  let lost=false;
  f.db.batch=async statements=>{const result=await batch(statements);if(!lost&&statements.some(s=>s.query.includes("INSERT INTO device_bound_operations"))){lost=true;throw new Error("simulated private database transport failure");}return result;};
  const failed=await f.call("/v2/device-authorizations/exchange",request);
  assert.equal(failed.status,503);
  assert.equal(failed.body.code,"temporarily_unavailable");
  const saved=f.sql.prepare("SELECT response_json FROM device_bound_operations").get();
  const recovered=await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"));
  assert.deepEqual(recovered.body,JSON.parse(saved.response_json));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_events").get().n,1);
});

test("HTTP rate/config gates precede parsing and cannot be disabled by legacy settings",async t=>{
  const f=fixture(t);
  for(let i=0;i<20;i++) assert.equal((await f.call("/v2/device-authorizations","malformed")).status,400);
  const limited=await f.call("/v2/device-authorizations","malformed");
  assert.equal(limited.status,429); assert.equal(limited.headers.get("retry-after"),"60");
  delete f.env.BOUND_DEVICE_CONFIG;
  assert.equal((await f.call("/v2/device-challenges",{})).status,503);
});

test("HTTP concurrent activation cannot oversubscribe the last device slot",async t=>{
  const f=fixture(t),first=await enrollment(f),second=await enrollment(f);
  const requests=await Promise.all([signed(f,first,"exchange"),signed(f,second,"exchange")]);
  const results=await Promise.all(requests.map(r=>f.call("/v2/device-authorizations/exchange",r)));
  assert.equal(results.filter(r=>r.status===200).length,1,JSON.stringify(results));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_bindings").get().n,1);
  const loser=results[0].status===200?second:first;
  assert.equal((await f.call("/v2/device-authorizations/exchange",await signed(f,loser,"exchange"))).body.code,"device_limit_reached");
});

test("HTTP recovery refreshes an approval consumed during proof verification",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const first=await signed(f,d,"exchange"),second=await signed(f,d,"exchange");
  const prepare=f.db.prepare; let raced=false,committed;
  f.db.prepare=query=>{
    const statement=prepare(query);
    if(query.startsWith("SELECT a.*,unixepoch() AS now")) {
      const bind=statement.bind.bind(statement);
      statement.bind=(...values)=>{const bound=bind(...values),read=bound.first.bind(bound);bound.first=async()=>{
        const old=await read();
        if(!raced){raced=true;committed=await f.call("/v2/device-authorizations/exchange",second);assert.equal(committed.status,200);}
        return old;
      };return bound;};
    }
    return statement;
  };
  const response=await f.call("/v2/device-authorizations/exchange",first);
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body,committed.body);
});

test("HTTP mixed pre-reads preserve unknown outcome when another invocation commits",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const first=await signed(f,d,"exchange"),second=await signed(f,d,"exchange");
  const prepare=f.db.prepare; let raced=false,committed;
  f.db.prepare=query=>{
    const statement=prepare(query);
    if(query==="SELECT * FROM device_bound_devices WHERE key_id=?") {
      const bind=statement.bind.bind(statement);
      statement.bind=(...values)=>{const bound=bind(...values),read=bound.first.bind(bound);bound.first=async()=>{
        const old=await read();
        if(!raced){raced=true;committed=await f.call("/v2/device-authorizations/exchange",second);assert.equal(committed.status,200);}
        return old;
      };return bound;};
    }
    return statement;
  };
  const response=await f.call("/v2/device-authorizations/exchange",first);
  assert.equal(response.status,503,JSON.stringify(response.body));
  assert.deepEqual((await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"))).body,committed.body);
});

test("HTTP valid proof cannot bypass PKCE, operation identity, retirement or signer purpose",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const wrong={...d.body,code_verifier:boundRandomId(32)};
  assert.equal((await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange",wrong))).body.code,"access_denied");
  const realPublic=f.env.BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM;
  delete f.env.BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM;
  f.env.LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM=privatePem;
  assert.equal((await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"))).status,503);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,0);
  f.env.BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM=realPublic;
  const result=await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"));
  assert.equal(result.status,200);
  const changed={...d.body,redirect_uri:"http://127.0.0.1:45679/callback"};
  assert.equal((await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange",changed))).body.code,"idempotency_conflict");
  const before=f.sql.prepare("SELECT hold_until FROM device_bound_bindings").get().hold_until;
  f.sql.exec("UPDATE device_bound_devices SET status='disabled'");
  assert.equal((await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"))).body.code,"device_retired");
  assert.equal(f.sql.prepare("SELECT hold_until FROM device_bound_bindings").get().hold_until,before);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,1);
});

test("HTTP rejects unsigned URL queries and keeps configuration failures no-store",async t=>{
  const f=fixture(t),d=await enrollment(f),request=await signed(f,d,"exchange");
  for(const suffix of ["?extra=1","?"]) {
    const response=await f.call(`/v2/device-authorizations/exchange${suffix}`,request);
    assert.equal(response.status,400); assert.equal(response.body.code,"invalid_request");
  }
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,0);
  f.env.REQUEST_SIGNATURE_MODE="invalid-mode";
  const response=await f.call("/v2/device-authorizations/exchange",request);
  assert.equal(response.status,503); assert.equal(response.body.code,"temporarily_unavailable");
  assert.equal(typeof response.body.request_id,"string");
});

test("HTTP current denial is not hidden by a competing successful operation",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const first=await signed(f,d,"exchange"),second=await signed(f,d,"exchange");
  const prepare=f.db.prepare; let raced=false;
  f.db.prepare=query=>{
    const statement=prepare(query);
    if(query.startsWith("SELECT e.*,c.status AS customer_status")) {
      const bind=statement.bind.bind(statement);
      statement.bind=(...values)=>{const bound=bind(...values),read=bound.first.bind(bound);bound.first=async()=>{
        if(!raced){raced=true;assert.equal((await f.call("/v2/device-authorizations/exchange",second)).status,200);f.sql.exec("UPDATE customers SET status='disabled'");}
        return read();
      };return bound;};
    }
    return statement;
  };
  const response=await f.call("/v2/device-authorizations/exchange",first);
  assert.equal(response.status,403); assert.equal(response.body.code,"access_denied");
});

test("HTTP rate infrastructure errors never reach issuance or expose exceptions",async t=>{
  const f=fixture(t),d=await enrollment(f),request=await signed(f,d,"exchange");
  f.env.VERIFY_RATE_LIMITER={async limit(){throw new Error("private binding details");}};
  const response=await f.call("/v2/device-authorizations",{});
  assert.equal(response.status,503); assert.equal(response.body.code,"temporarily_unavailable");
  assert.equal(JSON.stringify(response.body).includes("private"),false);
  delete f.env.VERIFY_RATE_LIMITER;
  f.db.batch=async()=>{throw new Error("private SQL details");};
  assert.equal((await f.call("/v2/device-authorizations/exchange",request)).status,503);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,0);
  assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id=?").get(request.proof.challenge_id).consumed_invocation_id,null);
});

test("HTTP global denial cannot grow per-client rows for rotating source identities",async t=>{
  const f=fixture(t);
  f.sql.exec("INSERT INTO rate_limit_counters VALUES('device-v2-global','global',960,1000,1080,1000)");
  for(let i=0;i<25;i++) assert.equal((await f.call("/v2/device-authorizations","malformed",{"cf-connecting-ip":`2001:db8::${i}`})).status,429);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace IN ('device-v2-client','device-v2-registration')").get().n,0);
  f.clock(1020);
  assert.equal((await f.call("/v2/device-authorizations","malformed")).status,400);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace IN ('device-v2-client','device-v2-registration')").get().n,1);
});

test("HTTP limiter fails closed if its batch straddles the minute boundary",async t=>{
  const f=fixture(t); f.clock(1019);
  const batch=f.db.batch;let crossed=false;
  f.db.batch=async statements=>{
    if(!crossed&&statements[0].query.startsWith("INSERT INTO rate_limit_counters")) {
      crossed=true;f.sql.exec("BEGIN IMMEDIATE");
      const first={results:f.sql.prepare(statements[0].query).all(...statements[0].params)};
      f.clock(1020);
      const second={results:f.sql.prepare(statements[1].query).all(...statements[1].params)};
      const third={results:f.sql.prepare(statements[2].query).all(...statements[2].params)};
      f.sql.exec("COMMIT");return [first,second,third];
    }
    return batch(statements);
  };
  assert.equal((await f.call("/v2/device-authorizations","malformed")).status,503);
  assert.ok(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace IN ('device-v2-client','device-v2-registration')").get().n<=1);
  assert.equal((await f.call("/v2/device-authorizations","malformed")).status,400);
});

test("one source over its budget cannot consume the global protected budget", async t => {
  const f = fixture(t);
  const flood = new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":"192.0.2.50"}});
  let limited = 0;
  for (let i = 0; i < 700; i++) {
    try { await limitBoundRequest(flood, f.env, f.db); } catch (error) { if (/rate_limited/.test(String(error.code ?? error.message))) limited++; else throw error; }
  }
  assert.equal(limited, 100);
  assert.equal(f.sql.prepare("SELECT request_count n FROM rate_limit_counters WHERE namespace='device-v2-global'").get().n, 600);
  const other = new Request("https://backend.test/v2/device-leases/renew", {headers:{"cf-connecting-ip":"192.0.2.51"}});
  await limitBoundRequest(other, f.env, f.db);
});

test("global protected budget is configurable and still denies once exhausted", async t => {
  const f = fixture(t);
  f.env.BOUND_GLOBAL_RATE_LIMIT = "150";
  for (let i = 0; i < 150; i++) await limitBoundRequest(new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":`198.51.100.${i % 200}`}}), f.env, f.db);
  await assert.rejects(limitBoundRequest(new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":"203.0.113.9"}}), f.env, f.db), /rate_limited/);
  f.env.BOUND_GLOBAL_RATE_LIMIT = "7";
  // Invalid values fall back to the default 1000, so this request is admitted
  // (global count is 150 < 1000), not denied.
  await limitBoundRequest(new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":"203.0.113.10"}}), f.env, f.db);
});

test("parseGlobalRateLimit is the one shared range check for both the runtime clamp and readiness", () => {
  for (const value of [100, 500, 1000, 1000000]) assert.equal(parseGlobalRateLimit(String(value)), value);
  assert.equal(parseGlobalRateLimit(500), 500);
  for (const invalid of [undefined, "0", "99", "1000001", "12.5", "not-a-number", "", "-5", "NaN", "Infinity"]) {
    assert.equal(parseGlobalRateLimit(invalid), null, String(invalid));
  }
});

test("verified renew for a large-capacity entitlement is admitted past the default 240/minute customer limit", async t => {
  const f = fixture(t);
  f.sql.prepare("UPDATE entitlements SET max_active_devices=200 WHERE project='APP'").run();
  const d = await enrollment(f);
  const activated = await f.call("/v2/device-authorizations/exchange", await signed(f, d, "exchange"));
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  // Seed the shared per-customer counter near the default 240/minute limit;
  // the entitlement's own cap is max(240, 2*200)=400, so the next verified
  // operation must still be admitted.
  f.sql.exec("UPDATE rate_limit_counters SET request_count=245 WHERE namespace='device-v2-customer'");
  const body = {binding_id: activated.body.data.binding_id, generation: 1, operation_id: boundRandomId(32)};
  const renewed = await f.call("/v2/device-leases/renew", await signed(f, d, "renew", body));
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(f.sql.prepare("SELECT request_count n FROM rate_limit_counters WHERE namespace='device-v2-customer'").get().n, 246);
});

test("session routes consult the edge limiter before any D1 write", async t => {
  const f = fixture(t);
  const keys = [];
  f.env.BOUND_SESSION_RATE_LIMITER = { async limit({ key }) { keys.push(key); return { success: false }; } };
  await assert.rejects(limitBoundRequest(new Request("https://backend.test/v2/device-leases/renew", {headers:{"cf-connecting-ip":"192.0.2.60"}}), f.env, f.db), /rate_limited/);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^device-v2-session:/);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters").get().n, 0);
});

test("source identity collapses IPv6 to its /64 and leaves IPv4 and malformed input raw", () => {
  for (const [raw, expected] of [
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:ffff:0:0:9", "2001:db8:1:2::/64"],
    ["[2001:db8:1:2::5]", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4::/64"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["192.0.2.1", "192.0.2.1"],
    ["unknown-client", "unknown-client"],
    ["garbage", "garbage"],
    ["1::2::3", "1::2::3"],
    ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
    ["12345::", "12345::"],
    ["192.0.2.256", "192.0.2.256"],
  ]) assert.equal(boundSourceIdentity(raw), expected, raw);
});

test("addresses in one IPv6 /64 share a source budget; another /64 does not", async t => {
  const f = fixture(t);
  const register = ip => limitBoundRequest(new Request("https://backend.test/v2/device-authorizations", {headers:{"cf-connecting-ip":ip}}), f.env, f.db);
  for (let i = 0; i < 10; i++) await register(`2001:db8:1:2::${i + 1}`);
  for (let i = 0; i < 10; i++) await register(`2001:db8:1:2:${(i + 1).toString(16)}::9`);
  await assert.rejects(register("2001:db8:1:2:ffff:ffff:ffff:ffff"), /rate_limited/);
  await register("2001:db8:1:3::1");
  await register("192.0.2.70");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace='device-v2-registration'").get().n, 3);
});

test("edge limiter keys use the same normalized source identity", async t => {
  const f = fixture(t);
  const keys = [];
  f.env.BOUND_SESSION_RATE_LIMITER = { async limit({ key }) { keys.push(key); return { success: false }; } };
  for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:abcd::7", "2001:db8:1:3::1", "192.0.2.61", "not-an-address"]) {
    await assert.rejects(limitBoundRequest(new Request("https://backend.test/v2/device-leases/renew", {headers:{"cf-connecting-ip":ip}}), f.env, f.db), /rate_limited/);
  }
  const key = async identity => `device-v2-session:${await boundSecretHash(identity)}`;
  assert.deepEqual(keys, [
    await key("2001:db8:1:2::/64"), await key("2001:db8:1:2::/64"), await key("2001:db8:1:3::/64"),
    await key("192.0.2.61"), await key("not-an-address"),
  ]);
});

test("HTTP mismatched signer and stale authority cannot commit a lease",async t=>{
  const f=fixture(t),d=await enrollment(f);
  const other=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  f.env.BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM=pem("PRIVATE KEY",await crypto.subtle.exportKey("pkcs8",other.privateKey));
  const request=await signed(f,d,"exchange");
  assert.equal((await f.call("/v2/device-authorizations/exchange",request)).status,503);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,0);
  f.env.BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM=privatePem;
  const batch=f.db.batch;
  f.db.batch=async statements=>{
    if(statements.some(s=>s.query.includes("INSERT INTO device_bound_operations"))) f.sql.exec("UPDATE customers SET status='disabled'");
    return batch(statements);
  };
  assert.equal((await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"))).status,503);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_bindings").get().n,0);
});


test("feature sessions renew fresh operations on one persistent binding with exact retry recovery",async t=>{
  const f=fixture(t);
  f.sql.exec("UPDATE entitlements SET lease_seconds=900");
  const d=await enrollment(f);
  const activation=await f.call("/v2/device-authorizations/exchange",await signed(f,d,"exchange"));
  assert.equal(activation.status,200);
  const issued=[];
  for (const now of [1100,1200,1300]) {
    f.clock(now);
    const body={binding_id:activation.body.data.binding_id,generation:1,operation_id:boundRandomId(32)};
    const fresh=await f.call("/v2/device-leases/renew",await signed(f,d,"renew",body));
    assert.equal(fresh.status,200,JSON.stringify(fresh.body));
    const token=decodeDeviceLeaseEnvelope(fresh.body.data.lease);
    assert.ok(verify("RSA-SHA256",deviceLeaseSigningInput(token.payload),createPublicKey(publicPem),token.signature));
    assert.equal(token.claims["operation-id"],body.operation_id);
    assert.equal(token.claims.feature,"DEFAULT");
    assert.equal(token.claims["issued-at"],now);
    assert.equal(token.claims["renew-after"],now+450);
    assert.equal(token.claims["expires-at"],now+900);
    issued.push(token.claims["lease-id"]);
    const before=f.sql.prepare("SELECT * FROM device_bound_bindings").get();
    const events=f.sql.prepare("SELECT * FROM device_bound_events ORDER BY id").all();
    const retry=await f.call("/v2/device-leases/renew",await signed(f,d,"renew",body));
    assert.deepEqual(retry.body,fresh.body);
    assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_bindings").get(),before);
    assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_events ORDER BY id").all(),events);
  }
  assert.equal(new Set(issued).size,3);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_devices").get().n,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_bindings WHERE state='active'").get().n,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_leases").get().n,4);
});

test("two feature entitlements share a device key but keep permissions and capacity independent",async t=>{
  const f=fixture(t);
  for(const feature of ["BATCH_RUN","EXPORT"]) f.sql.prepare(`INSERT INTO entitlements
    (project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,lease_seconds,valid_until,created_at,updated_at)
    VALUES('APP',?,?,'customer','active','device_bound_v1',1,900,10000,1000,1000)`).run(feature,fingerprint);
  const batch=await enrollment(f,"BATCH_RUN"),exporter=await enrollment(f,"EXPORT",batch.keys);
  assert.equal(batch.keyId,exporter.keyId);
  const bindings=[];
  for(const [feature,device] of [["BATCH_RUN",batch],["EXPORT",exporter]]) {
    const response=await f.call("/v2/device-authorizations/exchange",await signed(f,device,"exchange"));
    assert.equal(response.status,200,JSON.stringify(response.body));
    const token=decodeDeviceLeaseEnvelope(response.body.data.lease);
    assert.equal(token.claims.feature,feature);
    assert.equal(token.claims["device-key-id"],batch.keyId);
    bindings.push(response.body.data.binding_id);
  }
  assert.notEqual(bindings[0],bindings[1]);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_devices").get().n,1);
  assert.deepEqual(f.sql.prepare("SELECT feature,count(*) n FROM device_bound_bindings GROUP BY feature ORDER BY feature").all().map(r=>({...r})),[{feature:"BATCH_RUN",n:1},{feature:"EXPORT",n:1}]);
  f.clock(1100);
  const blocked=await enrollment(f,"BATCH_RUN");
  const denied=await f.call("/v2/device-authorizations/exchange",await signed(f,blocked,"exchange"));
  assert.equal(denied.status,409);assert.equal(denied.body.code,"device_limit_reached");
  f.clock(1200);
  f.sql.exec("UPDATE entitlements SET status='disabled',revocation_seq=revocation_seq+1 WHERE feature='BATCH_RUN'");
  const batchDenied=await f.call("/v2/device-challenges",{purpose:"renew",binding_id:bindings[0],operation_id:boundRandomId(32)});
  assert.equal(batchDenied.status,404);assert.equal(batchDenied.body.code,"binding_unavailable");
  const body={binding_id:bindings[1],generation:1,operation_id:boundRandomId(32)};
  const exportRenewal=await f.call("/v2/device-leases/renew",await signed(f,exporter,"renew",body));
  assert.equal(exportRenewal.status,200,JSON.stringify(exportRenewal.body));
  assert.equal(decodeDeviceLeaseEnvelope(exportRenewal.body.data.lease).claims.feature,"EXPORT");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_bindings WHERE state='active'").get().n,2);
});


test("session traffic behind one NAT exceeds ten jobs without trusting claimed device ids", async t => {
  const f = fixture(t);
  const request = new Request("https://backend.test/v2/device-leases/renew", {headers:{"cf-connecting-ip":"192.0.2.20"}});
  for (let i=0;i<100;i++) await limitBoundRequest(request, f.env, f.db);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace='device-v2-device'").get().n, 0);
  for (let i=0;i<60;i++) await limitBoundVerified(f.db, "sha256:" + "a".repeat(64), "owner");
  await assert.rejects(limitBoundVerified(f.db, "sha256:" + "a".repeat(64), "owner"), /rate_limited/);
  await limitBoundVerified(f.db, "sha256:" + "b".repeat(64), "other");
  f.clock(1060);
  await limitBoundVerified(f.db, "sha256:" + "a".repeat(64), "owner");
});

test("invalid possession proofs cannot consume verified customer budgets", async t => {
  const f = fixture(t), d = await enrollment(f);
  const request = await signed(f,d,"exchange");
  request.proof.signature = "A".repeat(86);
  assert.equal((await f.call("/v2/device-authorizations/exchange",request)).status,401);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace IN ('device-v2-device','device-v2-customer')").get().n,0);
});

test("recovering a committed exchange is not blocked by an exhausted device budget", async t => {
  const f = fixture(t), d = await enrollment(f);
  const activated = await f.call("/v2/device-authorizations/exchange", await signed(f, d, "exchange"));
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  f.sql.prepare("INSERT INTO rate_limit_counters VALUES('device-v2-device',?,960,61,1080,1000) ON CONFLICT(namespace,rate_key,window_start) DO UPDATE SET request_count=61").run(d.keyId);
  const recovered = await f.call("/v2/device-authorizations/exchange", await signed(f, d, "exchange"));
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.deepEqual(recovered.body, activated.body);
});

test("customer verified budget scales with the entitlement device limit", async t => {
  const f = fixture(t);
  const key = i => "sha256:" + i.toString(16).padStart(64, "0");
  for (let i = 0; i < 250; i++) await limitBoundVerified(f.db, key(i), "fleet", 500);
  for (let i = 0; i < 240; i++) await limitBoundVerified(f.db, key(1000 + i), "small");
  await assert.rejects(limitBoundVerified(f.db, key(2000), "small"), /rate_limited/);
});
