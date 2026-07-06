// Unit tests for the off-Cloudflare host security helpers.
// Pure — no server/DB:  node --test host-common.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIpFromRequest, assertSafeBind, isLoopback, CLIENT_IP_HEADERS } from "./host-common.mjs";

const mkReq = (headers, remoteAddress) => ({ headers, socket: { remoteAddress } });

test("clientIpFromRequest defaults to the socket peer and IGNORES spoofed headers", () => {
  const req = mkReq({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "8.8.8.8" }, "1.2.3.4");
  assert.equal(clientIpFromRequest(req, {}), "1.2.3.4");
});

test("clientIpFromRequest normalizes IPv4-mapped IPv6", () => {
  assert.equal(clientIpFromRequest(mkReq({}, "::ffff:5.6.7.8"), {}), "5.6.7.8");
});

test("clientIpFromRequest uses the rightmost trusted-proxy hop when configured", () => {
  // a trusted proxy that appends the real client as the last XFF entry
  const req = mkReq({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }, "10.0.0.1");
  assert.equal(clientIpFromRequest(req, { TRUST_PROXY_HEADER: "x-forwarded-for" }), "1.2.3.4");
});

test("clientIpFromRequest with a single-value trusted header (x-real-ip)", () => {
  const req = mkReq({ "x-real-ip": "203.0.113.7" }, "10.0.0.1");
  assert.equal(clientIpFromRequest(req, { TRUST_PROXY_HEADER: "x-real-ip" }), "203.0.113.7");
});

test("isLoopback: 127.0.0.1/::1/localhost yes; 0.0.0.0 and public no", () => {
  assert.ok(isLoopback("127.0.0.1") && isLoopback("::1") && isLoopback("localhost"));
  assert.ok(!isLoopback("0.0.0.0")); // 0.0.0.0 binds all interfaces — NOT loopback
  assert.ok(!isLoopback("10.0.0.5"));
});

test("assertSafeBind: loopback is always allowed", () => {
  assert.doesNotThrow(() => assertSafeBind("127.0.0.1", {}));
});

test("assertSafeBind: non-loopback WITHOUT rate limiting is refused", () => {
  assert.throws(() => assertSafeBind("0.0.0.0", {}), /Refusing to bind/);
  assert.throws(() => assertSafeBind("10.0.0.5", { D1_RATE_LIMIT_ENABLED: "0" }), /Refusing to bind/);
});

test("assertSafeBind: non-loopback WITH D1 rate limiting is allowed", () => {
  assert.doesNotThrow(() => assertSafeBind("0.0.0.0", { D1_RATE_LIMIT_ENABLED: "1" }));
});

test("CLIENT_IP_HEADERS covers the spoofable IP headers the host strips", () => {
  for (const h of ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"]) {
    assert.ok(CLIENT_IP_HEADERS.includes(h), h);
  }
});
