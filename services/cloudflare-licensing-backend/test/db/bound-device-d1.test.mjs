import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BOUND_LEASE_COMMIT_SQL, commitBoundDeviceLease } from "../../src/device/bound_store.mjs";
import { recoverBoundDeviceLease } from "../../src/device/bound_recovery.mjs";
import { purgeExpiredBoundApprovals, purgeExpiredBoundEphemera, expireBoundRecovery, purgeExpiredBoundLeases } from "../../src/device/bound_cleanup.mjs";
import { denyBoundAuthorization } from "../../src/device/bound_consent.mjs";
import { retireBoundBinding } from "../../src/device/bound_retire.mjs";
import { boundRandomId, boundSecretHash, createBoundAuthorization, createBoundChallenge } from "../../src/device/bound_enrollment.mjs";
import { encodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";

// Exercise the D1 binding from the repository's pinned Wrangler runtime, not
// the synchronous SQLite batch adapter. No remote database or account is used.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const fingerprint = "a".repeat(64);

test("local D1 commits one denial and its exact retry record atomically", async t => {
  const f=await fixture(t),handle=boundRandomId(32),hash=await boundSecretHash(handle);
  await f.db.prepare(`INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,created_at,expires_at)
    VALUES(?,'desktop','APP','key','spki','http://127.0.0.1:1234/callback','state','pkce',unixepoch(),unixepoch()+300)`).bind(hash).run();
  const config={clients:[{client_id:"desktop",project:"APP",callbacks:[{host:"127.0.0.1",path:"/callback"}]}]};
  const input={attempt_handle:handle,expected_attempt_revision:0,operation_id:boundRandomId(32)};
  const results=await Promise.all([denyBoundAuthorization(f.db,"customer",input,config),denyBoundAuthorization(f.db,"customer",input,config)]);
  assert.deepEqual(results,[{status:"authorization_denied",revision:1},{status:"authorization_denied",revision:1}]);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM mutation_idempotency").first()).n,1);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM device_bound_commit_checks").first()).n,0);
  assert.equal((await f.db.prepare("SELECT revision FROM device_bound_authorizations WHERE handle_hash=?").bind(hash).first()).revision,1);
});

test("local D1 erases expired approval ciphertext without changing approval identity", async t => {
  const f=await fixture(t),c=await candidate(f,99);
  await f.db.prepare("UPDATE device_bound_authorizations SET approval_ciphertext='encrypted-fixture' WHERE handle_hash=?").bind(c.subjectId).run();
  await purgeExpiredBoundApprovals(f.db);
  assert.equal((await f.db.prepare("SELECT approval_ciphertext FROM device_bound_authorizations WHERE handle_hash=?").bind(c.subjectId).first()).approval_ciphertext,'encrypted-fixture');
  // Seed an already expired approved attempt; pinned approval fields cannot be edited.
  await f.db.prepare(`INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,status,customer_id,feature,license_fingerprint,code_hash,code_expires_at,approval_ciphertext,created_at,expires_at)
    VALUES('expired-cleanup','desktop','APP','key','spki','http://127.0.0.1:1234/callback','state','pkce','approved','customer','DEFAULT',?,'hash',unixepoch()-1,'expired-cipher',unixepoch()-100,unixepoch()+100)`).bind(fingerprint).run();
  const before=await f.db.prepare("SELECT * FROM device_bound_authorizations WHERE handle_hash='expired-cleanup'").first();
  await purgeExpiredBoundApprovals(f.db);
  assert.deepEqual(await f.db.prepare("SELECT * FROM device_bound_authorizations WHERE handle_hash='expired-cleanup'").first(),{...before,approval_ciphertext:null});
});

