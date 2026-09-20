import { decodeBase64url, encodeBase64url, encodeDeviceLeasePayload, deviceLeaseSigningInput, encodeDeviceLeaseEnvelope, decodeDeviceLeaseEnvelope, deviceProofSigningInput } from "@licensecc/licensing-domain/lease/device_protocol";

const curveOrder = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const scalar = bytes => BigInt(`0x${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`);

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function importBoundDeviceKey(encodedSpki) {
  const bytes = decodeBase64url(encodedSpki, 384);
  const key = await crypto.subtle.importKey("spki", bytes, {name: "ECDSA", namedCurve: "P-256"}, true, ["verify"]);
  // SPKI must have precisely the canonical encoding exported for that point.
  const canonical = new Uint8Array(await crypto.subtle.exportKey("spki", key));
  if (encodeBase64url(canonical) !== encodedSpki) throw new Error("noncanonical_device_key");
  return { key, keyId: `sha256:${await sha256Hex(canonical)}` };
}

export function normalizeDeviceSignature(signature) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error("invalid_signature");
  const r = scalar(signature.slice(0, 32)), s = scalar(signature.slice(32));
  if (r === 0n || r >= curveOrder || s === 0n || s >= curveOrder) throw new Error("invalid_signature");
  const normalized = s > curveOrder / 2n ? curveOrder - s : s;
  const hex = normalized.toString(16).padStart(64, "0");
  const result = new Uint8Array(signature);
  for (let i = 0; i < 32; i++) result[32 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return result;
}

// Cryptographic verification only. Routes must reconstruct input from stored
// challenges and current intent, enforce expiry and consume nonces atomically.
export async function verifyBoundDeviceProof(encodedSpki, input, encodedSignature) {
  try {
    const {key, keyId} = await importBoundDeviceKey(encodedSpki);
    if (keyId !== input.key_id) return false;
    const signature = decodeBase64url(encodedSignature, 64);
    const normalized = normalizeDeviceSignature(signature);
    if (encodeBase64url(signature) !== encodeBase64url(normalized)) return false;
    return await crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"}, key, signature, deviceProofSigningInput(input));
  } catch { return false; }
}

function assertLeaseKey(key, usage) {
  const algorithm = key.algorithm;
  if (algorithm.name !== "RSASSA-PKCS1-v1_5" || algorithm.modulusLength !== 3072 || algorithm.hash?.name !== "SHA-256" || !key.usages.includes(usage)) throw new Error("invalid_lease_key");
}

export async function boundLeaseKeyId(publicKey) {
  assertLeaseKey(publicKey, "verify");
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return `sha256:${await sha256Hex(spki)}`;
}

export async function signBoundDeviceLease(claims, privateKey, publicKey) {
  assertLeaseKey(privateKey, "sign");
  if (await boundLeaseKeyId(publicKey) !== claims["key-id"]) throw new Error("lease_key_id_mismatch");
  const payload = encodeDeviceLeasePayload(claims);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, deviceLeaseSigningInput(payload)));
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, deviceLeaseSigningInput(payload))) throw new Error("lease_key_pair_mismatch");
  return encodeDeviceLeaseEnvelope(payload, signature);
}

// This verifies signature/expected claims only. The caller still must establish
// a fresh process-bound clock anchor and prove possession of its local key.
export async function verifyBoundDeviceLease(token, trustedKeys, expected, effectiveNow) {
  try {
    if (!Number.isSafeInteger(effectiveNow) || effectiveNow < 0) return null;
    const decoded = decodeDeviceLeaseEnvelope(token);
    const key = trustedKeys.get(decoded.claims["key-id"]);
    if (!key) return null;
    assertLeaseKey(key, "verify");
    if (await boundLeaseKeyId(key) !== decoded.claims["key-id"]) return null;
    const required = ["issuer", "audience", "project", "feature", "license-fingerprint", "binding-id", "device-key-id", "generation", "operation-id"];
    if (required.some(field => expected[field] === undefined || expected[field] !== decoded.claims[field])) return null;
    if (!Number.isSafeInteger(expected.min_revocation_seq) || expected.min_revocation_seq < 0 || decoded.claims["revocation-seq"] < expected.min_revocation_seq) return null;
    // The 120-second allowance is a server-side capacity hold, not additional
    // client grace. Counting it twice would undermine the no-overlap bound.
    if (effectiveNow < Number(decoded.claims["issued-at"]) || effectiveNow >= Number(decoded.claims["expires-at"])) return null;
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decoded.signature, deviceLeaseSigningInput(decoded.payload))) return null;
    return decoded.claims;
  } catch { return null; }
}
