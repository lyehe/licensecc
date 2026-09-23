import { encodeBase64url, deviceOperationBody, deviceOperationDigestInput } from "@licensecc/licensing-domain/lease/device_protocol";
import { deviceLeaseWindow } from "@licensecc/licensing-domain/lease/device_policy";
import { BoundRequestError, validateBoundRequest } from "./bound_request.mjs";
import { boundRandomId, boundSecretHash } from "./bound_enrollment.mjs";
import { sha256Hex, verifyBoundDeviceProof, signBoundDeviceLease } from "./bound_crypto.mjs";
import { commitBoundDeviceLease } from "./bound_store.mjs";
import { recoverBoundDeviceLease } from "./bound_recovery.mjs";
import { limitBoundVerified } from "./bound_rate.mjs";
import { boundTrialState } from "./bound_trial.mjs";

/** @returns {never} */
function deny(code, status) { throw new BoundRequestError(code, status); }

async function prove(db, purpose, request, config) {
  const subjectId = purpose === "exchange" ? await boundSecretHash(request.attempt_handle) : request.binding_id;
  const subject = purpose === "exchange"
    ? await db.prepare("SELECT a.*,unixepoch() AS now FROM device_bound_authorizations a WHERE handle_hash=?").bind(subjectId).first()
    : await db.prepare(`SELECT b.*,d.key_id,d.public_key_spki,d.customer_id,unixepoch() AS now
        FROM device_bound_bindings b JOIN device_bound_devices d ON d.id=b.device_id WHERE b.id=?`).bind(subjectId).first();
  if (!subject) deny(purpose === "exchange" ? "authorization_unavailable" : "binding_unavailable", 404);
  const challenge = await db.prepare("SELECT *,unixepoch() AS now FROM device_bound_challenges WHERE id=?").bind(request.proof.challenge_id).first();
  const nonceHash = await boundSecretHash(request.proof.nonce);
  if (!challenge || challenge.subject_id !== subjectId || challenge.key_id !== subject.key_id
      || challenge.key_id !== request.proof.key_id || challenge.purpose !== purpose
      || challenge.operation_id !== request.operation_id || challenge.nonce_hash !== nonceHash
      || challenge.expires_at !== request.proof.expires_at || challenge.consumed_invocation_id !== null) deny("invalid_proof", 401);
  if (challenge.expires_at <= challenge.now) deny("challenge_expired", 410);
  const { proof, ...semantic } = request;
  const bodyHash = await sha256Hex(deviceOperationBody(purpose, semantic));
  const signed = { audience: config.audience, method: "POST",
    path: purpose === "exchange" ? "/v2/device-authorizations/exchange" : "/v2/device-leases/renew",
    key_id: subject.key_id, operation_id: request.operation_id, body_sha256: bodyHash,
    challenge_id: challenge.id, nonce: proof.nonce, expires_at: challenge.expires_at };
  if (!await verifyBoundDeviceProof(subject.public_key_spki, signed, proof.signature)) deny("invalid_proof", 401);
  const requestDigest = await sha256Hex(deviceOperationDigestInput(purpose, subject.key_id, semantic));
  return { subject, subjectId, challenge, nonceHash, requestDigest };
}

