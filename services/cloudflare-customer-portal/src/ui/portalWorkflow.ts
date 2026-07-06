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

// ---- Formatters / display helpers --------------------------------------------------------------

export const LOGIN_CODE_SENT_COPY = "If this email is registered, we sent an 8-digit code. Enter it below.";

export const ACTIVATION_DOWNLOAD_ACTION_LABEL = "Activate and download .lic";

export const ACTIVATION_DOWNLOAD_DISCLOSURE =
  "Downloading a license activates this entitlement and can start activation-based trial time.";

// A license_fingerprint is a long hex digest; show a head...tail summary, never the full value in a
// way that could be mistaken for a credential. Mirrors the admin shortHash contract exactly.
export function shortHash(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

// epoch seconds -> human date; null/0/invalid render as "any" (open-ended window).
export function formatEpoch(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) {
    return "any";
  }
  if (!Number.isFinite(value) || value < 0) {
    return "any";
  }
  return new Date(value * 1000).toISOString().slice(0, 10);
}

// epoch seconds -> full local timestamp for event rows; invalid -> "-".
export function formatTimestamp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

// Render a validity window "<from> to <until>" using formatEpoch on both ends.
export function formatWindow(validFrom: number | null | undefined, validUntil: number | null | undefined): string {
  return `${formatEpoch(validFrom)} to ${formatEpoch(validUntil)}`;
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
