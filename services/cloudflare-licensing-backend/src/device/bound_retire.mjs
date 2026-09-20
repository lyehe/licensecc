import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";
import { BoundRequestError } from "./bound_request.mjs";
import { boundSecretHash } from "./bound_enrollment.mjs";

/** @returns {never} */
const deny = (code, status) => { throw new BoundRequestError(code, status); };
const fields = ["customerId","bindingId","operationId","invocationId","digest","expectedRevision",
  "customerRevision","deviceRevision","entitlementRevision","generation","actor"];
const input = `WITH p AS (SELECT ${fields.map(f=>`json_extract(j,'$.${f}') AS ${f}`).join(',')} FROM (SELECT ? AS j)) `;
const ownership = `JOIN device_bound_devices d ON d.id=b.device_id AND d.project=b.project
  JOIN entitlements e ON e.project=b.project AND e.feature=b.feature AND e.license_fingerprint=b.license_fingerprint
  JOIN customers c ON c.id=d.customer_id AND c.id=e.customer_id
  WHERE b.id=p.bindingId AND c.id=p.customerId AND c.status='active' AND e.enforcement_mode='device_bound_v1'`;
const revisions = `c.authority_revision=p.customerRevision AND d.revision=p.deviceRevision
  AND e.authority_revision=p.entitlementRevision`;
const fresh = `o.invocation_id=p.invocationId AND o.customer_id=p.customerId AND o.binding_id=p.bindingId
  AND o.purpose='retire' AND o.operation_id=p.operationId AND o.request_digest=p.digest AND o.lease_id IS NULL`;

export const BOUND_RETIRE_SQL = Object.freeze([
  input + `INSERT INTO device_bound_operations(key_id,purpose,operation_id,invocation_id,request_digest,customer_id,
    binding_id,lease_id,status,response_json,committed_at,retain_until)
    SELECT d.key_id,'retire',p.operationId,p.invocationId,p.digest,p.customerId,b.id,NULL,'prepared',
      json_object('binding_id',b.id,'state','retiring','effective_release_at',max(b.hold_until,unixepoch()),'revision',b.revision+1,'generation',b.generation+1),
      unixepoch(),unixepoch()+172800 FROM p JOIN device_bound_bindings b ${ownership}
      AND ${revisions} AND b.state='active' AND d.status='active' AND b.revision=p.expectedRevision
      AND b.revision<9007199254740991 AND b.generation=p.generation AND b.generation<9007199254740991`,
  input + `UPDATE device_bound_bindings SET state='retiring',generation=generation+1,revision=revision+1,
    updated_at=(SELECT o.committed_at FROM p JOIN device_bound_operations o ON ${fresh})
    WHERE id IN (SELECT o.binding_id FROM p JOIN device_bound_operations o ON ${fresh} AND o.status='prepared')
      AND state='active' AND revision=(SELECT expectedRevision FROM p) AND generation=(SELECT generation FROM p)`,
  input + `INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at)
    SELECT o.invocation_id,o.binding_id,o.customer_id,'retire',p.actor,o.committed_at
    FROM p JOIN device_bound_operations o ON ${fresh} AND o.status='prepared'`,
  input + `UPDATE device_bound_operations SET status='complete'
    WHERE invocation_id IN (SELECT o.invocation_id FROM p JOIN device_bound_operations o ON ${fresh} AND o.status='prepared')`,
  input + `INSERT INTO device_bound_commit_checks(invocation_id,ok) SELECT p.invocationId,CASE WHEN EXISTS (
    SELECT 1 FROM device_bound_bindings b ${ownership} AND ${revisions}
      AND b.state='retiring' AND b.revision=p.expectedRevision+1 AND b.generation=p.generation+1
      AND EXISTS (SELECT 1 FROM device_bound_operations o JOIN device_bound_events a ON a.invocation_id=o.invocation_id
        WHERE ${fresh} AND o.status='complete' AND o.key_id=d.key_id
          AND json_extract(o.response_json,'$.binding_id')=b.id AND json_extract(o.response_json,'$.state')='retiring'
          AND json_extract(o.response_json,'$.effective_release_at')=max(b.hold_until,o.committed_at)
          AND json_extract(o.response_json,'$.revision')=b.revision AND json_extract(o.response_json,'$.generation')=b.generation
          AND a.binding_id=b.id AND a.customer_id=p.customerId AND a.event_type='retire' AND a.actor=p.actor
          AND a.occurred_at=o.committed_at AND b.updated_at=o.committed_at)) THEN 1 ELSE 0 END FROM p`,
  input + `DELETE FROM device_bound_commit_checks WHERE invocation_id=(SELECT invocationId FROM p)`,
  input + `SELECT o.response_json FROM p JOIN device_bound_operations o ON ${fresh} AND o.status='complete'`,
]);

const ownedBinding = input + `SELECT b.*,d.key_id,c.authority_revision AS customer_revision,
  d.revision AS device_revision,e.authority_revision AS entitlement_revision
  FROM p JOIN device_bound_bindings b ${ownership}`;
