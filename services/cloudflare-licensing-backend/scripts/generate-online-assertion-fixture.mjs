import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

function usage() {
  console.error("usage: node scripts/generate-online-assertion-fixture.mjs [--out-dir <directory>] [--signing-key-file <path>]");
  process.exit(2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function buildPayload(keyId) {
  return [
    "purpose=licensecc-online-assertion",
    "version=1",
    "alg=rsa-pkcs1-sha256",
    `key-id=${keyId}`,
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
  ].join("\n");
}

const outDir = resolve(argValue("--out-dir") ?? "../../test/vectors/online_assertion");
const signingKeyFile = argValue("--signing-key-file");
if (process.argv.some((arg) => arg === "--help" || arg === "-h")) {
  usage();
}

let privateKey;
let publicKey;
if (signingKeyFile) {
  privateKey = createPrivateKey(readFileSync(resolve(signingKeyFile)));
  publicKey = privateKey.asymmetricKeyType === "rsa" ? createPublicKey(privateKey) : null;
} else {
  ({ privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
  }));
}

if (publicKey === null) {
  throw new Error("signing key must be RSA");
}

const publicDer = publicKey.export({ type: "pkcs1", format: "der" });
const keyId = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
const payload = buildPayload(keyId);
const signature = sign("RSA-SHA256", Buffer.from(payload, "utf8"), privateKey).toString("base64");
const assertion = `lccoa1.${Buffer.from(payload, "utf8").toString("base64")}.${signature}`;

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/golden.key_id`, `${keyId}\n`);
writeFileSync(`${outDir}/golden.public_key.pkcs1.der.hex`, `${publicDer.toString("hex")}\n`);
writeFileSync(`${outDir}/golden.payload`, payload);
writeFileSync(`${outDir}/golden.assertion`, `${assertion}\n`);

console.log(`wrote online assertion fixture to ${outDir}`);
console.log(`key id: ${keyId}`);
