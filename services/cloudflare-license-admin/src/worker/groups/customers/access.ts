import { entitlementSelectSql, withId } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { EntitlementRecord } from "../../../shared/api.js";
import type { Env } from "../../env.js";
import { boundedCursor } from "../../query.js";
import { envelope } from "../../responses.js";

// Customer identity comes exclusively from the route, never a conflicting query parameter.
// This is a grant page, not an app summary: each row keeps its own dates and exact ID.
export async function customerAccess(request: Request, env: Env, customerId: string, rid: string): Promise<Response> {
  const url = new URL(request.url);
  const page = boundedCursor(url);
  if (page === null) return envelope(rid, "invalid_request", undefined, 400);
  const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first();
  if (customer === null) return envelope(rid, "not_found", undefined, 404);
  const project = url.searchParams.get("project");
  const values: unknown[] = [customerId];
  let where = "WHERE customer_id = ?";
  if (project !== null && project !== "") { where += " AND project = ?"; values.push(project); }
  const rows = await env.DB.prepare(`${entitlementSelectSql(where)} ORDER BY project, feature, license_fingerprint LIMIT ? OFFSET ?`)
    .bind(...values, page.limit + 1, page.cursor).all<Omit<EntitlementRecord, "id">>();
  return envelope(rid, "entitlements_listed", {
    items: rows.results.slice(0, page.limit).map(withId),
    next_cursor: rows.results.length > page.limit ? String(page.cursor + page.limit) : null,
  });
}
