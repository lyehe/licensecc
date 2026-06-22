// Unit tests for the usage analytics aggregations (src/lease/usage_report.mjs). The
// peak-concurrent sweep line is the bug-prone core (interval overlap, equal-timestamp
// handoffs, baseline, still-open seats, unbalanced windows), so it is exercised hard here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computePeakConcurrent, summarizeUsage } from "../src/lease/usage_report.mjs";

const co = (ts) => ({ ts, type: "checkout" });
const end = (ts) => ({ ts, type: "end" });

test("empty window peaks at the baseline", () => {
  assert.equal(computePeakConcurrent([], 0), 0);
  assert.equal(computePeakConcurrent([], 3), 3);
});

test("counts simultaneous holds", () => {
  assert.equal(computePeakConcurrent([co(1), co(2), end(3)]), 2);
  assert.equal(computePeakConcurrent([co(1), co(2), co(3), end(4), end(5), end(6)]), 3);
  // interleaved: 1,2,1,2 -> peak 2
  assert.equal(computePeakConcurrent([co(1), co(2), end(3), co(4)]), 2);
});

test("still-open seats count toward the peak", () => {
  assert.equal(computePeakConcurrent([co(1), co(2), co(3)]), 3);
});

test("equal-timestamp handoff does not inflate the peak (release before checkout)", () => {
  // One seat held (baseline 1); at ts=5 it is released and another is checked out.
  // With the tie rule the peak stays 1, not 2.
  assert.equal(computePeakConcurrent([end(5), co(5)], 1), 1);
  // Two distinct checkouts at the same ts DO both count.
  assert.equal(computePeakConcurrent([co(5), co(5)]), 2);
});

test("baseline seats from before the window are included", () => {
  assert.equal(computePeakConcurrent([co(1)], 2), 3);
  assert.equal(computePeakConcurrent([end(1), co(2), co(3)], 1), 2); // 1 ->0 ->1 ->2
});

test("unbalanced windows never go negative", () => {
  assert.equal(computePeakConcurrent([end(1), end(2)], 0), 0);
  assert.equal(computePeakConcurrent([end(1), co(2)], 0), 1);
});

test("order independence: shuffled events give the same peak", () => {
  const events = [co(1), co(2), end(3), co(4), end(5), end(6), co(7)];
  const shuffled = [events[3], events[0], events[6], events[1], events[5], events[2], events[4]];
  assert.equal(computePeakConcurrent(shuffled), computePeakConcurrent(events));
});

test("summarizeUsage rolls up counts, denial rate, unique devices, and peak", () => {
  const rows = [
    { event_type: "checkout", device_key_id: "d1", ts: 10 },
    { event_type: "checkout", device_key_id: "d2", ts: 20 },
    { event_type: "denied", ts: 25 },
    { event_type: "release", ts: 30 },
    { event_type: "checkout", device_key_id: "d1", ts: 35 }, // d1 again -> still 2 unique
    { event_type: "reclaim", ts: 40 },
  ];
  const s = summarizeUsage(rows);
  assert.equal(s.checkouts, 3);
  assert.equal(s.releases, 2); // 1 release + 1 reclaim
  assert.equal(s.denials, 1);
  assert.equal(s.unique_devices, 2); // d1, d2
  // 3 checkouts + 1 denial = 4 attempts; 1 denied
  assert.equal(s.denial_rate, 0.25);
  // concurrency: +1@10,+1@20,-1@30,+1@35,-1@40 -> peak 2
  assert.equal(s.peak_concurrent, 2);
});

test("denial_rate is zero when there are no attempts", () => {
  assert.equal(summarizeUsage([]).denial_rate, 0);
  assert.equal(summarizeUsage([{ event_type: "release", ts: 1 }]).denial_rate, 0);
});
