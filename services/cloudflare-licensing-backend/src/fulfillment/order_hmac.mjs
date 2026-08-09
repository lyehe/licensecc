// Pure HMAC verification for Slice 1 order-ingest (POST /v1/orders). Worker-safe:
// no node:/Buffer; only Web Crypto (crypto.subtle) + standard globals (atob,
// TextEncoder). Runs raw under `node --test`.
//
// This function is PURE crypto + skew + keymap + audience. It does NOT spend the
// replay nonce in the DB -- that is the Stage-4 handler's job (it runs LAST, after
// verify+skew succeed). Keeping the nonce spend out of here makes the whole crypto
// surface unit-testable without a DB mock.
//
// HMAC scheme (blueprint):
//   Headers: X-LCC-Key-Id, X-LCC-Timestamp (unix-seconds int), X-LCC-Signature (b64 HMAC-SHA256).
//   signedBytes = utf8("POST\n/v1/orders\n" + audience + "\n" + canonicalIntTs + "\n") + rawBodyBytes
//   Key map ORDER_HMAC_SECRETS = JSON { key_id: base64-secret } into Object.create(null);
//   lookup via hasOwnProperty + typeof==='string'; reject empty map / empty / <32-byte
//   decoded secret at load (fail-closed). Unknown key_id -> unknown_key_id.
//   Header ts must equal its canonical integer form (reject "123.0" / " 123").
//   Skew |now-ts| > maxSkew -> stale_timestamp (maxSkew = ORDER_MAX_SKEW_SECONDS,
//   default 300, cap 3600). Audience from ORDER_INGEST_AUDIENCE.
//   Verify via crypto.subtle.verify (constant-time); NEVER manual ===.
//
// Design: docs/superpowers/plans/2026-06-24-slice1-order-ingest-blueprint.md

import { bytesFromBase64, loadSecretMap, lookupSecret } from "@licensecc/cloudflare-runtime/auth/secret_map";

const SIGNED_PREFIX = "POST\n/v1/orders\n";
const DEFAULT_MAX_SKEW_SECONDS = 300;
const MAX_SKEW_CAP_SECONDS = 3600;

const textEncoder = new TextEncoder();

export { bytesFromBase64, loadSecretMap, lookupSecret } from "@licensecc/cloudflare-runtime/auth/secret_map";

// Copy into an owned ArrayBuffer before Web Crypto.  TypeScript 5.9 correctly
// distinguishes a view backed by a potentially shared buffer from BufferSource;
// the copy also prevents a caller from mutating key/signature bytes during the
// crypto operation.
function cryptoBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * The canonical bytes the order-ingest HMAC is computed over. Exported so the
 * offline signer (scripts/order-sign.mjs) and this verifier share ONE framing and
 * can never drift. `timestamp` is the canonical integer-string form of unix seconds.
 */
export function canonicalOrderSignedText(audience, timestamp, bodyText) {
  return SIGNED_PREFIX + audience + "\n" + String(timestamp) + "\n" + bodyText;
}

/**
 * The actual HMAC input. The framing is UTF-8 text, but the body is appended as
 * its original wire bytes: it is never decoded and re-encoded before verification.
 * `canonicalOrderSignedText` remains the text helper used by the offline UTF-8
 * signer; for a canonical UTF-8 JSON body both forms produce identical bytes.
 */
export function canonicalOrderSignedBytes(audience, timestamp, bodyBytes) {
  const framing = textEncoder.encode(canonicalOrderSignedText(audience, timestamp, ""));
  const raw = typeof bodyBytes === "string" ? textEncoder.encode(bodyBytes) : bodyBytes;
  if (!(raw instanceof Uint8Array)) {
    throw new TypeError("order body must be a string or Uint8Array");
  }
  const signed = new Uint8Array(framing.byteLength + raw.byteLength);
  signed.set(framing);
  signed.set(raw, framing.byteLength);
  return signed;
}

/**
 * The canonical integer string form of a unix-seconds timestamp header. The header
 * MUST equal this exactly: "123" passes, "123.0"/" 123"/"+123"/"0x7b" do not. This
 * blocks signed-bytes ambiguity where two distinct header strings hash differently
 * but a sloppy Number() would treat them as the same instant.
 */
