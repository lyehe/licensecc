import React, { useEffect, useRef, useState } from "react";

import { AdminNavigationProvider, useAdminNavigation } from "./navigation";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { Sidebar } from "./Sidebar";
import { descriptions, tabs } from "./shellContent";
import { Catalog } from "../features/catalog/Catalog";
import { Customers } from "../features/customers/Customers";
import { Entitlements } from "../features/entitlements/Entitlements";
import { Events } from "../features/events/Events";
import { Fulfillment } from "../features/fulfillment/Fulfillment";
import { Licenses } from "../features/licenses/Licenses";
import { Overview } from "../features/overview/Overview";
import { Policies } from "../features/policies/Policies";
import { Reports } from "../features/reports/Reports";
import { Search } from "../features/search/Search";
import { Webhooks } from "../features/webhooks/Webhooks";
import { OperatorControlsProvider, useOperatorControls } from "../shared/controls";
import { CoreRefreshProvider } from "../shared/coreRefresh";
import { UsageTimeseriesProvider } from "../shared/usageTimeseries";
import { focusWorkspaceTarget } from "../shared/workspaceFocus";
import "../styles.css";
import "../shared/console.css";

export function App(): React.ReactElement {
  return (
    <OperatorControlsProvider>
      <CoreRefreshProvider>
        <UsageTimeseriesProvider>
          <AdminNavigationProvider>
            <ConsoleShell />
          </AdminNavigationProvider>
        </UsageTimeseriesProvider>
      </CoreRefreshProvider>
    </OperatorControlsProvider>
  );
}

function ConsoleShell(): React.ReactElement {
  const { route, navigationIntent, navigationNotice, navigationVersion, navigate, navigateTab, onNavigationHandled } = useAdminNavigation();
  const { feedback, modalActive, operationLocked } = useOperatorControls();
  const activeTab = route.tab;
  const label = tabs.find((tab) => tab.id === activeTab)?.label;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMenuOpen(false); }, [modalActive, navigationVersion]);

  return (
    <main className={`consoleShell${operationLocked ? " hasOperationNotice" : ""}`}>
      <a className="skipLink" href="#workspace-content" onClick={(event) => {
        event.preventDefault();
        const content = document.getElementById("workspace-content");
        focusWorkspaceTarget(content);
        content?.scrollIntoView({ block: "start" });
      }}>Skip to workspace</a>
      <Sidebar open={menuOpen && !modalActive} onClose={() => setMenuOpen(false)} menuRef={menuRef} />
      <div className="consoleBody">
        <header className="topbar">
          <button ref={menuRef} type="button" className="mobileMenuTrigger" data-workspace-menu aria-controls="workspace-navigation" aria-expanded={menuOpen && !modalActive} onClick={() => setMenuOpen((current) => !current)}>Menu</button>
          <span className="workspaceLabel"><span className="workspacePrefix">Workspace <span aria-hidden="true">/</span> </span>{label}</span>
          <EnvironmentBadge />
          <Search onNavigate={navigate} onOpen={() => setMenuOpen(false)} closeSignal={navigationVersion} hiddenByMenu={menuOpen} />
        </header>
        <div id="workspace-content" className="workspaceContent" tabIndex={-1}>
          <div className="pageHeading"><div><p className="eyebrow">License operations</p><h2 data-workspace-heading tabIndex={-1}>{label}</h2><p>{descriptions[activeTab]}</p></div></div>
          {navigationNotice !== null && <p className="activityMessage" data-tone="info" role="status">{navigationNotice}</p>}
          {feedback.message && <div className="activityMessage" data-tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>}
          {activeTab === "overview" && <div className="quickActions"><button className="primary" onClick={() => navigateTab("entitlements")}>Manage access <span aria-hidden="true">→</span></button><button onClick={() => navigateTab("reports")}>View usage</button></div>}
          <Overview active={activeTab === "overview"} />
          <Entitlements active={activeTab === "entitlements"} navigationIntent={navigationIntent} onNavigationHandled={onNavigationHandled} />
          <Policies active={activeTab === "policies"} />
          <Catalog active={activeTab === "plans"} />
          <Webhooks active={activeTab === "webhooks"} />
          <Events active={activeTab === "events"} />
          <Customers active={activeTab === "customers"} navigationIntent={navigationIntent} onNavigationHandled={onNavigationHandled} />
          <Licenses active={activeTab === "licenses"} navigationIntent={navigationIntent} onNavigationHandled={onNavigationHandled} />
          <Fulfillment active={activeTab === "fulfillment"} navigationIntent={navigationIntent} onNavigationHandled={onNavigationHandled} />
          <Reports active={activeTab === "reports"} onNavigate={navigate} />
        </div>
      </div>
    </main>
  );
}
