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

export const devicePaths: LabeledPathFragment = {
  label: "devices",
  entries: [
    ["/api/admin/entitlements/{id}/release-seats", {
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
  }],
    ["/api/admin/entitlements/{id}/devices", {
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
  }],
    ["/api/admin/entitlements/{id}/meter", {
    get: {
      tags: ["admin:entitlements"],
      summary: "Read the entitlement's metering quota + current-period consumption (reader+admin, non-mutating)",
      operationId: "getEntitlementMeter",
      security: ADMIN_SECURITY,
      parameters: [idParam],
      responses: {
        "200": okResponse("Quota + the CURRENT rolling period's units_consumed, WITHOUT incrementing it.", "#/components/schemas/MeterStatusData", "meter_status"),
        "400": errorResponse("Malformed entitlement id.", "invalid_entitlement_id"),
        ...ADMIN_AUTH_ERRORS,
        "404": errorResponse("No entitlement with that id.", "not_found"),
      },
    },
  }],
    ["/api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke", {
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
  }],
    ["/api/admin/entitlements/{id}/devices/{deviceKeyId}/disable", {
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
  }],
    ["/api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable", {
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
  }],
  ],
};
