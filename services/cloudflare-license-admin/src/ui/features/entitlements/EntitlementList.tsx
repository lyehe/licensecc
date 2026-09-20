import React from "react";
import type { EntitlementRecord } from "../../../shared/api";
import { ENTITLEMENT_BATCH_MAX_IDS } from "../../../shared/api";
import { ActionMenu } from "../../shared/ActionMenu";
import { ReadNotice } from "../../shared/ReadNotice";
import { focusTargetInRow, focusTargetInSection, type ConfirmActionOutcome, useOperatorControls } from "../../shared/controls";
import { formatEpoch } from "../../shared/format";
import { canEditEntitlement, canRunAction, disableEntitlementConfirm, releaseSeatsConfirm, revokeEntitlementConfirm, type EntitlementAction, type EntitlementFilter } from "./workflow";

interface ListProps {
  scoped?: boolean;
  items: EntitlementRecord[];
  filter: EntitlementFilter;
  onFilter: (filter: EntitlementFilter) => void;
  loading: boolean;
  error: string | null;
  ready: boolean;
  busy: boolean;
  selectedIds: Set<string>;
  selectedCount: number;
  allSelected: boolean;
  onSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onCreate: () => void;
  onEdit: (item: EntitlementRecord, extend?: boolean) => void;
  onRetry: () => void;
  onExport: () => void;
  onLoadMore: (() => void) | null;
  onTransition: (item: EntitlementRecord, action: EntitlementAction, key: string) => Promise<ConfirmActionOutcome>;
  onReleaseSeats: (item: EntitlementRecord, key: string) => Promise<ConfirmActionOutcome>;
  onBatch: (action: EntitlementAction, key: string) => Promise<ConfirmActionOutcome>;
  bulkConfirmBody: (action: EntitlementAction) => string;
  isCurrent: () => boolean;
  deviceEntitlementId: string | null;
  meterEntitlementId: string | null;
  onDevices: (id: string) => void;
  onMeter: (id: string) => void;
}

export function EntitlementValidity({ item }: { item: EntitlementRecord }): React.ReactElement {
  const now = Math.floor(Date.now() / 1000);
  const validity = item.valid_until !== null && item.valid_until <= now ? "Expired" : item.valid_from !== null && item.valid_from > now ? "Not started" : item.valid_until !== null && item.valid_until <= now + 30 * 86400 ? "Expires soon" : null;
  return <><span className={`status ${item.status}`}>{item.status}</span>{validity ? <span className={`healthBadge health-${validity === "Expired" ? "expired" : validity === "Expires soon" ? "expiring" : "pending"}`}>{validity}</span> : null}<div className="muted">{item.valid_until === null ? "No expiry" : `Expires ${formatEpoch(item.valid_until)}`}</div></>;
}

function EntitlementDetails({ item }: { item: EntitlementRecord }): React.ReactElement {
  return <details><summary>Technical details</summary><dl className="recordMeta"><div><dt>Entitlement ID</dt><dd><code>{item.id}</code></dd></div><div><dt>License fingerprint</dt><dd><code>{item.license_fingerprint}</code></dd></div><div><dt>Device restriction</dt><dd><code>{item.device_hash || "None"}</code></dd></div><div><dt>License ID</dt><dd><code>{item.license_id ?? "None"}</code></dd></div><div><dt>Policy ID</dt><dd><code>{item.policy_id ?? "None"}</code></dd></div><div><dt>Assertion TTL</dt><dd>{item.assertion_ttl_seconds} seconds</dd></div><div><dt>Valid from</dt><dd>{item.valid_from === null ? "Starts immediately" : formatEpoch(item.valid_from)}</dd></div><div><dt>Revocation revision</dt><dd>{item.revocation_seq}</dd></div><div><dt>Maximum borrow</dt><dd>{item.max_borrow_sec} seconds</dd></div><div><dt>Notes</dt><dd>{item.notes || "None"}</dd></div></dl></details>;
}

