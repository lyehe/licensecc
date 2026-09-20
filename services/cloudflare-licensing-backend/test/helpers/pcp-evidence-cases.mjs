import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign, constants } from 'node:crypto';

const u16 = value => Buffer.from([value >> 8, value & 255]);
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const sized = bytes => Buffer.concat([u16(bytes.length), bytes]);
const named = bytes => Buffer.concat([u16(11), createHash('sha256').update(bytes).digest()]);
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function fixture({ hash = 'sha256', padding = constants.RSA_PKCS1_PADDING, ak = rsa, policyLength = 32, exponent = 0, changePublic, changeCert } = {}) {
  const jwk = ec.publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([u16(0x23), u16(11), u32(0x40472), sized(Buffer.alloc(32)),
    u16(16), u16(16), u16(3), u16(16), sized(Buffer.from(jwk.x, 'base64url')), sized(Buffer.from(jwk.y, 'base64url'))]);
  if (changePublic) changePublic(pub);
  const nonce = Buffer.alloc(32, 5), signer = named(Buffer.from('AK ancestry')), subject = named(Buffer.from('subject ancestry'));
  const cert = Buffer.concat([u32(0xff544347), u16(0x8017), sized(signer), sized(nonce),
    Buffer.alloc(25), sized(named(pub)), sized(subject)]);
  if (changeCert) changeCert(cert);
  const signature = sign(hash, cert, { key: ak.privateKey, padding });
  const header = Buffer.alloc(24);
  [0x4b415741, 1, 24, cert.length, signature.length, pub.length].forEach((v, i) => header.writeUInt32LE(v, i * 4));
  const akJwk = ak.publicKey.export({ format: 'jwk' });
  const akPublic = Buffer.concat([u16(1), u16(11), u32(0x50072), sized(Buffer.alloc(policyLength)),
    u16(16), u16(20), u16(11), u16(2048), u32(exponent), sized(Buffer.from(akJwk.n, 'base64url'))]);
  return { claim: Buffer.concat([header, cert, signature, pub]), expected: {
    nonce: b64(nonce), subjectSpki: b64(ec.publicKey.export({ format: 'der', type: 'spki' })),
    akSpki: b64(ak.publicKey.export({ format: 'der', type: 'spki' })),
    akTpmPublic: b64(akPublic),
    qualifiedSigner: b64(signer), qualifiedSubject: b64(subject) } };
}

