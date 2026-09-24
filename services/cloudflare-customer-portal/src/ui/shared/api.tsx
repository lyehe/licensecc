import React from "react";

import type { ApiEnvelope } from "../../shared/api";
import { describeResultCode, describeUnknownResult } from "../portalWorkflow";
import type { StatusMessage } from "../types";

// The HttpOnly session cookie is the only browser credential. Keeping every JSON request here makes
// accidental bearer headers or cross-origin credential modes visible in one small boundary.
export async function api<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    return { ok: false, code: "invalid_response", request_id: "" };
  }
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
