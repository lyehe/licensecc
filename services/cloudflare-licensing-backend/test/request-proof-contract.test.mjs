import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ONLINE_REQUEST_PROOF_PURPOSE,
  LEASE_REQUEST_PROOF_PURPOSE,
  SEAT_REQUEST_PROOF_PURPOSE,
  REQUEST_PROOF_ALGORITHM,
  REQUEST_PROOF_VERSION,
  canonicalRequestProofPayload,
  decodeCanonicalBase64,
  deriveDeviceKeyId,
  parseP256SpkiDer,
  verifyRequestProofSignature,
} from "../dist/device/request_proof.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const vectorDirectory = join(repositoryRoot, "test", "vectors", "device_proof", "v1");
const expectedInventory = [
  "README.md",
  "device_key_id.txt",
  "lease.payload",
  "manifest.json",
  "online.payload",
  "public_key.spki.der.b64",
  "public_key.spki.der.hex",
  "seat.payload",
  "signature.p1363.b64",
  "signature.p1363.hex",
];
const expectedManifestKeys = [
  "algorithm",
  "client_hardening",
  "device_hash",
  "device_key_id",
  "feature",
  "files",
  "generated_by",
  "license_fingerprint",
  "nonce",
  "project",
  "proof_version",
  "protocol",
  "public_x",
  "public_y",
  "request_timestamp",
  "schema_version",
  "signed_payload",
];
const generatedBy =
  "npm --prefix services/cloudflare-licensing-backend run device-key -- verify-vectors --dir ../../test/vectors/device_proof/v1 --write-manifest";

function readVector(name) {
  return readFileSync(join(vectorDirectory, name));
}

function readVectorText(name) {
  return readVector(name).toString("utf8");
}

function fixtureFields(manifest, purpose) {
  return {
    purpose,
    version: manifest.proof_version,
    algorithm: manifest.algorithm,
    project: manifest.project,
    feature: manifest.feature,
    licenseFingerprint: manifest.license_fingerprint,
    deviceHash: manifest.device_hash,
    nonce: manifest.nonce,
    requestTimestamp: manifest.request_timestamp,
    clientHardening: manifest.client_hardening,
    deviceKeyId: manifest.device_key_id,
  };
}

function snapshotDirectory(directory) {
  return new Map(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name))]),
  );
}

function assertSnapshotsEqual(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [name, bytes] of expected) {
    assert.deepEqual(actual.get(name), bytes, name);
  }
}

function runVectorVerifier(directory, writeManifest = false) {
  const args = ["scripts/device-key.mjs", "verify-vectors", "--dir", directory];
  if (writeManifest) args.push("--write-manifest");
  return spawnSync(process.execPath, args, { cwd: join(repositoryRoot, "services", "cloudflare-licensing-backend"), encoding: "utf8" });
}

