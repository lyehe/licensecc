import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS, securityModeConfigErrorResponse } from "../components.js";

const reportPath: Record<string, unknown> = {
  get: {
    tags: ["report"],
    summary:
      "Generate a usage/analytics report from the usage_events log over a time window. truncated flag set if > 100000 rows. Scoped to the authenticated customer in soft/required modes.",
    operationId: "getAdminReport",
    security: [{ accountToken: [] }, { leaseBearer: [] }],
    description:
      "Authenticated by an account token (scoped to project+feature+report) or legacy LEASE_ISSUE_BEARER (off mode only). Aggregates peak_concurrent, unique_devices, denials, and rates.",
    parameters: [
      { name: "project", in: "query", required: true, schema: { type: "string" } },
      { name: "feature", in: "query", required: true, schema: { type: "string" } },
      { name: "license_fingerprint", in: "query", required: true, schema: { type: "string" } },
      { name: "from", in: "query", required: false, schema: { type: "integer", default: 0 }, description: "Unix seconds; default 0." },
      { name: "to", in: "query", required: false, schema: { type: "integer" }, description: "Unix seconds; default now." },
    ],
    responses: {
      "200": REPORT_SUCCESS,
      "400": errorResponse(
        "invalid_request: missing project, feature, or license_fingerprint query params.",
        "invalid_request",
      ),
      "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
      "403": errorResponse("forbidden_scope: token scopes do not allow report on project:feature.", "forbidden_scope"),
      "503": securityModeConfigErrorResponse(
        "Other route-specific 503 code is verification_error for D1 errors.",
        ["verification_error"],
      ),
    },
  },
};

export const reportPaths: LabeledPathFragment = {
  label: "reports",
  entries: [
    ["/v1/admin/report", reportPath],
  ],
};
