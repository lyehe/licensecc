import React, { useCallback, useRef, useState } from "react";

import type { AdminTab, NavigationIntent, NavigationTarget } from "./types";
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
import "../styles.css";

const tabs: ReadonlyArray<{ id: AdminTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "entitlements", label: "Entitlements" },
  { id: "policies", label: "Policies" },
  { id: "plans", label: "Plans" },
  { id: "webhooks", label: "Webhooks" },
  { id: "events", label: "Events" },
  { id: "customers", label: "Customers" },
  { id: "licenses", label: "Licenses" },
  { id: "fulfillment", label: "Fulfillment" },
  { id: "reports", label: "Reports" },
];

export function App(): React.ReactElement {
  return (
    <OperatorControlsProvider>
      <CoreRefreshProvider>
        <UsageTimeseriesProvider>
          <ConsoleShell />
        </UsageTimeseriesProvider>
      </CoreRefreshProvider>
    </OperatorControlsProvider>
  );
}

function ConsoleShell(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [navigationIntent, setNavigationIntent] = useState<NavigationIntent | null>(null);
  const nextIntentId = useRef(0);
  const { message } = useOperatorControls();

  const navigate = useCallback((target: NavigationTarget): void => {
    nextIntentId.current += 1;
    setNavigationIntent({ ...target, id: nextIntentId.current });
    setActiveTab(target.tab);
  }, []);
  const handleNavigation = useCallback((intent: NavigationIntent): void => {
    setNavigationIntent((current) => current?.id === intent.id ? null : current);
  }, []);

  return (
    <main>
      <header className="topbar">
        <div><h1>licensecc admin</h1><p>{message || "ready"}</p></div>
        <Search onNavigate={navigate} />
        <nav>
          {tabs.map((tab) => <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
        </nav>
      </header>
      <Overview active={activeTab === "overview"} />
      <Entitlements active={activeTab === "entitlements"} navigationIntent={navigationIntent} onNavigationHandled={handleNavigation} />
      <Policies active={activeTab === "policies"} />
      <Catalog active={activeTab === "plans"} />
      <Webhooks active={activeTab === "webhooks"} />
      <Events active={activeTab === "events"} />
      <Customers active={activeTab === "customers"} navigationIntent={navigationIntent} onNavigationHandled={handleNavigation} />
      <Licenses active={activeTab === "licenses"} navigationIntent={navigationIntent} onNavigationHandled={handleNavigation} />
      <Fulfillment active={activeTab === "fulfillment"} navigationIntent={navigationIntent} onNavigationHandled={handleNavigation} />
      <Reports active={activeTab === "reports"} onNavigate={navigate} />
    </main>
  );
}
