import type { LabeledPathFragment } from "../assemble.js";
import {
  ENTITLEMENT_BATCH_MAX_IDS,
  ENTITLEMENT_BATCH_TOO_LARGE_CODE,
} from "../../../shared/api.js";
import { LIMIT_ONLY_PAGINATION_OPTIONS } from "../../query.js";
import {
  ADMIN_AUTH_ERRORS,
  ADMIN_MUTATION_AUTH_ERRORS,
  ADMIN_SECURITY,
  csvExportResponse,
  deviceKeyIdParam,
  entitlementBatchTooLargeResponse,
  errorResponse,
  featureKeyParam,
  formatCsvParam,
  idempotencyKeyHeader,
  idParam,
  invalidPaginationResponse,
  limitCursorParams,
  okResponse,
  SYNC_SECURITY,
  transitionOkResponse,
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
        "400": invalidPaginationResponse(),
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
        "409": errorResponse("Target entitlement is revoked (terminal), or it changed after this request observed it; refetch and retry the latter.", "revoked_entitlement_is_terminal", "stale_transition"),
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
        "409": errorResponse("Target entitlement is revoked (terminal), or it changed after this request observed it; refetch and retry the latter.", "revoked_entitlement_is_terminal", "stale_transition"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/entitlements/{id}/disable", {
    post: {
      tags: ["admin:entitlements"],
      summary: "Disable entitlement (admin-only, requires reason). An already-disabled entitlement is a successful no-op; a revoked source entitlement is terminal.",
      operationId: "disableEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": transitionOkResponse("Entitlement is disabled. Returns the authoritative current record: status and revocation_seq change only from active; an already-disabled entitlement is returned unchanged.", "#/components/schemas/EntitlementRecord", { required: ["id", "revocation_seq"], expectedStatus: "disabled" }, "entitlement_disabled"),
        "400": errorResponse("Invalid request / json / id / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("The source entitlement is revoked (terminal), so it cannot be disabled, or a different concurrent transition changed it after this request observed it; refetch and retry the latter.", "revoked_entitlement_is_terminal", "stale_transition"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/entitlements/{id}/reenable", {
    post: {
      tags: ["admin:entitlements"],
      summary: "Re-enable entitlement (admin-only). An already-active entitlement is a successful no-op; a revoked source entitlement is terminal.",
      operationId: "reenableEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": transitionOkResponse("Entitlement is active. Returns the authoritative current record: status and revocation_seq change only from disabled; an already-active entitlement is returned unchanged.", "#/components/schemas/EntitlementRecord", { required: ["id", "revocation_seq"], expectedStatus: "active" }, "entitlement_reenabled"),
        "400": errorResponse("Invalid request / json / id / idempotency key.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("The source entitlement is revoked (terminal), so it cannot be re-enabled, or a different concurrent transition changed it after this request observed it; refetch and retry the latter.", "revoked_entitlement_is_terminal", "stale_transition"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/entitlements/{id}/revoke", {
    post: {
      tags: ["admin:entitlements"],
      summary: "Revoke entitlement (admin-only, terminal state, requires reason). An already-revoked entitlement is a successful no-op.",
      operationId: "revokeEntitlement",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": transitionOkResponse("Entitlement is revoked. Returns the authoritative current record: status and revocation_seq change only from active or disabled; an already-revoked entitlement is returned unchanged.", "#/components/schemas/EntitlementRecord", { required: ["id", "revocation_seq"], expectedStatus: "revoked" }, "entitlement_revoked"),
        "400": errorResponse("Invalid request / json / id / idempotency key, or missing reason.", "invalid_entitlement_id", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
        "409": errorResponse("A different concurrent transition changed the entitlement after this request observed it; refetch and retry. An already-revoked entitlement remains a 200 no-op.", "stale_transition"),
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
        ...limitCursorParams(LIMIT_ONLY_PAGINATION_OPTIONS),
        formatCsvParam,
      ],
      responses: {
        "200": okResponse("Audit-event list (JSON), or a CSV attachment when ?format=csv.", "#/components/schemas/EventsListData", "events_listed"),
        "400": invalidPaginationResponse(LIMIT_ONLY_PAGINATION_OPTIONS),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/entitlements/batch", {
    post: {
      tags: ["admin:entitlements"],
      summary: `Bulk transition entitlements (admin-only): disable/reenable/revoke up to ${ENTITLEMENT_BATCH_MAX_IDS} ids, per-row results`,
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
        "400": entitlementBatchTooLargeResponse(
          "Invalid action/ids/json/idempotency key or a missing reason for disable/revoke. More than four ids is rejected before any D1 query or mutation; split the request using the response data guidance.",
          "invalid_request",
          "invalid_idempotency_key",
          "invalid_json",
          "reason_required",
          ENTITLEMENT_BATCH_TOO_LARGE_CODE,
        ),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Dev bearer enabled outside development.", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
  ],
};
