// portal_email.mjs — fetch-only transactional email adapter (Resend-compatible).
//
// Blueprint (e): the sendEmail seam. When email is NOT configured (no API key / no from address)
// this returns { ok:false, code:"email_unconfigured" } and the caller does NOT 503 — it falls back
// to operator bootstrap. A successful login flow on the request path never blocks on email: the
// caller runs sendEmail inside ctx.waitUntil(). The OTP secret is passed here ONLY to compose the
// magic-link / code body; it is NEVER logged.
//
// Worker-safe: no node:/Buffer; only fetch + standard globals.

import { emailApiOrigin } from "./portal_destination.mjs";

const EMAIL_RESPONSE_TIMEOUT_MS = 2_000;

function discardResponseBody(response) {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => {});
  } catch {
    // The provider response is never consumed; cancellation is best effort and must not delay auth.
  }
}

/**
 * sendEmail(env, to, subject, body) -> { ok, code }
 *
 *   { ok:true,  code:"sent" }                        on a 2xx from the provider.
 *   { ok:false, code:"email_unconfigured" }          when PORTAL_EMAIL_API_KEY / FROM is unset.
 *   { ok:false, code:"email_send_failed" }           on a provider error / network throw.
 *
 * NEVER throws (so a flaky email provider can never 500 the auth path) and NEVER logs the body.
 */
export function sendEmail(env, to, subject, body) {
  return sendEmailWithTimeout(env, to, subject, body, EMAIL_RESPONSE_TIMEOUT_MS);
}

// The production export above fixes a small response deadline. The timeout-taking form is test-only
// internal surface so a stalled provider can be exercised without making deterministic tests wait.
async function sendEmailWithTimeout(env, to, subject, body, timeoutMs) {
  // Validate the destination BEFORE reading/assembling API-key credentials. Invalid config must be
  // indistinguishable from a provider failure to callers, but it must never cause a subrequest.
  const base = emailApiOrigin(env);
  if (base === null) return { ok: false, code: "email_send_failed" };
  const apiKey = env?.PORTAL_EMAIL_API_KEY;
  const from = env?.PORTAL_EMAIL_FROM;
  if (typeof apiKey !== "string" || apiKey.length === 0 || typeof from !== "string" || from.length === 0) {
    return { ok: false, code: "email_unconfigured" };
  }
  if (typeof to !== "string" || to.length === 0) {
    return { ok: false, code: "email_send_failed" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/emails", base).toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text: body }),
      // A provider redirect must be terminal: never forward the API key or OTP body to Location.
      redirect: "manual",
      signal: controller.signal,
    });
    // sendEmail only needs the status. Drop every provider body immediately, including a redirect's
    // potentially unbounded body, while the provider timeout is still live.
    discardResponseBody(response);
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, code: "email_send_failed" };
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, code: "sent" };
    }
    return { ok: false, code: "email_send_failed" };
  } catch {
    return { ok: false, code: "email_send_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export const _internals = {
  EMAIL_RESPONSE_TIMEOUT_MS,
  sendEmailWithTimeout,
};
