import { generateKeyPairSync, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const signer = resolve(here, "../../../services/cloudflare-licensing-backend/scripts/config-sign.mjs");

const { publicKey: pkcs1Der, privateKey: pkcs8Pem } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "pkcs1", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keyId = "sha256:" + createHash("sha256").update(pkcs1Der).digest("hex");

const config = Buffer.from('{"feature":"export","limit":7}');
writeFileSync(resolve(here, "embedded_golden.config"), config);
const pemPath = resolve(here, "_gen_embedded_golden_key.pkcs8.pem");
writeFileSync(pemPath, pkcs8Pem);

const token = execFileSync("node", [
  signer,
  "--private-key", pemPath,
  "--key-id", keyId,
  "--fingerprint", "a".repeat(64),
  "--config", resolve(here, "embedded_golden.config"),
  "--config-id", "app-config",
  "--config-seq", "9",
  "--project", "DEFAULT",
  "--feature", "EXPORT",
  "--issued-at", "1000",
  "--expires-at", "2000",
], { encoding: "utf8" }).trim();

const publicBytes = Array.from(pkcs1Der);
const macro =
  `license::os::SignaturePublicKey("${keyId}", ` +
  `std::vector<uint8_t>{${publicBytes.join(",")}}, 3072)`;
const macroForCMake = macro.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

writeFileSync(resolve(here, "embedded_golden.token"), token + "\n");
writeFileSync(resolve(here, "embedded_golden.key_id"), keyId + "\n");
writeFileSync(
  resolve(here, "embedded_golden_public_key_record.cmake.txt"),
  `set(LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS "${macroForCMake}" CACHE STRING "Config attestation public key records")\n`,
);
rmSync(pemPath, { force: true });
console.log("wrote embedded_golden.config, .token, .key_id, _public_key_record.cmake.txt");