function canonicalIntTimestamp(headerValue) {
  if (typeof headerValue !== "string" || headerValue.length === 0) {
    return null;
  }
  const n = Number(headerValue);
  if (!Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  // Reject any non-canonical spelling (leading/trailing space, decimals, signs).
  if (String(n) !== headerValue) {
    return null;
  }
  return { value: n, canonical: headerValue };
}

function clampMaxSkew(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return DEFAULT_MAX_SKEW_SECONDS;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_SKEW_SECONDS;
  }
  return Math.min(parsed, MAX_SKEW_CAP_SECONDS);
}

/**
 * Verify the order-ingest HMAC over the EXACT request bytes.
 *
 *   request  : the incoming Request (header source).
 *   env      : { ORDER_HMAC_SECRETS, ORDER_INGEST_AUDIENCE, ORDER_MAX_SKEW_SECONDS? }.
 *   bodyBytes: the raw request bytes already read once by the bounded stream reader.
 *              A string remains accepted for the offline UTF-8 signer/unit-test API.
 *
 * Returns { ok, code, keyId }:
 *   - { ok:true,  code:'ok',                keyId } on success.
 *   - { ok:false, code:'config_error'             } when no usable key map / audience.
 *   - { ok:false, code:'unknown_key_id'           } when the header key_id is unknown.
 *   - { ok:false, code:'stale_timestamp'          } on bad/non-canonical ts or skew.
 *   - { ok:false, code:'bad_signature'            } on missing/invalid signature.
 *
 * Constant-time: the signature comparison is crypto.subtle.verify, never a manual
 * string/byte ===.
 */
export async function verifyOrderHmac(request, env, bodyBytes) {
  const now = Math.floor(Date.now() / 1000);

  // Fail closed if the key map or audience is not configured/usable.
  const secretMap = loadSecretMap(env?.ORDER_HMAC_SECRETS);
  if (secretMap === null) {
    return { ok: false, code: "config_error", keyId: null };
  }
  const audience = env?.ORDER_INGEST_AUDIENCE;
  if (typeof audience !== "string" || audience.length === 0) {
    return { ok: false, code: "config_error", keyId: null };
  }

  const keyId = request.headers.get("X-LCC-Key-Id");
  if (typeof keyId !== "string" || keyId.length === 0) {
    return { ok: false, code: "unknown_key_id", keyId: null };
  }
  const secretBytes = lookupSecret(secretMap, keyId);
  if (secretBytes === null) {
    return { ok: false, code: "unknown_key_id", keyId: null };
  }

  const tsHeader = request.headers.get("X-LCC-Timestamp");
  const ts = canonicalIntTimestamp(tsHeader);
  if (ts === null) {
    return { ok: false, code: "stale_timestamp", keyId };
  }
  const maxSkew = clampMaxSkew(env?.ORDER_MAX_SKEW_SECONDS);
  if (Math.abs(now - ts.value) > maxSkew) {
    return { ok: false, code: "stale_timestamp", keyId };
  }

  const signatureHeader = request.headers.get("X-LCC-Signature");
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return { ok: false, code: "bad_signature", keyId };
  }
  let signatureBytes;
  try {
    signatureBytes = bytesFromBase64(signatureHeader);
  } catch {
    return { ok: false, code: "bad_signature", keyId };
  }

  let signedBytes;
  try {
    signedBytes = canonicalOrderSignedBytes(audience, ts.canonical, bodyBytes);
  } catch {
    return { ok: false, code: "bad_signature", keyId };
  }

  let valid;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      cryptoBuffer(secretBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      cryptoBuffer(signatureBytes),
      cryptoBuffer(signedBytes),
    );
  } catch {
    // A malformed signature byte length (or any crypto error) is a verification
    // failure, never a 5xx: never poison the inbox over a bad signature.
    return { ok: false, code: "bad_signature", keyId };
  }
  if (!valid) {
    return { ok: false, code: "bad_signature", keyId };
  }
  return { ok: true, code: "ok", keyId };
}
