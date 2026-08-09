import type { LabeledPathFragment } from "../assemble.js";
import { ERR_BODY_TOO_LARGE, ERR_CROSS_SITE, ERR_INVALID_JSON, errorResponse, LEASE_ACTION_REQUEST } from "../components.js";

// Backend action/download failures are wrapped in the portal envelope but deliberately retain the
// backend's status and machine code. These local transport/configuration alternatives apply before
// a backend response exists; operation-specific backend unions are declared beside each route.
const BACKEND_PROXY_TRANSPORT_ERRORS = errorResponse(
  "Backend was unreachable or its response was not valid JSON.",
  ["backend_unreachable", "backend_invalid_response"],
);
const BACKEND_PROXY_CONFIGURATION_ERRORS = errorResponse(
  "BACKEND_ORIGIN is absent or invalid (backend_unconfigured), portal token minting is misconfigured (config_error), or the backend returns config_error/verification_error.",
  ["backend_unconfigured", "config_error", "verification_error"],
);
const BACKEND_PROXY_SEAT_CONFIGURATION_ERRORS = errorResponse(
  "BACKEND_ORIGIN is absent or invalid (backend_unconfigured), portal token minting is misconfigured (config_error), or the backend cannot sign a seat assertion (seat_signing_unavailable) / verify its request.",
  ["backend_unconfigured", "config_error", "verification_error", "seat_signing_unavailable"],
);
const BACKEND_PROXY_LEASE_CONFIGURATION_ERRORS = errorResponse(
  "BACKEND_ORIGIN is absent or invalid (backend_unconfigured), portal token minting is misconfigured (config_error), or the backend cannot sign a lease (lease_signing_unavailable) / verify its request.",
  ["backend_unconfigured", "config_error", "verification_error", "lease_signing_unavailable"],
);

