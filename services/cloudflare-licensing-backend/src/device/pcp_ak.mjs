import { decodeBase64url } from '@licensecc/licensing-domain/lease/device_protocol';

/** Decode a claimed restricted RSA-2048/SHA-256 TPMT_PUBLIC. These attributes
 * are unauthenticated until EK activation/certificate trust binds its exact Name.
 * Canonical base64url carries the public area WITHOUT a TPM2B length wrapper.
 */
export function parseUntrustedPcpAk(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 416) throw new Error('invalid_pcp_ak');
  const bytes = decodeBase64url(encoded, 312);
  if (bytes.length !== 280 && bytes.length !== 312) throw new Error('invalid_pcp_ak');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const attributes = view.getUint32(4), policyLength = view.getUint16(8);
  // fixedTPM, fixedParent, sensitiveDataOrigin, restricted, sign; never decrypt.
  // 0x000f0cf6 is this profile's allowlist, not all currently defined TPM bits.
  if (view.getUint16(0) !== 1 || view.getUint16(2) !== 11 ||
      (attributes & 0x50032) !== 0x50032 || (attributes & 0x20000) !== 0 ||
      (attributes & ~0x000f0cf6) !== 0 ||
      (policyLength !== 0 && policyLength !== 32) || bytes.length !== 280 + policyLength) throw new Error('invalid_pcp_ak');
  const parameters = 10 + policyLength;
  if (view.getUint16(parameters) !== 16 || view.getUint16(parameters + 2) !== 20 ||
      view.getUint16(parameters + 4) !== 11 || view.getUint16(parameters + 6) !== 2048 ||
      ![0, 65537].includes(view.getUint32(parameters + 8)) ||
      view.getUint16(parameters + 12) !== 256) throw new Error('invalid_pcp_ak');
  const modulus = bytes.slice(parameters + 14);
  if (modulus.length !== 256 || (modulus[0] & 0x80) === 0 || (modulus[255] & 1) === 0) throw new Error('invalid_pcp_ak');
  return { bytes, modulus };
}
