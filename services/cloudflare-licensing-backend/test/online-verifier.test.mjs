import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import worker, {
  canonicalPayloadForTests,
  canonicalRequestProofPayloadForTests,
  resetSigningKeyCacheForTests,
  signingKeyImportCountForTests,
  validateVerifyRequest,
} from "../dist/index.js";
import { interpretWranglerResult, sqlFor } from "../scripts/entitlement.mjs";

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function testKeyEnv(row, overrides = {}) {
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

function validBody(overrides = {}) {
  return {
    project: "DEFAULT",
    feature: "DEFAULT",
    license_fingerprint: "a".repeat(64),
    device_hash: "",
    nonce: "b".repeat(64),
    ...overrides,
  };
}

function base64FromBytes(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function requestProofFixture(bodyOverrides = {}, proofOverrides = {}) {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const deviceKeyId = `sha256:${createHash("sha256").update(Buffer.from(spki)).digest("hex")}`;
  const body = validBody({
    request_signature_version: 1,
    device_key_id: deviceKeyId,
    request_timestamp: 1_000_000,
    request_signature_algorithm: "ecdsa-p256-sha256",
    request_signature: "AA==",
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

async function captureConsoleEvents(fn) {
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

function derPayloadOffset(bytes, offset) {
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

test("key generator emits PKCS#1 public key records for the C++ verifier", () => {
  const outDir = mkdtempSync(join(tmpdir(), "licensecc-online-key-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/generate-online-key.mjs", "--out-dir", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const publicRecord = JSON.parse(readFileSync(join(outDir, "online_public_key.json"), "utf8"));
    const publicDer = Buffer.from(publicRecord.public_key_der_base64, "base64");
    const payloadOffset = derPayloadOffset(publicDer, 0);
    assert.equal(publicDer[payloadOffset], 0x02, "PKCS#1 RSA public key starts with a modulus INTEGER");

    const expectedKeyId = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
    assert.equal(publicRecord.key_id, expectedKeyId);
    assert.match(readFileSync(join(outDir, "online_private_key.pkcs8.pem"), "utf8"), new RegExp("BEGIN " + "PRIVATE KEY"));
    const cmakeRecord = readFileSync(join(outDir, "online_public_key_record.cmake.txt"), "utf8");
    assert.match(cmakeRecord, /CACHE STRING/);
    assert.match(
      cmakeRecord,
      new RegExp(`SignaturePublicKey\\(\\\\"${expectedKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\\\"`),
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("break-glass CLI upsert does not update revoked entitlements", () => {
  const sql = sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator", status: "active" });
  assert.match(sql, /ON CONFLICT\(project, feature, license_fingerprint\) DO UPDATE SET/);
  assert.match(sql, /WHERE entitlements\.status != 'revoked'/);
  assert.match(sql, /INSERT INTO entitlement_events/);
});

test("break-glass CLI transitions keep revoked terminal except revoke", () => {
  const disabled = sqlFor("disable", { fingerprint: "a".repeat(64), actor: "operator", reason: "support" });
  const reenabled = sqlFor("reenable", { fingerprint: "a".repeat(64), actor: "operator" });
  const revoked = sqlFor("revoke", { fingerprint: "a".repeat(64), actor: "operator", reason: "chargeback" });
  assert.match(disabled, /AND status != 'revoked'/);
  assert.match(reenabled, /AND status != 'revoked'/);
  assert.doesNotMatch(revoked, /AND status != 'revoked'/);
});

test("break-glass CLI list does not require a fingerprint", () => {
  const sql = sqlFor("list", {});
  assert.match(sql, /FROM entitlements ORDER BY updated_at DESC LIMIT 100/);
  assert.doesNotMatch(sql, /license_fingerprint =/);
});

test("schema permits sync audit actor type", () => {
  const schema = readFileSync("schema.sql", "utf8");
  const migration = readFileSync("migrations/0006_allow_sync_actor_type.sql", "utf8");
  assert.match(schema, /actor_type IN \('access', 'dev', 'cli', 'sync', 'system', 'unknown'\)/);
  assert.match(migration, /actor_type IN \('access', 'dev', 'cli', 'sync', 'system', 'unknown'\)/);
});

test("break-glass CLI upsert --allow-revoked-override drops the guard and stamps a distinct event", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    status: "active",
    reason: "mistaken revoke, ticket #123",
    "allow-revoked-override": true,
  });
  assert.doesNotMatch(sql, /WHERE entitlements\.status != 'revoked'/);
  assert.match(sql, /'revoked-override'/);
  assert.match(sql, /INSERT INTO entitlement_events/);
});

test("break-glass CLI upsert override requires a reason", () => {
  assert.throws(
    () => sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator", "allow-revoked-override": true }),
    /reason is required/,
  );
});

test("break-glass CLI upsert sets customer_id and license_id when provided", () => {
  const sql = sqlFor("upsert", {
    fingerprint: "a".repeat(64),
    actor: "operator",
    "customer-id": "cus_123",
    "license-id": "lic_123",
  });
  assert.match(sql, /customer_id, license_id, created_at, updated_at/);
  assert.match(sql, /'cus_123'/);
  assert.match(sql, /'lic_123'/);
  assert.match(sql, /customer_id = excluded\.customer_id, license_id = excluded\.license_id/);
});

test("break-glass CLI upsert leaves customer_id and license_id NULL when unset", () => {
  const sql = sqlFor("upsert", { fingerprint: "a".repeat(64), actor: "operator" });
  // unset customer_id/license_id must be SQL NULL (not ''), matching the admin Worker's nullable columns:
  // ...valid_from, valid_until, customer_id, license_id, created_at, updated_at -> ..., NULL, NULL, unixepoch(), unixepoch())
  assert.match(sql, /, NULL, NULL, unixepoch\(\), unixepoch\(\)\)/);
});

test("schema and migration 0007 permit the revoked-override audit event type", () => {
  const schema = readFileSync("schema.sql", "utf8");
  const migration = readFileSync("migrations/0007_allow_revoked_override_event_type.sql", "utf8");
  assert.match(schema, /event_type IN \([^)]*'revoked-override'\)/);
  assert.match(migration, /event_type IN \([^)]*'revoked-override'\)/);
});

test("schema and migration 0008 define entitlement device keys", () => {
  const schema = readFileSync("schema.sql", "utf8");
  const migration = readFileSync("migrations/0008_create_entitlement_devices.sql", "utf8");
  for (const sql of [schema, migration]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS entitlement_devices/);
    assert.match(sql, /device_key_id TEXT NOT NULL/);
    assert.match(sql, /public_key_spki_der_base64 TEXT NOT NULL/);
    assert.match(sql, /status TEXT NOT NULL CHECK \(status IN \('active', 'revoked', 'disabled'\)\)/);
  }
});

test("interpretWranglerResult flags 0-row mutations and ignores reads", () => {
  // --remote --file (D1 import) reports rows_written; 0 means a guarded no-op.
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 0 } }], "upsert"), "noop");
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 2 } }], "revoke"), "ok");
  // --local strips meta to { duration }; a no-op cannot be distinguished from success.
  assert.equal(interpretWranglerResult([{ meta: { duration: 1 } }], "disable"), "unavailable");
  assert.equal(interpretWranglerResult(undefined, "reenable"), "unavailable");
  // reads never report a no-op regardless of payload.
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 0 } }], "get"), "ignore");
  assert.equal(interpretWranglerResult([{ meta: { rows_written: 0 } }], "list"), "ignore");
});

