import { decodeBase64url, encodeBase64url } from '@licensecc/licensing-domain/lease/device_protocol';
import { parseUntrustedPcpP256Claim } from './pcp_claim.mjs';
import { parseUntrustedPcpAk } from './pcp_ak.mjs';
import { importBoundDeviceKey, sha256Hex } from './bound_crypto.mjs';

const equal = (left, right) => left.length === right.length && left.every((byte, i) => byte === right[i]);
function exactBytes(value, length) {
  // Bound text before calling the shared decoder, including its regex scan.
  if (typeof value !== 'string' || value.length > Math.ceil(length * 4 / 3)) throw new Error('invalid_evidence');
  const bytes = decodeBase64url(value, length);
  if (bytes.length !== length) throw new Error('invalid_evidence');
  return bytes;
}

/** Verify cryptographic consistency ONLY, never hardware origin or authorization.
 * expected values must be supplied by the future challenge/trust owner, not
 * copied from request evidence. This helper does not enforce expiry or consume
 * challenges, authenticate claimed AK attributes/certificates, or establish Name ancestry.
 * Software-generated evidence can pass; hardwareTrusted is always false.
 */
export async function checkPcpEvidenceConsistency(claim, expected) {
  try {
    // Capture inputs before the first await so later mutation of expected cannot
    // change the identity checked or the evidence returned to the caller.
    const { nonce: encodedNonce, subjectSpki, akSpki, akTpmPublic, qualifiedSigner: signer,
      qualifiedSubject: subject } = expected;
    const nonce = exactBytes(encodedNonce, 32);
    const qualifiedSigner = exactBytes(signer, 34);
    const qualifiedSubject = exactBytes(subject, 34);
    if (typeof subjectSpki !== 'string' || subjectSpki.length > 512 ||
        typeof akSpki !== 'string' || akSpki.length > 512) return null;
    const parsed = parseUntrustedPcpP256Claim(claim);
    const akPublic = parseUntrustedPcpAk(akTpmPublic);
    if (!equal(parsed.nonce, nonce) || !equal(parsed.qualifiedSigner, qualifiedSigner) ||
        !equal(parsed.qualifiedName, qualifiedSubject)) return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', parsed.tpmPublic));
    if (!equal(parsed.objectName.slice(2), digest)) return null;
    const { key: deviceKey, keyId: subjectKeyId } = await importBoundDeviceKey(subjectSpki);
    const point = new Uint8Array(await crypto.subtle.exportKey('raw', deviceKey));
    if (point.length !== 65 || point[0] !== 4 || !equal(parsed.x, point.slice(1, 33)) ||
        !equal(parsed.y, point.slice(33))) return null;
    const akBytes = decodeBase64url(akSpki, 384);
    const ak = await crypto.subtle.importKey('spki', akBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']);
    const profile = /** @type {{name: string, modulusLength: number, hash: {name: string}, publicExponent: Uint8Array}} */ (ak.algorithm);
    if (ak.type !== 'public' || profile.name !== 'RSASSA-PKCS1-v1_5' ||
        profile.modulusLength !== 2048 || profile.hash.name !== 'SHA-256' ||
        !equal(profile.publicExponent, new Uint8Array([1, 0, 1]))) return null;
    const canonicalAk = new Uint8Array(await crypto.subtle.exportKey('spki', ak));
    const akJwk = await crypto.subtle.exportKey('jwk', ak);
    if (akJwk.n !== encodeBase64url(akPublic.modulus) || akJwk.e !== 'AQAB') return null;
    if (encodeBase64url(canonicalAk) !== akSpki ||
        !await crypto.subtle.verify('RSASSA-PKCS1-v1_5', ak, parsed.signature, parsed.certification)) return null;
    // Return only immutable summaries. No raw device-wide evidence is exposed.
    const akName = new Uint8Array(34);
    akName.set([0, 11]); akName.set(new Uint8Array(await crypto.subtle.digest('SHA-256', akPublic.bytes)), 2);
    return Object.freeze({ kind: 'pcp_evidence_consistency', hardwareTrusted: false, akName: encodeBase64url(akName),
      subjectKeyId, akKeyId: `sha256:${await sha256Hex(canonicalAk)}`,
      subjectName: encodeBase64url(parsed.objectName), nonce: encodedNonce });
  } catch { return null; }
}
