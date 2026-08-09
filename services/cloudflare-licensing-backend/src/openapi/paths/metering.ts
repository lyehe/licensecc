import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS, securityModeConfigErrorResponse } from "../components.js";

const meterPath: Record<string, unknown> = {
  post: {
    tags: ["report"],
    summary:
      "Report metered consumption against an entitlement for the current rolling period. Enforces meter_quota (429 quota_exceeded) only when the entitlement's meter_quota > 0; the default 0 counts only. Ownership-scoped in soft/required modes.",
    operationId: "postMeter",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+report) or legacy LEASE_ISSUE_BEARER (off mode only). units defaults to 1. A rejected over-quota increment records nothing (the counter never crosses the quota).",
    requestBody: jsonBody("#/components/schemas/MeterRequest"),
    responses: {
      "200": {
        description: "Units recorded for the current period.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/MeterSuccess" } } },
      },
      "400": errorResponse("invalid_request (missing project/feature/license_fingerprint) or invalid_units (units not a positive integer).", "invalid_request"),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse("forbidden_scope (token scopes disallow report on project:feature) or no_active_entitlement.", "no_active_entitlement"),
      "429": errorResponse("quota_exceeded: meter_quota > 0 and the increment would exceed it (nothing recorded).", "quota_exceeded"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 code is verification_error for D1 errors.",
        ["verification_error"],
      ),
    },
  },
};

export const meterPaths: LabeledPathFragment = {
  label: "metering",
  entries: [
    ["/v1/meter", meterPath],
  ],
};
