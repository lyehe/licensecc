// OpenAPI 3.1 "doc-of-existing" for the Cloudflare License Admin Worker.
//
// This is a hand-maintained description of the routes ACTUALLY served by
// src/worker/index.ts. It is pinned to the source by test/openapi-crosscheck.test.mjs
// (the cross-check fails CI if a route is added/removed in the Worker without a matching
// change here, or vice-versa). Keep `paths` in lock-step with the Worker's routing.
//
// Served unauthenticated by the Worker fetch handler (added EARLY, before auth):
//   GET /openapi.json -> this object as application/json
//   GET /docs         -> a self-contained HTML viewer (no external CDN)
//
// Envelope conventions (admin Worker): EVERY endpoint returns the flat JSON envelope
//   { ok: boolean, code: string, request_id: string, data?: T }
// success bodies set ok:true and carry `data`; error bodies set ok:false and omit `data`.

// Minimal structural type for the slice of OpenAPI 3.1 we emit. We intentionally do not
// pull an external types dependency (the Worker bundle stays dependency-free).
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string; readonly description?: string };
  readonly servers: ReadonlyArray<{ readonly url: string; readonly description?: string }>;
  readonly tags?: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  readonly security?: ReadonlyArray<Record<string, ReadonlyArray<string>>>;
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components: {
    readonly securitySchemes: Readonly<Record<string, unknown>>;
    readonly schemas: Readonly<Record<string, unknown>>;
    readonly parameters?: Readonly<Record<string, unknown>>;
    readonly responses?: Readonly<Record<string, unknown>>;
  };
}

// ── Reusable building blocks ────────────────────────────────────────────────

// A reusable error envelope response: { ok:false, code, request_id }. The OpenAPI
// status key it is filed under tells you the HTTP code; `code` is the machine string.
function errorResponse(description: string, ...codes: ReadonlyArray<string>): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
        ...(codes.length > 0
          ? { examples: Object.fromEntries(codes.map((code) => [code, { value: { ok: false, code, request_id: "1a2b3c-1" } } as const])) }
          : {}),
      },
    },
  };
}

// A success envelope response carrying `data` of the referenced schema.
function okResponse(description: string, dataRef: string, code: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [
            { $ref: "#/components/schemas/SuccessEnvelope" },
            { type: "object", properties: { code: { const: code }, data: { $ref: dataRef } } },
          ],
        },
      },
    },
  };
}

const idempotencyKeyHeader = {
  name: "idempotency-key",
  in: "header",
  required: false,
  description: "Optional idempotency key (max 128 chars). Mutations with the same scope+key+actor are cached and replayed from D1. An invalid (over-long/empty) value returns 400 invalid_idempotency_key.",
  schema: { type: "string", maxLength: 128 },
} as const;

const idParam = {
  name: "id",
  in: "path",
  required: true,
  description: "Resource identifier from the URL path. For entitlements this is the encoded entitlement id; for customers it is the URI-decoded customer id.",
  schema: { type: "string" },
} as const;

const deviceKeyIdParam = {
  name: "deviceKeyId",
  in: "path",
  required: true,
  description: "The relay-resistance device key id, form `sha256:<64-hex>` (URL-encoded in the path).",
  schema: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
} as const;