test("validates request schema", () => {
  assert.equal(validateVerifyRequest(validBody()).project, "DEFAULT");
  assert.equal(validateVerifyRequest(validBody({ nonce: "x" })), null);
  assert.equal(validateVerifyRequest(validBody({ license_fingerprint: "z".repeat(64) })), null);
  assert.equal(validateVerifyRequest(validBody({ request_signature_version: 1 })), null);
  assert.equal(
    validateVerifyRequest(
      validBody({
        request_signature_version: 1,
        device_key_id: `sha256:${"a".repeat(64)}`,
        request_timestamp: 1_000_000,
        request_signature_algorithm: "ecdsa-p256-sha256",
        request_signature: "AA==",
      }),
    ).request_proof.device_key_id,
    `sha256:${"a".repeat(64)}`,
  );
  assert.equal(
    validateVerifyRequest(
      validBody({
        request_signature_version: 1,
        device_key_id: `sha256:${"a".repeat(64)}`,
        request_timestamp: 1_000_000,
        request_signature_algorithm: "rsa-pkcs1-sha256",
        request_signature: "AA==",
      }),
    ),
    null,
  );
});

test("canonical request proof payload is byte exact", () => {
  const body = validateVerifyRequest(
    validBody({
      request_signature_version: 1,
      device_key_id: `sha256:${"d".repeat(64)}`,
      request_timestamp: 1_000_000,
      request_signature_algorithm: "ecdsa-p256-sha256",
      request_signature: "AA==",
      client_hardening: 15,
    }),
  );
  assert.notEqual(body, null);
  assert.equal(
    canonicalRequestProofPayloadForTests(body),
    [
      "purpose=licensecc-online-request",
      "version=1",
      "alg=ecdsa-p256-sha256",
      "project=DEFAULT",
      "feature=DEFAULT",
      `license-fingerprint=${"a".repeat(64)}`,
      "device-hash=",
      `nonce=${"b".repeat(64)}`,
      "request-timestamp=1000000",
      "client-hardening=15",
      `device-key-id=sha256:${"d".repeat(64)}`,
      "",
    ].join("\n"),
  );
});

