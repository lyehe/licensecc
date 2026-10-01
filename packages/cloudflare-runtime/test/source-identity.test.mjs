import test from "node:test";
import assert from "node:assert/strict";
import { sourceIdentity } from "../src/http/source_identity.mjs";

test("source identity collapses IPv6 to its /64 and leaves IPv4 and malformed input raw", () => {
  for (const [raw, expected] of [
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:ffff:0:0:9", "2001:db8:1:2::/64"],
    ["[2001:db8:1:2::5]", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4::/64"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::ffff:c000:201", "192.0.2.1"],
    ["192.0.2.1", "192.0.2.1"],
    [" 192.0.2.1 ", "192.0.2.1"],
    ["unknown-client", "unknown-client"],
    ["", ""],
    [null, ""],
    [undefined, ""],
    ["garbage", "garbage"],
    ["1::2::3", "1::2::3"],
    ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
    ["12345::", "12345::"],
    ["192.0.2.256", "192.0.2.256"],
  ]) assert.equal(sourceIdentity(raw), expected, String(raw));
});

test("two addresses in one /64 share an identity; neighbouring /64s and IPv4 addresses do not", () => {
  assert.equal(sourceIdentity("2001:db8:1:2::1"), sourceIdentity("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(sourceIdentity("2001:db8:1:2::1"), sourceIdentity("2001:db8:1:3::1"));
  assert.notEqual(sourceIdentity("192.0.2.1"), sourceIdentity("192.0.2.2"));
});
