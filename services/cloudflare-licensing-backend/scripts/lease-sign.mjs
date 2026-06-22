// lease-sign.mjs
//
// Node-side lease signer + CLI for the subscription lease platform (design doc D2).
// Produces a v201 hardware-bound `.lic` lease signed with the HOT lease key.
//
// The parity-critical canonical format lives in ../src/lease/canonical_payload.mjs
// (Worker-safe, shared with the lease Worker). This file adds node:crypto signing
// and the offline CLI. Cross-language parity against the C++ verifier is guarded by
// test/lease-sign.test.mjs.
//
// Phase-1 note: signs in-process with Web Crypto via node:crypto. The locked
// architecture's hybrid split (key-isolated keyholder, KMS/HSM apex) is the
// production hardening target; the "sign a vetted payload" surface stays narrow so
// it can move behind that boundary without changing the protocol.

import { subtle } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildV201CanonicalPayload,
  buildLeaseLicenseText,
  leaseCanonicalFields,
  utcDateFromEpoch,
  CANONICAL_ORDER,
  SIGNATURE_ALGORITHM,
} from "../src/lease/canonical_payload.mjs";

// Re-export the shared format helpers so tooling/tests have one import surface.
export { buildV201CanonicalPayload, utcDateFromEpoch, CANONICAL_ORDER, SIGNATURE_ALGORITHM };

function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bytes = Buffer.from(body, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Sign a v201 lease with the hot lease key (PKCS#8 PEM). Returns the license INI
// text, the detached signature, and the canonical payload (for the e2e vector).
export async function signV201Lease(opts) {
  const fields = leaseCanonicalFields(opts);
  const payload = buildV201CanonicalPayload(fields);
  const key = await subtle.importKey("pkcs8", pemToDer(opts.privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, payload.bytes));
  const signatureB64 = Buffer.from(signature).toString("base64");
  return {
    license: buildLeaseLicenseText(fields, signatureB64),
    signatureB64,
    payloadHex: payload.hex,
    keyId: opts.keyId,
    validFrom: opts.validFrom,
    validTo: opts.validTo,
  };
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { options[key] = "true"; } else { options[key] = next; i += 1; }
    }
  }
  return options;
}

function usage() {
  process.stderr.write(
    "usage: node lease-sign.mjs --private-key <pkcs8-pem> --key-id sha256:<64hex> " +
      "--project <name> --feature <FEATURE> --valid-from <YYYY-MM-DD> --valid-to <YYYY-MM-DD> " +
      "[--client-signature <sig> --client-signature-source-strength <s>] [--start-version v] [--end-version v] " +
      "[--extra-data d] [--out <file>]\n",
  );
  process.exit(2);
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options["private-key"] || !options["key-id"]) usage();
  const privateKeyPem = readFileSync(resolve(options["private-key"]), "utf8");
  const result = await signV201Lease({
    project: options.project ?? "DEFAULT",
    feature: options.feature ?? "DEFAULT",
    keyId: options["key-id"],
    privateKeyPem,
    validFrom: options["valid-from"],
    validTo: options["valid-to"],
    clientSignature: options["client-signature"],
    clientSignatureSourceStrength: options["client-signature-source-strength"],
    startVersion: options["start-version"],
    endVersion: options["end-version"],
    extraData: options["extra-data"],
  });
  if (options.out) {
    writeFileSync(resolve(options.out), result.license);
    process.stderr.write(`wrote ${options.out} (key-id ${result.keyId})\n`);
  } else {
    process.stdout.write(result.license);
  }
}

if (process.argv[1]?.endsWith("lease-sign.mjs")) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); });
}