test("client_hardening is accepted but does not change the allow/deny decision", async () => {
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  async function verify(body) {
    return worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      await testKeyEnv(row),
    );
  }

  const withoutField = await verify(validBody());
  const withField = await verify(validBody({ client_hardening: 15 }));
  assert.equal(withoutField.status, withField.status);
  const withoutBody = await withoutField.json();
  const withBody = await withField.json();
  assert.equal(withoutBody.ok, withBody.ok);
  assert.equal(withoutBody.code, withBody.code);
  assert.equal(withBody.ok, true);
  assert.equal(withBody.code, "entitlement_ok");

  // The telemetry must never leak into the signed canonical payload.
  const payload = Buffer.from(withBody.assertion.split(".")[1], "base64").toString("utf8");
  assert.doesNotMatch(payload, /client.?hardening/i);
});

test("client_hardening is logged on allow and deny paths but not signed", async () => {
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const env = await testKeyEnv(row);

  let allowBody;
  const allowLogs = await captureConsoleEvents(async () => {
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody({ client_hardening: 15 })),
      }),
      env,
    );
    allowBody = await response.json();
  });
  const okLog = allowLogs.find((entry) => entry.event === "verify.ok");
  assert.equal(okLog?.severity, "info");
  assert.equal(okLog?.client_hardening, 15);
  assert.equal(allowBody.ok, true);
  const payload = Buffer.from(allowBody.assertion.split(".")[1], "base64").toString("utf8");
  assert.doesNotMatch(payload, /client.?hardening/i);

  let denyBody;
  const denyLogs = await captureConsoleEvents(async () => {
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody({ license_fingerprint: "c".repeat(64), client_hardening: 7 })),
      }),
      env,
    );
    denyBody = await response.json();
  });
  const deniedLog = denyLogs.find((entry) => entry.event === "verify.denied");
  assert.equal(deniedLog?.severity, "warn");
  assert.equal(deniedLog?.client_hardening, 7);
  assert.equal(denyBody.ok, false);
  assert.equal(denyBody.code, "entitlement_denied");
});

test("request proof soft mode logs missing proof but preserves allow behavior", async () => {
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const env = await testKeyEnv(row, { REQUEST_SIGNATURE_MODE: "soft" });
  const logs = await captureConsoleEvents(async () => {
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).code, "entitlement_ok");
  });
  const proofLog = logs.find((entry) => entry.event === "verify.request_proof");
  assert.equal(proofLog?.severity, "warn");
  assert.equal(proofLog?.mode, "soft");
  assert.equal(proofLog?.result, "missing");
  const okLog = logs.find((entry) => entry.event === "verify.ok");
  assert.equal(okLog?.request_signature_mode, "soft");
  assert.equal(okLog?.request_proof, "missing");
});

test("request proof required mode denies missing proof before signing", async () => {
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    await testKeyEnv(row, { REQUEST_SIGNATURE_MODE: "required" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "request_proof_required",
    server_time: Math.floor(Date.now() / 1000),
  });
});

