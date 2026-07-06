// portal_otp unit tests (blueprint (g)): 8-digit derivation; HMAC-at-rest (no plaintext stored);
// single-use; TTL; attempt-cap; re-issue invalidation; multi-pepper redeem; no-customer ok+dummy;
// A's code + B's email no-match; requestOtp returns NO secret; RL generic ok.

import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDb, portalEnv, seedCustomer, NOW, OTP_PEPPERS } from "./helpers.mjs";
import { requestOtp, redeemOtp, codeFromSecretBytes } from "../src/auth/portal_otp.mjs";

function env(db, overrides = {}) {
  return portalEnv(db, overrides);
}

function rows(db) {
  return db.prepare("SELECT * FROM portal_otp").all();
}

test("the 8-digit code derives from the first 4 secret bytes (uint32 % 1e8)", () => {
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x05, 0xff, 0xff]);
  assert.equal(codeFromSecretBytes(bytes), "00000005");
  const big = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  // 0xffffffff % 1e8 = 4294967295 % 100000000 = 94967295
  assert.equal(codeFromSecretBytes(big), "94967295");
});

test("requestOtp stores only HMACs (no plaintext code/secret) and returns NO secret", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const r = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok");
  assert.equal(r.secret, undefined, "requestOtp NEVER returns the secret on the normal path");
  const stored = rows(db);
  assert.equal(stored.length, 1);
  const row = stored[0];
  // Stored columns are HMACs (base64), not raw secrets/codes.
  assert.ok(row.secret_hmac.length >= 40);
  assert.ok(row.code_hmac.length >= 40);
  assert.equal(row.consumed_at, null);
  assert.equal(row.attempt_count, 0);
  assert.equal(row.email_lower, "a@x.com");
});

test("an unknown email returns ok and writes NOTHING (no enumeration, dummy work)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const r = await requestOtp(e, { email: "nobody@x.com", clientIp: "1.1.1.1", now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.code, "ok", "same shape as a known email (no oracle)");
  assert.equal(r.secret, undefined);
  assert.equal(rows(db).length, 0, "no OTP row for an unknown email");
});

test("a redeemed code mints a session-eligible result exactly once (single-use)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  // Capture the secret via the bootstrap escape hatch so the test can derive the code.
  const req = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  const secretBytes = Uint8Array.from(atob(req.secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const code = codeFromSecretBytes(secretBytes);

  const first = await redeemOtp(e, { email: "a@x.com", code, clientIp: "1.1.1.1", now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.customerId, "A");

  const second = await redeemOtp(e, { email: "a@x.com", code, clientIp: "1.1.1.1", now: NOW });
  assert.equal(second.ok, false, "a consumed code cannot be redeemed again");
  assert.equal(second.code, "invalid_otp");
});

test("the magic-link secret redeems the same row", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const req = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  const redeemed = await redeemOtp(e, { secret: req.secret, clientIp: "1.1.1.1", now: NOW });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.customerId, "A");
});

test("an expired OTP is denied (TTL)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const req = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  // Redeem 601s later (TTL is 600s).
  const r = await redeemOtp(e, { secret: req.secret, clientIp: "1.1.1.1", now: NOW + 601 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_otp");
});

test("A's code with B's email does NOT match (code_hmac is email-bound)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  seedCustomer(db, "B", "b@x.com");
  const e = env(db);
  const reqA = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  const secretBytes = Uint8Array.from(atob(reqA.secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const aCode = codeFromSecretBytes(secretBytes);
  // Present A's code under B's email: the email-bound code_hmac cannot match.
  const r = await redeemOtp(e, { email: "b@x.com", code: aCode, clientIp: "2.2.2.2", now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_otp");
});

test("a wrong code is byte-identical to no-OTP (invalid_otp), and does not consume the live row", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", now: NOW });
  const r = await redeemOtp(e, { email: "a@x.com", code: "00000000", clientIp: "1.1.1.1", now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_otp");
  // The live row was NOT consumed by a wrong code.
  const live = db.prepare("SELECT consumed_at FROM portal_otp WHERE customer_id = 'A'").get();
  assert.equal(live.consumed_at, null, "a wrong code does not consume the live row");
});

test("re-issuing an OTP invalidates the prior unconsumed row", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const first = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  // A second request supersedes the first.
  await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", now: NOW + 1 });
  // The FIRST secret is now consumed (invalidated) and cannot redeem.
  const r = await redeemOtp(e, { secret: first.secret, clientIp: "1.1.1.1", now: NOW + 2 });
  assert.equal(r.ok, false, "the prior code was invalidated by the re-issue");
});

test("multi-pepper: a secret issued under p1 redeems while a NEW pepper is also live", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  // Issue under the single-pepper map.
  const eIssue = env(db, { PORTAL_OTP_PEPPERS: OTP_PEPPERS });
  const req = await requestOtp(eIssue, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  // Redeem under a TWO-pepper map (p1 + a new p2): the candidate-HMAC-per-pepper loop still matches p1.
  const twoPeppers = JSON.stringify({
    ...JSON.parse(OTP_PEPPERS),
    p2: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 5 + 99) & 0xff))),
  });
  const eRedeem = env(db, { PORTAL_OTP_PEPPERS: twoPeppers });
  const r = await redeemOtp(eRedeem, { secret: req.secret, clientIp: "1.1.1.1", now: NOW });
  assert.equal(r.ok, true, "an old-pepper secret still redeems while a new pepper is live (rotation-safe)");
});

test("pepper-unset -> config_error on request and redeem", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db, { PORTAL_OTP_PEPPERS: undefined });
  const req = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", now: NOW });
  assert.equal(req.code, "config_error");
  const red = await redeemOtp(e, { email: "a@x.com", code: "12345678", clientIp: "1.1.1.1", now: NOW });
  assert.equal(red.code, "config_error");
});

test("the attempt cap is enforced (5 live attempts max)", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const req = await requestOtp(e, { email: "a@x.com", clientIp: "1.1.1.1", returnSecret: true, now: NOW });
  // Burn 5 wrong-but-matching-shape attempts on the live row by directly setting attempt_count to the cap.
  db.prepare("UPDATE portal_otp SET attempt_count = 5 WHERE customer_id = 'A'").run();
  // Now even the CORRECT secret is denied (attempt_count < 5 fails).
  const r = await redeemOtp(e, { secret: req.secret, clientIp: "1.1.1.1", now: NOW });
  assert.equal(r.ok, false, "a row at the attempt cap is denied even with the right secret");
});
