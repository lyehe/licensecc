import { generateKeyPairSync, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const signer = resolve(here, "../../../services/cloudflare-online-verifier/scripts/config-sign.mjs");

const { publicKey: pkcs1Der, privateKey: pkcs8Pem } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "pkcs1", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keyId = "sha256:" + createHash("sha256").update(pkcs1Der).digest("hex");

const config = Buffer.from('{"feature":"export","limit":5}');  // exact bytes, no trailing newline
writeFileSync(resolve(here, "golden.config"), config);
const pemPath = resolve(here, "_gen_golden_key.pkcs8.pem");
writeFileSync(pemPath, pkcs8Pem);

const token = execFileSync("node", [
  signer,
  "--private-key", pemPath,
  "--key-id", keyId,
  "--fingerprint", "a".repeat(64),
  "--config", resolve(here, "golden.config"),
  "--config-id", "app-config",
  "--config-seq", "9",
  "--project", "DEFAULT",
  "--feature", "EXPORT",
  "--issued-at", "1000",
  "--expires-at", "2000",
], { encoding: "utf8" }).trim();

writeFileSync(resolve(here, "golden.token"), token + "\n");
writeFileSync(resolve(here, "golden.key_id"), keyId + "\n");
writeFileSync(resolve(here, "golden.public_key.pkcs1.der.hex"), Buffer.from(pkcs1Der).toString("hex") + "\n");
rmSync(pemPath, { force: true });
console.log("wrote golden.config, golden.token, golden.key_id, golden.public_key.pkcs1.der.hex");
