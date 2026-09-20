import { decodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";

import { UnsignedJsonError as BoundRequestError, parseUnsignedJson as parseBoundJson, readUnsignedJson as readBoundJson } from "@licensecc/cloudflare-runtime/http/unsigned_json";
export { BoundRequestError, parseBoundJson, readBoundJson };
/** @returns {never} */
function invalid() { throw new BoundRequestError(); }
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

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
    exact(value, ["client_id", "project", "public_key_spki", "device_label", "redirect_uri", "state", "code_challenge", "code_challenge_method", ...(Object.hasOwn(value ?? {}, "requested_feature") ? ["requested_feature"] : [])]);
    text(value.client_id, /^[A-Za-z0-9_.:-]{1,127}$/);
    text(value.project, /^[A-Za-z0-9_.:-]{1,127}$/);
    if (Object.hasOwn(value, "requested_feature")) text(value.requested_feature, /^[A-Za-z0-9_.:-]{1,15}$/);
    if (typeof value.public_key_spki !== "string" || value.public_key_spki.length > 512) invalid();
    try { if (!decodeBase64url(value.public_key_spki, 384).length) invalid(); } catch { invalid(); }
    if (typeof value.device_label !== "string") invalid();
    const label = value.device_label.trim();
    if ([...label].length < 1 || [...label].length > 80 || utf8.decode(encoder.encode(label)) !== label) invalid();
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
