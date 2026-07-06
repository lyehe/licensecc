// canonical_payload.mjs
//
// Worker-safe (no node:/Buffer) single source of truth for the v201 lease
// canonical payload + license text. A faithful JS port of the C++
// src/library/base/v201_canonical_payload.cpp: same domain, field order,
// `k<8hex>:<key>v<8hex>:<value>\n` framing, and validation. Imported by BOTH the
// Node signer (scripts/lease-sign.mjs) and the Cloudflare lease Worker so the two
// can never drift from each other; cross-language parity against C++ is guarded by
// test/lease-sign.test.mjs (asserts against the checked-in C++ golden vectors).

export const SIGNATURE_ALGORITHM = "rsa-pkcs1-sha256";
const DOMAIN = "licensecc:v201\n";
const MAX_VALUE_LENGTH = 4096;
const MAX_PAYLOAD_LENGTH = 16384;

// MUST match canonical_order() in v201_canonical_payload.cpp.
export const CANONICAL_ORDER = [
  "lic_ver", "canonical-v", "sig-v", "sig-alg", "key-id",
  "project", "feature", "valid-from", "valid-to", "start-version",
  "end-version", "client-signature", "client-signature-source-strength", "extra-data",
];
const REQUIRED_FIELDS = ["lic_ver", "canonical-v", "sig-v", "sig-alg", "key-id", "project", "feature"];
const SOURCE_STRENGTHS = new Set([
  "strong-ethernet-mac", "strong-disk-serial-or-uuid", "weak-ip-address",
  "weak-env-selected-ethernet-mac", "weak-env-selected-ip-address",
  "weak-env-selected-disk-serial-or-uuid", "weak-disk-label",
  "weak-env-selected-disk-label", "weak-disk-mutable", "weak-env-selected-disk-mutable",
]);
// INI storage excludes project/feature: feature is the [section]; project is implicit (LCC_PROJECT_NAME).
const STORAGE_EXCLUDED = new Set(["project", "feature"]);
const KEY_ID_RE = /^sha256:[0-9a-f]{64}$/;

const encoder = new TextEncoder();

function hex8(n) {
  return n.toString(16).padStart(8, "0");
}

function byteLength(value) {
  return encoder.encode(value).length;
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function isPrintableAscii(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function isValidProjectName(value) {
  return !!value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function isValidFeatureName(value) {
  return !!value && /^[A-Z0-9_.-]+$/.test(value);
}

export function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month];
}

export function isValidVersion(value) {
  if (!value || value.startsWith(".") || value.endsWith(".")) return false;
  const parts = value.split(".");
  if (parts.length > 3) return false;
  return parts.every((p) => /^\d{1,4}$/.test(p));
}

function validateField(key, value) {
  if (!CANONICAL_ORDER.includes(key)) throw new Error(`unknown canonical field: ${key}`);
  if (value === "" || value === undefined || value === null) throw new Error(`empty canonical field: ${key}`);
  if (typeof value !== "string") throw new Error(`canonical field must be a string: ${key}`);
  if (value.length > MAX_VALUE_LENGTH) throw new Error(`canonical field too long: ${key}`);
  if (!isPrintableAscii(value)) throw new Error(`non-printable byte in canonical field: ${key}`);
  if (key === "lic_ver" && value !== "201") throw new Error("lic_ver must be 201");
  if ((key === "canonical-v" || key === "sig-v") && value !== "1") throw new Error(`${key} must be 1`);
  if (key === "sig-alg" && value !== SIGNATURE_ALGORITHM) throw new Error("sig-alg is unsupported");
  if (key === "key-id" && !KEY_ID_RE.test(value)) throw new Error("key-id must be sha256:<64 lowercase hex>");
  if (key === "project" && !isValidProjectName(value)) throw new Error("invalid project name");
  if (key === "feature" && !isValidFeatureName(value)) throw new Error("invalid feature name");
  if ((key === "valid-from" || key === "valid-to") && !isValidDate(value)) throw new Error(`${key} is not a calendar date`);
  if ((key === "start-version" || key === "end-version") && !isValidVersion(value)) throw new Error(`${key} is not a version`);
  if (key === "client-signature-source-strength" && !SOURCE_STRENGTHS.has(value)) {
    throw new Error("client-signature-source-strength is unsupported");
  }
}

// Returns { bytes: Uint8Array, hex: string }. Throws on any invalid/missing field.
export function buildV201CanonicalPayload(fields) {
  const present = new Map();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    validateField(key, value);
    if (present.has(key)) throw new Error(`duplicate canonical field: ${key}`);
    present.set(key, value);
  }
  for (const required of REQUIRED_FIELDS) {
    if (!present.has(required)) throw new Error(`missing required canonical field: ${required}`);
  }
  if (present.has("valid-from") && present.has("valid-to") && present.get("valid-from") > present.get("valid-to")) {
    throw new Error("valid-from must not be after valid-to");
  }
  if (present.has("client-signature") !== present.has("client-signature-source-strength")) {
    throw new Error("client-signature and client-signature-source-strength must be present together");
  }

  let text = DOMAIN;
  for (const key of CANONICAL_ORDER) {
    if (!present.has(key)) continue;
    const value = present.get(key);
    text += `k${hex8(byteLength(key))}:${key}v${hex8(byteLength(value))}:${value}\n`;
  }
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_PAYLOAD_LENGTH) throw new Error("canonical payload too long");
  return { bytes, hex: bytesToHex(bytes) };
}

// Assemble the canonical field object for a lease from high-level options.
export function leaseCanonicalFields(opts) {
  if (!opts.validFrom) throw new Error("validFrom is mandatory for a lease (signed pre-issuance bound)");
  if (!opts.validTo) throw new Error("validTo is mandatory for a lease (the expiry)");
  return {
    "lic_ver": "201",
    "canonical-v": "1",
    "sig-v": "1",
    "sig-alg": SIGNATURE_ALGORITHM,
    "key-id": opts.keyId,
    "project": opts.project,
    "feature": opts.feature,
    "valid-from": opts.validFrom,
    "valid-to": opts.validTo,
    "start-version": opts.startVersion,
    "end-version": opts.endVersion,
    "client-signature": opts.clientSignature,
    "client-signature-source-strength": opts.clientSignatureSourceStrength,
    "extra-data": opts.extraData,
  };
}

// Assemble the v201 license INI text from canonical fields + a base64 signature.
export function buildLeaseLicenseText(fields, signatureB64) {
  const lines = [`[${fields.feature}]`];
  for (const key of CANONICAL_ORDER) {
    if (STORAGE_EXCLUDED.has(key)) continue;
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key} = ${value}`);
  }
  lines.push(`sig = ${signatureB64}`);
  return lines.join("\n") + "\n";
}

// YYYY-MM-DD (UTC) for an epoch-second instant. The lease validity window is computed
// in epoch seconds (clamped to the subscription end) then projected to a UTC date.
export function utcDateFromEpoch(epochSeconds) {
  if (!Number.isInteger(epochSeconds) || epochSeconds < 0) throw new Error("epochSeconds must be a non-negative integer");
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}
