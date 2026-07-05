// OpenAPI 3.1 "doc-of-existing" for the Customer Portal Worker.
//
// This is a FAITHFUL description of the routes the Worker's fetch handler (src/worker/index.ts)
// actually serves — it is NOT a contract the handler is generated from. The build-time cross-check
// test (test/openapi.test.mjs) PINS this document to the source so the two cannot silently drift:
// every path here must have its literal route in index.ts, and every routed path index.ts declares
// must be present here.
//
// Envelope discipline (matches the rest of the portal): every JSON endpoint returns
// { ok, code, request_id, data? }. Signed-in routes additionally set the lccp_session cookie; the
// magic interstitial and the .lic download return non-JSON bodies (text/html and
// application/octet-stream respectively). Status codes and `code` strings are pulled verbatim from
// the handler source — none are invented.

// Minimal local typing for the slice of OpenAPI we emit. We deliberately avoid a dependency on an
// OpenAPI types package (the portal Worker is zero-runtime-dep); `as const`-friendly loose records
// keep tsc happy under the strict worker config without pulling schemas we don't author.
export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

// ---- Reusable error responses ($ref into components.responses-style inline schemas) -------------
// Each error response is the FLAT envelope { ok:false, code, request_id }. We model the discrete
// `code` value as an enum const so the doc states the exact string the handler returns.

function errorResponse(description: string, code: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [{ $ref: "#/components/schemas/ErrorEnvelope" }],
          properties: { code: { const: code } },
        },
      },
    },
  };
}

// The standard cross-site / body-size / config errors shared by most state-changing routes.
const ERR_CROSS_SITE = errorResponse("Cross-site request rejected (Sec-Fetch-Site not same-origin, or Origin does not match PORTAL_PUBLIC_ORIGIN).", "cross_site_forbidden");
const ERR_BODY_TOO_LARGE = errorResponse("Request body exceeded 8192 bytes.", "body_too_large");
const ERR_INVALID_JSON = errorResponse("Body was not a JSON object.", "invalid_json");

