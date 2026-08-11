// Worker-safe request-proof v1 protocol primitives. This module deliberately
// uses only Web Platform APIs so the Worker, Node CLI, and future consumers all
// share the same canonical bytes and strict P-256 wire validation.

export const ONLINE_REQUEST_PROOF_PURPOSE = "licensecc-online-request";
export const LEASE_REQUEST_PROOF_PURPOSE = "licensecc-lease-request";
export const SEAT_REQUEST_PROOF_PURPOSE = "licensecc-seat-request";
export const REQUEST_PROOF_VERSION = 1;
export const REQUEST_PROOF_ALGORITHM = "ecdsa-p256-sha256";

const PROOF_PURPOSES = new Set([
  ONLINE_REQUEST_PROOF_PURPOSE,
  LEASE_REQUEST_PROOF_PURPOSE,
  SEAT_REQUEST_PROOF_PURPOSE,
]);
const NAME = /^[A-Za-z0-9_.:-]+$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
const P256_FIELD = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const textEncoder = new TextEncoder();

function invalid(message) {
  throw new TypeError(message);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bigintFromBytes(bytes) {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function modulo(value, modulus) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function requireName(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || !NAME.test(value)) {
    invalid(`${label} is outside the request-proof ASCII contract`);
  }
}

function requireLowerHex(value, label, allowEmpty = false) {
  if (allowEmpty && value === "") return;
  if (typeof value !== "string" || !LOWER_HEX_64.test(value)) {
    invalid(`${label} must be exactly 64 lowercase hexadecimal characters`);
  }
}

function requireSafeInteger(value, label, maximum) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    invalid(`${label} is outside the request-proof integer contract`);
  }
}

function requireP256Point(publicX, publicY) {
  const x = BigInt(`0x${publicX}`);
  const y = BigInt(`0x${publicY}`);
  if (x >= P256_FIELD || y >= P256_FIELD) {
    invalid("P-256 public point coordinate is out of range");
  }
  const left = modulo(y * y, P256_FIELD);
  const right = modulo(x * x * x - 3n * x + P256_B, P256_FIELD);
  if (left !== right) {
    invalid("P-256 public point is not on the curve");
  }
}

function constantTimeAsciiEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function encodeCanonicalBase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    invalid("base64 input must be bytes");
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeCanonicalBase64(value, expectedLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value)
  ) {
    invalid("base64 value is not canonical RFC 4648 standard base64");
  }
  let binary = "";
  try {
    binary = atob(value);
  } catch {
    invalid("base64 value is malformed");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeCanonicalBase64(bytes) !== value) {
    invalid("base64 value has non-canonical padding or unused bits");
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    invalid(`decoded value must contain exactly ${expectedLength} bytes`);
  }
  return bytes;
}

export function p256SpkiDerFromCoordinates(publicX, publicY) {
  if (typeof publicX !== "string" || !LOWER_HEX_64.test(publicX)) {
    invalid("public X coordinate must be 32-byte lowercase hexadecimal");
  }
  if (typeof publicY !== "string" || !LOWER_HEX_64.test(publicY)) {
    invalid("public Y coordinate must be 32-byte lowercase hexadecimal");
  }
  requireP256Point(publicX, publicY);
  const bytes = new Uint8Array(91);
  bytes.set(SPKI_PREFIX, 0);
  bytes.set(hexToBytes(publicX), SPKI_PREFIX.length);
  bytes.set(hexToBytes(publicY), SPKI_PREFIX.length + 32);
  return bytes;
}

export function parseP256SpkiDer(value) {
  if (!(value instanceof Uint8Array) || value.length !== 91) {
    invalid("P-256 SubjectPublicKeyInfo must be exactly 91 bytes");
  }
  for (let index = 0; index < SPKI_PREFIX.length; index += 1) {
    if (value[index] !== SPKI_PREFIX[index]) {
      invalid("SubjectPublicKeyInfo is not canonical P-256 DER");
    }
  }
  const publicX = bytesToHex(value.subarray(SPKI_PREFIX.length, SPKI_PREFIX.length + 32));
  const publicY = bytesToHex(value.subarray(SPKI_PREFIX.length + 32));
  requireP256Point(publicX, publicY);
  return { bytes: Uint8Array.from(value), publicX, publicY };
}

