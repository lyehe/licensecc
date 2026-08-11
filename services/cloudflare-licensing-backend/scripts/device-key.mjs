import { createHash, webcrypto } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  LEASE_REQUEST_PROOF_PURPOSE,
  ONLINE_REQUEST_PROOF_PURPOSE,
  REQUEST_PROOF_ALGORITHM,
  REQUEST_PROOF_VERSION,
  SEAT_REQUEST_PROOF_PURPOSE,
  canonicalRequestProofPayload,
  decodeCanonicalBase64,
  deriveDeviceKeyId,
  encodeCanonicalBase64,
  p256SpkiDerFromCoordinates,
  parseP256SpkiDer,
  verifyRequestProofSignature,
} from "../src/device/request_proof.mjs";

const subtle = webcrypto.subtle;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.:-]+$/;
const VECTOR_GENERATED_BY =
  "npm --prefix services/cloudflare-licensing-backend run device-key -- verify-vectors --dir ../../test/vectors/device_proof/v1 --write-manifest";
const VECTOR_INVENTORY = [
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
const VECTOR_HASHED_FILES = VECTOR_INVENTORY.filter((name) => name !== "manifest.json");
const VECTOR_MANIFEST_KEYS = [
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

function usage() {
  console.error(`usage:
  node scripts/device-key.mjs generate --out-dir <directory>
  node scripts/device-key.mjs sign --private-key <pkcs8-pem> --device-key-id sha256:<64-hex> --fingerprint <64-hex> --nonce <64-hex> [--project DEFAULT] [--feature DEFAULT] [--device-hash <64-hex>] [--client-hardening 0] [--timestamp <epoch>]
  node scripts/device-key.mjs verify-vectors --dir <directory> [--write-manifest]`);
  process.exit(2);
}

function parseArgs(argv) {
  const command = argv[2];
  if (!command) {
    usage();
  }
  const options = {};
  const positionals = [];
  for (let i = 3; i < argv.length; ++i) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--write-manifest") {
      options["write-manifest"] = true;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) {
      usage();
    }
    options[arg.slice(2)] = value;
  }
  return { command, options, positionals };
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validatedName(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !NAME.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return value;
}

function validatedHex(value, label, required = true) {
  if (!required && (value === undefined || value === "")) {
    return "";
  }
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} must be exactly 64 hex characters`);
  }
  return value.toLowerCase();
}

function validatedDeviceKeyId(value) {
  if (typeof value !== "string" || !DEVICE_KEY_ID.test(value)) {
    throw new Error("device-key-id must be sha256:<64 lowercase hex characters>");
  }
  return value;
}

function validatedUnixSeconds(value) {
  const parsed = Number(value ?? Math.floor(Date.now() / 1000));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new Error("timestamp must be a non-negative integer epoch second");
  }
  return parsed;
}

function validatedClientHardening(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) {
    throw new Error("client-hardening must be an integer in [0, 65535]");
  }
  return parsed;
}

function bytesToPem(bytes, label) {
  const b64 = Buffer.from(bytes).toString("base64");
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bytes = Buffer.from(body, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function generate(options, positionals) {
  const outDirArg = options["out-dir"] ?? positionals[0];
  if (outDirArg === undefined || outDirArg === "") {
    throw new Error("out-dir is required");
  }
  const outDir = resolve(outDirArg);
  const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey));
  const spki = new Uint8Array(await subtle.exportKey("spki", keyPair.publicKey));
  const keyId = await deriveDeviceKeyId(spki);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/device_private_key.pkcs8.pem`, bytesToPem(pkcs8, "PRIVATE KEY"), { mode: 0o600 });
  writeFileSync(`${outDir}/device_public_key.spki.der.b64`, Buffer.from(spki).toString("base64") + "\n");
  writeFileSync(
    `${outDir}/device_public_key.json`,
    JSON.stringify(
      {
        key_id: keyId,
        algorithm: REQUEST_PROOF_ALGORITHM,
        public_key_spki_der_base64: Buffer.from(spki).toString("base64"),
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`wrote device key material to ${outDir}`);
  console.log(`key id: ${keyId}`);
  console.log("register device_public_key.json with scripts/entitlement.mjs device-upsert");
}

async function sign(options) {
  const fields = {
    project: validatedName(options.project ?? "DEFAULT", "project", 127),
    feature: validatedName(options.feature ?? "DEFAULT", "feature", 15),
    fingerprint: validatedHex(requireOption(options, "fingerprint"), "fingerprint"),
    deviceHash: validatedHex(options["device-hash"], "device-hash", false),
    nonce: validatedHex(requireOption(options, "nonce"), "nonce"),
    timestamp: validatedUnixSeconds(options.timestamp),
    clientHardening: validatedClientHardening(options["client-hardening"]),
    deviceKeyId: validatedDeviceKeyId(requireOption(options, "device-key-id")),
  };
  const privateKeyPem = readFileSync(resolve(requireOption(options, "private-key")), "utf8");
  const privateKey = await subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const payload = canonicalRequestProofPayload({
    purpose: ONLINE_REQUEST_PROOF_PURPOSE,
    version: REQUEST_PROOF_VERSION,
    algorithm: REQUEST_PROOF_ALGORITHM,
    project: fields.project,
    feature: fields.feature,
    licenseFingerprint: fields.fingerprint,
    deviceHash: fields.deviceHash,
    nonce: fields.nonce,
    requestTimestamp: fields.timestamp,
    clientHardening: fields.clientHardening,
    deviceKeyId: fields.deviceKeyId,
  });
  const signature = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(payload)),
  );
  process.stdout.write(
    JSON.stringify(
      {
        request_signature_version: REQUEST_PROOF_VERSION,
        device_key_id: fields.deviceKeyId,
        request_timestamp: fields.timestamp,
        request_signature_algorithm: REQUEST_PROOF_ALGORITHM,
        request_signature: Buffer.from(signature).toString("base64"),
      },
      null,
      2,
    ) + "\n",
  );
}

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys must be exactly: ${expected.join(", ")}`);
  }
}

function singleLine(bytes, label) {
  const value = Buffer.from(bytes).toString("utf8");
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\r")) {
    fail(`${label} must contain one LF-terminated line`);
  }
  return value.slice(0, -1);
}

function equalBytes(left, right, label) {
  if (!Buffer.from(left).equals(Buffer.from(right))) {
    fail(`${label} does not match`);
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function validateVectorInventory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(VECTOR_INVENTORY)) {
    fail(`vector inventory must be exactly: ${VECTOR_INVENTORY.join(", ")}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`vector entry must be a regular non-symlink file: ${entry.name}`);
    }
  }
}

