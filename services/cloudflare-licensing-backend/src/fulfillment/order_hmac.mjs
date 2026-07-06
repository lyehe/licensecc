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
//   signedBytes = "POST\n/v1/orders\n" + audience + "\n" + canonicalIntTs + "\n" + bodyText
//   Key map ORDER_HMAC_SECRETS = JSON { key_id: base64-secret } into Object.create(null);
//   lookup via hasOwnProperty + typeof==='string'; reject empty map / empty / <32-byte
//   decoded secret at load (fail-closed). Unknown key_id -> unknown_key_id.
//   Header ts must equal its canonical integer form (reject "123.0" / " 123").
//   Skew |now-ts| > maxSkew -> stale_timestamp (maxSkew = ORDER_MAX_SKEW_SECONDS,
//   default 300, cap 3600). Audience from ORDER_INGEST_AUDIENCE.
//   Verify via crypto.subtle.verify (constant-time); NEVER manual ===.
//
// Design: docs/superpowers/plans/2026-06-24-slice1-order-ingest-blueprint.md

const SIGNED_PREFIX = "POST\n/v1/orders\n";
const MIN_SECRET_BYTES = 32;
const DEFAULT_MAX_SKEW_SECONDS = 300;
const MAX_SKEW_CAP_SECONDS = 3600;

const textEncoder = new TextEncoder();

/**
 * The canonical bytes the order-ingest HMAC is computed over. Exported so the
 * offline signer (scripts/order-sign.mjs) and this verifier share ONE framing and
 * can never drift. `timestamp` is the canonical integer-string form of unix seconds.
 */
export function canonicalOrderSignedText(audience, timestamp, bodyText) {
  return SIGNED_PREFIX + audience + "\n" + String(timestamp) + "\n" + bodyText;
}

/**
 * Worker-safe base64 -> bytes. atob is present in Workers and modern node; we never
 * reach for Buffer here so the module bundles identically everywhere. Throws on
 * malformed base64 (callers treat a throw as a hard failure / bad secret).
 */
export function bytesFromBase64(value) {
  // atob is lenient about some inputs; the secret/sig length checks downstream are
  // what actually gate correctness, so we only need a faithful decode here.
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parse env.ORDER_HMAC_SECRETS (a JSON object { key_id: base64-secret }) into a
 * null-prototype map of key_id -> decoded-secret-bytes. Fail-closed: returns null
 * on any malformed JSON, non-object, empty map, non-string value, undecodable
 * secret, or a secret shorter than 32 bytes. A null return means "no usable keys"
 * and the caller must reject every request.
 */
export function loadSecretMap(rawJson) {
  if (typeof rawJson !== "string" || rawJson.length === 0) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const map = Object.create(null);
  let count = 0;
  for (const keyId of Object.keys(parsed)) {
    // Never let a "__proto__"/"constructor" payload key poison the lookup map; the
    // null prototype + own-key iteration here keeps those as ordinary data keys.
    const value = parsed[keyId];
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    let secretBytes;
    try {
      secretBytes = bytesFromBase64(value);
    } catch {
      return null;
    }
    if (secretBytes.length < MIN_SECRET_BYTES) {
      return null;
    }
    map[keyId] = secretBytes;
    count += 1;
  }
  if (count === 0) {
    return null;
  }
  return map;
}

/**
 * Own-property, typeof-guarded lookup. Never walks the prototype chain, so a
 * key_id of "__proto__"/"constructor"/"hasOwnProperty" can only ever hit a real
 * data entry (or miss), never a forged function/object off Object.prototype.
 */
export function lookupSecret(map, keyId) {
  if (!Object.prototype.hasOwnProperty.call(map, keyId)) {
    return null;
  }
  const value = map[keyId];
  // map values are Uint8Array; typeof-string guard is belt-and-suspenders against
  // a prototype-pollution shaped value sneaking in.
  if (typeof value === "string") {
    return null;
  }
  return value instanceof Uint8Array ? value : null;
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
 *   bodyText : the raw body text already read once via request.text() (we sign over
 *              these EXACT bytes; the caller must not re-stringify a parsed object).
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
export async function verifyOrderHmac(request, env, bodyText) {
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

  const signedText = canonicalOrderSignedText(audience, ts.canonical, bodyText);

  let valid;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify("HMAC", key, signatureBytes, textEncoder.encode(signedText));
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
