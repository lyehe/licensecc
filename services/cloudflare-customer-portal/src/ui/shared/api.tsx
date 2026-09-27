import React from "react";

import type { ApiEnvelope } from "../../shared/api";
import { describeResultCode, describeUnknownResult, rateLimitMessage } from "../portalWorkflow";
import type { StatusMessage } from "../types";

// A mid-session 401 (task C3): the server's `unauthorized` code means the session cookie is gone or
// invalid -- distinct from a credential failure that also answers 401 (`invalid_otp`,
// `invalid_credentials`, ...), which means "you typed the wrong thing", never "you were signed out".
// App registers exactly one handler here, once (setOnUnauthorized), so every api() call below routes a
// real session death through the same recovery path, and reportUnauthorized() lets the download's raw
// fetch -- it bypasses api() entirely to get the real Response for a blob -- reach that same handler.
type UnauthorizedHandler = () => void;
let onUnauthorizedHandler: UnauthorizedHandler | null = null;

export function setOnUnauthorized(handler: UnauthorizedHandler | null): void {
  onUnauthorizedHandler = handler;
}

// Fix round 1 (Minor): a straggler -- a request sent under an OLD, now-superseded session that only
// answers 401 long after the customer already signed in again -- must not bounce that new sign-in back
// a step. The re-entrancy guard in App.tsx's effect resets once its retry settles, so by itself it
// cannot tell "a fresh 401 from the current session" apart from "a very late 401 from a dead one". A
// session epoch does: beginNewSession() bumps it once per confirmed sign-in (called from
// AuthFeature.tsx's loadMe, success branch only), api() captures the epoch when EACH request starts,
// and reportUnauthorized() ignores a 401 whose request started in an epoch that is no longer current.
let sessionEpoch = 0;

export function beginNewSession(): void {
  sessionEpoch += 1;
}

// Lets a caller that bypasses api() (the download's raw fetch) capture the epoch the same way api()
// captures it internally, at the moment its own request starts.
export function currentSessionEpoch(): number {
  return sessionEpoch;
}

export function reportUnauthorized(status: number, code: string, requestEpoch: number): void {
  if (status === 401 && code === "unauthorized" && requestEpoch === sessionEpoch) onUnauthorizedHandler?.();
}

// The HttpOnly session cookie is the only browser credential. Keeping every JSON request here makes
// accidental bearer headers or cross-origin credential modes visible in one small boundary.
export async function api<T>(
  path: string,
  init?: RequestInit,
  options?: { skipUnauthorizedHook?: boolean },
): Promise<ApiEnvelope<T>> {
  const requestEpoch = sessionEpoch; // captured before the request goes out, per fix round 1 (Minor)
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // fetch() itself rejects when the request never reached the network at all (offline, DNS
    // failure, an aborted request) -- distinct from the JSON-parse fallback below, which handles a
    // response that DID arrive but wasn't valid JSON. Every api() caller gets back a normal envelope
    // either way, so a dropped connection always shows the customer a sentence instead of surfacing
    // as an unhandled rejection / pageerror (task C2).
    return { ok: false, code: "network_unavailable", request_id: "" };
  }
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    return { ok: false, code: "invalid_response", request_id: "" };
  }
  // retrySession()'s own /me check (AuthFeature.tsx's loadMe) must never re-trigger the hook it is
  // itself answering -- that would be circular -- so it alone passes skipUnauthorizedHook (task C3).
  if (!options?.skipUnauthorizedHook) reportUnauthorized(response.status, envelope.code, requestEpoch);
  // The auth 429s carry a real `retry-after` header (task C6); it never rides the JSON body, so it
  // is read here, once, and attached for every caller instead of each one re-parsing headers.
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  return Number.isFinite(retryAfter) ? { ...envelope, retryAfter } : envelope;
}

export function resultMessage(result: ApiEnvelope<unknown>): StatusMessage {
  return { code: result.code, request_id: result.request_id, ok: result.ok, retryAfter: result.retryAfter };
}

export function localMessage(code: string, ok: boolean, params?: Record<string, number>): StatusMessage {
  return params === undefined ? { code, request_id: "", ok } : { code, request_id: "", ok, params };
}

// Fix round 1 (Minor): the "Technical details" line -- the raw code, plus the request id in
// parentheses when one is present -- shared verbatim between StatusLine (below, the page-level line)
// and ActionResult.tsx (every local per-row/card line), so the two never drift apart. Lives here
// rather than in portalWorkflow.ts: it needs no React, but api.tsx (not the pure RESULT_CODE_COPY
// module) is where both callers already look for shared StatusLine-adjacent helpers.
export function formatMessageDetail(message: Pick<StatusMessage, "code" | "request_id">): string {
  return message.request_id === "" ? message.code : `${message.code} (${message.request_id})`;
}

// D3: the sign-in screen's one summary sentence for sign-out's best-effort seat release, built from
// the released/failed counts (App.tsx's logout()) at render time -- exactly like rateLimitMessage
// above, StatusLine special-cases the "seats_released_on_signout" code to call this instead of the
// static RESULT_CODE_COPY entry, since the wording needs singular/plural nouns and an optional second
// sentence a static string cannot express. Lives here (not portalWorkflow.ts): it needs no React or
// DOM, but portal-ui-api.test.mjs slices this file down to everything ABOVE StatusLine and asserts
// ZERO remaining runtime imports, so nothing above that line may depend on a new cross-file import.
export function seatsReleasedMessage(released: number, failed: number): string {
  const parts: string[] = [];
  if (released > 0) parts.push(`Released ${released} browser seat${released === 1 ? "" : "s"}.`);
  if (failed > 0) parts.push(`${failed} seat${failed === 1 ? "" : "s"} couldn't be released; they'll be listed after you sign in again.`);
  return parts.join(" ");
}

// Human-readable status text for the SPA: describeResultCode's copy when the code is mapped, else the
// generic reference fallback -- never the raw snake_case code as the visible sentence (task C1). The
// code and request id remain available, tucked under a collapsed "Technical details" disclosure so
// support can read them off without the raw code cluttering the message every customer sees.
export function StatusLine({ message, fallback }: { message: StatusMessage | null; fallback: string }): React.ReactElement {
  if (message === null) {
    return <p role="status" className="statusline">{fallback}</p>;
  }
  // rate_limited gets the one dynamic sentence ONLY when a real retry-after header reached this
  // specific call (the auth 429s in the header rollout); every other rate_limited (e.g. self-service's
  // own 429, which never carries the header) keeps the existing generic RESULT_CODE_COPY text.
  // seats_released_on_signout (D3) gets the same treatment for the released/failed counts App.tsx's
  // logout() attaches as params -- see seatsReleasedMessage above.
  const human = message.code === "rate_limited" && typeof message.retryAfter === "number"
    ? rateLimitMessage(message.retryAfter)
    : message.code === "seats_released_on_signout" && message.params !== undefined
    ? seatsReleasedMessage(message.params.released ?? 0, message.params.failed ?? 0)
    : describeResultCode(message.code) ?? describeUnknownResult(message.request_id);
  const detail = formatMessageDetail(message);
  return (
    <div role="status" className={message.ok ? "statusline" : "statusline error"}>
      <p>{human}</p>
      <details>
        <summary>Technical details</summary>
        <small>{detail}</small>
      </details>
    </div>
  );
}