test("local D1 simultaneous retire retries commit one event and retain the maximum hold",async t=>{
  const f=await fixture(t),c=await candidate(f,95,{bindingId:boundRandomId(16)});
  await commitBoundDeviceLease(f.db,c);
  const before=await f.db.prepare('SELECT * FROM device_bound_bindings WHERE id=?').bind(c.bindingId).first();
  const input={binding_id:c.bindingId,expected_revision:before.revision,operation_id:boundRandomId(32)};
  const results=await Promise.all([retireBoundBinding(f.db,'customer',input),retireBoundBinding(f.db,'customer',input)]);
  assert.deepEqual(results[0],results[1]);
  const after=await f.db.prepare('SELECT * FROM device_bound_bindings WHERE id=?').bind(c.bindingId).first();
  assert.equal(after.hold_until,before.hold_until);assert.equal(after.generation,before.generation+1);assert.equal(after.revision,before.revision+1);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM device_bound_events WHERE event_type='retire'").first()).n,1);
  assert.equal((await f.db.prepare("SELECT count(*) n FROM device_bound_operations WHERE purpose='retire'").first()).n,1);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM device_bound_commit_checks').first()).n,0);
});

async function fixture(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name:"bound-device-test", modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-08-01", d1Databases: {DB: "bound-device-test"} }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  // SQLite parses the canonical DDL into complete statements (including
  // multi-statement trigger bodies); all test operations execute through D1.
  const parser = new DatabaseSync(":memory:");
  let ddl;
  try {
    parser.exec(readFileSync(new URL("../../schema.sql", import.meta.url), "utf8"));
    ddl = parser.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid").all();
  } finally { parser.close(); }
  for (const row of ddl) await db.prepare(row.sql).run();
  const now = await db.prepare("SELECT unixepoch() AS now").first("now");
  await db.prepare("INSERT INTO customers(id,name,created_at,updated_at) VALUES('customer','Test',?,?)").bind(now,now).run();
  await db.prepare("INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,created_at,updated_at,enforcement_mode,max_active_devices) VALUES('APP','DEFAULT',?,'active','customer',?,?,'device_bound_v1',1)")
    .bind(fingerprint,now,now).run();
  return {db,now};
}

async function candidate({db,now}, id, overrides = {}) {
  const c={keyId:`key-${id}`,purpose:"exchange",operationId:`op-${id}`,requestDigest:`digest-${id}`,
    customerId:"customer",customerRevision:0,project:"APP",feature:"DEFAULT",fingerprint,entitlementRevision:0,trialStamp:0,
    deviceId:`device-${id}`,deviceRevision:0,publicKeySpki:`public-${id}`,deviceLabel:"Test device",
    bindingId:`binding-${id}`,bindingRevision:0,generation:1,leaseId:`lease-${id}`,issuedAt:now,
    expiresAt:now+3600,acceptUntil:now+3720,token:`verified-signed-fixture-${id}`,
    challengeId:`challenge-${id}`,challengeExpiresAt:now+60,nonceHash:`nonce-${id}`,subjectId:`attempt-${id}`,
    attemptRevision:0,codeHash:`code-${id}`,pkceChallenge:`pkce-${id}`,redirectUri:"http://127.0.0.1:1234/callback",...overrides};
  c.responseJson=JSON.stringify({ok:true,code:"device_activated",request_id:c.operationId,
    data:{binding_id:c.bindingId,lease:c.token,expires_at:c.expiresAt}});
  // The store consumes an already cryptographically verified internal candidate;
  // independent crypto tests own signatures. This test targets D1 transaction behavior.
  await db.prepare("INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,status,customer_id,feature,license_fingerprint,code_hash,code_expires_at,created_at,expires_at) VALUES(?,'desktop','APP',?,?,?,'state',?,'approved','customer','DEFAULT',?,?,?,?,?)")
    .bind(c.subjectId,c.keyId,c.publicKeySpki,c.redirectUri,c.pkceChallenge,c.fingerprint,c.codeHash,now+60,now,now+300).run();
  await db.prepare("INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at) VALUES(?,'exchange',?,?,?,?,?,?)")
    .bind(c.challengeId,c.subjectId,c.keyId,c.operationId,c.nonceHash,now,now+60).run();
  return c;
}

