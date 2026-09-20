import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse } from "../components.js";

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
  description: "Validates browser binding and atomically consumes state before exchanging the code. Requires verified provider email. Stable provider subject identifies the account. A new identity registers an empty customer; existing email collisions require authenticated linking. Provider tokens are not persisted.",
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
    responses: { "200": jsonData("Provider availability.", {
      type: "object", required: ["google", "github", "email", "password"],
      properties: { password: { type: "boolean" }, google: { type: "boolean" }, github: { type: "boolean" }, email: { type: "boolean" } },
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
] };
