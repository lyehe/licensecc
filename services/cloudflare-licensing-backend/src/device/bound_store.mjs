// Guarded D1 batches for a *cryptographically verified and signed* candidate.
// HTTP handlers must verify device proof and reconstruct the candidate from
// primary DB reads, never pass caller JSON directly to this internal module.
import { boundTrialSql, boundTrialDeadlineSql } from "./bound_trial.mjs";
const fields = ["keyId", "purpose", "operationId", "invocationId", "requestDigest",
  "customerId", "customerRevision", "project", "feature", "fingerprint", "entitlementRevision",
  "deviceId", "deviceRevision", "publicKeySpki", "deviceLabel", "bindingId",
  "bindingRevision", "generation", "leaseId", "issuedAt", "expiresAt", "acceptUntil",
  "token", "responseJson", "challengeId", "challengeExpiresAt", "nonceHash", "subjectId",
  "attemptRevision", "codeHash", "pkceChallenge", "redirectUri", "trialStamp"];
const input = `WITH p AS (SELECT ${fields.map(f => `json_extract(j, '$.${f}') AS ${f}`).join(", ")} FROM (SELECT ? AS j)) `;
const owned = (revision, allowUnstarted = true) => `e.project=p.project AND e.feature=p.feature AND e.license_fingerprint=p.fingerprint
  AND e.customer_id=p.customerId AND e.status='active' AND e.enforcement_mode='device_bound_v1'
  AND e.authority_revision=${revision} AND e.pool_size=0
  AND ${boundTrialSql("e", "p.keyId", "unixepoch()", allowUnstarted)}
  AND (e.valid_from IS NULL OR e.valid_from <= unixepoch())
  AND (e.valid_until IS NULL OR e.valid_until > unixepoch())`;
const challenge = `c.id=p.challengeId AND c.key_id=p.keyId AND c.purpose=p.purpose
  AND c.operation_id=p.operationId AND c.subject_id=p.subjectId AND c.nonce_hash=p.nonceHash
  AND c.consumed_invocation_id IS NULL AND c.expires_at=p.challengeExpiresAt AND c.expires_at > unixepoch()`;
const activeDevice = `d.id=p.deviceId AND d.key_id=p.keyId AND d.public_key_spki=p.publicKeySpki
  AND d.customer_id=p.customerId AND d.project=p.project AND d.status='active' AND d.revision=p.deviceRevision`;
const activeBinding = `b.id=p.bindingId AND b.project=p.project AND b.feature=p.feature
  AND b.license_fingerprint=p.fingerprint AND b.device_id=p.deviceId
  AND b.state='active' AND b.generation=p.generation AND b.revision=p.bindingRevision`;
const approved = `a.handle_hash=p.subjectId AND a.status='approved' AND a.revision=p.attemptRevision
  AND a.customer_id=p.customerId AND a.project=p.project AND a.feature=p.feature
  AND a.license_fingerprint=p.fingerprint AND a.key_id=p.keyId AND a.public_key_spki=p.publicKeySpki
  AND a.code_hash=p.codeHash AND a.pkce_challenge=p.pkceChallenge AND a.redirect_uri=p.redirectUri
  AND a.expires_at > unixepoch() AND a.code_expires_at > unixepoch()`;
const operation = `o.invocation_id=p.invocationId AND o.key_id=p.keyId AND o.purpose=p.purpose
  AND o.operation_id=p.operationId AND o.request_digest=p.requestDigest
  AND o.binding_id=p.bindingId AND o.lease_id=p.leaseId AND o.customer_id=p.customerId
  AND o.status='prepared'`;

