// Recovery is deliberately independent of issuance: no lease, binding hold,
// original response timestamp or audit event is created/extended here.
// Callers must verify fresh device proof and reconstruct this internal candidate
// from primary DB reads. Never pass an HTTP request body directly to this helper.
import { boundTrialSql } from "./bound_trial.mjs";
const fields=["keyId","purpose","operationId","requestDigest","customerId","customerRevision",
  "project","feature","fingerprint","entitlementRevision","deviceId","deviceRevision","publicKeySpki",
  "bindingId","generation","challengeId","challengeExpiresAt","nonceHash","subjectId",
  "codeHash","pkceChallenge","redirectUri","invocationId"];
const input=`WITH p AS (SELECT ${fields.map(f=>`json_extract(j,'$.${f}') AS ${f}`).join(",")} FROM (SELECT ? AS j)) `;
const authority=`FROM p
  JOIN device_bound_operations o ON o.key_id=p.keyId AND o.purpose=p.purpose AND o.operation_id=p.operationId
    AND o.request_digest=p.requestDigest AND o.status='complete' AND o.response_json<>'' AND o.retain_until>unixepoch()
    AND o.customer_id=p.customerId AND o.binding_id=p.bindingId
  JOIN device_bound_devices d ON d.id=p.deviceId AND d.key_id=p.keyId AND d.public_key_spki=p.publicKeySpki
    AND d.customer_id=p.customerId AND d.project=p.project AND d.status='active' AND d.revision=p.deviceRevision
  JOIN device_bound_bindings b ON b.id=o.binding_id AND b.device_id=d.id AND b.project=p.project
    AND b.feature=p.feature AND b.license_fingerprint=p.fingerprint AND b.state='active' AND b.generation=p.generation
  JOIN entitlements e ON e.project=b.project AND e.feature=b.feature AND e.license_fingerprint=b.license_fingerprint
    AND e.customer_id=p.customerId AND e.status='active' AND e.enforcement_mode='device_bound_v1'
    AND e.authority_revision=p.entitlementRevision AND e.pool_size=0
    AND ${boundTrialSql("e", "p.keyId", "unixepoch()", false)}
    AND (e.valid_from IS NULL OR e.valid_from<=unixepoch())
    AND (e.valid_until IS NULL OR e.valid_until>unixepoch())
  JOIN customers owner ON owner.id=p.customerId AND owner.status='active' AND owner.authority_revision=p.customerRevision
  WHERE p.purpose IN ('exchange','renew') AND
    ((p.purpose='renew' AND p.subjectId=p.bindingId) OR (p.purpose='exchange' AND EXISTS (
      SELECT 1 FROM device_bound_authorizations a WHERE a.handle_hash=p.subjectId AND a.status='consumed'
      AND a.consumed_invocation_id=o.invocation_id AND a.consumed_operation_id=p.operationId
      AND a.recovery_until>unixepoch() AND a.customer_id=p.customerId AND a.project=p.project
      AND a.feature=p.feature AND a.license_fingerprint=p.fingerprint AND a.key_id=p.keyId
      AND a.public_key_spki=p.publicKeySpki AND a.code_hash=p.codeHash
      AND a.pkce_challenge=p.pkceChallenge AND a.redirect_uri=p.redirectUri)))`;
const validChallenge=`c.id=p.challengeId AND c.key_id=p.keyId AND c.purpose=p.purpose
  AND c.operation_id=p.operationId AND c.subject_id=p.subjectId AND c.nonce_hash=p.nonceHash
  AND c.expires_at=p.challengeExpiresAt AND c.expires_at>unixepoch()`;
const consume=input+`UPDATE device_bound_challenges SET consumed_invocation_id=(SELECT invocationId FROM p)
  WHERE consumed_invocation_id IS NULL AND EXISTS (SELECT 1 ${authority}
    AND ${validChallenge.replaceAll("c.","device_bound_challenges.")})`;
const assertion=input+`INSERT INTO device_bound_commit_checks(invocation_id,ok)
  SELECT p.invocationId,CASE WHEN EXISTS (SELECT 1 ${authority}
    AND EXISTS(SELECT 1 FROM device_bound_challenges c WHERE ${validChallenge}
      AND c.consumed_invocation_id=p.invocationId)) THEN 1 ELSE 0 END FROM p`;
const remove=input+`DELETE FROM device_bound_commit_checks WHERE invocation_id=(SELECT invocationId FROM p)`;
// Admission is finalized by the assertion. Return its immutable result through
// fresh challenge consumption, without a second clock boundary after admission.
const read=input+`SELECT o.response_json FROM p
  JOIN device_bound_operations o ON o.key_id=p.keyId AND o.purpose=p.purpose AND o.operation_id=p.operationId
    AND o.request_digest=p.requestDigest AND o.status='complete' AND o.customer_id=p.customerId AND o.binding_id=p.bindingId
  JOIN device_bound_challenges c ON c.id=p.challengeId AND c.consumed_invocation_id=p.invocationId
    AND c.key_id=p.keyId AND c.purpose=p.purpose AND c.operation_id=p.operationId
    AND c.subject_id=p.subjectId AND c.nonce_hash=p.nonceHash`;
export const BOUND_RECOVERY_SQL=Object.freeze([consume,assertion,remove,read]);

export async function recoverBoundDeviceLease(db,candidate) {
  if (!db.batch) throw new Error("atomic_batch_required");
  const invocationId=crypto.randomUUID();
  const encoded=JSON.stringify({...candidate,invocationId});
  const results=await db.batch(BOUND_RECOVERY_SQL.map(sql=>db.prepare(sql).bind(encoded)));
  const row=results.at(-1)?.results?.[0];
  if (!row) throw new Error("recovery_unavailable");
  return {invocationId,response:JSON.parse(row.response_json)};
}