// Only an authenticated backend capability may supply customerId. This is not a
// public device-proof endpoint and never derives identity from caller headers.
export async function retireBoundBinding(db, customerId, request) {
  return retireWithActor(db,customerId,request,'customer');
}

// The separate operator capability supplies this principal only after admin
// authentication. Customer RPC arguments cannot select an operator actor.
export async function retireBoundBindingAsOperator(db, actor, customerId, request) {
  if(!actor || typeof actor!=='object' || Array.isArray(actor) || Object.keys(actor).length!==3
      || !['subject','actor_type','role'].every(key=>Object.hasOwn(actor,key)) || actor.role!=='admin'
      || !['access','dev'].includes(actor.actor_type) || typeof actor.subject!=='string'
      || !actor.subject || actor.subject.length>256 || Array.from(actor.subject).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)
      || new TextDecoder().decode(new TextEncoder().encode(actor.subject))!==actor.subject)deny('access_denied',403);
  return retireWithActor(db,customerId,request,`operator:${actor.actor_type}:${actor.subject}`);
}

async function retireWithActor(db, customerId, request, actor) {
  if(typeof customerId!=='string' || !customerId || customerId.length>256) deny('access_denied',403);
  if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).length!==3
      || !['binding_id','expected_revision','operation_id'].every(key=>Object.hasOwn(request,key))) deny('invalid_request',400);
  try {
    if(decodeBase64url(request.binding_id,16).length!==16 || decodeBase64url(request.operation_id,32).length!==32) deny('invalid_request',400);
  } catch { deny('invalid_request',400); }
  if(!Number.isSafeInteger(request.expected_revision) || Object.is(request.expected_revision,-0)
      || request.expected_revision<0 || request.expected_revision>=Number.MAX_SAFE_INTEGER) deny('invalid_request',400);
  if(!db.batch) throw new Error('atomic_batch_required');
  const intent=actor==='customer'?['lcc-binding-retire-v1',customerId,request.binding_id,request.expected_revision]
    :['lcc-binding-retire-operator-v1',customerId,request.binding_id,request.expected_revision,actor];
  const p={customerId,bindingId:request.binding_id,operationId:request.operation_id,expectedRevision:request.expected_revision,actor,
    digest:await boundSecretHash(JSON.stringify(intent))};
  const row=await db.prepare(ownedBinding).bind(JSON.stringify(p)).first();
  if(!row) deny('binding_unavailable',404);
  const cached=async()=>{
    const operation=await db.prepare(`SELECT request_digest,status,response_json,retain_until,unixepoch() AS now
      FROM device_bound_operations WHERE key_id=? AND purpose='retire' AND operation_id=?`)
      .bind(row.key_id,p.operationId).first();
    if(!operation)return null;
    if(operation.request_digest!==p.digest)deny('idempotency_conflict',409);
    if(operation.status!=='complete' || operation.response_json==='' || operation.retain_until<=operation.now)deny('idempotency_conflict',409);
    const result=await db.prepare(input + `SELECT o.response_json FROM p
      JOIN device_bound_operations o ON o.key_id=? AND o.purpose='retire' AND o.operation_id=p.operationId
      JOIN device_bound_bindings b ON b.id=o.binding_id ${ownership}
      AND o.customer_id=p.customerId AND o.request_digest=p.digest AND o.status='complete'
      AND o.lease_id IS NULL AND json_extract(NULLIF(o.response_json,''),'$.binding_id')=b.id
      AND json_extract(NULLIF(o.response_json,''),'$.state')='retiring' AND json_extract(NULLIF(o.response_json,''),'$.revision')=p.expectedRevision+1
      AND o.response_json<>'' AND o.retain_until>unixepoch() AND b.state IN ('retiring','released')
      AND b.generation=json_extract(NULLIF(o.response_json,''),'$.generation') AND b.revision>=json_extract(NULLIF(o.response_json,''),'$.revision')
      AND max(b.hold_until,o.committed_at)=json_extract(NULLIF(o.response_json,''),'$.effective_release_at')`)
      .bind(JSON.stringify(p),row.key_id).first();
    if(!result)deny('idempotency_conflict',409);
    return JSON.parse(result.response_json);
  };
  const previous=await cached(); if(previous)return previous;
  if(row.state!=='active' || row.revision!==p.expectedRevision || row.generation>=Number.MAX_SAFE_INTEGER)deny('revision_conflict',409);
  const encoded=JSON.stringify({...p,invocationId:crypto.randomUUID(),generation:row.generation,
    customerRevision:row.customer_revision,deviceRevision:row.device_revision,entitlementRevision:row.entitlement_revision});
  try {
    const results=await db.batch(BOUND_RETIRE_SQL.map(sql=>db.prepare(sql).bind(encoded)));
    const result=results.at(-1)?.results?.[0];
    if(result?.response_json)return JSON.parse(result.response_json);
  } catch { /* Race losers and lost results recover only the committed operation. */ }
  const winner=await cached(); if(winner)return winner;
  const current=await db.prepare(ownedBinding).bind(JSON.stringify(p)).first();
  if(!current)deny('binding_unavailable',404);
  if(current.state!=='active' || current.revision!==p.expectedRevision)deny('revision_conflict',409);
  deny('temporarily_unavailable',503);
}