export const BOUND_LEASE_GUARD_SQL = input + `INSERT INTO device_bound_operations
  (key_id,purpose,operation_id,invocation_id,request_digest,customer_id,binding_id,lease_id,response_json,committed_at,retain_until)
  SELECT p.keyId,p.purpose,p.operationId,p.invocationId,p.requestDigest,p.customerId,p.bindingId,p.leaseId,p.responseJson,unixepoch(),unixepoch()+172800
  FROM p JOIN entitlements e ON ${owned("p.entitlementRevision")}
  JOIN customers owner ON owner.id=p.customerId AND owner.status='active' AND owner.authority_revision=p.customerRevision
  WHERE p.purpose IN ('exchange','renew') AND p.issuedAt <= unixepoch()
  AND p.expiresAt > unixepoch() AND p.expiresAt-p.issuedAt BETWEEN 2 AND 86400
  AND p.acceptUntil=p.expiresAt+120
  AND (e.valid_until IS NULL OR p.expiresAt <= e.valid_until)
  AND (e.lease_seconds <= 0 OR p.expiresAt <= p.issuedAt+e.lease_seconds)
  AND p.trialStamp=CASE WHEN e.is_trial=1 AND e.trial_started_at IS NULL THEN 1 ELSE 0 END
  AND (p.trialStamp=0 OR e.authority_revision<9007199254740991)
  AND (p.purpose='exchange' OR p.trialStamp=0)
  AND (e.is_trial=0 OR p.expiresAt<=${boundTrialDeadlineSql("e", "p.issuedAt")})
  AND EXISTS (SELECT 1 FROM device_bound_challenges c WHERE ${challenge})
  AND (
    (p.purpose='renew' AND p.subjectId=p.bindingId
      AND EXISTS (SELECT 1 FROM device_bound_devices d WHERE ${activeDevice})
      AND EXISTS (SELECT 1 FROM device_bound_bindings b WHERE ${activeBinding}))
    OR
    (p.purpose='exchange'
      AND EXISTS (SELECT 1 FROM device_bound_authorizations a WHERE ${approved})
      AND (EXISTS (SELECT 1 FROM device_bound_devices d WHERE ${activeDevice})
        OR (p.deviceRevision=0 AND NOT EXISTS (SELECT 1 FROM device_bound_devices d WHERE d.key_id=p.keyId OR d.id=p.deviceId)))
      AND (EXISTS (SELECT 1 FROM device_bound_bindings b WHERE ${activeBinding})
        OR (p.generation=1 AND p.bindingRevision=0
          AND NOT EXISTS (SELECT 1 FROM device_bound_bindings b WHERE b.id=p.bindingId)
          AND NOT EXISTS (SELECT 1 FROM device_bound_bindings b WHERE b.project=p.project AND b.feature=p.feature
            AND b.license_fingerprint=p.fingerprint AND b.device_id=p.deviceId AND b.state='active')
          AND (SELECT COUNT(*) FROM device_bound_bindings b WHERE b.project=p.project AND b.feature=p.feature
            AND b.license_fingerprint=p.fingerprint AND (b.state='active' OR (b.state='retiring' AND b.hold_until > unixepoch()))) < e.max_active_devices))
    )
  )`;

const stampTrial = input + `UPDATE entitlements SET
  trial_started_at=(SELECT o.committed_at FROM p JOIN device_bound_operations o ON ${operation}),
  trial_device_hash=(SELECT p.keyId FROM p),
  updated_at=(SELECT o.committed_at FROM p JOIN device_bound_operations o ON ${operation})
  WHERE trial_started_at IS NULL AND trial_device_hash IS NULL AND is_trial=1
    AND EXISTS (SELECT 1 FROM p JOIN device_bound_operations o ON ${operation}
      WHERE p.trialStamp=1 AND p.purpose='exchange' AND entitlements.project=p.project
        AND entitlements.feature=p.feature AND entitlements.license_fingerprint=p.fingerprint
        AND entitlements.authority_revision=p.entitlementRevision)`;
const createDevice = input + `INSERT INTO device_bound_devices
  (id,customer_id,project,key_id,public_key_spki,label,created_at,last_proof_at)
  SELECT p.deviceId,p.customerId,p.project,p.keyId,p.publicKeySpki,p.deviceLabel,o.committed_at,o.committed_at
  FROM p JOIN device_bound_operations o ON ${operation}
  WHERE p.purpose='exchange' AND NOT EXISTS (SELECT 1 FROM device_bound_devices d WHERE d.id=p.deviceId)`;
