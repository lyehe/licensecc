import { summarizeUsage } from "@licensecc/licensing-domain/usage/usage_report";
import { json } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env, ExecutionContextLike, IsolationBinding } from "../env.js";
import { resolveIsolation } from "./verify.js";
import { logEvent } from "../observability/index.js";

const USAGE_EVENT_RETENTION_SEC = 90 * 24 * 60 * 60; // reports cover up to 90d; longer => rollups
const USAGE_REPORT_MAX_ROWS = 100000; // honest cap: beyond this a window report is flagged truncated

export async function recordUsageEvent(
  env: Env,
  e: {
    project: string;
    feature: string;
    fingerprint: string;
    event_type: "checkout" | "release" | "reclaim" | "denied";
    seat_id?: string;
    device_key_id?: string;
    reason?: string;
    ts: number;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO usage_events (project, feature, license_fingerprint, event_type, seat_id, device_key_id, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(e.project, e.feature, e.fingerprint, e.event_type, e.seat_id ?? null, e.device_key_id ?? null, e.reason ?? null, e.ts)
      .run();
  } catch (error) {
    // Best-effort: a missed analytics row must never break licensing -- but make the drop
    // observable so a silent peak_concurrent undercount is detectable in logs.
    logEvent("warn", "usage.record_dropped", {
      project: e.project,
      feature: e.feature,
      event_type: e.event_type,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

interface UsageRow {
  event_type: string;
  seat_id: string | null;
  device_key_id: string | null;
  ts: number;
}

// Live seats at instant t (for a windowed report's baseline): checkouts minus ends before t.
// The ownership EXISTS (soft/required) gates the baseline on the SAME entitlement-ownership
// conjunct as the report read, so a foreign/NULL-owner entitlement contributes nothing to A's
// baseline. off => the original tuple-scoped reads (customerId null can't bind an owned EXISTS).
async function liveSeatsAt(
  env: Env,
  project: string,
  feature: string,
  fingerprint: string,
  t: number,
  isolation: IsolationBinding,
): Promise<number> {
  try {
    // Distinct seats checked out before t minus distinct seats ended before t = seats still open
    // at t. EXCEPT dedups by seat_id, so a seat with both a reclaim AND a release (a double-end)
    // is subtracted once, not twice (which would silently deflate the baseline -> peak).
    const ownership =
      isolation.mode === "off"
        ? ""
        : "AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = usage_events.project AND e.feature = usage_events.feature " +
          "AND e.license_fingerprint = usage_events.license_fingerprint AND " +
          (isolation.mode === "soft" ? "(e.customer_id = ? OR e.customer_id IS NULL)" : "e.customer_id = ?") +
          ") ";
    const sql =
      "SELECT COUNT(*) AS baseline FROM (" +
      `SELECT seat_id FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id IS NOT NULL AND event_type = 'checkout' AND ts < ? ${ownership}` +
      "EXCEPT " +
      `SELECT seat_id FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND seat_id IS NOT NULL AND event_type IN ('release', 'reclaim') AND ts < ? ${ownership})`;
    const binds: unknown[] =
      isolation.mode === "off"
        ? [project, feature, fingerprint, t, project, feature, fingerprint, t]
        : [project, feature, fingerprint, t, isolation.customerId, project, feature, fingerprint, t, isolation.customerId];
    const row = await env.DB.prepare(sql).bind(...binds).first<{ baseline: number }>();
    return Math.max(0, Number(row?.baseline ?? 0));
  } catch {
    return 0;
  }
}

export async function handleUsageReport(request: Request, env: Env, ctx?: ExecutionContextLike, isolationOverride?: IsolationBinding): Promise<Response> {
  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const feature = url.searchParams.get("feature");
  const fingerprint = url.searchParams.get("license_fingerprint");
  if (!project || !feature || !fingerprint) return json({ ok: false, code: "invalid_request" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const isolation = await resolveIsolation(request, env, "report", project, feature, now, ctx, isolationOverride);
  if ("ok" in isolation) return json({ ok: false, code: isolation.code }, isolation.status);

  const fromParam = Number.parseInt(url.searchParams.get("from") ?? "", 10);
  const toParam = Number.parseInt(url.searchParams.get("to") ?? "", 10);
  const windowFrom = Number.isInteger(fromParam) && fromParam > 0 ? fromParam : 0;
  const windowTo = Number.isInteger(toParam) && toParam > 0 ? toParam : now;

  // off => the original tuple-scoped read; soft/required => fold the ownership EXISTS into the
  // usage_events read so a foreign/NULL-owner entitlement's events never surface in A's report.
  const reportOwnership =
    isolation.mode === "off"
      ? ""
      : "AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project = usage_events.project AND e.feature = usage_events.feature " +
        "AND e.license_fingerprint = usage_events.license_fingerprint AND " +
        (isolation.mode === "soft" ? "(e.customer_id = ? OR e.customer_id IS NULL)" : "e.customer_id = ?") +
        ") ";
  const reportSql =
    `SELECT event_type, seat_id, device_key_id, ts FROM usage_events WHERE project = ? AND feature = ? AND license_fingerprint = ? AND ts >= ? AND ts <= ? ${reportOwnership}ORDER BY ts ASC LIMIT ?`;
  const reportBinds: unknown[] =
    isolation.mode === "off"
      ? [project, feature, fingerprint, windowFrom, windowTo, USAGE_REPORT_MAX_ROWS + 1]
      : [project, feature, fingerprint, windowFrom, windowTo, isolation.customerId, USAGE_REPORT_MAX_ROWS + 1];

  let rows: UsageRow[];
  try {
    const result = await env.DB.prepare(reportSql).bind(...reportBinds).all<UsageRow>();
    rows = result.results ?? [];
  } catch {
    return json({ ok: false, code: "verification_error" }, 503);
  }
  // Honest scale guard: if the window holds more events than the cap, the summary is over a
  // prefix only -- flag it rather than report a silently-wrong peak. (Rollups remove the cap.)
  const truncated = rows.length > USAGE_REPORT_MAX_ROWS;
  if (truncated) rows = rows.slice(0, USAGE_REPORT_MAX_ROWS);
  const baseline = windowFrom > 0 ? await liveSeatsAt(env, project, feature, fingerprint, windowFrom, isolation) : 0;
  const summary = summarizeUsage(rows, baseline);
  return json({ ok: true, project, feature, from: windowFrom, to: windowTo, server_time: now, truncated, ...summary });
}
