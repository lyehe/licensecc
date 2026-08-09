import type { LabeledPathFragment } from "../assemble.js";
import { ERR_BODY_TOO_LARGE, ERR_CROSS_SITE, ERR_INVALID_JSON, errorResponse, LEASE_ACTION_REQUEST } from "../components.js";

const ERR_INVALID_MAGIC_BODY = errorResponse("Body was not valid JSON or application/x-www-form-urlencoded.", ["invalid_json", "invalid_request"]);
const ERR_UNSUPPORTED_MEDIA_TYPE = errorResponse("Content-Type must be application/json or application/x-www-form-urlencoded.", "unsupported_media_type");

export const authPaths: LabeledPathFragment = {
  label: "auth",
  entries: [
    ["/portal/v1/auth/request", {
      post: {
        tags: ["auth"],
        operationId: "authRequestOtp",
        summary: "Request an OTP (numeric code + magic link) for an email.",
        description:
          "Always returns ok (no customer enumeration). Schedules the email via ctx.waitUntil when " +
          "configured. The secret is NEVER returned on this path (only via the operator bootstrap). " +
          "Always-on rate limiting (per-email 5/900s + per-IP 30/900s, fail-closed).",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: { email: { type: "string", format: "email" } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OTP requested (or a no-op for an unknown email — identical shape).",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: { code: { const: "otp_requested" } },
                },
              },
            },
          },
          "400": ERR_INVALID_JSON,
          "403": ERR_CROSS_SITE,
          "413": ERR_BODY_TOO_LARGE,
          "429": errorResponse("Rate limited (per-email 5/900s + per-IP 30/900s, fail-closed).", "rate_limited"),
          "503": errorResponse("PORTAL_OTP_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/portal/v1/auth/verify", {
      post: {
        tags: ["auth"],
        operationId: "authVerifyOtp",
        summary: "Redeem an 8-digit numeric code + email and mint an opaque session.",
        description:
          "Email-bound: a wrong code and an unknown OTP are byte-identical (invalid_otp, no oracle on " +
          "the reason). Single-use atomic claim (consumed_at). On success sets the lccp_session cookie.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "code"],
                properties: { email: { type: "string", format: "email" }, code: { type: "string", description: "8-digit numeric code." } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed in. Sets the lccp_session cookie.",
            headers: {
              "Set-Cookie": {
                description: "lccp_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "signed_in" },
                    data: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } },
                  },
                },
              },
            },
          },
          "400": ERR_INVALID_JSON,
          "401": errorResponse("Invalid OTP (wrong/consumed/expired/over-cap code), or unauthorized config_error from redeemOtp. Byte-identical for all failure reasons.", "invalid_otp"),
          "403": ERR_CROSS_SITE,
          "413": ERR_BODY_TOO_LARGE,
          "429": errorResponse("Rate limited (per-IP verify 30/900s).", "rate_limited"),
          "503": errorResponse("PORTAL_OTP_PEPPERS or PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/portal/v1/auth/magic", {
      get: {
        tags: ["auth"],
        operationId: "authMagicInterstitial",
        summary: "Magic-link interstitial (HTML). Renders a self-submitting form that POSTs the token to /magic-redeem.",
        description:
          "The magic-link secret arrives in ?token=<secret> but is NEVER consumed on this GET " +
          "(prevents referer/prefetch leaks — invariant 6). Returns an auto-submitting HTML form, " +
          "not JSON. Headers: referrer-policy: no-referrer; cache-control: no-store.",
        security: [],
        parameters: [
          {
            name: "token",
            in: "query",
            required: true,
            description: "Magic-link secret (base64url, 32 bytes). Echoed into a hidden form field on this origin only; never consumed here.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Auto-submitting interstitial HTML.",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    }],
    ["/portal/v1/auth/magic-redeem", {
      post: {
        tags: ["auth"],
        operationId: "authMagicRedeem",
        summary: "Redeem a magic-link token and mint an opaque session.",
        description:
          "Accepts the token either as JSON { token } or as application/x-www-form-urlencoded " +
          "token=<secret> (posted by the interstitial form). The request body is capped at 8192 " +
          "bytes before parsing; multipart and other media types are rejected. Email-independent; " +
          "single-use via an atomic UPDATE. On success sets the lccp_session cookie.",
        security: [],
        requestBody: {

          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: { token: { type: "string", description: "Magic-link secret (base64url, 32 bytes)." } },
                additionalProperties: false,
              },
            },
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["token"],
                properties: { token: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed in. Sets the lccp_session cookie.",
            headers: {
              "Set-Cookie": {
                description: "lccp_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "signed_in" },
                    data: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } },
                  },
                },
              },
            },
          },
          "400": ERR_INVALID_MAGIC_BODY,
          "401": errorResponse("Invalid OTP (wrong/consumed/expired/over-cap secret), or unauthorized config_error from redeemOtp.", "invalid_otp"),
          "403": ERR_CROSS_SITE,
          "413": ERR_BODY_TOO_LARGE,
          "415": ERR_UNSUPPORTED_MEDIA_TYPE,
          "429": errorResponse("Rate limited (per-IP verify 30/900s).", "rate_limited"),
          "503": errorResponse("PORTAL_OTP_PEPPERS or PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/portal/v1/auth/logout", {
      post: {
        tags: ["auth"],
        operationId: "authLogout",
        summary: "Revoke the session and clear the cookie (idempotent).",
        description:
          "No auth required (the session is optional — logout is idempotent). Marks the session row " +
          "revoked and bumps account_token_revocations.revocation_seq to kill any in-flight 120s " +
          "account token (invariant 9). Always clears the cookie (Max-Age=0).",
        security: [{ sessionCookie: [] }, {}],
        responses: {
          "200": {
            description: "Logged out. Clears the lccp_session cookie.",
            headers: {
              "Set-Cookie": {
                description: "lccp_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
                schema: { type: "string" },
              },
            },
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: { code: { const: "logged_out" } },
                },
              },
            },
          },
          "400": errorResponse("Body was not a JSON object (when Content-Type: application/json).", "invalid_json"),
          "403": ERR_CROSS_SITE,
          "413": ERR_BODY_TOO_LARGE,
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/portal/v1/admin/bootstrap-otp", {
      post: {
        tags: ["admin"],
        operationId: "adminBootstrapOtp",
        summary: "Operator break-glass: issue an OTP and return the secret directly (never emailed).",
        description:
          "The ONLY path that returns a secret. Gated by a constant-time bearer (PORTAL_BOOTSTRAP_BEARER; " +
          "unset -> 404, no existence oracle), an optional Cloudflare Access network gate " +
          "(PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1), always-on rate limiting, and an append-only audit row. " +
          "For an unknown email the secret is null (no enumeration).",
        security: [{ bootstrapBearer: [] }, { bootstrapBearer: [], cfAccess: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: { email: { type: "string", format: "email" } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OTP issued; secret returned once (null for an unknown email).",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "bootstrap_otp" },
                    data: {
                      type: "object",
                      required: ["secret"],
                      properties: { secret: { type: ["string", "null"], description: "The OTP secret, or null for an unknown email." } },
                    },
                  },
                },
              },
            },
          },
          "400": errorResponse("Body was not a JSON object (invalid_json) or email empty after trim/lower (invalid_request).", "invalid_request"),
          "401": errorResponse("Bearer missing or wrong (constant-time comparison).", "unauthorized"),
          "403": errorResponse("Cloudflare Access required (PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1 and cf-access-jwt-assertion missing) — access_required; or cross_site_forbidden.", "access_required"),
          "404": errorResponse("PORTAL_BOOTSTRAP_BEARER unset — the route does not exist (no existence oracle).", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "429": errorResponse("Rate limited (per-email 5/900s + per-IP 30/900s via requestOtp).", "rate_limited"),
          "503": errorResponse("PORTAL_OTP_PEPPERS unset.", "config_error"),
        },
      },
    }],
  ],
};
