import type { LabeledPathFragment } from "../assemble.js";
import { SEARCH_PAGINATION_OPTIONS } from "../../query.js";
import {
  ADMIN_AUTH_ERRORS,
  ADMIN_MUTATION_AUTH_ERRORS,
  ADMIN_SECURITY,
  csvExportResponse,
  deviceKeyIdParam,
  errorResponse,
  featureKeyParam,
  formatCsvParam,
  idempotencyKeyHeader,
  idParam,
  invalidPaginationResponse,
  limitCursorParams,
  okResponse,
  paginationErrorDescription,
  SYNC_SECURITY,
  transitionOkResponse,
} from "../components.js";

export const customerPaths: LabeledPathFragment = {
  label: "customers",
  entries: [
    ["/api/admin/customers", {
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
        "400": errorResponse("Invalid query parameter, including limit/cursor pagination bounds (e.g. over-long search term).", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/customers/{id}", {
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
  }],
    ["/api/admin/customers/{id}/disable", {
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
        "200": transitionOkResponse("Customer disabled.", "#/components/schemas/CustomerRow", { required: ["id"], expectedStatus: "disabled" }, "customer_disabled"),
        "400": errorResponse("Invalid request / json / idempotency key, or missing reason.", "invalid_request", "invalid_idempotency_key", "invalid_json", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No customer with that id.", "not_found"),
        "409": errorResponse("Customer is not in the expected prior status (concurrent change).", "customer_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/customers/{id}/reenable", {
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
        "200": transitionOkResponse("Customer re-enabled.", "#/components/schemas/CustomerRow", { required: ["id"], expectedStatus: "active" }, "customer_reenabled"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No customer with that id.", "not_found"),
        "409": errorResponse("Customer is not in the expected prior status (concurrent change).", "customer_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/licenses", {
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
        "400": errorResponse("Invalid query parameter, including limit/cursor pagination bounds (e.g. over-long search term).", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/orders", {
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
        "400": invalidPaginationResponse(),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
  ],
};

export const searchPaths: LabeledPathFragment = {
  label: "customers-search",
  entries: [
    ["/api/admin/search", {
    get: {
      tags: ["admin:reports"],
      summary: "Global search across customers, licenses, entitlements, and orders (reader+admin)",
      operationId: "globalSearch",
      security: ADMIN_SECURITY,
      parameters: [
        { name: "q", in: "query", required: true, description: "Search term (1..128 chars). Contains-match (escaped LIKE) on customers (id/email/name/external_ref), licenses (id/label), orders (subscription_id); PREFIX-match on the hex entitlement license_fingerprint.", schema: { type: "string", minLength: 1, maxLength: 128 } },
        ...limitCursorParams(SEARCH_PAGINATION_OPTIONS),
      ],
      responses: {
        "200": okResponse("Mixed-type search results for UI deep-linking.", "#/components/schemas/SearchData", "search_results"),
        "400": errorResponse(`Empty or over-long q, or ${paginationErrorDescription(SEARCH_PAGINATION_OPTIONS)}`, "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
  ],
};
