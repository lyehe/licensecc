import React, { type ReactNode } from "react";

/**
 * A disclosure of ordinary buttons, not an ARIA menu with implied arrow-key behavior. It closes
 * itself once an action button inside it is chosen -- including one that opens a confirmation
 * dialog or another panel -- so it never lingers open behind whatever that action did next. Focus
 * restoration (the shared confirm dialog, or a row's own generic fallback) already tolerates its
 * trigger becoming hidden this way: it reopens the ancestor disclosure before focusing back into it.
 */
export function ActionMenu({ label, children }: { label: string; children: ReactNode }): React.ReactElement {
  return <details className="contextActions" onKeyDown={(event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}><summary>{label}<span className="actionChevron" aria-hidden="true">⌄</span></summary><div className="actions" onClick={(event) => {
    if (!(event.target instanceof HTMLElement) || event.target.closest("button") === null) return;
    const details = event.currentTarget.closest("details");
    if (details !== null) details.open = false;
  }}>{children}</div></details>;
}

/** Keep each action's existing permission and freshness guards in its owning workflow. */
export function StatusActions({ status, children }: { status: string; children: ReactNode }): React.ReactElement {
  return <div className="actions statusActions" data-status={status}>{children}</div>;
}
