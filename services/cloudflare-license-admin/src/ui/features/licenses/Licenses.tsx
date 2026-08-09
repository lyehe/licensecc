import React, { useEffect, useMemo, useState } from "react";

import type { NavigationIntent } from "../../app/types";
import { api } from "../../shared/api";
import { useOperatorControls } from "../../shared/controls";
import { formatEpoch, shortHash } from "../../shared/format";
import { loadMore } from "../../shared/pagination";
import { LicenseListFilter, licensesPath } from "./workflow";

interface LicenseListItem {
  id: string;
  customer_id: string;
  project: string;
  label: string;
  created_at: number;
  updated_at: number;
}

export function Licenses({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [licenses, setLicenses] = useState<LicenseListItem[]>([]);
  const [licenseFilter, setLicenseFilter] = useState<LicenseListFilter>({ project: "", customer_id: "", q: "" });
  const [licensesCursor, setLicensesCursor] = useState<string | null>(null);
  const { busy, setMessage } = useOperatorControls();
  const licensesUrl = useMemo(() => licensesPath(licenseFilter), [licenseFilter]);

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
    if (!active) return;
    void (async () => {
      const response = await api<{ items: LicenseListItem[]; next_cursor: string | null }>(licensesUrl);
      if (response.ok && response.data) {
        setLicenses(response.data.items);
        setLicensesCursor(response.data.next_cursor ?? null);
      } else {
        setMessage(`${response.code} (${response.request_id})`);
      }
    })();
  }, [active, licensesUrl, setMessage]);

  if (!active) return null;
  return (
    <section className="tablePane full">
      <div className="filters">
        <input placeholder="project" value={licenseFilter.project} onChange={(event) => setLicenseFilter({ ...licenseFilter, project: event.target.value })} />
        <input placeholder="customer_id" value={licenseFilter.customer_id} onChange={(event) => setLicenseFilter({ ...licenseFilter, customer_id: event.target.value })} />
        <input placeholder="search id / label" value={licenseFilter.q} onChange={(event) => setLicenseFilter({ ...licenseFilter, q: event.target.value })} />
      </div>
      <table>
        <thead><tr><th>ID</th><th>Customer</th><th>Project</th><th>Label</th><th>Created</th></tr></thead>
        <tbody>{licenses.map((item) => (
          <tr key={item.id}><td>{item.id}</td><td><code>{shortHash(item.customer_id)}</code></td><td>{item.project}</td><td>{item.label}</td><td>{formatEpoch(item.created_at)}</td></tr>
        ))}</tbody>
      </table>
      <div className="tableFooter">
        <span className="muted">{licenses.length} shown</span>
        {licensesCursor !== null && <button type="button" disabled={busy} onClick={() => void loadMore(licensesUrl, licensesCursor, setLicenses, setLicensesCursor, setMessage)}>Load more</button>}
      </div>
    </section>
  );
}
