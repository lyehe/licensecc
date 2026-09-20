// Device-bound protocol v1 / request proof v2. No cryptographic trust decisions
// live here: callers must verify signatures and expected identity before use.
const encoder = new TextEncoder();
// Preserve a BOM so the strict canonical parser rejects it rather than silently
// accepting a second byte representation of the same signed payload.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const DEVICE_LEASE_FIELDS = Object.freeze([
  "version", "purpose", "key-id", "issuer", "audience", "project", "feature",
  "license-fingerprint", "binding-id", "device-key-id", "generation",
  "revocation-seq", "lease-id", "operation-id", "issued-at", "renew-after", "expires-at",
]);
const integers = new Set(["version", "generation", "revocation-seq", "issued-at", "renew-after", "expires-at"]);
const keyPattern = /^sha256:[a-f0-9]{64}$/;

export function encodeBase64url(bytes) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64url(value, maxBytes = 8192) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil(maxBytes * 4 / 3)) throw new Error("invalid_encoding");
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), ch => ch.charCodeAt(0)); }
  catch { throw new Error("invalid_encoding"); }
  if (bytes.length > maxBytes || encodeBase64url(bytes) !== value) throw new Error("invalid_encoding");
  return bytes;
}

function text(value) {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).length > 1024 || decoder.decode(encoder.encode(value)) !== value) throw new Error("invalid_text");
  return encodeBase64url(encoder.encode(value));
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_integer");
  return String(value);
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error("invalid_fields");
}

export const DEVICE_COMPARISON_FIELDS = Object.freeze([
  "attempt_handle", "client_id", "project", "key_id", "redirect_uri", "state", "code_challenge",
]);

// Display-only enrollment comparison. This is neither proof nor a credential.
// Callers separately validate the registry, callback and imported device key.
export function deviceEnrollmentComparisonInput(input) {
  const featureBound = Object.hasOwn(input ?? {}, "requested_feature");
  const fields = featureBound ? [...DEVICE_COMPARISON_FIELDS, "requested_feature"] : DEVICE_COMPARISON_FIELDS;
  exactFields(input, fields);
  if (featureBound && (typeof input.requested_feature !== "string" || !/^[A-Za-z0-9_.:-]{1,15}$/.test(input.requested_feature))) throw new Error("invalid_identity");
  for(const field of ["client_id","project"])if(typeof input[field]!=="string" || !/^[A-Za-z0-9_.:-]{1,127}$/.test(input[field]))throw new Error("invalid_identity");
  for (const field of ["attempt_handle", "state", "code_challenge"]) {
    if (decodeBase64url(input[field],32).length!==32) throw new Error("invalid_identity");
  }
  if (typeof input.key_id!=="string" || !keyPattern.test(input.key_id)) throw new Error("invalid_identity");
  return encoder.encode((featureBound ? "lcc-device-enrollment-comparison-v2\n" : "lcc-device-enrollment-comparison-v1\n")+fields.map(field=>text(input[field])).join("\n")+"\n");
}

export function formatDeviceEnrollmentComparison(digest) {
  if (!(digest instanceof Uint8Array) || digest.length!==32) throw new Error("invalid_digest");
  const hex=Array.from(digest.slice(0,6),byte=>byte.toString(16).padStart(2,"0")).join("").toUpperCase();
  return `${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}`;
}

function validateClaims(claims) {
  exactFields(claims, DEVICE_LEASE_FIELDS);
  if (claims.version !== 1 || claims.purpose !== "device-lease") throw new Error("invalid_purpose");
  if (typeof claims.project !== "string" || !/^[A-Za-z0-9_.:-]{1,127}$/.test(claims.project) || typeof claims.feature !== "string" || !/^[A-Za-z0-9_.:-]{1,15}$/.test(claims.feature)) throw new Error("invalid_identity");
  if (!keyPattern.test(claims["key-id"]) || !keyPattern.test(claims["device-key-id"]) || !/^[a-f0-9]{64}$/.test(claims["license-fingerprint"])) throw new Error("invalid_identity");
  for (const field of ["binding-id","lease-id","operation-id"]) {
    const size=field==="operation-id"?32:16;
    if (decodeBase64url(claims[field],size).length!==size) throw new Error("invalid_identity");
  }
  if (claims.generation < 1 || claims["issued-at"] >= claims["renew-after"] || claims["renew-after"] >= claims["expires-at"]) throw new Error("invalid_window");
  if (claims["expires-at"] - claims["issued-at"] > 86400) throw new Error("invalid_window");
  integer(claims["expires-at"] + 120);
}

export function encodeDeviceLeasePayload(claims) {
  validateClaims(claims);
  const payload = DEVICE_LEASE_FIELDS.map(field => `${field}=${integers.has(field) ? integer(claims[field]) : text(claims[field])}`).join("\n") + "\n";
  const bytes = encoder.encode(payload);
  if (bytes.length > 4096) throw new Error("payload_too_large");
  return bytes;
}

