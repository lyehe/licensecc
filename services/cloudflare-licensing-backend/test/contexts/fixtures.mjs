import assert from "node:assert/strict";

export function derPayloadOffset(bytes, offset) {
  assert.equal(bytes[offset], 0x30);
  ++offset;
  const lengthByte = bytes[offset++];
  if ((lengthByte & 0x80) === 0) {
    return offset;
  }
  const lengthBytes = lengthByte & 0x7f;
  assert.ok(lengthBytes > 0 && lengthBytes <= 4);
  return offset + lengthBytes;
}
