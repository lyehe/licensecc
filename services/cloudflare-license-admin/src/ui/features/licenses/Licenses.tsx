import React, { useEffect, useMemo, useState } from "react";

import { useAdminNavigation } from "../../app/navigation";
import type { NavigationIntent } from "../../app/types";
import { api, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { hasLicenseListData } from "../../shared/mutationGuards";
import { loadMore } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
import { LicenseListFilter, licensesPath } from "./workflow";

interface LicenseListItem {
  id: string;
  customer_id: string | null;
  project: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

export function Licenses({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [licensesSnapshot, setLicenses] = useState<LicenseListItem[]>([]);
  const [licenseFilter, setLicenseFilter] = useState<LicenseListFilter>({ project: "", customer_id: "", q: "" });
  const [licensesCursorSnapshot, setLicensesCursor] = useState<string | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);
  const { navigate, openCustomer, rememberFilters } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, setMessage } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const licensesUrl = useMemo(() => licensesPath(licenseFilter), [licenseFilter]);
  const licensesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${licensesUrl}`);

  async function refreshLicenses(): Promise<void> {
    const ticket = licensesFence.begin();
    const response = await api<{ items: LicenseListItem[]; next_cursor: string | null }>(licensesUrl);
    if (!licensesFence.isCurrent(ticket)) return;
    const parsed = parseExactApiSuccess<{ items: LicenseListItem[]; next_cursor: string | null }>(response, "licenses_listed", hasLicenseListData);
    if (parsed !== null) {
      if (licensesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
        setLicenses(parsed.data.items);
        setLicensesCursor(parsed.data.next_cursor ?? null);
        setListFailure(null);
      }
      return;
    }
    const failure = apiFailureMessage(response);
    setListFailure(failure);
    setMessage(failure);
  }

  useEffect(() => {
    if (navigationIntent?.tab !== "licenses") return;
    setLicenseFilter({
      project: navigationIntent.filter.project ?? "",
      customer_id: navigationIntent.filter.customer_id ?? "",
      q: navigationIntent.filter.q ?? "",
    });
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (!active || navigationIntent?.tab === "licenses") return;
    rememberFilters("licenses", { ...licenseFilter });
  }, [active, licenseFilter, navigationIntent, rememberFilters]);

  useEffect(() => {
    if (!active) return;
    setListFailure(null);
    void refreshLicenses();
  }, [active, licensesFence, licensesUrl, setMessage]);

  const licenses = licensesFence.isSettled() ? licensesSnapshot : [];
  const licensesCursor = licensesFence.canLoadMore() ? licensesCursorSnapshot : null;

  if (!active) return null;
  const loading = !licensesFence.isSettled() && listFailure === null;
  const updating = licensesFence.isSettled() && !licensesFence.canLoadMore();
  return (
    <section className="listPage" aria-labelledby="licenses-list-title">
      <header className="listHeader listStatusHeader"><div><h2 id="licenses-list-title" className="srOnly">Licenses</h2></div>{updating && <p className="readState" role="status">Updating licenses…</p>}</header>
      <div className="filters filterBar" aria-label="License filters">
        <label>Project<input value={licenseFilter.project} onChange={(event) => setLicenseFilter({ ...licenseFilter, project: event.target.value })} /></label>
        <label>Customer ID<input value={licenseFilter.customer_id} onChange={(event) => setLicenseFilter({ ...licenseFilter, customer_id: event.target.value })} /></label>
        <label>Search licenses<input placeholder="License ID or label" value={licenseFilter.q} onChange={(event) => setLicenseFilter({ ...licenseFilter, q: event.target.value })} /></label>
        <button type="button" disabled={licenseFilter.project === "" && licenseFilter.customer_id === "" && licenseFilter.q === ""} onClick={() => setLicenseFilter({ project: "", customer_id: "", q: "" })}>Clear filters</button>
      </div>
      {loading && <p className="readState" role="status">Loading licenses…</p>}
      {listFailure !== null && <div className="readState error" role="alert"><p>Could not load licenses: {listFailure}</p><button type="button" onClick={() => void refreshLicenses()}>Retry</button></div>}
      {licenses.length === 0 && licensesFence.isSettled() && <div className="emptyState"><h3>No licenses found</h3><p>Try clearing or changing the filters.</p></div>}
      {licenses.length > 0 && <>
        <div className="desktopRecords tableScroll"><table><thead><tr><th>License</th><th>Customer</th><th>Project</th><th>Label</th><th>Created</th><th>Related records</th></tr></thead><tbody>{licenses.map((item) => <tr key={item.id}><td><code>{item.id}</code></td><td>{item.customer_id === null ? "—" : <button type="button" onClick={() => openCustomer(item.customer_id!)}>{shortHash(item.customer_id)}</button>}</td><td>{item.project}</td><td>{item.label || "—"}</td><td>{formatEpoch(item.created_at)}</td><td><button type="button" onClick={() => navigate({ tab: "entitlements", filter: { project: item.project, feature: "", status: "" } })}>View project access</button></td></tr>)}</tbody></table></div>
        <div className="recordCards">{licenses.map((item) => <article className="recordCard" key={item.id}><h3>{item.label || item.id}</h3><code>{item.id}</code><p>Project: {item.project}</p><p>Created {formatEpoch(item.created_at)}</p><div className="actions">{item.customer_id !== null && <button type="button" onClick={() => openCustomer(item.customer_id!)}>Open customer</button>}<button type="button" onClick={() => navigate({ tab: "entitlements", filter: { project: item.project, feature: "", status: "" } })}>View project access</button></div></article>)}</div>
      </>}
      {licensesFence.isSettled() && <div className="tableFooter"><span className="muted">{licenses.length} shown</span>{licensesCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(licensesUrl, licensesCursor, licenses, setLicenses, setLicensesCursor, setMessage, hasLicenseListData, "licenses_listed", licensesFence, (license) => license.id)}>Load more</button>}</div>}
    </section>
  );
}
