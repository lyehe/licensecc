// portal_otp unit tests (blueprint (g)): 8-digit derivation; HMAC-at-rest (no plaintext stored);
// single-use; TTL; attempt-cap; re-issue invalidation; multi-pepper redeem; no-customer ok+dummy;
// A's code + B's email no-match; requestOtp returns NO secret; RL generic ok.

import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDb, portalEnv, seedCustomer, NOW, OTP_PEPPERS } from "./helpers.mjs";
import { requestOtp, redeemOtp, codeFromSecretBytes, emitEmailDeliveryFailure } from "../src/auth/portal_otp.mjs";

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

test("successful email delivery emits no failure event", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const emissions = [];
  const pending = [];
  const result = await requestOtp(env(db), {
    email: "a@x.com",
    clientIp: "1.1.1.1",
    now: NOW,
    sendEmailFn: async () => ({ ok: true, code: "sent" }),
    emailDeliveryFailureFn: (errorType) => emissions.push(errorType),
    waitUntil: (work) => pending.push(work),
  });

  assert.deepEqual(result, { ok: true, code: "ok" });
  assert.equal(pending.length, 1, "delivery remains attached to the request context");
  await Promise.all(pending);
  assert.deepEqual(emissions, []);
});

test("resolved and rejected delivery failures emit one fixed failure class and remain no-throw", async () => {
  const cases = [
    ["unconfigured", () => ({ ok: false, code: "email_unconfigured" })],
    ["send_failed", () => ({ ok: false, code: "email_send_failed" })],
    ["send_failed", () => ({ ok: false, code: "email_send_indeterminate" })],
    ["invalid_result", () => ({ ok: false, code: "provider-secret-detail", body: "provider-secret-body" })],
    ["invalid_result", () => undefined],
    ["rejected", () => Promise.reject(new Error("provider rejection detail"))],
    ["rejected", () => { throw new Error("synchronous provider detail"); }],
  ];

  for (const [expectedErrorType, deliver] of cases) {
    const db = freshDb();
    seedCustomer(db, "A", "a@x.com");
    const emissions = [];
    const pending = [];
    const result = await requestOtp(env(db), {
      email: "a@x.com",
      clientIp: "1.1.1.1",
      now: NOW,
      sendEmailFn: deliver,
      emailDeliveryFailureFn: (errorType) => emissions.push(errorType),
      waitUntil: (work) => pending.push(work),
    });

    assert.deepEqual(result, { ok: true, code: "ok" }, `${expectedErrorType} preserves the anti-enumeration result`);
    assert.equal(pending.length, 1);
    await assert.doesNotReject(Promise.all(pending));
    assert.deepEqual(emissions, [expectedErrorType]);
    db.close();
  }
});

test("email failure telemetry is closed-shape and cannot leak delivery inputs or exception text", async () => {
  const recipient = "sensitive-recipient@example.test";
  const apiKey = "sensitive-email-api-key";
  const providerText = "sensitive-provider-response-text";
  const exceptionText = "sensitive-exception-message";
  const db = freshDb();
  seedCustomer(db, "A", recipient);
  const e = env(db, { PORTAL_EMAIL_API_KEY: apiKey });
  const lines = [];
  let deliveredBody = "";
  const originalError = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const result = await requestOtp(e, {
      email: recipient,
      clientIp: "1.1.1.1",
      magicLinkBase: "https://portal.test",
      now: NOW,
      sendEmailFn: (_deliveryEnv, to, _subject, body) => {
        deliveredBody = body;
        return Promise.reject(new Error(`${exceptionText} ${providerText} ${apiKey} ${to} ${body}`));
      },
    });
    assert.deepEqual(result, { ok: true, code: "ok" });
  } finally {
    console.error = originalError;
  }

  assert.match(deliveredBody, /Your sign-in code is [0-9]{8}/, "the delivery input contained an OTP");
  assert.match(deliveredBody, /token=/, "the delivery input contained a magic-link secret");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "portal.email_delivery_failed",
    severity: "error",
    error_type: "rejected",
  });
  for (const sensitive of [recipient, apiKey, providerText, exceptionText, deliveredBody]) {
    assert.equal(lines[0].includes(sensitive), false, `telemetry excludes ${sensitive === deliveredBody ? "the OTP/magic-link body" : "a sensitive delivery value"}`);
  }
  db.close();
});

