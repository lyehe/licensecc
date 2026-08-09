import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS } from "../components.js";

function leasePath(op: "activate" | "renew", summary: string): Record<string, unknown> {
  return {
    post: {
      tags: ["lease"],
      summary,
      operationId: `post${op[0].toUpperCase()}${op.slice(1)}`,
      security: [{ accountToken: [] }, { leaseBearer: [] }],
      description:
        "Authenticated by an account token (Authorization: Bearer lcca_..., scoped to project+feature+" +
        op +
        ") or the legacy LEASE_ISSUE_BEARER (off mode only). Optional ECDSA device proof binds the lease to a registered device key; device-rebind cap (max_active_devices) enforced atomically. Idempotent on request_id.",
      requestBody: jsonBody("#/components/schemas/LeaseRequest"),
      responses: {
        "200": LEASE_SUCCESS,
        "400": errorResponse("invalid_request: malformed JSON or missing required fields.", "invalid_request"),
        "401": ACCOUNT_TOKEN_AUTH_ERRORS["401"],
        "403": errorResponse(
          "forbidden_scope (token cannot " +
            op +
            " on project:feature), no_active_entitlement, expired_subscription, device_proof_required, device_proof_invalid, device_limit_exceeded, trial_device_proof_required (trial requires a verified device proof and none was presented), or trial_device_locked (trial is one-per-device and this device differs from the device that started the trial).",
          "no_active_entitlement",
        ),
        "500": errorResponse("lease_signing_error: crypto signing failed.", "lease_signing_error"),
        "503": errorResponse(
          "config_error (ACCOUNT_TOKEN_PEPPERS / LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM unavailable) or verification_error (D1 errors).",
          "verification_error",
        ),
      },
    },
  };
}

export const leasePaths: LabeledPathFragment = {
  label: "leases",
  entries: [
    ["/v1/activate", leasePath("activate", "Hardware-bound sliding-window lease issuance (v201).")],
    ["/v1/renew", leasePath("renew", "Hardware-bound lease renewal (v201). Same auth/validation/issuance as /v1/activate on an existing lease.")],
  ],
};
