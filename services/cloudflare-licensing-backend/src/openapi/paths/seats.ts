import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS, securityModeConfigErrorResponse } from "../components.js";

const checkoutPath: Record<string, unknown> = {
  post: {
    tags: ["seat"],
    summary:
      "Concurrent/floating seat checkout. Returns a short-TTL lccoa1 assertion. Live (heartbeat-gated) or borrowed (offline grace). Pool cap enforced atomically.",
    operationId: "postCheckout",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+checkout) or legacy LEASE_ISSUE_BEARER (off mode only). Optional ECDSA device proof binds the seat. Lazily reclaims lapsed seats on the hot path.",
    requestBody: jsonBody("#/components/schemas/SeatCheckoutRequest"),
    responses: {
      "200": {
        description: "Seat reserved (mode live or borrowed).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/SeatCheckoutSuccess" } },
        },
      },
      "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse(
        "forbidden_scope, no_active_entitlement, floating_disabled (pool_size <= 0), device_proof_required, device_proof_invalid, or borrowing_disabled (borrow_seconds present but max_borrow_sec <= 0).",
        "floating_disabled",
      ),
      "409": errorResponse(
        "pool_exhausted: concurrent seat count at/above pool_size + allow_overdraft.",
        "pool_exhausted",
      ),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 codes include seat_signing_unavailable and verification_error for D1 errors.",
        ["seat_signing_unavailable", "verification_error"],
      ),
    },
  },
};

const heartbeatPath: Record<string, unknown> = {

  post: {
    tags: ["seat"],
    summary:
      "Renew a live seat's heartbeat deadline within the entitlement's valid_until window. Returns an updated assertion. Fails if the seat was reclaimed.",
    operationId: "postHeartbeat",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+heartbeat) or legacy LEASE_ISSUE_BEARER (off mode only). seat_id is REQUIRED.",
    requestBody: jsonBody("#/components/schemas/SeatHeartbeatRequest"),
    responses: {
      "200": SEAT_SUCCESS,
      "400": errorResponse(
        "invalid_request: malformed JSON, missing seat_id, or other required fields.",
        "invalid_request",
      ),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse(
        "forbidden_scope or no_active_entitlement (not found, status!=active, or outside validity window).",
        "no_active_entitlement",
      ),
      "410": errorResponse(
        "seat_reclaimed: seat not found, revoked, or heartbeat deadline expired.",
        "seat_reclaimed",
      ),
      "500": errorResponse("seat_signing_error: crypto signing failed.", "seat_signing_error"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 codes include seat_signing_unavailable and verification_error for D1 errors.",
        ["seat_signing_unavailable", "verification_error"],
      ),
    },
  },
};

const releasePath: Record<string, unknown> = {
  post: {
    tags: ["seat"],
    summary:
      "Release a seat (mark heartbeat_deadline expired, record usage event). Idempotent: ok:true even if already reclaimed. Ownership-scoped in soft/required modes.",
    operationId: "postRelease",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+release) or legacy LEASE_ISSUE_BEARER (off mode only). seat_id is REQUIRED.",
    requestBody: jsonBody("#/components/schemas/SeatReleaseRequest"),
    responses: {
      "200": {
        description: "Seat released (idempotent).",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ReleaseSuccess" } },
        },
      },
      "400": errorResponse(
        "invalid_request: malformed JSON, missing seat_id, or other required fields.",
        "invalid_request",
      ),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse("forbidden_scope: token scopes do not allow release on project:feature.", "forbidden_scope"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 code is verification_error for D1 errors.",
        ["verification_error"],
      ),
    },
  },
};

export const seatPaths: LabeledPathFragment = {
  label: "seats",
  entries: [
    ["/v1/checkout", checkoutPath],
    ["/v1/heartbeat", heartbeatPath],
    ["/v1/release", releasePath],
  ],
};
