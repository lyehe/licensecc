import type { LabeledPathFragment } from "../assemble.js";
import { ADMIN_AUTH_ERRORS, ADMIN_SECURITY, errorResponse, idParam, limitCursorParams, okResponse } from "../components.js";

const string = { type: "string" };
const integer = { type: "integer" };
const nullableInteger = { type: ["integer", "null"] };
function record(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", required: Object.keys(properties), properties };
}
function workspaceResponse(code: string, items: unknown): Record<string, unknown> {
  return { description: "Customer-scoped page. Offset cursors are not snapshots; refresh after changes.", content: { "application/json": { schema: record({
    ok: { const: true }, code: { const: code }, request_id: string,
    data: record({ customer: record({ id: string, status: string }), server_time: integer,
      items: { type: "array", items }, next_cursor: { type: ["string", "null"] } }),
  }) } } };
}

export const workspacePaths: LabeledPathFragment = {
  label: "workspace",
  entries: [
    ["/api/admin/customers/{id}/apps", { get: {
      tags: ["admin:customers"], operationId: "listCustomerApps", security: ADMIN_SECURITY,
      summary: "Page through complete per-app grant summaries",
      description: "Aggregates all grants for each returned project before pagination. Enabled counts are stored state; in_date_count checks grant dates only, not customer or runtime authorization. Earliest/latest expiry exclude nulls; no_expiry_count preserves non-expiring grants. Nodes and sessions are read separately.",
      parameters: [idParam, ...limitCursorParams()], responses: {
        "200": workspaceResponse("customer_apps", record({ project: string, grant_count: integer, enabled_count: integer, in_date_count: integer, earliest_expiry: nullableInteger, latest_expiry: nullableInteger, no_expiry_count: integer })),
        "400": errorResponse("Invalid limit/cursor pagination bounds.", "invalid_request"), "404": errorResponse("Customer not found.", "not_found"), ...ADMIN_AUTH_ERRORS,
      },
    } }],
    ["/api/admin/customers/{id}/resources", { get: {
      tags: ["admin:customers"], operationId: "listCustomerResources", security: ADMIN_SECURITY,
      summary: "Independently page registered nodes or floating-session records",
      description: "kind selects nodes (default) or sessions; optional project limits scope. Node registrations are not floating sessions. Session records may have expired deadlines; compare with server_time. No device public keys, secrets, or notes are selected. Customer ownership is enforced by a grant join.",
      parameters: [idParam, { name: "kind", in: "query", schema: { type: "string", enum: ["nodes", "sessions"], default: "nodes" } }, { name: "project", in: "query", schema: string }, ...limitCursorParams()], responses: {
        "200": workspaceResponse("customer_resources", { oneOf: [record({ project: string, feature: string, license_fingerprint: string, device_key_id: string, status: string, last_seen_at: nullableInteger }), record({ project: string, feature: string, license_fingerprint: string, seat_id: string, client_instance_id: string, mode: { type: "string", enum: ["live", "borrowed"] }, heartbeat_deadline: integer })] }),
        "400": errorResponse("Invalid kind or limit/cursor pagination bounds.", "invalid_request"), "404": errorResponse("Customer not found.", "not_found"), ...ADMIN_AUTH_ERRORS,
      },
    } }],
    ["/api/admin/customers/{id}/access", { get: {
      tags: ["admin:customers"], operationId: "listCustomerAccess", security: ADMIN_SECURITY,
      summary: "Page through exact grants belonging to one customer",
      description: "Grant-level page; not a complete app summary. Sorted by project, feature, fingerprint. Offset cursors are not snapshots: concurrent insertion/deletion may shift pages. Refresh after mutations. A customer_id query parameter cannot override the path customer. Returns enabled and disabled customers' records for authorized operators.",
      parameters: [idParam, { name: "project", in: "query", required: false, schema: { type: "string" } }, ...limitCursorParams()],
      responses: { "200": okResponse("Exact grants, including independent dates and version fields. Use each returned id with existing entitlement actions and device reads.", "#/components/schemas/EntitlementsListData", "entitlements_listed"),
        "400": errorResponse("Invalid limit/cursor pagination bounds.", "invalid_request"), "404": errorResponse("Customer not found.", "not_found"), ...ADMIN_AUTH_ERRORS },
    } }],
    ["/api/admin/catalog/projects", { get: {
      tags: ["admin:catalog"], operationId: "listCatalogProjects", security: ADMIN_SECURITY,
      summary: "Discover projects from configuration and retained business records",
      description: "Union of catalog features/plans, policies, entitlements, licenses, orders and order events, including disabled and unassigned records. No independent app registry. Lexical project ordering; offset pages can shift under concurrent changes. Audit-only and token-scope-only project names are not configuration records.",
      parameters: limitCursorParams(),
      responses: { "200": { description: "Project page.", content: { "application/json": { schema: {
        type: "object", required: ["ok", "code", "request_id", "data"], properties: {
          ok: { const: true }, code: { const: "projects_listed" }, request_id: { type: "string" },
          data: { type: "object", required: ["items", "next_cursor"], properties: {
            items: { type: "array", items: { type: "object", required: ["project"], properties: { project: { type: "string" } } } },
            next_cursor: { type: ["string", "null"] },
          } },
        },
      } } } }, "400": errorResponse("Invalid limit/cursor pagination bounds.", "invalid_request"), ...ADMIN_AUTH_ERRORS },
    } }],
  ],
};