async function authority(db, purpose, request, verified, operation) {
  const { subject } = verified;
  if (purpose === "exchange") {
    if (!["approved", "consumed"].includes(subject.status)) deny("authorization_unavailable", 404);
    const pkce = encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.code_verifier))));
    if (subject.code_hash !== await boundSecretHash(request.code) || subject.pkce_challenge !== pkce
        || subject.redirect_uri !== request.redirect_uri) deny("access_denied", 403);
    if (!operation && (subject.status !== "approved" || subject.expires_at <= subject.now || subject.code_expires_at <= subject.now)) deny("authorization_expired", 410);
    if (operation && (subject.status !== "consumed" || subject.consumed_operation_id !== request.operation_id
        || subject.consumed_invocation_id !== operation.invocation_id)) deny("authorization_unavailable", 404);
  }
  const entitlement = await db.prepare(`SELECT e.*,c.status AS customer_status,c.authority_revision AS customer_revision,unixepoch() AS now
    FROM entitlements e JOIN customers c ON c.id=e.customer_id
    WHERE e.project=? AND e.feature=? AND e.license_fingerprint=? AND e.customer_id=?`)
    .bind(subject.project, subject.feature, subject.license_fingerprint, subject.customer_id).first();
  if (!entitlement || entitlement.status !== "active" || entitlement.customer_status !== "active"
      || entitlement.pool_size !== 0
      || (entitlement.valid_from !== null && entitlement.valid_from > entitlement.now)
      || (entitlement.valid_until !== null && entitlement.valid_until <= entitlement.now)) deny("access_denied", 403);
  if (entitlement.enforcement_mode !== "device_bound_v1") deny("legacy_protocol_disabled", 403);
  const trial = boundTrialState(entitlement, subject.key_id, entitlement.now, purpose === "exchange" && !operation);
  if (!trial || (trial.stamp && entitlement.authority_revision >= Number.MAX_SAFE_INTEGER)) deny("access_denied", 403);
  const device = await db.prepare("SELECT * FROM device_bound_devices WHERE key_id=?").bind(subject.key_id).first();
  if (device && (device.customer_id !== subject.customer_id || device.project !== subject.project)) deny("access_denied", 403);
  if (device && device.status !== "active") deny("device_retired", 403);
  if (device && device.public_key_spki !== subject.public_key_spki) deny("invalid_proof", 401);
  const binding = operation || purpose === "renew"
    ? await db.prepare("SELECT * FROM device_bound_bindings WHERE id=?").bind(operation ? operation.binding_id : request.binding_id).first()
    : device ? await db.prepare(`SELECT * FROM device_bound_bindings WHERE device_id=? AND project=? AND feature=?
        AND license_fingerprint=? AND state='active'`).bind(device.id, subject.project, subject.feature, subject.license_fingerprint).first() : null;
  if (binding && (binding.device_id !== device?.id || binding.project !== subject.project || binding.feature !== subject.feature
      || binding.license_fingerprint !== subject.license_fingerprint)) deny("access_denied", 403);
  if (binding && binding.state !== "active") deny("device_retired", 403);
  if ((operation || purpose === "renew") && (!binding || !device)) deny("binding_unavailable", 404);
  if (purpose === "renew" && binding.generation !== request.generation) deny("revision_conflict", 409);
  if (!binding) {
    const capacity = await db.prepare(`SELECT count(*) AS occupied FROM device_bound_bindings WHERE project=? AND feature=?
      AND license_fingerprint=? AND (state='active' OR (state='retiring' AND hold_until>unixepoch()))`)
      .bind(subject.project, subject.feature, subject.license_fingerprint).first();
    if (capacity.occupied >= entitlement.max_active_devices) {
      const created = await db.prepare(`SELECT b.id FROM device_bound_bindings b JOIN device_bound_devices d ON d.id=b.device_id
        WHERE d.key_id=? AND b.project=? AND b.feature=? AND b.license_fingerprint=? AND b.state='active'`)
        .bind(subject.key_id, subject.project, subject.feature, subject.license_fingerprint).first();
      if (created) deny("temporarily_unavailable", 503);
      deny("device_limit_reached", 409);
    }
  }
  return { entitlement, device, binding, trial };
}

