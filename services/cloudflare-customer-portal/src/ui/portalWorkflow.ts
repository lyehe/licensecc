// Pure, dependency-free path-builders + formatters + input validators for the customer-portal SPA.
// MUST stay free of any import that the workflow unit test cannot `ts.transpileModule` + `import()`
// (no React, no DOM, no node:). The UI imports these; the test exercises them directly.
//
// Invariant 3 reminder: NONE of these helpers emit an Authorization header or a bearer/token — they
// only build SAME-ORIGIN relative paths. The session is the HttpOnly cookie, carried automatically.

// ---- Auth path builders (same-origin, relative) ------------------------------------------------

export function authRequestPath(): string {
  return "/portal/v1/auth/request";
}

export function authVerifyPath(): string {
  return "/portal/v1/auth/verify";
}

export function logoutPath(): string {
  return "/portal/v1/auth/logout";
}

// ---- Read path builders ------------------------------------------------------------------------

export function mePath(): string {
  return "/api/portal/me";
}

export function entitlementsPath(): string {
  return "/api/portal/entitlements";
}

// ---- Formatters / display helpers --------------------------------------------------------------

export const LOGIN_CODE_SENT_COPY = "If this email is registered, we sent an 8-digit code. Enter it below.";

// Shown on the verify screen so a customer knows the code is short-lived (mirrors the 10-minute TTL
// the OTP email itself states in src/auth/portal_otp.mjs).
export const OTP_EXPIRY_COPY = "Codes expire 10 minutes after they are sent.";

