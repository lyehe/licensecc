import { INVALID_IDEMPOTENCY_KEY, mutationResponse, readIdempotencyKey } from "../../idempotency.js";
import { envelope } from "../../responses.js";
import { entitlementId } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Actor, MutationContext } from "@licensecc/cloudflare-runtime/d1/entitlement_mutation";
import type { Env } from "../../env.js";
import { requireAdmin } from "../../auth.js";
import { parseJsonBody, safeNotes } from "../../request.js";
import { clientIp } from "../../support.js";
import { transitionWithGuard } from "../../transitions.js";
import { CSV_ROW_CAP, SEARCH_PAGINATION_OPTIONS, boundedCursor, csvResponse, likeContains, likePrefix, wantsCsv } from "../../query.js";
export async function listCustomers(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status === "active" || status === "disabled") {
    filters.push("c.status = ?");
    values.push(status);
  }
  const q = url.searchParams.get("q");
  if (q !== null && q !== "") {
    const like = likeContains(q);
    if (like === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("(lower(c.id) LIKE ? ESCAPE '\\' OR lower(c.email) LIKE ? ESCAPE '\\' OR lower(c.name) LIKE ? ESCAPE '\\')");
    values.push(like, like, like);
  }
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const projection =
    `SELECT c.id, c.name, c.email, c.status, c.external_ref, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM entitlements e WHERE e.customer_id = c.id) AS entitlement_count,
       (SELECT COUNT(*) FROM entitlements e WHERE e.customer_id = c.id AND e.status = 'active') AS active_entitlement_count
     FROM customers c ${where}`;
  if (wantsCsv(url)) {
    const csvRows = await env.DB.prepare(`${projection} ORDER BY c.updated_at DESC, c.id LIMIT ?`)
      .bind(...values, CSV_ROW_CAP).all<Record<string, unknown>>();
    return csvResponse(
      "customers.csv",
      ["id", "name", "email", "status", "external_ref", "entitlement_count", "active_entitlement_count", "created_at", "updated_at"],
      csvRows.results,
    );
  }
  const { limit, cursor } = pagination;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(`${projection} ORDER BY c.updated_at DESC, c.id LIMIT ? OFFSET ?`)
    .bind(...values).all();
  return envelope(requestIdValue, "customers_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

export async function getCustomer(env: Env, customerId: string, requestIdValue: string): Promise<Response> {
  const customer = await env.DB.prepare(
    "SELECT id, name, email, status, external_ref, metadata_json, created_at, updated_at FROM customers WHERE id = ?",
  ).bind(customerId).first();
  if (customer === null) {
    return envelope(requestIdValue, "not_found", undefined, 404);
  }
  // NOTE: token_hmac / pepper_key_id are deliberately NEVER selected — operators see the
  // display prefix and scope/status only, never the keyed secret material.
  const [entitlements, tokens, licenses, orders, events] = await Promise.all([
    env.DB.prepare(
      "SELECT project, feature, license_fingerprint, status, valid_from, valid_until, revocation_seq, updated_at FROM entitlements WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 200",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT id, token_prefix, name, status, scopes_json, expires_at, last_used_at, created_at FROM account_tokens WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT id, project, label, created_at, updated_at FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 100",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT subscription_id, project, feature, license_fingerprint, last_seq, order_epoch, updated_at FROM orders WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 100",
    ).bind(customerId).all(),
    env.DB.prepare(
      "SELECT id, event_type, prev_status, next_status, actor, actor_type, reason, created_at FROM customer_events WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
    ).bind(customerId).all(),
  ]);
  return envelope(requestIdValue, "customer", {
    customer,
    entitlements: entitlements.results,
    account_tokens: tokens.results,
    licenses: licenses.results,
    orders: orders.results,
    events: events.results,
  });
}

export async function listLicenses(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const filters: string[] = [];
  const values: unknown[] = [];
  for (const [query, column] of [["project", "project"], ["customer_id", "customer_id"]] as const) {
    const value = url.searchParams.get(query);
    if (value !== null && value !== "") {
      filters.push(`${column} = ?`);
      values.push(value);
    }
  }
  const q = url.searchParams.get("q");
  if (q !== null && q !== "") {
    const like = likeContains(q);
    if (like === null) {
      return envelope(requestIdValue, "invalid_request", undefined, 400);
    }
    filters.push("(lower(id) LIKE ? ESCAPE '\\' OR lower(label) LIKE ? ESCAPE '\\')");
    values.push(like, like);
  }
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const { limit, cursor } = pagination;
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT id, customer_id, project, label, created_at, updated_at FROM licenses ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
  ).bind(...values).all();
  return envelope(requestIdValue, "licenses_listed", {
    items: rows.results.slice(0, limit),
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

export async function listOrders(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const staleSecs = Math.min(Math.max(Number(url.searchParams.get("stale_secs") ?? "300") || 300, 1), 86400);
  const filters: string[] = [];
  const values: unknown[] = [];
  const status = url.searchParams.get("status");
  if (status !== null && ["accepted", "processed", "superseded", "rejected"].includes(status)) {
    filters.push("status = ?");
    values.push(status);
  }
  const sub = url.searchParams.get("subscription_id");
  if (sub !== null && sub !== "") {
    filters.push("subscription_id = ?");
    values.push(sub);
  }
  const pagination = boundedCursor(url);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const { limit, cursor } = pagination;
  const where = filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  values.push(limit + 1, cursor);
  const rows = await env.DB.prepare(
    `SELECT event_id, subscription_id, project, feature, order_epoch, seq, intent, key_id, status, received_at, processed_at FROM order_events ${where} ORDER BY received_at DESC, event_id LIMIT ? OFFSET ?`,
  ).bind(...values).all<Record<string, unknown>>();
  const items = rows.results.slice(0, limit).map((row) => ({
    ...row,
    stale: row.status === "accepted" && row.processed_at === null && Number(row.received_at) < now - staleSecs,
  }));
  const byStatus = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM order_events GROUP BY status")
    .all<{ status: string; count: number }>();
  const stale = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM order_events WHERE status = 'accepted' AND processed_at IS NULL AND received_at < ?",
  ).bind(now - staleSecs).first<{ count: number }>();
  const fulfillmentSummary: Record<string, number> = { accepted: 0, processed: 0, superseded: 0, rejected: 0 };
  for (const row of byStatus.results) {
    fulfillmentSummary[row.status] = row.count;
  }
  fulfillmentSummary.stale_accepted = stale?.count ?? 0;
  return envelope(requestIdValue, "orders_listed", {
    items,
    summary: fulfillmentSummary,
    stale_secs: staleSecs,
    next_cursor: rows.results.length > limit ? String(cursor + limit) : null,
  });
}

export async function handleCustomerTransition(
  request: Request,
  env: Env,
  actor: Actor,
  customerId: string,
  action: "disable" | "reenable",
  requestIdValue: string,
): Promise<Response> {
  const adminError = requireAdmin(actor, requestIdValue);
  if (adminError !== null) {
    return adminError;
  }
  if (customerId.length === 0 || customerId.length > 128) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey === INVALID_IDEMPOTENCY_KEY) {
    return envelope(requestIdValue, "invalid_idempotency_key", undefined, 400);
  }
  const body = await parseJsonBody(request, requestIdValue);
  if (body instanceof Response) {
    return body;
  }
  const reason = safeNotes((body as Record<string, unknown>).reason) ?? "";
  const ctx: MutationContext = { actor, requestId: requestIdValue, ip: clientIp(request), idempotencyKey, source: "admin" };
  return mutationResponse(request, env, ctx, `customer_${action}d`, () =>
    transitionWithGuard(env, {
      table: "customers",
      columns: "id, name, email, status, external_ref, created_at, updated_at",
      idClause: "id = ?",
      idValues: [customerId],
      action,
      conflictCode: "customer_status_conflict",
      reason,
      requireReason: true,
      auditStatement: (existing, nextStatus, now) =>
        env.DB.prepare(
          `INSERT INTO customer_events (customer_id, event_type, prev_status, next_status, actor, actor_type, source, reason, request_id, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'admin', ?, ?, ? WHERE EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = ? AND updated_at = ?)`,
        ).bind(customerId, action, String(existing.status), nextStatus, actor.email, actor.actorType, reason, requestIdValue, now, customerId, nextStatus, now),
    }, requestIdValue),
  );
}

// ── Bulk entitlement transitions (Workstream C) ──────────────────────────────
// POST /api/admin/entitlements/batch — admin-only. Body { action, reason, ids[] }.
// Composes the SHARED transitionEntitlement once per id; one bad row never aborts the
// others (per-row success/failure is collected). createEntitlement is NOT touched.
//
// FOOTGUN guarded here: mutation_idempotency is keyed by (scope, idempotency_key). If every
// row reused the SAME idempotency key, the FIRST row's cached response would be replayed for
// every subsequent row (mergeable only by accident). So each row gets a DISTINCT sub-key
// `<base>:<id>` derived from the request's Idempotency-Key (or a generated batch id), and the
// scope mirrors the single mutations (METHOD:pathname:actor.subject) so a re-POST of the same
// batch with the same Idempotency-Key replays each row's OWN cached response — not row #1's.
export async function globalSearch(request: Request, env: Env, requestIdValue: string): Promise<Response> {
  const url = new URL(request.url);
  const rawQ = url.searchParams.get("q");
  if (rawQ === null || rawQ === "") {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const like = likeContains(rawQ);
  const prefix = likePrefix(rawQ);
  if (like === null || prefix === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const pagination = boundedCursor(url, SEARCH_PAGINATION_OPTIONS);
  if (pagination === null) {
    return envelope(requestIdValue, "invalid_request", undefined, 400);
  }
  const perType = pagination.limit;
  const [customers, licenses, entitlements, orders] = await Promise.all([
    env.DB.prepare(
      "SELECT id, name, email, external_ref, status FROM customers WHERE lower(id) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\' OR lower(external_ref) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?",
    ).bind(like, like, like, like, perType).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT id, project, label, customer_id FROM licenses WHERE lower(id) LIKE ? ESCAPE '\\' OR lower(label) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?",
    ).bind(like, like, perType).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT project, feature, license_fingerprint, status, customer_id FROM entitlements WHERE license_fingerprint LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    ).bind(prefix, perType).all<Record<string, unknown>>(),
    env.DB.prepare(
      "SELECT subscription_id, project, feature, license_fingerprint, customer_id FROM orders WHERE lower(subscription_id) LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?",
    ).bind(like, perType).all<Record<string, unknown>>(),
  ]);
  const results: Array<Record<string, unknown>> = [];
  for (const row of customers.results) {
    results.push({ type: "customer", id: row.id, label: row.name, email: row.email, status: row.status, external_ref: row.external_ref });
  }
  for (const row of licenses.results) {
    results.push({ type: "license", id: row.id, label: row.label, project: row.project, customer_id: row.customer_id });
  }
  for (const row of entitlements.results) {
    const id = entitlementId(String(row.project), String(row.feature), String(row.license_fingerprint));
    results.push({ type: "entitlement", id, label: row.license_fingerprint, project: row.project, feature: row.feature, status: row.status, customer_id: row.customer_id });
  }
  for (const row of orders.results) {
    results.push({ type: "order", id: row.subscription_id, label: row.subscription_id, project: row.project, feature: row.feature, license_fingerprint: row.license_fingerprint, customer_id: row.customer_id });
  }
  return envelope(requestIdValue, "search_results", { results });
}

// ── License-policy templates (Stage 3) ───────────────────────────────────────
// CRUD over entitlement_policies. Reads are reader+admin; writes require requireAdmin.
// Each write (create/patch/disable/reenable) commits the row mutation + a policy_events
// audit row in ONE atomic batch, mirroring the customer kill-switch's guarded-UPDATE+audit
// shape. Policy CRUD is ALWAYS available regardless of POLICY_STAMP_MODE — managing template
// rows is harmless; the mode only gates whether a create HONORS a policy_id.

// The full policy column projection, in storage order — every policy SELECT/RETURNING renders these.
