import React, { type ReactNode } from "react";

/** A disclosure of ordinary buttons, not an ARIA menu with implied arrow-key behavior. */
export function ActionMenu({ label, children }: { label: string; children: ReactNode }): React.ReactElement {
  return <details className="contextActions" onKeyDown={(event) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  }}><summary>{label}<span className="actionChevron" aria-hidden="true">⌄</span></summary><div className="actions">{children}</div></details>;
}

/** Keep each action's existing permission and freshness guards in its owning workflow. */
export function StatusActions({ status, children }: { status: string; children: ReactNode }): React.ReactElement {
  return <div className="actions statusActions" data-status={status}>{children}</div>;
}
