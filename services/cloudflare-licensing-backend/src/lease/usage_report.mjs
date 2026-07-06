// usage_report.mjs
//
// Worker-safe (no node:/Buffer) pure aggregations over the usage_events log -- the
// analytics that make floating sellable (peak concurrent usage, denial rate, adoption).
// Pure functions so they are exhaustively unit-tested and shared by the Worker
// (/v1/admin/report) and the report CLI.

// Peak simultaneous concurrency via a sweep line.
//
// `events` is a list of { ts, type: "checkout" | "end" }. `baseline` is the number of seats
// already held at the start of the window (seats whose checkout preceded it). At an equal
// timestamp a release is applied BEFORE a coincident checkout, so a seat handed off at the
// same instant does not inflate the peak. Returns the maximum simultaneous count.
export function computePeakConcurrent(events, baseline = 0) {
  const rank = (type) => (type === "end" ? 0 : 1); // end before checkout on a tie
  const ordered = [...events].sort((a, b) => a.ts - b.ts || rank(a.type) - rank(b.type));
  let running = baseline;
  let peak = baseline;
  for (const event of ordered) {
    running += event.type === "checkout" ? 1 : -1;
    if (running < 0) running = 0; // defensive: never below zero (unbalanced window data)
    if (running > peak) peak = running;
  }
  return peak;
}

// Map raw usage_events rows to sweep-line events. checkout -> +1; release/reclaim -> -1;
// denied is not a concurrency change.
//
// SEAT-AWARE: a seat can legitimately produce a 'reclaim' (at its lapse deadline) AND a later
// 'release' (client shutdown after a 410) -- two ends for one seat. A seat-blind sweep would
// apply a phantom -1 that undercounts a DIFFERENT live seat under the same entitlement, biasing
// peak_concurrent (the billable metric) downward. So we track open seat_ids and emit an end only
// for a seat that is currently open (first-end-wins, which is the earlier reclaim deadline -- the
// instant the seat actually became free), ignoring the duplicate. Rows are processed in ts order.
// Rows without a seat_id (legacy/null) keep the old +1/-1 behavior so historical data aggregates.
function toSweepEvents(rows) {
  const ordered = [...rows].sort((a, b) => Number(a.ts) - Number(b.ts));
  const events = [];
  const open = new Set();
  for (const row of ordered) {
    const seat = row.seat_id ?? null;
    if (row.event_type === "checkout") {
      if (seat === null) {
        events.push({ ts: Number(row.ts), type: "checkout" });
        continue;
      }
      if (open.has(seat)) continue; // duplicate checkout for a live seat: ignore
      open.add(seat);
      events.push({ ts: Number(row.ts), type: "checkout" });
    } else if (row.event_type === "release" || row.event_type === "reclaim") {
      if (seat === null) {
        events.push({ ts: Number(row.ts), type: "end" });
        continue;
      }
      if (!open.has(seat)) continue; // second end for an already-closed seat: drop the phantom -1
      open.delete(seat);
      events.push({ ts: Number(row.ts), type: "end" });
    }
  }
  return events;
}

// Summarize a window of usage_events rows. `baseline` is the live-seat count at the window
// start (0 for an all-time report). Returns the analytics a vendor sells on.
export function summarizeUsage(rows, baseline = 0) {
  let checkouts = 0;
  let releases = 0;
  let denials = 0;
  const devices = new Set();
  for (const row of rows) {
    switch (row.event_type) {
      case "checkout":
        checkouts += 1;
        if (row.device_key_id) devices.add(row.device_key_id);
        break;
      case "release":
      case "reclaim":
        releases += 1;
        break;
      case "denied":
        denials += 1;
        break;
      default:
        break;
    }
  }
  const attempts = checkouts + denials;
  return {
    peak_concurrent: computePeakConcurrent(toSweepEvents(rows), baseline),
    checkouts,
    releases,
    denials,
    // Fraction of checkout ATTEMPTS that were denied (pool exhausted). The upsell signal.
    denial_rate: attempts === 0 ? 0 : denials / attempts,
    unique_devices: devices.size,
  };
}
