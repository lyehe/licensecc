import { encodeBase64url, decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";
import { BoundRequestError, validateBoundClient } from "./bound_request.mjs";
import { boundRandomId, boundSecretHash, boundEnrollmentComparison } from "./bound_enrollment.mjs";
import { sealBoundApproval, openBoundApproval } from "./bound_approval_crypto.mjs";
import { CONSENT_PAGE_SQL, consentPageCursor, readConsentPageCursor } from "./bound_consent_page.mjs";
import { boundTrialSql, boundTrialState } from "./bound_trial.mjs";

/** @returns {never} */
function deny(code, status) { throw new BoundRequestError(code, status); }
const encode = value => encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
const entitlementId = row => encode([row.project, row.feature, row.license_fingerprint]);

function selectedId(value) {
  try {
    const tuple = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64url(value, 512)));
    if (!Array.isArray(tuple) || tuple.length !== 3 || encode(tuple) !== value
        || typeof tuple[0] !== "string" || !/^[A-Za-z0-9_.:-]{1,127}$/.test(tuple[0])
        || typeof tuple[1] !== "string" || !/^[A-Za-z0-9_.:-]{1,15}$/.test(tuple[1])
        || typeof tuple[2] !== "string" || !/^[a-f0-9]{64}$/.test(tuple[2])) deny("invalid_request", 400);
    return tuple;
  } catch { deny("invalid_request", 400); }
}

async function attemptForCustomer(db, customerId, handle, config) {
  try { if (decodeBase64url(handle, 32).length !== 32) deny("invalid_request", 400); }
  catch { deny("invalid_request", 400); }
  if (typeof customerId !== "string" || !customerId || customerId.length > 256) deny("access_denied", 403);
  const owner = await db.prepare("SELECT status,authority_revision FROM customers WHERE id=?").bind(customerId).first();
  if (!owner || owner.status !== "active") deny("access_denied", 403);
  const hash = await boundSecretHash(handle);
  const attempt = await db.prepare("SELECT *,unixepoch() AS now FROM device_bound_authorizations WHERE handle_hash=?").bind(hash).first();
  if (!attempt) deny("authorization_unavailable", 404);
  if (attempt.customer_id !== null && attempt.customer_id !== customerId) deny("access_denied", 403);
  const client = validateBoundClient({ client_id: attempt.client_id, project: attempt.project, redirect_uri: attempt.redirect_uri }, config.clients);
  return { attempt, owner, client };
}

// This module is an internal use-case boundary. The named consent
// service entrypoint supplies a portal-session-derived customer, never a public
// request header. Do not register these helpers as public backend HTTP routes.
export async function inspectBoundAuthorization(db, customerId, handle, config, pageCursor) {
  try {if(decodeBase64url(handle,32).length!==32)deny("invalid_request",400);}catch{deny("invalid_request",400);}
  if(typeof customerId!=="string" || !customerId || customerId.length>256)deny("access_denied",403);
  const hash=await boundSecretHash(handle),customerHash=await boundSecretHash(customerId);
  const after=readConsentPageCursor(pageCursor,hash,customerHash);
  const result=await db.prepare(CONSENT_PAGE_SQL).bind(customerId,hash,customerId,customerId,...after).all();
  const a=result.results[0];
  if(!a || a.current_customer_status!=="active")deny("access_denied",403);
  if(!a.handle_hash)deny("authorization_unavailable",404);
  if(a.customer_id!==null && a.customer_id!==customerId)deny("access_denied",403);
  if (a.expires_at <= a.now && a.status !== "consumed") deny("authorization_expired", 410);
  const client=validateBoundClient({client_id:a.client_id,project:a.project,redirect_uri:a.redirect_uri},config.clients);
  const rows=result.results.filter(row=>row.page_fingerprint!==null),has_more=rows.length>100;
  const comparison_code=await boundEnrollmentComparison({attempt_handle:handle,client_id:a.client_id,project:a.project,key_id:a.key_id,
    redirect_uri:a.redirect_uri,state:a.client_state,code_challenge:a.pkce_challenge,
    ...(a.requested_feature ? {requested_feature:a.requested_feature} : {})});
  return { app: { name: client.display_name, project: a.project }, device: { label: a.device_label },
    status: a.status, revision: a.revision, expires_at: a.expires_at, comparison_code,
    entitlements: rows.slice(0,100).map(row=>({id:entitlementId({project:a.project,feature:row.page_feature,license_fingerprint:row.page_fingerprint}),
      feature:row.page_feature,valid_until:row.page_valid_until,device_limit:row.page_device_limit,
      ...(row.page_activation_trial_seconds===null?{}:{activation_trial_seconds:row.page_activation_trial_seconds})})),has_more,
    next_page_cursor:has_more?consentPageCursor(hash,customerHash,rows[99]):null };
}

