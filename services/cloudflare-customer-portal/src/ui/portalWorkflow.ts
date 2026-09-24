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

export function devicesPath(): string {
  return "/api/portal/devices";
}

export function usagePath(filter?: { project?: string; feature?: string }): string {
  const params = new URLSearchParams();
  if (filter?.project !== undefined && filter.project !== "") params.set("project", filter.project);
  if (filter?.feature !== undefined && filter.feature !== "") params.set("feature", filter.feature);
  return `/api/portal/usage${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function downloadPath(): string {
  return "/api/portal/download";
}

// ---- Action path builders (server resolves the fingerprint; body is project+feature only) ------

export function checkoutPath(): string {
  return "/api/portal/checkout";
}

export function heartbeatPath(): string {
  return "/api/portal/heartbeat";
}

export function releasePath(): string {
  return "/api/portal/release";
}

// Self-serve device deactivation (frees the slot a registered device holds). Distinct from the
// floating-seat releasePath above: this retires a node-locked/proof-carrying DEVICE, not a live seat.
export function deviceReleasePath(): string {
  return "/api/portal/devices/release";
}

// ---- Formatters / display helpers --------------------------------------------------------------

export const LOGIN_CODE_SENT_COPY = "If this email is registered, we sent an 8-digit code. Enter it below.";

export const RESEND_CODE_ACTION_LABEL = "Resend code";

// Shown on the verify screen so a customer knows the code is short-lived (mirrors the 10-minute TTL
// the OTP email itself states in src/auth/portal_otp.mjs).
export const OTP_EXPIRY_COPY = "Codes expire 10 minutes after they are sent.";

export const ACTIVATION_DOWNLOAD_ACTION_LABEL = "Activate and download .lic";

export const ACTIVATION_DOWNLOAD_DISCLOSURE =
  "Downloading a license activates this license and can start activation-based trial time.";

export const DEVICE_KEY_HELP_COPY =
  "The device key ID is shown by the licensed application on the device you are activating. Registered IDs are also listed under Devices.";

export const DEVICE_RELEASE_ACTION_LABEL = "Release";

// Shown in the confirm before a device release. It MUST state the consequence: the freed slot and the
// re-activation the application on that device will have to perform.
export const DEVICE_RELEASE_CONFIRM_COPY =
  "Release this device? This frees one device slot; the application on that device will need to activate again.";

// Floating-seat release is also destructive: it ends the current checkout and makes that seat
// available to another customer/device. The dialog supplies the exact seat/device/license context
// beside this consequence copy; no backend reason field exists for this portal operation.
export const FLOATING_SEAT_RELEASE_CONFIRM_TITLE = "Release seat?";

export const FLOATING_SEAT_RELEASE_CONFIRM_COPY =
  "This release cannot be undone. It ends renewal for this checkout and makes the seat available to another user. An issued grant may remain usable until it expires. This browser must check out a new seat to renew access.";

export const FLOATING_SEAT_RELEASE_NETWORK_ERROR_COPY =
  "The release request outcome is unknown because the service was unreachable. Check the seat status before taking another action.";

export const FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE = "floating_seat_release_refresh_failed";

export const FLOATING_SEAT_RELEASE_REFRESH_ERROR_COPY =
  "Seat released; status refresh failed. Refresh status manually to verify current availability.";

export const PORTAL_STATUS_REFRESH_ACTION_LABEL = "Refresh status";

// Empty-state copy for each portal tab. Shown when the tab has no rows so the customer sees an
// explanation instead of a bare table header.
export const NO_ENTITLEMENTS_EMPTY_COPY = "No licenses yet — they appear here after purchase.";

export const NO_DEVICES_EMPTY_COPY = "No devices registered yet — activate a license to register one.";

// Map a raw server/result code to customer-facing copy. Returns null for any code we do not humanize,
// so the caller (StatusLine) falls back to a generic message -- never the raw code itself. Codes mirror
// the backend envelope `code` field emitted by routes/auth.ts, routes/self-service.ts, support.ts and
// app.ts; `BACKEND_PROXY_ERROR_MANIFEST`'s codes; and this app's own local UI-only codes (passed via
// localMessage()). This is the single source of humane portal feedback strings for StatusLine.
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

  // ---- Self-service actions (routes/self-service.ts) ----------------------------------------------
  device_status_conflict: "That device's status changed. Refresh to see its current status.",
  portal_error: "Something went wrong on our end. Try again.",
  device_released: "Device released.",
  backend_unconfigured: "The service is temporarily unavailable. Try again shortly.",
  device_key_required: "Enter the device key ID shown by the application before continuing.",
  backend_invalid_response: "The service returned an unexpected response. Try again.",

  // ---- Worker-wide fallback (app.ts) ---------------------------------------------------------------
  temporarily_unavailable: "This is temporarily unavailable. Try again shortly.",

  // ---- Backend-proxied seat/download errors (BACKEND_PROXY_ERROR_MANIFEST) ------------------------
  token_revoked: "Your session ended. Sign in again.",
  token_expired: "Your session ended. Sign in again.",
  floating_disabled: "This license doesn't support seats.",
  forbidden_scope: "You don't have access to do that.",
  no_active_entitlement: "This license is no longer active.",
  device_proof_required: "This device needs to be verified. Use the application to verify it, then try again.",
  device_proof_invalid: "This device couldn't be verified. Use the application to verify it again.",
  borrowing_disabled: "Offline borrowing isn't enabled for this license.",
  pool_exhausted: "All seats are in use — release one or ask your administrator.",
  seat_signing_error: "We couldn't complete that seat action. Try again.",
  verification_error: "We couldn't verify that request. Try again.",
  seat_signing_unavailable: "Seat actions are temporarily unavailable. Try again shortly.",
  seat_reclaimed: "Your seat was reclaimed after inactivity — check out again.",
  expired_subscription: "This subscription has expired — renew it to continue.",
  device_limit_exceeded: "This license's device limit is reached — release a device under Devices.",
  trial_device_proof_required: "This trial requires device verification. Use the application to verify it, then try again.",
  trial_device_locked: "This trial is locked to a different device.",
  lease_signing_error: "We couldn't complete that download. Try again.",
  lease_signing_unavailable: "Downloads are temporarily unavailable. Try again shortly.",

  // ---- Local UI-only codes (src/ui, passed via localMessage()) -------------------------------------
  invalid_email: "Enter a valid email address.",
  invalid_code: "Enter the 8-digit code exactly as sent.",
  invalid_response: "The service returned an unexpected response. Try again.",
  // A fetch that never reached the network at all (offline, DNS failure, an aborted request) --
  // produced by api()'s own fetch rejection and by the download's raw fetch, both of which bypass the
  // server entirely, so no server-authored code is available (task C2).
  network_unavailable: "Couldn't reach the portal. Check your connection and try again.",
  account_refresh_failed: "Account refresh failed. Displayed data may be out of date; retry to refresh it.",
  seat_not_checked_out: "Start a seat before doing that.",
  license_unavailable: "This license can't be downloaded right now.",
  download_started: "Download started.",
  // Shown whenever the logout request itself failed (a server-returned failure code, or the network
  // rejection above) -- always specific about staying signed in rather than forwarding whatever code
  // came back, since a code like "unauthorized" would misleadingly suggest the session already ended
  // (task C2).
  logout_failed: "Sign-out didn't complete. You're still signed in — try again.",
  // Shown by App's global onUnauthorized hook (api.tsx) once retrySession() confirms a mid-session
  // 401 is real. The server's own `unauthorized` code already maps to this identical sentence above,
  // but this local code is what fires the return-to-sign-in transition itself, and it can be raised
  // by ANY api() caller -- a background data read, a seat action, or the download's raw fetch -- not
  // just the one request whose response happened to carry the code (task C3).
  session_ended: "Your session ended. Sign in again.",
  [FLOATING_SEAT_RELEASE_REFRESH_FAILED_CODE]: FLOATING_SEAT_RELEASE_REFRESH_ERROR_COPY,

  // ---- Seat-action success (self-service.ts apiAction's default `${operation}_ok`) ----------------
  checkout_ok: "Seat started.",
  heartbeat_ok: "Seat renewed.",
  release_ok: "Seat released.",
};

// download_failed_<http-status> (DownloadsFeature.tsx) is a dynamic family -- one status per failed
// download -- so it is matched by prefix instead of enumerating every possible status. The status
// itself still reaches the customer, just under Technical details (StatusLine renders the full code
// there), never as the main sentence.
export const DOWNLOAD_FAILED_PREFIX = "download_failed_";
export const DOWNLOAD_FAILED_COPY = "The download failed. Try again.";

export function describeResultCode(code: string): string | null {
  if (typeof code !== "string") {
    return null;
  }
  if (code.startsWith(DOWNLOAD_FAILED_PREFIX)) {
    return DOWNLOAD_FAILED_COPY;
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

// ---- Floating-seat session persistence ---------------------------------------------------------

// A live floating-seat checkout the SPA holds so Release/Refresh stay enabled. `expires_at` is the
// lease deadline in epoch seconds (the backend checkout/heartbeat `expires_at`); 0 means unknown and
// is never treated as expired on hydrate.
export interface SeatSession {
  seat_id: string;
  client_instance_id: string;
  expires_at: number;
}

// Versioned localStorage namespace: a shape change becomes a NEW key rather than a silent misread of
// stale entries. main.tsx reads/writes this key; these helpers stay window-free so they unit-test raw.
export const SEATS_KEY = "licensecc.portal.seats.v1";

// Serialize the in-memory seat map for localStorage. Pure JSON — no window access.
export function serializeSeatSessions(sessions: Record<string, SeatSession>): string {
  return JSON.stringify(sessions);
}

// Rebuild the seat map from a stored JSON string (or null when the key is absent). Tolerates any
// garbage (bad JSON, wrong root type, malformed entries) by returning {} — never throws. Entries
// whose lease already expired (`expires_at > 0 && expires_at <= now`) are DROPPED so their
// Release/Refresh buttons do not re-enable against a seat the server has already reclaimed.
export function hydrateSeatSessions(json: string | null | undefined, now: number): Record<string, SeatSession> {
  if (typeof json !== "string" || json.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, SeatSession> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.seat_id !== "string" || typeof entry.client_instance_id !== "string") {
      continue;
    }
    const expiresAt = typeof entry.expires_at === "number" && Number.isFinite(entry.expires_at) ? entry.expires_at : 0;
    if (expiresAt > 0 && expiresAt <= now) {
      continue;
    }
    out[key] = { seat_id: entry.seat_id, client_instance_id: entry.client_instance_id, expires_at: expiresAt };
  }
  return out;
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
  // ends the trial yet (or at all); absent from an older Worker's row.
  trial_ends_at?: number | null;
}

// When access ends: the earlier of the license's end and its trial's end, or null for neither.
function licenseEndsAt(item: LicenseDates): number | null {
  const ends = [item.valid_until, item.trial_ends_at].filter((end): end is number => typeof end === "number");
  return ends.length === 0 ? null : Math.min(...ends);
}

// An ended trial is expired like any other ended license. trial_ends_at comes from the rule that
// enforces the row: a protected trial past it is refused, and a legacy one would only get a license
// that has already expired, so hiding its download is correct.
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

// The Mode column: how the license is enforced and, for a trial, when the rule that enforces it ends
// it; otherwise that the first activation starts its clock; otherwise plain "Trial" -- a trial with
// no end of its own (the Valid column already says "No end date"), or a row from an older Worker.
export function licenseModeLabel(
  item: { enforcement_mode?: string; license_mode: string; trial_ends_at?: number | null; trial_starts_on_activation?: boolean },
  now: number,
): string {
  const enforcement = item.enforcement_mode === "device_bound_v1" ? "Protected device" : null;
  if (item.license_mode !== "trial") return enforcement ?? (item.license_mode === "floating" ? "Floating" : "Node-locked");
  const trial = typeof item.trial_ends_at === "number" ? `Trial · ${item.trial_ends_at <= now ? "ended" : "ends"} ${formatEndDate(item.trial_ends_at)}`
    : item.trial_starts_on_activation === true ? "Trial starts when you activate"
    : "Trial";
  return enforcement === null ? trial : `${enforcement} · ${trial}`;
}

export const LICENSE_ATTENTION_COPY = "Needs attention";

// The Apps list flags an app with an expired, suspended or revoked license: each has a next step
// for the customer. A license that has yet to start needs nothing from them.
export function licenseNeedsAttention(item: LicenseDates, now: number): boolean {
  const state = licenseDisplayStatus(item, now);
  return state === "expired" || state === "disabled" || state === "revoked";
}

export function canDownloadLicense(item: { enforcement_mode?: string; license_mode: string }): boolean {
  return (item.enforcement_mode === undefined || item.enforcement_mode === "legacy") && item.license_mode !== "floating";
}