export const selfServicePaths: LabeledPathFragment = {
  label: "self-service",
  entries: [
    ["/api/portal/me", {
      get: {
        tags: ["portal"],
        operationId: "portalMe",
        summary: "Return the authenticated customer_id from the session.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "The session-scoped identity.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "me" },
                    data: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } },
                  },
                },
              },
            },
          },
          "401": errorResponse("No / invalid / expired / revoked session.", "unauthorized"),
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/api/portal/entitlements", {
      get: {
        tags: ["portal"],
        operationId: "portalEntitlements",
        summary: "List the customer's entitlements (read-only, customer_id bound).",
        description: "Ordered by project, feature.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "The customer's entitlements.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "entitlements" },
                    data: {
                      type: "object",
                      required: ["items"],
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              project: { type: "string" },
                              feature: { type: "string" },
                              license_fingerprint: { type: "string" },
                              status: { type: "string" },
                              valid_from: { type: ["integer", "null"] },
                              valid_until: { type: ["integer", "null"] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse("No / invalid / expired / revoked session.", "unauthorized"),
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/api/portal/devices", {
      get: {
        tags: ["portal"],
        operationId: "portalDevices",
        summary: "List the customer's devices (max 500) on owned entitlements.",
        description: "Ordered by created_at DESC. A device is visible only if it belongs to an entitlement the session customer owns.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "The customer's devices.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "devices" },
                    data: {
                      type: "object",
                      required: ["items"],
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              project: { type: "string" },
                              feature: { type: "string" },
                              license_fingerprint: { type: "string" },
                              device_key_id: { type: "string" },
                              created_at: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse("No / invalid / expired / revoked session.", "unauthorized"),
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/api/portal/devices/release", {
      post: {
        tags: ["portal"],
        operationId: "portalDeviceRelease",
        summary: "Self-serve device deactivation. Frees the slot a registered device holds.",
        description:
          "Resolves the device through the SAME ownership EXISTS as the devices listing (invariant 4 — a " +
          "foreign or absent device is the generic not_found, never a 403 oracle). Atomically bumps the " +
          "entitlement revocation_seq, flips the device out of 'active', and appends a portal_device_release " +
          "audit event with the session customer id. Re-releasing an already-released device is a 409.",
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["device_key_id"],
                properties: {
                  device_key_id: { type: "string", description: "The device key id shown on the Devices tab." },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The device was released and no longer appears on the Devices tab.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: { code: { const: "device_released" } },
                },
              },
            },
          },
          "400": ERR_INVALID_JSON,
          "401": errorResponse("No / invalid session.", "unauthorized"),
          "403": ERR_CROSS_SITE,

          "404": errorResponse("device_key_id not owned or absent (generic — no existence oracle).", "not_found"),
          "409": errorResponse("The device was already released / not active.", "device_status_conflict"),
          "413": ERR_BODY_TOO_LARGE,
          "429": errorResponse("Per-session release rate limit exceeded.", "rate_limited"),
          "500": errorResponse("The atomic device-release and audit transaction could not be completed.", "portal_error"),
        },
      },
    }],
    ["/api/portal/usage", {
      get: {
        tags: ["portal"],
        operationId: "portalUsage",
        summary: "Aggregate usage events by (project, feature, event_type) for owned entitlements.",
        description: "Grouped and counted; an event is included only if it belongs to an entitlement the customer owns.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": {
            description: "Aggregated usage counts.",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "usage" },
                    data: {
                      type: "object",
                      required: ["items"],
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              project: { type: "string" },
                              feature: { type: "string" },
                              event_type: { type: "string" },
                              count: { type: "integer" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": errorResponse("No / invalid / expired / revoked session.", "unauthorized"),
          "503": errorResponse("PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    }],
    ["/api/portal/checkout", {
      post: {
        tags: ["portal"],
        operationId: "portalCheckout",
        summary: "Seat checkout. Server-resolves the entitlement id, mints a 120s account token, proxies to backend /v1/checkout.",
        description:
          "Server-resolves entitlement_id -> project/feature/fingerprint from the customer's active entitlements " +
          "(invariant 4). Mints an ephemeral 120s session-scoped account token (never returned to the " +
          "browser), proxies to the backend, then wraps the backend response in a portal envelope.",
        security: [{ sessionCookie: [] }],
        requestBody: LEASE_ACTION_REQUEST,
        responses: {
          "200": {
            description: "Portal envelope with backend checkout response in data.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
          },
          "400": errorResponse("Body was not JSON (invalid_json), or portal/backend checkout validation rejected it (invalid_request).", ["invalid_json", "invalid_request"]),
          "401": errorResponse("No / invalid portal session (unauthorized), or the backend account token was rejected, revoked, or expired.", ["unauthorized", "token_revoked", "token_expired"]),
          "403": errorResponse("Cross-site request rejected, or backend checkout returned a documented policy denial.", ["cross_site_forbidden", "forbidden_scope", "no_active_entitlement", "floating_disabled", "device_proof_required", "device_proof_invalid", "borrowing_disabled"]),
          "404": errorResponse("entitlement_id not owned or not active (generic — no existence oracle).", "not_found"),
          "409": errorResponse("Backend checkout could not reserve a concurrent seat because the pool was exhausted.", "pool_exhausted"),
          "413": ERR_BODY_TOO_LARGE,
          "500": errorResponse("The portal failed unexpectedly, or backend checkout failed to sign/verify the seat response.", ["portal_error", "seat_signing_error", "verification_error"]),
          "502": BACKEND_PROXY_TRANSPORT_ERRORS,
          "503": BACKEND_PROXY_SEAT_CONFIGURATION_ERRORS,
        },
      },
    }],
    ["/api/portal/heartbeat", {
      post: {
        tags: ["portal"],
        operationId: "portalHeartbeat",
        summary: "Seat heartbeat. Same entitlement-id resolution, minting, and response wrapping as checkout.",
        security: [{ sessionCookie: [] }],
        requestBody: LEASE_ACTION_REQUEST,
        responses: {
          "200": {
            description: "Portal envelope with backend heartbeat response in data.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
          },
          "400": errorResponse("Body was not JSON (invalid_json), or portal/backend heartbeat validation rejected it (invalid_request).", ["invalid_json", "invalid_request"]),
          "401": errorResponse("No / invalid portal session (unauthorized), or the backend account token was rejected, revoked, or expired.", ["unauthorized", "token_revoked", "token_expired"]),
          "403": errorResponse("Cross-site request rejected, or backend heartbeat returned a documented policy denial.", ["cross_site_forbidden", "forbidden_scope", "no_active_entitlement"]),
          "404": errorResponse("entitlement_id not owned or not active.", "not_found"),
          "410": errorResponse("The backend seat was reclaimed, revoked, or reached its heartbeat deadline.", "seat_reclaimed"),
          "413": ERR_BODY_TOO_LARGE,
          "500": errorResponse("The portal failed unexpectedly, or backend heartbeat failed to sign/verify the seat response.", ["portal_error", "seat_signing_error", "verification_error"]),
          "502": BACKEND_PROXY_TRANSPORT_ERRORS,
          "503": BACKEND_PROXY_SEAT_CONFIGURATION_ERRORS,
        },
      },
    }],
    ["/api/portal/release", {
      post: {
        tags: ["portal"],
        operationId: "portalRelease",
        summary: "Seat release. Same entitlement-id resolution, minting, and response wrapping as checkout.",
        security: [{ sessionCookie: [] }],
        requestBody: LEASE_ACTION_REQUEST,
        responses: {
          "200": {
            description: "Portal envelope with backend release response in data.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } },
          },
          "400": errorResponse("Body was not JSON (invalid_json), or portal/backend release validation rejected it (invalid_request).", ["invalid_json", "invalid_request"]),
          "401": errorResponse("No / invalid portal session (unauthorized), or the backend account token was rejected, revoked, or expired.", ["unauthorized", "token_revoked", "token_expired"]),
          "403": errorResponse("Cross-site request rejected, or backend release denied the token scope.", ["cross_site_forbidden", "forbidden_scope"]),
          "404": errorResponse("entitlement_id not owned or not active.", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "500": errorResponse("The portal failed unexpectedly, or the backend returned its generic verification error.", ["portal_error", "verification_error"]),
          "502": BACKEND_PROXY_TRANSPORT_ERRORS,
          "503": BACKEND_PROXY_CONFIGURATION_ERRORS,
        },
      },
    }],
    ["/api/portal/download", {
      post: {
        tags: ["portal"],
        operationId: "portalDownload",
        summary: "Download the signed .lic file (application/octet-stream).",
        description:
          "Server-resolves entitlement_id, mints a 120s token, proxies to backend /v1/activate with " +
          "device_key_id, then converts the backend JSON lic field to an attachment. Strips upstream Authorization / Set-Cookie so the " +
          "ephemeral bearer never reaches the browser. The portal never parses or signs (invariant 1).",
        security: [{ sessionCookie: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/DownloadRequest" } } },
        },
        responses: {
          "200": {
            description: "Signed .lic file streamed from the backend.",
            headers: {
              "Content-Disposition": { description: 'attachment; filename="project-feature.lic"', schema: { type: "string" } },
              "Cache-Control": { description: "no-store", schema: { type: "string" } },
            },
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          "400": errorResponse("Body was not JSON (invalid_json), device_key_id was absent (device_key_required), or portal/backend activate validation rejected it (invalid_request).", ["invalid_json", "device_key_required", "invalid_request"]),
          "401": errorResponse("No / invalid portal session (unauthorized), or the backend account token was rejected, revoked, or expired.", ["unauthorized", "token_revoked", "token_expired"]),
          "403": errorResponse("Cross-site request rejected, or backend activate returned a documented entitlement/device policy denial.", ["cross_site_forbidden", "forbidden_scope", "no_active_entitlement", "expired_subscription", "device_proof_required", "device_proof_invalid", "device_limit_exceeded", "trial_device_proof_required", "trial_device_locked"]),
          "404": errorResponse("project/feature not owned or not active, or fingerprint unresolvable.", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "500": errorResponse("The portal failed unexpectedly, or backend activate failed to sign/verify the lease response.", ["portal_error", "lease_signing_error", "verification_error"]),
          "502": errorResponse("Backend /v1/activate was unreachable or returned invalid JSON.", ["backend_unreachable", "backend_invalid_response"]),
          "503": BACKEND_PROXY_LEASE_CONFIGURATION_ERRORS,
        },
      },
    }],
  ],
};