function p1363ToDer(signature) {
  function integer(bytes) {
    let offset = 0;
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1;
    let magnitude = bytes.subarray(offset);
    if ((magnitude[0] & 0x80) !== 0) magnitude = Uint8Array.from([0, ...magnitude]);
    return Uint8Array.from([0x02, magnitude.length, ...magnitude]);
  }
  const r = integer(signature.subarray(0, 32));
  const s = integer(signature.subarray(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

function p1363ScalarPair(r, s) {
  const bytes = Buffer.alloc(64);
  Buffer.from(r.toString(16).padStart(64, "0"), "hex").copy(bytes, 0);
  Buffer.from(s.toString(16).padStart(64, "0"), "hex").copy(bytes, 32);
  return bytes.toString("base64");
}

test("request-proof v1 vectors have the exact inventory and manifest contract", () => {
  assert.deepEqual(readdirSync(vectorDirectory).sort(), expectedInventory);
  const manifest = JSON.parse(readVectorText("manifest.json"));
  assert.deepEqual(Object.keys(manifest).sort(), expectedManifestKeys);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.protocol, "licensecc-request-proof");
  assert.equal(manifest.proof_version, REQUEST_PROOF_VERSION);
  assert.equal(manifest.algorithm, REQUEST_PROOF_ALGORITHM);
  assert.equal(manifest.signed_payload, "online.payload");
  assert.equal(manifest.generated_by, generatedBy);
  assert.deepEqual(Object.keys(manifest.files), [...Object.keys(manifest.files)].sort());
  assert.deepEqual(Object.keys(manifest.files), expectedInventory.filter((name) => name !== "manifest.json"));
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(createHash("sha256").update(readVector(name)).digest("hex"), digest, name);
  }
});

test("all three audiences produce byte-exact payloads and differ only by purpose", () => {
  const manifest = JSON.parse(readVectorText("manifest.json"));
  const audiences = [
    [ONLINE_REQUEST_PROOF_PURPOSE, "online.payload"],
    [LEASE_REQUEST_PROOF_PURPOSE, "lease.payload"],
    [SEAT_REQUEST_PROOF_PURPOSE, "seat.payload"],
  ];
  for (const [purpose, filename] of audiences) {
    assert.equal(canonicalRequestProofPayload(fixtureFields(manifest, purpose)), readVectorText(filename));
  }
  const payloadsWithoutPurpose = audiences.map(([, filename]) => readVectorText(filename).replace(/^purpose=[^\n]+\n/, ""));
  assert.equal(new Set(payloadsWithoutPurpose).size, 1);
});

test("the canonical builder rejects normalization-prone or out-of-contract values", () => {
  const manifest = JSON.parse(readVectorText("manifest.json"));
  const fields = fixtureFields(manifest, ONLINE_REQUEST_PROOF_PURPOSE);
  for (const override of [
    { purpose: "licensecc-unknown-request" },
    { project: " DEFAULT" },
    { feature: "DÉFAULT" },
    { licenseFingerprint: manifest.license_fingerprint.toUpperCase() },
    { deviceHash: "A".repeat(64) },
    { nonce: "B".repeat(64) },
    { requestTimestamp: Number.MAX_SAFE_INTEGER + 1 },
    { clientHardening: 0x10000 },
    { deviceKeyId: `sha256:${"A".repeat(64)}` },
  ]) {
    assert.throws(() => canonicalRequestProofPayload({ ...fields, ...override }));
  }
});

test("the fixed P-256 key id and P1363 signature verify", async () => {
  const manifest = JSON.parse(readVectorText("manifest.json"));
  const spkiBase64 = readVectorText("public_key.spki.der.b64").trimEnd();
  const spki = decodeCanonicalBase64(spkiBase64, 91);
  const parsed = parseP256SpkiDer(spki);
  assert.equal(parsed.publicX, manifest.public_x);
  assert.equal(parsed.publicY, manifest.public_y);
  assert.equal(await deriveDeviceKeyId(spki), manifest.device_key_id);
  assert.equal(readVectorText("device_key_id.txt"), `${manifest.device_key_id}\n`);
  assert.equal(
    await verifyRequestProofSignature(
      readVectorText(manifest.signed_payload),
      spkiBase64,
      readVectorText("signature.p1363.b64").trimEnd(),
      manifest.device_key_id,
    ),
    true,
  );
});

test("strict signature verification rejects the complete Appendix A signature corpus", async () => {
  const manifest = JSON.parse(readVectorText("manifest.json"));
  const spkiBase64 = readVectorText("public_key.spki.der.b64").trimEnd();
  const signatureBase64 = readVectorText("signature.p1363.b64").trimEnd();
  const signature = decodeCanonicalBase64(signatureBase64, 64);
  const onlinePayload = readVectorText("online.payload");
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
  const der = p1363ToDer(signature);
  const nonMinimalDer = Uint8Array.from([
    der[0], der[1] + 1, der[2], der[3] + 1, 0, ...der.subarray(4),
  ]);
  const trailingDer = Uint8Array.from([...der, 0]);

  for (const malformed of [
    Buffer.alloc(63).toString("base64"),
    Buffer.alloc(65).toString("base64"),
    Buffer.from(der).toString("base64"),
    Buffer.from(nonMinimalDer).toString("base64"),
    Buffer.from(trailingDer).toString("base64"),
    p1363ScalarPair(0n, 1n),
    p1363ScalarPair(1n, 0n),
    p1363ScalarPair(order, 1n),
    p1363ScalarPair(1n, order),
    p1363ScalarPair(order + 1n, 1n),
    p1363ScalarPair(1n, order + 1n),
  ]) {
    await assert.rejects(
      verifyRequestProofSignature(onlinePayload, spkiBase64, malformed, manifest.device_key_id),
    );
  }
  for (const nonCanonical of [signatureBase64.slice(0, -2), `${signatureBase64}\n`, signatureBase64.replace("/", "_")]) {
    await assert.rejects(
      verifyRequestProofSignature(onlinePayload, spkiBase64, nonCanonical, manifest.device_key_id),
    );
  }
  for (const highBitScalar of [
    p1363ScalarPair(1n << 255n, 1n),
    p1363ScalarPair(1n, 1n << 255n),
  ]) {
    assert.equal(
      await verifyRequestProofSignature(onlinePayload, spkiBase64, highBitScalar, manifest.device_key_id),
      false,
    );
  }

  const doubleHashKey = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const doubleHashSpki = new Uint8Array(await crypto.subtle.exportKey("spki", doubleHashKey.publicKey));
  const payloadDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(onlinePayload));
  const doubleHashSignature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, doubleHashKey.privateKey, payloadDigest),
  );
  assert.equal(
    await verifyRequestProofSignature(
      onlinePayload,
      Buffer.from(doubleHashSpki).toString("base64"),
      Buffer.from(doubleHashSignature).toString("base64"),
      await deriveDeviceKeyId(doubleHashSpki),
    ),
    false,
  );

  await assert.rejects(
    verifyRequestProofSignature(onlinePayload, spkiBase64, signatureBase64, `sha256:${"0".repeat(64)}`),
  );
  assert.equal(
    await verifyRequestProofSignature(
      readVectorText("lease.payload"),
      spkiBase64,
      signatureBase64,
      manifest.device_key_id,
    ),
    false,
  );
  assert.equal(
    await verifyRequestProofSignature(
      readVectorText("seat.payload"),
      spkiBase64,
      signatureBase64,
      manifest.device_key_id,
    ),
    false,
  );
});

