import React, { useEffect, useRef, useState } from "react";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { ReadNotice } from "../../shared/ReadNotice";
import { hasCustomerListData, hasLicenseListData } from "../../shared/mutationGuards";
import { loadAllExactPages, loadExactFirstPage } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { CreateLicenseButton } from "./CreateLicense";

interface RelationshipOption { id: string; name?: string; email?: string; label?: string | null; project?: string }

// Customers are a typeahead: one bounded page when the form opens, then one per pause in typing,
// never every page of every customer. A customer's own licenses are few, so that lookup reads all.
export const CUSTOMER_TYPEAHEAD_LIMIT = 20;
export const TYPEAHEAD_DELAY_MS = 300;

function RelationshipLookup({ kind, value, onChange, scope = "", project = "", required = false, emptyAction }: { kind: "customer" | "license"; value: string; onChange: (value: string) => void; scope?: string; project?: string; required?: boolean; emptyAction?: (selectCreated: (id: string) => void) => React.ReactNode }): React.ReactElement {
  const typeahead = kind === "customer";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const typed = useDebouncedValue(query.trim(), TYPEAHEAD_DELAY_MS);
  const term = typeahead ? typed : search;
  const [items, setItems] = useState<RelationshipOption[]>([]);
  const [more, setMore] = useState(false);
  const [read, setRead] = useState<{ context: string; error: OperatorFeedback | null; loading: boolean }>({ context: "", error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const selectRef = useRef<HTMLSelectElement>(null);
  const loadsStarted = useRef(0);
  const loadsSettled = useRef(0);
  const focusAfterLoad = useRef<number | null>(null);
  const params = new URLSearchParams();
  if (term !== "") params.set("q", term);
  if (typeahead) params.set("limit", String(CUSTOMER_TYPEAHEAD_LIMIT));
  if (kind === "license" && scope !== "") params.set("customer_id", scope);
  const path = `/api/admin/${kind}s${params.size === 0 ? "" : `?${params}`}`;
  const fence = useRequestFence(path);
  const label = kind === "customer" ? "Customer" : "License";

  useEffect(() => {
    let mounted = true;
    const load = ++loadsStarted.current;
    setRead({ context: path, loading: true, error: null });
    void (async () => {
      const identity = (item: RelationshipOption): string => item.id;
      const result = typeahead
        ? await loadExactFirstPage<RelationshipOption>(path, "customers_listed", hasCustomerListData, fence, identity, () => mounted)
        : await loadAllExactPages<RelationshipOption>(path, "licenses_listed", hasLicenseListData, fence, identity, () => mounted);
      if (!mounted || result.kind === "stale") return;
      if (result.kind === "success") {
        setItems(result.items);
        setMore("more" in result && result.more === true);
      }
      loadsSettled.current = load;
      setRead({ context: path, loading: false, error: result.kind === "failure" ? result.feedback : null });
    })();
    return () => { mounted = false; };
  }, [path, typeahead, fence, revision]);

  const ready = fence.canLoadMore();
  // A protected grant can only use a license of its own project, so only those are offered.
  const visible = fence.isSettled() ? items.filter((item) => project === "" || item.project === project) : [];
  const currentRead = read.context === path ? read : { loading: true, error: null };
  // A just-created record takes focus once a load that started after its creation has settled.
  useEffect(() => {
    if (focusAfterLoad.current === null || loadsSettled.current < focusAfterLoad.current || !ready) return;
    focusAfterLoad.current = null;
    selectRef.current?.focus();
  });
  const selectCreated = (id: string): void => { onChange(id); focusAfterLoad.current = loadsStarted.current + 1; setRevision((previous) => previous + 1); };
  return <section className="wide" aria-label={`${label} relationship`}>
    {/* Enter never submits the surrounding entitlement form from a search field. */}
    <div className="filterBar"><label>Search {kind}s<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!typeahead) setSearch(query); } }} /></label>{!typeahead && <button type="button" onClick={() => { setSearch(query); setRevision((previous) => previous + 1); }}>Find {kind}s</button>}</div>
    <ReadNotice {...currentRead} hasData={visible.length > 0} label={`${kind} options`} onRetry={() => setRevision((previous) => previous + 1)} />
    <label>{label} ({required ? "required" : "optional"})<select ref={selectRef} required={required} value={value} disabled={!ready} onChange={(event) => onChange(event.target.value)}><option value="">No {kind}</option>{value !== "" && !visible.some((item) => item.id === value) && <option value={value}>Current ID: {value}</option>}{visible.map((item) => <option key={item.id} value={item.id}>{item.name || item.email || item.label || item.project || item.id}{(item.name || item.email || item.label || item.project) ? ` · ${item.id}` : ""}</option>)}</select></label>
    {typeahead && ready && more && <p className="muted">Showing the first {CUSTOMER_TYPEAHEAD_LIMIT} customers. Type more of a name, email, or ID to narrow the list.</p>}
    {ready && visible.length === 0 && <p className="muted">No {kind}s match. Try another search or enter the full ID below.</p>}
    {ready && visible.length === 0 && term === "" && value === "" && currentRead.error === null && emptyAction?.(selectCreated)}
    <details><summary>Enter {kind} ID manually</summary><p className="muted">Use this when lookup cannot resolve the {kind}. Enter the complete identifier.</p><label>{label} ID<input name={`${kind}_id`} maxLength={128} value={value} onChange={(event) => onChange(event.target.value)} /></label></details>
  </section>;
}

/** `protectedProject` is set for a protected create: licenses narrow to it, and one can be created. */
export function EntitlementRelationships({ customerId, licenseId, onCustomerChange, onLicenseChange, required = false, protectedProject = "" }: { customerId: string; licenseId: string; required?: boolean; protectedProject?: string; onCustomerChange: (value: string) => void; onLicenseChange: (value: string) => void }): React.ReactElement {
  const createLicense = protectedProject !== "" && customerId !== ""
    ? (selectCreated: (id: string) => void) => <CreateLicenseButton customerId={customerId} project={protectedProject} onCreated={selectCreated} />
    : undefined;
  return <><RelationshipLookup kind="customer" required value={customerId} onChange={onCustomerChange} /><RelationshipLookup kind="license" required={required} value={licenseId} onChange={onLicenseChange} scope={customerId} project={protectedProject} emptyAction={createLicense} /></>;
}