const createBinding = input + `INSERT INTO device_bound_bindings
  (id,project,feature,license_fingerprint,device_id,created_at,updated_at)
  SELECT p.bindingId,p.project,p.feature,p.fingerprint,p.deviceId,o.committed_at,o.committed_at
  FROM p JOIN device_bound_operations o ON ${operation}
  WHERE p.purpose='exchange' AND NOT EXISTS (SELECT 1 FROM device_bound_bindings b WHERE b.id=p.bindingId)`;
const consumeChallenge = input + `UPDATE device_bound_challenges
  SET consumed_invocation_id=(SELECT invocationId FROM p)
  WHERE EXISTS (SELECT 1 FROM p JOIN device_bound_operations o ON ${operation}
    WHERE ${challenge.replaceAll("c.", "device_bound_challenges.")})`;
const consumeApproval = input + `UPDATE device_bound_authorizations SET status='consumed', revision=revision+1,
  consumed_invocation_id=(SELECT invocationId FROM p), consumed_operation_id=(SELECT operationId FROM p),
  recovery_until=(SELECT o.retain_until FROM p JOIN device_bound_operations o ON ${operation}), approval_ciphertext=NULL
  WHERE EXISTS (SELECT 1 FROM p JOIN device_bound_operations o ON ${operation}
    WHERE p.purpose='exchange' AND ${approved.replaceAll("a.", "device_bound_authorizations.")})`;
const updateBinding = input + `UPDATE device_bound_bindings
  SET hold_until=MAX(hold_until,(SELECT acceptUntil FROM p)), revision=revision+1,
    updated_at=(SELECT committed_at FROM p JOIN device_bound_operations o ON ${operation})
  WHERE EXISTS (SELECT 1 FROM p JOIN device_bound_operations o ON ${operation}
    WHERE ${activeBinding.replaceAll("b.", "device_bound_bindings.")})`;
const updateDevice = input + `UPDATE device_bound_devices SET last_proof_at=
  (SELECT o.committed_at FROM p JOIN device_bound_operations o ON ${operation})
  WHERE EXISTS (SELECT 1 FROM p JOIN device_bound_operations o ON ${operation}
    WHERE ${activeDevice.replaceAll("d.", "device_bound_devices.")})`;
const issueLease = input + `INSERT INTO device_bound_leases
  (id,binding_id,generation,entitlement_revision,invocation_id,issued_at,expires_at,accept_until,token)
  SELECT p.leaseId,p.bindingId,p.generation,p.entitlementRevision+p.trialStamp,p.invocationId,p.issuedAt,p.expiresAt,p.acceptUntil,p.token
  FROM p JOIN device_bound_operations o ON ${operation}`;
const audit = input + `INSERT INTO device_bound_events(invocation_id,binding_id,customer_id,event_type,actor,occurred_at)
  SELECT p.invocationId,p.bindingId,p.customerId,p.purpose,p.keyId,o.committed_at
  FROM p JOIN device_bound_operations o ON ${operation}`;

