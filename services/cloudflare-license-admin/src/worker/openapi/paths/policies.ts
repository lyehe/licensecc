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
  invalidPaginationResponse,
  limitCursorParams,
  okResponse,
  SYNC_SECURITY,
} from "../components.js";

export const policyPaths: LabeledPathFragment = {
  label: "policies",
  entries: [
    ["/api/admin/policies", {
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
        "400": invalidPaginationResponse(),
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
  }],
    ["/api/admin/policies/{id}", {
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
  }],
    ["/api/admin/policies/{id}/disable", {
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
  }],
    ["/api/admin/policies/{id}/reenable", {
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
  }],
  ],
};