// Route supplies a primary-session DB and independently purposed signer loader.
// No caller-provided revision, customer id, key material or timestamp is used
// as an authority snapshot. Every snapshot is rechecked by the commit batch.
export async function issueBoundLease(db, purpose, input, config, loadSigner, requestId) {
  const request = validateBoundRequest(purpose, input);
  const verified = await prove(db, purpose, request, config);
  const operation = await db.prepare(`SELECT *,unixepoch() AS now FROM device_bound_operations
    WHERE key_id=? AND purpose=? AND operation_id=?`).bind(verified.subject.key_id, purpose, request.operation_id).first();
  if (operation && operation.request_digest !== verified.requestDigest) deny("idempotency_conflict", 409);
  if (operation && (operation.status !== "complete" || operation.response_json === "" || operation.retain_until <= operation.now)) deny("idempotency_conflict", 409);
  if (operation && purpose === "exchange") {
    // A concurrent invocation may have consumed the approval while this request
    // verified its signature. Observe that commit's current attempt, not the
    // earlier approved snapshot; otherwise recovery gets a false terminal 404.
    const current = await db.prepare(`SELECT *,unixepoch() AS now FROM device_bound_authorizations
      WHERE handle_hash=? AND key_id=? AND public_key_spki=?`)
      .bind(verified.subjectId, verified.subject.key_id, verified.subject.public_key_spki).first();
    if (!current) deny("temporarily_unavailable", 503);
    verified.subject = current;
  }
  let snapshot;
  try { snapshot = await authority(db, purpose, request, verified, operation); }
  catch (error) {
    if (!operation && error instanceof BoundRequestError
        && ["authorization_expired", "authorization_unavailable", "device_limit_reached", "binding_unavailable"].includes(error.code)) {
      // A later capacity/authority read may observe a competing commit that the
      // earlier operation lookup missed. Preserve an unknown outcome instead
      // of returning a misleading terminal denial from those mixed snapshots.
      const committed = await db.prepare(`SELECT 1 AS present FROM device_bound_operations
        WHERE key_id=? AND purpose=? AND operation_id=?`).bind(verified.subject.key_id, purpose, request.operation_id).first();
      if (committed) deny("temporarily_unavailable", 503);
    }
    throw error;
  }
  const { entitlement: e, device, binding, trial } = snapshot;
  const a = verified.subject;
  const candidate = { purpose, keyId: a.key_id, operationId: request.operation_id, requestDigest: verified.requestDigest,
    customerId: e.customer_id, customerRevision: e.customer_revision, project: e.project, feature: e.feature,
    fingerprint: e.license_fingerprint, entitlementRevision: e.authority_revision, trialStamp: trial.stamp,
    deviceId: device?.id ?? boundRandomId(), deviceRevision: device?.revision ?? 0,
    publicKeySpki: a.public_key_spki, deviceLabel: purpose === "exchange" ? a.device_label : device.label,
    bindingId: binding?.id ?? boundRandomId(), bindingRevision: binding?.revision ?? 0, generation: binding?.generation ?? 1,
    challengeId: verified.challenge.id, challengeExpiresAt: verified.challenge.expires_at,
    nonceHash: verified.nonceHash, subjectId: verified.subjectId,
    attemptRevision: purpose === "exchange" ? a.revision : null,
    codeHash: purpose === "exchange" ? a.code_hash : null,
    pkceChallenge: purpose === "exchange" ? a.pkce_challenge : null,
    redirectUri: purpose === "exchange" ? a.redirect_uri : null };
  if (operation) return (await recoverBoundDeviceLease(db, candidate)).response;
  // Replaying a committed operation returns the stored lease; never rate-limit reconciliation.
  await limitBoundVerified(db, a.key_id, e.customer_id, Math.max(240, 2 * (e.max_active_devices ?? 0)));
  let window;
  try { window = deviceLeaseWindow(e.now, Math.min(e.valid_until ?? Number.MAX_SAFE_INTEGER,
    trial.expiresAt ?? Number.MAX_SAFE_INTEGER,
    e.lease_seconds > 0 ? e.now + e.lease_seconds : Number.MAX_SAFE_INTEGER)); }
  catch { deny("access_denied", 403); }
  const signer = await loadSigner();
  const leaseId = boundRandomId();
  const claims = { version: 1, purpose: "device-lease", "key-id": signer.keyId, issuer: config.issuer,
    audience: config.audience, project: e.project, feature: e.feature, "license-fingerprint": e.license_fingerprint,
    "binding-id": candidate.bindingId, "device-key-id": candidate.keyId, generation: candidate.generation,
    "revocation-seq": e.revocation_seq, "lease-id": leaseId, "operation-id": request.operation_id,
    "issued-at": window.issuedAt, "renew-after": window.renewAfter, "expires-at": window.expiresAt };
  const token = await signBoundDeviceLease(claims, signer.privateKey, signer.publicKey);
  const response = { ok: true, code: purpose === "exchange" ? "device_activated" : "device_renewed", request_id: requestId,
    data: { device_id: candidate.deviceId, binding_id: candidate.bindingId, generation: candidate.generation,
      entitlement: { project: e.project, feature: e.feature, license_fingerprint: e.license_fingerprint },
      lease: token, renew_after: window.renewAfter, expires_at: window.expiresAt, accept_until: window.acceptUntil } };
  // A thrown commit/recovery error is an unknown outcome. The route maps it to
  // 503; the client preserves intent and obtains a fresh challenge to reconcile.
  return (await commitBoundDeviceLease(db, { ...candidate, leaseId, ...window, token, responseJson: JSON.stringify(response) })).response;
}
