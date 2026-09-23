import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse } from "../components.js";

const body = (register: boolean) => ({ required: true, content: { "application/json": { schema: {
  type: "object", required: register ? ["email", "password"] : ["password"],
  properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 15, maxLength: 128 }, current_password: { type: "string", description: "Required for an existing password unless this is a recent OTP/OAuth session." } },
} } } });
// settings() (routes/password.ts) runs gate() -> authSession() -> the row lookup for BOTH verbs,
// then GET returns 200 immediately while POST alone goes on to readJson()/throttle()/the credential
// check/the batch write. Each verb gets its own map below so neither can claim a code its own
// handler path cannot emit.
const signedInResponse = { description: "Signed in with a rotated opaque HttpOnly session cookie. No password/hash is returned." };
const common = {
  "403": errorResponse("Origin mismatch.", "cross_site_forbidden"),
  "404": errorResponse("Password sign-in disabled.", "not_found"),
  "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
  "429": errorResponse("Per-IP or login-identifier limit reached.", "rate_limited"),
  "503": errorResponse("Session/database configuration unavailable.", "config_error"),
};
const settingsSharedResponses = {
  "403": common["403"],
  "404": common["404"],
  "503": common["503"],
};
const settingsGetResponses = {
  ...settingsSharedResponses,
  "200": { description: "Email login identifier, has_password, can_reset, and email_verified flags; no hash.", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { email: { type: "string" }, has_password: { type: "boolean" }, can_reset: { type: "boolean" }, email_verified: { type: "boolean" } } } } } } } },
  "401": errorResponse("Missing, invalid or expired session.", "unauthorized"),
};
const settingsPostResponses = {
  ...settingsSharedResponses,
  "200": signedInResponse,
  "400": errorResponse("Invalid JSON, email or password length.", ["invalid_json", "invalid_registration"]),
  "401": errorResponse("Invalid credentials or session.", ["invalid_credentials", "unauthorized"]),
  "403": errorResponse("Origin mismatch or fresh verified sign-in required.", ["cross_site_forbidden", "verified_sign_in_required"]),
  "409": errorResponse("Settings changed concurrently.", "password_change_conflict"),
  "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
  "429": errorResponse("Per-IP or login-identifier limit reached.", "rate_limited"),
};
const accepted = { description: "Generic verification_requested envelope, including ineligible addresses and delivery failures. No session or account is created.",
  content: { "application/json": { schema: { type: "object", required: ["ok", "code"], properties: { ok: { type: "boolean", const: true }, code: { type: "string", const: "verification_requested" } } } } } };
export const passwordPaths: LabeledPathFragment = { label: "password", entries: [
  ...(["register", "reset"] as const).map(action => [`/portal/v1/auth/password/${action}`, { post: {
    tags: ["auth"], operationId: action === "register" ? "authRegisterPassword" : "authResetPassword", summary: action === "register" ? "Request email verification before creating an account." : "Request password recovery at a verified email.", security: [],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } } },
    responses: { "202": accepted, "400": errorResponse("Invalid email or JSON.", ["invalid_email", "invalid_json"]), "403": common["403"], "404": common["404"], "413": common["413"], "429": common["429"], "503": errorResponse("Email or session configuration unavailable.", ["email_unconfigured", "config_error"]) },
    description: "Requires exact Origin, password enablement and an email sender. Links expire after 15 minutes. Registration never claims existing accounts; reset is restricted to active accounts whose credential email matches their verified contact address. Shared email send limit 1/60s, per-action email 10/900s, IP 5/900s for registration and 30/900s for reset. Resend uses the same endpoint.",
  } }] as [string, Record<string, unknown>]),
  ["/portal/v1/auth/password/complete", { post: {
    tags: ["auth"], operationId: "authCompletePassword", summary: "Redeem an email proof and set a password.", security: [],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["token", "password"], properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, password: { type: "string", minLength: 15, maxLength: 128 } } } } } },
    responses: { "200": { description: "Signed in with a rotated session cookie (code signed_in), or password_updated with sign_in_required when the credential changed but no session could be issued." }, "400": errorResponse("Expired, used or invalid link, or invalid password/JSON.", ["invalid_link", "invalid_registration", "invalid_json"]), ...common },
    description: "POST only; opening the email link does not consume it. Single-use atomic redemption creates an empty verified account or resets an existing credential. Reset revokes sessions, OTPs and ephemeral account tokens. Outstanding reset links become invalid after any password change. Token must be passed in JSON, never a query parameter. IP 10/900s and token 5/900s before hashing. A committed credential change always reports success, even when the follow-up session mint fails.",
  } }],
  ["/portal/v1/auth/password/login", { post: {
    tags: ["auth"], operationId: "authLoginPassword", summary: "Sign in using an email/password credential.", security: [], requestBody: body(true),
    responses: { "200": signedInResponse, "400": errorResponse("Invalid JSON.", "invalid_json"), "401": errorResponse("Invalid credentials.", "invalid_credentials"), ...common },
    description: "Requires exact Origin. Wrong password, unknown login and disabled customer return the same denial. Per-IP 30/900s and per-email 10/900s. Session creation atomically checks the verified password hash is still current.",
  } }],
  ["/portal/v1/auth/password", {
    get: { tags: ["auth"], operationId: "authPasswordSettings", summary: "Read this customer's password settings.", security: [{ sessionCookie: [] }], responses: settingsGetResponses },
    post: { tags: ["auth"], operationId: "authSetPassword", summary: "Set or change this customer's password.", security: [{ sessionCookie: [] }], requestBody: body(false), responses: settingsPostResponses,
      description: "Requires current password or an OTP/OAuth session created within ten minutes. First set requires a recent OTP/OAuth session and customer contact email. Atomic compare-and-swap revokes all old sessions, outstanding OTPs and ephemeral account tokens, then issues a new password-authenticated session.",
    },
  }],
] };
