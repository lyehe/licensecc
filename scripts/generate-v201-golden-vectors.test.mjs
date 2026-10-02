import assert from "node:assert/strict";
import { createPublicKey, verify, constants } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  canonicalPayload,
  goldenFields,
  renderV201GoldenVectors,
  v201GoldenVectorDrift,
  VECTOR_DIRECTORY,
} from "./generate-v201-golden-vectors.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");

test("the committed v201 golden vectors match the generator output", () => {
  assert.deepEqual(v201GoldenVectorDrift(), []);
});

// A working copy may already carry CRLF line endings: with core.autocrlf, Git checks out the
// generator's payload copies (text=auto) as CRLF, while test/vectors keeps eol=lf.
const readLf = (path) => read(path).replace(/\r\n/gu, "\n");
// Normalizes to LF first, so converting text that is already CRLF leaves it unchanged.
const crlf = (text) => text.replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n");

test("a CRLF checkout of the vectors still matches", () => {
  assert.deepEqual(v201GoldenVectorDrift((path) => crlf(readLf(path))), []);
});

test("converting a checkout that is already CRLF still matches", () => {
  const crlfCheckout = (path) => crlf(readLf(path));
  assert.deepEqual(v201GoldenVectorDrift((path) => crlf(crlfCheckout(path))), []);
});

test("an edited vector is reported", () => {
  const edited = `${VECTOR_DIRECTORY}/full.license`;
  const drift = v201GoldenVectorDrift((path) => (path === edited ? read(path).replace("extra-data = alpha", "extra-data = beta") : read(path)));
  assert.deepEqual(drift, [edited]);
});

test("the golden key meets the runtime's 3072-bit floor and signs every golden payload", () => {
  const files = renderV201GoldenVectors();
  const der = Buffer.from(files.get(`${VECTOR_DIRECTORY}/public_key.pkcs1.der.hex`).trim(), "hex");
  const publicKey = createPublicKey({ key: der, format: "der", type: "pkcs1" });
  assert.ok(publicKey.asymmetricKeyDetails.modulusLength >= 3072);
  for (const name of ["minimal", "full"]) {
    const payload = Buffer.from(files.get(`${VECTOR_DIRECTORY}/${name}.payload.hex`).trim(), "hex");
    const signature = Buffer.from(files.get(`${VECTOR_DIRECTORY}/${name}.signature.b64`).trim(), "base64");
    assert.equal(signature.length, publicKey.asymmetricKeyDetails.modulusLength / 8);
    assert.ok(verify("sha256", payload, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature), name);
  }
});

test("the canonical payload frames each field in the canonical order", () => {
  const { minimal } = goldenFields("sha256:00");
  const reordered = Object.fromEntries(Object.entries(minimal).reverse());
  const text = canonicalPayload(reordered).toString("latin1");
  assert.ok(text.startsWith("licensecc:v201\nk00000007:lic_verv00000003:201\nk0000000b:canonical-vv00000001:1\n"));
  assert.ok(text.endsWith("k00000007:featurev0000000a:MY_PRODUCT\n"));
});