async function approvedResponse(db, a, customerId, input, digest, keyRing) {
  if (a.status !== "approved" || a.code_expires_at <= a.now || a.expires_at <= a.now || !a.approval_ciphertext) deny("authorization_expired", 410);
  if (a.customer_id !== customerId) deny("access_denied", 403);
  const saved = await openBoundApproval(a.approval_ciphertext, a.handle_hash, a.revision, keyRing);
  if (saved.operation_id !== input.operation_id || saved.request_digest !== digest) deny("idempotency_conflict", 409);
  // Decryption can yield while the code expires or another invocation consumes
  // it. Admit recovery only after crypto, against this exact still-live blob.
  const current = await db.prepare(`SELECT 1 AS eligible FROM device_bound_authorizations a
    JOIN entitlements e ON e.project=a.project AND e.feature=a.feature AND e.license_fingerprint=a.license_fingerprint
    JOIN customers c ON c.id=a.customer_id AND c.id=e.customer_id
    WHERE a.handle_hash=? AND a.revision=? AND a.approval_ciphertext=? AND a.customer_id=? AND a.status='approved'
      AND a.code_expires_at>unixepoch() AND a.expires_at>unixepoch()
      AND (a.requested_feature IS NULL OR a.feature=a.requested_feature)
      AND e.status='active' AND c.status='active' AND e.enforcement_mode='device_bound_v1' AND e.pool_size=0
      AND ${boundTrialSql("e","a.key_id")}
      AND (e.valid_from IS NULL OR e.valid_from<=unixepoch()) AND (e.valid_until IS NULL OR e.valid_until>unixepoch())`)
    .bind(a.handle_hash, a.revision, a.approval_ciphertext, customerId).first();
  if (!current) deny("access_denied", 403);
  return saved.response;
}

export async function approveBoundAuthorization(db, customerId, input, config, keyRing) {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 4
      || !["attempt_handle", "entitlement_id", "expected_attempt_revision", "operation_id"].every(k => Object.hasOwn(input, k))
      || !Number.isSafeInteger(input.expected_attempt_revision) || input.expected_attempt_revision < 0
      || input.expected_attempt_revision >= Number.MAX_SAFE_INTEGER || typeof input.operation_id !== "string"
      || !/^[A-Za-z0-9_-]{16,128}$/.test(input.operation_id)) deny("invalid_request", 400);
  const tuple = selectedId(input.entitlement_id);
  const { attempt: a, owner } = await attemptForCustomer(db, customerId, input.attempt_handle, config);
  if (tuple[0] !== a.project || (a.requested_feature != null && tuple[1] !== a.requested_feature)) deny("access_denied", 403);
  const digest = await boundSecretHash(JSON.stringify(["approve-v1", customerId, input.entitlement_id, input.expected_attempt_revision]));
  if (a.status !== "pending") return approvedResponse(db, a, customerId, input, digest, keyRing);
  if (a.expires_at <= a.now) deny("authorization_expired", 410);
  if (a.revision !== input.expected_attempt_revision) deny("revision_conflict", 409);
  const entitlement = await db.prepare(`SELECT *,unixepoch() AS now FROM entitlements
    WHERE project=? AND feature=? AND license_fingerprint=? AND customer_id=? AND status='active'
      AND enforcement_mode='device_bound_v1' AND pool_size=0
      AND (valid_from IS NULL OR valid_from<=unixepoch()) AND (valid_until IS NULL OR valid_until>unixepoch())`)
    .bind(...tuple, customerId).first();
  if (!entitlement || !boundTrialState(entitlement,a.key_id,entitlement.now)) deny("access_denied", 403);
  const code = boundRandomId(32), expires = Math.min(a.expires_at, entitlement.now + 60);
  const callback = new URL(a.redirect_uri);
  callback.search = new URLSearchParams({ code, state: a.client_state }).toString();
  const response = { callback_url: callback.href, expires_at: expires, revision: a.revision + 1 };
  const ciphertext = await sealBoundApproval({ operation_id: input.operation_id, request_digest: digest, response }, a.handle_hash, a.revision + 1, keyRing);
  const changed = await db.prepare(`UPDATE device_bound_authorizations
    SET status='approved',revision=revision+1,customer_id=?,feature=?,license_fingerprint=?,code_hash=?,code_expires_at=?,approval_ciphertext=?
    WHERE handle_hash=? AND status='pending' AND revision=? AND expires_at>unixepoch() AND ?>unixepoch()
      AND EXISTS(SELECT 1 FROM customers WHERE id=? AND status='active' AND authority_revision=?)
      AND EXISTS(SELECT 1 FROM entitlements e WHERE project=? AND feature=? AND license_fingerprint=? AND customer_id=?
        AND (device_bound_authorizations.requested_feature IS NULL OR e.feature=device_bound_authorizations.requested_feature)
        AND status='active' AND authority_revision=? AND enforcement_mode='device_bound_v1' AND pool_size=0
        AND ${boundTrialSql("e","device_bound_authorizations.key_id")}
        AND (valid_from IS NULL OR valid_from<=unixepoch()) AND (valid_until IS NULL OR valid_until>unixepoch()))
    RETURNING revision`)
    .bind(customerId, tuple[1], tuple[2], await boundSecretHash(code), expires, ciphertext, a.handle_hash, a.revision, expires,
      customerId, owner.authority_revision, ...tuple, customerId, entitlement.authority_revision).first();
  if (changed) return response;
  // A competing approval may have won. Recover only its exact authenticated
  // encrypted response, never this invocation's uncommitted callback code.
  const { attempt: current } = await attemptForCustomer(db, customerId, input.attempt_handle, config);
  if (current.status === "approved") return approvedResponse(db, current, customerId, input, digest, keyRing);
  deny("revision_conflict", 409);
}

