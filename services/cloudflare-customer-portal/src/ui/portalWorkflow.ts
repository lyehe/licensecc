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

export const ACTIVATION_DOWNLOAD_ACTION_LABEL = "Activate and download .lic";

export const ACTIVATION_DOWNLOAD_DISCLOSURE =
  "Downloading a license activates this entitlement and can start activation-based trial time.";

export const DEVICE_KEY_HELP_COPY =
  "The device key id is shown by the licensed application on the device you are activating; devices that are already registered also list it under the Devices tab.";

export const DEVICE_RELEASE_ACTION_LABEL = "Release";

// Shown in the confirm before a device release. It MUST state the consequence: the freed slot and the
// re-activation the application on that device will have to perform.
export const DEVICE_RELEASE_CONFIRM_COPY =
  "Release this device? This frees one device slot; the application on that device will need to activate again.";

// Map a raw server/result code to customer-facing copy. Returns null for any code we do not humanize,
// so the caller can fall back to showing the raw code (kept visible as small print for support). Codes
// mirror the backend envelope `code` field; this is the single source of humane portal feedback strings.
const RESULT_CODE_COPY: Record<string, string> = {
  pool_exhausted: "All seats are in use — release one or ask your administrator.",
  device_limit_exceeded: "This license's device limit is reached — release a device on the Devices tab.",
  expired_subscription: "This subscription has expired — renew it to continue.",
  invalid_otp: "That code is wrong or expired — request a new one.",
  seat_reclaimed: "Your seat was reclaimed after inactivity — check out again.",
  rate_limited: "Too many attempts — wait a moment and try again.",
};

export function describeResultCode(code: string): string | null {
  if (typeof code !== "string") {
    return null;
  }
  return RESULT_CODE_COPY[code] ?? null;
}

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
