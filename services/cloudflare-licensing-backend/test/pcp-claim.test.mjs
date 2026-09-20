import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUntrustedPcpP256Claim as parse } from '../src/device/pcp_claim.mjs';

const u16 = (value) => Buffer.from([value >> 8, value & 255]);
const u32 = (value) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
const sized = (bytes) => Buffer.concat([u16(bytes.length), bytes]);
const name = (value) => Buffer.concat([u16(11), Buffer.alloc(32, value)]);
const clock = Buffer.concat([Buffer.alloc(16, 255), Buffer.from([1])]);
const firmware = Buffer.from('fedcba9876543210', 'hex');
function fixture(policySize = 32) {
  // Deliberately unsigned synthetic evidence. Parsing is never trust admission.
  const cert = Buffer.concat([u32(0xff544347), u16(0x8017), sized(name(7)),
    sized(Buffer.alloc(32, 8)), clock, firmware, sized(name(9)), sized(name(10))]);
  const pub = Buffer.concat([u16(0x23), u16(11), u32(0x40472), sized(Buffer.alloc(policySize, 4)),
    u16(0x10), u16(0x10), u16(3), u16(0x10), sized(Buffer.alloc(32, 1)), sized(Buffer.alloc(32, 2))]);
  const header = Buffer.alloc(24);
  [0x4b415741, 1, 24, cert.length, 256, pub.length].forEach((value, index) => header.writeUInt32LE(value, index * 4));
  return Buffer.concat([header, cert, Buffer.alloc(256, 3), pub]);
}
const bad = (input) => assert.throws(() => parse(input), /^Error: invalid_pcp_claim$/);

test('PCP decoding returns independent untrusted fields for both bounded policy sizes', () => {
  for (const policy of [0, 32]) {
    const input = fixture(policy), result = parse(input);
    assert.equal(result.authPolicy.length, policy);
    assert.equal(result.nonce.length, 32);
    assert.equal(result.attributes, 0x40472);
    const expected = { certification: input.subarray(24, 197), signature: Buffer.alloc(256, 3),
      tpmPublic: input.subarray(453), qualifiedSigner: name(7), nonce: Buffer.alloc(32, 8),
      clockInfo: clock, firmwareVersion: firmware, objectName: name(9), qualifiedName: name(10),
      authPolicy: Buffer.alloc(policy, 4), x: Buffer.alloc(32, 1), y: Buffer.alloc(32, 2) };
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(Buffer.from(result[field]), value, field);
    }
    assert.equal('assurance' in result, false);
    assert.equal('verified' in result, false);
    input.fill(0);
    assert.equal(result.nonce[0], 8);
    assert.equal(result.x[0], 1);
  }
});

test('PCP decoding rejects every truncated prefix, trailing bytes and invalid input types', () => {
  const input = fixture();
  for (let size = 0; size < input.length; size++) bad(input.subarray(0, size));
  for (const value of [null, {}, [], 'claim', new ArrayBuffer(571), new Uint8Array(2049), Buffer.concat([input, Buffer.alloc(1)])]) bad(value);
});

test('PCP bounded copying ignores overridden iteration and length and rejects proxies', () => {
  const input = fixture();
  input[Symbol.iterator] = () => { throw new Error('iterator must not execute'); };
  Object.defineProperty(input, 'length', { get() { throw new Error('length must not execute'); } });
  assert.equal(parse(input).nonce.length, 32);
  bad(new Proxy(fixture(), {}));
  const oversized = new Uint8Array(2049);
  Object.defineProperty(oversized, 'length', { value: 571 });
  bad(oversized);
  const padded = Buffer.concat([Buffer.alloc(7), fixture(), Buffer.alloc(9)]);
  assert.equal(parse(padded.subarray(7, -9)).nonce.length, 32);
});

test('PCP decoding rejects unknown header, TPM profile, Names, lengths and attributes', () => {
  const original = fixture(), pub = 24 + 173 + 256;
  for (const offset of [0, 4, 8, 12, 16, 20]) {
    const input = Buffer.from(original); input.writeUInt32LE(0xffffffff, offset); bad(input);
  }
  // Magic/type, signer Name algorithm, nonce size, safe flag, subject Name,
  // qualified Name; public type/hash, policy, symmetric/scheme/curve/KDF, x/y.
  for (const [offset, value] of [[24, 0], [29, 0], [33, 4], [67, 31], [116, 2],
    [128, 4], [164, 4], [pub + 1, 1], [pub + 3, 4], [pub + 9, 31],
    [pub + 43, 0], [pub + 45, 0], [pub + 47, 4], [pub + 49, 0],
    [pub + 51, 31], [pub + 85, 31]]) {
    const input = Buffer.from(original); input[offset] = value; bad(input);
  }
  for (const attrs of [0, 0x40470, 0x40462, 0x40452, 0x472, 0x50472, 0x60472, 0x8040472]) {
    const input = Buffer.from(original); input.writeUInt32BE(attrs, pub + 4); bad(input);
  }
});
