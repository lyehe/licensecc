import assert from "node:assert/strict";
import { boundRandomId, boundSecretHash, createBoundChallenge } from "../../src/device/bound_enrollment.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BOUND_LEASE_COMMIT_SQL, commitBoundDeviceLease } from "../../src/device/bound_store.mjs";
import { BOUND_RECOVERY_SQL, recoverBoundDeviceLease } from "../../src/device/bound_recovery.mjs";
import { EXPIRE_BOUND_RECOVERY_SQL } from "../../src/device/bound_cleanup.mjs";
import { SEAT_CHECKOUT_ATOMIC_SQL, seatCheckoutSqlOwned, seatHeartbeatSql } from "../../src/lease/issuance_sql.mjs";

const fp = "a".repeat(64);
function fixture() {
  const sql = new DatabaseSync(":memory:");
  let now = 1000;
  let beforeStatement = () => {};
  sql.function("unixepoch", () => now);
  sql.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith(".sql")).sort()) sql.exec(readFileSync(new URL(name, dir), "utf8"));
  sql.exec(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('customer','Customer',1000,1000);
    INSERT INTO entitlements(project,feature,license_fingerprint,status,created_at,updated_at,customer_id,enforcement_mode,max_active_devices)
    VALUES('APP','DEFAULT','${fp}','active',1000,1000,'customer','device_bound_v1',1);`);
  class Statement {
    constructor(query, params=[]) { this.query=query; this.params=params; }
    bind(...params) { return new Statement(this.query,params); }
    async first() { return sql.prepare(this.query).get(...this.params) ?? null; }
    async all() { return {results:sql.prepare(this.query).all(...this.params)}; }
  }
  const db = {prepare: query => new Statement(query), async batch(statements) {
    sql.exec("BEGIN IMMEDIATE");
    try { const results=[]; for (const s of statements) { beforeStatement(s.query); results.push({results:sql.prepare(s.query).all(...s.params)}); } sql.exec("COMMIT"); return results; }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  }};
  return {sql,db,clock(value){now=value;},beforeStatement(callback){beforeStatement=callback;}};
}

test("challenge issuance honors exclusive deadlines and consumed-operation recovery", async t => {
  const f=fixture(); t.after(()=>f.sql.close());
  const handle=boundRandomId(32),operation=boundRandomId(32);
  const c={...candidate(),subjectId:await boundSecretHash(handle),operationId:operation,bindingId:boundRandomId()};
  c.responseJson=JSON.stringify({ok:true,code:"device_activated",request_id:operation,data:{binding_id:c.bindingId,lease:c.token,expires_at:c.expiresAt}});
  seed(f,c);
  const input={purpose:"exchange",attempt_handle:handle,operation_id:operation};
  f.clock(1100);
  await assert.rejects(createBoundChallenge(f.db,input),/authorization_unavailable/);
  f.clock(1000);
  await commitBoundDeviceLease(f.db,c);
  f.clock(1300); // Both original authorization and approval code have expired.
  const recovered=await createBoundChallenge(f.db,input);
  assert.equal(recovered.expires_at,1360);
  const renew={purpose:"renew",binding_id:c.bindingId,operation_id:boundRandomId(32)};
  assert.equal((await createBoundChallenge(f.db,renew)).expires_at,1360);
  f.clock(173790); // Complete operation is retained until 1000 + 172800.
  assert.equal((await createBoundChallenge(f.db,input)).expires_at,173800);
  f.clock(173800);
  await assert.rejects(createBoundChallenge(f.db,input),/authorization_unavailable/);
  f.sql.prepare("UPDATE device_bound_devices SET status='disabled' WHERE id=?").run(c.deviceId);
  await assert.rejects(createBoundChallenge(f.db,renew),/binding_unavailable/);
});

test("pending challenge lifetime is clamped to the authorization deadline", async t => {
  const f=fixture(); t.after(()=>f.sql.close());
  const handle=boundRandomId(32),hash=await boundSecretHash(handle);
  f.sql.prepare(`INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,created_at,expires_at)
    VALUES(?,'desktop','APP','key','spki','http://127.0.0.1:1234/callback','state','pkce',1000,1300)`).run(hash);
  const input={purpose:"exchange",attempt_handle:handle,operation_id:boundRandomId(32)};
  f.clock(1299);
  assert.equal((await createBoundChallenge(f.db,input)).expires_at,1300);
  f.clock(1300);
  await assert.rejects(createBoundChallenge(f.db,input),/authorization_unavailable/);
});

test("consumed challenge admission rejects missing, incomplete or unrelated operation records", async t => {
  for (const fault of ["missing","prepared","invocation"]) {
    const f=fixture(); t.after(()=>f.sql.close());
    const handle=boundRandomId(32),operation=boundRandomId(32);
    const c={...candidate(),subjectId:await boundSecretHash(handle),operationId:operation};
    seed(f,c);
    await commitBoundDeviceLease(f.db,c);
    // Simulate missing/restored-corrupt recovery material, not a supported
    // transition. Delete/reinsert does not weaken production immutability.
    const saved=f.sql.prepare("SELECT * FROM device_bound_operations").get();
    f.sql.exec("DROP TRIGGER tr_bound_operation_tombstone; DELETE FROM device_bound_operations");
    if (fault!=="missing") {
      if (fault==="prepared") saved.status="prepared";
      if (fault==="invocation") saved.invocation_id="unrelated-invocation";
      const columns=Object.keys(saved);
      f.sql.prepare(`INSERT INTO device_bound_operations(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`).run(...Object.values(saved));
    }
    await assert.rejects(createBoundChallenge(f.db,{purpose:"exchange",attempt_handle:handle,operation_id:operation}),/authorization_unavailable/);
  }
});

test("renewal challenges reject current inactive or unsupported authority", async t => {
  for (const mutation of ["UPDATE customers SET status='disabled'", "UPDATE entitlements SET status='disabled'", "UPDATE entitlements SET is_trial=1", "UPDATE entitlements SET pool_size=1", "UPDATE entitlements SET valid_until=1000", "UPDATE entitlements SET valid_from=1001"]) {
    const f=fixture(); t.after(()=>f.sql.close());
    const c={...candidate(),bindingId:boundRandomId()};
    c.responseJson=JSON.stringify({ok:true,code:"device_activated",request_id:c.operationId,data:{binding_id:c.bindingId,lease:c.token,expires_at:c.expiresAt}});
    seed(f,c); await commitBoundDeviceLease(f.db,c);
    f.sql.exec(mutation);
    await assert.rejects(createBoundChallenge(f.db,{purpose:"renew",binding_id:c.bindingId,operation_id:boundRandomId(32)}),/binding_unavailable/);
  }
});

function candidate(label="one") {
  const c = {keyId:`sha256:${label.padEnd(64,"a").slice(0,64)}`,purpose:"exchange",operationId:`op-${label}`,
    requestDigest:`digest-${label}`,customerId:"customer",customerRevision:0,project:"APP",feature:"DEFAULT",fingerprint:fp,
    entitlementRevision:0,trialStamp:0,deviceId:`device-${label}`,deviceRevision:0,publicKeySpki:`spki-${label}`,deviceLabel:"Workstation",
    bindingId:`binding-${label}`,bindingRevision:0,generation:1,leaseId:`lease-${label}`,issuedAt:1000,expiresAt:2000,
    acceptUntil:2120,token:`signed-token-${label}`,responseJson:JSON.stringify({ok:true,token:`signed-token-${label}`}),
    challengeId:`challenge-${label}`,challengeExpiresAt:1060,nonceHash:`nonce-${label}`,subjectId:`attempt-${label}`,attemptRevision:0,
    codeHash:`code-${label}`,pkceChallenge:`pkce-${label}`,redirectUri:"http://127.0.0.1:1234/callback"};
  c.responseJson=JSON.stringify({ok:true,code:"device_activated",request_id:c.operationId,data:{binding_id:c.bindingId,lease:c.token,expires_at:c.expiresAt}});
  return c;
}

test("erased recovery payloads remain denied after the database clock moves backward",async t=>{
  const f=fixture();t.after(()=>f.sql.close());const c=candidate();seed(f,c);
  await commitBoundDeviceLease(f.db,c);
  const before=f.sql.prepare('SELECT * FROM device_bound_bindings').get();
  f.clock(173800);f.sql.exec(EXPIRE_BOUND_RECOVERY_SQL[0]);
  assert.equal(f.sql.prepare('SELECT response_json FROM device_bound_operations').get().response_json,'');
  f.clock(1000);
  const retry={...c,challengeId:'post-cleanup',nonceHash:'new-nonce'};challenge(f,retry);
  await assert.rejects(recoverBoundDeviceLease(f.db,retry),/CHECK/);
  assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id='post-cleanup'").get().consumed_invocation_id,null);
  assert.deepEqual(f.sql.prepare('SELECT * FROM device_bound_bindings').get(),before);
});
function seed(f,c) {
  f.sql.prepare(`INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,
    redirect_uri,client_state,pkce_challenge,status,customer_id,feature,license_fingerprint,code_hash,code_expires_at,created_at,expires_at)
    VALUES(?,'desktop',?,?,?,?,?,?, 'approved',?,?,?,?,1100,1000,1300)`)
    .run(c.subjectId,c.project,c.keyId,c.publicKeySpki,c.redirectUri,"state",c.pkceChallenge,c.customerId,c.feature,c.fingerprint,c.codeHash);
  challenge(f,c);
}
function challenge(f,c) {
  f.sql.prepare(`INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at)
    VALUES(?,?,?,?,?,?,1000,1060)`).run(c.challengeId,c.purpose,c.subjectId,c.keyId,c.operationId,c.nonceHash);
}
function count(f,table) { return f.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }
function emptyCommit(f) {
  for (const table of ["device_bound_devices","device_bound_bindings","device_bound_operations","device_bound_leases","device_bound_events","device_bound_commit_checks"]) assert.equal(count(f,table),0,table);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_challenges WHERE consumed_invocation_id IS NOT NULL").get().n,0);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM device_bound_authorizations WHERE status='consumed'").get().n,0);
}

test("trial first exchange stamps commit time and key exactly once across competing candidates", async t => {
  for (const basis of ["from_issue","from_first_activation","from_first_use"]) {
    for (const locked of [0,1]) {
      const f=fixture(); t.after(()=>f.sql.close());
      f.sql.prepare(`UPDATE entitlements SET is_trial=1,trial_expiration_basis=?,trial_duration_sec=1200,
        trial_one_per_device=?,valid_until=2200,max_active_devices=2`).run(basis,locked);
      const make=label=>({...candidate(label),trialStamp:1,entitlementRevision:1});
      const a=make("a"),b=make("b"); seed(f,a); seed(f,b);
      f.clock(1010); // Signing preceded the actual commit; start uses DB time.
      const outcomes=await Promise.allSettled([commitBoundDeviceLease(f.db,a),commitBoundDeviceLease(f.db,b)]);
      assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
      const state=()=>f.sql.prepare("SELECT trial_started_at,trial_device_hash,authority_revision FROM entitlements").get();
      assert.deepEqual({...state()},{trial_started_at:1010,trial_device_hash:a.keyId,authority_revision:2});
      assert.equal(f.sql.prepare("SELECT entitlement_revision FROM device_bound_leases").get().entitlement_revision,2);
      const retry={...b,trialStamp:0,entitlementRevision:2};
      if (locked) await assert.rejects(commitBoundDeviceLease(f.db,retry),/CHECK/);
      else await commitBoundDeviceLease(f.db,retry);
      assert.deepEqual({...state()},{trial_started_at:1010,trial_device_hash:a.keyId,authority_revision:2});
      assert.equal(count(f,'device_bound_leases'),locked?1:2);
      const sameKey={...candidate('c'),trialStamp:0,entitlementRevision:2,
        keyId:a.keyId,deviceId:a.deviceId,publicKeySpki:a.publicKeySpki,
        bindingId:a.bindingId,bindingRevision:1};
      sameKey.responseJson=JSON.stringify({ok:true,code:'device_activated',request_id:sameKey.operationId,
        data:{binding_id:sameKey.bindingId,lease:sameKey.token,expires_at:sameKey.expiresAt}});
      seed(f,sameKey); f.clock(1020);
      await commitBoundDeviceLease(f.db,sameKey);
      assert.deepEqual({...state()},{trial_started_at:1010,trial_device_hash:a.keyId,authority_revision:2});
      assert.equal(count(f,'device_bound_bindings'),locked?1:2);
    }
  }
});

test("trial stamp omission, excessive expiry and revision overflow roll back without starting the clock", async t => {
  for (const fault of ['omit','expiry','revision','stamp-flag']) {
    const f=fixture(); t.after(()=>f.sql.close());
    f.sql.exec("UPDATE entitlements SET is_trial=1,trial_expiration_basis='from_first_activation',trial_duration_sec=1000");
    const c={...candidate('a'),trialStamp:1,entitlementRevision:1}; seed(f,c);
    if (fault==='revision') {
      f.sql.exec('UPDATE entitlements SET authority_revision=9007199254740991');
      c.entitlementRevision=Number.MAX_SAFE_INTEGER;
    }
    if (fault==='expiry') f.sql.exec('UPDATE entitlements SET trial_duration_sec=999');
    if (fault==='expiry') c.entitlementRevision=2;
    if (fault==='stamp-flag') c.trialStamp=0;
    if (fault==='omit') {
      const encoded=JSON.stringify({...c,invocationId:'omitted-trial-stamp'});
      await assert.rejects(f.db.batch(BOUND_LEASE_COMMIT_SQL.filter((_,i)=>i!==1).map(q=>f.db.prepare(q).bind(encoded))),/CHECK/);
    } else await assert.rejects(commitBoundDeviceLease(f.db,c),/CHECK/);
    emptyCommit(f);
    const row=f.sql.prepare('SELECT trial_started_at,trial_device_hash,authority_revision FROM entitlements').get();
    assert.equal(row.trial_started_at,null); assert.equal(row.trial_device_hash,null);
    assert.equal(row.authority_revision,c.entitlementRevision);
  }
});

test("two stale candidates cannot both acquire the last persistent slot", async () => {
  const f=fixture(), a=candidate("one"), b=candidate("two"); seed(f,a); seed(f,b);
  const outcomes = await Promise.allSettled([commitBoundDeviceLease(f.db,a),commitBoundDeviceLease(f.db,b)]);
  assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
  for (const table of ["device_bound_devices","device_bound_bindings","device_bound_operations","device_bound_leases","device_bound_events"]) assert.equal(count(f,table),1,table);
  assert.equal(count(f,"device_bound_commit_checks"),0);
  assert.equal(f.sql.prepare("SELECT hold_until FROM device_bound_bindings").get().hold_until,2120);
});

test("every omitted dependent statement fails the final assertion and rolls the entire batch back", async () => {
  // Omit each required mutation from device creation through finalization.
  // Updating last_proof_at is redundant for a just-created device at this time;
  // its mandatory renewal update is covered separately with an advanced clock.
  for (const omit of [2,3,4,5,6,8,9,10]) {
    const f=fixture(), c=candidate(); seed(f,c);
    const encoded=JSON.stringify({...c,invocationId:`invocation-${omit}`});
    const statements=BOUND_LEASE_COMMIT_SQL.filter((_,i)=>i!==omit).map(q=>f.db.prepare(q).bind(encoded));
    await assert.rejects(f.db.batch(statements),`omitted statement ${omit}`);
    emptyCommit(f);
  }
});

test("expired or changed authorization leaves no signed result or consumed proof", async () => {
  for (const patch of ["challenge","code","attempt","entitlement","customer","revision","token"]) {
    const f=fixture(),c=candidate(); seed(f,c);
    if (patch==="challenge") f.clock(1060);
    if (patch==="code") f.sql.exec("DROP TRIGGER tr_bound_attempt_approval_immutable; UPDATE device_bound_authorizations SET code_expires_at=1000");
    if (patch==="attempt") { f.sql.exec("DROP TRIGGER tr_bound_attempt_intent_immutable; DROP TRIGGER tr_bound_attempt_approval_immutable; UPDATE device_bound_authorizations SET expires_at=1001,code_expires_at=1001"); f.clock(1001); }
    if (patch==="entitlement") f.sql.exec("UPDATE entitlements SET valid_until=1000");
    if (patch==="customer") f.sql.exec("UPDATE customers SET status='disabled'; UPDATE customers SET status='active'");
    if (patch==="revision") f.sql.exec("UPDATE entitlements SET max_active_devices=2");
    if (patch==="token") {
      c.expiresAt=1000; c.acceptUntil=1120;
      const response=JSON.parse(c.responseJson); response.data.expires_at=c.expiresAt;
      c.responseJson=JSON.stringify(response);
    }
    await assert.rejects(commitBoundDeviceLease(f.db,c),/CHECK/,patch); emptyCommit(f);
  }
});

test("renewal extends one binding, retirement retains its maximum, and cleanup cannot erase it", async () => {
  const f=fixture(),c=candidate(); seed(f,c); await commitBoundDeviceLease(f.db,c);
  const renewal={...c,purpose:"renew",operationId:"renew-one",requestDigest:"renew-digest",challengeId:"renew-challenge",nonceHash:"renew-nonce",
    subjectId:c.bindingId,bindingRevision:1,leaseId:"renew-lease",expiresAt:3000,acceptUntil:3120,token:"renew-token",responseJson:'{"ok":true,"code":"device_renewed","request_id":"renew-one","data":{"binding_id":"binding-one","lease":"renew-token","expires_at":3000}}'};
  challenge(f,renewal); await commitBoundDeviceLease(f.db,renewal);
  assert.equal(count(f,"device_bound_bindings"),1);
  assert.equal(f.sql.prepare("SELECT hold_until FROM device_bound_bindings").get().hold_until,3120);
  f.sql.exec("UPDATE device_bound_devices SET status='disabled'");
  const row=f.sql.prepare("SELECT * FROM device_bound_bindings").get();
  assert.equal(row.state,"retiring"); assert.equal(row.generation,2); assert.equal(row.hold_until,3120);
  f.sql.exec("DELETE FROM device_bound_leases; DELETE FROM device_bound_events");
  assert.throws(()=>f.sql.exec("DELETE FROM device_bound_bindings"),/tombstone/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_bindings SET hold_until=0"),/cannot_shrink/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_bindings SET state='released'"),/hold_active/);
  assert.throws(()=>f.sql.exec("UPDATE entitlements SET max_active_devices=0"),/capacity_in_use/);
  f.clock(3120); f.sql.exec("UPDATE device_bound_bindings SET state='released'; UPDATE entitlements SET max_active_devices=0");
});

test("schema refuses fractional authority, null identities, identity rewrites and legacy revival", async () => {
  const f=fixture(),c=candidate(); seed(f,c); await commitBoundDeviceLease(f.db,c);
  assert.throws(()=>f.sql.exec("UPDATE entitlements SET authority_revision=1.5"),/CHECK/);
  assert.throws(()=>f.sql.exec("UPDATE customers SET authority_revision=1.5"),/CHECK/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_devices SET id='different'"),/immutable/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_bindings SET id='different'"),/immutable/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_bindings SET generation=1.5"),/CHECK/);
  assert.throws(()=>f.sql.exec("INSERT INTO device_bound_commit_checks(invocation_id,ok) VALUES(NULL,1)"),/NOT NULL/);
  assert.throws(()=>f.sql.exec("UPDATE entitlements SET enforcement_mode='legacy'"),/downgrade/);
  assert.throws(()=>f.sql.prepare("INSERT INTO entitlement_devices(project,feature,license_fingerprint,device_key_id,public_key_spki_der_base64,status,created_at,updated_at) VALUES('APP','DEFAULT',?,'key','spki','active',1000,1000)").run(fp),/legacy_protocol_disabled/);
});

test("fresh authenticated recovery works after code expiry without changing a lease or hold", async () => {
  const f=fixture(),c=candidate(); seed(f,c); const first=await commitBoundDeviceLease(f.db,c);
  const before=f.sql.prepare("SELECT * FROM device_bound_bindings").get();
  f.clock(1400); // Original attempt, code and challenge have expired.
  const recovery={...c,challengeId:"recovery-challenge",nonceHash:"recovery-nonce",challengeExpiresAt:1460};
  f.sql.prepare(`INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at)
    VALUES(?,'exchange',?,?,?,?,1400,1460)`).run(recovery.challengeId,recovery.subjectId,recovery.keyId,recovery.operationId,recovery.nonceHash);
  const recovered=await recoverBoundDeviceLease(f.db,recovery);
  assert.deepEqual(recovered.response,first.response);
  assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_bindings").get(),before);
  assert.equal(count(f,"device_bound_leases"),1); assert.equal(count(f,"device_bound_events"),1);
  assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id=?").get(recovery.challengeId).consumed_invocation_id,recovered.invocationId);
  await assert.rejects(recoverBoundDeviceLease(f.db,recovery),/CHECK/);
});

test("result recovery rejects changed intent and retired authority without consuming its fresh challenge", async () => {
  for (const mode of ["digest","retired","owner","pool"]) {
    const f=fixture(),c=candidate(); seed(f,c); await commitBoundDeviceLease(f.db,c);
    const r={...c,challengeId:"recover",nonceHash:"recover-nonce"}; challenge(f,r);
    if (mode==="digest") r.requestDigest="different";
    if (mode==="retired") f.sql.exec("UPDATE device_bound_devices SET status='disabled'");
    if (mode==="owner") f.sql.exec("UPDATE customers SET status='disabled'; UPDATE customers SET status='active'");
    if (mode==="pool") {
      f.sql.exec("UPDATE entitlements SET pool_size=1");
      r.entitlementRevision=f.sql.prepare("SELECT authority_revision FROM entitlements").get().authority_revision;
    }
    await assert.rejects(recoverBoundDeviceLease(f.db,r),/CHECK/);
    assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id='recover'").get().consumed_invocation_id,null);
    assert.equal(count(f,"device_bound_leases"),1);
  }
});

test("invalid response and stale operation collisions never commit a new allocation", async () => {
  const f=fixture(),c=candidate(); seed(f,c);
  await assert.rejects(commitBoundDeviceLease(f.db,{...c,responseJson:"{"})); emptyCommit(f);
  await assert.rejects(commitBoundDeviceLease(f.db,{...c,responseJson:'{"ok":true}'})); emptyCommit(f);
  await commitBoundDeviceLease(f.db,c);
  await assert.rejects(commitBoundDeviceLease(f.db,c));
  await assert.rejects(commitBoundDeviceLease(f.db,{...c,requestDigest:"changed"}));
  assert.equal(count(f,"device_bound_bindings"),1); assert.equal(count(f,"device_bound_leases"),1);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_operations SET status='prepared'"),/immutable/);
});

test("authorization records require coherent states and preserve consumed recovery identity", async () => {
  const f=fixture(),c=candidate(); seed(f,c);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_authorizations SET status='consumed'"),/CHECK/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_authorizations SET consumed_operation_id='premature'"),/CHECK/);
  assert.throws(()=>f.sql.exec("INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,status,created_at,expires_at) VALUES('incomplete','desktop','APP','key','spki','redirect','state','pkce','approved',1000,1300)"),/CHECK/);
  await commitBoundDeviceLease(f.db,c);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_authorizations SET consumed_operation_id='replacement'"),/immutable/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_authorizations SET recovery_until=recovery_until+1"),/immutable/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_authorizations SET approval_ciphertext='restored-secret'"),/CHECK/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_authorizations SET revision=0"),/cannot_shrink/);
});

test("retirement revisions cannot be reset and trial authority changes invalidate stale candidates", async () => {
  const f=fixture(),c=candidate(); seed(f,c); await commitBoundDeviceLease(f.db,c);
  f.sql.exec("UPDATE device_bound_devices SET status='disabled'");
  assert.throws(()=>f.sql.exec("UPDATE device_bound_devices SET revision=0"),/cannot_shrink/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_bindings SET generation=1"),/cannot_shrink/);
  assert.throws(()=>f.sql.exec("UPDATE device_bound_bindings SET revision=0"),/cannot_shrink/);
  for (const field of ["trial_one_per_device","trial_require_device_proof","trial_device_hash"]) {
    const before=f.sql.prepare("SELECT authority_revision FROM entitlements").get().authority_revision;
    f.sql.exec(`UPDATE entitlements SET ${field}=${field==='trial_device_hash' ? "'device-hash'" : '1'}`);
    assert.equal(f.sql.prepare("SELECT authority_revision FROM entitlements").get().authority_revision,before+1);
  }
});

test("renewal cannot commit if its verified-contact write is omitted", async () => {
  const f=fixture(),c=candidate(); seed(f,c); await commitBoundDeviceLease(f.db,c);
  const before=f.sql.prepare("SELECT * FROM device_bound_bindings").get();
  f.clock(1020);
  const renewal={...c,purpose:"renew",operationId:"renew-omitted-contact",requestDigest:"renew-digest",
    challengeId:"renew-proof",nonceHash:"renew-nonce",subjectId:c.bindingId,bindingRevision:1,
    leaseId:"new-lease",issuedAt:1020,expiresAt:3000,acceptUntil:3120,token:"new-token",invocationId:"omitted-contact"};
  renewal.responseJson=JSON.stringify({ok:true,code:"device_renewed",request_id:renewal.operationId,
    data:{binding_id:renewal.bindingId,lease:renewal.token,expires_at:renewal.expiresAt}});
  challenge(f,renewal);
  const encoded=JSON.stringify(renewal);
  await assert.rejects(f.db.batch(BOUND_LEASE_COMMIT_SQL.filter((_,i)=>i!==7).map(q=>f.db.prepare(q).bind(encoded))),/CHECK/);
  assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_bindings").get(),before);
  assert.equal(count(f,"device_bound_operations"),1);
  assert.equal(count(f,"device_bound_leases"),1);
  assert.equal(count(f,"device_bound_events"),1);
  assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id='renew-proof'").get().consumed_invocation_id,null);
  await commitBoundDeviceLease(f.db,renewal);
  assert.equal(f.sql.prepare("SELECT last_proof_at FROM device_bound_devices").get().last_proof_at,1020);
});

test("empty or pruned legacy issuance history never authorizes automatic protected conversion", () => {
  const f=fixture();
  f.sql.exec("INSERT INTO entitlements(project,feature,license_fingerprint,status,created_at,updated_at,customer_id) VALUES('OLD','DEFAULT','legacy','active',1000,1000,'customer')");
  const convert=()=>f.sql.exec("UPDATE entitlements SET enforcement_mode='device_bound_v1' WHERE project='OLD'");
  assert.throws(convert,/protected_mode_migration_required/);
  f.sql.exec("INSERT INTO lease_issuance(project,feature,license_fingerprint,device_key_id,lease_key_id,issued_at,valid_from,valid_to) VALUES('OLD','DEFAULT','legacy','key','signer',1,1,999999); DELETE FROM lease_issuance WHERE project='OLD'");
  assert.throws(convert,/protected_mode_migration_required/);
  assert.equal(f.sql.prepare("SELECT enforcement_mode FROM entitlements WHERE project='OLD'").get().enforcement_mode,'legacy');
});

test("renewal recovery returns the original result and rejects at the retention deadline", async () => {
  const f=fixture(),c=candidate(); seed(f,c); await commitBoundDeviceLease(f.db,c);
  const renewal={...c,purpose:"renew",operationId:"renew-retention",requestDigest:"renew-digest",
    challengeId:"renew-proof",nonceHash:"renew-nonce",subjectId:c.bindingId,bindingRevision:1,
    leaseId:"new-lease",expiresAt:3000,acceptUntil:3120,token:"new-token"};
  renewal.responseJson=JSON.stringify({ok:true,code:"device_renewed",request_id:renewal.operationId,
    data:{binding_id:renewal.bindingId,lease:renewal.token,expires_at:renewal.expiresAt}});
  challenge(f,renewal); const first=await commitBoundDeviceLease(f.db,renewal);
  const before=f.sql.prepare("SELECT * FROM device_bound_bindings").get();
  const deadline=f.sql.prepare("SELECT retain_until FROM device_bound_operations WHERE operation_id=?").get(renewal.operationId).retain_until;
  for (const now of [deadline-1,deadline]) {
    f.clock(now);
    const r={...renewal,challengeId:`recover-${now}`,nonceHash:`nonce-${now}`,challengeExpiresAt:now+60};
    f.sql.prepare("INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at) VALUES(?,'renew',?,?,?,?,?,?)")
      .run(r.challengeId,r.subjectId,r.keyId,r.operationId,r.nonceHash,now,now+60);
    if (now<deadline) assert.deepEqual((await recoverBoundDeviceLease(f.db,r)).response,first.response);
    else {
      await assert.rejects(recoverBoundDeviceLease(f.db,r),/CHECK/);
      assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id=?").get(r.challengeId).consumed_invocation_id,null);
    }
  }
  assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_bindings").get(),before);
  assert.equal(count(f,"device_bound_leases"),2); assert.equal(count(f,"device_bound_events"),2);
});

test("an expired unconsumed approval cannot recover or create an operation", async () => {
  const f=fixture(),c=candidate(); seed(f,c); f.clock(1400);
  const r={...c,challengeId:"late-challenge",nonceHash:"late-nonce",challengeExpiresAt:1460};
  f.sql.prepare("INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at) VALUES(?,'exchange',?,?,?,?,1400,1460)")
    .run(r.challengeId,r.subjectId,r.keyId,r.operationId,r.nonceHash);
  await assert.rejects(recoverBoundDeviceLease(f.db,r),/CHECK/);
  await assert.rejects(commitBoundDeviceLease(f.db,r),/CHECK/);
  emptyCommit(f);
});

test("legacy floating mutations cannot bypass protected mode after a stale pre-read", () => {
  const f=fixture();
  const base=["APP","DEFAULT",fp,"seat","client","live",1000,1100,"APP","DEFAULT",fp,1000,1];
  assert.throws(()=>f.sql.prepare(SEAT_CHECKOUT_ATOMIC_SQL).get(...base),/legacy_protocol_disabled/);
  for (const mode of ["soft","required"]) {
    assert.equal(f.sql.prepare(seatCheckoutSqlOwned(mode)).get(...base,"APP","DEFAULT",fp,"customer",1000,1000),undefined);
  }
  assert.equal(count(f,"seat_checkouts"),0);
  // Inject an old row to exercise UPDATE independently of the INSERT guard.
  f.sql.exec("DROP TRIGGER tr_bound_reject_legacy_seat_insert");
  f.sql.prepare("INSERT INTO seat_checkouts(project,feature,license_fingerprint,seat_id,client_instance_id,mode,checked_out_at,heartbeat_deadline) VALUES('APP','DEFAULT',?,'seat','client','live',1000,1100)").run(fp);
  assert.throws(()=>f.sql.exec("UPDATE seat_checkouts SET heartbeat_deadline=9999"),/legacy_protocol_disabled/);
  for (const mode of ["off","soft","required"]) {
    const params=[1200,"APP","DEFAULT",fp,"seat",1000,1000,1000];
    if (mode!=='off') params.push("customer");
    assert.equal(f.sql.prepare(seatHeartbeatSql(mode)).get(...params),undefined);
  }
  assert.equal(f.sql.prepare("SELECT heartbeat_deadline FROM seat_checkouts").get().heartbeat_deadline,1100);
});

test("unstarted trials cannot bypass the stamp through exchange, renewal or recovery", async () => {
  for (const basis of ['from_issue','from_first_activation','from_first_use']) {
    for (const action of ['exchange','renew','recover']) {
      const f=fixture(),c=candidate(); seed(f,c);
      if (action!=='exchange') await commitBoundDeviceLease(f.db,c);
      f.sql.prepare("UPDATE entitlements SET is_trial=1,trial_expiration_basis=?,trial_duration_sec=60").run(basis);
      const currentRevision=f.sql.prepare("SELECT authority_revision FROM entitlements").get().authority_revision;
      const request={...c,entitlementRevision:currentRevision,challengeId:'trial-challenge',nonceHash:'trial-nonce'};
      if (action==='renew') {
        Object.assign(request,{purpose:'renew',operationId:'trial-renew',requestDigest:'trial-renew-digest',subjectId:c.bindingId,bindingRevision:1,leaseId:'trial-lease'});
        const response=JSON.parse(request.responseJson); response.code='device_renewed'; response.request_id=request.operationId;
        request.responseJson=JSON.stringify(response);
      }
      challenge(f,request);
      const before=f.sql.prepare("SELECT * FROM device_bound_bindings").all();
      await assert.rejects(action==='recover' ? recoverBoundDeviceLease(f.db,request) : commitBoundDeviceLease(f.db,request),/CHECK/);
      assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_bindings").all(),before);
      assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id='trial-challenge'").get().consumed_invocation_id,null);
      if (action==='exchange') emptyCommit(f);
      else {
        for (const table of ['device_bound_operations','device_bound_leases','device_bound_events']) assert.equal(count(f,table),1);
        assert.equal(f.sql.prepare("SELECT consumed_operation_id FROM device_bound_authorizations").get().consumed_operation_id,c.operationId);
      }
    }
  }
});

test("recovery has one final admission deadline and cannot lose its result after consuming proof", async () => {
  for (const advanceBefore of [1,3]) {
    const f=fixture(),c=candidate(); seed(f,c); const first=await commitBoundDeviceLease(f.db,c);
    f.sql.exec("UPDATE entitlements SET valid_until=2001");
    const r={...c,entitlementRevision:1,challengeId:'boundary-proof',nonceHash:'boundary-nonce',challengeExpiresAt:2060};
    f.sql.prepare("INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at) VALUES(?,'exchange',?,?,?,?,2000,2060)")
      .run(r.challengeId,r.subjectId,r.keyId,r.operationId,r.nonceHash);
    const before=f.sql.prepare("SELECT * FROM device_bound_bindings").get();
    f.clock(2000);
    f.beforeStatement(query=>{if(query===BOUND_RECOVERY_SQL[advanceBefore]) f.clock(2001);});
    if (advanceBefore===1) {
      await assert.rejects(recoverBoundDeviceLease(f.db,r),/CHECK/);
      assert.equal(f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id=?").get(r.challengeId).consumed_invocation_id,null);
    } else {
      assert.deepEqual((await recoverBoundDeviceLease(f.db,r)).response,first.response);
      assert.equal(typeof f.sql.prepare("SELECT consumed_invocation_id FROM device_bound_challenges WHERE id=?").get(r.challengeId).consumed_invocation_id,'string');
    }
    assert.deepEqual(f.sql.prepare("SELECT * FROM device_bound_bindings").get(),before);
    for (const table of ['device_bound_leases','device_bound_events','device_bound_operations']) assert.equal(count(f,table),1);
    assert.equal(count(f,'device_bound_commit_checks'),0);
  }
});
