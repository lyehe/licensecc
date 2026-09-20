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
  ["/portal/v1/auth/password/register", { post: {
    tags: ["auth"], operationId: "authRegisterPassword", summary: "Register an empty account with email and password.", security: [], requestBody: body(true), responses,
    description: "Requires exact Origin and enabled password sign-in. Email is an unverified login identifier stored separately from customer contact email. Never claims an existing customer or grants licenses. Per-IP limit 5/900s and per-email 10/900s before scrypt.",
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
