import React from "react";

import { describeResultCode, describeUnknownResult, rateLimitMessage } from "../portalWorkflow";
import type { StatusMessage } from "../types";
import { formatMessageDetail } from "./api";

export function StatusLine({ message, fallback }: { message: StatusMessage | null; fallback: string }): React.ReactElement {
  if (message === null) {
    return <p role="status" className="statusline">{fallback}</p>;
  }
  // Only a real retry-after header supplies the dynamic rate-limit sentence.
  const human = message.code === "rate_limited" && typeof message.retryAfter === "number"
    ? rateLimitMessage(message.retryAfter)
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