export function EntitlementList(props: ListProps): React.ReactElement {
  const { items, busy, ready, filter, onFilter, selectedCount, onTransition, onReleaseSeats, isCurrent } = props;
  const { requestConfirm, runConsequenceAction } = useOperatorControls();
  const locked = busy || !ready;
  const filtered = Object.values(filter).some((value) => value !== "");
  function actions(item: EntitlementRecord): React.ReactElement {
    const focus = focusTargetInRow(`entitlement:${item.id}`, ['button[data-focus-action="reenable"]', ".status"]);
    return <div className="actions"><button disabled={locked || !canEditEntitlement(item.status)} onClick={() => props.onEdit(item)}>Edit</button><ActionMenu label="More actions">
      <button disabled={locked || !canEditEntitlement(item.status)} onClick={() => props.onEdit(item, true)}>Extend validity</button>
      <button data-focus-action="disable" className="danger" disabled={locked || !canRunAction(item.status, "disable")} onClick={() => requestConfirm({ title: "Disable entitlement", body: disableEntitlementConfirm(item), requiresReason: true, run: ({ idempotencyKey }) => onTransition(item, "disable", idempotencyKey), successFocusTarget: focus, isCurrent })}>Disable</button>
      <button data-focus-action="reenable" disabled={locked || !canRunAction(item.status, "reenable")} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }) => onTransition(item, "reenable", idempotencyKey), successFocusTarget: focus, isCurrent })}>Reenable</button>
      <button className="danger" disabled={locked || !canRunAction(item.status, "revoke")} onClick={() => requestConfirm({ title: "Revoke entitlement", body: revokeEntitlementConfirm(item), requiresReason: true, run: ({ idempotencyKey }) => onTransition(item, "revoke", idempotencyKey), successFocusTarget: focus, isCurrent })}>Revoke</button>
      {!props.scoped && <><button className="danger" disabled={locked || item.license_mode !== "floating" || item.status !== "active"} onClick={() => requestConfirm({ title: "Release seats", body: releaseSeatsConfirm(item), requiresReason: true, run: ({ idempotencyKey }) => onReleaseSeats(item, idempotencyKey), successFocusTarget: focus, isCurrent })}>Release seats</button>
      <button disabled={busy} aria-expanded={props.deviceEntitlementId === item.id} onClick={() => props.onDevices(item.id)}>Devices</button>
      <button disabled={busy} aria-expanded={props.meterEntitlementId === item.id} onClick={() => props.onMeter(item.id)}>Meter</button></>}
      <p className="muted">{item.status === "revoked" ? "Revocation is permanent. Editing and lifecycle changes are unavailable." : item.status === "active" ? "Disable pauses access; Reenable applies to disabled records." : "Reenable restores the record; Disable applies to active records."} {!props.scoped && "Release seats requires an active floating entitlement."}</p>
    </ActionMenu></div>;
  }
  function selection(item: EntitlementRecord): React.ReactElement | null {
    if (props.scoped) return null;
    return <input type="checkbox" aria-label={`Select ${item.project}/${item.feature}`} checked={props.selectedIds.has(item.id)} disabled={locked || (!props.selectedIds.has(item.id) && selectedCount >= ENTITLEMENT_BATCH_MAX_IDS)} onChange={() => props.onSelect(item.id)} />;
  }
  const capacity = (item: EntitlementRecord): React.ReactElement => <><div>{item.license_mode?.replaceAll("_", " ") || "Default mode"}</div><span className="muted">Pool {item.pool_size} · Maximum devices {item.max_active_devices}</span></>;
  return <section className="tablePane" data-focus-section="entitlements" aria-label="Entitlement list">
    {filter.id && <p role="status">Showing the selected grant for customer {filter.customer_id}. {!props.scoped && "Clear filters to browse all grants. This selection lasts for this navigation session."}</p>}
    {!props.scoped && <><div className="listHeader"><button type="button" className="primary" disabled={busy} onClick={props.onCreate}>New entitlement</button></div>
    <div className="filterBar"><label>Project filter<input aria-label="Filter by project" value={filter.project} onChange={(event) => onFilter({ ...filter, project: event.target.value })} /></label><label>Feature filter<input aria-label="Filter by feature" value={filter.feature} onChange={(event) => onFilter({ ...filter, feature: event.target.value })} /></label><label>Status filter<select aria-label="Filter by status" value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">All statuses</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="revoked">Revoked</option></select></label><button type="button" disabled={!filtered} onClick={() => onFilter({ project: "", feature: "", status: "" })}>Clear filters</button><button type="button" disabled={busy} onClick={props.onExport}>Export CSV</button></div>
    <p className="muted">CSV export: up to 10,000 filtered records.</p></>}
    <ReadNotice loading={props.loading} error={props.error} hasData={items.length > 0} label="entitlements" onRetry={props.onRetry} />
    {!ready && items.length > 0 && <p className="muted">Actions are unavailable until the current list read succeeds.</p>}
    {selectedCount > 0 && <div className="bulkBar"><span>{selectedCount} selected (maximum {ENTITLEMENT_BATCH_MAX_IDS} per batch)</span><button type="button" disabled={locked} onClick={() => requestConfirm({ title: "Disable selected entitlements", body: props.bulkConfirmBody("disable"), requiresReason: true, run: ({ idempotencyKey }) => props.onBatch("disable", idempotencyKey), successFocusTarget: focusTargetInSection("entitlements"), isCurrent })}>Disable</button><button type="button" disabled={locked} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }) => props.onBatch("reenable", idempotencyKey), successFocusTarget: focusTargetInSection("entitlements"), isCurrent })}>Reenable</button><button type="button" className="danger" disabled={locked} onClick={() => requestConfirm({ title: "Revoke selected entitlements", body: props.bulkConfirmBody("revoke"), requiresReason: true, run: ({ idempotencyKey }) => props.onBatch("revoke", idempotencyKey), successFocusTarget: focusTargetInSection("entitlements"), isCurrent })}>Revoke selected</button><button type="button" disabled={busy} onClick={props.onClearSelection}>Clear</button></div>}
    <div className="desktopRecords tableScroll" role="region" aria-label="Entitlement records" tabIndex={0}><table><thead><tr><th className="checkCol">{!props.scoped && <input type="checkbox" aria-label={`Select all loaded rows (up to ${ENTITLEMENT_BATCH_MAX_IDS})`} disabled={locked} checked={props.allSelected} onChange={props.onSelectAll} />}</th><th>Project / feature</th><th>Customer or identifier</th><th>Status / validity</th><th>Capacity</th><th>Actions</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} data-focus-row={`entitlement:${item.id}`}><td className="checkCol">{selection(item)}</td><td><strong>{item.project}</strong><div>{item.feature}</div><EntitlementDetails item={item} /></td><td><code>{item.customer_id ?? item.id}</code></td><td><EntitlementValidity item={item} /></td><td>{capacity(item)}</td><td>{actions(item)}</td></tr>)}</tbody></table></div>
    <div className="recordCards" aria-label="Entitlement summaries">{items.map((item) => <article className="recordCard" key={item.id} data-focus-row={`entitlement:${item.id}`}><div className="listHeader"><h3>{item.project} / {item.feature}</h3>{selection(item)}</div><code>{item.customer_id ?? item.id}</code><div><EntitlementValidity item={item} /></div><div>{capacity(item)}</div>{actions(item)}<EntitlementDetails item={item} /></article>)}</div>
    {ready && items.length === 0 && <div className="emptyState">{filtered ? "No entitlements match these filters." : "No entitlements yet. Create an entitlement to grant access."}</div>}
    <p className="muted">Lifecycle and date validity are shown; other access restrictions may still apply.</p>
    {ready && <div className="tableFooter"><span className="muted">{items.length} loaded</span>{props.onLoadMore && <button type="button" disabled={busy} onClick={props.onLoadMore}>Load more</button>}</div>}
  </section>;
}
