import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { inspectBoundAuthorization, approveBoundAuthorization, denyBoundAuthorization } from "../../src/device/bound_consent.mjs";
import { boundRandomId, boundSecretHash } from "../../src/device/bound_enrollment.mjs";
import { openBoundApproval } from "../../src/device/bound_approval_crypto.mjs";
import { ERASE_EXPIRED_BOUND_APPROVALS_SQL, purgeExpiredBoundApprovals } from "../../src/device/bound_cleanup.mjs";
import { CONSENT_PAGE_SQL } from "../../src/device/bound_consent_page.mjs";

async function fixture(t, requestedFeature = null) {
  const sql=new DatabaseSync(":memory:");t.after(()=>sql.close());let now=1000,before=()=>{};
  sql.function("unixepoch",()=>BigInt(now));sql.exec("PRAGMA foreign_keys=ON");
  sql.exec(readFileSync(new URL("../../schema.sql",import.meta.url),"utf8"));
  const fingerprint="a".repeat(64),handle=boundRandomId(32),hash=await boundSecretHash(handle);
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('owner','Owner',1000,1000),('other','Other',1000,1000);
    INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,created_at,updated_at)
    VALUES('APP','DEFAULT','${fingerprint}','owner','active','device_bound_v1',1000,1000);`);
  sql.prepare("INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,device_label,redirect_uri,client_state,pkce_challenge,requested_feature,created_at,expires_at) VALUES(?,'desktop','APP',?,'pinned-spki','Workstation','http://127.0.0.1:45678/callback',?,?,?,1000,1300)").run(hash,`sha256:${"b".repeat(64)}`,"A".repeat(43),"A".repeat(43),requestedFeature);
  class Statement {constructor(query,params=[]){this.query=query;this.params=params;}bind(...params){return new Statement(this.query,params);}async first(){before(this.query);return sql.prepare(this.query).get(...this.params)??null;}async all(){before(this.query);return {results:sql.prepare(this.query).all(...this.params)};}}
  const db={prepare:query=>new Statement(query),async batch(statements){
    sql.exec("BEGIN");try{const results=statements.map(s=>{before(s.query);return sql.prepare(s.query).all(...s.params);});sql.exec("COMMIT");return results;}
    catch(error){sql.exec("ROLLBACK");throw error;}
  }};
  const config={clients:[{client_id:"desktop",project:"APP",display_name:"Example app",callbacks:[{host:"127.0.0.1",path:"/callback"}]}]};
  const ring=JSON.stringify({active:"approval1",keys:{approval1:boundRandomId(32)}});
  const inspected=await inspectBoundAuthorization(db,"owner",handle,config);
  const input={attempt_handle:handle,entitlement_id:inspected.entitlements[0].id,expected_attempt_revision:0,operation_id:boundRandomId(32)};
  return {sql,db,config,ring,input,hash,clock(value){now=value;},before(callback){before=callback;}};
}

function seedPages(f,count){
  f.sql.exec("UPDATE entitlements SET status='disabled'");
  const insert=f.sql.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,created_at,updated_at) VALUES('APP','DEFAULT',?,'owner','active','device_bound_v1',1000,1000)");
  for(let i=1;i<=count;i++)insert.run((i*10).toString(16).padStart(64,"0"));
  return insert;
}

test("trial consent reports timing and approves without starting or reserving a device",async t=>{
  for(const basis of ['from_issue','from_first_activation','from_first_use']){
    const f=await fixture(t);
    f.sql.prepare(`UPDATE entitlements SET is_trial=1,trial_expiration_basis=?,trial_duration_sec=86400,
      trial_one_per_device=1,valid_until=?`).run(basis,basis==='from_issue'?1200:null);
    const read=()=>inspectBoundAuthorization(f.db,'owner',f.input.attempt_handle,f.config);
    const page=await read();assert.equal(page.entitlements.length,1);
    assert.equal(page.entitlements[0].activation_trial_seconds,basis==='from_issue'?undefined:86400);
    assert.equal(page.entitlements[0].valid_until,basis==='from_issue'?1200:null);
    const before=f.sql.prepare('SELECT * FROM entitlements').get();
    const approved=await approveBoundAuthorization(f.db,'owner',f.input,f.config,f.ring);
    assert.deepEqual(await approveBoundAuthorization(f.db,'owner',f.input,f.config,f.ring),approved);
    assert.deepEqual(f.sql.prepare('SELECT * FROM entitlements').get(),before);
    for(const table of ['device_bound_devices','device_bound_bindings','device_bound_leases'])
      assert.equal(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  }
});

test("started-trial consent uses its persisted deadline and rejects a different device key",async t=>{
  const f=await fixture(t);
  f.sql.prepare(`UPDATE entitlements SET is_trial=1,trial_expiration_basis='from_first_activation',trial_duration_sec=200,
    trial_started_at=900,trial_device_hash=?,trial_one_per_device=1`).run(`sha256:${'b'.repeat(64)}`);
  const read=()=>inspectBoundAuthorization(f.db,'owner',f.input.attempt_handle,f.config);
  const first=await read();assert.equal(first.entitlements[0].valid_until,1100);
  assert.equal(first.entitlements[0].activation_trial_seconds,undefined);
  f.sql.exec('UPDATE entitlements SET valid_until=1050');
  assert.equal((await read()).entitlements[0].valid_until,1050);
  f.sql.prepare('UPDATE entitlements SET trial_device_hash=?').run(`sha256:${'c'.repeat(64)}`);
  assert.equal((await read()).entitlements.length,0);
  await assert.rejects(approveBoundAuthorization(f.db,'owner',f.input,f.config,f.ring),/access_denied/);
  f.sql.exec('UPDATE entitlements SET trial_one_per_device=0');
  assert.equal((await read()).entitlements.length,1);
  f.clock(1050);assert.equal((await read()).entitlements.length,0);
});

for(const count of [0,1,100,101,225])test(`consent pages traverse ${count} eligible licenses without omissions or duplicates`,async t=>{
  const f=await fixture(t);seedPages(f,count);let cursor,code;const ids=[];
  do{
    const page=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config,cursor);
    assert.equal(page.has_more,page.next_page_cursor!==null);assert.ok(page.entitlements.length<=100);
    if(page.has_more)assert.equal(page.entitlements.length,100);
    if(code)assert.equal(page.comparison_code,code);code=page.comparison_code;
    ids.push(...page.entitlements.map(e=>e.id));cursor=page.next_page_cursor??undefined;
  }while(cursor);
  assert.equal(ids.length,count);assert.equal(new Set(ids).size,count);
  assert.match(code,/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  const plan=f.sql.prepare(`EXPLAIN QUERY PLAN ${CONSENT_PAGE_SQL}`).all("owner",f.hash,"owner","owner","","");
  assert.ok(plan.some(row=>row.detail.includes("idx_entitlements_customer_project")),JSON.stringify(plan));
});

test("consent live keyset tolerates a deleted cursor row and rechecks later eligibility",async t=>{
  const f=await fixture(t),insert=seedPages(f,205);
  const first=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config);
  const tuple=JSON.parse(Buffer.from(first.entitlements.at(-1).id,"base64url").toString());
  f.sql.prepare("DELETE FROM entitlements WHERE feature=? AND license_fingerprint=?").run(tuple[1],tuple[2]);
  insert.run("0".repeat(64));insert.run((1005).toString(16).padStart(64,"0"));
  f.sql.prepare("UPDATE entitlements SET status='disabled' WHERE license_fingerprint=?").run((1010).toString(16).padStart(64,"0"));
  f.sql.prepare("UPDATE entitlements SET valid_until=1000 WHERE license_fingerprint=?").run((1020).toString(16).padStart(64,"0"));
  f.sql.prepare("UPDATE entitlements SET customer_id='other' WHERE license_fingerprint=?").run((1030).toString(16).padStart(64,"0"));
  const second=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config,first.next_page_cursor);
  const fingerprints=second.entitlements.map(e=>JSON.parse(Buffer.from(e.id,"base64url").toString())[2]);
  assert.equal(fingerprints[0],(1005).toString(16).padStart(64,"0"));
  for(const value of [0,1010,1020,1030])assert.ok(!fingerprints.includes(value.toString(16).padStart(64,"0")));
  assert.equal(JSON.parse(Buffer.from((await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config)).entitlements[0].id,"base64url").toString())[2],"0".repeat(64));
});

test("consent page cursors reject malformed encoding and foreign context",async t=>{
  const f=await fixture(t);seedPages(f,101);
  const first=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config);
  const tuple=JSON.parse(Buffer.from(first.next_page_cursor,"base64url").toString());
  const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
  for(const cursor of [null,"",17,"a".repeat(513),first.next_page_cursor+"=",encode(["ep2",...tuple.slice(1)]),encode([tuple[0],"0".repeat(64),...tuple.slice(2)]),encode([...tuple,"extra"]),Buffer.from(" "+JSON.stringify(tuple)).toString("base64url")]){
    await assert.rejects(inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config,cursor),error=>error.code==="invalid_request");
  }
  await assert.rejects(inspectBoundAuthorization(f.db,"other",f.input.attempt_handle,f.config,first.next_page_cursor),error=>error.code==="invalid_request");
  await assert.rejects(inspectBoundAuthorization(f.db,"owner",boundRandomId(32),f.config,first.next_page_cursor),error=>error.code==="invalid_request");
});

test("consent page authorization and empty-page status use one current database read",async t=>{
  const f=await fixture(t);seedPages(f,101);
  const first=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config);
  f.before(query=>{if(query===CONSENT_PAGE_SQL)f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");});
  await assert.rejects(inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config,first.next_page_cursor),error=>error.code==="access_denied");
  f.before(()=>{});f.sql.exec("UPDATE customers SET status='active' WHERE id='owner'");
  await approveBoundAuthorization(f.db,"owner",{...f.input,entitlement_id:first.entitlements[0].id},f.config,f.ring);
  const approved=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config,first.next_page_cursor);
  assert.equal(approved.status,"approved");assert.deepEqual(approved.entitlements,[]);assert.equal(approved.next_page_cursor,null);
  assert.equal(approved.comparison_code,first.comparison_code);
});

test("approval cleanup uses its partial index, exclusive deadline and bounded repeatable batches",async t=>{
  const f=await fixture(t);
  await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring);
  const before=f.sql.prepare("SELECT * FROM device_bound_authorizations").get();
  const db={prepare:query=>({async run(){return {meta:f.sql.prepare(query).run()};}})};
  f.clock(1059);await purgeExpiredBoundApprovals(db);
  assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_authorizations").get(),before);
  const queryPlan=f.sql.prepare(`EXPLAIN QUERY PLAN ${ERASE_EXPIRED_BOUND_APPROVALS_SQL}`).all();
  assert.ok(queryPlan.some(row=>row.detail.includes("idx_bound_approval_cleanup")));
  f.clock(1060);await purgeExpiredBoundApprovals(db);
  assert.deepEqual({...f.sql.prepare("SELECT * FROM device_bound_authorizations").get()},{...before,approval_ciphertext:null});
  await purgeExpiredBoundApprovals(db);
  assert.deepEqual({...f.sql.prepare("SELECT * FROM device_bound_authorizations").get()},{...before,approval_ciphertext:null});
  // Copy approved fixtures with distinct handles: cleanup may drain only 10000 per call.
  const columns=Object.keys(before),values=columns.map(column=>before[column]);
  const insert=f.sql.prepare(`INSERT INTO device_bound_authorizations(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`);
  for(let i=0;i<10001;i++){const row=[...values];row[columns.indexOf("handle_hash")]=i.toString(16).padStart(64,"0");insert.run(...row);}
  await purgeExpiredBoundApprovals(db);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_authorizations WHERE approval_ciphertext IS NOT NULL").get().n,1);
  await purgeExpiredBoundApprovals(db);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_authorizations WHERE approval_ciphertext IS NOT NULL").get().n,0);
  await assert.rejects(purgeExpiredBoundApprovals({prepare(){throw new Error("db unavailable");}}),/db unavailable/);
});

test("denial is atomic, terminal and recoverable after a lost response",async t=>{
  const f=await fixture(t),input={attempt_handle:f.input.attempt_handle,expected_attempt_revision:0,operation_id:f.input.operation_id};
  const before=f.sql.prepare("SELECT * FROM device_bound_authorizations").get();
  const batch=f.db.batch;
  f.db.batch=async statements=>{await batch(statements);throw new Error("lost response");};
  const response=await denyBoundAuthorization(f.db,"owner",input,f.config);
  assert.deepEqual(response,{status:"authorization_denied",revision:1});
  f.db.batch=batch;
  assert.deepEqual(await denyBoundAuthorization(f.db,"owner",input,f.config),response);
  assert.deepEqual({...f.sql.prepare("SELECT * FROM device_bound_authorizations").get()},{...before,status:"denied",revision:1});
  assert.equal(f.sql.prepare("SELECT count(*) n FROM mutation_idempotency").get().n,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_commit_checks").get().n,0);
  await assert.rejects(denyBoundAuthorization(f.db,"other",input,f.config),/revision_conflict/);
  await assert.rejects(denyBoundAuthorization(f.db,"owner",{...input,operation_id:boundRandomId(32)},f.config),/revision_conflict/);
  await assert.rejects(denyBoundAuthorization(f.db,"owner",{...input,expected_attempt_revision:1},f.config),/idempotency_conflict/);
  await assert.rejects(approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring));
  f.clock(1300);await assert.rejects(denyBoundAuthorization(f.db,"owner",input,f.config),/authorization_expired/);
});

test("denial rolls back its cache on failed transition and cannot overwrite approval",async t=>{
  const f=await fixture(t),input={attempt_handle:f.input.attempt_handle,expected_attempt_revision:0,operation_id:f.input.operation_id};
  f.before(query=>{if(query.startsWith("UPDATE device_bound_authorizations SET status='denied'"))throw new Error("write failed");});
  await assert.rejects(denyBoundAuthorization(f.db,"owner",input,f.config),/temporarily_unavailable/);
  assert.equal(f.sql.prepare("SELECT status FROM device_bound_authorizations").get().status,"pending");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM mutation_idempotency").get().n,0);
  f.before(()=>{});
  await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring);
  await assert.rejects(denyBoundAuthorization(f.db,"owner",input,f.config),/revision_conflict/);
  assert.equal(f.sql.prepare("SELECT status FROM device_bound_authorizations").get().status,"approved");
});

test("concurrent approval and denial choose one terminal result; disabled customers cannot cancel",async t=>{
  const f=await fixture(t),input={attempt_handle:f.input.attempt_handle,expected_attempt_revision:0,operation_id:f.input.operation_id};
  const results=await Promise.allSettled([approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),denyBoundAuthorization(f.db,"owner",input,f.config)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const row=f.sql.prepare("SELECT * FROM device_bound_authorizations").get();
  assert.equal(row.revision,1);assert.ok(["approved","denied"].includes(row.status));
  const other=await fixture(t),otherInput={attempt_handle:other.input.attempt_handle,expected_attempt_revision:0,operation_id:other.input.operation_id};
  other.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");
  await assert.rejects(denyBoundAuthorization(other.db,"owner",otherInput,other.config),/access_denied/);
  assert.equal(other.sql.prepare("SELECT status FROM device_bound_authorizations").get().status,"pending");
});

test("denial final guard rolls back a staged retry record when the deadline crosses",async t=>{
  for (const boundary of ["UPDATE device_bound_authorizations SET status='denied'","INSERT INTO device_bound_commit_checks"]) {
  const f=await fixture(t),input={attempt_handle:f.input.attempt_handle,expected_attempt_revision:0,operation_id:f.input.operation_id};
  f.before(query=>{if(query.startsWith(boundary))f.clock(1300);});
  await assert.rejects(denyBoundAuthorization(f.db,"owner",input,f.config),/temporarily_unavailable/);
  assert.equal(f.sql.prepare("SELECT status FROM device_bound_authorizations").get().status,"pending");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM mutation_idempotency").get().n,0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_commit_checks").get().n,0);
  }
});

test("customer disable after denial pre-read remains committed and prevents cancellation",async t=>{
  const f=await fixture(t),input={attempt_handle:f.input.attempt_handle,expected_attempt_revision:0,operation_id:f.input.operation_id};
  const batch=f.db.batch;
  f.db.batch=async statements=>{f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");return batch(statements);};
  await assert.rejects(denyBoundAuthorization(f.db,"owner",input,f.config),/temporarily_unavailable/);
  assert.equal(f.sql.prepare("SELECT status FROM customers WHERE id='owner'").get().status,"disabled");
  assert.equal(f.sql.prepare("SELECT status FROM device_bound_authorizations").get().status,"pending");
  assert.equal(f.sql.prepare("SELECT count(*) n FROM mutation_idempotency").get().n,0);
});

test("consent inspection exposes safe owned choices and approval persists only encrypted callback recovery",async t=>{
  const f=await fixture(t);
  const inspection=await inspectBoundAuthorization(f.db,"owner",f.input.attempt_handle,f.config);
  assert.deepEqual(inspection.app,{name:"Example app",project:"APP"});
  assert.equal(inspection.entitlements.length,1);
  assert.equal(JSON.stringify(inspection).includes("pinned-spki"),false);
  assert.equal((await inspectBoundAuthorization(f.db,"other",f.input.attempt_handle,f.config)).entitlements.length,0);
  const response=await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring);
  const callback=new URL(response.callback_url),code=callback.searchParams.get("code");
  assert.equal(callback.origin,"http://127.0.0.1:45678");assert.equal(callback.searchParams.get("state"),"A".repeat(43));
  assert.equal(response.expires_at,1060);assert.equal(response.revision,1);
  const row=f.sql.prepare("SELECT * FROM device_bound_authorizations").get();
  assert.equal(row.code_hash,await boundSecretHash(code));assert.equal(JSON.stringify(row).includes(code),false);
  assert.equal(row.status,"approved");assert.equal(row.customer_id,"owner");
  assert.deepEqual(await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),response);
  await assert.rejects(approveBoundAuthorization(f.db,"other",f.input,f.config,f.ring),/access_denied/);
  await assert.rejects(approveBoundAuthorization(f.db,"owner",{...f.input,operation_id:boundRandomId(32)},f.config,f.ring),/idempotency_conflict/);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_operations").get().n,0);
});

test("concurrent same-operation approvals recover one winning callback and different operations conflict",async t=>{
  const f=await fixture(t);
  const responses=await Promise.all([approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring)]);
  assert.deepEqual(responses[0],responses[1]);
  assert.equal(f.sql.prepare("SELECT revision FROM device_bound_authorizations").get().revision,1);
  const other=await fixture(t);
  const competing=await Promise.allSettled([approveBoundAuthorization(other.db,"owner",other.input,other.config,other.ring),approveBoundAuthorization(other.db,"owner",{...other.input,operation_id:boundRandomId(32)},other.config,other.ring)]);
  assert.equal(competing.filter(r=>r.status==="fulfilled").length,1);
  assert.match(competing.find(r=>r.status==="rejected").reason.message,/idempotency_conflict/);
});

test("approval final update rejects ownership, status, revision and expiry races",async t=>{
  for(const mutation of ["UPDATE customers SET status='disabled' WHERE id='owner'","UPDATE entitlements SET customer_id='other'","UPDATE entitlements SET status='disabled'","UPDATE entitlements SET valid_until=1000"]) {
    const f=await fixture(t);let injected=false;
    f.before(query=>{if(!injected&&query.startsWith("UPDATE device_bound_authorizations")){injected=true;f.sql.exec(mutation);}});
    await assert.rejects(approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring));
    assert.equal(f.sql.prepare("SELECT status FROM device_bound_authorizations").get().status,"pending");
  }
  const f=await fixture(t);
  f.before(query=>{if(query.startsWith("UPDATE device_bound_authorizations"))f.clock(1060);});
  await assert.rejects(approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring));
  assert.equal(f.sql.prepare("SELECT code_hash FROM device_bound_authorizations").get().code_hash,null);
});

test("approval recovery expires exclusively and current authority still controls access",async t=>{
  const f=await fixture(t);f.clock(1290);
  const response=await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring);
  assert.equal(response.expires_at,1300);
  f.clock(1299);assert.deepEqual(await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),response);
  f.clock(1300);await assert.rejects(approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),/authorization_expired/);
  const other=await fixture(t);await approveBoundAuthorization(other.db,"owner",other.input,other.config,other.ring);
  other.sql.exec("UPDATE entitlements SET customer_id='other'");
  await assert.rejects(approveBoundAuthorization(other.db,"owner",other.input,other.config,other.ring),/access_denied/);
});

test("approval recovery has a final admission point after decryption",async t=>{
  for(const change of ["expire","consume","disable","replace"]) {
    const f=await fixture(t);await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring);
    f.before(query=>{
      if(!query.startsWith("SELECT 1 AS eligible FROM device_bound_authorizations"))return;
      if(change==="expire")f.clock(1060);
      if(change==="disable")f.sql.exec("UPDATE customers SET status='disabled' WHERE id='owner'");
      if(change==="consume")f.sql.exec("UPDATE device_bound_authorizations SET status='consumed',revision=revision+1,consumed_invocation_id='invocation',consumed_operation_id='operation',recovery_until=2000,approval_ciphertext=NULL");
      if(change==="replace")f.sql.exec("UPDATE device_bound_authorizations SET approval_ciphertext='replaced-ciphertext'");
    });
    await assert.rejects(approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),/access_denied/);
  }
});

test("lost approval response recovers the committed callback without code or revision churn",async t=>{
  const f=await fixture(t),prepare=f.db.prepare;
  f.db.prepare=query=>{
    const statement=prepare(query);
    if(query.startsWith("UPDATE device_bound_authorizations")) {
      const bind=statement.bind.bind(statement);
      statement.bind=(...params)=>{const bound=bind(...params),first=bound.first.bind(bound);bound.first=async()=>{await first();throw new Error("simulated lost response");};return bound;};
    }
    return statement;
  };
  await assert.rejects(approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),/simulated lost response/);
  const before=f.sql.prepare("SELECT * FROM device_bound_authorizations").get();
  const expected=await openBoundApproval(before.approval_ciphertext,before.handle_hash,before.revision,f.ring);
  f.db.prepare=prepare;
  assert.deepEqual(await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring),expected.response);
  assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_authorizations").get(),before);
  await assert.rejects(approveBoundAuthorization(f.db,"owner",{...f.input,expected_attempt_revision:1},f.config,f.ring),/idempotency_conflict/);
  const changedId=Buffer.from(JSON.stringify(["APP","OTHER","a".repeat(64)])).toString("base64url");
  await assert.rejects(approveBoundAuthorization(f.db,"owner",{...f.input,entitlement_id:changedId},f.config,f.ring),/idempotency_conflict/);
});


test("requested feature constrains consent, approval, recovery and immutable intent", async t => {
  const f = await fixture(t, "DEFAULT");
  f.sql.exec(`INSERT INTO entitlements(project,feature,license_fingerprint,customer_id,status,enforcement_mode,created_at,updated_at)
    VALUES('APP','EXPORT','${"c".repeat(64)}','owner','active','device_bound_v1',1000,1000)`);
  const page = await inspectBoundAuthorization(f.db, "owner", f.input.attempt_handle, f.config);
  assert.deepEqual(page.entitlements.map(row => row.feature), ["DEFAULT"]);
  const otherId = Buffer.from(JSON.stringify(["APP", "EXPORT", "c".repeat(64)])).toString("base64url");
  await assert.rejects(approveBoundAuthorization(f.db,"owner",{...f.input,entitlement_id:otherId},f.config,f.ring), /access_denied/);
  assert.throws(() => f.sql.exec("UPDATE device_bound_authorizations SET requested_feature='EXPORT'"), /authorization_intent_immutable/);
  const approved = await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring);
  assert.deepEqual(await approveBoundAuthorization(f.db,"owner",f.input,f.config,f.ring), approved);
  await assert.rejects(approveBoundAuthorization(f.db,"owner",{...f.input,entitlement_id:otherId},f.config,f.ring), /access_denied/);
});