export function decodeDeviceLeasePayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 4096) throw new Error("invalid_payload");
  let payload;
  try { payload = decoder.decode(bytes); } catch { throw new Error("invalid_payload"); }
  const lines = payload.split("\n");
  if (lines.length !== DEVICE_LEASE_FIELDS.length + 1 || lines.pop() !== "") throw new Error("invalid_fields");
  /** @type {Record<string, string | number>} */
  const claims = {};
  DEVICE_LEASE_FIELDS.forEach((field, index) => {
    const prefix = `${field}=`;
    const line = lines[index];
    if (typeof line !== "string" || !line.startsWith(prefix)) throw new Error("invalid_fields");
    const value = line.slice(prefix.length);
    if (integers.has(field)) {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid_integer");
      const number = Number(value); integer(number); claims[field] = number;
    } else {
      claims[field] = decoder.decode(decodeBase64url(value, 1024));
    }
  });
  // Re-encoding enforces all semantic and canonical text constraints.
  if (decoder.decode(encodeDeviceLeasePayload(claims)) !== payload) throw new Error("invalid_payload");
  return claims;
}

export function deviceLeaseSigningInput(payload) {
  decodeDeviceLeasePayload(payload);
  const prefix = encoder.encode("lccdl1.");
  const result = new Uint8Array(prefix.length + payload.length);
  result.set(prefix); result.set(payload, prefix.length); return result;
}

export function encodeDeviceLeaseEnvelope(payload, signature) {
  decodeDeviceLeasePayload(payload);
  if (!(signature instanceof Uint8Array) || signature.length !== 384) throw new Error("invalid_signature_size");
  const token = `lccdl1.${encodeBase64url(payload)}.${encodeBase64url(signature)}`;
  if (token.length > 8192) throw new Error("token_too_large");
  return token;
}

export function decodeDeviceLeaseEnvelope(token) {
  if (typeof token !== "string" || token.length > 8192) throw new Error("invalid_token");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "lccdl1") throw new Error("invalid_token");
  const payload = decodeBase64url(parts[1], 4096);
  const signature = decodeBase64url(parts[2], 384);
  if (signature.length !== 384) throw new Error("invalid_signature_size");
  return { payload, signature, claims: decodeDeviceLeasePayload(payload) };
}

export const DEVICE_OPERATION_FIELDS = Object.freeze({
  exchange: Object.freeze(["attempt_handle", "code", "code_verifier", "redirect_uri", "operation_id"]),
  renew: Object.freeze(["binding_id", "generation", "operation_id"]),
});

export function deviceOperationBody(purpose, body) {
  const fields = DEVICE_OPERATION_FIELDS[purpose];
  if (!fields) throw new Error("invalid_purpose");
  exactFields(body, fields);
  const values = fields.map(field => {
    if (field === "generation") { integer(body[field]); if (body[field] < 1) throw new Error("invalid_generation"); }
    else return text(body[field]);
    return body[field];
  });
  return encoder.encode(JSON.stringify(values));
}

export function deviceOperationDigestInput(purpose, keyId, body) {
  if (!keyPattern.test(keyId)) throw new Error("invalid_identity");
  const semantic = deviceOperationBody(purpose, body);
  return encoder.encode(["lcc-device-operation-v1", text(purpose), text(keyId), encodeBase64url(semantic), ""].join("\n"));
}

export function deviceProofSigningInput(input) {
  const fields = ["audience", "method", "path", "key_id", "operation_id", "body_sha256", "challenge_id", "nonce", "expires_at"];
  exactFields(input, fields);
  if (input.method !== "POST" || !["/v2/device-authorizations/exchange", "/v2/device-leases/renew"].includes(input.path) || !keyPattern.test(input.key_id) || !/^[a-f0-9]{64}$/.test(input.body_sha256)) throw new Error("invalid_intent");
  const encoded = fields.map(field => field === "expires_at" ? integer(input[field]) : text(input[field]));
  return encoder.encode(["lcc-device-proof-v2", ...encoded, ""].join("\n"));
}
// Position-only enrollment cursor. Callers retain all authorization/context checks.
export function decodeEnrollmentPageCursor(value) {
  if(typeof value!=="string" || !value || value.length>512)throw new Error("Invalid enrollment cursor");
  const tuple=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(decodeBase64url(value,384)));
  if(!Array.isArray(tuple) || tuple.length!==5 || tuple[0]!=="ep1"
      || ![tuple[1],tuple[2],tuple[4]].every(v=>typeof v==="string" && /^[a-f0-9]{64}$/.test(v))
      || typeof tuple[3]!=="string" || !/^[A-Za-z0-9_.:-]{1,15}$/.test(tuple[3])
      || encodeBase64url(new TextEncoder().encode(JSON.stringify(tuple)))!==value)throw new Error("Invalid enrollment cursor");
  return tuple;
}
