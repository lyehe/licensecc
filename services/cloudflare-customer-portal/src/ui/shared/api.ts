import type { ApiEnvelope } from "../../shared/api";
import type { StatusMessage } from "../types";

// A mid-session 401: the server's `unauthorized` code means the session cookie is gone or
// invalid -- distinct from a credential failure that also answers 401 (`invalid_otp`,
// `invalid_credentials`, ...), which means "you typed the wrong thing", never "you were signed out".
// App registers exactly one handler here, once (setOnSessionProblem), so every api() call below routes a
// real session death or a 409 account_changed through the same /me recovery path.
type SessionProblemHandler = (reason: "session_ended" | "account_changed") => void;
let onSessionProblemHandler: SessionProblemHandler | null = null;

export function setOnSessionProblem(handler: SessionProblemHandler | null): void {
  onSessionProblemHandler = handler;
}

// A straggler -- a request sent under an OLD, now-superseded session that only
// answers 401 long after the customer already signed in again -- must not bounce that new sign-in back
// a step. The re-entrancy guard in App.tsx's effect resets once its retry settles, so by itself it
// cannot tell "a fresh 401 from the current session" apart from "a very late 401 from a dead one". A
// session epoch does: beginNewSession() bumps it once per confirmed sign-in (called from
// AuthFeature.tsx's loadMe, success branch only), api() captures the epoch when EACH request starts,
// and reportSessionProblem() ignores failures from a superseded epoch, including account mismatches.
let sessionEpoch = 0;

export function beginNewSession(): void {
  sessionEpoch += 1;
}

function reportSessionProblem(status: number, code: string, requestEpoch: number): void {
  if (requestEpoch !== sessionEpoch) return;
  if (status === 401 && code === "unauthorized") onSessionProblemHandler?.("session_ended");
  if (status === 409 && code === "account_changed") onSessionProblemHandler?.("account_changed");
}

// The HttpOnly session cookie is the only browser credential. Keeping every JSON request here makes
// accidental bearer headers or cross-origin credential modes visible in one small boundary.
export async function api<T>(
  path: string,
  init?: RequestInit,
  options?: { skipSessionHook?: boolean },
): Promise<ApiEnvelope<T>> {
  const requestEpoch = sessionEpoch; // captured before the request goes out
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    // fetch() itself rejects when the request never reached the network at all (offline, DNS
    // failure, an aborted request) -- distinct from the JSON-parse fallback below, which handles a
    // response that DID arrive but wasn't valid JSON. Every api() caller gets back a normal envelope
    // either way, so a dropped connection always shows the customer a sentence instead of surfacing
    // as an unhandled rejection / pageerror.
    return { ok: false, code: "network_unavailable", request_id: "" };
  }
  let envelope: ApiEnvelope<T>;
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)
        || !("ok" in body) || typeof body.ok !== "boolean" || body.ok !== response.ok
        || !("code" in body) || typeof body.code !== "string" || !body.code
        || !("request_id" in body) || typeof body.request_id !== "string") {
      return { ok: false, code: "invalid_response", request_id: "" };
    }
    envelope = body as ApiEnvelope<T>;
  } catch {
    return { ok: false, code: "invalid_response", request_id: "" };
  }
  // retrySession()'s own /me check (AuthFeature.tsx's loadMe) must never re-trigger the hook it is
  // itself answering -- that would be circular -- so it alone passes skipSessionHook.
  if (!options?.skipSessionHook) reportSessionProblem(response.status, envelope.code, requestEpoch);
  // The auth 429s carry a real `retry-after` header; it never rides the JSON body, so it
  // is read here, once, and attached for every caller instead of each one re-parsing headers.
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  return Number.isFinite(retryAfter) ? { ...envelope, retryAfter } : envelope;
}

// Bind account reads and actions to the identity the mounted screen actually displayed.
// A mismatch rechecks /me through the epoch-fenced session handler; no mutation is replayed.
export function accountApi<T>(customerId: string, path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const headers = new Headers(init?.headers);
  headers.set("x-expected-customer-id", encodeURIComponent(customerId));
  return api<T>(path, { ...init, headers });
}

export function resultMessage(result: ApiEnvelope<unknown>): StatusMessage {
  return { code: result.code, request_id: result.request_id, ok: result.ok, retryAfter: result.retryAfter };
}

export function localMessage(code: string, ok: boolean): StatusMessage {
  return { code, request_id: "", ok };
}

export function formatMessageDetail(message: Pick<StatusMessage, "code" | "request_id">): string {
  return message.request_id === "" ? message.code : `${message.code} (${message.request_id})`;
}
