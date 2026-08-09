import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS, securityModeConfigErrorResponse } from "../components.js";

// ---------------------------------------------------------------------------
// /v1/emergency/* break-glass overrides. Same request/response shapes as the underlying scoped
// handler, but gated ONLY by EMERGENCY_OPERATOR_BEARER (constant-time): unset/empty => 404, mismatch
// => 401. Dispatched with ACCOUNT_TOKEN_MODE forced to off (non-isolated operator authority).
// ---------------------------------------------------------------------------
function emergencyNotFound(): Record<string, unknown> {
  return errorResponse("not_found: EMERGENCY_OPERATOR_BEARER unset/empty (the route does not exist).", "not_found");
}
function emergencyUnauthorized(): Record<string, unknown> {
  return errorResponse("unauthorized: operator bearer mismatch.", "unauthorized");
}

function emergencyLease(op: "activate" | "renew"): Record<string, unknown> {
  return {
    post: {
      tags: ["emergency"],
      summary: `Break-glass emergency override for lease ${op}. Explicit non-isolated operator path. Logged at warn.`,
      operationId: `postEmergency${op[0].toUpperCase()}${op.slice(1)}`,
      security: [{ emergencyBearer: [] }],
      requestBody: jsonBody("#/components/schemas/LeaseRequest"),
      responses: {
        "200": LEASE_SUCCESS,
        "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
        "401": emergencyUnauthorized(),
        "403": errorResponse(
          "no_active_entitlement, expired_subscription, device_proof_required, device_proof_invalid, device_limit_exceeded, trial_device_proof_required, or trial_device_locked.",
          "no_active_entitlement",
        ),
        "404": emergencyNotFound(),
        "500": errorResponse("lease_signing_error: crypto signing failed.", "lease_signing_error"),
        "503": securityModeConfigErrorResponse(
          "Other route-specific 503 codes include verification_error and lease_signing_unavailable.",
          ["verification_error", "lease_signing_unavailable"],
        ),
      },
    },
  };
}

const emergencyCheckoutPath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for seat checkout. Explicit non-isolated operator path.",
    operationId: "postEmergencyCheckout",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/SeatCheckoutRequest"),
    responses: {
      "200": {
        description: "Seat reserved (mode live or borrowed).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/SeatCheckoutSuccess" } } },
      },
      "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "403": errorResponse(
        "no_active_entitlement, floating_disabled, device_proof_required, device_proof_invalid, or borrowing_disabled.",
        "no_active_entitlement",
      ),
      "404": emergencyNotFound(),
      "409": errorResponse("pool_exhausted: concurrent seat count at/above pool_size + allow_overdraft.", "pool_exhausted"),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 codes include verification_error and seat_signing_unavailable.",
        ["verification_error", "seat_signing_unavailable"],
      ),
    },
  },
};

const emergencyHeartbeatPath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for seat heartbeat. Explicit non-isolated operator path.",
    operationId: "postEmergencyHeartbeat",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/SeatHeartbeatRequest"),
    responses: {
      "200": SEAT_SUCCESS,
      "400": errorResponse("invalid_request: missing seat_id.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "403": errorResponse("no_active_entitlement.", "no_active_entitlement"),
      "404": emergencyNotFound(),
      "410": errorResponse("seat_reclaimed: seat not found, revoked, or heartbeat deadline expired.", "seat_reclaimed"),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 codes include verification_error and seat_signing_unavailable.",
        ["verification_error", "seat_signing_unavailable"],
      ),
    },
  },
};

const emergencyReleasePath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for seat release. Explicit non-isolated operator path.",
    operationId: "postEmergencyRelease",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/SeatReleaseRequest"),
    responses: {
      "200": {
        description: "Seat released (idempotent).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ReleaseSuccess" } } },
      },
      "400": errorResponse("invalid_request: missing seat_id.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "404": emergencyNotFound(),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 code is verification_error.",
        ["verification_error"],
      ),
    },
  },
};

const emergencyMeterPath: Record<string, unknown> = {
  post: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for metered consumption. Explicit non-isolated operator path.",
    operationId: "postEmergencyMeter",
    security: [{ emergencyBearer: [] }],
    requestBody: jsonBody("#/components/schemas/MeterRequest"),
    responses: {
      "200": {
        description: "Units recorded for the current period.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/MeterSuccess" } } },
      },
      "400": errorResponse("invalid_request or invalid_units.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "403": errorResponse("no_active_entitlement.", "no_active_entitlement"),
      "404": emergencyNotFound(),
      "429": errorResponse("quota_exceeded.", "quota_exceeded"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 code is verification_error.",
        ["verification_error"],
      ),
    },
  },
};

const emergencyReportPath: Record<string, unknown> = {
  get: {
    tags: ["emergency"],
    summary:
      "Break-glass emergency override for usage report. Non-isolated operator path, full access to all entitlements.",
    operationId: "getEmergencyAdminReport",
    security: [{ emergencyBearer: [] }],
    parameters: [
      { name: "project", in: "query", required: true, schema: { type: "string" } },
      { name: "feature", in: "query", required: true, schema: { type: "string" } },
      { name: "license_fingerprint", in: "query", required: true, schema: { type: "string" } },
      { name: "from", in: "query", required: false, schema: { type: "integer", default: 0 } },
      { name: "to", in: "query", required: false, schema: { type: "integer" } },
    ],
    responses: {
      "200": REPORT_SUCCESS,
      "400": errorResponse("invalid_request: missing query params.", "invalid_request"),
      "401": emergencyUnauthorized(),
      "404": emergencyNotFound(),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 code is verification_error.",
        ["verification_error"],
      ),
    },
  },
};

export const emergencyPaths: LabeledPathFragment = {
  label: "emergency",
  entries: [
    ["/v1/emergency/v1/activate", emergencyLease("activate")],
    ["/v1/emergency/v1/renew", emergencyLease("renew")],
    ["/v1/emergency/v1/checkout", emergencyCheckoutPath],
    ["/v1/emergency/v1/heartbeat", emergencyHeartbeatPath],
    ["/v1/emergency/v1/release", emergencyReleasePath],
    ["/v1/emergency/v1/meter", emergencyMeterPath],
    ["/v1/emergency/v1/admin/report", emergencyReportPath],
  ],
};
