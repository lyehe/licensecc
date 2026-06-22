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
function toSweepEvents(rows) {
  const events = [];
  for (const row of rows) {
    if (row.event_type === "checkout") {
      events.push({ ts: Number(row.ts), type: "checkout" });
    } else if (row.event_type === "release" || row.event_type === "reclaim") {
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
