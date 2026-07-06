import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";

function usage() {
  console.error("usage: node scripts/generate-online-key.mjs [--out-dir] <directory>");
  process.exit(2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const outDirArg = argValue("--out-dir") ?? process.argv[2];
if (!outDirArg) {
  usage();
}

const outDir = resolve(outDirArg);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicExponent: 0x10001,
});

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicDer = publicKey.export({ type: "pkcs1", format: "der" });
const publicBytes = Array.from(publicDer);
const publicKeyId = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
const publicKeyMacro =
  `license::os::SignaturePublicKey("${publicKeyId}", ` +
  `std::vector<uint8_t>{${publicBytes.join(",")}}, 3072)`;
const publicKeyMacroForCMake = publicKeyMacro.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/online_private_key.pkcs8.pem`, privatePem, { mode: 0o600 });
writeFileSync(
  `${outDir}/online_public_key_record.cmake.txt`,
  `set(LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS "${publicKeyMacroForCMake}" CACHE STRING "Online assertion public key records")\n`,
);
writeFileSync(
  `${outDir}/online_public_key.json`,
  JSON.stringify(
    {
      key_id: publicKeyId,
      algorithm: "rsa-pkcs1-sha256",
      bits: 3072,
      public_key_der_base64: publicDer.toString("base64"),
      cmake_definition: `-DLCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS=${publicKeyMacro}`,
    },
    null,
    2,
  ) + "\n",
);

console.log(`wrote online key material to ${outDir}`);
console.log(`key id: ${publicKeyId}`);
console.log("store online_private_key.pkcs8.pem as ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM");
