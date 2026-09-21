import { encodeBase64url, deviceEnrollmentComparisonInput, formatDeviceEnrollmentComparison } from "@licensecc/licensing-domain/lease/device_protocol";
import { importBoundDeviceKey, sha256Hex } from "./bound_crypto.mjs";
import { BoundRequestError, validateBoundClient, validateBoundRequest } from "./bound_request.mjs";
import { boundTrialSql } from "./bound_trial.mjs";

const encoder = new TextEncoder();
export const boundSecretHash = value => sha256Hex(encoder.encode(value));
export const boundRandomId = (size = 16) => encodeBase64url(crypto.getRandomValues(new Uint8Array(size)));
export async function boundEnrollmentComparison(input) {
  return formatDeviceEnrollmentComparison(new Uint8Array(await crypto.subtle.digest("SHA-256",deviceEnrollmentComparisonInput(input))));
}

// Called only after the route's mandatory rate limit. Registry and portal URL
// come from validated deployment configuration, never Host or request headers.
export async function createBoundAuthorization(db, input, config) {
  const request = validateBoundRequest("authorize", input);
  validateBoundClient(request, config.clients);
  const destination = new URL(config.authorizationUrl);
  if (destination.protocol !== "https:" || destination.username || destination.password || destination.search || destination.hash) {
    throw new BoundRequestError("temporarily_unavailable", 503);
  }
  let device;
  try { device = await importBoundDeviceKey(request.public_key_spki); }
  catch { throw new BoundRequestError(); }
  const handle = boundRandomId(32);
  const hash = await boundSecretHash(handle);
  const row = await db.prepare(`INSERT INTO device_bound_authorizations
    (handle_hash,client_id,project,key_id,public_key_spki,device_label,redirect_uri,client_state,pkce_challenge,requested_feature,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch()+300) RETURNING expires_at`)
    .bind(hash, request.client_id, request.project, device.keyId, request.public_key_spki,
      request.device_label, request.redirect_uri, request.state, request.code_challenge, request.requested_feature ?? null).first();
  if (!row) throw new BoundRequestError("temporarily_unavailable", 503);
  // Fragment keeps the secret handle out of the portal's initial HTTP URL/logs.
  // The browser UI later posts it to the authenticated inspection endpoint.
  destination.hash = new URLSearchParams({ attempt_handle: handle }).toString();
  const comparison_code=await boundEnrollmentComparison({attempt_handle:handle,client_id:request.client_id,project:request.project,key_id:device.keyId,
    redirect_uri:request.redirect_uri,state:request.state,code_challenge:request.code_challenge,
    ...(request.requested_feature ? {requested_feature:request.requested_feature} : {})});
  return { attempt_handle: handle, authorization_url: destination.href, expires_at: row.expires_at, comparison_code };
}

const exchangeSubject = `SELECT a.handle_hash AS subject_id,a.key_id,
  CASE WHEN a.status='consumed' THEN min(a.recovery_until,o.retain_until) ELSE a.expires_at END AS deadline
  FROM device_bound_authorizations a
  LEFT JOIN device_bound_operations o ON o.key_id=a.key_id AND o.purpose='exchange'
    AND o.operation_id=a.consumed_operation_id AND o.invocation_id=a.consumed_invocation_id
    AND o.customer_id=a.customer_id AND o.status='complete' AND o.response_json<>''
  WHERE a.handle_hash=? AND (
    (a.status='pending' AND a.expires_at>unixepoch())
    OR (a.status='approved' AND a.expires_at>unixepoch() AND a.code_expires_at>unixepoch())
    OR (a.status='consumed' AND a.consumed_operation_id=?
      AND a.recovery_until>unixepoch() AND o.retain_until>unixepoch()))`;
const renewSubject = `SELECT b.id AS subject_id,d.key_id,unixepoch()+60 AS deadline
  FROM device_bound_bindings b JOIN device_bound_devices d ON d.id=b.device_id
  JOIN entitlements e ON e.project=b.project AND e.feature=b.feature AND e.license_fingerprint=b.license_fingerprint
  JOIN customers c ON c.id=d.customer_id AND c.id=e.customer_id
  WHERE b.id=? AND b.state='active' AND d.status='active' AND c.status='active'
    AND e.status='active' AND e.enforcement_mode='device_bound_v1' AND e.pool_size=0
    AND ${boundTrialSql("e", "d.key_id", "unixepoch()", false)}
    AND (e.valid_from IS NULL OR e.valid_from<=unixepoch())
    AND (e.valid_until IS NULL OR e.valid_until>unixepoch())`;

// Challenge admission and its deadline are computed in the INSERT itself.
// A challenge grants no license; proof, current authority and single-use
// consumption remain mandatory in the later atomic issuance/recovery batch.
export async function createBoundChallenge(db, input) {
  const request = validateBoundRequest("challenge", input);
  const id = boundRandomId(), nonce = boundRandomId(32);
  const hash = await boundSecretHash(nonce);
  const exchange = request.purpose === "exchange";
  const subjectValues = exchange
    ? [await boundSecretHash(request.attempt_handle), request.operation_id]
    : [request.binding_id];
  const row = await db.prepare(`WITH subject AS (${exchange ? exchangeSubject : renewSubject})
    INSERT INTO device_bound_challenges(id,purpose,subject_id,key_id,operation_id,nonce_hash,created_at,expires_at)
    SELECT ?,?,s.subject_id,s.key_id,?,?,unixepoch(),min(unixepoch()+60,s.deadline)
    FROM subject s WHERE s.deadline>unixepoch() RETURNING expires_at`)
    .bind(...subjectValues, id, request.purpose, request.operation_id, hash).first();
  if (!row) throw new BoundRequestError(exchange ? "authorization_unavailable" : "binding_unavailable", 404);
  return { challenge_id: id, nonce, expires_at: row.expires_at };
}