test("request proof required mode accepts a registered device signature", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 3,
    };
    const proof = await requestProofFixture();
    const env = await testKeyEnv(row, { REQUEST_SIGNATURE_MODE: "required", deviceRows: [proof.deviceRow] });
    const logs = await captureConsoleEvents(async () => {
      const response = await worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.code, "entitlement_ok");
      assert.match(body.assertion, /^lccoa1\./);
    });
    const proofLog = logs.find((entry) => entry.event === "verify.request_proof");
    assert.equal(proofLog?.severity, "info");
    assert.equal(proofLog?.mode, "required");
    assert.equal(proofLog?.result, "valid");
  } finally {
    Date.now = originalNow;
  }
});

test("device key utility generates proof accepted by required request-proof mode", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  const outDir = mkdtempSync(join(tmpdir(), "licensecc-device-key-"));
  try {
    const generate = spawnSync(process.execPath, ["scripts/device-key.mjs", "generate", "--out-dir", outDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(generate.status, 0, generate.stderr);

    const publicRecord = JSON.parse(readFileSync(join(outDir, "device_public_key.json"), "utf8"));
    const spki = Buffer.from(publicRecord.public_key_spki_der_base64, "base64");
    assert.equal(publicRecord.algorithm, "ecdsa-p256-sha256");
    assert.equal(publicRecord.key_id, `sha256:${createHash("sha256").update(spki).digest("hex")}`);

    const sign = spawnSync(
      process.execPath,
      [
        "scripts/device-key.mjs",
        "sign",
        "--private-key",
        join(outDir, "device_private_key.pkcs8.pem"),
        "--device-key-id",
        publicRecord.key_id,
        "--fingerprint",
        "a".repeat(64),
        "--nonce",
        "b".repeat(64),
        "--client-hardening",
        "15",
        "--timestamp",
        "1000000",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(sign.status, 0, sign.stderr);
    const proof = JSON.parse(sign.stdout);

    const row = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 3,
    };
    const env = await testKeyEnv(row, {
      REQUEST_SIGNATURE_MODE: "required",
      deviceRows: [
        {
          project: "DEFAULT",
          feature: "DEFAULT",
          license_fingerprint: "a".repeat(64),
          device_key_id: publicRecord.key_id,
          public_key_spki_der_base64: publicRecord.public_key_spki_der_base64,
          status: "active",
        },
      ],
    });
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody({ client_hardening: 15, ...proof })),
      }),
      env,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.code, "entitlement_ok");
  } finally {
    Date.now = originalNow;
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("request proof required mode denies invalid and stale proof", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 3,
    };
    const proof = await requestProofFixture();
    const env = await testKeyEnv(row, { REQUEST_SIGNATURE_MODE: "required", deviceRows: [proof.deviceRow] });

    const invalid = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...proof.body, request_signature: "AA==" }),
      }),
      env,
    );
    assert.equal(invalid.status, 200);
    assert.deepEqual(await invalid.json(), {
      ok: false,
      code: "request_proof_invalid",
      server_time: 1_000_000,
    });

    const staleProof = await requestProofFixture({ request_timestamp: 999_000 });
    const stale = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(staleProof.body),
      }),
      await testKeyEnv(row, { REQUEST_SIGNATURE_MODE: "required", deviceRows: [staleProof.deviceRow] }),
    );
    assert.equal(stale.status, 200);
    assert.deepEqual(await stale.json(), {
      ok: false,
      code: "request_proof_stale",
      server_time: 1_000_000,
    });
  } finally {
    Date.now = originalNow;
  }
});

test("request proof soft mode logs invalid proof but preserves allow behavior", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 3,
    };
    const proof = await requestProofFixture();
    const env = await testKeyEnv(row, { REQUEST_SIGNATURE_MODE: "soft", deviceRows: [proof.deviceRow] });
    const logs = await captureConsoleEvents(async () => {
      const response = await worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...proof.body, request_signature: "AA==" }),
        }),
        env,
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).code, "entitlement_ok");
    });
    const proofLog = logs.find((entry) => entry.event === "verify.request_proof");
    assert.equal(proofLog?.severity, "warn");
    assert.equal(proofLog?.mode, "soft");
    assert.equal(proofLog?.result, "invalid_signature");
  } finally {
    Date.now = originalNow;
  }
});