function limitCursorParams(): ReadonlyArray<Record<string, unknown>> {
  return [
    { name: "limit", in: "query", required: false, description: "Page size (default 50, clamped to max 100).", schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
    { name: "cursor", in: "query", required: false, description: "Opaque numeric offset cursor (default 0). Use `next_cursor` from the previous page.", schema: { type: "string", default: "0" } },
  ];
}

// CSV export rides the existing list path: `?format=csv` streams a text/csv attachment of
// the rows the JSON list would return (SAME filters), capped at 10000 rows. No new route.
const formatCsvParam = {
  name: "format",
  in: "query",
  required: false,
  description: "When `csv`, the endpoint returns a text/csv attachment (Content-Disposition) of the rows the JSON list would return, using the SAME filters, capped at 10000 rows (a trailing comment row marks truncation). Omit (or any other value) for the default JSON envelope.",
  schema: { type: "string", enum: ["csv"] },
} as const;

// The shared text/csv export response documented on every list endpoint that accepts ?format=csv.
const csvExportResponse = {
  description: "CSV export (returned only when ?format=csv). text/csv attachment of up to 10000 rows; a trailing comment row marks a truncated export.",
  content: { "text/csv": { schema: { type: "string" } } },
} as const;

// ── Path objects ────────────────────────────────────────────────────────────

const ADMIN_SECURITY: ReadonlyArray<Record<string, ReadonlyArray<string>>> = [{ cloudflareAccess: [] }, { devBearer: [] }];
const SYNC_SECURITY: ReadonlyArray<Record<string, ReadonlyArray<string>>> = [{ syncBearer: [] }];

// Error responses shared by every authenticated admin endpoint (the auth gate runs first).
const ADMIN_AUTH_ERRORS = {
  "401": errorResponse("Authentication failed.", "missing_access_jwt", "admin_auth_not_configured"),
  "403": errorResponse("Authorization failed.", "invalid_access_jwt", "admin_role_denied"),
} as const;

// Error responses shared by every admin MUTATION endpoint (auth + RBAC + body limits + idempotency).
const ADMIN_MUTATION_AUTH_ERRORS = {
  "401": errorResponse("Authentication failed.", "missing_access_jwt", "admin_auth_not_configured"),
  "403": errorResponse("Authorization failed (RBAC / invalid JWT / admin role required).", "invalid_access_jwt", "admin_role_denied", "admin_role_required"),
} as const;

const paths: Record<string, Record<string, unknown>> = {
  "/openapi.json": {
    get: {
      tags: ["meta"],
      summary: "This OpenAPI 3.1 document",
      operationId: "getOpenApiDocument",
      security: [],
      responses: {
        "200": { description: "The OpenAPI document for this Worker.", content: { "application/json": { schema: { type: "object" } } } },
      },
    },
  },
  "/docs": {
    get: {
      tags: ["meta"],
      summary: "Self-contained HTML API reference",
      operationId: "getDocsPage",
      security: [],
      responses: {
        "200": { description: "A dependency-free HTML page that fetches /openapi.json and renders the endpoint list.", content: { "text/html": { schema: { type: "string" } } } },
      },
    },
  },

  "/api/admin/summary": {
    get: {
      tags: ["admin:reports"],
      summary: "Entitlement counts by status",
      operationId: "getAdminSummary",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse("Entitlement counts.", "#/components/schemas/SummaryData", "summary"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/report": {
    get: {
      tags: ["admin:reports"],
      summary: "Comprehensive system report with all metrics",
      operationId: "getAdminReport",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse("Full system metrics snapshot.", "#/components/schemas/ReportData", "report"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/report/timeseries": {
    get: {
      tags: ["admin:reports"],
      summary: "Bucketed usage + fulfillment time-series over a [from,to] window (reader+admin)",
      operationId: "getReportTimeseries",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "from", in: "query", required: false, description: "Window start (epoch seconds). Defaults to `to` minus 7 days.", schema: { type: "integer", minimum: 0 } },
        { name: "to", in: "query", required: false, description: "Window end (epoch seconds, exclusive upper edge). Defaults to now.", schema: { type: "integer", minimum: 0 } },
        { name: "buckets", in: "query", required: false, description: "Number of equal buckets to split the window into (default 24, clamped to 1..200).", schema: { type: "integer", default: 24, minimum: 1, maximum: 200 } },
      ],
      responses: {
        "200": okResponse("Per-bucket usage (checkouts/releases/denials/denial_rate) + fulfillment_events.", "#/components/schemas/TimeseriesData", "report_timeseries"),
        "400": errorResponse("Invalid window (from >= to).", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/report/expiring": {
    get: {
      tags: ["admin:reports"],
      summary: "Active entitlements expiring within N days, soonest first (reader+admin)",
      operationId: "getReportExpiring",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "within_days", in: "query", required: false, description: "Look-ahead horizon in days (default 30, clamped to 1..365).", schema: { type: "integer", default: 30, minimum: 1, maximum: 365 } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("Expiring-soon entitlement page (valid_until ASC) with days_left.", "#/components/schemas/ExpiringData", "report_expiring"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/audit/verify": {
    get: {
      tags: ["admin:reports"],
      summary: "Verify the tamper-evident audit hash chain over entitlement_events (reader+admin)",
      operationId: "verifyAuditChain",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse(
          "The chain-verification result; data.audit_chain.ok is false with brokenAt/reason when tampering is detected.",
          "#/components/schemas/AuditChainData",
          "audit_chain_ok",
        ),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/customers": {
    get: {
      tags: ["admin:customers"],
      summary: "List customers with pagination and optional filtering",
      operationId: "listCustomers",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "status", in: "query", required: false, description: "Filter by customer status.", schema: { type: "string", enum: ["active", "disabled"] } },
        { name: "q", in: "query", required: false, description: "Case-insensitive contains search over id/email/name (max 128 chars).", schema: { type: "string", maxLength: 128 } },
        ...limitCursorParams(),
        formatCsvParam,
      ],
      responses: {
        "200": okResponse("Customer page (JSON), or a CSV attachment when ?format=csv.", "#/components/schemas/CustomersListData", "customers_listed"),
        "400": errorResponse("Invalid query parameter (e.g. over-long search term).", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/customers/{id}": {
    get: {
      tags: ["admin:customers"],
      summary: "Get detailed customer profile with related entitlements, tokens, licenses, orders, and events",
      operationId: "getCustomer",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      responses: {
        "200": okResponse("Customer detail bundle. Account-token HMAC and pepper_key_id are never returned.", "#/components/schemas/CustomerDetailData", "customer"),
        ...ADMIN_AUTH_ERRORS,
        "404": errorResponse("No customer with that id.", "not_found"),
      },
    },
  },
  "/api/admin/customers/{id}/disable": {
    post: {
      tags: ["admin:customers"],
      summary: "Disable customer account (kill-switch, atomic with audit event)",
      operationId: "disableCustomer",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse("Customer disabled.", "#/components/schemas/CustomerRow", "customer_disabled"),
        "400": errorResponse("Invalid request / json / idempotency key, or missing reason.", "invalid_request", "invalid_idempotency_key", "invalid_json", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No customer with that id.", "not_found"),
        "409": errorResponse("Customer is not in the expected prior status (concurrent change).", "customer_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/customers/{id}/reenable": {
    post: {
      tags: ["admin:customers"],
      summary: "Re-enable customer account",
      operationId: "reenableCustomer",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted; any `reason` field is ignored.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": okResponse("Customer re-enabled.", "#/components/schemas/CustomerRow", "customer_reenabled"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No customer with that id.", "not_found"),
        "409": errorResponse("Customer is not in the expected prior status (concurrent change).", "customer_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/licenses": {
    get: {
      tags: ["admin:licenses"],
      summary: "List licenses with pagination and optional filtering",
      operationId: "listLicenses",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "project", in: "query", required: false, description: "Exact-match project filter.", schema: { type: "string" } },
        { name: "customer_id", in: "query", required: false, description: "Exact-match customer id filter.", schema: { type: "string" } },
        { name: "q", in: "query", required: false, description: "Case-insensitive contains search over id/label (max 128 chars).", schema: { type: "string", maxLength: 128 } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("License page.", "#/components/schemas/LicensesListData", "licenses_listed"),
        "400": errorResponse("Invalid query parameter (e.g. over-long search term).", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/orders": {
    get: {
      tags: ["admin:orders"],
      summary: "List order events with fulfillment summary and staleness detection",
      operationId: "listOrders",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "status", in: "query", required: false, description: "Filter by fulfillment status.", schema: { type: "string", enum: ["accepted", "processed", "superseded", "rejected"] } },
        { name: "subscription_id", in: "query", required: false, description: "Exact-match subscription id filter.", schema: { type: "string" } },
        { name: "stale_secs", in: "query", required: false, description: "Staleness threshold in seconds (default 300, clamped to 1..86400).", schema: { type: "integer", default: 300, minimum: 1, maximum: 86400 } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("Order-event page with fulfillment summary.", "#/components/schemas/OrdersListData", "orders_listed"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/settings": {
    get: {
      tags: ["admin:reports"],
      summary: "Get worker configuration and auth settings",
      operationId: "getSettings",
      security: ADMIN_SECURITY,
      responses: {
        "200": okResponse("Worker configuration.", "#/components/schemas/SettingsData", "settings"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/policies": {
    get: {
      tags: ["admin:policies"],
      summary: "List license-policy templates with pagination and optional filtering",
      operationId: "listPolicies",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "project", in: "query", required: false, description: "Exact-match project filter.", schema: { type: "string" } },
        { name: "type", in: "query", required: false, description: "Exact-match policy type filter.", schema: { type: "string", enum: ["trial", "node_locked", "floating", "subscription"] } },
        { name: "status", in: "query", required: false, description: "Exact-match status filter.", schema: { type: "string", enum: ["active", "disabled"] } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("Policy page.", "#/components/schemas/PoliciesListData", "policies_listed"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
    post: {
      tags: ["admin:policies"],
      summary: "Create a license-policy template (admin-only)",
      operationId: "createPolicy",
      security: ADMIN_SECURITY,
      parameters: [idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/PolicyInput" } } },
      },
      responses: {
        "200": okResponse("Policy created.", "#/components/schemas/Policy", "policy_created"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "409": errorResponse("A policy with that name already exists in the project.", "policy_name_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/policies/{id}": {
    get: {
      tags: ["admin:policies"],
      summary: "Get a single license-policy template by id",
      operationId: "getPolicy",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      responses: {
        "200": okResponse("Policy record.", "#/components/schemas/Policy", "policy"),
        ...ADMIN_AUTH_ERRORS,
        "404": errorResponse("No policy with that id.", "not_found"),
      },
    },
    patch: {
      tags: ["admin:policies"],
      summary: "Update mutable policy template fields (admin-only)",
      operationId: "patchPolicy",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/PolicyPatch" } } },
      },
      responses: {
        "200": okResponse("Policy updated.", "#/components/schemas/Policy", "policy_patched"),
        "400": errorResponse("Invalid request / json / idempotency key (project/name/type/status are not patchable).", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No policy with that id.", "not_found"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/policies/{id}/disable": {
    post: {
      tags: ["admin:policies"],
      summary: "Disable a policy template (admin-only, requires reason; blocks new stamps only)",
      operationId: "disablePolicy",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse("Policy disabled.", "#/components/schemas/Policy", "policy_disabled"),
        "400": errorResponse("Invalid request / json / idempotency key, or missing reason.", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No policy with that id.", "not_found"),
        "409": errorResponse("Policy is not in the expected prior status (concurrent change).", "policy_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/policies/{id}/reenable": {
    post: {
      tags: ["admin:policies"],
      summary: "Re-enable a disabled policy template (admin-only)",
      operationId: "reenablePolicy",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted; any `reason` field is ignored.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": okResponse("Policy re-enabled.", "#/components/schemas/Policy", "policy_reenabled"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No policy with that id.", "not_found"),
        "409": errorResponse("Policy is not in the expected prior status (concurrent change).", "policy_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/webhooks": {
    get: {
      tags: ["admin:webhooks"],
      summary: "List webhook endpoints with pagination and optional status filtering",
      operationId: "listWebhooks",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "status", in: "query", required: false, description: "Exact-match status filter.", schema: { type: "string", enum: ["active", "disabled"] } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("Webhook endpoint page.", "#/components/schemas/WebhooksListData", "webhooks_listed"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
    post: {
      tags: ["admin:webhooks"],
      summary: "Create a webhook endpoint (admin-only, https URL required)",
      operationId: "createWebhook",
      security: ADMIN_SECURITY,
      parameters: [idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEndpointInput" } } },
      },
      responses: {
        "200": okResponse("Webhook endpoint created.", "#/components/schemas/WebhookEndpoint", "webhook_created"),
        "400": errorResponse("Invalid request / json / idempotency key, or a non-https URL.", "invalid_idempotency_key", "invalid_json", "invalid_request", "invalid_url"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/webhooks/deliveries": {
    get: {
      tags: ["admin:webhooks"],
      summary: "List webhook deliveries (the outbox) filtered by status / endpoint",
      operationId: "listWebhookDeliveries",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "status", in: "query", required: false, description: "Exact-match delivery status filter.", schema: { type: "string", enum: ["pending", "delivered", "failed"] } },
        { name: "endpoint_id", in: "query", required: false, description: "Filter to one endpoint id (max 128 chars).", schema: { type: "string", maxLength: 128 } },
        ...limitCursorParams(),
      ],
      responses: {
        "200": okResponse("Delivery page.", "#/components/schemas/WebhookDeliveriesListData", "webhook_deliveries_listed"),
        "400": errorResponse("Invalid status / endpoint_id filter.", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/webhooks/deliveries/{id}/redrive": {
    post: {
      tags: ["admin:webhooks"],
      summary: "Redrive a failed delivery back to pending (admin-only)",
      operationId: "redriveWebhookDelivery",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted; no body fields are read.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": okResponse("Delivery reset to pending (next_attempt_at = now).", "#/components/schemas/WebhookDelivery", "webhook_delivery_redriven"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No delivery with that id.", "not_found"),
        "409": errorResponse("Delivery is not in the 'failed' status (only failed deliveries can be redriven).", "webhook_delivery_not_failed"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/webhooks/{id}": {
    get: {
      tags: ["admin:webhooks"],
      summary: "Get a webhook endpoint by id, including its recent deliveries",
      operationId: "getWebhook",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      responses: {
        "200": okResponse("Webhook endpoint + its 50 most-recent deliveries.", "#/components/schemas/WebhookDetailData", "webhook"),
        ...ADMIN_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
      },
    },
    patch: {
      tags: ["admin:webhooks"],
      summary: "Update a webhook endpoint's url / event_types / description (admin-only)",
      operationId: "patchWebhook",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEndpointPatch" } } },
      },
      responses: {
        "200": okResponse("Webhook endpoint updated.", "#/components/schemas/WebhookEndpoint", "webhook_patched"),
        "400": errorResponse("Invalid request / json / idempotency key, or a non-https URL (status/id are not patchable).", "invalid_idempotency_key", "invalid_json", "invalid_request", "invalid_url"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/webhooks/{id}/disable": {
    post: {
      tags: ["admin:webhooks"],
      summary: "Disable a webhook endpoint (admin-only; stops enqueue/delivery for it)",
      operationId: "disableWebhook",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted; no body fields are read.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": okResponse("Webhook endpoint disabled.", "#/components/schemas/WebhookEndpoint", "webhook_disabled"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
        "409": errorResponse("Endpoint is not in the expected prior status (concurrent change).", "webhook_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/webhooks/{id}/reenable": {
    post: {
      tags: ["admin:webhooks"],
      summary: "Re-enable a disabled webhook endpoint (admin-only)",
      operationId: "reenableWebhook",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted; no body fields are read.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": okResponse("Webhook endpoint re-enabled.", "#/components/schemas/WebhookEndpoint", "webhook_reenabled"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
        "409": errorResponse("Endpoint is not in the expected prior status (concurrent change).", "webhook_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements": {
    get: {
      tags: ["admin:entitlements"],
      summary: "List entitlements with pagination and optional filtering",
      operationId: "listEntitlements",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "project", in: "query", required: false, description: "Exact-match project filter.", schema: { type: "string" } },
        { name: "feature", in: "query", required: false, description: "Exact-match feature filter.", schema: { type: "string" } },
        { name: "status", in: "query", required: false, description: "Exact-match status filter.", schema: { type: "string", enum: ["active", "disabled", "revoked"] } },
        ...limitCursorParams(),
        formatCsvParam,
      ],
      responses: {
        "200": okResponse("Entitlement page (JSON), or a CSV attachment when ?format=csv.", "#/components/schemas/EntitlementsListData", "entitlements_listed"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
    post: {
      tags: ["admin:entitlements"],
      summary: "Create new entitlement (admin-only); optionally stamp from a policy via policy_id",
      operationId: "createEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/EntitlementInput" } } },
      },
      responses: {
        "200": okResponse("Entitlement created (directly, or stamped from a policy).", "#/components/schemas/EntitlementRecord", "entitlement_saved"),
        "400": errorResponse("Invalid request / json / id / idempotency key, or a policy_id was supplied while POLICY_STAMP_MODE is off.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request", "policy_stamping_disabled"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("Referenced resource not found, or the policy_id is unknown/disabled.", "not_found", "policy_not_found"),
        "409": errorResponse("Target entitlement is revoked (terminal).", "revoked_entitlement_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}": {
    get: {
      tags: ["admin:entitlements"],
      summary: "Get single entitlement by ID",
      operationId: "getEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      responses: {
        "200": okResponse("Entitlement record.", "#/components/schemas/EntitlementRecord", "entitlement"),
        "400": errorResponse("Malformed entitlement id.", "invalid_entitlement_id"),
        ...ADMIN_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
      },
    },
    patch: {
      tags: ["admin:entitlements"],
      summary: "Update entitlement fields (admin-only)",
      operationId: "patchEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/EntitlementPatch" } } },
      },
      responses: {
        "200": okResponse("Entitlement updated.", "#/components/schemas/EntitlementRecord", "entitlement_patched"),
        "400": errorResponse("Invalid request / json / id / idempotency key.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("Target entitlement is revoked (terminal).", "revoked_entitlement_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/disable": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Disable entitlement (admin-only, requires reason)",
      operationId: "disableEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse("Entitlement disabled.", "#/components/schemas/EntitlementRecord", "entitlement_disabled"),
        "400": errorResponse("Invalid request / json / id / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("Target entitlement is revoked (terminal).", "revoked_entitlement_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/reenable": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Re-enable entitlement (admin-only)",
      operationId: "reenableEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": okResponse("Entitlement re-enabled.", "#/components/schemas/EntitlementRecord", "entitlement_reenabled"),
        "400": errorResponse("Invalid request / json / id / idempotency key.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("Target entitlement is revoked (terminal).", "revoked_entitlement_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/revoke": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Revoke entitlement (admin-only, terminal state, requires reason)",
      operationId: "revokeEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse("Entitlement revoked (terminal).", "#/components/schemas/EntitlementRecord", "entitlement_revoked"),
        "400": errorResponse("Invalid request / json / id / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("Target entitlement is already revoked (terminal).", "revoked_entitlement_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/events": {
    get: {
      tags: ["admin:entitlements"],
      summary: "List entitlement audit events (most recent first)",
      operationId: "listEvents",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "limit", in: "query", required: false, description: "Page size (default 50, clamped to max 100).", schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
        formatCsvParam,
      ],
      responses: {
        "200": okResponse("Audit-event list (JSON), or a CSV attachment when ?format=csv.", "#/components/schemas/EventsListData", "events_listed"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/admin/entitlements/batch": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Bulk transition entitlements (admin-only): disable/reenable/revoke up to 100 ids, per-row results",
      operationId: "batchTransitionEntitlements",
      security: ADMIN_SECURITY,
      parameters: [idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/BatchTransitionInput" } } },
      },
      responses: {
        "200": okResponse(
          "Batch processed. Per-row {id, ok, code}; one bad row never aborts the others. Each row carries a DISTINCT idempotency sub-key so a re-POST with the same Idempotency-Key replays each row's own result (never row #1's).",
          "#/components/schemas/BatchResultData",
          "batch_done",
        ),
        "400": errorResponse("Invalid action/ids/json/idempotency key, more than 100 ids, or a missing reason for disable/revoke.", "invalid_request", "invalid_idempotency_key", "invalid_json", "too_many", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Dev bearer enabled outside development.", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/release-seats": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Force-release the LIVE seats stuck on a dead machine (admin-only, requires reason)",
      operationId: "releaseEntitlementSeats",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse(
          "Reclaimed the entitlement's LIVE seat_checkouts (heartbeat_deadline > now) and wrote a 'reclaim' usage_events row per seat. `released:0` is a valid idempotent success.",
          "#/components/schemas/ReleaseSeatsData",
          "seats_released",
        ),
        "400": errorResponse("Invalid request / json / id / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/devices": {
    get: {
      tags: ["admin:entitlements"],
      summary: "List the entitlement's registered relay-resistance device keys (reader+admin)",
      operationId: "listEntitlementDevices",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      responses: {
        "200": okResponse("The entitlement's device keys (newest-touched first, max 200).", "#/components/schemas/DevicesListData", "devices_listed"),
        "400": errorResponse("Malformed entitlement id.", "invalid_entitlement_id"),
        ...ADMIN_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
      },
    },
  },
  "/api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Revoke ONE device key (admin-only, terminal, requires reason). Bumps revocation_seq so the online-verify path refuses that device pre-TTL.",
      operationId: "revokeEntitlementDevice",
      security: ADMIN_SECURITY,
      parameters: [idParam, deviceKeyIdParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse("Device revoked; entitlement revocation_seq bumped.", "#/components/schemas/EntitlementRecord", "device_revoked"),
        "400": errorResponse("Invalid entitlement id / device key id / json / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_device_key_id", "invalid_idempotency_key", "invalid_json", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id, or no such device key.", "not_found", "device_not_found"),
        "409": errorResponse("Device is already revoked (terminal).", "device_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/devices/{deviceKeyId}/disable": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Disable ONE device key (admin-only, reversible, requires reason). Bumps revocation_seq.",
      operationId: "disableEntitlementDevice",
      security: ADMIN_SECURITY,
      parameters: [idParam, deviceKeyIdParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": okResponse("Device disabled; entitlement revocation_seq bumped.", "#/components/schemas/EntitlementRecord", "device_disabled"),
        "400": errorResponse("Invalid entitlement id / device key id / json / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_device_key_id", "invalid_idempotency_key", "invalid_json", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id, or no such device key.", "not_found", "device_not_found"),
        "409": errorResponse("Device is revoked (terminal); cannot disable.", "device_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable": {
    post: {
      tags: ["admin:entitlements"],
      summary: "Re-enable a disabled device key (admin-only). Bumps revocation_seq. Reason optional.",
      operationId: "reenableEntitlementDevice",
      security: ADMIN_SECURITY,
      parameters: [idParam, deviceKeyIdParam, idempotencyKeyHeader],
      responses: {
        "200": okResponse("Device re-enabled; entitlement revocation_seq bumped.", "#/components/schemas/EntitlementRecord", "device_reenabled"),
        "400": errorResponse("Invalid entitlement id / device key id / json / idempotency key.", "invalid_entitlement_id", "invalid_device_key_id", "invalid_idempotency_key", "invalid_json"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id, or no such device key.", "not_found", "device_not_found"),
        "409": errorResponse("Device is revoked (terminal); cannot re-enable.", "device_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  },
  "/api/admin/search": {
    get: {
      tags: ["admin:reports"],
      summary: "Global search across customers, licenses, entitlements, and orders (reader+admin)",
      operationId: "globalSearch",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "q", in: "query", required: true, description: "Search term (1..128 chars). Contains-match (escaped LIKE) on customers (id/email/name/external_ref), licenses (id/label), orders (subscription_id); PREFIX-match on the hex entitlement license_fingerprint.", schema: { type: "string", minLength: 1, maxLength: 128 } },
        { name: "limit", in: "query", required: false, description: "Per-type result cap (default 10, clamped to 10).", schema: { type: "integer", default: 10, minimum: 1, maximum: 10 } },
      ],
      responses: {
        "200": okResponse("Mixed-type search results for UI deep-linking.", "#/components/schemas/SearchData", "search_results"),
        "400": errorResponse("Empty or over-long q.", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  },
  "/api/sync/entitlements": {
    post: {
      tags: ["sync"],
      summary: "Sync entitlement from external system (creates or updates via idempotency)",
      operationId: "syncEntitlement",
      security: SYNC_SECURITY,
      parameters: [idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/EntitlementSyncInput" } } },
      },
      responses: {
        "200": okResponse("Entitlement synced (created or updated).", "#/components/schemas/EntitlementRecord", "entitlement_synced"),
        "400": errorResponse("Invalid request / json / idempotency key, or missing reason for a non-active status.", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        "401": errorResponse("Sync token not configured on the Worker.", "sync_auth_not_configured"),
        "403": errorResponse("Bearer token did not match SYNC_API_TOKEN.", "invalid_sync_token"),
        "404": errorResponse("Referenced resource not found.", "not_found"),
        "409": errorResponse("Target entitlement is revoked (terminal).", "revoked_entitlement_is_terminal"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed.", "mutation_failed"),
      },
    },
  },
};

// ── The document ────────────────────────────────────────────────────────────

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Cloudflare License Admin API",
    version: "0.1.0",
    description:
      "Operator back-office API for managing entitlements, customers, licenses, and orders. " +
      "All /api/admin/* routes require Cloudflare Access JWT (reader or admin RBAC); mutations require the admin role. " +
      "/api/sync/entitlements uses a separate bearer token (SYNC_API_TOKEN). " +
      "Every response is the flat envelope { ok, code, request_id, data? }.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "meta", description: "Spec + docs (unauthenticated)." },
    { name: "admin:reports", description: "Aggregate reads: summary, report, settings." },
    { name: "admin:customers", description: "Customer reads and kill-switch." },
    { name: "admin:licenses", description: "License reads." },
    { name: "admin:orders", description: "Order-event reads." },
    { name: "admin:entitlements", description: "Entitlement reads, mutations, and audit events." },
    { name: "admin:policies", description: "License-policy template CRUD (frozen stamp-time templates)." },
    { name: "admin:webhooks", description: "Webhook endpoint CRUD + delivery outbox status/redrive (signing secret lives only in the env, never D1)." },
    { name: "sync", description: "External-system entitlement sync (separate bearer token)." },
  ],
  security: ADMIN_SECURITY,
  paths,
  components: {
    securitySchemes: {
      cloudflareAccess: {
        type: "apiKey",
        in: "header",
        name: "cf-access-jwt-assertion",
        description:
          "Cloudflare Access JWT, verified against the configured issuer/audience/JWKS. The email claim is mapped to a role via ADMIN_ACCESS_ADMIN_EMAILS / ADMIN_ACCESS_READER_EMAILS. Reads allow reader or admin; mutations require admin.",
      },
      devBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "Development-only bearer token (ADMIN_DEV_BEARER, gated by ADMIN_DEV_BEARER_ENABLED). Grants the admin role. Returns 500 dev_bearer_forbidden_in_environment if enabled outside ENVIRONMENT=development. Not for production use.",
      },
      syncBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "Bearer token for /api/sync/entitlements, compared (timing-safe) against SYNC_API_TOKEN. Independent of Cloudflare Access; no reader/admin distinction.",
      },
    },
    schemas: {
      // ── Envelopes ──
      SuccessEnvelope: {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { const: true },
          code: { type: "string", description: "Machine-readable success code (endpoint-specific)." },
          request_id: { type: "string", description: "From cf-ray, else a generated UUID." },
          data: { description: "Endpoint-specific payload." },
        },
      },
      ErrorEnvelope: {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { const: false },
          code: { type: "string", description: "Machine-readable error code." },
          request_id: { type: "string" },
        },
      },

      // ── Request bodies ──
      EmptyBody: { type: "object", description: "Empty JSON object (`{}`). An empty request body is also accepted.", additionalProperties: false },
      ReasonRequiredBody: {
        type: "object",
        required: ["reason"],
        properties: {
          reason: { type: "string", maxLength: 1000, description: "Required audit reason. Must not contain newlines or NUL. Empty/missing returns 400 reason_required." },
        },
      },
      EntitlementInput: {
        type: "object",
        required: ["project", "feature", "license_fingerprint", "device_hash"],
        properties: {
          project: { type: "string", maxLength: 127 },
          feature: { type: "string", maxLength: 15 },
          license_fingerprint: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "64-char hex." },
          device_hash: { type: "string", description: "64-char hex, or empty string for unbound.", oneOf: [{ pattern: "^[0-9a-fA-F]{64}$" }, { const: "" }] },
          status: { type: "string", enum: ["active", "disabled", "revoked"], default: "active" },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600, default: 300 },
          valid_from: { type: ["integer", "null"], minimum: 0, default: null, description: "Epoch seconds; must be < valid_until when both set." },
          valid_until: { type: ["integer", "null"], minimum: 0, default: null, description: "Epoch seconds; must be > valid_from when both set." },
          notes: { type: "string", maxLength: 1000, default: "" },
          customer_id: { type: ["string", "null"], maxLength: 128, default: null },
          license_id: { type: ["string", "null"], maxLength: 128, default: null },
          policy_id: {
            type: "string",
            maxLength: 128,
            description:
              "Optional. When present (and non-empty), the entitlement is STAMPED from this policy template instead of validated directly. Requires POLICY_STAMP_MODE=on (else 400 policy_stamping_disabled); the policy must exist and be active (else 404 policy_not_found). Body fields above act as per-field overrides on the stamp.",
          },
        },
      },
      EntitlementPatch: {
        type: "object",
        description: "All fields optional; only provided fields are updated. project/feature/license_fingerprint/status are NOT patchable.",
        properties: {
          device_hash: { type: "string", description: "64-char hex, or empty string." },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
          valid_from: { type: ["integer", "null"], minimum: 0 },
          valid_until: { type: ["integer", "null"], minimum: 0 },
          notes: { type: "string", maxLength: 1000 },
          customer_id: { type: ["string", "null"], maxLength: 128 },
          license_id: { type: ["string", "null"], maxLength: 128 },
        },
      },
      EntitlementSyncInput: {
        allOf: [
          { $ref: "#/components/schemas/EntitlementInput" },
          { type: "object", properties: { reason: { type: "string", maxLength: 1000, description: "Optional; required (non-empty) when status is disabled or revoked." } } },
        ],
      },

      // ── Records ──
      EntitlementRecord: {
        type: "object",
        properties: {
          id: { type: "string", description: "Encoded entitlement id (project/feature/license_fingerprint)." },
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          device_hash: { type: "string" },
          status: { type: "string", enum: ["active", "disabled", "revoked"] },
          assertion_ttl_seconds: { type: "integer" },
          revocation_seq: { type: "integer" },
          valid_from: { type: ["integer", "null"] },
          valid_until: { type: ["integer", "null"] },
          notes: { type: "string" },
          customer_id: { type: ["string", "null"] },
          license_id: { type: ["string", "null"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          policy_id: { type: ["string", "null"], description: "Advisory provenance: the policy this row was stamped from (frozen; no live link)." },
          is_trial: { type: "integer", description: "1 when stamped from a trial policy, else 0. Frozen on the row." },
          trial_expiration_basis: { type: ["string", "null"], enum: ["from_issue", "from_first_activation", "from_first_use", null] },
          trial_duration_sec: { type: "integer" },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          trial_require_device_proof: { type: "integer", enum: [0, 1] },
          trial_started_at: { type: ["integer", "null"] },
          trial_device_hash: { type: ["string", "null"] },
        },
      },
      Policy: {
        type: "object",
        description: "A license-policy template (entitlement_policies row). Frozen at stamp time onto a new entitlement.",
        properties: {
          id: { type: "string" },
          project: { type: "string", maxLength: 127 },
          name: { type: "string", maxLength: 127 },
          type: { type: "string", enum: ["trial", "node_locked", "floating", "subscription"] },
          status: { type: "string", enum: ["active", "disabled"] },
          valid_from_offset_sec: { type: ["integer", "null"] },
          duration_sec: { type: ["integer", "null"] },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
          pool_size: { type: "integer", minimum: 0 },
          max_active_devices: { type: "integer", minimum: 0 },
          max_borrow_sec: { type: "integer", minimum: 0 },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"] },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"] },
          trial_duration_sec: { type: "integer", minimum: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          trial_require_device_proof: { type: "integer", enum: [0, 1] },
          notes: { type: "string", maxLength: 1000 },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      },
      PolicyInput: {
        type: "object",
        required: ["project", "name", "type"],
        description: "Create body. project/name/type required; every other field takes the column default.",
        properties: {
          project: { type: "string", maxLength: 127 },
          name: { type: "string", maxLength: 127, description: "Unique per project (case-insensitive). A duplicate returns 409 policy_name_conflict." },
          type: { type: "string", enum: ["trial", "node_locked", "floating", "subscription"] },
          valid_from_offset_sec: { type: ["integer", "null"], default: null },
          duration_sec: { type: ["integer", "null"], default: null },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600, default: 300 },
          pool_size: { type: "integer", minimum: 0, default: 0 },
          max_active_devices: { type: "integer", minimum: 0, default: 1 },
          max_borrow_sec: { type: "integer", minimum: 0, default: 0 },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"], default: "fixed_window" },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"], default: "from_issue" },
          trial_duration_sec: { type: "integer", minimum: 0, default: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1], default: 0 },
          trial_require_device_proof: { type: "integer", enum: [0, 1], default: 0 },
          notes: { type: "string", maxLength: 1000, default: "" },
        },
      },
      PolicyPatch: {
        type: "object",
        description: "All fields optional; only provided fields are updated. project/name/type/status are NOT patchable (status flips only via disable/reenable).",
        properties: {
          valid_from_offset_sec: { type: ["integer", "null"] },
          duration_sec: { type: ["integer", "null"] },
          assertion_ttl_seconds: { type: "integer", minimum: 1, maximum: 3600 },
          pool_size: { type: "integer", minimum: 0 },
          max_active_devices: { type: "integer", minimum: 0 },
          max_borrow_sec: { type: "integer", minimum: 0 },
          expiry_strategy: { type: "string", enum: ["fixed_window", "non_expiring"] },
          trial_expiration_basis: { type: "string", enum: ["from_issue", "from_first_activation", "from_first_use"] },
          trial_duration_sec: { type: "integer", minimum: 0 },
          trial_one_per_device: { type: "integer", enum: [0, 1] },
          trial_require_device_proof: { type: "integer", enum: [0, 1] },
          notes: { type: "string", maxLength: 1000 },
        },
      },
      WebhookEndpoint: {
        type: "object",
        description: "A webhook endpoint config row (webhook_endpoints). The signing secret is NEVER stored here — it lives only in the Worker-env WEBHOOK_SIGNING_SECRETS map.",
        properties: {
          id: { type: "string" },
          url: { type: "string", maxLength: 2048, description: "Delivery URL. Always https (a non-https URL is rejected at create/patch with 400 invalid_url)." },
          event_types: { type: "string", maxLength: 1024, description: "CSV event-type filter; empty string means all event types." },
          status: { type: "string", enum: ["active", "disabled"] },
          description: { type: "string", maxLength: 500 },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          scope_project: { type: ["string", "null"], maxLength: 128, description: "Per-tenant scope (audit R2.2). null/'' = global; matches entitlement/order events. Set one dimension, not both." },
          scope_customer_id: { type: ["string", "null"], maxLength: 128, description: "Per-tenant scope (audit R2.2). null/'' = global; matches customer events. Set one dimension, not both." },
        },
      },
      WebhookEndpointInput: {
        type: "object",
        required: ["url"],
        description: "Create body. `url` is required and MUST be https. event_types / description / scope_* take the column default ('').",
        properties: {
          url: { type: "string", maxLength: 2048, description: "https URL. A non-https or unparseable URL returns 400 invalid_url." },
          event_types: { type: "string", maxLength: 1024, default: "", description: "CSV event-type filter; '' = all." },
          description: { type: "string", maxLength: 500, default: "" },
          scope_project: { type: "string", maxLength: 128, default: "", description: "Per-tenant scope (audit R2.2). '' = global. Set one dimension, not both." },
          scope_customer_id: { type: "string", maxLength: 128, default: "", description: "Per-tenant scope (audit R2.2). '' = global. Set one dimension, not both." },
        },
      },
      WebhookEndpointPatch: {
        type: "object",
        description: "All fields optional; only provided fields are updated. status / id are NOT patchable (status flips only via disable/reenable).",
        properties: {
          url: { type: "string", maxLength: 2048, description: "https URL. A non-https URL returns 400 invalid_url." },
          event_types: { type: "string", maxLength: 1024 },
          description: { type: "string", maxLength: 500 },
          scope_project: { type: "string", maxLength: 128, description: "Per-tenant scope (audit R2.2). '' clears it (global)." },
          scope_customer_id: { type: "string", maxLength: 128, description: "Per-tenant scope (audit R2.2). '' clears it (global)." },
        },
      },
      WebhookDelivery: {
        type: "object",
        description: "A row in the webhook_deliveries outbox (drained by the backend cron). The payload body is not surfaced; only delivery metadata.",
        properties: {
          id: { type: "integer" },
          endpoint_id: { type: "string" },
          event_source: { type: "string", enum: ["entitlement", "customer", "order"] },
          event_id: { type: "integer" },
          event_type: { type: "string" },
          status: { type: "string", enum: ["pending", "delivered", "failed"] },
          attempts: { type: "integer" },
          last_status: { type: "integer", description: "HTTP status of the last attempt (0 if never attempted)." },
          last_error: { type: "string" },
          next_attempt_at: { type: "integer" },
          created_at: { type: "integer" },
          delivered_at: { type: ["integer", "null"] },
        },
      },
      CustomerRow: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          status: { type: "string", enum: ["active", "disabled"] },
          external_ref: { type: ["string", "null"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
        },
      },
      CustomerListItem: {
        allOf: [
          { $ref: "#/components/schemas/CustomerRow" },
          { type: "object", properties: { entitlement_count: { type: "integer" }, active_entitlement_count: { type: "integer" } } },
        ],
      },

      // ── data payloads (the `data` field of each success envelope) ──
      SummaryData: {
        type: "object",
        properties: {
          entitlements: {
            type: "object",
            properties: { total: { type: "integer" }, active: { type: "integer" }, revoked: { type: "integer" }, disabled: { type: "integer" } },
          },
        },
      },
      ReportData: {
        type: "object",
        properties: {
          generated_at: { type: "integer" },
          entitlements: { type: "object", properties: { total: { type: "integer" }, active: { type: "integer" }, revoked: { type: "integer" }, disabled: { type: "integer" } } },
          customers: { type: "object", properties: { total: { type: "integer" }, active: { type: "integer" }, disabled: { type: "integer" } } },
          account_tokens: { type: "object", properties: { active: { type: "integer" } } },
          licenses: { type: "object", properties: { total: { type: "integer" } } },
          fulfillment: {
            type: "object",
            properties: {
              accepted: { type: "integer" }, processed: { type: "integer" }, superseded: { type: "integer" }, rejected: { type: "integer" },
              stale_accepted: { type: "integer" }, events_24h: { type: "integer" }, events_7d: { type: "integer" },
            },
          },
          customer_suspensions_7d: { type: "integer" },
        },
      },
      SettingsData: {
        type: "object",
        properties: {
          environment: { type: "string" },
          public_verifier_url: { type: "string" },
          auth: { type: "string", enum: ["dev-bearer", "cloudflare-access"] },
        },
      },
      CustomersListData: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/CustomerListItem" } },
          next_cursor: { type: ["string", "null"] },
        },
      },
      CustomerDetailData: {
        type: "object",
        properties: {
          customer: {
            type: "object",
            properties: {
              id: { type: "string" }, name: { type: "string" }, email: { type: "string" }, status: { type: "string" },
              external_ref: { type: ["string", "null"] }, metadata_json: { type: ["string", "null"] },
              created_at: { type: "integer" }, updated_at: { type: "integer" },
            },
          },
          entitlements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                project: { type: "string" }, feature: { type: "string" }, license_fingerprint: { type: "string" }, status: { type: "string" },
                valid_from: { type: ["integer", "null"] }, valid_until: { type: ["integer", "null"] }, revocation_seq: { type: "integer" }, updated_at: { type: "integer" },
              },
            },
          },
          account_tokens: {
            type: "array",
            description: "token_hmac and pepper_key_id are deliberately never returned.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, token_prefix: { type: "string" }, name: { type: "string" }, status: { type: "string" },
                scopes_json: { type: ["string", "null"] }, expires_at: { type: ["integer", "null"] }, last_used_at: { type: ["integer", "null"] }, created_at: { type: "integer" },
              },
            },
          },
          licenses: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, project: { type: "string" }, label: { type: ["string", "null"] }, created_at: { type: "integer" }, updated_at: { type: "integer" } } },
          },
          orders: {
            type: "array",
            items: {
              type: "object",
              properties: {
                subscription_id: { type: "string" }, project: { type: "string" }, feature: { type: "string" }, license_fingerprint: { type: "string" },
                last_seq: { type: "integer" }, order_epoch: { type: "integer" }, updated_at: { type: "integer" },
              },
            },
          },
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" }, event_type: { type: "string" }, prev_status: { type: ["string", "null"] }, next_status: { type: ["string", "null"] },
                actor: { type: "string" }, actor_type: { type: "string" }, reason: { type: ["string", "null"] }, created_at: { type: "integer" },
              },
            },
          },
        },
      },
      LicensesListData: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, customer_id: { type: ["string", "null"] }, project: { type: "string" }, label: { type: ["string", "null"] }, created_at: { type: "integer" }, updated_at: { type: "integer" } } },
          },
          next_cursor: { type: ["string", "null"] },
        },
      },
      OrdersListData: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                event_id: { type: "string" }, subscription_id: { type: "string" }, project: { type: "string" }, feature: { type: "string" },
                order_epoch: { type: "integer" }, seq: { type: "integer" }, intent: { type: "string" }, key_id: { type: ["string", "null"] }, status: { type: "string" },
                received_at: { type: "integer" }, processed_at: { type: ["integer", "null"] }, stale: { type: "boolean" },
              },
            },
          },
          summary: {
            type: "object",
            properties: { accepted: { type: "integer" }, processed: { type: "integer" }, superseded: { type: "integer" }, rejected: { type: "integer" }, stale_accepted: { type: "integer" } },
          },
          stale_secs: { type: "integer" },
          next_cursor: { type: ["string", "null"] },
        },
      },
      EntitlementsListData: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/EntitlementRecord" } },
          next_cursor: { type: ["string", "null"] },
        },
      },
      PoliciesListData: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/Policy" } },
          next_cursor: { type: ["string", "null"] },
        },
      },
      WebhooksListData: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/WebhookEndpoint" } },
          next_cursor: { type: ["string", "null"] },
        },
      },
      WebhookDeliveriesListData: {
        type: "object",
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } },
          next_cursor: { type: ["string", "null"] },
        },
      },
      WebhookDetailData: {
        type: "object",
        properties: {
          endpoint: { $ref: "#/components/schemas/WebhookEndpoint" },
          deliveries: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" }, description: "The endpoint's 50 most-recent deliveries (newest first)." },
        },
      },
      EventsListData: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" }, project: { type: "string" }, feature: { type: "string" }, license_fingerprint: { type: "string" },
                event_type: { type: "string" }, status: { type: "string" }, revocation_seq: { type: "integer" }, actor: { type: "string" }, actor_type: { type: "string" },
                source: { type: "string" }, request_id: { type: "string" }, reason: { type: ["string", "null"] }, created_at: { type: "integer" },
              },
            },
          },
        },
      },
      BatchTransitionInput: {
        type: "object",
        required: ["action", "ids"],
        description: "Bulk transition body. `reason` is required (non-empty) for disable/revoke. `ids` is the encoded entitlement ids (1..100).",
        properties: {
          action: { type: "string", enum: ["disable", "reenable", "revoke"] },
          reason: { type: "string", maxLength: 1000, description: "Required (non-empty) for disable/revoke; ignored for reenable." },
          ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", description: "Encoded entitlement id." } },
        },
      },
      BatchResultData: {
        type: "object",
        properties: {
          results: {
            type: "array",
            description: "One entry per input id (in input order). `ok:false` rows carry a per-row failure code (not_found, revoked_entitlement_is_terminal, invalid_entitlement_id, mutation_failed).",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                ok: { type: "boolean" },
                code: { type: "string", description: "Per-row success or failure code." },
              },
            },
          },
        },
      },
      SearchData: {
        type: "object",
        properties: {
          results: {
            type: "array",
            description: "Mixed-type results across customers/licenses/entitlements/orders. `type` + `id` let the UI deep-link.",
            items: {
              type: "object",
              required: ["type", "id", "label"],
              properties: {
                type: { type: "string", enum: ["customer", "license", "entitlement", "order"] },
                id: { type: "string", description: "Deep-link key: customer id, license id, encoded entitlement id, or subscription id." },
                label: { type: "string" },
                project: { type: "string" },
                feature: { type: "string" },
                license_fingerprint: { type: "string" },
                email: { type: "string" },
                status: { type: "string" },
                external_ref: { type: ["string", "null"] },
                customer_id: { type: ["string", "null"] },
              },
            },
          },
        },
      },
      TimeseriesData: {
        type: "object",
        description:
          "Bucketed usage-analytics over [from,to). `buckets` is a dense, fixed-length array (zero-filled gaps); each bucket aggregates usage_events (by ts) + order_events (by received_at).",
        properties: {
          from: { type: "integer", description: "Window start (epoch seconds)." },
          to: { type: "integer", description: "Window end (epoch seconds, exclusive)." },
          bucket_seconds: { type: "integer", description: "Nominal bucket width; the last bucket absorbs any integer remainder of the span." },
          buckets: {
            type: "array",
            items: {
              type: "object",
              required: ["start", "checkouts", "releases", "denials", "denial_rate", "fulfillment_events"],
              properties: {
                start: { type: "integer", description: "Bucket start (epoch seconds)." },
                checkouts: { type: "integer", description: "usage_events event_type='checkout' in this bucket." },
                releases: { type: "integer", description: "usage_events event_type IN ('release','reclaim') in this bucket." },
                denials: { type: "integer", description: "usage_events event_type='denied' in this bucket." },
                denial_rate: { type: "number", description: "denials / (checkouts + denials); 0 when the bucket saw no attempts (the upsell signal)." },
                fulfillment_events: { type: "integer", description: "order_events received_at in this bucket." },
              },
            },
          },
        },
      },
      AuditChainData: {
        type: "object",
        properties: {
          audit_chain: {
            type: "object",
            required: ["ok", "checked"],
            properties: {
              ok: { type: "boolean", description: "True when the hash chain over entitlement_events verifies intact." },
              checked: { type: "integer", description: "Number of digest segments verified." },
              brokenAt: { type: "integer", description: "audit_digests.id of the segment that diverged (present when ok=false)." },
              reason: { type: "string", description: "prev_digest_mismatch | event_count_mismatch | digest_mismatch (present when ok=false)." },
            },
          },
        },
      },
      ExpiringData: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["project", "feature", "license_fingerprint", "valid_until", "days_left"],
              properties: {
                project: { type: "string" },
                feature: { type: "string" },
                license_fingerprint: { type: "string" },
                customer_id: { type: ["string", "null"] },
                valid_until: { type: "integer", description: "Epoch seconds the entitlement expires at." },
                days_left: { type: "integer", description: "ceil((valid_until - now)/86400); >=1 for a still-future expiry." },
              },
            },
          },
          next_cursor: { type: ["string", "null"] },
        },
      },
      ReleaseSeatsData: {
        type: "object",
        required: ["released", "seat_ids"],
        properties: {
          released: { type: "integer", description: "Count of LIVE seats reclaimed (0 is a valid idempotent success)." },
          seat_ids: { type: "array", items: { type: "string" }, description: "The reclaimed seat_ids (sorted)." },
        },
      },
      EntitlementDevice: {
        type: "object",
        description: "A registered relay-resistance device key (entitlement_devices). The public key is not surfaced here.",
        required: ["project", "feature", "license_fingerprint", "device_key_id", "status", "created_at", "updated_at"],
        properties: {
          project: { type: "string" },
          feature: { type: "string" },
          license_fingerprint: { type: "string" },
          device_key_id: { type: "string", description: "sha256:<64-hex>." },
          status: { type: "string", enum: ["active", "revoked", "disabled"] },
          created_at: { type: "integer" },
          updated_at: { type: "integer" },
          last_seen_at: { type: ["integer", "null"], description: "Last time this device presented a valid request proof (null if never)." },
          notes: { type: "string" },
        },
      },
      DevicesListData: {
        type: "object",
        required: ["items"],
        properties: {
          items: { type: "array", items: { $ref: "#/components/schemas/EntitlementDevice" }, description: "The entitlement's device keys, newest-touched first (max 200)." },
        },
      },
    },
  },
};

// Serialized once at module load — the /openapi.json route returns this verbatim.
export const openApiJson: string = JSON.stringify(openApiDocument);