test("local D1 ephemera and lease cleanup preserve committed authority and recovery records",async t=>{
  const f=await fixture(t),c=await candidate(f,'cleanup');
  await commitBoundDeviceLease(f.db,c);
  const tables=['device_bound_devices','device_bound_bindings','device_bound_operations','device_bound_leases','device_bound_events'];
  const before=await Promise.all(tables.map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()));
  await f.db.prepare(`INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,created_at,expires_at)
    VALUES('expired-attempt','client','APP','key','spki','uri','state','pkce',?,?)`).bind(f.now-10,f.now-1).run();
  await f.db.prepare(`INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at)
    VALUES('expired-proof','exchange','expired-attempt','key','operation','old-nonce',?,?)`).bind(f.now-10,f.now-1).run();
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:1,attempts:1});
  assert.deepEqual(await purgeExpiredBoundEphemera(f.db),{challenges:0,attempts:0});
  await f.db.prepare(`INSERT INTO device_bound_leases(id,binding_id,generation,entitlement_revision,invocation_id,issued_at,expires_at,accept_until,token)
    VALUES('expired-lease',?,1,0,'expired-invocation',?,?,?,'old-token')`).bind(c.bindingId,f.now-500,f.now-120,f.now).run();
  assert.deepEqual(await purgeExpiredBoundLeases(f.db),{leases:1});
  assert.deepEqual(await purgeExpiredBoundLeases(f.db),{leases:0});
  for(let i=0;i<tables.length;i++)assert.deepEqual((await f.db.prepare(`SELECT * FROM ${tables[i]}`).all()).results,before[i].results);
  assert.equal(await f.db.prepare('SELECT status FROM device_bound_authorizations').first('status'),'consumed');
});

test("local D1 erases expired recovery payloads but retains immutable operation tombstones",async t=>{
  const f=await fixture(t),c=await candidate(f,'retention');await commitBoundDeviceLease(f.db,c);
  const binding=await f.db.prepare('SELECT * FROM device_bound_bindings').first();
  await f.db.prepare(`INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,status,response_json,committed_at,retain_until)
    VALUES('key','renew','old-op','old-invocation','digest','customer',?,'complete','old-response',?,?)`).bind(c.bindingId,f.now-10,f.now-1).run();
  const before=await f.db.prepare("SELECT * FROM device_bound_operations WHERE operation_id='old-op'").first();
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:1,attempts:0});
  assert.deepEqual(await f.db.prepare("SELECT * FROM device_bound_operations WHERE operation_id='old-op'").first(),{...before,response_json:''});
  assert.deepEqual(await f.db.prepare('SELECT * FROM device_bound_bindings').first(),binding);
  await assert.rejects(f.db.prepare("UPDATE device_bound_operations SET response_json='restored' WHERE operation_id='old-op'").run(),/operation_result_immutable/);
  await assert.rejects(f.db.prepare("DELETE FROM device_bound_operations WHERE operation_id='old-op'").run(),/operation_tombstone_required/);
  assert.deepEqual(await expireBoundRecovery(f.db),{responses:0,attempts:0});
});