// Request body shared by the four lease/action routes + the data fields they accept.
const LEASE_ACTION_REQUEST = {
  required: true,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/LeaseActionRequest" },
    },
  },
};

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "licensecc Customer Portal Worker",
    version: "0.1.0",
    description:
      "Self-serve customer portal: email-OTP / magic-link sign-in, read-only session-scoped " +
      "entitlement/device/usage views, and per-action seat operations (checkout/heartbeat/" +
      "release/download) proxied to the licensing backend via an ephemeral, session-scoped " +
      "account token. Every authenticated route binds the session-derived customer_id; no " +
      "client-supplied customer_id or fingerprint reaches a mutation chokepoint. This document " +
      "describes the routes the Worker actually serves and is pinned to the source by a " +
      "build-time cross-check test.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "auth", description: "Public sign-in / sign-out (email OTP + magic link). No session required." },
    { name: "admin", description: "Operator break-glass OTP issuance (bearer-gated; unset -> 404)." },
    { name: "portal", description: "Session-scoped customer data + per-action seat operations. Requires the lccp_session cookie." },
    { name: "ops", description: "Health / operational endpoints." },
  ],
  components: {
    securitySchemes: {
      // The opaque, DB-backed session cookie (HMAC, never JWT). Set on sign-in, cleared on logout.
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "lccp_session",
        description:
          "Opaque DB-backed session token (HMAC at rest, never a JWT). HttpOnly; Secure; " +
          "SameSite=Lax; Path=/; Max-Age=86400 (24h). Single-use revocation semantics; logout " +
          "marks the row revoked and bumps the per-customer account-token revocation floor.",
      },
      // Break-glass operator bearer (constant-time compared; unset -> the route 404s).
      bootstrapBearer: {
        type: "http",
        scheme: "bearer",
        description:
          "Operator break-glass bearer (PORTAL_BOOTSTRAP_BEARER), constant-time compared. When " +
          "the secret is unset the route returns 404 (no existence oracle). Optionally also " +
          "requires a Cloudflare Access JWT in the cf-access-jwt-assertion header when " +
          "PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1.",
      },
      // Optional Cloudflare Access network gate in front of the bootstrap route.
      cfAccess: {
        type: "apiKey",
        in: "header",
        name: "cf-access-jwt-assertion",
        description:
          "Cloudflare Access JWT. Required on /portal/v1/admin/bootstrap-otp only when " +
          "PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1; the audit row records cf-access-authenticated-user-email.",
      },
    },
    schemas: {
      // Success envelope: { ok:true, code, request_id, data? }.
      Envelope: {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", description: "Machine-readable result code for this response." },
          request_id: { type: "string", description: "cf-ray if present, else a generated UUID." },
          data: { description: "Endpoint-specific payload (omitted when the handler returns no data)." },
        },
      },
      // Error envelope: { ok:false, code, request_id } (data omitted).
      ErrorEnvelope: {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { const: false },
          code: { type: "string", description: "Machine-readable error code." },
          request_id: { type: "string" },
        },
      },
      // Body shared by checkout / heartbeat / release. The fingerprint is NEVER client-supplied; the
      // handler server-resolves it from the session-owned entitlement id.
      LeaseActionRequest: {
        type: "object",
        required: ["entitlement_id", "client_instance_id", "nonce"],
        properties: {
          entitlement_id: { type: "string", description: "Opaque entitlement id returned by /api/portal/entitlements." },
          client_instance_id: { type: "string", description: "Client instance id forwarded to backend seat operations." },
          nonce: { type: "string", description: "Per-action nonce forwarded to backend seat operations." },
          seat_id: { type: "string", description: "Required for heartbeat and release." },
          device_key_id: { type: "string", description: "Optional device key id for proof-capable seat operations." },
        },
        additionalProperties: false,
      },
      // Body for /api/portal/download.
      DownloadRequest: {
        type: "object",
        required: ["entitlement_id", "device_key_id"],
        properties: {
          entitlement_id: { type: "string", description: "Opaque entitlement id returned by /api/portal/entitlements." },
          device_key_id: { type: "string", description: "Device key id required by backend /v1/activate." },
        },
        additionalProperties: false,
      },
    },
  },
  paths: {
    // ---------------------------------------------------------------------------------------------
    // Public auth
    // ---------------------------------------------------------------------------------------------
    "/portal/v1/auth/request": {
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
    },
    "/portal/v1/auth/verify": {
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
    },
    "/portal/v1/auth/magic": {
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
    },
    "/portal/v1/auth/magic-redeem": {
      post: {
        tags: ["auth"],
        operationId: "authMagicRedeem",
        summary: "Redeem a magic-link token and mint an opaque session.",
        description:
          "Accepts the token either as JSON { token } or as application/x-www-form-urlencoded " +
          "token=<secret> (posted by the interstitial form). Email-independent; single-use via an " +
          "atomic UPDATE. On success sets the lccp_session cookie.",
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
          "400": ERR_INVALID_JSON,
          "401": errorResponse("Invalid OTP (wrong/consumed/expired/over-cap secret), or unauthorized config_error from redeemOtp.", "invalid_otp"),
          "403": ERR_CROSS_SITE,
          "413": ERR_BODY_TOO_LARGE,
          "429": errorResponse("Rate limited (per-IP verify 30/900s).", "rate_limited"),
          "503": errorResponse("PORTAL_OTP_PEPPERS or PORTAL_SESSION_PEPPERS unset.", "config_error"),
        },
      },
    },
    "/portal/v1/auth/logout": {
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
    },
    // ---------------------------------------------------------------------------------------------
    // Operator break-glass
    // ---------------------------------------------------------------------------------------------
    "/portal/v1/admin/bootstrap-otp": {
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
    },
    // ---------------------------------------------------------------------------------------------
    // Session-scoped portal data + actions
    // ---------------------------------------------------------------------------------------------
    "/api/portal/me": {
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
    },
    "/api/portal/entitlements": {
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
    },
    "/api/portal/devices": {
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
    },
    "/api/portal/usage": {
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
    },
    "/api/portal/checkout": {
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
          "400": ERR_INVALID_JSON,
          "401": errorResponse("No / invalid session.", "unauthorized"),
          "403": ERR_CROSS_SITE,
          "404": errorResponse("entitlement_id not owned or not active (generic — no existence oracle).", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "502": errorResponse("Backend fetch threw.", "backend_unreachable"),
          "503": errorResponse("BACKEND_ORIGIN unset (backend_unconfigured), or ACCOUNT_TOKEN_PEPPERS unset / customer has no entitlements (config_error).", "config_error"),
        },
      },
    },
    "/api/portal/heartbeat": {
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
          "400": ERR_INVALID_JSON,
          "401": errorResponse("No / invalid session.", "unauthorized"),
          "403": ERR_CROSS_SITE,
          "404": errorResponse("entitlement_id not owned or not active.", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "502": errorResponse("Backend fetch threw.", "backend_unreachable"),
          "503": errorResponse("BACKEND_ORIGIN unset (backend_unconfigured) or config_error.", "config_error"),
        },
      },
    },
    "/api/portal/release": {
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
          "400": ERR_INVALID_JSON,
          "401": errorResponse("No / invalid session.", "unauthorized"),
          "403": ERR_CROSS_SITE,
          "404": errorResponse("entitlement_id not owned or not active.", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "502": errorResponse("Backend fetch threw.", "backend_unreachable"),
          "503": errorResponse("BACKEND_ORIGIN unset (backend_unconfigured) or config_error.", "config_error"),
        },
      },
    },
    "/api/portal/download": {
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
          "400": ERR_INVALID_JSON,
          "401": errorResponse("No / invalid session.", "unauthorized"),
          "403": ERR_CROSS_SITE,
          "404": errorResponse("project/feature not owned or not active, or fingerprint unresolvable.", "not_found"),
          "413": ERR_BODY_TOO_LARGE,
          "502": errorResponse("Backend /v1/activate fetch threw.", "backend_unreachable"),
          "503": errorResponse("BACKEND_ORIGIN unset (backend_unconfigured), or ACCOUNT_TOKEN_PEPPERS unset / customer has no entitlements (config_error).", "config_error"),
        },
      },
    },
    // ---------------------------------------------------------------------------------------------
    // Ops
    // ---------------------------------------------------------------------------------------------
    "/health": {
      get: {
        tags: ["ops"],
        operationId: "health",
        summary: "Health check. 200 only if ACCOUNT_TOKEN_MODE=required (backend account isolation enforced).",
        description: "Invariant 7: the portal is only healthy when the backend enforces full account isolation.",
        security: [],
        responses: {
          "200": {
            description: "Healthy (ACCOUNT_TOKEN_MODE=required).",
            content: {
              "application/json": {
                schema: {
                  allOf: [{ $ref: "#/components/schemas/Envelope" }],
                  properties: {
                    code: { const: "healthy" },
                    data: { type: "object", required: ["account_token_mode_required"], properties: { account_token_mode_required: { const: true } } },
                  },
                },
              },
            },
          },
          "503": errorResponse('ACCOUNT_TOKEN_MODE != "required" — the portal is not healthy because backend account isolation is not enforced.', "account_token_mode_not_required"),
        },
      },
    },
  },
};

