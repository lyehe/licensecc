// portal_ratelimit unit tests (blueprint (g)): ALWAYS-ON throttling even with D1_RATE_LIMIT_ENABLED
// unset (invariant 5); per-key counters are independent.

import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDb, D1Like, NOW } from "./helpers.mjs";
import { portalRateLimit } from "../src/auth/portal_ratelimit.mjs";

function env() {
  // NOTE: D1_RATE_LIMIT_ENABLED is intentionally UNSET — the portal limiter must throttle anyway.
  return { DB: new D1Like(freshDb()) };
}

test("throttles with D1_RATE_LIMIT_ENABLED unset (invariant 5)", async () => {
  const e = env();
  let lastLimited = false;
  for (let i = 0; i < 5; i += 1) {
    const r = await portalRateLimit(e, "request:email:a@x", 3, 900, NOW);
    lastLimited = r.limited;
  }
  // limit=3 -> the 4th and 5th calls are over the cap.
  assert.equal(lastLimited, true, "limiter trips despite no D1_RATE_LIMIT_ENABLED flag");
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