// The one rate-limit sentence for every auth 429 that carries the server's `retry-after` header
// (OTP request/verify, magic JSON redeem, password login/register/reset/complete), and the same
// fallback wherever that header is absent -- a redirect-driven rate_limited (ProviderSignIn's
// auth_error=rate_limited), or a password screen's own 429 the header rollout left out (settings'
// change action). n = max(1, ceil(seconds/60)); the header itself is always a positive integer of
// seconds (portalRateLimit's fixed-window remainder), never a full minute short.
export function rateLimitMessage(retryAfterSeconds?: number | null): string {
  if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "Too many attempts. Try again later.";
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} minutes.`;
}

// Empty-state copy for the entitlements table. Shown when the customer has no rows so they see an
// explanation instead of a bare table header.
export const NO_ENTITLEMENTS_EMPTY_COPY = "No licenses yet — they appear here after purchase.";

// Map a raw server/result code to customer-facing copy. Returns null for any code we do not humanize,
// so the caller (StatusLine) falls back to a generic message -- never the raw code itself. Codes mirror
// the backend envelope `code` field emitted by routes/auth.ts, routes/self-service.ts, support.ts and
// app.ts, and this app's own local UI-only codes (passed via localMessage()). This is the single
// source of humane portal feedback strings for StatusLine.
// `passwordMessage()` (passwordMessages.tsx) and `ProviderSignIn`'s ERRORS map their own, separate code
// domains (password flows and the `?auth_error=` redirect) and never read this map.
const RESULT_CODE_COPY: Record<string, string> = {
  // ---- Session / identity (routes/auth.ts) -------------------------------------------------------
  unauthorized: "Your session ended. Sign in again.",
  config_error: "The service is temporarily unavailable. Try again shortly.",
  cross_site_forbidden: "That request couldn't be verified. Reload the page and try again.",
  invalid_otp: "That code is wrong or expired — request a new one.",
  signed_in: "Signed in.",
  unsupported_media_type: "That request wasn't formatted correctly. Reload the page and try again.",
  logged_out: "You're signed out.",
  not_found: "We couldn't find that. It may have been removed or already changed.",
  // access_required and bootstrap_otp are the only two codes UNIQUE to the operator-only break-glass
  // route (handleBootstrap in routes/auth.ts, POST /portal/v1/admin/bootstrap-otp). That route also
  // returns several codes shared with other routes (not_found, unauthorized, cross_site_forbidden,
  // invalid_request, config_error, rate_limited), which already get their own copy elsewhere in this
  // map. The two unique ones are classified differently on purpose:
  //  - access_required IS mapped here: it is an ordinary 403 failure code, and every non-data
  //    failure code gets real copy here regardless of which route emits it.
  //  - bootstrap_otp is deliberately NOT mapped: its 200 payload is the minted OTP secret itself, a
  //    pure data shape like `me`/`entitlements` (read off `.data`, never handed to setMessage), and
  //    the customer-portal SPA has no caller for this operator-only route at all. It is excluded via
  //    DATA_ONLY_CODES in test/portal-ui-workflow.test.mjs rather than mapped to copy here.
  access_required: "Additional verification is required for this action.",
  invalid_request: "That request wasn't valid. Check the details and try again.",
  rate_limited: "Too many attempts — wait a moment and try again.",
  otp_requested: "Check your email for a sign-in code.",

  // ---- Request/body validation (support.ts) ------------------------------------------------------
  body_too_large: "That request was too large. Try again with less data.",
  invalid_json: "That request wasn't valid. Reload the page and try again.",

  // ---- Worker-wide fallback (app.ts) ---------------------------------------------------------------
  // portal_error (the catch-all's own 500 for any unhandled exception) is intentionally NOT mapped
  // here: it carries no copy more useful than describeUnknownResult()'s generic reference sentence,
  // which additionally names the request id for support -- something a static string here cannot do.
  temporarily_unavailable: "This is temporarily unavailable. Try again shortly.",

  // ---- Local UI-only codes (src/ui, passed via localMessage()) -------------------------------------
  invalid_email: "Enter a valid email address.",
  invalid_code: "Enter the 8-digit code exactly as sent.",
  invalid_response: "The service returned an unexpected response. Try again.",
  // A fetch that never reached the network at all (offline, DNS failure, an aborted request) --
  // produced by api()'s own fetch rejection -- so no server-authored code is available.
  network_unavailable: "Couldn't reach the portal. Check your connection and try again.",
  account_refresh_failed: "Account refresh failed. Displayed data may be out of date; retry to refresh it.",
  // Shown whenever the logout request itself failed (a server-returned failure code, or the network
  // rejection above) -- always specific about staying signed in rather than forwarding whatever code
  // came back, since a code like "unauthorized" would misleadingly suggest the session already ended.
  logout_failed: "Sign-out didn't complete. You're still signed in — try again.",
  // Shown by App's global onUnauthorized hook (api.tsx) once retrySession() confirms a mid-session
  // 401 is real. The server's own `unauthorized` code already maps to this identical sentence above,
  // but this local code is what fires the return-to-sign-in transition itself, and it can be raised
  // by ANY api() caller, not just the one request whose response happened to carry the code.
  session_ended: "Your session ended. Sign in again.",
};

export function describeResultCode(code: string): string | null {
  if (typeof code !== "string") {
    return null;
  }
  // Object.hasOwn -- not `RESULT_CODE_COPY[code] ?? null` -- because a code equal to an
  // Object.prototype member name ("constructor", "__proto__", "toString", ...) would otherwise
  // resolve to that inherited function/value instead of null: React then throws ("Objects are not
  // valid as a React child") or silently renders a function. Mirrors the fix already applied to
  // ProviderSignIn's ERRORS and passwordMessage()'s MESSAGES (both Object.hasOwn too).
  return Object.hasOwn(RESULT_CODE_COPY, code) ? RESULT_CODE_COPY[code] : null;
}

// StatusLine's fallback for a code describeResultCode could not map: an unmapped code, or a
// prototype-polluting key name. Never the raw code; includes the request id (so support can trace it)
// when one is present, and never dangles the word "Reference" when the id is empty.
export function describeUnknownResult(requestId: string): string {
  return requestId === "" ? "Something went wrong. Try again." : `Something went wrong. Reference ${requestId}.`;
}

// A license_fingerprint is a long hex digest; show a head...tail summary, never the full value in a
// way that could be mistaken for a credential. Mirrors the admin shortHash contract exactly.
export function shortHash(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

// The last second toISOString() still writes as a plain four-digit-year date (9999-12-31T23:59:59Z).
// A later epoch, such as a "never" sentinel, is no calendar date a customer can act on, and past a
// JS Date's range toISOString() throws, which would take the whole page down mid-render.
const LAST_CALENDAR_EPOCH = 253_402_300_799;

function isCalendarEpoch(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= LAST_CALENDAR_EPOCH;
}

// epoch seconds -> "YYYY-MM-DD" in UTC. License dates are whole days, shown in UTC so every viewer
// reads the same day. For a date that is present: an optional start or end goes through
// formatStartDate/formatEndDate, which say what a missing one means.
export function formatEpoch(value: number): string {
  return new Date(value * 1000).toISOString().slice(0, 10);
}

export const NO_START_DATE_COPY = "No start date";

export const NO_END_DATE_COPY = "No end date";

// A license's start date, or "No start date" when it has none a calendar can show.
export function formatStartDate(value: number | null | undefined): string {
  return isCalendarEpoch(value) ? formatEpoch(value) : NO_START_DATE_COPY;
}

// A license's (or its trial's) end date, or "No end date" when it has none a calendar can show.
export function formatEndDate(value: number | null | undefined): string {
  return isCalendarEpoch(value) ? formatEpoch(value) : NO_END_DATE_COPY;
}

// epoch seconds -> full local timestamp for event rows; invalid -> "-".
export function formatTimestamp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

// Render a validity window "<from> to <until>", naming a missing start or end.
export function formatWindow(validFrom: number | null | undefined, validUntil: number | null | undefined): string {
  return `${formatStartDate(validFrom)} to ${formatEndDate(validUntil)}`;
}

// ---- Input validators --------------------------------------------------------------------------

// Normalize an email for the auth request: trim + lowercase. Returns "" for non-strings.
export function normalizeEmail(value: string): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

// Loose shape check for an email (the server is authoritative; this only gates the submit button).
export function isLikelyEmail(value: string): boolean {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > 254) {
    return false;
  }
  if (email.includes(" ") || email.includes("\n") || email.includes("\r")) {
    return false;
  }
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

// The OTP code is exactly 8 digits (blueprint (a): uint32 % 1e8, zero-padded to 8). Accept only
// after stripping whitespace; 7 or 9 digits (or any non-digit) is rejected.
export function normalizeCode(value: string): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, "");
}

export function isValidCode(value: string): boolean {
  return /^[0-9]{8}$/.test(normalizeCode(value));
}

// ---- License lifecycle (display only) -----------------------------------------------------------

// A license's lifecycle as the customer reads it. Display only: dates do not establish device or
// trial authorization, which the server decides on every activation. The wire status "disabled"
// reads as suspended (doc/architecture/glossary.md). A status this portal does not know is
// "unknown", so a raw code never reaches the page.
export type LicenseDisplayStatus = "active" | "not_started" | "expired" | "disabled" | "revoked" | "unknown";

interface LicenseDates {
  status: string;
  valid_from: number | null;
  valid_until: number | null;
  // When the rule that enforces the row ends its trial, never after valid_until; null when nothing
  // ends the trial yet (or at all).
  trial_ends_at?: number | null;
}

// When access ends: the earlier of the license's end and its trial's end, or null for neither.
function licenseEndsAt(item: LicenseDates): number | null {
  const ends = [item.valid_until, item.trial_ends_at].filter((end): end is number => typeof end === "number");
  return ends.length === 0 ? null : Math.min(...ends);
}

// An ended trial is expired like any other ended license. trial_ends_at comes from the protected
// device-bound trial rule that enforces every row: a trial past it is refused.
export function licenseDisplayStatus(item: LicenseDates, now: number): LicenseDisplayStatus {
  if (item.status === "disabled" || item.status === "revoked") return item.status;
  if (item.status !== "active") return "unknown";
  const endsAt = licenseEndsAt(item);
  if (endsAt !== null && endsAt <= now) return "expired";
  if (item.valid_from !== null && item.valid_from > now) return "not_started";
  return "active";
}

// What the Status column says first. Where the customer has a next step, the entitlements feature
// finishes the sentence with <SupportContact/>: "Expired on 2025-06-15. Contact support to renew."
export function licenseStatusLead(item: LicenseDates, now: number): string {
  switch (licenseDisplayStatus(item, now)) {
    case "active": return "Active";
    case "expired": return `Expired on ${formatEndDate(licenseEndsAt(item))}.`;
    case "not_started": return `Starts ${formatStartDate(item.valid_from)}.`;
    case "disabled": return "Suspended.";
    case "revoked": return "Revoked.";
    default: return "Unavailable.";
  }
}

// The Mode column: every license is a protected device license and, for a trial, when the rule
// that enforces it ends it; otherwise that the first activation starts its clock; otherwise plain
// "Trial" -- a trial with no end of its own (the Valid column already says "No end date").
// "Starts when you activate" promises an activation the customer can still make, so it shows only
// while the license is active or not yet valid; beside "Revoked.", "Suspended." or "Expired on ..."
// it would contradict the status.
export function licenseModeLabel(
  item: LicenseDates & { license_mode: "trial" | "node_locked"; trial_starts_on_activation?: boolean },
  now: number,
): string {
  if (item.license_mode !== "trial") return "Protected device";
  const activatable = ["active", "not_started"].includes(licenseDisplayStatus(item, now));
  const trial = typeof item.trial_ends_at === "number" ? `Trial · ${item.trial_ends_at <= now ? "ended" : "ends"} ${formatEndDate(item.trial_ends_at)}`
    : item.trial_starts_on_activation === true && activatable ? "Trial starts when you activate"
    : "Trial";
  return `Protected device · ${trial}`;
}

export const LICENSE_ATTENTION_COPY = "Needs attention";

// The Apps list flags an app with an expired, suspended or revoked license: each has a next step
// for the customer. A license that has yet to start needs nothing from them.
export function licenseNeedsAttention(item: LicenseDates, now: number): boolean {
  const state = licenseDisplayStatus(item, now);
  return state === "expired" || state === "disabled" || state === "revoked";
}
