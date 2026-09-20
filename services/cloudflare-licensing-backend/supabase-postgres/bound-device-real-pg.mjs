import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { VERIFY_SQL } from "../src/db/verify-statements.mjs";
import { translateWorkerSqlToPg } from "./sql-translate.mjs";

const connectionString=process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for the protected-device PostgreSQL gate");
const db=postgres(connectionString,{max:1});
const rollback=new Error("rollback successful protected-device conformance transaction");
const customer=`bound-${randomUUID()}`, project=`BOUND_${randomUUID()}`, fingerprint="b".repeat(64);

try {
  await assert.rejects(db.begin(async sql=>{
    const q=(query,params=[])=>sql.unsafe(query,params);
    const denied=(query,params,pattern)=>assert.rejects(sql.savepoint(tx=>tx.unsafe(query,params)),pattern);
    const now=Number((await q("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT AS now"))[0].now);
    await q("INSERT INTO customers(id,name,created_at,updated_at) VALUES($1,'Conformance', $2,$2)",[customer,now]);
    await q("INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,created_at,updated_at,enforcement_mode,max_active_devices) VALUES($1,'DEFAULT',$2,'active',$3,$4,$4,'device_bound_v1',1)",[project,fingerprint,customer,now]);
    await q("INSERT INTO entitlements(project,feature,license_fingerprint,status,customer_id,created_at,updated_at) VALUES($1,'LEGACY',$2,'active',$3,$4,$4)",[project,fingerprint,customer,now]);
    await denied("UPDATE entitlements SET enforcement_mode='device_bound_v1' WHERE project=$1 AND feature='LEGACY'",[project],/protected_mode_migration_required/);
    await denied("UPDATE entitlements SET enforcement_mode='legacy' WHERE project=$1 AND feature='DEFAULT'",[project],/protected_mode_downgrade/);
    const lookup=translateWorkerSqlToPg(VERIFY_SQL.entitlementLookup);
    assert.equal((await q(lookup,[project,'DEFAULT',fingerprint])).length,0);
    assert.equal((await q(lookup,[project,'LEGACY',fingerprint])).length,1);

    const device=randomUUID(),binding=randomUUID();
    await q("INSERT INTO device_bound_devices(id,customer_id,project,key_id,public_key_spki,created_at,last_proof_at) VALUES($1,$2,$3,$1,'test-spki',$4,$4)",[device,customer,project,now]);
    await q("INSERT INTO device_bound_bindings(id,project,feature,license_fingerprint,device_id,hold_until,created_at,updated_at) VALUES($1,$2,'DEFAULT',$3,$4,$5,$6,$6)",[binding,project,fingerprint,device,now+3600,now]);
    await denied("UPDATE entitlements SET max_active_devices=0 WHERE project=$1 AND feature='DEFAULT'",[project],/capacity_in_use/);
    await denied("UPDATE device_bound_bindings SET hold_until=0 WHERE id=$1",[binding],/binding_hold_cannot_shrink/);
    await denied("UPDATE device_bound_devices SET key_id='changed' WHERE id=$1",[device],/device_identity_immutable/);
    await denied("DELETE FROM device_bound_bindings WHERE id=$1",[binding],/binding_tombstone_required/);
    await denied("DELETE FROM device_bound_devices WHERE id=$1",[device],/device_tombstone_required/);
    await denied("INSERT INTO seat_checkouts(project,feature,license_fingerprint,seat_id,client_instance_id,mode,checked_out_at,heartbeat_deadline) VALUES($1,'DEFAULT',$2,'seat','client','borrowed',$3,$4)",[project,fingerprint,now,now+60],/legacy_protocol_disabled/);
    await denied("INSERT INTO lease_issuance(project,feature,license_fingerprint,device_key_id,lease_key_id,issued_at,valid_from,valid_to) VALUES($1,'DEFAULT',$2,'device','signer',$3,$3,$4)",[project,fingerprint,now,now+60],/legacy_protocol_disabled/);

    // Execute the AFTER-trigger self-update and dependent binding retirement.
    await q("UPDATE device_bound_devices SET status='disabled' WHERE id=$1",[device]);
    const retired=(await q("SELECT state,generation,hold_until FROM device_bound_bindings WHERE id=$1",[binding]))[0];
    assert.equal(retired.state,'retiring'); assert.equal(Number(retired.generation),2);
    assert.equal(Number(retired.hold_until),now+3600);
    assert.equal(Number((await q("SELECT revision FROM device_bound_devices WHERE id=$1",[device]))[0].revision),1);
    await denied("UPDATE device_bound_bindings SET state='released' WHERE id=$1",[binding],/binding_hold_active/);
    await denied("UPDATE device_bound_bindings SET generation=1 WHERE id=$1",[binding],/binding_revision_cannot_shrink/);
    await denied("UPDATE device_bound_devices SET revision=0 WHERE id=$1",[device],/device_revision_cannot_shrink/);

    await q("UPDATE customers SET status='disabled' WHERE id=$1",[customer]);
    await q("UPDATE customers SET status='active' WHERE id=$1",[customer]);
    assert.equal(Number((await q("SELECT authority_revision FROM customers WHERE id=$1",[customer]))[0].authority_revision),2);
    await q("UPDATE entitlements SET trial_require_device_proof=1 WHERE project=$1 AND feature='DEFAULT'",[project]);
    assert.equal(Number((await q("SELECT authority_revision FROM entitlements WHERE project=$1 AND feature='DEFAULT'",[project]))[0].authority_revision),1);
    await denied("INSERT INTO device_bound_authorizations(handle_hash,client_id,project,key_id,public_key_spki,redirect_uri,client_state,pkce_challenge,status,created_at,expires_at) VALUES('incomplete','client',$1,'key','spki','uri','state','pkce','approved',$2,$3)",[project,now,now+60],/check constraint/);
    for(const expired of [false,true]){
      const op=randomUUID();
      await q("INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,response_json,committed_at,retain_until) VALUES('retention-key','renew',$1,$1,'digest',$2,$3,'response',$4,$5)",[op,customer,binding,now-10,expired?now-1:now+100]);
      await q("UPDATE device_bound_operations SET status='complete' WHERE operation_id=$1",[op]);
      if(expired){
        await q("UPDATE device_bound_operations SET response_json='' WHERE operation_id=$1",[op]);
        await denied("UPDATE device_bound_operations SET response_json='restored' WHERE operation_id=$1",[op],/operation_result_immutable/);
      }else await denied("UPDATE device_bound_operations SET response_json='' WHERE operation_id=$1",[op],/operation_result_immutable/);
      await denied("DELETE FROM device_bound_operations WHERE operation_id=$1",[op],/operation_tombstone_required/);
      await denied("INSERT INTO device_bound_operations SELECT * FROM device_bound_operations WHERE operation_id=$1",[op],/operation_tombstone_required/);
    }
    const event=(await q("INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at) VALUES($1,$2,$3,'retire','test',$4) RETURNING id",[randomUUID(),binding,customer,now]))[0];
    assert.ok(Number(event.id)>0);
    throw rollback;
  }), error=>error===rollback);
  console.log("Real PostgreSQL protected-device guards passed; all test rows rolled back.");
} finally { await db.end(); }
