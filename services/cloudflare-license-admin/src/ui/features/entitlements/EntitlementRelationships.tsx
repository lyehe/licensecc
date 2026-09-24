import React, { useEffect, useRef, useState } from "react";
import { ReadNotice } from "../../shared/ReadNotice";
import { hasCustomerListData, hasLicenseListData } from "../../shared/mutationGuards";
import { loadAllExactPages } from "../../shared/pagination";
import { useRequestFence } from "../../shared/requestFence";
import { CreateLicenseButton } from "./CreateLicense";

interface RelationshipOption { id: string; name?: string; email?: string; label?: string | null; project?: string }

function RelationshipLookup({ kind, value, onChange, scope = "", project = "", required = false, emptyAction }: { kind: "customer" | "license"; value: string; onChange: (value: string) => void; scope?: string; project?: string; required?: boolean; emptyAction?: (selectCreated: (id: string) => void) => React.ReactNode }): React.ReactElement {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<RelationshipOption[]>([]);
  const [read, setRead] = useState<{ context: string; error: string | null; loading: boolean }>({ context: "", error: null, loading: true });
  const [revision, setRevision] = useState(0);
  const selectRef = useRef<HTMLSelectElement>(null);
  const loadedRevision = useRef(-1);
  const focusAtRevision = useRef<number | null>(null);
  const params = new URLSearchParams();
  if (search !== "") params.set("q", search);
  if (kind === "license" && scope !== "") params.set("customer_id", scope);
  const path = `/api/admin/${kind}s${params.size === 0 ? "" : `?${params}`}`;
  const fence = useRequestFence(path);
  const label = kind === "customer" ? "Customer" : "License";

  useEffect(() => {
    let mounted = true;
    setRead({ context: path, loading: true, error: null });
    void (async () => {
      const result = await loadAllExactPages<RelationshipOption>(path, `${kind}s_listed`, kind === "customer" ? hasCustomerListData : hasLicenseListData, fence, (item) => item.id, () => mounted);
      if (!mounted || result.kind === "stale") return;
      if (result.kind === "success") setItems(result.items);
      loadedRevision.current = revision;
      setRead({ context: path, loading: false, error: result.kind === "failure" ? result.message : null });
    })();
    return () => { mounted = false; };
  }, [path, kind, fence, revision]);

  const ready = fence.canLoadMore();
  // A protected grant can only use a license of its own project, so only those are offered.
  const visible = fence.isSettled() ? items.filter((item) => project === "" || item.project === project) : [];
  const currentRead = read.context === path ? read : { loading: true, error: null };
  // A just-created record takes focus once the reload that lists it has settled.
  useEffect(() => {
    if (focusAtRevision.current === null || loadedRevision.current < focusAtRevision.current || !ready) return;
    focusAtRevision.current = null;
    selectRef.current?.focus();
  });
  const selectCreated = (id: string): void => { onChange(id); focusAtRevision.current = revision + 1; setRevision(revision + 1); };
  return <section className="wide" aria-label={`${label} relationship`}>
    <div className="filterBar"><label>Search {kind}s<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setSearch(query); } }} /></label><button type="button" onClick={() => { setSearch(query); setRevision((previous) => previous + 1); }}>Find {kind}s</button></div>
    <ReadNotice {...currentRead} hasData={visible.length > 0} label={`${kind} options`} onRetry={() => setRevision((previous) => previous + 1)} />
    <label>{label} ({required ? "required" : "optional"})<select ref={selectRef} required={required} value={value} disabled={!ready} onChange={(event) => onChange(event.target.value)}><option value="">No {kind}</option>{value !== "" && !visible.some((item) => item.id === value) && <option value={value}>Current ID: {value}</option>}{visible.map((item) => <option key={item.id} value={item.id}>{item.name || item.email || item.label || item.project || item.id}{(item.name || item.email || item.label || item.project) ? ` · ${item.id}` : ""}</option>)}</select></label>

    {ready && visible.length === 0 && <p className="muted">No {kind}s match. Try another search or enter the full ID below.</p>}
    {ready && visible.length === 0 && value === "" && currentRead.error === null && emptyAction?.(selectCreated)}
    <details><summary>Enter {kind} ID manually</summary><p className="muted">Use this when lookup cannot resolve the {kind}. Enter the complete identifier.</p><label>{label} ID<input name={`${kind}_id`} maxLength={128} value={value} onChange={(event) => onChange(event.target.value)} /></label></details>
  </section>;
}

/** `protectedProject` is set for a protected create: licenses narrow to it, and one can be created. */
export function EntitlementRelationships({ customerId, licenseId, onCustomerChange, onLicenseChange, required = false, protectedProject = "" }: { customerId: string; licenseId: string; required?: boolean; protectedProject?: string; onCustomerChange: (value: string) => void; onLicenseChange: (value: string) => void }): React.ReactElement {
  const createLicense = protectedProject !== "" && customerId !== ""
    ? (selectCreated: (id: string) => void) => <CreateLicenseButton customerId={customerId} project={protectedProject} onCreated={selectCreated} />
    : undefined;
  return <><RelationshipLookup kind="customer" required={required} value={customerId} onChange={onCustomerChange} /><RelationshipLookup kind="license" required={required} value={licenseId} onChange={onLicenseChange} scope={customerId} project={protectedProject} emptyAction={createLicense} /></>;
}
