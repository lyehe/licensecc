import { createHash, webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const subtle = webcrypto.subtle;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const DEVICE_KEY_ID = /^sha256:[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9_.:-]+$/;
const REQUEST_PROOF_ALGORITHM = "ecdsa-p256-sha256";

function usage() {
  console.error(`usage:
  node scripts/device-key.mjs generate --out-dir <directory>
  node scripts/device-key.mjs sign --private-key <pkcs8-pem> --device-key-id sha256:<64-hex> --fingerprint <64-hex> --nonce <64-hex> [--project DEFAULT] [--feature DEFAULT] [--device-hash <64-hex>] [--client-hardening 0] [--timestamp <epoch>]`);
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

function keyIdForSpki(spkiBytes) {
  return `sha256:${createHash("sha256").update(Buffer.from(spkiBytes)).digest("hex")}`;
}

function canonicalRequestProofPayload(fields) {
  return (
    "purpose=licensecc-online-request\n" +
    "version=1\n" +
    `alg=${REQUEST_PROOF_ALGORITHM}\n` +
    `project=${fields.project}\n` +
    `feature=${fields.feature}\n` +
    `license-fingerprint=${fields.fingerprint}\n` +
    `device-hash=${fields.deviceHash}\n` +
    `nonce=${fields.nonce}\n` +
    `request-timestamp=${fields.timestamp}\n` +
    `client-hardening=${fields.clientHardening}\n` +
    `device-key-id=${fields.deviceKeyId}\n`
  );
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
  const keyId = keyIdForSpki(spki);

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
  const payload = canonicalRequestProofPayload(fields);
  const signature = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(payload)),
  );
  process.stdout.write(
    JSON.stringify(
      {
        request_signature_version: 1,
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

try {
  const { command, options, positionals } = parseArgs(process.argv);
  if (command === "generate") {
    await generate(options, positionals);
  } else if (command === "sign") {
    await sign(options);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