// Prove the exact causal chain, not merely that rows with an invocation exist.
const finalize = input + `UPDATE device_bound_operations SET status='complete'
  WHERE EXISTS (SELECT 1 FROM p JOIN entitlements e ON ${owned("p.entitlementRevision+p.trialStamp", false)}
    JOIN customers owner ON owner.id=p.customerId AND owner.status='active' AND owner.authority_revision=p.customerRevision
    JOIN device_bound_devices d ON ${activeDevice} AND d.last_proof_at=device_bound_operations.committed_at
    JOIN device_bound_bindings b ON b.id=p.bindingId AND b.device_id=d.id AND b.project=e.project
      AND b.feature=e.feature AND b.license_fingerprint=e.license_fingerprint AND b.state='active'
      AND b.generation=p.generation AND b.revision=p.bindingRevision+1 AND b.hold_until>=p.acceptUntil
    JOIN device_bound_leases l ON l.id=p.leaseId AND l.binding_id=b.id AND l.generation=b.generation
      AND l.entitlement_revision=e.authority_revision AND l.invocation_id=p.invocationId
      AND l.issued_at=p.issuedAt AND l.expires_at=p.expiresAt AND l.accept_until=p.acceptUntil AND l.token=p.token
    JOIN device_bound_events audit ON audit.invocation_id=p.invocationId AND audit.binding_id=b.id
      AND audit.customer_id=p.customerId AND audit.actor=p.keyId AND audit.event_type=p.purpose
    JOIN device_bound_challenges c ON c.id=p.challengeId AND c.consumed_invocation_id=p.invocationId
      AND c.operation_id=p.operationId AND c.key_id=p.keyId AND c.subject_id=p.subjectId
      AND c.purpose=p.purpose AND c.nonce_hash=p.nonceHash AND c.expires_at=p.challengeExpiresAt AND c.expires_at>unixepoch()
    WHERE device_bound_operations.invocation_id=p.invocationId AND device_bound_operations.status='prepared'
      AND p.expiresAt>unixepoch()
      AND (e.is_trial=0 OR p.expiresAt<=${boundTrialDeadlineSql("e", "p.issuedAt")})
      AND (p.trialStamp=0 OR (e.trial_started_at=device_bound_operations.committed_at AND e.trial_device_hash=p.keyId))
      AND (p.purpose='renew' OR EXISTS (SELECT 1 FROM device_bound_authorizations a
        WHERE a.handle_hash=p.subjectId AND a.status='consumed' AND a.revision=p.attemptRevision+1
          AND a.consumed_invocation_id=p.invocationId AND a.consumed_operation_id=p.operationId
          AND a.customer_id=p.customerId AND a.key_id=p.keyId AND a.project=p.project
          AND a.feature=p.feature AND a.license_fingerprint=p.fingerprint
          AND a.code_hash=p.codeHash AND a.pkce_challenge=p.pkceChallenge AND a.redirect_uri=p.redirectUri
          AND a.expires_at>unixepoch() AND a.code_expires_at>unixepoch())))`;
const assertComplete = input + `INSERT INTO device_bound_commit_checks(invocation_id,ok)
  SELECT p.invocationId, CASE WHEN EXISTS (SELECT 1 FROM device_bound_operations o
    WHERE o.invocation_id=p.invocationId AND o.status='complete' AND o.key_id=p.keyId
      AND o.purpose=p.purpose AND o.operation_id=p.operationId AND o.request_digest=p.requestDigest
      AND o.binding_id=p.bindingId AND o.lease_id=p.leaseId AND o.response_json=p.responseJson) THEN 1 ELSE 0 END FROM p`;
const removeCheck = input + `DELETE FROM device_bound_commit_checks WHERE invocation_id=(SELECT invocationId FROM p)`;
const result = input + `SELECT response_json FROM device_bound_operations WHERE invocation_id=(SELECT invocationId FROM p) AND status='complete'`;

export const BOUND_LEASE_COMMIT_SQL = Object.freeze([
  BOUND_LEASE_GUARD_SQL, stampTrial, createDevice, createBinding, consumeChallenge, consumeApproval,
  updateBinding, updateDevice, issueLease, audit, finalize, assertComplete, removeCheck, result,
]);

export async function commitBoundDeviceLease(db, candidate) {
  if (!db.batch) throw new Error("atomic_batch_required");
  if (!candidate || !["exchange", "renew"].includes(candidate.purpose)) throw new Error("invalid_candidate");
  const response = JSON.parse(candidate.responseJson);
  const expectedCode = candidate.purpose === "exchange" ? "device_activated" : "device_renewed";
  if (!response || response.ok !== true || response.code !== expectedCode || typeof response.request_id !== "string"
    || response.data?.binding_id !== candidate.bindingId || response.data?.lease !== candidate.token
    || response.data?.expires_at !== candidate.expiresAt) throw new Error("invalid_candidate_response");
  // Fresh invocation is deliberately generated here, not selected by callers.
  const invocationId = crypto.randomUUID();
  const encoded = JSON.stringify({trialStamp: 0, ...candidate, invocationId});
  const results = await db.batch(BOUND_LEASE_COMMIT_SQL.map(sql => db.prepare(sql).bind(encoded)));
  const row = results.at(-1)?.results?.[0];
  if (!row || row.response_json !== candidate.responseJson) throw new Error("commit_result_unavailable");
  return { invocationId, response };
}
