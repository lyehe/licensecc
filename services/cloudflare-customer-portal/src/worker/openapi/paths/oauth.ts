import type { LabeledPathFragment } from "../assemble.js";
import { ERR_BODY_TOO_LARGE, ERR_CROSS_SITE, errorResponse } from "../components.js";

const redirectResponse = {
  description: "No-store redirect to the provider or fixed portal origin. Callback errors use an allowlisted auth_error; credentials never appear in the final URL.",
  headers: { Location: { schema: { type: "string", format: "uri" } }, "Set-Cookie": { schema: { type: "string" }, description: "Secure HttpOnly SameSite=Lax browser binding or opaque session cookie." } },
};
const start = (provider: string): Record<string, unknown> => ({ post: {
  tags: ["auth"], operationId: `authStart${provider}`, summary: `Start ${provider} sign-in or explicit account linking.`,
  description: "Requires exact configured Origin. Authorization code with S256 PKCE, single-use D1 state and a browser-bound cookie. Link mode requires an active session at start and callback. No email-based automatic linking.",
  security: [{}, { sessionCookie: [] }],
  parameters: [{ name: "mode", in: "query", required: false, schema: { type: "string", enum: ["link"] } }],
  responses: { "303": redirectResponse, "400": errorResponse("Unknown mode.", "invalid_request"), "401": errorResponse("Linking requires a session.", "unauthorized"), "403": errorResponse("Origin mismatch.", "cross_site_forbidden"), "503": errorResponse("Session configuration unavailable.", "config_error") },
} });
const callback = (provider: string): Record<string, unknown> => ({ get: {
  tags: ["auth"], operationId: `authCallback${provider}`, summary: `Complete ${provider} sign-in.`, security: [],
  description: "Validates browser binding and atomically consumes state before exchanging the code. Requires verified provider email. Stable provider subject identifies the account. A new identity registers an empty customer; existing email collisions require authenticated linking (auth_error=account_link_required). An identity whose customer is suspended redirects with auth_error=account_suspended and no session. Provider tokens are not persisted.",
  parameters: [
    { name: "state", in: "query", required: true, schema: { type: "string" } },
    { name: "code", in: "query", required: false, schema: { type: "string" } },
    { name: "error", in: "query", required: false, schema: { type: "string" } },
  ], responses: { "303": redirectResponse, "503": errorResponse("Public origin unavailable.", "config_error") },
} });
const jsonData = (description: string, data: Record<string, unknown>): Record<string, unknown> => ({
  description, content: { "application/json": { schema: {
    type: "object", properties: { data },
  } } },
});
export const oauthPaths: LabeledPathFragment = { label: "oauth", entries: [
  ["/portal/v1/auth/providers", { get: {
    tags: ["auth"], operationId: "authProviders", summary: "List configured sign-in methods without exposing credentials.", security: [],
    responses: { "200": jsonData("Provider availability and the operator's support contact.", {
      type: "object", required: ["google", "github", "email", "password", "support"],
      properties: {
        password: { type: "boolean" }, google: { type: "boolean" }, github: { type: "boolean" }, email: { type: "boolean" },
        support: { type: ["string", "null"], description: "PORTAL_SUPPORT_CONTACT when it is a credential-free https: URL or a single mailto: address; otherwise null." },
      },
    }) },
  } }],
  ["/portal/v1/auth/google/start", start("Google")],
  ["/portal/v1/auth/github/start", start("GitHub")],
  ["/portal/v1/auth/google/callback", callback("Google")],
  ["/portal/v1/auth/github/callback", callback("GitHub")],
  ["/portal/v1/auth/identities", { get: {
    tags: ["auth"], operationId: "authIdentities", summary: "List this customer's linked providers.", security: [{ sessionCookie: [] }],
    responses: {
      "200": jsonData("Linked providers; no provider credentials.", {
        type: "object", properties: { items: { type: "array", items: {
          type: "object", properties: { provider: { type: "string", enum: ["google", "github"] }, email: { type: "string" }, created_at: { type: "integer" } },
        } } },
      }),
      "401": errorResponse("Session required.", "unauthorized"),
      "503": errorResponse("Session configuration unavailable.", "config_error"),
    },
  } }],
  ["/portal/v1/auth/identities/unlink", { post: {
    tags: ["auth"], operationId: "authUnlinkIdentity", summary: "Disconnect one of this customer's linked providers.", security: [{ sessionCookie: [] }],
    description: "Requires a session and a same-site request. Allowed only while another sign-in method is usable now: a password while password sign-in is enabled, the other provider's identity while that provider is configured, or a non-empty contact email while email codes are configured (the same predicates as GET /portal/v1/auth/providers). The rule and the delete are one conditional statement, so concurrent requests cannot remove the last method. The same transaction revokes the customer's other OAuth sessions; the current session and sessions from other sign-in methods are kept.",
    requestBody: { required: true, content: { "application/json": { schema: {
      type: "object", required: ["provider"], properties: { provider: { type: "string", enum: ["google", "github"] } },
    } } } },
    responses: {
      "200": { description: "The provider was disconnected and no longer appears in GET /portal/v1/auth/identities.", headers: { "Cache-Control": { description: "no-store", schema: { type: "string" } } },
        content: { "application/json": { schema: {
          allOf: [{ $ref: "#/components/schemas/Envelope" }],
          properties: { code: { const: "identity_unlinked" }, data: { type: "object", required: ["provider"], properties: { provider: { type: "string", enum: ["google", "github"] } } } },
        } } } },
      "400": errorResponse("Body was not a JSON object, or provider is not google or github.", ["invalid_json", "invalid_request"]),
      "401": errorResponse("Missing, invalid or expired session.", "unauthorized"),
      "403": ERR_CROSS_SITE,
      "404": errorResponse("This customer has no identity for that provider (absent and foreign identities look the same).", "not_found"),
      "409": errorResponse("No other sign-in method is usable now; nothing was changed.", "last_sign_in_method"),
      "413": ERR_BODY_TOO_LARGE,
      "503": errorResponse("Session or database configuration unavailable.", "config_error"),
    },
  } }],
] };
