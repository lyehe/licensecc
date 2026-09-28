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
  successResponse,
  transitionOkResponse,
} from "../components.js";
import { WEBHOOK_TEST_STATUS_CLASSES } from "@licensecc/cloudflare-runtime/webhooks/webhook_endpoint";

const webhookTestResult = {
  type: "object",
  additionalProperties: false,
  required: ["status_class"],
  properties: {
    status_class: {
      type: "string",
      enum: [...WEBHOOK_TEST_STATUS_CLASSES],
      description: "The class of the receiver's HTTP status (redirects are never followed), or network_error when it could not be reached or did not answer within 5 seconds. Nothing else from the receiver is returned.",
    },
  },
};

export const webhookPaths: LabeledPathFragment = {
  label: "webhooks",
  entries: [
    ["/api/admin/webhooks", {
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
        "400": invalidPaginationResponse(),
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
        "400": errorResponse("Invalid request / json / idempotency key, a URL that is not an https address on a public host name (no credentials, IP address, single-label or internal name, or trailing dot), or an event_types token outside the known entitlement/customer/order set (data.allowed lists the grouped allow-list).", "invalid_idempotency_key", "invalid_json", "invalid_request", "invalid_url", "invalid_event_types"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/webhooks/deliveries", {
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
        "400": errorResponse("Invalid status / endpoint_id filter or limit/cursor pagination bounds.", "invalid_request"),
        ...ADMIN_AUTH_ERRORS,
      },
    },
  }],
    ["/api/admin/webhooks/deliveries/{id}/redrive", {
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
        "200": transitionOkResponse("Delivery reset to pending (next_attempt_at = now).", "#/components/schemas/WebhookDelivery", { required: ["id", "next_attempt_at"], expectedStatus: "pending" }, "webhook_delivery_redriven"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No delivery with that id.", "not_found"),
        "409": errorResponse("Delivery is not in the 'failed' status (only failed deliveries can be redriven).", "webhook_delivery_not_failed"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/webhooks/{id}", {
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
        "400": errorResponse("Invalid request / json / idempotency key, a URL that is not an https address on a public host name (no credentials, IP address, single-label or internal name, or trailing dot; status/id are not patchable), or an event_types token outside the known entitlement/customer/order set (data.allowed lists the grouped allow-list).", "invalid_idempotency_key", "invalid_json", "invalid_request", "invalid_url", "invalid_event_types"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/webhooks/{id}/disable", {
    post: {
      tags: ["admin:webhooks"],
      summary: "Disable a webhook endpoint (admin-only; stops enqueue/delivery for it)",
      operationId: "disableWebhook",
      security: ADMIN_SECURITY,
      parameters: [idParam, idempotencyKeyHeader],
      requestBody: {
        required: true,
        description: "A non-empty audit reason is required; it is recorded in the webhook_events log.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReasonRequiredBody" } } },
      },
      responses: {
        "200": transitionOkResponse("Webhook endpoint disabled.", "#/components/schemas/WebhookEndpoint", { required: ["id"], expectedStatus: "disabled" }, "webhook_disabled"),
        "400": errorResponse("Invalid request / json / idempotency key, or missing reason.", "invalid_idempotency_key", "invalid_json", "invalid_request", "reason_required"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
        "409": errorResponse("Endpoint is not in the expected prior status (concurrent change).", "webhook_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/webhooks/{id}/reenable", {
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
        "200": transitionOkResponse("Webhook endpoint re-enabled.", "#/components/schemas/WebhookEndpoint", { required: ["id"], expectedStatus: "active" }, "webhook_reenabled"),
        "400": errorResponse("Invalid request / json / idempotency key.", "invalid_idempotency_key", "invalid_json", "invalid_request"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No webhook endpoint with that id.", "not_found"),
        "409": errorResponse("Endpoint is not in the expected prior status (concurrent change).", "webhook_status_conflict"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "500": errorResponse("Mutation failed, or dev bearer enabled outside development.", "mutation_failed", "dev_bearer_forbidden_in_environment"),
      },
    },
  }],
    ["/api/admin/webhooks/{id}/test", {
    post: {
      tags: ["admin:webhooks"],
      summary: "Send one signed test event to an active endpoint (admin-only)",
      description: "The licensing backend, which alone holds the webhook signing secret, re-checks the stored URL is https and POSTs {\"type\":\"test\",\"endpoint_id\",\"sent_at\"} signed exactly like a real delivery, with Licensecc-Event-Source: test and a fresh test- Licensecc-Webhook-Id. It never follows a redirect and waits at most 5 seconds. Only the status class is returned. One test per endpoint per 60 seconds. Not idempotent and not recorded as a delivery. Responses are no-store.",
      operationId: "sendWebhookTest",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      requestBody: {
        required: false,
        description: "Empty JSON object accepted; no body fields are read.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/EmptyBody" } } },
      },
      responses: {
        "200": successResponse("The test event was sent; data carries only the receiver's status class.", webhookTestResult, ["webhook_test_sent"]),
        "400": errorResponse("Invalid endpoint id or JSON body, or the stored endpoint URL is no longer an https address on a public host name (no credentials, IP address, single-label or internal name, or trailing dot).", "invalid_request", "invalid_json", "invalid_url"),
        ...ADMIN_MUTATION_AUTH_ERRORS,
        "404": errorResponse("No active webhook endpoint with that id (unknown or disabled); nothing was sent.", "not_found"),
        "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
        "429": {
          ...errorResponse("A test event was sent to this endpoint less than 60 seconds ago; data.retry_after gives the seconds to wait.", "rate_limited"),
          headers: { "retry-after": { description: "Seconds until this endpoint accepts another test (1-60).", schema: { type: "integer", minimum: 1, maximum: 60 } } },
        },
        "500": errorResponse("Dev bearer enabled outside development.", "dev_bearer_forbidden_in_environment"),
        "503": errorResponse("Nothing was sent: the WEBHOOK_OPERATOR backend capability is not bound, webhook signing is not configured on the backend, or the backend is unavailable.", "webhook_operator_not_configured", "webhook_signing_unconfigured", "temporarily_unavailable"),
      },
    },
  }],
  ],
};
