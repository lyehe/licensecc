// Structural decoding only. Every returned field remains UNTRUSTED: this module
// does not verify signatures, Names, freshness, certificates or TPM provenance.
// No enrollment/issuance route may derive hardware assurance from this result.
/** @returns {never} */
function invalid() { throw new Error('invalid_pcp_claim'); }
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get ?? invalid();
const copyBytes = Uint8Array.prototype.set;

class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  take(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) invalid();
    const result = this.bytes.slice(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  integer(size) {
    return this.take(size).reduce((value, byte) => value * 256 + byte, 0);
  }
  sized(min, max) {
    const size = this.integer(2);
    if (size < min || size > max) invalid();
    return this.take(size);
  }
  name() {
    const name = this.sized(34, 34);
    if (name[0] !== 0 || name[1] !== 0x0b) invalid();
    return name;
  }
  end() { if (this.offset !== this.bytes.length) invalid(); }
}

/** Decode the bounded Windows KAWA-v1 RSA-2048 / SHA-256-Name P-256 shape.
 * The raw signature has no algorithm tag; its algorithm must come from a
 * separately validated AK profile. A successful parse establishes no trust.
 */
export function parseUntrustedPcpP256Claim(input) {
  if (!(input instanceof Uint8Array)) invalid();
  let bytes;
  try {
    const size = byteLength.call(input);
    if (size < 24 || size > 2048) invalid();
    bytes = new Uint8Array(size);
    // Intrinsic typed-array copying bypasses overridden length/iterator methods.
    // A concurrent resize can fail, but cannot grow the bounded destination.
    copyBytes.call(bytes, input);
  } catch { invalid(); }
  const header = new DataView(bytes.buffer);
  const word = (offset) => header.getUint32(offset, true);
  const certifySize = word(12), signatureSize = word(16), publicSize = word(20);
  if (word(0) !== 0x4b415741 || word(4) !== 1 || word(8) !== 24 ||
      certifySize !== 173 || signatureSize !== 256 ||
      (publicSize !== 86 && publicSize !== 118) ||
      24 + certifySize + signatureSize + publicSize !== bytes.length) invalid();
  const certification = bytes.slice(24, 24 + certifySize);
  const signature = bytes.slice(24 + certifySize, 24 + certifySize + signatureSize);
  const tpmPublic = bytes.slice(24 + certifySize + signatureSize);
  const certify = new Reader(certification);
  if (certify.integer(4) !== 0xff544347 || certify.integer(2) !== 0x8017) invalid();
  const qualifiedSigner = certify.name();
  const nonce = certify.sized(32, 32);
  // Preserve raw clock/firmware bytes; never convert uint64 into lossy JS numbers
  // or expose this information as a trustworthy wall-clock or hardware identity.
  const clockInfo = certify.take(17);
  if (clockInfo[16] !== 0 && clockInfo[16] !== 1) invalid();
  const firmwareVersion = certify.take(8);
  const objectName = certify.name(), qualifiedName = certify.name();
  certify.end();
  const publicReader = new Reader(tpmPublic);
  if (publicReader.integer(2) !== 0x23 || publicReader.integer(2) !== 0x0b) invalid();
  const attributes = publicReader.integer(4);
  // Required fixedTPM/fixedParent/sensitiveDataOrigin/sign; no restricted or
  // decrypt subject. Other recognized attributes remain untrusted policy input.
  if ((attributes & 0x40032) !== 0x40032 || (attributes & 0x30000) !== 0 ||
      (attributes & ~0x000f0cf6) !== 0) invalid();
  const authPolicy = publicReader.sized(0, 32);
  if (authPolicy.length !== 0 && authPolicy.length !== 32) invalid();
  if (publicReader.integer(2) !== 0x10 || publicReader.integer(2) !== 0x10 ||
      publicReader.integer(2) !== 3 || publicReader.integer(2) !== 0x10) invalid();
  const x = publicReader.sized(32, 32), y = publicReader.sized(32, 32);
  publicReader.end();
  return { certification, signature, tpmPublic, qualifiedSigner, nonce, clockInfo,
    firmwareVersion, objectName, qualifiedName, attributes, authPolicy, x, y };
}