test("invalid client_hardening values are rejected like other malformed fields", async () => {
  for (const value of [-1, 1.5, "x", 70000]) {
    assert.equal(validateVerifyRequest(validBody({ client_hardening: value })), null, `value=${value}`);
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody({ client_hardening: value })),
      }),
      await testKeyEnv(null),
    );
    assert.equal(response.status, 400, `value=${value}`);
    assert.deepEqual(await response.json(), { ok: false, code: "invalid_request" }, `value=${value}`);
  }
});

test("canonical online assertion payload is byte exact", () => {
  const payload = canonicalPayloadForTests({
    purpose: "licensecc-online-assertion",
    version: "1",
    alg: "rsa-pkcs1-sha256",
    keyId: "sha256:test-key",
    project: "DEFAULT",
    feature: "EXPORT",
    licenseFingerprint: "a".repeat(64),
    deviceHash: "b".repeat(64),
    nonce: "c".repeat(64),
    status: "ok",
    issuedAt: 1000,
    expiresAt: 1300,
    cacheUntil: 1600,
    revocationSeq: 42,
  });
  assert.equal(
    payload,
    [
      "purpose=licensecc-online-assertion",
      "version=1",
      "alg=rsa-pkcs1-sha256",
      "key-id=sha256:test-key",
      "project=DEFAULT",
      "feature=EXPORT",
      `license-fingerprint=${"a".repeat(64)}`,
      `device-hash=${"b".repeat(64)}`,
      `nonce=${"c".repeat(64)}`,
      "status=ok",
      "issued-at=1000",
      "expires-at=1300",
      "cache-until=1600",
      "revocation-seq=42",
      "",
    ].join("\n"),
  );
});

test("canonical online assertion payload matches shared golden fixture", () => {
  const fixtureDir = join(process.cwd(), "../../test/vectors/online_assertion");
  const keyId = readFileSync(join(fixtureDir, "golden.key_id"), "utf8").trim();
  const fixturePayload = readFileSync(join(fixtureDir, "golden.payload"), "utf8");
  const fixtureAssertion = readFileSync(join(fixtureDir, "golden.assertion"), "utf8").trim();
  const payload = canonicalPayloadForTests({
    purpose: "licensecc-online-assertion",
    version: "1",
    alg: "rsa-pkcs1-sha256",
    keyId,
    project: "DEFAULT",
    feature: "EXPORT",
    licenseFingerprint: "a".repeat(64),
    deviceHash: "b".repeat(64),
    nonce: "c".repeat(64),
    status: "ok",
    issuedAt: 1000,
    expiresAt: 1300,
    cacheUntil: 1600,
    revocationSeq: 42,
  });
  assert.equal(payload, fixturePayload);
  assert.equal(Buffer.from(fixtureAssertion.split(".")[1], "base64").toString("utf8"), fixturePayload);
});

test("health route returns status", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), await testKeyEnv(null));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("signing key import is cached for a stable key", async () => {
  resetSigningKeyCacheForTests();
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const env = await testKeyEnv(row);
  for (let i = 0; i < 2; ++i) {
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody({ nonce: `${i}${"b".repeat(63)}` })),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  assert.equal(signingKeyImportCountForTests(), 1);
});

test("valid entitlement returns signed assertion with nonce", async () => {
  const row = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    await testKeyEnv(row),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.assertion, /^lccoa1\./);
  const payload = Buffer.from(body.assertion.split(".")[1], "base64").toString("utf8");
  assert.match(payload, /status=ok\n/);
  assert.match(payload, new RegExp(`nonce=${"b".repeat(64)}\\n`));
});

test("cache-until grace window exceeds expires-at when cache ttl is larger", async () => {
  const originalNow = Date.now;
  Date.now = () => 2_000_000_000;
  try {
    const row = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 7,
    };
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv(row),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    const payload = Buffer.from(body.assertion.split(".")[1], "base64").toString("utf8");
    const issuedAt = Number(payload.match(/issued-at=(\d+)\n/)[1]);
    const expiresAt = Number(payload.match(/expires-at=(\d+)\n/)[1]);
    const cacheUntil = Number(payload.match(/cache-until=(\d+)\n/)[1]);
    assert.equal(expiresAt, issuedAt + 120);
    assert.equal(cacheUntil, issuedAt + 600);
    assert.ok(cacheUntil > expiresAt, "cache-until must exceed expires-at when cache ttl is larger");
    // C++ client rejects cache_until - issued_at > 86400; stay within the bound.
    assert.ok(cacheUntil - issuedAt <= 86400);
  } finally {
    Date.now = originalNow;
  }
});

