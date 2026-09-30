// portal_ratelimit unit tests (blueprint (g)): ALWAYS-ON throttling with no enabling
// configuration (invariant 5); per-key counters are independent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDb, D1Like, NOW } from "./helpers.mjs";
import { portalRateLimit } from "../src/auth/portal_ratelimit.mjs";

function env() {
  // NOTE: the env carries only DB, no limiter configuration — the portal limiter must throttle anyway.
  return { DB: new D1Like(freshDb()) };
}

test("throttles with no limiter configuration (invariant 5)", async () => {
  const e = env();
  let lastLimited = false;
  for (let i = 0; i < 5; i += 1) {
    const r = await portalRateLimit(e, "request:email:a@x", 3, 900, NOW);
    lastLimited = r.limited;
  }
  // limit=3 -> the 4th and 5th calls are over the cap.
  assert.equal(lastLimited, true, "limiter trips with no limiter configuration");
});

test("counter is per-key: a different key starts fresh", async () => {
  const e = env();
  for (let i = 0; i < 4; i += 1) await portalRateLimit(e, "verify:cust:A:ip:1.1.1.1", 3, 900, NOW);
  const a = await portalRateLimit(e, "verify:cust:A:ip:1.1.1.1", 3, 900, NOW);
  assert.equal(a.limited, true, "A's IP is over the cap");
  const b = await portalRateLimit(e, "verify:cust:B:ip:2.2.2.2", 3, 900, NOW);
  assert.equal(b.limited, false, "B's IP is independent and under the cap");
});

test("the per-(customer,IP) verify counter is independent of a per-row attempt cap", async () => {
  // The verify RL key encodes both customer and IP; a single row's attempt_count cap (5) is a
  // separate ceiling. Here the RL key tracks 10 verify attempts -> trips at its own cap of 8.
  const e = env();
  let limited = false;
  for (let i = 0; i < 10; i += 1) {
    const r = await portalRateLimit(e, "verify:cust:A:ip:9.9.9.9", 8, 900, NOW);
    limited = r.limited;
  }
  assert.equal(limited, true);
});

test("a fresh window resets the counter", async () => {
  const e = env();
  for (let i = 0; i < 5; i += 1) await portalRateLimit(e, "request:ip:5.5.5.5", 3, 60, NOW);
  const tripped = await portalRateLimit(e, "request:ip:5.5.5.5", 3, 60, NOW);
  assert.equal(tripped.limited, true);
  // Advance past the window: a new window_start -> a fresh counter row.
  const later = await portalRateLimit(e, "request:ip:5.5.5.5", 3, 60, NOW + 120);
  assert.equal(later.limited, false, "the next fixed window starts the count over");
});

test("first call in a window returns count 1 (under cap)", async () => {
  const e = env();
  const r = await portalRateLimit(e, "request:email:fresh@x", 5, 900, NOW);
  assert.equal(r.count, 1);
  assert.equal(r.limited, false);
});

// The UI's rate-limit sentence needs the exact seconds left in the CURRENT fixed window
// (windowStart + period - now), not just a limited/not-limited flag. Pin both ends of a window: the
// very first instant has the full period left, and the very last instant has exactly one second.
test("retryAfter is the exact seconds left in the fixed window, at both boundaries", async () => {
  const e = env();
  const period = 100;
  const windowStart = 1_000; // an arbitrary epoch that is itself a multiple of `period`
  const first = await portalRateLimit(e, "boundary:key", 1, period, windowStart);
  assert.equal(first.retryAfter, period, "the first instant of a window has the full period left");
  const last = await portalRateLimit(e, "boundary:key", 1, period, windowStart + period - 1);
  assert.equal(last.retryAfter, 1, "the last instant of a window has exactly one second left");
  const next = await portalRateLimit(e, "boundary:key", 1, period, windowStart + period);
  assert.equal(next.retryAfter, period, "the next window starts a fresh full period");
});

// Fail-closed still owes the caller a usable retry-after: windowStart/retryAfter are pure functions
// of (now, period), computable even though the counter write itself never happened.
test("retryAfter is still correct when the counter write fails (fail-closed)", async () => {
  const brokenDb = { prepare() { throw new Error("boom"); } };
  const period = 100;
  const windowStart = 5_000;
  const r = await portalRateLimit({ DB: brokenDb }, "broken:key", 1, period, windowStart + 42);
  assert.equal(r.limited, true);
  assert.equal(r.retryAfter, period - 42);
});
