import test from "node:test";
import assert from "node:assert/strict";
import { parseUnsignedJson } from "../src/http/unsigned_json.mjs";

const parse = source => parseUnsignedJson(new TextEncoder().encode(source));

test("unsigned JSON handles escape-heavy strings without confusing keys or structure", () => {
  const text = '\\"'.repeat(3000);
  const value = { text, nested: [{ text: "{}[],:-1e0", enabled: true, empty: null }] };
  assert.deepEqual(parse(JSON.stringify(value)), value);
  const key = JSON.stringify(text);
  assert.deepEqual(parse(`{${key} \r\n\t : 1}`), { [text]: 1 });
  assert.throws(() => parse(`{${key}:1,${key}:2}`), /invalid_request/);
  assert.throws(() => parse(`{"text":${key.slice(0, -1)}}`), /invalid_request/);
});

test("unsigned JSON preserves decoded-key, Unicode, depth and integer validation", () => {
  for (const source of [
    '{"a":1,"\\u0061":2}', '{"nested":[{"x":1,"x":2}]}',
    '{"x":"\\ud800"}', '{"x":-0}', '{"x":1e0}', '{"x":1.0000000000000001}',
    '{"x":9007199254740992}', '{"x":' + '['.repeat(8) + '0' + ']'.repeat(8) + '}',
  ]) assert.throws(() => parse(source), /invalid_request/);
  assert.deepEqual(parse('{"a":{"x":0},"b":{"x":9007199254740991},"text":"🚀"}'),
    { a: { x: 0 }, b: { x: Number.MAX_SAFE_INTEGER }, text: "🚀" });
});
