import React, { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { useAdminNavigation } from "./navigation";
import { hashForRoute, routeForTab } from "./navigationState";
import { tabs } from "./shellContent";
import type { AdminTab } from "./types";
import { focusWorkspaceTarget } from "../shared/workspaceFocus";

const groups: ReadonlyArray<{ label: string; ids: readonly AdminTab[] }> = [
  { label: "Manage", ids: ["overview", "entitlements", "customers", "licenses"] },
  { label: "Configure", ids: ["policies", "plans", "webhooks"] },
  { label: "Monitor", ids: ["events", "fulfillment", "reports"] },
];

export function Sidebar({ open, onClose, menuRef }: { open: boolean; onClose: () => void; menuRef: RefObject<HTMLButtonElement | null> }): React.ReactElement {
  const { route, navigateTab } = useAdminNavigation();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    focusWorkspaceTarget(panel.current?.querySelector<HTMLElement>("[aria-current='page']") ?? panel.current);
  }, [open]);
  function dismiss(): void {
    onClose();
    focusWorkspaceTarget(menuRef.current);
  }
  return <>
    {open && <div className="sidebarBackdrop" aria-hidden="true" onClick={dismiss} />}
    <div id="workspace-navigation" ref={panel} className={`sidebar${open ? " isOpen" : ""}`} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    }} onBlur={(event) => {
      // This is a disclosure, not a second modal. Tab may leave the panel;
      // close it when focus moves to the workspace so content stays visible.
      if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== menuRef.current) onClose();
    }}>
      <div className="brand"><span className="brandMark" aria-hidden="true">L</span><div><h1>licensecc admin</h1><p>License management</p></div></div>
      <button type="button" className="mobileMenuClose" onClick={dismiss}>Close menu</button>
      <nav aria-label="Main navigation">
        {groups.map((group) => <div className="navGroup" key={group.label}>
          <p className="navLabel">{group.label}</p>
          {group.ids.map((id) => tabs.find((tab) => tab.id === id)!).map((tab) => <a key={tab.id} href={hashForRoute(routeForTab(tab.id))} aria-current={route.tab === tab.id ? "page" : undefined} className={route.tab === tab.id ? "active" : ""} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (navigateTab(tab.id)) onClose();
          }}>{tab.label}</a>)}
        </div>)}
      </nav>
      <p className="sidebarNote">Access &amp; licensing<br />Operator console</p>
    </div>
  </>;
}