export function registerPcpEvidenceCases(test, { check, parseAk, checkAndMutate }) {
test('consistent software evidence passes cryptographic checks but NEVER establishes hardware trust', async () => {
  const { claim, expected } = fixture(), result = await check(claim, expected);
  assert.equal(result.kind, 'pcp_evidence_consistency');
  assert.equal(result.hardwareTrusted, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.nonce, expected.nonce);
  assert.equal(result.subjectKeyId, `sha256:${createHash('sha256').update(Buffer.from(expected.subjectSpki, 'base64url')).digest('hex')}`);
  assert.equal(result.akKeyId, `sha256:${createHash('sha256').update(Buffer.from(expected.akSpki, 'base64url')).digest('hex')}`);
  assert.equal(result.subjectName, b64(named(claim.subarray(453))));
  assert.equal(result.akName, b64(named(Buffer.from(expected.akTpmPublic, 'base64url'))));
});

test('AK Name binds exact restricted public area, including policy and exponent encoding', async () => {
  const names = new Set();
  for (const policyLength of [0, 32]) for (const exponent of [0, 65537]) {
    const { claim, expected } = fixture({ policyLength, exponent });
    const result = await check(claim, expected);
    assert.equal(result.hardwareTrusted, false);
    assert.equal(result.akName, b64(named(Buffer.from(expected.akTpmPublic, 'base64url'))));
    names.add(result.akName);
  }
  assert.equal(names.size, 4, 'Name hashes exact encoding, even for equivalent RSA exponents');
});

test('rejects AK substitution, unrestrained attributes, malformed profile and all truncations', async () => {
  const { claim, expected } = fixture(), area = Buffer.from(expected.akTpmPublic, 'base64url');
  const rejected = async bytes => assert.equal(await check(claim, { ...expected, akTpmPublic: b64(bytes) }), null);
  for (let end = 0; end < area.length; end++) await rejected(area.subarray(0, end));
  await rejected(Buffer.concat([area, Buffer.from([0])]));
  for (const attr of [0x40072, 0x50070, 0x50062, 0x50052, 0x10072, 0x70072, 0x850072]) {
    const changed = Buffer.from(area); changed.writeUInt32BE(attr, 4); await rejected(changed);
  }
  for (const offset of [1, 3, 9, 43, 45, 47, 49, 53, 55, 56, 150, 311]) {
    const changed = Buffer.from(area); changed[offset] ^= 1; await rejected(changed);
  }
  const other = fixture({ ak: generateKeyPairSync('rsa', { modulusLength: 2048 }) });
  await rejected(Buffer.from(other.expected.akTpmPublic, 'base64url'));
});

test('AK parser independently rejects short-width and even moduli in both policy branches', async () => {
  for (const policyLength of [0, 32]) {
    const { expected } = fixture({ policyLength });
    const original = Buffer.from(expected.akTpmPublic, 'base64url');
    assert.equal((await parseAk(b64(original))).modulus.length, 256);
    const shortWidth = Buffer.from(original); shortWidth[24 + policyLength] &= 0x7f;
    const even = Buffer.from(original); even[even.length - 1] &= 0xfe;
    for (const bytes of [shortWidth, even]) await assert.rejects(() => parseAk(b64(bytes)), /invalid_pcp_ak/);
  }
});

test('nonce, both qualified Names, subject key and AK are bound to caller expectations', async () => {
  const { claim, expected } = fixture();
  for (const field of ['nonce', 'qualifiedSigner', 'qualifiedSubject']) {
    const changed = Buffer.from(expected[field], 'base64url'); changed[changed.length - 1] ^= 1;
    assert.equal(await check(claim, { ...expected, [field]: b64(changed) }), null, field);
  }
  for (const field of ['subjectSpki', 'akSpki']) {
    const other = field === 'subjectSpki' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.equal(await check(claim, { ...expected, [field]: b64(other.publicKey.export({ format: 'der', type: 'spki' })) }), null, field);
  }
});

test('rejects signature tampering, SHA1, PSS, signed wrong Name and signed mismatched point', async () => {
  for (const options of [{ hash: 'sha1' }, { padding: constants.RSA_PKCS1_PSS_PADDING },
    { changeCert: cert => { cert[130] ^= 1; } }, { changePublic: pub => { pub[60] ^= 1; } }]) {
    const { claim, expected } = fixture(options);
    assert.equal(await check(claim, expected), null);
  }
  const { claim, expected } = fixture();
  for (const position of [80, 197, 452, 510]) {
    const changed = Buffer.from(claim); changed[position] ^= 1;
    assert.equal(await check(changed, expected), null);
  }
});

test('rejects missing, malformed, oversized and noncanonical expectations without throwing', async () => {
  const { claim, expected } = fixture();
  for (const value of [null, undefined, {}, []]) assert.equal(await check(claim, value), null);
  for (const field of Object.keys(expected)) {
    for (const value of ['', null, 'A'.repeat(1024), expected[field] + '=']) {
      assert.equal(await check(claim, { ...expected, [field]: value }), null, field);
    }
    const missing = { ...expected }; delete missing[field];
    assert.equal(await check(claim, missing), null);
  }
});

test('snapshots claim and expected identity before asynchronous verification', async () => {
  const { claim, expected } = fixture(), originalNonce = expected.nonce;
  const result = await checkAndMutate(claim, expected);
  assert.equal(result.hardwareTrusted, false);
  assert.equal(result.nonce, originalNonce);
});

test('rejects correctly signed nonprofile RSA keys and malformed/noncanonical SPKI encodings', async () => {
  for (const options of [{ modulusLength: 2048, publicExponent: 3 }, { modulusLength: 1024 }, { modulusLength: 3072 }]) {
    const { claim, expected } = fixture({ ak: generateKeyPairSync('rsa', options) });
    assert.equal(await check(claim, expected), null);
  }
  const { claim, expected } = fixture();
  for (const field of ['akSpki', 'subjectSpki']) {
    const der = Buffer.from(expected[field], 'base64url');
    const badTag = Buffer.from(der); badTag[0] = 0x31;
    for (const bytes of [der.subarray(0, -1), Buffer.concat([der, Buffer.from([0])]), badTag]) {
      assert.equal(await check(claim, { ...expected, [field]: b64(bytes) }), null);
    }
  }
  // Invalid point is reflected in both signed public area and expected SPKI.
  // Signature/Name agreement cannot replace curve validation at key import.
  const invalid = fixture({ changePublic: pub => pub.fill(0, 52, 84) });
  const spki = Buffer.from(invalid.expected.subjectSpki, 'base64url');
  spki.fill(0, spki.length - 64, spki.length - 32);
  assert.equal(await check(invalid.claim, { ...invalid.expected, subjectSpki: b64(spki) }), null);
});

}
