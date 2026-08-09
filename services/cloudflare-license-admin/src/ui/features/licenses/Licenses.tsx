import React, { useEffect, useMemo, useState } from "react";

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
  const { busy: requestBusy, operationLocked, setMessage } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const licensesUrl = useMemo(() => licensesPath(licenseFilter), [licenseFilter]);
  const licensesFence = useRequestFence(`${active ? "active" : "inactive"}\u0000${licensesUrl}`);

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
      const ticket = licensesFence.begin();
      const response = await api<{ items: LicenseListItem[]; next_cursor: string | null }>(licensesUrl);
      if (!licensesFence.isCurrent(ticket)) return;
      const parsed = parseExactApiSuccess<{ items: LicenseListItem[]; next_cursor: string | null }>(response, "licenses_listed", hasLicenseListData);
      if (parsed !== null) {
        if (licensesFence.settle(ticket, parsed.data.next_cursor ?? null)) {
          setLicenses(parsed.data.items);
          setLicensesCursor(parsed.data.next_cursor ?? null);
        }
      } else {
        setMessage(apiFailureMessage(response));
      }
    })();
  }, [active, licensesFence, licensesUrl, setMessage]);

  const licenses = licensesFence.isSettled() ? licensesSnapshot : [];
  const licensesCursor = licensesFence.canLoadMore() ? licensesCursorSnapshot : null;

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
          <tr key={item.id}><td>{item.id}</td><td><code>{shortHash(item.customer_id ?? "-")}</code></td><td>{item.project}</td><td>{item.label ?? "-"}</td><td>{formatEpoch(item.created_at)}</td></tr>
        ))}</tbody>
      </table>
      <div className="tableFooter">
        <span className="muted">{licenses.length} shown</span>
        {licensesCursor !== null && <button type="button" disabled={busy || operationLocked} onClick={() => void loadMore(licensesUrl, licensesCursor, licenses, setLicenses, setLicensesCursor, setMessage, hasLicenseListData, "licenses_listed", licensesFence, (license) => license.id)}>Load more</button>}
      </div>
    </section>
  );
}
