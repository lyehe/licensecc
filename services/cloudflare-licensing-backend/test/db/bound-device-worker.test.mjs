import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { measureBoundCleanupBacklog, purgeExpiredBoundEphemera } from "../../src/device/bound_cleanup.mjs";
import { encodeBase64url, deviceOperationBody, deviceProofSigningInput, decodeDeviceLeaseEnvelope, deviceEnrollmentComparisonInput, formatDeviceEnrollmentComparison } from "@licensecc/licensing-domain/lease/device_protocol";
import { boundRandomId, boundSecretHash } from "../../src/device/bound_enrollment.mjs";
import { sha256Hex, normalizeDeviceSignature, importBoundDeviceKey } from "../../src/device/bound_crypto.mjs";

import { mintSession } from "../../../cloudflare-customer-portal/src/auth/portal_session.mjs";

const require=createRequire(import.meta.url),wranglerRequire=createRequire(require.resolve("wrangler/package.json"));
const {Miniflare,convertV4MiniflareOptions}=wranglerRequire("miniflare");
const {build}=wranglerRequire("esbuild");

for(const trial of [false,true])test(`actual local Worker and D1 execute ${trial?'trial':'standard'} enrollment, signed activation, recovery and renewal`,async t=>{
  const bundled=await build({entryPoints:[fileURLToPath(new URL("../../src/index.ts",import.meta.url))],bundle:true,external:["cloudflare:workers"],write:false,format:"esm",platform:"browser",target:"es2022",logLevel:"silent"});
  const portalBundle=await build({entryPoints:[fileURLToPath(new URL("../../../cloudflare-customer-portal/src/worker/index.ts",import.meta.url))],bundle:true,external:["cloudflare:workers","node:crypto"],write:false,format:"esm",platform:"browser",target:"es2022",logLevel:"silent"});
  const adminBundle=await build({entryPoints:[fileURLToPath(new URL("../../../cloudflare-license-admin/src/worker/index.ts",import.meta.url))],bundle:true,external:["cloudflare:workers","node:crypto"],write:false,format:"esm",platform:"browser",target:"es2022",logLevel:"silent"});
  const sessionPeppers=JSON.stringify({test:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")});
  const signer=await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);
  const pem=(label,bytes)=>`-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64")}\n-----END ${label}-----`;
  const config={issuer:"https://licenses.example.test/",audience:"desktop",authorization_url:"https://portal.example.test/connect",
    clients:[{client_id:"desktop",project:"APP",display_name:"Example app",callbacks:[{host:"127.0.0.1",path:"/callback"}]}]};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:"device-http",modules:true,script:bundled.outputFiles[0].text,
    compatibilityDate:"2026-08-01",d1Databases:{DB:"device-http"},bindings:{BOUND_DEVICE_CONFIG:JSON.stringify(config),
      BOUND_APPROVAL_ENCRYPTION_KEYS:JSON.stringify({active:"test",keys:{test:boundRandomId(32)}}),
      BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM:pem("PRIVATE KEY",await crypto.subtle.exportKey("pkcs8",signer.privateKey)),
      BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM:pem("PUBLIC KEY",await crypto.subtle.exportKey("spki",signer.publicKey)),
      DEVICE_PROOF_MODE:"off",ACCOUNT_TOKEN_MODE:"off",REQUEST_SIGNATURE_MODE:"off",D1_RATE_LIMIT_ENABLED:"0"}},
    // Test-only caller: production portal will derive identity from its session.
    {name:"consent-caller",modules:true,compatibilityDate:"2026-08-01",
      serviceBindings:{CONSENT:{name:"device-http",entrypoint:"DeviceConsent"},OPERATOR:{name:"device-http",entrypoint:"DeviceOperator"},PUBLIC:"device-http",PORTAL:"real-portal"},
      script:`export default {async fetch(request,env){const b=await request.json();
        if(b.portal) return env.PORTAL.fetch(new Request("https://portal.example.test/api/portal/"+(b.op==="list"?"device-bindings":b.op==="retire"?"device-bindings/retire":"device-authorizations/"+b.op),{method:b.op==="list"?"GET":"POST",headers:b.headers,...(b.op==="list"?{}:{body:JSON.stringify(b.input)})}));
        if(b.malformed==="undefined") b.input.extra=undefined;
        if(b.malformed==="bigint") b.input.attempt_handle=1n;
        if(b.malformed==="negative-zero") b.input.expected_attempt_revision=-0;
        if(b.malformed==="oversized") b.input.attempt_handle="a".repeat(16385);
        try {return Response.json(b.binding==="OPERATOR"?await env.OPERATOR[b.method](b.actor,b.customer??"customer",b.input):await env[b.binding??"CONSENT"][b.method](b.customer??"customer",b.input));}
        catch {return Response.json({rpc_unavailable:true});}}}`}
    ,{name:"real-portal",modules:true,compatibilityDate:"2026-08-01",compatibilityFlags:["nodejs_compat"],script:portalBundle.outputFiles[0].text,
      d1Databases:{DB:"device-http"},serviceBindings:{DEVICE_CONSENT:{name:"device-http",entrypoint:"DeviceConsent"}},
      bindings:{PORTAL_PUBLIC_ORIGIN:"https://portal.example.test",PORTAL_SESSION_PEPPERS:sessionPeppers}},
    {name:"real-admin",modules:true,compatibilityDate:"2026-08-01",compatibilityFlags:["nodejs_compat"],script:adminBundle.outputFiles[0].text,
      d1Databases:{DB:"device-http"},serviceBindings:{DEVICE_OPERATOR:{name:"device-http",entrypoint:"DeviceOperator"}},
      bindings:{ENVIRONMENT:"development",ADMIN_DEV_BEARER_ENABLED:"1",ADMIN_DEV_BEARER:"local-test-admin"}}
  ]}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database("DB");
  const parser=new DatabaseSync(":memory:");let ddl;
  try{parser.exec(readFileSync(new URL("../../schema.sql",import.meta.url),"utf8"));ddl=parser.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all();}
  finally{parser.close();}
  for(const row of ddl)await db.prepare(row.sql).run();
  const fingerprint="a".repeat(64);
  await db.prepare("INSERT INTO customers(id,name,created_at,updated_at) VALUES('customer','Customer',unixepoch(),unixepoch())").run();
  await db.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,lease_seconds,created_at,updated_at) VALUES('APP','DEFAULT',?,'customer','active','device_bound_v1',1,3600,unixepoch(),unixepoch())").bind(fingerprint).run();
  if(trial)await db.prepare("UPDATE entitlements SET is_trial=1,trial_expiration_basis='from_first_activation',trial_duration_sec=7200,trial_one_per_device=1").run();
  async function call(path,body,expectedStatus=200){
    const response=await mf.dispatchFetch(`https://untrusted-host.test${path}`,{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":"127.0.0.2"},body:JSON.stringify(body)});
    assert.equal(response.headers.get("cache-control"),"no-store");
    const result=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(result));return result;
  }
  const keys=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const spki=encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki",keys.publicKey))),keyId=(await importBoundDeviceKey(spki)).keyId;
  const verifier=boundRandomId(32),redirect="http://127.0.0.1:45678/callback";
  const original={client_id:"desktop",project:"APP",public_key_spki:spki,device_label:"Workstation",redirect_uri:redirect,state:boundRandomId(32),code_challenge:encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)))),code_challenge_method:"S256"};
  const attempt=await call("/v2/device-authorizations",original);
  const comparison=formatDeviceEnrollmentComparison(new Uint8Array(await crypto.subtle.digest("SHA-256",deviceEnrollmentComparisonInput({attempt_handle:attempt.data.attempt_handle,client_id:original.client_id,project:original.project,key_id:keyId,redirect_uri:original.redirect_uri,state:original.state,code_challenge:original.code_challenge}))));
  assert.equal(attempt.data.comparison_code,comparison);
  const caller=await mf.getWorker("consent-caller");
  async function consent(method,input,extra={}) {
    return (await caller.fetch("https://test-only-caller/",{method:"POST",body:JSON.stringify({method,input,...extra})})).json();
  }
  const inspect=await consent("inspect",{attempt_handle:attempt.data.attempt_handle});
  assert.equal(inspect.code,"authorization_inspected");assert.equal(inspect.data.entitlements.length,1);
  assert.equal(inspect.data.entitlements[0].activation_trial_seconds,trial?7200:undefined);
  assert.equal(inspect.data.comparison_code,comparison);assert.equal(inspect.data.next_page_cursor,null);
  assert.equal((await consent("inspect",{attempt_handle:attempt.data.attempt_handle,extra:true})).status,400);
  assert.equal((await consent("inspect",{attempt_handle:attempt.data.attempt_handle},{customer:"missing"})).status,403);
  assert.equal((await consent("inspect",{attempt_handle:attempt.data.attempt_handle},{binding:"PUBLIC"})).rpc_unavailable,true);
  const publicConsent=await mf.dispatchFetch("https://public.test/api/portal/device-authorizations/approve",{method:"POST",headers:{"x-customer-id":"customer"},body:"{}"});
  assert.equal(publicConsent.status,404);
  const approvalInput={attempt_handle:attempt.data.attempt_handle,entitlement_id:inspect.data.entitlements[0].id,expected_attempt_revision:0,operation_id:boundRandomId(32)};
  const session=await mintSession({DB:db,PORTAL_SESSION_PEPPERS:sessionPeppers},{customerId:"customer"});
  assert.equal(session.ok,true);
  async function portalCall(op,body,headers={}) {
    return caller.fetch("https://test-only-caller/",{method:"POST",body:JSON.stringify({portal:true,op,input:body,headers:{"content-type":"application/json",origin:"https://portal.example.test",cookie:`lccp_session=${session.raw}`,"x-expected-customer-id":"customer","idempotency-key":approvalInput.operation_id,...headers}})});
  }
  const unauthPortal=await portalCall("inspect",{attempt_handle:attempt.data.attempt_handle},{cookie:""});
  assert.equal(unauthPortal.status,401,await unauthPortal.text());
  assert.equal((await portalCall("inspect",{attempt_handle:attempt.data.attempt_handle},{origin:"https://evil.test"})).status,403);
  assert.equal((await portalCall("inspect",{attempt_handle:attempt.data.attempt_handle,customer_id:"other"})).status,400);
  for(const op of ["inspect","approve","deny"]){
    assert.equal((await portalCall(op,{attempt_handle:attempt.data.attempt_handle},{"x-expected-customer-id":""})).status,400);
    const changed=await portalCall(op,{attempt_handle:attempt.data.attempt_handle},{"x-expected-customer-id":"other"});
    assert.equal(changed.status,409);assert.equal((await changed.json()).code,"account_changed");
  }
  const extraGrants=Array.from({length:101},(_,i)=>db.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,created_at,updated_at) VALUES('APP','DEFAULT',?,'customer','active','device_bound_v1',unixepoch(),unixepoch())").bind((i+1).toString(16).padStart(64,"0")));
  for(let i=0;i<extraGrants.length;i+=50)await db.batch(extraGrants.slice(i,i+50));
  const page1=await (await portalCall("inspect",{attempt_handle:attempt.data.attempt_handle})).json();
  assert.equal(page1.data.entitlements.length,100);assert.equal(page1.data.has_more,true);assert.equal(page1.data.comparison_code,comparison);
  const page2=await (await portalCall("inspect",{attempt_handle:attempt.data.attempt_handle,page_cursor:page1.data.next_page_cursor})).json();
  assert.equal(page2.data.entitlements.length,2);assert.equal(page2.data.next_page_cursor,null);assert.equal(page2.data.comparison_code,comparison);
  assert.equal(page2.data.entitlements.at(-1).id,approvalInput.entitlement_id);
  for(const page_cursor of [null,"","x".repeat(513),page1.data.next_page_cursor+"="]){
    assert.equal((await portalCall("inspect",{attempt_handle:attempt.data.attempt_handle,page_cursor})).status,400);
    assert.equal((await consent("inspect",{attempt_handle:attempt.data.attempt_handle,page_cursor})).status,400);
  }
  const {operation_id:unused,...portalInput}=approvalInput;
  const portalApproval=await portalCall("approve",portalInput,{"x-customer-id":"other"});
  assert.equal(portalApproval.status,200);assert.equal(portalApproval.headers.get("cache-control"),"no-store");
  const approved=await portalApproval.json();
  assert.equal(approved.code,"authorization_approved");
  assert.equal(await db.prepare('SELECT trial_started_at FROM entitlements WHERE license_fingerprint=?').bind(fingerprint).first('trial_started_at'),null);
  assert.deepEqual((await consent("approve",approvalInput)).data,approved.data);
  const code=new URL(approved.data.callback_url).searchParams.get("code");
  assert.equal(await db.prepare("SELECT approval_ciphertext IS NOT NULL AS encrypted FROM device_bound_authorizations WHERE handle_hash=?").bind(await boundSecretHash(attempt.data.attempt_handle)).first("encrypted"),1);
  async function signed(purpose,body){
    const subject=purpose==="exchange"?{attempt_handle:body.attempt_handle}:{binding_id:body.binding_id};
    const c=(await call("/v2/device-challenges",{purpose,...subject,operation_id:body.operation_id})).data;
    const input={audience:config.audience,method:"POST",path:purpose==="exchange"?"/v2/device-authorizations/exchange":"/v2/device-leases/renew",key_id:keyId,operation_id:body.operation_id,body_sha256:await sha256Hex(deviceOperationBody(purpose,body)),challenge_id:c.challenge_id,nonce:c.nonce,expires_at:c.expires_at};
    return {...body,proof:{key_id:keyId,challenge_id:c.challenge_id,nonce:c.nonce,expires_at:c.expires_at,signature:encodeBase64url(normalizeDeviceSignature(new Uint8Array(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},keys.privateKey,deviceProofSigningInput(input)))))}};
  }
  const body={attempt_handle:attempt.data.attempt_handle,code,code_verifier:verifier,redirect_uri:redirect,operation_id:boundRandomId(32)};
  const activated=await call("/v2/device-authorizations/exchange",await signed("exchange",body));
  if(trial){
    const stamp=await db.prepare('SELECT trial_started_at,trial_device_hash FROM entitlements WHERE license_fingerprint=?').bind(fingerprint).first();
    assert.ok(stamp.trial_started_at>0);assert.equal(stamp.trial_device_hash,keyId);
  }
  const claims=decodeDeviceLeaseEnvelope(activated.data.lease).claims;
  assert.equal(claims["device-key-id"],keyId);assert.equal(claims.issuer,config.issuer);
  assert.equal(claims["expires-at"]-claims["issued-at"],3600);
  assert.deepEqual(await call("/v2/device-authorizations/exchange",await signed("exchange",body)),activated);
  const renew={binding_id:activated.data.binding_id,generation:1,operation_id:boundRandomId(32)};
  const renewed=await call("/v2/device-leases/renew",await signed("renew",renew));
  assert.equal(renewed.data.binding_id,activated.data.binding_id);
  assert.equal(await db.prepare("SELECT count(*) n FROM device_bound_bindings").first("n"),1);
  assert.equal(await db.prepare("SELECT count(*) n FROM device_bound_leases").first("n"),2);
  const binding=await db.prepare('SELECT revision,generation,hold_until FROM device_bound_bindings WHERE id=?').bind(activated.data.binding_id).first();
  const retireInput={binding_id:activated.data.binding_id,expected_revision:binding.revision,operation_id:boundRandomId(32)};
  const listed=await (await portalCall('list',{})).json();
  assert.equal(listed.code,'device_bindings');assert.equal(listed.data.items.length,1);
  assert.equal(listed.data.items[0].binding_id,retireInput.binding_id);assert.equal(listed.data.items[0].state,'active');
  assert.equal((await consent('retire',retireInput,{customer:'missing'})).status,404);
  assert.equal((await consent('retire',{...retireInput,extra:true})).status,400);
  assert.equal((await consent('retire',retireInput,{binding:'PUBLIC'})).rpc_unavailable,true);
  const {operation_id:retireKey,...retireBody}=retireInput;
  const retirementResponse=await portalCall('retire',retireBody,{'idempotency-key':retireKey});
  assert.equal(retirementResponse.status,200);assert.equal(retirementResponse.headers.get('cache-control'),'no-store');
  const retired=await retirementResponse.json();
  assert.equal(retired.code,'binding_retired');assert.equal(retired.data.effective_release_at,binding.hold_until);
  assert.deepEqual((await consent('retire',retireInput)).data,retired.data);
  const retried=await portalCall('retire',retireBody,{'idempotency-key':retireKey});
  assert.equal(retried.status,200);assert.deepEqual((await retried.json()).data,retired.data);
  const persisted=await db.prepare('SELECT hold_until,generation,revision FROM device_bound_bindings WHERE id=?').bind(retireInput.binding_id).first();
  assert.equal(persisted.hold_until,binding.hold_until);assert.equal(persisted.generation,retired.data.generation);
  assert.equal(persisted.generation,binding.generation+1);
  const retiringList=await (await portalCall('list',{})).json();
  assert.equal(retiringList.data.items[0].state,'retiring');assert.equal(retiringList.data.items[0].revision,persisted.revision);
  assert.equal(persisted.revision,binding.revision+1);
  assert.equal((await db.prepare("SELECT count(*) n FROM device_bound_events WHERE binding_id=? AND event_type='retire'").bind(retireInput.binding_id).first()).n,1);
  assert.equal((await call('/v2/device-challenges',{purpose:'renew',binding_id:activated.data.binding_id,operation_id:boundRandomId(32)},404)).code,'binding_unavailable');
  const cancelAttempt=await call("/v2/device-authorizations",{client_id:"desktop",project:"APP",public_key_spki:spki,device_label:"Cancel test",redirect_uri:redirect,state:boundRandomId(32),code_challenge:encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)))),code_challenge_method:"S256"});
  const cancelInput={attempt_handle:cancelAttempt.data.attempt_handle,expected_attempt_revision:0,operation_id:boundRandomId(32)};
  for(const malformed of ["undefined","bigint","negative-zero","oversized"]) {
    assert.equal((await consent("deny",cancelInput,{malformed})).status,400,malformed);
  }
  const denied=await (await portalCall("deny",{attempt_handle:cancelInput.attempt_handle,expected_attempt_revision:0},{"idempotency-key":cancelInput.operation_id})).json();
  assert.equal(denied.code,"authorization_denied");
  assert.deepEqual((await consent("deny",cancelInput)).data,denied.data);
  assert.equal((await consent("execute",cancelInput)).rpc_unavailable,true);
  const operatorBinding=boundRandomId(16),operatorFingerprint='b'.repeat(64);
  await db.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,created_at,updated_at) VALUES('APP','OPERATOR',?,'customer','active','device_bound_v1',1,unixepoch(),unixepoch())").bind(operatorFingerprint).run();
  await db.prepare("INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,hold_until,created_at,updated_at) VALUES(?,'APP','OPERATOR',?,?,unixepoch()+120,unixepoch(),unixepoch())").bind(operatorBinding,operatorFingerprint,activated.data.device_id).run();
  const operatorInput={binding_id:operatorBinding,expected_revision:0,operation_id:boundRandomId(32)};
  const operator={subject:'access-subject',actor_type:'access',role:'admin'};
  const operatorCall=(actor=operator)=>consent('retire',operatorInput,{binding:'OPERATOR',actor});
  assert.equal((await operatorCall({...operator,role:'reader'})).code,'access_denied');
  assert.equal((await consent('approve',operatorInput,{binding:'OPERATOR',actor:operator})).rpc_unavailable,true);
  assert.equal((await consent('retireBoundBindingAsOperator',operatorInput)).rpc_unavailable,true);
  const operated=await operatorCall();assert.equal(operated.code,'binding_retired');
  assert.deepEqual((await operatorCall()).data,operated.data);
  assert.equal((await operatorCall({...operator,subject:'another-operator'})).code,'idempotency_conflict');
  assert.equal((await consent('retire',operatorInput)).code,'idempotency_conflict');
  const operatorState=await db.prepare('SELECT generation,revision,hold_until FROM device_bound_bindings WHERE id=?').bind(operatorBinding).first();
  assert.equal(operatorState.generation,2);assert.equal(operatorState.revision,1);assert.equal(operatorState.hold_until,operated.data.effective_release_at);
  const operatorEvents=await db.prepare('SELECT actor FROM device_bound_events WHERE binding_id=?').bind(operatorBinding).all();
  assert.deepEqual(operatorEvents.results,[{actor:'operator:access:access-subject'}]);
  const admin=await mf.getWorker('real-admin'),adminBinding=boundRandomId(16),adminKey=boundRandomId(32),adminFingerprint='e'.repeat(64);
  await db.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,max_active_devices,created_at,updated_at) VALUES('APP','ADMIN',?,'customer','active','device_bound_v1',1,unixepoch(),unixepoch())").bind(adminFingerprint).run();
  await db.prepare("INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,hold_until,created_at,updated_at) VALUES(?,'APP','ADMIN',?,?,unixepoch()+120,unixepoch(),unixepoch())").bind(adminBinding,adminFingerprint,activated.data.device_id).run();
  const adminPath=`https://admin.example.test/api/admin/customers/customer/bindings`;
  const adminHeaders={authorization:'Bearer local-test-admin','content-type':'application/json','x-expected-operator':encodeURIComponent(JSON.stringify(['dev','dev'])),'idempotency-key':adminKey};
  const adminRead=await admin.fetch(`${adminPath}?binding_id=${adminBinding}`,{headers:adminHeaders});
  assert.equal(adminRead.status,200);const adminPage=await adminRead.json();assert.equal(adminPage.data.items[0].binding_id,adminBinding);
  const adminRetire=body=>admin.fetch(`${adminPath}/${adminBinding}/retire`,{method:'POST',headers:adminHeaders,body:JSON.stringify(body)});
  assert.equal((await adminRetire({expected_revision:0,actor:'forged'})).status,400);
  const adminResponse=await adminRetire({expected_revision:0});assert.equal(adminResponse.status,200);assert.equal(adminResponse.headers.get('cache-control'),'no-store');
  const adminRetired=await adminResponse.json();assert.equal(adminRetired.code,'binding_retired');
  assert.deepEqual((await (await adminRetire({expected_revision:0})).json()).data,adminRetired.data);
  const adminHistory=await (await admin.fetch(`${adminPath}/${adminBinding}/events`,{headers:adminHeaders})).json();
  assert.equal(adminHistory.data.items.length,1);assert.equal(adminHistory.data.items[0].actor,'operator:dev:dev');
  assert.equal((await db.prepare('SELECT hold_until FROM device_bound_bindings WHERE id=?').bind(adminBinding).first()).hold_until,adminRetired.data.effective_release_at);
  await db.prepare("UPDATE customers SET status='disabled' WHERE id='customer'").run();
  assert.equal((await consent("deny",cancelInput)).status,403);
  // Exercise the actual local D1 session API and indexed read projection after
  // real issuance/retirement. Disabled customer state does not hide cleanup work.
  assert.equal(typeof db.withSession,'function');
  const heldBefore=(await db.prepare('SELECT id,state,generation,revision,hold_until FROM device_bound_bindings ORDER BY id').all()).results;
  const eventsBefore=await db.prepare('SELECT COUNT(*) AS n FROM device_bound_events').first('n');
  await purgeExpiredBoundEphemera(db);
  const probeId=boundRandomId(16);
  await db.prepare("INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at) VALUES(?,'exchange','probe','probe','probe',?,unixepoch()-30,unixepoch()-10)")
    .bind(probeId,probeId).run();
  const deadline=await db.prepare('SELECT expires_at FROM device_bound_challenges WHERE id=?').bind(probeId).first('expires_at');
  const backlog=(await measureBoundCleanupBacklog(db)).find(row=>row.source==='ephemera'&&row.target==='challenges');
  assert.equal(backlog.backlog_present,true);assert.equal(backlog.oldest_expired_at,deadline);
  assert.equal(backlog.backlog_age_seconds,backlog.measured_at-deadline);assert.ok(backlog.backlog_age_seconds>=10);
  await purgeExpiredBoundEphemera(db);
  const cleared=(await measureBoundCleanupBacklog(db)).find(row=>row.source==='ephemera'&&row.target==='challenges');
  assert.equal(cleared.backlog_present,false);assert.equal(cleared.backlog_age_seconds,null);
  assert.deepEqual((await db.prepare('SELECT id,state,generation,revision,hold_until FROM device_bound_bindings ORDER BY id').all()).results,heldBefore);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM device_bound_events').first('n'),eventsBefore);
});