test("rate limited request returns 429 before D1 lookup", async () => {
  let dbPrepareCount = 0;
  const env = await testKeyEnv(null, {
    VERIFY_RATE_LIMITER: {
      async limit(input) {
        assert.equal(input.key, "client:203.0.113.10");
        return { success: false };
      },
    },
    DB: {
      prepare() {
        ++dbPrepareCount;
        throw new Error("D1 should not be used for rate-limited requests");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: "rate_limited" });
  assert.equal(dbPrepareCount, 0);
});

test("D1 client rate limiter returns 429 before entitlement lookup", async () => {
  let entitlementLookupCount = 0;
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    D1_RATE_LIMIT_LIMIT: "20",
    D1_RATE_LIMIT_PERIOD_SECONDS: "60",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind(namespace, key, windowStart, expiresAt, updatedAt) {
              assert.equal(namespace, "verify-v1-client");
              assert.equal(key, "client:203.0.113.10");
              assert.equal(Number.isInteger(windowStart), true);
              assert.equal(Number.isInteger(expiresAt), true);
              assert.equal(Number.isInteger(updatedAt), true);
              return {
                async first() {
                  return { request_count: 21 };
                },
              };
            },
          };
        }
        ++entitlementLookupCount;
        throw new Error("entitlement lookup should not be used for D1-rate-limited requests");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: "rate_limited" });
  assert.equal(entitlementLookupCount, 0);
});

test("D1 entitlement rate limiter returns 429 after client tier passes", async () => {
  let entitlementLookupCount = 0;
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    D1_RATE_LIMIT_LIMIT: "20",
    D1_RATE_LIMIT_PERIOD_SECONDS: "60",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind(namespace, key) {
              if (namespace === "verify-v1-client") {
                assert.equal(key, "client:203.0.113.10");
                return {
                  async first() {
                    return { request_count: 1 };
                  },
                };
              }
              assert.equal(namespace, "verify-v1-entitlement");
              assert.equal(key, `DEFAULT:DEFAULT:${"a".repeat(64)}`);
              return {
                async first() {
                  return { request_count: 21 };
                },
              };
            },
          };
        }
        if (sql.startsWith("DELETE FROM rate_limit_counters")) {
          return {
            bind() {
              return {
                async run() {
                  return {};
                },
              };
            },
          };
        }
        ++entitlementLookupCount;
        throw new Error("entitlement lookup should not be used for D1-rate-limited requests");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, code: "rate_limited" });
  assert.equal(entitlementLookupCount, 0);
});

test("D1 rate limiter cleans expired counters on first request in window", async () => {
  let cleanupCount = 0;
  let entitlementLookupCount = 0;
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind() {
              return {
                async first() {
                  return { request_count: 1 };
                },
              };
            },
          };
        }
        if (sql.startsWith("DELETE FROM rate_limit_counters")) {
          return {
            bind(nowSeconds) {
              assert.equal(Number.isInteger(nowSeconds), true);
              return {
                async run() {
                  ++cleanupCount;
                  return {};
                },
              };
            },
          };
        }
        if (sql.startsWith("SELECT project, feature, license_fingerprint")) {
          ++entitlementLookupCount;
          return {
            bind() {
              return {
                async first() {
                  return null;
                },
              };
            },
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "entitlement_denied");
  assert.equal(cleanupCount, 2);
  assert.equal(entitlementLookupCount, 1);
});