test("the email failure emitter bounds unsupported error types and never throws with a broken sink", () => {
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    emitEmailDeliveryFailure("secret-provider-error-text");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(JSON.parse(lines[0]), {
    event: "portal.email_delivery_failed",
    severity: "error",
    error_type: "invalid_result",
  });

  console.error = () => { throw new Error("logging backend unavailable"); };
  try {
    assert.doesNotThrow(() => emitEmailDeliveryFailure("send_failed"));
  } finally {
    console.error = originalError;
  }
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

// Issue a live code for `email` through the operator-bootstrap seam, which is the only way a test
// can learn the code the customer would have been emailed.
async function issueCode(e, email, now = NOW) {
  const req = await requestOtp(e, { email, clientIp: "10.0.0.1", returnSecret: true, now });
  const secretBytes = Uint8Array.from(atob(req.secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return { secret: req.secret, code: codeFromSecretBytes(secretBytes) };
}

// The n-th wrong guess for `code`: a well-formed 8-digit code that is never the right one.
function wrongCode(code, n = 0) {
  return String((Number(code) + n + 1) % 100_000_000).padStart(8, "0");
}

// Each guess comes from its own client address, so only the per-code and per-email limits apply.
async function guessWrong(e, email, code, count) {
  for (let i = 0; i < count; i += 1) {
    const r = await redeemOtp(e, { email, code: wrongCode(code, i), clientIp: `192.0.2.${i + 1}`, now: NOW });
    assert.deepEqual(r, { ok: false, code: "invalid_otp" }, `wrong guess ${i + 1} is refused`);
  }
}

test("every wrong code counts against the live code: 4 wrong guesses then the right code signs in", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const { code } = await issueCode(e, "a@x.com");
  await guessWrong(e, "a@x.com", code, 4);
  assert.equal(db.prepare("SELECT attempt_count FROM portal_otp WHERE customer_id = 'A'").get().attempt_count, 4,
    "each wrong guess raised the live code's attempt count");
  const r = await redeemOtp(e, { email: "a@x.com", code, clientIp: "198.51.100.1", now: NOW });
  assert.equal(r.ok, true, "the fifth guess may still be the right one");
  assert.equal(r.customerId, "A");
});

test("5 wrong guesses kill the live code: the right code and the same row's link secret are refused", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const { code, secret } = await issueCode(e, "a@x.com");
  await guessWrong(e, "a@x.com", code, 5);
  const byCode = await redeemOtp(e, { email: "a@x.com", code, clientIp: "198.51.100.1", now: NOW });
  assert.deepEqual(byCode, { ok: false, code: "invalid_otp" }, "the right code no longer signs in");
  const bySecret = await redeemOtp(e, { secret, clientIp: "198.51.100.2", now: NOW });
  assert.deepEqual(bySecret, { ok: false, code: "invalid_otp" }, "the same row's link secret no longer signs in");
  assert.equal(db.prepare("SELECT attempt_count FROM portal_otp WHERE customer_id = 'A'").get().attempt_count, 5,
    "guesses at a dead code no longer change it");
});

test("wrong guesses for one email leave another email's live code untouched", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  seedCustomer(db, "B", "b@x.com");
  const e = env(db);
  const a = await issueCode(e, "a@x.com");
  const b = await issueCode(e, "b@x.com");
  await guessWrong(e, "a@x.com", a.code, 5);
  assert.equal(db.prepare("SELECT attempt_count FROM portal_otp WHERE customer_id = 'B'").get().attempt_count, 0);
  const r = await redeemOtp(e, { email: "b@x.com", code: b.code, clientIp: "198.51.100.1", now: NOW });
  assert.equal(r.ok, true, "B still signs in with B's code");
  assert.equal(r.customerId, "B");
});

test("unknown email, no live code, wrong code and dead code answer identically and run the same code statements", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  seedCustomer(db, "B", "b@x.com");
  seedCustomer(db, "C", "c@x.com");
  const e = env(db);
  const a = await issueCode(e, "a@x.com");
  const c = await issueCode(e, "c@x.com");
  await guessWrong(e, "c@x.com", c.code, 5);

  // Record the portal_otp statements each failed verify prepares (the rate-limit counters are keyed
  // per address and email, so their bookkeeping differs by design).
  const statements = [];
  const recordingEnv = env(db);
  const real = recordingEnv.DB;
  recordingEnv.DB = { prepare(sql) { if (/portal_otp/.test(sql)) statements.push(sql); return real.prepare(sql); } };
  async function attempt(email, code, clientIp) {
    statements.length = 0;
    const result = await redeemOtp(recordingEnv, { email, code, clientIp, now: NOW });
    return { result, statements: [...statements] };
  }

  const cases = {
    "unknown email": await attempt("nobody@x.com", "12345678", "198.51.100.1"),
    "no live code": await attempt("b@x.com", "12345678", "198.51.100.2"),
    "wrong code": await attempt("a@x.com", wrongCode(a.code, 50), "198.51.100.3"),
    "dead code": await attempt("c@x.com", c.code, "198.51.100.4"),
  };
  const [first, ...rest] = Object.entries(cases);
  assert.deepEqual(first[1].result, { ok: false, code: "invalid_otp" });
  assert.equal(first[1].statements.length, 1, "a code check counts and claims in one statement");
  assert.match(first[1].statements[0], /attempt_count = attempt_count \+ 1/);
  assert.match(first[1].statements[0], /consumed_at = CASE/);
  for (const [name, outcome] of rest) {
    assert.deepEqual(outcome.result, first[1].result, `${name}: same response as ${first[0]}`);
    assert.deepEqual(outcome.statements, first[1].statements, `${name}: same code statements as ${first[0]}`);
  }
});

