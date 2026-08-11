import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalRequestProofPayloadForTests,
  validateVerifyRequest,
} from "../../dist/routes/verify.js";

export function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

export async function testKeyEnv(row, overrides = {}) {
  const { deviceRows = [], ...envOverrides } = overrides;
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const env = {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: bytesToPem(new Uint8Array(pkcs8), "PRIVATE KEY"),
    ONLINE_SIGNING_KEY_ID: "sha256:test-online-key",
    MAX_ASSERTION_TTL_SECONDS: "300",
    DB: {
      prepare(sql) {
        if (sql.includes("FROM entitlement_devices")) {
          return {
            bind(project, feature, licenseFingerprint, deviceKeyId) {
              return {
                async first() {
                  return (
                    deviceRows.find(
                      (device) =>
                        device.project === project &&
                        device.feature === feature &&
                        device.license_fingerprint === licenseFingerprint &&
                        device.device_key_id === deviceKeyId,
                    ) ?? null
                  );
                },
              };
            },
          };
        }
        return {
          bind(project, feature, licenseFingerprint) {
            return {
              async first() {
                if (
                  row &&
                  row.project === project &&
                  row.feature === feature &&
                  row.license_fingerprint === licenseFingerprint
                ) {
                  return row;
                }
                return null;
              },
            };
          },
        };
      },
    },
    ...envOverrides,
  };
  return env;
}

export function validBody(overrides = {}) {
  return {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    device_hash: "",
    nonce: "b".repeat(64),
    ...overrides,
  };
}

export function base64FromBytes(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export async function requestProofFixture(bodyOverrides = {}, proofOverrides = {}) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const deviceKeyId = `sha256:${createHash("sha256").update(Buffer.from(spki)).digest("hex")}`;
  const body = validBody({
    request_signature_version: 1,
    device_key_id: deviceKeyId,
    request_timestamp: 1_000_000,
    request_signature_algorithm: "ecdsa-p256-sha256",
    request_signature: base64FromBytes(new Uint8Array(64).fill(1)),
    ...bodyOverrides,
  });
  const validated = validateVerifyRequest(body);
  assert.notEqual(validated, null);
  const payload = canonicalRequestProofPayloadForTests(validated);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(payload)),
  );
  const signedBody = {
    ...body,
    request_signature: base64FromBytes(signature),
    ...proofOverrides,
  };
  return {
    body: signedBody,
    deviceRow: {
      project: signedBody.project,
      feature: signedBody.feature,
      license_fingerprint: signedBody.license_fingerprint,
      device_key_id: deviceKeyId,
      public_key_spki_der_base64: base64FromBytes(spki),
      status: "active",
    },
  };
}

export async function captureConsoleEvents(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const lines = [];
  console.log = (line) => lines.push({ severity: "info", line: String(line) });
  console.warn = (line) => lines.push({ severity: "warn", line: String(line) });
  console.error = (line) => lines.push({ severity: "error", line: String(line) });
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
  return lines.map((entry) => ({ severity: entry.severity, ...JSON.parse(entry.line) }));
}

export function derPayloadOffset(bytes, offset) {
  assert.equal(bytes[offset], 0x30);
  ++offset;
  const lengthByte = bytes[offset++];
  if ((lengthByte & 0x80) === 0) {
    return offset;
  }
  const lengthBytes = lengthByte & 0x7f;
  assert.ok(lengthBytes > 0 && lengthBytes <= 4);
  return offset + lengthBytes;
}