test("strict SPKI parsing rejects the complete Appendix A public-key corpus", async () => {
  const manifest = JSON.parse(readVectorText("manifest.json"));
  const spki = decodeCanonicalBase64(readVectorText("public_key.spki.der.b64").trimEnd(), 91);
  const signature = readVectorText("signature.p1363.b64").trimEnd();
  const payload = readVectorText("online.payload");
  const wrongAlgorithmOid = Uint8Array.from(spki);
  wrongAlgorithmOid[12] ^= 1;
  const wrongCurveOid = Uint8Array.from(spki);
  wrongCurveOid[22] ^= 1;
  const wrongPointForm = Uint8Array.from(spki);
  wrongPointForm[26] = 0x02;
  const invalidPoint = Uint8Array.from(spki);
  invalidPoint.fill(0, 27);
  const nonMinimalDer = Uint8Array.from([0x30, 0x81, 0x59, ...spki.subarray(2)]);
  const trailingDer = Uint8Array.from([...spki, 0]);
  for (const malformed of [
    spki.subarray(0, spki.length - 1),
    wrongAlgorithmOid,
    wrongCurveOid,
    wrongPointForm,
    invalidPoint,
    nonMinimalDer,
    trailingDer,
  ]) {
    assert.throws(() => parseP256SpkiDer(malformed));
    await assert.rejects(
      verifyRequestProofSignature(payload, Buffer.from(malformed).toString("base64"), signature, manifest.device_key_id),
    );
  }
  for (const nonCanonical of [`${readVectorText("public_key.spki.der.b64").trimEnd()}\n`, readVectorText("public_key.spki.der.b64").trimEnd().replace("+", "-")]) {
    await assert.rejects(verifyRequestProofSignature(payload, nonCanonical, signature, manifest.device_key_id));
  }
});

test("the CLI verifies vectors and write-manifest is idempotent", () => {
  const verify = runVectorVerifier(vectorDirectory);
  assert.equal(verify.status, 0, verify.stderr);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "licensecc-request-proof-v1-"));
  const copy = join(temporaryRoot, "v1");
  try {
    cpSync(vectorDirectory, copy, { recursive: true });
    const first = runVectorVerifier(copy, true);
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = snapshotDirectory(copy);
    const second = runVectorVerifier(copy, true);
    assert.equal(second.status, 0, second.stderr);
    assertSnapshotsEqual(snapshotDirectory(copy), afterFirst);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("write-manifest validates the complete candidate before changing files", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "licensecc-request-proof-invalid-"));
  const copy = join(temporaryRoot, "v1");
  try {
    cpSync(vectorDirectory, copy, { recursive: true });
    writeFileSync(join(copy, "signature.p1363.b64"), `${Buffer.alloc(63).toString("base64")}\n`);
    const before = snapshotDirectory(copy);
    const result = runVectorVerifier(copy, true);
    assert.notEqual(result.status, 0);
    assertSnapshotsEqual(snapshotDirectory(copy), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the vector verifier rejects unlisted files and symlinks", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "licensecc-request-proof-inventory-"));
  const copy = join(temporaryRoot, "v1");
  try {
    cpSync(vectorDirectory, copy, { recursive: true });
    writeFileSync(join(copy, "extra.txt"), "unlisted\n");
    assert.notEqual(runVectorVerifier(copy).status, 0);
    rmSync(join(copy, "extra.txt"));
    try {
      symlinkSync(join(copy, "online.payload"), join(copy, "alias.payload"), "file");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        const junctionTarget = join(temporaryRoot, "junction-target");
        mkdirSync(junctionTarget);
        symlinkSync(junctionTarget, join(copy, "alias.payload"), "junction");
      } else {
        throw error;
      }
    }
    assert.notEqual(runVectorVerifier(copy).status, 0);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the vector verifier rejects a symlinked root without changing its target", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "licensecc-request-proof-root-link-"));
  const target = join(temporaryRoot, "real-v1");
  const linkedRoot = join(temporaryRoot, "linked-v1");
  try {
    cpSync(vectorDirectory, target, { recursive: true });
    symlinkSync(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const before = snapshotDirectory(target);
    const verify = runVectorVerifier(linkedRoot);
    assert.notEqual(verify.status, 0);
    const write = runVectorVerifier(linkedRoot, true);
    assert.notEqual(write.status, 0);
    assertSnapshotsEqual(snapshotDirectory(target), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the backend package exposes the Worker-safe typed module", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "services", "cloudflare-licensing-backend", "package.json"), "utf8"));
  assert.deepEqual(packageJson.exports?.["./device/request_proof"], {
    types: "./src/device/request_proof.d.ts",
    default: "./src/device/request_proof.mjs",
  });
  const source = readFileSync(join(repositoryRoot, "services", "cloudflare-licensing-backend", "src", "device", "request_proof.mjs"), "utf8");
  assert.doesNotMatch(source, /(?:from\s+["']node:|\bBuffer\b)/);
});
