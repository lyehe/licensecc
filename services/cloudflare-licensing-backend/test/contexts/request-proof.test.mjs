import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import worker from "../../dist/index.js";
import {
  canonicalRequestProofPayloadForTests,
  validateVerifyRequest,
} from "../../dist/routes/verify.js";
import {
  captureConsoleEvents,
  requestProofFixture,
  testKeyEnv,
  validBody,
} from "./fixtures.mjs";

const TEST_P1363_BASE64 = Buffer.alloc(64, 1).toString("base64");

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
        request_signature: TEST_P1363_BASE64,
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
        request_signature: TEST_P1363_BASE64,
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
      request_signature: TEST_P1363_BASE64,
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
        body: JSON.stringify({ ...proof.body, request_signature: TEST_P1363_BASE64 }),
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
          body: JSON.stringify({ ...proof.body, request_signature: TEST_P1363_BASE64 }),
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