test("local D1 concurrent batches grant exactly one last slot and recover the committed response", async t => {
  const f=await fixture(t);
  const candidates=[];
  for (let id=0;id<6;id++) candidates.push(await candidate(f,id));
  const results=await Promise.allSettled(candidates.map(c=>commitBoundDeviceLease(f.db,c)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=candidates[results.findIndex(r=>r.status==='fulfilled')];
  for (const table of ['device_bound_devices','device_bound_bindings','device_bound_leases','device_bound_events','device_bound_operations']) {
    assert.equal(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first('n'),1,table);
  }
  const before=await f.db.prepare("SELECT * FROM device_bound_bindings").first();
  const recovery={...winner,challengeId:"recovery",nonceHash:"recovery-nonce"};
  await f.db.prepare("INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at) VALUES('recovery','exchange',?,?,?,'recovery-nonce',?,?)")
    .bind(winner.subjectId,winner.keyId,winner.operationId,f.now,f.now+60).run();
  const response=await recoverBoundDeviceLease(f.db,recovery);
  assert.deepEqual(response.response,JSON.parse(winner.responseJson));
  assert.deepEqual(await f.db.prepare("SELECT * FROM device_bound_bindings").first(),before);
  await assert.rejects(recoverBoundDeviceLease(f.db,recovery),/CHECK/);
  assert.equal(await f.db.prepare("SELECT count(*) n FROM device_bound_commit_checks").first('n'),0);
});

test("local D1 rolls back the entire issuance when a dependent audit write is missing", async t => {
  const f=await fixture(t), c=await candidate(f,"rollback");
  const encoded=JSON.stringify({...c,invocationId:"fault-injection"});
  await assert.rejects(f.db.batch(BOUND_LEASE_COMMIT_SQL.filter((_,i)=>i!==9).map(sql=>f.db.prepare(sql).bind(encoded))),/CHECK/);
  for (const table of ['device_bound_devices','device_bound_bindings','device_bound_leases','device_bound_events','device_bound_operations','device_bound_commit_checks']) {
    assert.equal(await f.db.prepare(`SELECT count(*) n FROM ${table}`).first('n'),0,table);
  }
  assert.equal((await f.db.prepare("SELECT consumed_invocation_id FROM device_bound_challenges").first()).consumed_invocation_id,null);
  assert.equal((await f.db.prepare("SELECT status FROM device_bound_authorizations").first()).status,'approved');
  await commitBoundDeviceLease(f.db,c);
});

test("local D1 trial stamp is atomic under competing first activations and audit failure", async t => {
  const f=await fixture(t);
  await f.db.prepare(`UPDATE entitlements SET is_trial=1,trial_expiration_basis='from_first_activation',
    trial_duration_sec=7200,trial_one_per_device=1,max_active_devices=2`).run();
  const candidates=[];
  for (let i=0;i<2;i++) candidates.push(await candidate(f,`trial-${i}`,
    {trialStamp:1,entitlementRevision:1,keyId:`sha256:${String(i).repeat(64)}`}));
  const failed=JSON.stringify({...candidates[0],invocationId:'trial-audit-failure'});
  await assert.rejects(f.db.batch(BOUND_LEASE_COMMIT_SQL.filter((_,i)=>i!==9).map(sql=>f.db.prepare(sql).bind(failed))),/CHECK/);
  const before=await f.db.prepare('SELECT trial_started_at,trial_device_hash,authority_revision FROM entitlements').first();
  assert.deepEqual(before,{trial_started_at:null,trial_device_hash:null,authority_revision:1});
  assert.equal(await f.db.prepare('SELECT count(*) n FROM device_bound_operations').first('n'),0);
  const results=await Promise.allSettled(candidates.map(c=>commitBoundDeviceLease(f.db,c)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=candidates[results.findIndex(r=>r.status==='fulfilled')];
  const row=await f.db.prepare('SELECT trial_started_at,trial_device_hash,authority_revision FROM entitlements').first();
  const operation=await f.db.prepare('SELECT committed_at FROM device_bound_operations').first();
  assert.deepEqual(row,{trial_started_at:operation.committed_at,trial_device_hash:winner.keyId,authority_revision:2});
  assert.equal(await f.db.prepare('SELECT entitlement_revision FROM device_bound_leases').first('entitlement_revision'),2);
  const loser=candidates.find(c=>c!==winner);
  await assert.rejects(commitBoundDeviceLease(f.db,{...loser,trialStamp:0,entitlementRevision:2}),/CHECK/);
  assert.deepEqual(await f.db.prepare('SELECT trial_started_at,trial_device_hash,authority_revision FROM entitlements').first(),row);
});

test("local D1 enrollment pins validated intent, hashes handles and issues bounded challenges", async t => {
  const {db}=await fixture(t);
  const keys=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
  const request={client_id:"desktop",project:"APP",
    public_key_spki:encodeBase64url(new Uint8Array(await crypto.subtle.exportKey("spki",keys.publicKey))),
    device_label:" My PC ",redirect_uri:"http://127.0.0.1:45678/callback",
    state:boundRandomId(32),code_challenge:boundRandomId(32),code_challenge_method:"S256"};
  const config={authorizationUrl:"https://portal.example.test/connect",clients:[{client_id:"desktop",project:"APP",callbacks:[{host:"127.0.0.1",path:"/callback"}]}]};
  const result=await createBoundAuthorization(db,request,config);
  const row=await db.prepare("SELECT * FROM device_bound_authorizations").first();
  assert.equal(row.handle_hash,await boundSecretHash(result.attempt_handle));
  assert.equal(row.expires_at-row.created_at,300);
  assert.equal(result.expires_at,row.expires_at);
  assert.equal(row.device_label,"My PC");
  assert.equal(row.redirect_uri,request.redirect_uri);
  assert.equal(row.client_state,request.state);
  assert.equal(row.pkce_challenge,request.code_challenge);
  assert.equal(row.status,"pending");
  assert.equal(JSON.stringify(row).includes(result.attempt_handle),false);
  const destination=new URL(result.authorization_url);
  assert.equal(destination.origin,"https://portal.example.test");
  assert.equal(destination.search,"");
  assert.equal(new URLSearchParams(destination.hash.slice(1)).get("attempt_handle"),result.attempt_handle);
  const operation=boundRandomId(32);
  const challenge=await createBoundChallenge(db,{purpose:"exchange",attempt_handle:result.attempt_handle,operation_id:operation});
  const saved=await db.prepare("SELECT * FROM device_bound_challenges WHERE id=?").bind(challenge.challenge_id).first();
  assert.equal(saved.nonce_hash,await boundSecretHash(challenge.nonce));
  assert.equal(saved.subject_id,row.handle_hash);
  assert.equal(saved.key_id,row.key_id);
  assert.equal(saved.operation_id,operation);
  assert.equal(saved.expires_at-saved.created_at,60);
  assert.ok(saved.expires_at<=row.expires_at);
  assert.equal(saved.consumed_invocation_id,null);
  await assert.rejects(createBoundAuthorization(db,{...request,public_key_spki:encodeBase64url(new Uint8Array(91))},config),/invalid_request/);
  await assert.rejects(createBoundAuthorization(db,{...request,project:"OTHER"},config),/access_denied/);
  assert.equal(await db.prepare("SELECT count(*) n FROM device_bound_authorizations").first("n"),1);
  await db.prepare("UPDATE device_bound_authorizations SET status='denied',revision=revision+1 WHERE handle_hash=?").bind(row.handle_hash).run();
  await assert.rejects(createBoundChallenge(db,{purpose:"exchange",attempt_handle:result.attempt_handle,operation_id:operation}),/authorization_unavailable/);
});

test("local D1 consumed-attempt challenges require its exact retained operation", async t => {
  const f=await fixture(t),handle=boundRandomId(32),operation=boundRandomId(32);
  const c=await candidate(f,"challenge-recovery",{subjectId:await boundSecretHash(handle),operationId:operation});
  await commitBoundDeviceLease(f.db,c);
  const challenge=await createBoundChallenge(f.db,{purpose:"exchange",attempt_handle:handle,operation_id:operation});
  assert.ok(challenge.expires_at>f.now);
  const count=await f.db.prepare("SELECT count(*) n FROM device_bound_challenges").first("n");
  await assert.rejects(createBoundChallenge(f.db,{purpose:"exchange",attempt_handle:handle,operation_id:boundRandomId(32)}),/authorization_unavailable/);
  assert.equal(await f.db.prepare("SELECT count(*) n FROM device_bound_challenges").first("n"),count);
  await assert.rejects(createBoundChallenge(f.db,{purpose:"renew",binding_id:boundRandomId(),operation_id:operation}),/binding_unavailable/);
});