export async function denyBoundAuthorization(db, customerId, input, config) {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 3
      || !["attempt_handle", "expected_attempt_revision", "operation_id"].every(k => Object.hasOwn(input, k))
      || !Number.isSafeInteger(input.expected_attempt_revision) || input.expected_attempt_revision < 0
      || input.expected_attempt_revision >= Number.MAX_SAFE_INTEGER || typeof input.operation_id !== "string"
      || !/^[A-Za-z0-9_-]{16,128}$/.test(input.operation_id)) deny("invalid_request", 400);
  const { attempt: a, owner } = await attemptForCustomer(db, customerId, input.attempt_handle, config);
  if (a.expires_at <= a.now) deny("authorization_expired", 410);
  const scope = `bound-deny:${await boundSecretHash(JSON.stringify([customerId,a.handle_hash]))}`;
  const digest = await boundSecretHash(JSON.stringify(["deny-v1",input.expected_attempt_revision]));
  const invocation = boundRandomId(32), revision = input.expected_attempt_revision + 1;
  const response = { status: "authorization_denied", revision };
  const saved = JSON.stringify({ invocation, digest, response });
  const current = `EXISTS(SELECT 1 FROM customers WHERE id=? AND status='active' AND authority_revision=?)`;
  const eligible = `handle_hash=? AND status='pending' AND revision=? AND expires_at>unixepoch() AND ${current}`;
  const eligibleParams = [a.handle_hash,input.expected_attempt_revision,customerId,owner.authority_revision];
  // This cache holds only a safe terminal response, never handles, codes or callback URLs.
  // The final CHECK rolls the entire batch back if either the denial or cache is absent.
  try {
    await db.batch([
      db.prepare(`INSERT INTO mutation_idempotency(scope,idempotency_key,response_json,created_at)
        SELECT ?,?,?,unixepoch() FROM device_bound_authorizations WHERE ${eligible}
        ON CONFLICT(scope,idempotency_key) DO NOTHING`).bind(scope,input.operation_id,saved,...eligibleParams),
      db.prepare(`UPDATE device_bound_authorizations SET status='denied',revision=revision+1
        WHERE ${eligible} AND EXISTS(SELECT 1 FROM mutation_idempotency WHERE scope=? AND idempotency_key=?
          AND json_extract(response_json,'$.invocation')=?)`).bind(...eligibleParams,scope,input.operation_id,invocation),
      db.prepare(`INSERT INTO device_bound_commit_checks(invocation_id,ok) SELECT ?,CASE WHEN
        EXISTS(SELECT 1 FROM device_bound_authorizations WHERE handle_hash=? AND status='denied' AND revision=?
          AND expires_at>unixepoch()) AND ${current}
        AND EXISTS(SELECT 1 FROM mutation_idempotency WHERE scope=? AND idempotency_key=?
          AND json_extract(response_json,'$.digest')=?) THEN 1 ELSE 0 END`)
        .bind(invocation,a.handle_hash,revision,customerId,owner.authority_revision,scope,input.operation_id,digest),
      db.prepare("DELETE FROM device_bound_commit_checks WHERE invocation_id=?").bind(invocation),
    ]);
  } catch {
    // A failed/lost batch response can still mean a committed denial. Reconcile below.
  }
  const committed = await db.prepare(`SELECT m.response_json FROM mutation_idempotency m
    JOIN device_bound_authorizations a ON a.handle_hash=?
    JOIN customers c ON c.id=? AND c.status='active'
    WHERE m.scope=? AND m.idempotency_key=? AND a.status='denied'
      AND a.revision=json_extract(m.response_json,'$.response.revision') AND a.expires_at>unixepoch()`)
    .bind(a.handle_hash,customerId,scope,input.operation_id).first();
  if (committed) {
    const cached = JSON.parse(committed.response_json);
    if (cached.digest !== digest) deny("idempotency_conflict", 409);
    return cached.response;
  }
  if (a.status !== "pending" || a.revision !== input.expected_attempt_revision) deny("revision_conflict", 409);
  deny("temporarily_unavailable", 503);
}