test("rate limiter failure returns controlled error", async () => {
  const env = await testKeyEnv(null, {
    VERIFY_RATE_LIMITER: {
      async limit() {
        throw new Error("simulated rate limiter outage");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
});

test("D1 rate limiter failure returns controlled error", async () => {
  const env = await testKeyEnv(null, {
    D1_RATE_LIMIT_ENABLED: "1",
    DB: {
      prepare(sql) {
        if (sql.startsWith("INSERT INTO rate_limit_counters")) {
          return {
            bind() {
              return {
                async first() {
                  throw new Error("simulated D1 limiter outage");
                },
              };
            },
          };
        }
        throw new Error("entitlement lookup should not run after D1 limiter failure");
      },
    },
  });

  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
});

test("unknown entitlement returns unsigned denial by default", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    await testKeyEnv(null),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "entitlement_denied");
  assert.equal(body.assertion, undefined);
});

test("inactive entitlement states return unsigned denial by default", async () => {
  for (const status of ["disabled", "revoked"]) {
    const row = {
      ...validBody(),
      status,
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 4,
    };
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv(row),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "entitlement_denied");
    assert.equal(body.assertion, undefined);
    assert.equal(typeof body.server_time, "number");
  }
});

test("device mismatch returns unsigned denial by default", async () => {
  const row = {
    ...validBody(),
    device_hash: "c".repeat(64),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 5,
  };
  const response = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody({ device_hash: "d".repeat(64) })),
    }),
    await testKeyEnv(row),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "entitlement_denied");
  assert.equal(body.assertion, undefined);
});

test("validity windows are enforced and clamp assertion lifetime", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const activeRow = {
      ...validBody(),
      status: "active",
      assertion_ttl_seconds: 120,
      cache_ttl_seconds: 600,
      revocation_seq: 9,
      valid_from: 900,
      valid_until: 1050,
    };
    const active = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv(activeRow),
    );
    assert.equal(active.status, 200);
    const activeBody = await active.json();
    assert.equal(activeBody.ok, true);
    const activePayload = Buffer.from(activeBody.assertion.split(".")[1], "base64").toString("utf8");
    assert.match(activePayload, /expires-at=1050\n/);
    assert.match(activePayload, /cache-until=1050\n/);

    const expired = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv({ ...activeRow, valid_until: 1000 }),
    );
    assert.equal(expired.status, 200);
    assert.deepEqual(await expired.json(), { ok: false, code: "entitlement_denied", server_time: 1000 });

    const notYetValid = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody()),
      }),
      await testKeyEnv({ ...activeRow, valid_from: 1001, valid_until: 1100 }),
    );
    assert.equal(notYetValid.status, 200);
    assert.deepEqual(await notYetValid.json(), { ok: false, code: "entitlement_denied", server_time: 1000 });
  } finally {
    Date.now = originalNow;
  }
});

test("malformed and oversized requests are rejected", async () => {
  const env = await testKeyEnv(null);
  const malformed = await worker.fetch(
    new Request("https://example.test/v1/verify", { method: "POST", body: "{" }),
    env,
  );
  assert.equal(malformed.status, 400);

  const oversized = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-length": "4097" },
      body: JSON.stringify(validBody()),
    }),
    env,
  );
  assert.equal(oversized.status, 413);
});

test("D1 and signing failures return controlled errors", async () => {
  const d1FailureEnv = await testKeyEnv(null, {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                throw new Error("simulated D1 outage");
              },
            };
          },
        };
      },
    },
  });
  const d1Failure = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    d1FailureEnv,
  );
  assert.equal(d1Failure.status, 500);
  assert.deepEqual(await d1Failure.json(), { ok: false, code: "verification_error" });

  const signingFailureRow = {
    ...validBody(),
    status: "active",
    assertion_ttl_seconds: 120,
    cache_ttl_seconds: 600,
    revocation_seq: 3,
  };
  const signingFailureEnv = await testKeyEnv(signingFailureRow, {
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "not a private key",
  });
  const signingFailure = await worker.fetch(
    new Request("https://example.test/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    }),
    signingFailureEnv,
  );
  assert.equal(signingFailure.status, 500);
  assert.deepEqual(await signingFailure.json(), { ok: false, code: "verification_error" });
});