function validateVectorRoot(directory) {
  let root;
  try {
    root = lstatSync(directory);
  } catch (error) {
    fail(`vector root cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    fail("vector root must be a non-symlink directory");
  }
}

function parseVectorManifest(directory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  } catch (error) {
    fail(`manifest.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertExactKeys(manifest, VECTOR_MANIFEST_KEYS, "manifest.json");
  if (manifest.schema_version !== 1) fail("schema_version must be integer 1");
  if (manifest.protocol !== "licensecc-request-proof") fail("protocol must be licensecc-request-proof");
  if (manifest.proof_version !== REQUEST_PROOF_VERSION) fail("proof_version must be integer 1");
  if (manifest.algorithm !== REQUEST_PROOF_ALGORITHM) fail(`algorithm must be ${REQUEST_PROOF_ALGORITHM}`);
  if (manifest.signed_payload !== "online.payload") fail("signed_payload must be online.payload");
  if (manifest.generated_by !== VECTOR_GENERATED_BY) fail("generated_by does not match the v1 command contract");
  if (typeof manifest.public_x !== "string" || !LOWER_HEX_64.test(manifest.public_x)) {
    fail("public_x must be 64 lowercase hexadecimal characters");
  }
  if (typeof manifest.public_y !== "string" || !LOWER_HEX_64.test(manifest.public_y)) {
    fail("public_y must be 64 lowercase hexadecimal characters");
  }
  if (typeof manifest.device_key_id !== "string" || !DEVICE_KEY_ID.test(manifest.device_key_id)) {
    fail("manifest device_key_id is not canonical");
  }
  assertExactKeys(manifest.files, VECTOR_HASHED_FILES, "manifest files");
  if (JSON.stringify(Object.keys(manifest.files)) !== JSON.stringify(VECTOR_HASHED_FILES)) {
    fail("manifest files keys must be in lexical order");
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (typeof digest !== "string" || !LOWER_HEX_64.test(digest)) {
      fail(`manifest digest must be lowercase SHA-256 for ${name}`);
    }
  }
  return manifest;
}

function vectorPayloadFields(manifest, purpose) {
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

function vectorPayloads(manifest) {
  return new Map([
    ["online.payload", canonicalRequestProofPayload(vectorPayloadFields(manifest, ONLINE_REQUEST_PROOF_PURPOSE))],
    ["lease.payload", canonicalRequestProofPayload(vectorPayloadFields(manifest, LEASE_REQUEST_PROOF_PURPOSE))],
    ["seat.payload", canonicalRequestProofPayload(vectorPayloadFields(manifest, SEAT_REQUEST_PROOF_PURPOSE))],
  ]);
}

function candidateManifest(manifest, contents) {
  const files = {};
  for (const name of VECTOR_HASHED_FILES) files[name] = sha256Hex(contents.get(name));
  return {
    schema_version: manifest.schema_version,
    protocol: manifest.protocol,
    proof_version: manifest.proof_version,
    algorithm: manifest.algorithm,
    project: manifest.project,
    feature: manifest.feature,
    license_fingerprint: manifest.license_fingerprint,
    device_hash: manifest.device_hash,
    nonce: manifest.nonce,
    request_timestamp: manifest.request_timestamp,
    client_hardening: manifest.client_hardening,
    device_key_id: manifest.device_key_id,
    signed_payload: manifest.signed_payload,
    public_x: manifest.public_x,
    public_y: manifest.public_y,
    generated_by: manifest.generated_by,
    files,
  };
}

function replaceGeneratedVectorFiles(directory, updates) {
  const marker = `${process.pid}.${Date.now()}`;
  const pending = [];
  const backedUp = [];
  const installed = [];
  try {
    let index = 0;
    for (const [name, bytes] of updates) {
      const target = join(directory, name);
      const temporary = join(directory, `.${name}.tmp.${marker}.${index}`);
      const backup = join(directory, `.${name}.bak.${marker}.${index}`);
      writeFileSync(temporary, bytes, { flag: "wx" });
      pending.push({ target, temporary, backup });
      index += 1;
    }
    for (const item of pending) {
      renameSync(item.target, item.backup);
      backedUp.push(item);
    }
    for (const item of pending) {
      renameSync(item.temporary, item.target);
      installed.push(item);
    }
  } catch (error) {
    let rollbackFailure;
    for (const item of [...installed].reverse()) {
      try {
        if (existsSync(item.target)) unlinkSync(item.target);
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError;
      }
    }
    for (const item of [...backedUp].reverse()) {
      try {
        if (existsSync(item.backup)) renameSync(item.backup, item.target);
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError;
      }
    }
    for (const item of pending) {
      try {
        if (existsSync(item.temporary)) unlinkSync(item.temporary);
      } catch (rollbackError) {
        rollbackFailure ??= rollbackError;
      }
    }
    if (rollbackFailure !== undefined) {
      throw new Error(`vector update failed and rollback was incomplete: ${String(rollbackFailure)}`, { cause: error });
    }
    throw error;
  }
  for (const item of backedUp) rmSync(item.backup, { force: true });
}

async function verifyVectors(options, positionals) {
  const allowedOptions = new Set(["dir", "write-manifest"]);
  if (positionals.length !== 0 || Object.keys(options).some((name) => !allowedOptions.has(name))) usage();
  const directory = resolve(requireOption(options, "dir"));
  const writeManifest = options["write-manifest"] === true;
  if (options["write-manifest"] !== undefined && !writeManifest) usage();
  validateVectorRoot(directory);
  validateVectorInventory(directory);
  const manifest = parseVectorManifest(directory);
  const payloads = vectorPayloads(manifest);

  const spkiHex = singleLine(readFileSync(join(directory, "public_key.spki.der.hex")), "public_key.spki.der.hex");
  if (!/^[0-9a-f]{182}$/.test(spkiHex)) fail("public_key.spki.der.hex must contain exactly 91 lowercase-hex bytes");
  const spkiFromHex = new Uint8Array(Buffer.from(spkiHex, "hex"));
  const spkiBase64 = singleLine(readFileSync(join(directory, "public_key.spki.der.b64")), "public_key.spki.der.b64");
  const spkiFromBase64 = decodeCanonicalBase64(spkiBase64, 91);
  equalBytes(spkiFromHex, spkiFromBase64, "public SPKI hex/base64");
  const parsedSpki = parseP256SpkiDer(spkiFromHex);
  if (parsedSpki.publicX !== manifest.public_x || parsedSpki.publicY !== manifest.public_y) {
    fail("public coordinates do not match the canonical SPKI");
  }
  equalBytes(
    p256SpkiDerFromCoordinates(manifest.public_x, manifest.public_y),
    spkiFromHex,
    "SPKI reconstructed from public coordinates",
  );
  if (encodeCanonicalBase64(spkiFromHex) !== spkiBase64) fail("public SPKI base64 does not re-emit canonically");
  const derivedKeyId = await deriveDeviceKeyId(spkiFromHex);
  const keyIdFile = singleLine(readFileSync(join(directory, "device_key_id.txt")), "device_key_id.txt");
  if (derivedKeyId !== manifest.device_key_id || keyIdFile !== manifest.device_key_id) {
    fail("device key id does not match the canonical SPKI");
  }

  const signatureHex = singleLine(readFileSync(join(directory, "signature.p1363.hex")), "signature.p1363.hex");
  if (!/^[0-9a-f]{128}$/.test(signatureHex)) fail("signature.p1363.hex must contain exactly 64 lowercase-hex bytes");
  const signatureFromHex = new Uint8Array(Buffer.from(signatureHex, "hex"));
  const signatureBase64 = singleLine(readFileSync(join(directory, "signature.p1363.b64")), "signature.p1363.b64");
  const signatureFromBase64 = decodeCanonicalBase64(signatureBase64, 64);
  equalBytes(signatureFromHex, signatureFromBase64, "signature P1363 hex/base64");
  if (encodeCanonicalBase64(signatureFromHex) !== signatureBase64) fail("signature base64 does not re-emit canonically");
  if (
    !(await verifyRequestProofSignature(
      payloads.get(manifest.signed_payload),
      spkiBase64,
      signatureBase64,
      manifest.device_key_id,
    ))
  ) {
    fail("fixed request-proof signature does not verify");
  }

  const contents = new Map();
  for (const name of VECTOR_HASHED_FILES) contents.set(name, readFileSync(join(directory, name)));
  for (const [name, payload] of payloads) contents.set(name, Buffer.from(payload, "utf8"));
  const nextManifest = candidateManifest(manifest, contents);
  assertExactKeys(nextManifest, VECTOR_MANIFEST_KEYS, "candidate manifest");
  assertExactKeys(nextManifest.files, VECTOR_HASHED_FILES, "candidate manifest files");
  if (JSON.stringify(Object.keys(nextManifest.files)) !== JSON.stringify(VECTOR_HASHED_FILES)) {
    fail("candidate manifest files are not in lexical order");
  }

  if (writeManifest) {
    const updates = new Map(payloads);
    updates.set("manifest.json", Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`, "utf8"));
    replaceGeneratedVectorFiles(directory, updates);
    console.log(`updated and verified request-proof v1 vectors in ${directory}`);
    return;
  }

  for (const [name, payload] of payloads) {
    equalBytes(readFileSync(join(directory, name)), Buffer.from(payload, "utf8"), name);
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(nextManifest.files)) {
    fail("manifest file hashes do not match the complete vector inventory");
  }
  console.log(`verified request-proof v1 vectors in ${directory}`);
}

try {
  const { command, options, positionals } = parseArgs(process.argv);
  if (command === "generate") {
    await generate(options, positionals);
  } else if (command === "sign") {
    await sign(options);
  } else if (command === "verify-vectors") {
    await verifyVectors(options, positionals);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
