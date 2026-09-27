import React from "react";
import { describeResultCode, describeUnknownResult, rateLimitMessage } from "../portalWorkflow";
import { SupportContact } from "./SupportContact";
import type { StatusMessage } from "../types";

// D2: "show each result next to the control that produced it". Each seat card and each device row
// that has its own action (start/renew/release a seat, release a legacy device, download a
// license) gets its OWN role="status" line showing that action's result, instead of every action
// funnelling through the single page-level StatusLine (api.tsx) -- which stays reserved for page
// results: refresh and account-level failures (session ended, account refresh failed, and the
// like). Renders nothing until that control has produced a result, so a page with many rows does
// not fill up with empty status regions.
//
// A couple of codes need a real link (SupportContact) in their copy, which portalWorkflow.ts's
// RESULT_CODE_COPY cannot hold: that map MUST stay plain strings so the pure workflow unit test can
// `ts.transpileModule` + `import()` it without React (see portalWorkflow.ts's own header comment).
// Those few codes are mapped here instead, as real React nodes, and checked first.
const RESULT_CODE_NODES: Partial<Record<string, React.ReactNode>> = {
  // A floating license has no free seat right now; every seat is held by some browser until it is
  // released or its lease expires. Framed the same way the entitlements table's own "next step"
  // sentences are (EntitlementsFeature.tsx's NEXT_STEP): a plain sentence a support contact finishes.
  pool_exhausted: <>All seats are in use. <SupportContact /> to free one.</>,
};

function describeResultNode(code: string): React.ReactNode | null {
  return Object.hasOwn(RESULT_CODE_NODES, code) ? RESULT_CODE_NODES[code] ?? null : null;
}

// Mirrors StatusLine's own rendering (api.tsx) exactly, plus the node lookup above, so a local line
// and the page-level line never show visibly different text for the same code.
export function ActionResult({ message }: { message: StatusMessage | null }): React.ReactElement | null {
  if (message === null) {
    return null;
  }
  const human = message.code === "rate_limited" && typeof message.retryAfter === "number"
    ? rateLimitMessage(message.retryAfter)
    : describeResultNode(message.code) ?? describeResultCode(message.code) ?? describeUnknownResult(message.request_id);
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
