import React from "react";

import type { ApiEnvelope } from "../../shared/api";
import { describeResultCode } from "../portalWorkflow";
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

export function StatusLine({ message, fallback }: { message: StatusMessage | null; fallback: string }): React.ReactElement {
  if (message === null) {
    return <p role="status" className="statusline">{fallback}</p>;
  }
  const human = describeResultCode(message.code);
  const detail = message.request_id === "" ? message.code : `${message.code} (${message.request_id})`;
  return (
    <p role="status" className={message.ok ? "statusline" : "statusline error"}>
      {human ?? message.code}
      <small> {detail}</small>
    </p>
  );
}
