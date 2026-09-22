import { useAdminNavigation } from "../../app/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { formatEpoch } from "../../shared/format";
import { Entitlements } from "../entitlements/Entitlements";
import type { EntitlementFilter } from "../entitlements/workflow";
import { hasEntitlementRecordData } from "../../shared/mutationGuards";

type Row = Record<string, unknown>;
type Page = { items: Row[]; next_cursor: string | null; customer?: { id: string }; server_time?: number };
function isRow(value: unknown): value is Row { return typeof value === "object" && value !== null && !Array.isArray(value); }
function PagedRecords({ url, code, customerId, kind, render }: {
  url: string; code: string; customerId: string; kind: "apps" | "grants" | "nodes" | "sessions";
  render(rows: Row[], serverTime: number): React.ReactNode;
}): React.ReactElement {
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const consumed = useRef(new Set<string>());
  const failedCursor = useRef<string | null>(null);
  const loadedKeys = useRef(new Set<string>());
  const load = useCallback(async (next: string | null): Promise<void> => {
    const ticket = ++generation.current;
    failedCursor.current = next;
    setBusy(true); setError("");
    try {
      const path = new URL(url, window.location.origin);
      if (next !== null) path.searchParams.set("cursor", next);
      const response = await api<Page>(path.pathname + path.search);
      if (ticket !== generation.current) return;
      const parsed = parseExactApiSuccess<Page>(response, code, (data) => {
        if (!isRow(data) || !Array.isArray(data.items) || !(data.next_cursor === null || typeof data.next_cursor === "string")) return false;
        if (kind !== "grants" && (!isRow(data.customer) || data.customer.id !== customerId || typeof data.server_time !== "number")) return false;
        return data.items.every((item: unknown) => {
          if (!isRow(item) || typeof item.project !== "string") return false;
          if (path.searchParams.has("project") && item.project !== path.searchParams.get("project")) return false;
          if (kind === "grants") return hasEntitlementRecordData(item) && item.customer_id === customerId;
          if (kind === "apps") return ["grant_count", "enabled_count", "in_date_count", "no_expiry_count"].every(key => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0)
            && ["earliest_expiry", "latest_expiry"].every(key => item[key] === null || typeof item[key] === "number");
          return typeof item.feature === "string" && typeof item.license_fingerprint === "string" && (kind === "nodes"
            ? typeof item.device_key_id === "string" && typeof item.status === "string" && (item.last_seen_at === null || typeof item.last_seen_at === "number")
            : typeof item.seat_id === "string" && typeof item.mode === "string" && typeof item.heartbeat_deadline === "number");
        });
      });
      if (!parsed) throw new Error(apiFailureMessage(response));
      if (parsed.data.next_cursor !== null && (parsed.data.next_cursor === next || (next !== null && consumed.current.has(parsed.data.next_cursor)))) throw new Error("Pagination changed. Refresh this view.");
      const keys = parsed.data.items.map(item => JSON.stringify([item.project, item.feature, item.license_fingerprint, item.device_key_id, item.seat_id]));
      if (new Set(keys).size !== keys.length || (next !== null && keys.some(key => loadedKeys.current.has(key)))) throw new Error("Records changed between pages. Refresh this view.");
      loadedKeys.current = new Set(next === null ? keys : [...loadedKeys.current, ...keys]);
      if (next === null) consumed.current.clear(); else consumed.current.add(next);
      setRows(previous => next === null ? parsed.data.items : [...previous, ...parsed.data.items]);
      setCursor(parsed.data.next_cursor); setTime(parsed.data.server_time ?? 0);
    } catch (failure) { if (ticket === generation.current) setError(failure instanceof Error ? failure.message : "Unable to load records."); }
    finally { if (ticket === generation.current) setBusy(false); }
  }, [url, code, customerId, kind]);
  useEffect(() => { void load(null); return () => { generation.current++; }; }, [load]);
  return <section aria-busy={busy}>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void load(failedCursor.current)}>Retry</button></p>}
    {busy && <p role="status">Loading…</p>}
    {!busy && !error && rows.length === 0 && <p>No records found.</p>}
    {rows.length > 0 && render(rows, time)}
    <div className="tableFooter"><span>{rows.length} loaded</span><button disabled={busy} onClick={() => { consumed.current.clear(); void load(null); }}>Refresh</button>{cursor !== null && <button disabled={busy} onClick={() => void load(cursor)}>Load more</button>}</div>
  </section>;
}

