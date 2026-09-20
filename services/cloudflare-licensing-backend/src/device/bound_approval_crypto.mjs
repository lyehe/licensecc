import { decodeBase64url, encodeBase64url } from "@licensecc/licensing-domain/lease/device_protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function context(handleHash, revision) {
  if (typeof handleHash !== "string" || !/^[a-f0-9]{64}$/.test(handleHash)
      || !Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_approval_context");
  return encoder.encode(JSON.stringify(["licensecc-approval-v1", handleHash, revision]));
}
function keys(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("approval_keys_unavailable");
  const ring = JSON.parse(value);
  if (!ring || typeof ring !== "object" || Array.isArray(ring) || Object.keys(ring).length !== 2
      || typeof ring.active !== "string" || !ring.keys || typeof ring.keys !== "object" || Array.isArray(ring.keys)
      || Object.keys(ring.keys).length < 1 || Object.keys(ring.keys).length > 3 || !Object.hasOwn(ring.keys, ring.active)) throw new Error("approval_keys_unavailable");
  for (const [id, encoded] of Object.entries(ring.keys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || decodeBase64url(encoded, 32).length !== 32) throw new Error("approval_keys_unavailable");
  }
  return ring;
}

// Independently purposed AES-GCM secret ring. Ciphertext is bound to one
// authorization's approved revision; it is not a generic operation cache.
export async function sealBoundApproval(value, handleHash, revision, keyRing) {
  const ring = keys(keyRing), id = ring.active;
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > 4096) throw new Error("approval_response_too_large");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", decodeBase64url(ring.keys[id], 32), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context(handleHash, revision), tagLength: 128 }, key, plaintext);
  return `lccac1.${id}.${encodeBase64url(iv)}.${encodeBase64url(new Uint8Array(ciphertext))}`;
}

export async function openBoundApproval(envelope, handleHash, revision, keyRing) {
  const ring = keys(keyRing);
  if (typeof envelope !== "string" || envelope.length > 5700) throw new Error("approval_response_unavailable");
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== "lccac1" || !Object.hasOwn(ring.keys, parts[1])) throw new Error("approval_response_unavailable");
  const iv = decodeBase64url(parts[2], 12), ciphertext = decodeBase64url(parts[3], 4112);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error("approval_response_unavailable");
  const key = await crypto.subtle.importKey("raw", decodeBase64url(ring.keys[parts[1]], 32), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: context(handleHash, revision), tagLength: 128 }, key, ciphertext);
  return JSON.parse(decoder.decode(plaintext));
}