// A D1 stand-in for concurrent requests: it holds every portal_otp statement, then runs all the
// held ones back to back in arrival order before any request sees its own result, as statements
// from simultaneous requests reach D1 before their answers come back.
function heldOtpStatements(real) {
  const held = [];
  const waiters = [];
  let open = false;
  function hold(execute) {
    if (open) return execute();
    return new Promise((resolve, reject) => {
      held.push({ execute, resolve, reject });
      for (const waiter of waiters.filter(({ count }) => held.length >= count)) waiter.resolve();
    });
  }
  const wrap = (statement) => ({
    bind: (...values) => wrap(statement.bind(...values)),
    first: (...args) => hold(() => statement.first(...args)),
    run: (...args) => hold(() => statement.run(...args)),
    all: (...args) => hold(() => statement.all(...args)),
  });
  return {
    db: { prepare: (sql) => (/portal_otp/.test(sql) ? wrap(real.prepare(sql)) : real.prepare(sql)) },
    held: (count) => (held.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve }))),
    release() {
      open = true;
      // node:sqlite runs each statement synchronously when the adapter method is called, so every
      // held statement has run, in order, before the first answer is delivered.
      const answers = held.map(({ execute }) => execute());
      held.forEach(({ resolve, reject }, index) => answers[index].then(resolve, reject));
    },
  };
}

// Ten simultaneous checks for one address, the right code at `position` (1-based) in the order
// the checks reach the database.
async function concurrentChecks(position) {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const { code } = await issueCode(e, "a@x.com");
  const gate = heldOtpStatements(e.DB);
  const concurrentEnv = { ...e, DB: gate.db };
  const results = [];
  for (let i = 1; i <= 10; i += 1) {
    results.push(redeemOtp(concurrentEnv, { email: "a@x.com", code: i === position ? code : wrongCode(code, i), clientIp: `192.0.2.${i}`, now: NOW }));
    // This check's statement is waiting at the database before the next check starts.
    await gate.held(i);
  }
  gate.release();
  const settled = await Promise.all(results);
  return { right: settled[position - 1], attemptCount: db.prepare("SELECT attempt_count FROM portal_otp").get().attempt_count };
}

test("concurrent checks cannot get past the five-check cap: the right code as the 6th or 10th check is refused", async () => {
  for (const position of [6, 10]) {
    const { right, attemptCount } = await concurrentChecks(position);
    assert.deepEqual(right, { ok: false, code: "invalid_otp" }, `the right code as concurrent check ${position} is refused`);
    assert.equal(attemptCount, 5, "no more than five checks ever counted against the code");
  }
});

test("concurrent checks still let the right code in as the 5th check", async () => {
  const { right, attemptCount } = await concurrentChecks(5);
  assert.equal(right.ok, true, "the fifth check may still be the right one");
  assert.equal(right.customerId, "A");
  assert.equal(attemptCount, 5);
});

