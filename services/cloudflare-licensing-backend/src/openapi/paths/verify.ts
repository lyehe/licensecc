import type { LabeledPathFragment } from "../assemble.js";
import { ACCOUNT_TOKEN_AUTH_ERRORS, errorResponse, jsonBody, LEASE_SUCCESS, REPORT_SUCCESS, SEAT_SUCCESS, securityModeConfigErrorResponse } from "../components.js";

const verifyPath: Record<string, unknown> = {
  post: {
    tags: ["client"],
    summary:
      "Client-facing online license verification with optional ECDSA device proof. Rate-limited per client IP and per entitlement. Returns a signed RSA lccoa1 assertion or a denial.",
    operationId: "postVerify",
    security: [{ requestProof: [] }],
    description:
      "No account auth: the client presents a license fingerprint (and optionally an ECDSA request proof) and receives a signed lccoa1 assertion or a denial validated client-side by the C++ SDK. Request-signature mode (off/soft/required) governs proof acceptance. Body must be <= 4096 bytes.",
    requestBody: jsonBody("#/components/schemas/VerifyRequest"),
    responses: {
      "200": {
        description:
          "Assertion issued (ok:true, code:entitlement_ok) OR a soft denial (ok:false, code:entitlement_denied) -- both are HTTP 200.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/VerifySuccess" },
          },
        },
      },
      "400": errorResponse(
        "body_too_large (actual body over 4096 bytes), invalid_json (malformed JSON), or invalid_request (field validation failed).",
        "invalid_request",
      ),
      "401": errorResponse(
        "request_proof_required (required mode, proof missing), request_proof_stale (timestamp outside skew window), or request_proof_invalid (device unknown/disabled, invalid signature, malformed key, or replayed nonce).",
        "request_proof_invalid",
      ),
      "403": errorResponse(
        "entitlement_denied: not found, revoked, disabled, device mismatch, outside validity window, or rate limited.",
        "entitlement_denied",
      ),
      "413": errorResponse("body_too_large: Content-Length over 4096 bytes.", "body_too_large"),
      "429": errorResponse(
        "rate_limited. source: cloudflare-client | d1-client | d1-entitlement | d1-global.",
        "rate_limited",
      ),
      "503": securityModeConfigErrorResponse(),
      "500": errorResponse(
        "verification_error: D1 lookup failed, signing failed, or proof-nonce store unavailable.",
        "verification_error",
      ),
    },
  },
};

export const verifyPaths: LabeledPathFragment = {
  label: "verify",
  entries: [
    ["/v1/verify", verifyPath],
  ],
};
