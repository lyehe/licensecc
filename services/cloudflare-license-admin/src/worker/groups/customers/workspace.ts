import type { Env } from "../../env.js";
import { boundedCursor } from "../../query.js";
import { envelope } from "../../responses.js";

export async function customerWorkspace(request: Request, env: Env, customerId: string, rid: string): Promise<Response> {
  const url = new URL(request.url);
  const page = boundedCursor(url);
  if (!page) return envelope(rid, "invalid_request", undefined, 400);
  const customer = await env.DB.prepare("SELECT id, status FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return envelope(rid, "not_found", undefined, 404);
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(`SELECT project, COUNT(*) AS grant_count,
    SUM(status = 'active') AS enabled_count,
    SUM(status = 'active' AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)) AS in_date_count,
    MIN(valid_until) AS earliest_expiry, MAX(valid_until) AS latest_expiry,
    SUM(valid_until IS NULL) AS no_expiry_count
    FROM entitlements WHERE customer_id = ? GROUP BY project ORDER BY project LIMIT ? OFFSET ?`)
    .bind(now, now, customerId, page.limit + 1, page.cursor).all();
  return envelope(rid, "customer_apps", {
    customer, server_time: now, items: rows.results.slice(0, page.limit),
    next_cursor: rows.results.length > page.limit ? String(page.cursor + page.limit) : null,
  });
}
