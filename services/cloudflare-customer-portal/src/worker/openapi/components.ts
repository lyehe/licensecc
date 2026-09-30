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

// The response headers object for the seven auth 429s that carry the exact wait
// (portalRateLimit's own fixed-window retryAfter, in seconds) instead of leaving the customer to
// guess. Spread this into an errorResponse()'s result for exactly those routes -- every other 429
// (the signed-in password-change action, device consent/bindings' own fixed 60s header, and the
// operator break-glass bootstrap route) is unaffected and keeps its existing shape.
export const RETRY_AFTER_HEADER = {
  "retry-after": {
    description: "Seconds until portalRateLimit's current fixed window resets. The UI reads this to show \"Try again in {n} minutes.\"",
    schema: { type: "integer", minimum: 1 },
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
          "marks the row revoked.",
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
    ]],
  ],
};
