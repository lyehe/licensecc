import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const subtle = webcrypto.subtle;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const NAME = /^[A-Za-z0-9_.:-]+$/;
const ALGORITHM = "rsa-pkcs1-sha256";
const ENVELOPE_PREFIX = "lcccfg1";

function usage() {
  console.error(`usage:
  node scripts/config-sign.mjs --private-key <pkcs8-pem> --key-id sha256:<64-hex> --fingerprint <64-hex> --config <file> --config-id <id> --config-seq <uint> --expires-at <epoch> [--project DEFAULT] [--feature DEFAULT] [--device-hash <64-hex>] [--issued-at <epoch>]`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; ++i) {
    const arg = argv[i];
    if (!arg.startsWith("--")) usage();
    const eq = arg.indexOf("=");
    if (eq !== -1) { options[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const value = argv[++i];
    if (value === undefined) usage();
    options[arg.slice(2)] = value;
  }
  return options;
}

function requireOption(options, name) {
  const v = options[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

function validatedName(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !NAME.test(value)) {
    throw new Error(`${label} must be 1-${maxLength} characters using letters, digits, _, ., :, or -`);
  }
  return value;
}

function validatedHex(value, label, required = true) {
  if (!required && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !HEX_64.test(value)) throw new Error(`${label} must be exactly 64 hex characters`);
  return value.toLowerCase();
}

function validatedUint(value, label, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bytes = Buffer.from(body, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function canonicalConfigPayload(f) {
  return (
    "purpose=licensecc-config-attestation\n" +
    "version=1\n" +
    `alg=${ALGORITHM}\n` +
    `key-id=${f.keyId}\n` +
    `project=${f.project}\n` +
    `feature=${f.feature}\n` +
    `license-fingerprint=${f.fingerprint}\n` +
    `device-hash=${f.deviceHash}\n` +
    `config-id=${f.configId}\n` +
    `config-seq=${f.configSeq}\n` +
    `config-hash=sha256:${f.configHash}\n` +
    `issued-at=${f.issuedAt}\n` +
    `expires-at=${f.expiresAt}\n`
  );
}

async function main() {
  if (process.argv.length <= 2) usage();
  const options = parseArgs(process.argv);
  const configPath = resolve(requireOption(options, "config"));
  const configBytes = readFileSync(configPath);
  const f = {
    keyId: requireOption(options, "key-id"),
    project: validatedName(options.project ?? "DEFAULT", "project", 127),
    feature: validatedName(options.feature ?? "DEFAULT", "feature", 15),
    fingerprint: validatedHex(requireOption(options, "fingerprint"), "fingerprint"),
    deviceHash: validatedHex(options["device-hash"], "device-hash", false),
    configId: validatedName(requireOption(options, "config-id"), "config-id", 64),
    configSeq: validatedUint(requireOption(options, "config-seq"), "config-seq", 0),
    issuedAt: validatedUint(options["issued-at"], "issued-at", 0),
    expiresAt: validatedUint(requireOption(options, "expires-at"), "expires-at", 0),
    configHash: createHash("sha256").update(configBytes).digest("hex"),
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(f.keyId)) throw new Error("key-id must be sha256:<64 lowercase hex>");
  if (f.expiresAt === 0 || f.expiresAt <= f.issuedAt) {
    throw new Error("expires-at must be a non-zero epoch second greater than issued-at; never-expiring config tokens are rejected by the verifier");
  }
  const payload = canonicalConfigPayload(f);
  const privateKeyPem = readFileSync(resolve(requireOption(options, "private-key")), "utf8");
  const privateKey = await subtle.importKey(
    "pkcs8", pemToDer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(
    await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(payload)),
  );
  const token = `${ENVELOPE_PREFIX}.${Buffer.from(payload).toString("base64")}.${Buffer.from(signature).toString("base64")}`;
  process.stdout.write(token + "\n");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); });
