import React from "react";

import type { ApiEnvelope } from "../../shared/api";
import { describeResultCode, describeUnknownResult } from "../portalWorkflow";
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

export function reportUnauthorized(status: number, code: string): void {
  if (status === 401 && code === "unauthorized") onUnauthorizedHandler?.();
}

// The HttpOnly session cookie is the only browser credential. Keeping every JSON request here makes
// accidental bearer headers or cross-origin credential modes visible in one small boundary.
export async function api<T>(
  path: string,
  init?: RequestInit,
  options?: { skipUnauthorizedHook?: boolean },
): Promise<ApiEnvelope<T>> {
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
  if (!options?.skipUnauthorizedHook) reportUnauthorized(response.status, envelope.code);
  return envelope;
}

export function resultMessage(result: ApiEnvelope<unknown>): StatusMessage {
  return { code: result.code, request_id: result.request_id, ok: result.ok };
}

export function localMessage(code: string, ok: boolean): StatusMessage {
  return { code, request_id: "", ok };
}

// Human-readable status text for the SPA: describeResultCode's copy when the code is mapped, else the
// generic reference fallback -- never the raw snake_case code as the visible sentence (task C1). The
// code and request id remain available, tucked under a collapsed "Technical details" disclosure so
// support can read them off without the raw code cluttering the message every customer sees.
export function StatusLine({ message, fallback }: { message: StatusMessage | null; fallback: string }): React.ReactElement {
  if (message === null) {
    return <p role="status" className="statusline">{fallback}</p>;
  }
  const human = describeResultCode(message.code) ?? describeUnknownResult(message.request_id);
  const detail = message.request_id === "" ? message.code : `${message.code} (${message.request_id})`;
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