// A self-contained docs page that fetches /openapi.json and renders a grouped, collapsible endpoint
// list. NO external CDN / no network dependency beyond the same-origin /openapi.json fetch.
export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>licensecc Customer Portal — API</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 0 1rem 4rem; max-width: 960px; margin-inline: auto; }
  h1 { font-size: 1.5rem; margin: 1.5rem 0 .25rem; }
  .sub { color: #777; margin: 0 0 1.5rem; }
  h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .05em; color: #888; border-bottom: 1px solid #8884; padding-bottom: .25rem; margin: 2rem 0 .75rem; }
  details { border: 1px solid #8884; border-radius: 6px; margin: .5rem 0; padding: .25rem .75rem; }
  details[open] { background: #8881; }
  summary { cursor: pointer; display: flex; align-items: center; gap: .75rem; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  .method { font-weight: 700; font-size: .75rem; padding: .15rem .5rem; border-radius: 4px; min-width: 3.5rem; text-align: center; color: #fff; }
  .method.get { background: #2563eb; }
  .method.post { background: #16a34a; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .summary-text { color: #666; flex: 1; }
  .desc { margin: .5rem 0; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { color: #888; font-weight: 600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #8882; padding: .1rem .3rem; border-radius: 3px; }
  .sec { font-size: .8rem; color: #888; }
  .err { color: #b91c1c; }
  .err.ok { color: #16a34a; }
  #err { color: #b91c1c; padding: 1rem; }
</style>
</head>
<body>
<h1 id="title">API</h1>
<p class="sub" id="subtitle"></p>
<div id="err" hidden></div>
<div id="groups"></div>
<script>
(async function () {
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === "text") n.textContent = attrs[k]; else if (k === "html") n.innerHTML = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var spec;
  try {
    var res = await fetch("/openapi.json", { headers: { accept: "application/json" } });
    spec = await res.json();
  } catch (e) {
    var box = document.getElementById("err");
    box.hidden = false;
    box.textContent = "Failed to load /openapi.json: " + e;
    return;
  }
  document.getElementById("title").textContent = (spec.info && spec.info.title) || "API";
  document.getElementById("subtitle").textContent =
    "v" + ((spec.info && spec.info.version) || "?") + " — OpenAPI " + (spec.openapi || "");

  // Group operations by their first tag (fallback "other").
  var groups = {};
  var order = [];
  var paths = spec.paths || {};
  Object.keys(paths).forEach(function (p) {
    var item = paths[p];
    ["get", "post", "put", "patch", "delete"].forEach(function (m) {
      var op = item[m];
      if (!op) return;
      var tag = (op.tags && op.tags[0]) || "other";
      if (!groups[tag]) { groups[tag] = []; order.push(tag); }
      groups[tag].push({ method: m, path: p, op: op });
    });
  });

  var container = document.getElementById("groups");
  order.forEach(function (tag) {
    container.appendChild(el("h2", { text: tag }));
    groups[tag].forEach(function (entry) {
      var op = entry.op;
      var summary = el("summary", null, [
        el("span", { class: "method " + entry.method, text: entry.method.toUpperCase() }),
        el("span", { class: "path", text: entry.path }),
        el("span", { class: "summary-text", text: op.summary || "" }),
      ]);
      var details = el("details", null, [summary]);

      if (op.description) details.appendChild(el("p", { class: "desc", text: op.description }));

      // Security.
      var secNames = (op.security || []).map(function (s) { return Object.keys(s).join("+") || "public"; });
      details.appendChild(el("p", { class: "sec", text: "Security: " + (secNames.length ? secNames.join(" OR ") : "public") }));

      // Parameters.
      if (op.parameters && op.parameters.length) {
        var ptable = el("table", null, [el("tr", null, [el("th", { text: "param" }), el("th", { text: "in" }), el("th", { text: "required" }), el("th", { text: "description" })])]);
        op.parameters.forEach(function (pp) {
          ptable.appendChild(el("tr", null, [
            el("td", null, [el("code", { text: pp.name })]),
            el("td", { text: pp.in || "" }),
            el("td", { text: pp.required ? "yes" : "no" }),
            el("td", { text: pp.description || "" }),
          ]));
        });
        details.appendChild(el("p", { class: "desc", text: "Parameters" }));
        details.appendChild(ptable);
      }

      // Request body content types.
      if (op.requestBody && op.requestBody.content) {
        details.appendChild(el("p", { class: "desc", text: "Request body: " + Object.keys(op.requestBody.content).join(", ") }));
      }

      // Responses.
      var rtable = el("table", null, [el("tr", null, [el("th", { text: "status" }), el("th", { text: "description" })])]);
      var responses = op.responses || {};
      Object.keys(responses).forEach(function (code) {
        var ok = code[0] === "2";
        rtable.appendChild(el("tr", null, [
          el("td", null, [el("span", { class: "err" + (ok ? " ok" : ""), text: code })]),
          el("td", { text: (responses[code] && responses[code].description) || "" }),
        ]));
      });
      details.appendChild(el("p", { class: "desc", text: "Responses" }));
      details.appendChild(rtable);

      container.appendChild(details);
    });
  });
})();
</script>
</body>
</html>`;
