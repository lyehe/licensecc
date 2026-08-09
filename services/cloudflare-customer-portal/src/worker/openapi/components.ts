import type { LabeledComponentFragment } from "./assemble.js";

// ---- Reusable error responses ($ref into components.responses-style inline schemas) -------------
// Each error response is the FLAT envelope { ok:false, code, request_id }. We model the exact
// allowed code string(s) as a const or enum so the document cannot claim a different runtime code.

export function errorResponse(description: string, code: string | readonly string[]): Record<string, unknown> {
  const codeSchema = typeof code === "string" ? { const: code } : { enum: [...code] };
  return {
    description,
    content: {
      "application/json": {
        schema: {
          allOf: [{ $ref: "#/components/schemas/ErrorEnvelope" }],
          properties: { code: codeSchema },
        },
      },
    },
  };
}

// The standard cross-site / body-size / config errors shared by most state-changing routes.
export const ERR_CROSS_SITE = errorResponse("Cross-site request rejected (Sec-Fetch-Site not same-origin, or Origin does not match PORTAL_PUBLIC_ORIGIN).", "cross_site_forbidden");
export const ERR_BODY_TOO_LARGE = errorResponse("Request body exceeded 8192 bytes.", "body_too_large");
export const ERR_INVALID_JSON = errorResponse("Body was not a JSON object.", "invalid_json");

// Request body shared by the four lease/action routes + the data fields they accept.
export const LEASE_ACTION_REQUEST = {
  required: true,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/LeaseActionRequest" },
    },
  },
};

export const openApiComponents: LabeledComponentFragment = {
  label: "portal-components",
  namespaces: [
    ["securitySchemes", [
      ["sessionCookie", {
        type: "apiKey",
        in: "cookie",
        name: "lccp_session",
        description:
          "Opaque DB-backed session token (HMAC at rest, never a JWT). HttpOnly; Secure; " +
          "SameSite=Lax; Path=/; Max-Age=86400 (24h). Single-use revocation semantics; logout " +
          "marks the row revoked and bumps the per-customer account-token revocation floor.",
      }],
      ["bootstrapBearer", {
        type: "http",
        scheme: "bearer",
        description:
          "Operator break-glass bearer (PORTAL_BOOTSTRAP_BEARER), constant-time compared. When " +
          "the secret is unset the route returns 404 (no existence oracle). Optionally also " +
          "requires a Cloudflare Access JWT in the cf-access-jwt-assertion header when " +
          "PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1.",
      }],
      ["cfAccess", {
        type: "apiKey",
        in: "header",
        name: "cf-access-jwt-assertion",
        description:
          "Cloudflare Access JWT. Required on /portal/v1/admin/bootstrap-otp only when " +
          "PORTAL_BOOTSTRAP_REQUIRE_ACCESS=1; the audit row records cf-access-authenticated-user-email.",
      }],
    ]],
    ["schemas", [
      ["Envelope", {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { type: "boolean" },
          code: { type: "string", description: "Machine-readable result code for this response." },
          request_id: { type: "string", description: "cf-ray if present, else a generated UUID." },
          data: { description: "Endpoint-specific payload (omitted when the handler returns no data)." },
        },
      }],
      ["ErrorEnvelope", {
        type: "object",
        required: ["ok", "code", "request_id"],
        properties: {
          ok: { const: false },
          code: { type: "string", description: "Machine-readable error code." },
          request_id: { type: "string" },
        },
      }],
      ["LeaseActionRequest", {
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
      }],
      ["DownloadRequest", {
        type: "object",
        required: ["entitlement_id", "device_key_id"],
        properties: {
          entitlement_id: { type: "string", description: "Opaque entitlement id returned by /api/portal/entitlements." },
          device_key_id: { type: "string", description: "Device key id required by backend /v1/activate." },
        },
        additionalProperties: false,
      }],
    ]],
  ],
};
