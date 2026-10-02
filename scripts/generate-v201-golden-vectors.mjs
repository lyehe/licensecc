// Regenerates the signed v201 golden license vectors under test/vectors/v201/ and the generator's
// copies of their canonical payloads under extern/license-generator/test/data/v201/.
//
// The vectors are signed with the generator's 3072-bit fixture key,
// extern/license-generator/test/data/private_key_3072.rsa, so they verify under the runtime's
// 3072-bit floor. RSASSA-PKCS1-v1_5 signatures are deterministic, so the output is stable: with
// no argument the script checks that the committed files match it; --write rewrites them.
//
// The canonical payload rules mirror src/library/base/v201_canonical_payload.cpp. The C++ tests
// rebuild each payload from its fields and re-sign it, so any drift between the two fails there.
import { createHash, createPrivateKey, createPublicKey, sign, constants } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PRIVATE_KEY_PATH = "extern/license-generator/test/data/private_key_3072.rsa";
export const VECTOR_DIRECTORY = "test/vectors/v201";
export const GENERATOR_VECTOR_DIRECTORY = "extern/license-generator/test/data/v201";

const DOMAIN = "licensecc:v201\n";
const CANONICAL_ORDER = [
  "lic_ver", "canonical-v", "sig-v", "sig-alg", "key-id", "project", "feature", "valid-from", "valid-to",
  "start-version", "end-version", "custom-limit", "client-signature", "client-signature-source-strength",
  "extra-data",
];
// The license section header carries the feature; project and feature are signed but not stored.
const UNSTORED_FIELDS = new Set(["project", "feature"]);

/** The signed fields of each golden license, before the key id is known. */
export function goldenFields(keyId) {
  const minimal = {
    "lic_ver": "201",
    "canonical-v": "1",
    "sig-v": "1",
    "sig-alg": "rsa-pkcs1-sha256",
    "key-id": keyId,
    "project": "MY_PRODUCT",
    "feature": "MY_PRODUCT",
  };
  const full = {
    ...minimal,
    "valid-from": "2024-01-02",
    "valid-to": "2035-12-31",
    "start-version": "1.2.3",
    "end-version": "9.9.9",
    "client-signature": "AEBC-Q0RF-Rkc=",
    "client-signature-source-strength": "strong-disk-serial-or-uuid",
    "extra-data": "alpha",
  };
  return { minimal, full };
}

function frame(length) {
  return length.toString(16).padStart(8, "0");
}

/** The v201 canonical payload bytes for a field map, in the canonical field order. */
export function canonicalPayload(fields) {
  let text = DOMAIN;
  for (const key of CANONICAL_ORDER) {
    if (!(key in fields)) continue;
    const value = fields[key];
    text += `k${frame(Buffer.byteLength(key))}:${key}v${frame(Buffer.byteLength(value))}:${value}\n`;
  }
  return Buffer.from(text, "latin1");
}

/** The stored license text: the feature section with every stored field, then the signature. */
function licenseText(fields, signature) {
  const lines = [`[${fields.feature}]`];
  for (const key of CANONICAL_ORDER) {
    if (key in fields && !UNSTORED_FIELDS.has(key)) lines.push(`${key} = ${fields[key]}`);
  }
  lines.push(`sig = ${signature}`);
  return `${lines.join("\n")}\n`;
}

/** Every generated file, keyed by its repository-relative path. */
export function renderV201GoldenVectors(privateKeyPem = readFileSync(resolve(repositoryRoot, PRIVATE_KEY_PATH), "utf8")) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyDer = createPublicKey(privateKey).export({ type: "pkcs1", format: "der" });
  const keyId = `sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  const files = new Map([
    [`${VECTOR_DIRECTORY}/public_key.pkcs1.der.hex`, `${publicKeyDer.toString("hex")}\n`],
    [`${VECTOR_DIRECTORY}/public_key.id`, `${keyId}\n`],
  ]);
  for (const [name, fields] of Object.entries(goldenFields(keyId))) {
    const payload = canonicalPayload(fields);
    const signature = sign("sha256", payload, { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64");
    files.set(`${VECTOR_DIRECTORY}/${name}.payload.hex`, `${payload.toString("hex")}\n`);
    files.set(`${VECTOR_DIRECTORY}/${name}.signature.b64`, `${signature}\n`);
    files.set(`${VECTOR_DIRECTORY}/${name}.license`, licenseText(fields, signature));
    files.set(`${VECTOR_DIRECTORY}/${name}.expected-result`, "FUNC_RET_OK\n");
    files.set(`${GENERATOR_VECTOR_DIRECTORY}/${name}.payload.hex`, `${payload.toString("hex")}\n`);
  }
  return files;
}

/** Paths whose checked-out content differs from the generator output, or an empty list. */
export function v201GoldenVectorDrift(readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8")) {
  const drifted = [];
  for (const [path, expected] of renderV201GoldenVectors()) {
    let actual;
    try {
      // A Windows checkout may carry CRLF line endings; the committed blobs are LF.
      actual = readText(path).replace(/\r\n/gu, "\n");
    } catch {
      actual = null;
    }
    if (actual !== expected) drifted.push(path);
  }
  return drifted;
}

function main() {
  const knownArguments = process.argv.slice(2);
  if (knownArguments.some((argument) => argument !== "--write")) {
    throw new Error("usage: node scripts/generate-v201-golden-vectors.mjs [--write]");
  }
  if (knownArguments.includes("--write")) {
    const files = renderV201GoldenVectors();
    for (const [path, content] of files) writeFileSync(resolve(repositoryRoot, path), content);
    console.log(`Wrote ${files.size} v201 golden vector files signed with ${PRIVATE_KEY_PATH}.`);
    return;
  }
  const drifted = v201GoldenVectorDrift();
  if (drifted.length > 0) {
    for (const path of drifted) console.error(`${path} differs from the generator output`);
    console.error("Run node scripts/generate-v201-golden-vectors.mjs --write and commit the result.");
    process.exitCode = 1;
    return;
  }
  console.log("The v201 golden vectors match the generator output.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
