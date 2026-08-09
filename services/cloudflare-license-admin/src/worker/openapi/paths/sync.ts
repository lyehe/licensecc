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

export const syncPaths: LabeledPathFragment = {
  label: "sync",
  entries: [
    ["/api/sync/entitlements", {
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
        "409": errorResponse("Target entitlement is revoked (terminal), or it changed after this request observed it; refetch and retry the latter.", "revoked_entitlement_is_terminal", "stale_transition"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed.", "mutation_failed"),
      },
    },
  }],
  ],
};
