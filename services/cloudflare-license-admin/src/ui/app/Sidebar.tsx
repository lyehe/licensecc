import React, { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { useAdminNavigation } from "./navigation";
import { hashForRoute, routeForTab } from "./navigationState";
import { tabs } from "./shellContent";
import type { AdminTab } from "./types";
import { focusWorkspaceTarget, usableFocusTarget } from "../shared/workspaceFocus";

const groups: ReadonlyArray<{ label: string; ids: readonly AdminTab[] }> = [
  { label: "Daily work", ids: ["overview", "customers", "entitlements"] },
  { label: "Configuration", ids: ["policies", "plans", "webhooks"] },
  { label: "Activity", ids: ["events", "fulfillment", "reports"] },
  { label: "Related records", ids: ["licenses"] },
];

export function Sidebar({ open, onClose, menuRef }: { open: boolean; onClose: () => void; menuRef: RefObject<HTMLButtonElement | null> }): React.ReactElement {
  const { route, navigateTab } = useAdminNavigation();
  const [expanded,setExpanded]=useState<Record<string,boolean>>({});
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const active=panel.current?.querySelector<HTMLElement>("[aria-current='page']") ?? null;
    focusWorkspaceTarget(usableFocusTarget(active) ? active : panel.current);
  }, [open]);
  useEffect(() => {
    const group = groups.find(item => item.ids.includes(route.tab));
    if (group) setExpanded(current => ({ ...current, [group.label]: true }));
  }, [route.tab]);
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
      <div className="brand"><span className="brandMark" aria-hidden="true">L</span><div><h1>Licensecc admin</h1></div></div>
      <button type="button" className="mobileMenuClose" onClick={dismiss}>Close menu</button>
      <nav aria-label="Main navigation">
        {groups.map((group) => <div className="navGroup" key={group.label}>
          {group.label!=="Daily work" && <button className="navDisclosure" aria-label={group.label} aria-expanded={expanded[group.label] ?? group.ids.includes(route.tab)} aria-controls={`nav-${group.label.replaceAll(" ","-")}`} onClick={()=>setExpanded(current=>({...current,[group.label]:!(current[group.label] ?? group.ids.includes(route.tab))}))}>{group.label}</button>}
          <div id={`nav-${group.label.replaceAll(" ","-")}`} hidden={group.label!=="Daily work" && !(expanded[group.label] ?? group.ids.includes(route.tab))}>
          {group.ids.map((id) => tabs.find((tab) => tab.id === id)!).map((tab) => <a key={tab.id} href={hashForRoute(routeForTab(tab.id))} aria-current={route.tab === tab.id ? "page" : undefined} className={route.tab === tab.id ? "active" : ""} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (navigateTab(tab.id)) onClose();
          }}>{tab.label}</a>)}
          </div>
        </div>)}
      </nav>
    </div>
  </>;
}
