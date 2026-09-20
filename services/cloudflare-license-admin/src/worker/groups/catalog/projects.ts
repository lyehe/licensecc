import type { Env } from "../../env.js";
import { boundedCursor } from "../../query.js";
import { envelope } from "../../responses.js";

// Current configuration and retained business records, including disabled and
// unassigned records. No registry or copied source of truth is introduced.
export async function listProjects(request: Request, env: Env, rid: string): Promise<Response> {
  const page = boundedCursor(new URL(request.url));
  if (page === null) return envelope(rid, "invalid_request", undefined, 400);
  const rows = await env.DB.prepare(`SELECT project FROM (
    SELECT project FROM catalog_features UNION SELECT project FROM catalog_plans
    UNION SELECT project FROM entitlement_policies
    UNION SELECT project FROM entitlements UNION SELECT project FROM licenses
    UNION SELECT project FROM orders UNION SELECT project FROM order_events
  ) ORDER BY project LIMIT ? OFFSET ?`).bind(page.limit + 1, page.cursor).all<{ project: string }>();
  return envelope(rid, "projects_listed", {
    items: rows.results.slice(0, page.limit),
    next_cursor: rows.results.length > page.limit ? String(page.cursor + page.limit) : null,
  });
}