// Stateful test env: real entitlement + device rows + an in-memory nonce store so a
// second identical request observes the consumed nonce.
async function replayTestEnv(row, proof, envOverrides = {}) {
  const base = await testKeyEnv(row, {
    REQUEST_SIGNATURE_MODE: "required",
    deviceRows: [proof.deviceRow],
    ...envOverrides,
  });
  const consumed = new Set();
  const innerPrepare = base.DB.prepare.bind(base.DB);
  base.DB.prepare = (sql) => {
    if (sql.includes("INSERT INTO request_proof_nonces")) {
      return {
        bind(project, feature, fingerprint, deviceKeyId, nonce) {
          const key = [project, feature, fingerprint, deviceKeyId, nonce].join("|");
          return {
            async first() {
              if (consumed.has(key)) return null; // ON CONFLICT DO NOTHING -> no row
              consumed.add(key);
              return { nonce };
            },
          };
        },
      };
    }
    if (sql.includes("DELETE FROM request_proof_nonces")) {
      return { bind: () => ({ async run() {} }) };
    }
    return innerPrepare(sql);
  };
  return { env: base, failNonceStore: () => { base.DB.prepare = failingNoncePrepare(innerPrepare); } };
}

function failingNoncePrepare(innerPrepare) {
  return (sql) => {
    if (sql.includes("request_proof_nonces")) {
      return { bind: () => ({ async first() { throw new Error("d1 down"); }, async run() { throw new Error("d1 down"); } }) };
    }
    return innerPrepare(sql);
  };
}

test("required mode denies a replayed request proof on the second identical request", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env } = await replayTestEnv(row, proof);
    const send = () =>
      worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
    const first = await send();
    assert.equal((await first.json()).ok, true);

    const replay = await send();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: false, code: "request_proof_invalid", server_time: 1_000_000 });
  } finally {
    Date.now = originalNow;
  }
});

test("required mode fails CLOSED when the nonce store errors", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env, failNonceStore } = await replayTestEnv(row, proof);
    failNonceStore();
    const response = await worker.fetch(
      new Request("https://example.test/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proof.body),
      }),
      env,
    );
    // d1_error on the proof path returns HTTP 500 verification_error (never an allow).
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, code: "verification_error" });
  } finally {
    Date.now = originalNow;
  }
});

test("soft mode logs a replayed nonce but still allows", async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000;
  try {
    const row = { ...validBody(), status: "active", assertion_ttl_seconds: 120, cache_ttl_seconds: 600, revocation_seq: 3 };
    const proof = await requestProofFixture();
    const { env } = await replayTestEnv(row, proof, { REQUEST_SIGNATURE_MODE: "soft" });
    const send = () =>
      worker.fetch(
        new Request("https://example.test/v1/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(proof.body),
        }),
        env,
      );
    await (await send()).json();
    const logs = await captureConsoleEvents(async () => {
      const replay = await send();
      assert.equal((await replay.json()).ok, true); // soft still allows
    });
    const proofLog = logs.find((e) => e.event === "verify.request_proof");
    assert.equal(proofLog?.result, "replayed_nonce");
    assert.equal(proofLog?.mode, "soft");
  } finally {
    Date.now = originalNow;
  }
});

test("/health surfaces config-consistency warnings for a half-configured deploy (R2.3)", async () => {
  // Secrets present but their enforcing modes left off -> a permissive posture the operator likely
  // did not intend. Marker-free non-empty values (the check only tests presence, never parses).
  const env = {
    ACCOUNT_TOKEN_PEPPERS: "configured",
    ACCOUNT_TOKEN_MODE: "off",
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "present",
    REQUEST_SIGNATURE_MODE: "off",
    ORDER_SIGNER_SCOPES: "configured",
    ORDER_SIGNER_SCOPE_MODE: "off",
  };
  const res = await worker.fetch(new Request("https://example.test/health"), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.config_warnings));
  assert.ok(body.config_warnings.some((w) => w.includes("ACCOUNT_TOKEN_MODE")));
  assert.ok(body.config_warnings.some((w) => w.includes("REQUEST_SIGNATURE_MODE")));
  assert.ok(body.config_warnings.some((w) => w.includes("ORDER_SIGNER_SCOPE_MODE")));
});

test("/health has no config_warnings when enforcing modes match the configured secrets (R2.3)", async () => {
  const env = {
    ACCOUNT_TOKEN_PEPPERS: "configured",
    ACCOUNT_TOKEN_MODE: "required",
    ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: "present",
    REQUEST_SIGNATURE_MODE: "required",
  };
  const res = await worker.fetch(new Request("https://example.test/health"), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.config_warnings, undefined);
});