export function CustomerAccess({ customerId }: { customerId: string }): React.ReactElement {
  const { navigate } = useAdminNavigation();
  const [project, setProject] = useState<string | null>(null);
  const [view, setView] = useState<"grants" | "nodes" | "sessions">("grants");
  const [managed, setManaged] = useState<EntitlementFilter | null>(null);
  const root = `/api/admin/customers/${encodeURIComponent(customerId)}`;
  const url = project === null ? `${root}/apps` : `${root}/${view === "grants" ? "access" : "resources"}?${new URLSearchParams({ project, ...(view === "grants" ? {} : { kind: view }) })}`;
  if (managed) return <Entitlements key={managed.id} active navigationIntent={null} onNavigationHandled={() => undefined} scopedGrant={managed} onExit={() => setManaged(null)} />;
  return <section>
    <div className="actions"><h3>Apps &amp; access</h3><button onClick={() => navigate({ tab: "entitlements", filter: { customer_id: customerId, ...(project ? { project } : {}) } })}>Assign existing license</button></div>
    {project !== null && <><div className="actions"><button onClick={() => setProject(null)}>All apps</button><strong>{project}</strong></div>
      <nav className="sectionTabs" aria-label="App records">{(["grants", "nodes", "sessions"] as const).map(kind => <button key={kind} aria-current={view === kind ? "page" : undefined} onClick={() => setView(kind)}>{kind === "grants" ? "Access grants" : kind === "nodes" ? "Registered nodes" : "Floating sessions"}</button>)}</nav></>}
    <PagedRecords key={url} url={url} customerId={customerId} kind={project === null ? "apps" : view} code={project === null ? "customer_apps" : view === "grants" ? "entitlements_listed" : "customer_resources"} render={(rows, now) => <div className="customerAccessRecords">
      {rows.map(row => <article className="recordCard" key={JSON.stringify([row.project, row.feature, row.license_fingerprint, row.device_key_id, row.seat_id])}>
        {project === null ? <><h4>{String(row.project)}</h4><p>{Number(row.grant_count)} grants · {Number(row.in_date_count)} enabled and within grant dates</p>
          <p>{row.earliest_expiry === row.latest_expiry && Number(row.no_expiry_count) === 0 ? `Valid until ${formatEpoch(Number(row.earliest_expiry))}` : "Mixed or non-expiring validity — view grants"}</p>
          <button onClick={() => { setProject(String(row.project)); setView("grants"); }}>View app</button></> : view === "grants" ? <><h4>{String(row.feature)}</h4><p>{String(row.status)} · Valid until {row.valid_until === null ? "No expiry" : formatEpoch(Number(row.valid_until))}</p>
          <button onClick={() => setManaged({ project, feature: String(row.feature), status: "", id: String(row.id), customer_id: customerId })}>Manage access</button></> : view === "nodes" ? <><h4>{String(row.feature)}</h4><p>{String(row.device_key_id)}</p><p>{String(row.status)} · Last seen {formatEpoch(row.last_seen_at as number | null)}</p></> : <><h4>{String(row.feature)} · {String(row.mode)}</h4><p>{String(row.seat_id)}</p><p>{Number(row.heartbeat_deadline) > now ? "Current" : "Expired"} · Deadline {formatEpoch(Number(row.heartbeat_deadline))}</p></>}
      </article>)}
    </div>} />
    <p className="muted">Grant dates do not override customer suspension or runtime checks. Registered nodes and floating sessions are separate records.</p>
  </section>;
}