test("two live codes for one address each still sign in, and a wrong check counts against both", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  const first = await issueCode(e, "a@x.com", NOW);
  const firstId = db.prepare("SELECT id FROM portal_otp").get().id;
  const second = await issueCode(e, "a@x.com", NOW + 1);
  // A new request supersedes the earlier code; restore it so the address has two live codes.
  db.prepare("UPDATE portal_otp SET consumed_at = NULL WHERE id = ?").run(firstId);
  const counts = () => db.prepare("SELECT attempt_count FROM portal_otp ORDER BY created_at").all().map((row) => row.attempt_count);

  await guessWrong(e, "a@x.com", first.code, 1);
  assert.deepEqual(counts(), [1, 1], "a wrong check counts against every live code of the address");
  const byFirst = await redeemOtp(e, { email: "a@x.com", code: first.code, clientIp: "198.51.100.1", now: NOW + 2 });
  assert.equal(byFirst.ok, true, "the earlier code signs in");
  assert.equal(byFirst.customerId, "A");
  const bySecond = await redeemOtp(e, { email: "a@x.com", code: second.code, clientIp: "198.51.100.2", now: NOW + 2 });
  assert.equal(bySecond.ok, true, "the later code is still live and signs in too");
  assert.equal(db.prepare("SELECT count(*) AS n FROM portal_otp WHERE consumed_at IS NULL").get().n, 0);
});

test("the per-email verify budget refuses the 11th attempt for an address, whatever the client address", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  // Five codes' worth of wrong guesses: each code dies after five, so a fresh one is requested in
  // between, as an attacker keeping a live code would.
  let { code } = await issueCode(e, "a@x.com");
  for (let i = 0; i < 10; i += 1) {
    if (i === 5) ({ code } = await issueCode(e, "a@x.com", NOW + 1));
    const r = await redeemOtp(e, { email: "A@X.com ", code: wrongCode(code, i), clientIp: `203.0.113.${i + 1}`, now: NOW });
    assert.equal(r.code, "invalid_otp", `attempt ${i + 1} is within the budget`);
  }
  ({ code } = await issueCode(e, "a@x.com", NOW + 2));
  const limited = await redeemOtp(e, { email: "a@x.com", code, clientIp: "203.0.113.200", now: NOW });
  assert.equal(limited.code, "rate_limited", "even a fresh, right code is refused once the address's budget is spent");
  const period = 900;
  assert.equal(limited.retryAfter, Math.floor(NOW / period) * period + period - NOW);
  const other = await redeemOtp(e, { email: "b@x.com", code: "12345678", clientIp: "203.0.113.200", now: NOW });
  assert.equal(other.code, "invalid_otp", "another address keeps its own budget");

  // An address with no account gets the same budget, so the limit itself is no oracle.
  for (let i = 0; i < 10; i += 1) await redeemOtp(e, { email: "nobody@x.com", code: "12345678", clientIp: `203.0.113.${100 + i}`, now: NOW });
  assert.equal((await redeemOtp(e, { email: "nobody@x.com", code: "12345678", clientIp: "203.0.113.201", now: NOW })).code, "rate_limited");
});

// The UI's rate-limit sentence needs the exact seconds left in the window, so requestOtp/
// redeemOtp must forward portalRateLimit's retryAfter on their rate_limited outcome.
test("requestOtp reports retryAfter when the per-email cap trips", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  for (let i = 0; i < 5; i += 1) await requestOtp(e, { email: "a@x.com", clientIp: `ip-${i}`, now: NOW });
  const limited = await requestOtp(e, { email: "a@x.com", clientIp: "ip-final", now: NOW });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, "rate_limited");
  const period = 900;
  const windowStart = Math.floor(NOW / period) * period;
  assert.equal(limited.retryAfter, windowStart + period - NOW);
});

test("redeemOtp reports retryAfter when the per-IP verify cap trips", async () => {
  const db = freshDb();
  seedCustomer(db, "A", "a@x.com");
  const e = env(db);
  // A different address each time, so the per-email budget never trips first.
  for (let i = 0; i < 30; i += 1) await redeemOtp(e, { email: `user${i}@x.com`, code: "00000000", clientIp: "1.1.1.1", now: NOW });
  const limited = await redeemOtp(e, { email: "a@x.com", code: "00000000", clientIp: "1.1.1.1", now: NOW });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, "rate_limited");
  const period = 900;
  const windowStart = Math.floor(NOW / period) * period;
  assert.equal(limited.retryAfter, windowStart + period - NOW);
});
