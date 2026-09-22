import type { LabeledPathFragment } from "../assemble.js";
import { errorResponse } from "../components.js";

const body = (register: boolean) => ({ required: true, content: { "application/json": { schema: {
  type: "object", required: register ? ["email", "password"] : ["password"],
  properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 15, maxLength: 128 }, current_password: { type: "string", description: "Required for an existing password unless this is a recent OTP/OAuth session." } },
} } } });
const responses = {
  "200": { description: "Signed in with a rotated opaque HttpOnly session cookie. No password/hash is returned." },
  "400": errorResponse("Invalid JSON, email or password length.", ["invalid_json", "invalid_registration"]),
  "401": errorResponse("Invalid credentials or session.", ["invalid_credentials", "unauthorized"]),
  "403": errorResponse("Origin mismatch or fresh verified sign-in required.", ["cross_site_forbidden", "verified_sign_in_required"]),
  "404": errorResponse("Password sign-in disabled.", "not_found"),
  "409": errorResponse("Registration unavailable or settings changed concurrently.", ["registration_unavailable", "password_change_conflict"]),
  "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
  "429": errorResponse("Per-IP or login-identifier limit reached.", "rate_limited"),
  "503": errorResponse("Session/database configuration unavailable.", "config_error"),
};
export const passwordPaths: LabeledPathFragment = { label: "password", entries: [
  ...(["register", "reset"] as const).map(action => [`/portal/v1/auth/password/${action}`, { post: {
    tags: ["auth"], operationId: action === "register" ? "authRegisterPassword" : "authResetPassword", summary: action === "register" ? "Request email verification before creating an account." : "Request password recovery at a verified email.", security: [],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } } },
    responses: { "202": { description: "Generic verification_requested response, including ineligible addresses and delivery failures. No session or account is created." }, "400": errorResponse("Invalid email or JSON.", ["invalid_email", "invalid_json"]), "403": responses["403"], "404": responses["404"], "413": responses["413"], "429": responses["429"], "503": errorResponse("Email or session configuration unavailable.", ["email_unconfigured", "config_error"]) },
    description: "Requires exact Origin, password enablement and an email sender. Links expire after 15 minutes. Registration never claims existing accounts; reset is restricted to active accounts whose credential email matches their verified contact address. Shared email send limit 1/60s, per-action email 10/900s, IP 5/900s for registration and 30/900s for reset. Resend uses the same endpoint.",
  } }] as [string, Record<string, unknown>]),
  ["/portal/v1/auth/password/complete", { post: {
    tags: ["auth"], operationId: "authCompletePassword", summary: "Redeem an email proof and set a password.", security: [],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["token", "password"], properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, password: { type: "string", minLength: 15, maxLength: 128 } } } } } },
    responses: { ...responses, "400": errorResponse("Expired, used or invalid link, or invalid password/JSON.", ["invalid_link", "invalid_registration", "invalid_json"]) },
    description: "POST only; opening the email link does not consume it. Single-use atomic redemption creates an empty verified account or resets an existing credential. Reset revokes sessions, OTPs and ephemeral account tokens. Outstanding reset links become invalid after any password change. Token must be passed in JSON, never a query parameter. IP 10/900s and token 5/900s before hashing.",
  } }],
  ["/portal/v1/auth/password/login", { post: {
    tags: ["auth"], operationId: "authLoginPassword", summary: "Sign in using an email/password credential.", security: [], requestBody: body(true), responses,
    description: "Requires exact Origin. Wrong password, unknown login and disabled customer return the same denial. Per-IP 30/900s and per-email 10/900s. Session creation atomically checks the verified password hash is still current.",
  } }],
  ["/portal/v1/auth/password", {
    get: { tags: ["auth"], operationId: "authPasswordSettings", summary: "Read this customer's password settings.", security: [{ sessionCookie: [] }], responses: {
      ...responses, "200": { description: "Email login identifier, has_password, can_reset, and email_verified flags; no hash.", content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { email: { type: "string" }, has_password: { type: "boolean" }, can_reset: { type: "boolean" }, email_verified: { type: "boolean" } } } } } } } },
    } },
    post: { tags: ["auth"], operationId: "authSetPassword", summary: "Set or change this customer's password.", security: [{ sessionCookie: [] }], requestBody: body(false), responses,
      description: "Requires current password or an OTP/OAuth session created within ten minutes. First set requires a recent OTP/OAuth session and customer contact email. Atomic compare-and-swap revokes all old sessions, outstanding OTPs and ephemeral account tokens, then issues a new password-authenticated session.",
    },
  }],
] };
