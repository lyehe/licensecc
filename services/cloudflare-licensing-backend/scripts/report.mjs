// report.mjs
//
// Usage analytics CLI: query the usage_events log for one entitlement and print peak
// concurrent usage, denial rate (the upsell signal), and unique devices over a window.
// The aggregation lives in ../src/lease/usage_report.mjs (shared with the Worker's
// /v1/admin/report and exhaustively unit-tested); this CLI just fetches + formats.
//
// Usage:
//   node scripts/report.mjs --fingerprint <64hex> [--project DEFAULT] [--feature DEFAULT]
//        [--from <epoch>] [--to <epoch>] [--remote] [--config wrangler.toml] [--db DB]

import { spawnSync } from "node:child_process";

import { summarizeUsage } from "../src/lease/usage_report.mjs";

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const HEX_64 = /^[0-9a-f]{64}$/;

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = "true";
    } else {
      options[key] = next;
      i += 1;
    }
  }
  return options;
}

// Build the report SELECT. Inputs are validated against strict allowlists before
// interpolation (wrangler d1 execute takes a SQL string, not bound params).
export function buildReportSql(project, feature, fingerprint, from, to) {
  if (!SAFE_NAME.test(project)) throw new Error("invalid --project");
  if (!SAFE_NAME.test(feature)) throw new Error("invalid --feature");
  if (!HEX_64.test(fingerprint)) throw new Error("--fingerprint must be 64 lowercase hex characters");
  const f = Number.parseInt(String(from), 10);
  const t = Number.parseInt(String(to), 10);
  if (!Number.isInteger(f) || f < 0 || !Number.isInteger(t) || t < f) throw new Error("invalid --from/--to window");
  return (
    "SELECT event_type, seat_id, device_key_id, ts FROM usage_events " +
    `WHERE project='${project}' AND feature='${feature}' AND license_fingerprint='${fingerprint}' ` +
    `AND ts >= ${f} AND ts <= ${t} ORDER BY ts ASC`
  );
}

// Distinct seats open at instant t (the windowed-report baseline; matches the Worker's liveSeatsAt).
export function buildBaselineSql(project, feature, fingerprint, t) {
  if (!SAFE_NAME.test(project) || !SAFE_NAME.test(feature)) throw new Error("invalid --project/--feature");
  if (!HEX_64.test(fingerprint)) throw new Error("--fingerprint must be 64 lowercase hex characters");
  const v = Number.parseInt(String(t), 10);
  if (!Number.isInteger(v) || v < 0) throw new Error("invalid baseline instant");
  const ent = `project='${project}' AND feature='${feature}' AND license_fingerprint='${fingerprint}'`;
  return (
    "SELECT COUNT(*) AS baseline FROM (" +
    `SELECT seat_id FROM usage_events WHERE ${ent} AND seat_id IS NOT NULL AND event_type='checkout' AND ts < ${v} ` +
    `EXCEPT SELECT seat_id FROM usage_events WHERE ${ent} AND seat_id IS NOT NULL AND event_type IN ('release','reclaim') AND ts < ${v})`
  );
}

function runD1(sql, options) {
  const db = options.db ?? "DB";
  const config = options.config ?? (options.remote ? "wrangler.toml" : "wrangler.example.toml");
  const args = ["wrangler", "d1", "execute", db, "--json", "--config", config, "--command", sql];
  args.push(options.remote ? "--remote" : "--local");
  const result = spawnSync("npx", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  // wrangler returns [{ results: [...] }] or { result: [{ results: [...] }] } depending on version.
  const block = Array.isArray(parsed) ? parsed[0] : (parsed.result?.[0] ?? parsed);
  return block?.results ?? [];
}

function main() {
  const options = parseArgs(process.argv);
  const fingerprint = options.fingerprint;
  if (!fingerprint) {
    process.stderr.write("usage: node scripts/report.mjs --fingerprint <64hex> [--project] [--feature] [--from] [--to] [--remote]\n");
    process.exit(2);
  }
  const project = options.project ?? "DEFAULT";
  const feature = options.feature ?? "DEFAULT";
  const from = options.from ?? "0";
  const to = options.to ?? String(Math.floor(Date.now() / 1000));
  const rows = runD1(buildReportSql(project, feature, fingerprint, from, to), options);
  // Windowed reports need the baseline of seats already open at the window start, or peak is
  // under-reported. All-time reports (from=0) have no baseline.
  const fromN = Number.parseInt(String(from), 10);
  const baseline =
    fromN > 0 ? Number(runD1(buildBaselineSql(project, feature, fingerprint, fromN), options)[0]?.baseline ?? 0) : 0;
  const summary = summarizeUsage(rows, baseline);
  process.stdout.write(
    `usage report  ${project}/${feature}  fp=${fingerprint.slice(0, 12)}…  [${from}..${to}]\n` +
      `  peak concurrent : ${summary.peak_concurrent}\n` +
      `  checkouts       : ${summary.checkouts}\n` +
      `  releases        : ${summary.releases}\n` +
      `  denials         : ${summary.denials}  (denial rate ${(summary.denial_rate * 100).toFixed(1)}%)\n` +
      `  unique devices  : ${summary.unique_devices}\n`,
  );
}

if (process.argv[1]?.endsWith("report.mjs")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
