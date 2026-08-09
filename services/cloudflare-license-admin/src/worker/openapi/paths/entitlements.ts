import type { LabeledPathFragment } from "../assemble.js";
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
  limitCursorParams,
  okResponse,
  SYNC_SECURITY,
} from "../components.js";

export const entitlementPaths: LabeledPathFragment = {
  label: "entitlements",
  entries: [
    ["/api/admin/entitlements", {
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
  }],
    ["/api/admin/entitlements/{id}", {
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
  }],
    ["/api/admin/entitlements/{id}/disable", {
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
  }],
    ["/api/admin/entitlements/{id}/reenable", {
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
  }],
    ["/api/admin/entitlements/{id}/revoke", {
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
  }],
    ["/api/admin/events", {
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
  }],
    ["/api/admin/entitlements/batch", {
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
  }],
  ],
};