export async function deriveDeviceKeyId(spkiDer) {
  const canonical = parseP256SpkiDer(spkiDer).bytes;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", canonical));
  return `sha256:${bytesToHex(digest)}`;
}

function validatedPayloadFields(fields) {
  if (typeof fields !== "object" || fields === null) invalid("request-proof fields are required");
  if (!PROOF_PURPOSES.has(fields.purpose)) invalid("request-proof purpose is unsupported");
  if (fields.version !== REQUEST_PROOF_VERSION) invalid("request-proof version is unsupported");
  if (fields.algorithm !== REQUEST_PROOF_ALGORITHM) invalid("request-proof algorithm is unsupported");
  requireName(fields.project, "project", 127);
  requireName(fields.feature, "feature", 15);
  requireLowerHex(fields.licenseFingerprint, "license fingerprint");
  requireLowerHex(fields.deviceHash, "device hash", true);
  requireLowerHex(fields.nonce, "nonce");
  requireSafeInteger(fields.requestTimestamp, "request timestamp", Number.MAX_SAFE_INTEGER);
  requireSafeInteger(fields.clientHardening, "client hardening", 0xffff);
  if (typeof fields.deviceKeyId !== "string" || !DEVICE_KEY_ID.test(fields.deviceKeyId)) {
    invalid("device key id must be sha256 followed by 64 lowercase hexadecimal characters");
  }
  return fields;
}

export function canonicalRequestProofPayload(fields) {
  const value = validatedPayloadFields(fields);
  return (
    `purpose=${value.purpose}\n` +
    `version=${value.version}\n` +
    `alg=${value.algorithm}\n` +
    `project=${value.project}\n` +
    `feature=${value.feature}\n` +
    `license-fingerprint=${value.licenseFingerprint}\n` +
    `device-hash=${value.deviceHash}\n` +
    `nonce=${value.nonce}\n` +
    `request-timestamp=${value.requestTimestamp}\n` +
    `client-hardening=${value.clientHardening}\n` +
    `device-key-id=${value.deviceKeyId}\n`
  );
}

function validateP1363Signature(value) {
  const signature = decodeCanonicalBase64(value, 64);
  const r = bigintFromBytes(signature.subarray(0, 32));
  const s = bigintFromBytes(signature.subarray(32));
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s >= P256_ORDER) {
    invalid("P1363 signature scalar is outside the P-256 order");
  }
  return signature;
}

export async function verifyRequestProofSignature(payload, publicKeySpkiDerBase64, signatureP1363Base64, expectedDeviceKeyId) {
  if (typeof payload !== "string") invalid("request-proof payload must be a string");
  const spki = decodeCanonicalBase64(publicKeySpkiDerBase64, 91);
  const canonicalSpki = parseP256SpkiDer(spki).bytes;
  if (expectedDeviceKeyId !== undefined) {
    if (typeof expectedDeviceKeyId !== "string" || !DEVICE_KEY_ID.test(expectedDeviceKeyId)) {
      invalid("expected device key id is not canonical");
    }
    const actualDeviceKeyId = await deriveDeviceKeyId(canonicalSpki);
    if (!constantTimeAsciiEqual(actualDeviceKeyId, expectedDeviceKeyId)) {
      invalid("device key id does not match SubjectPublicKeyInfo");
    }
  }
  const signature = validateP1363Signature(signatureP1363Base64);
  const key = await globalThis.crypto.subtle.importKey(
    "spki",
    canonicalSpki,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    textEncoder.encode(payload),
  );
}
