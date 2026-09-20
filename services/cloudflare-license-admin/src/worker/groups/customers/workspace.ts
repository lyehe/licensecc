import type { Env } from "../../env.js";
import { boundedCursor } from "../../query.js";
import { envelope } from "../../responses.js";

export async function customerWorkspace(request: Request, env: Env, customerId: string, rid: string, view: "apps" | "resources"): Promise<Response> {
  const url = new URL(request.url);
  const page = boundedCursor(url);
  const kind = url.searchParams.get("kind") ?? "nodes";
  if (!page || (view === "resources" && kind !== "nodes" && kind !== "sessions")) return envelope(rid, "invalid_request", undefined, 400);
  const customer = await env.DB.prepare("SELECT id, status FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return envelope(rid, "not_found", undefined, 404);
  const now = Math.floor(Date.now() / 1000);
  let rows;
  if (view === "apps") {
    rows = await env.DB.prepare(`SELECT project, COUNT(*) AS grant_count,
      SUM(status = 'active') AS enabled_count,
      SUM(status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)) AS in_date_count,
      MIN(valid_until) AS earliest_expiry, MAX(valid_until) AS latest_expiry,
      SUM(valid_until IS NULL) AS no_expiry_count
      FROM entitlements WHERE customer_id = ? GROUP BY project ORDER BY project LIMIT ? OFFSET ?`)
      .bind(now, now, customerId, page.limit + 1, page.cursor).all();
  } else {
    const project = url.searchParams.get("project");
    const values: unknown[] = [customerId];
    const projectFilter = project ? " AND e.project = ?" : "";
    if (project) values.push(project);
    const table = kind === "nodes" ? "entitlement_devices" : "seat_checkouts";
    const fields = kind === "nodes" ? "r.device_key_id, r.status, r.last_seen_at" : "r.seat_id, r.client_instance_id, r.mode, r.heartbeat_deadline";
    const key = kind === "nodes" ? "r.device_key_id" : "r.seat_id";
    rows = await env.DB.prepare(`SELECT r.project, r.feature, r.license_fingerprint, ${fields}
      FROM ${table} r JOIN entitlements e ON e.project=r.project AND e.feature=r.feature AND e.license_fingerprint=r.license_fingerprint
      WHERE e.customer_id = ?${projectFilter} ORDER BY r.project, r.feature, r.license_fingerprint, ${key} LIMIT ? OFFSET ?`)
      .bind(...values, page.limit + 1, page.cursor).all();
  }
  return envelope(rid, view === "apps" ? "customer_apps" : "customer_resources", {
    customer, server_time: now, items: rows.results.slice(0, page.limit),
    next_cursor: rows.results.length > page.limit ? String(page.cursor + page.limit) : null,
  });
}
