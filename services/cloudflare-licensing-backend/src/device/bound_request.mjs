import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";

import { UnsignedJsonError as BoundRequestError, parseUnsignedJson as parseBoundJson, readUnsignedJson as readBoundJson } from "@licensecc/cloudflare-runtime/http/unsigned_json";
export { BoundRequestError, parseBoundJson, readBoundJson };
/** @returns {never} */
function invalid() { throw new BoundRequestError(); }
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
// The approval page shows the label beside the real comparison code, so a label may not hold a
// C0 or C1 control or DEL, a line or paragraph separator, a bidi or format control, or text
// shaped like a comparison code that tells the approver which code to match. The native client
// applies the same rule before it sends a label.
// eslint-disable-next-line no-control-regex -- control characters are rejected deliberately
const MISLEADING_LABEL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}/u;

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function text(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
}
function bytes(value, size) {
  try { if (decodeBase64url(value, size).length !== size) invalid(); }
  catch { invalid(); }
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid();
}
function proof(value) {
  if (value === undefined) throw new BoundRequestError("proof_required", 401);
  exact(value, ["key_id", "challenge_id", "nonce", "expires_at", "signature"]);
  text(value.key_id, /^sha256:[a-f0-9]{64}$/);
  bytes(value.challenge_id, 16); bytes(value.nonce, 32);
  integer(value.expires_at); bytes(value.signature, 64);
}

// Syntax validation only: callers must resolve the registry, import/re-export
// SPKI, verify proof and enforce current database authority separately.
export function validateBoundRequest(operation, value) {
  if (operation === "authorize") {
    exact(value, ["client_id", "project", "requested_feature", "public_key_spki", "device_label", "redirect_uri", "state", "code_challenge", "code_challenge_method"]);
    text(value.client_id, /^[A-Za-z0-9_.:-]{1,127}$/);
    text(value.project, /^[A-Za-z0-9_.:-]{1,127}$/);
    text(value.requested_feature, /^[A-Za-z0-9_.:-]{1,15}$/);
    if (typeof value.public_key_spki !== "string" || value.public_key_spki.length > 512) invalid();
    try { if (!decodeBase64url(value.public_key_spki, 384).length) invalid(); } catch { invalid(); }
    if (typeof value.device_label !== "string") invalid();
    const label = value.device_label.trim();
    if ([...label].length < 1 || [...label].length > 80 || utf8.decode(encoder.encode(label)) !== label
        || MISLEADING_LABEL.test(label)) invalid();
    bytes(value.state, 32); bytes(value.code_challenge, 32);
    if (value.code_challenge_method !== "S256") throw new BoundRequestError("unsupported_protocol");
    callbackSyntax(value.redirect_uri);
    return { ...value, device_label: label };
  }
  if (operation === "challenge") {
    if (value?.purpose !== "exchange" && value?.purpose !== "renew") invalid();
    const subject = value.purpose === "exchange" ? "attempt_handle" : "binding_id";
    exact(value, ["purpose", subject, "operation_id"]);
    bytes(value[subject], value.purpose === "exchange" ? 32 : 16);
  } else if (operation === "exchange") {
    if (value && !Object.hasOwn(value, "proof")) proof(undefined);
    exact(value, ["attempt_handle", "code", "code_verifier", "redirect_uri", "operation_id", "proof"]);
    bytes(value.attempt_handle, 32); bytes(value.code, 32); bytes(value.code_verifier, 32);
    callbackSyntax(value.redirect_uri); proof(value.proof);
  } else if (operation === "renew") {
    if (value && !Object.hasOwn(value, "proof")) proof(undefined);
    exact(value, ["binding_id", "generation", "operation_id", "proof"]);
    bytes(value.binding_id, 16); integer(value.generation, 1); proof(value.proof);
  } else invalid();
  bytes(value.operation_id, 32);
  return value;
}

function callbackSyntax(value) {
  if (typeof value !== "string" || value.length > 1024
      || value.includes("?") || value.includes("#")
      || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\//.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.href !== value || url.username || url.password || url.search || url.hash) invalid();
  return url;
}

// Registry records are deployment configuration, never supplied by the client.
// Each record owns one project and explicitly enumerates loopback IPs and paths.
export function validateBoundClient(request, registry) {
  const client = registry.find(entry => entry.client_id === request.client_id);
  if (!client || client.project !== request.project) throw new BoundRequestError("access_denied", 403);
  const url = callbackSyntax(request.redirect_uri);
  if (!client.callbacks.some(callback => callback.host === url.hostname && callback.path === url.pathname)) {
    throw new BoundRequestError("access_denied", 403);
  }
  return client;
}
