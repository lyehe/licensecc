import React, { useEffect, useRef } from "react";
import type { EntitlementDeviceRecord, EntitlementRecord } from "../../../shared/api";
import { ENTITLEMENT_BATCH_MAX_IDS } from "../../../shared/api";
import { ActionMenu } from "../../shared/ActionMenu";
import { ReadNotice } from "../../shared/ReadNotice";
import { BatchRunPanel } from "./BatchRunPanel";
import { EntitlementInspectorPanel } from "./EntitlementInspectors";
import type { EntitlementBatch } from "./useEntitlementBatch";
import type { useEntitlementInspection } from "./useEntitlementInspection";
import { focusTargetInRow, type ConfirmActionOutcome, useOperatorControls } from "../../shared/controls";
import { hasActiveFilter } from "../../shared/filters";
import { formatUtcDate } from "../../shared/format";
import type { OperatorFeedback } from "../../shared/operatorFeedback";
import { useMediaQuery } from "../../shared/useMediaQuery";
import { focusWorkspaceTarget } from "../../shared/workspaceFocus";
import { canEditEntitlement, canRunAction, disableEntitlementConfirm, ENTITLEMENT_DISABLE_REASON_PRESETS, filterAfterShowAll, isSingleEntitlementFilter, releaseSeatsConfirm, revokeEntitlementConfirm, revokeTypedConfirmation, type DeviceAction, type EntitlementAction, type EntitlementFilter } from "./workflow";

/** The entitlement table's column count, so the inline inspector row's cell spans every column. */
const ENTITLEMENT_TABLE_COLUMN_COUNT = 6;

interface ListProps {
  scoped?: boolean;
  items: EntitlementRecord[];
  filter: EntitlementFilter;
  onFilter: (filter: EntitlementFilter) => void;
  loading: boolean;
  error: OperatorFeedback | null;
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
  batch: EntitlementBatch;
  bulkConfirmBody: (action: EntitlementAction) => string;
  isCurrent: () => boolean;
  inspection: ReturnType<typeof useEntitlementInspection>;
  onDevices: (id: string) => void;
  onMeter: (id: string) => void;
  onDeviceTransition: (device: EntitlementDeviceRecord, action: DeviceAction, key: string) => Promise<ConfirmActionOutcome>;
  onHistory: (item: EntitlementRecord) => void;
}

export function EntitlementValidity({ item }: { item: EntitlementRecord }): React.ReactElement {
  const now = Math.floor(Date.now() / 1000);
  const validity = item.valid_until !== null && item.valid_until <= now ? "Expired" : item.valid_from !== null && item.valid_from > now ? "Not started" : item.valid_until !== null && item.valid_until <= now + 30 * 86400 ? "Expires soon" : null;
  return <><span className={`status ${item.status}`}>{item.status === "disabled" ? "suspended" : item.status}</span>{validity ? <span className={`healthBadge health-${validity === "Expired" ? "expired" : validity === "Expires soon" ? "expiring" : "pending"}`}>{validity}</span> : null}<div className="muted">{item.valid_until === null ? "No expiry" : `Expires ${formatUtcDate(item.valid_until)}`}</div></>;
}

function EntitlementDetails({ item }: { item: EntitlementRecord }): React.ReactElement {
  return <details><summary>Technical details</summary><dl className="recordMeta"><div><dt>Entitlement ID</dt><dd><code>{item.id}</code></dd></div><div><dt>License fingerprint</dt><dd><code>{item.license_fingerprint}</code></dd></div><div><dt>Device restriction</dt><dd><code>{item.device_hash || "None"}</code></dd></div><div><dt>License ID</dt><dd><code>{item.license_id ?? "None"}</code></dd></div><div><dt>Policy ID</dt><dd><code>{item.policy_id ?? "None"}</code></dd></div><div><dt>Assertion TTL</dt><dd>{item.assertion_ttl_seconds} seconds</dd></div><div><dt>Valid from</dt><dd>{item.valid_from === null ? "Starts immediately" : formatUtcDate(item.valid_from)}</dd></div><div><dt>Revocation revision</dt><dd>{item.revocation_seq}</dd></div><div><dt>Maximum borrow</dt><dd>{item.max_borrow_sec} seconds</dd></div><div><dt>Notes</dt><dd>{item.notes || "None"}</dd></div></dl></details>;
}

export function EntitlementList(props: ListProps): React.ReactElement {
  const { items, busy, ready, filter, onFilter, selectedCount, onTransition, onReleaseSeats, isCurrent } = props;
  const { requestConfirm, runConsequenceAction } = useOperatorControls();
  const locked = busy || !ready;
  // Exactly one of the table or the card layout renders; CSS hiding the other does not satisfy a
  // DOM that must only ever hold one shape of row.
  const narrow = useMediaQuery("(max-width: 1023px)");
  const filtered = hasActiveFilter(filter);
  // A search or "Expiring soon" deep link focuses its one row once the list settles on it; it never
  // steals focus back on a later, unrelated reload of the same deep link.
  const singleRecordFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const id = filter.id;
    if (!ready || id === undefined || id === "") { singleRecordFocusRef.current = null; return; }
    if (singleRecordFocusRef.current === id) return;
    const match = items.find((item) => item.id === id);
    if (match === undefined) return;
    singleRecordFocusRef.current = id;
    const target = focusTargetInRow(`entitlement:${match.id}`, []);
    focusWorkspaceTarget(typeof target === "function" ? target() : target);
  }, [filter.id, ready, items]);
  function actions(item: EntitlementRecord): React.ReactElement {
    const focus = focusTargetInRow(`entitlement:${item.id}`, ['button[data-focus-action="reenable"]', ".status"]);
    return <div className="actions"><button disabled={locked || !canEditEntitlement(item.status)} onClick={() => props.onEdit(item)}>Edit</button><ActionMenu label="More actions">
      <button disabled={busy} onClick={() => props.onHistory(item)}>History</button>
      {canEditEntitlement(item.status) && <button disabled={locked} onClick={() => props.onEdit(item, true)}>Extend validity</button>}
      {canRunAction(item.status, "disable") && <button data-focus-action="disable" className="danger" disabled={locked} onClick={() => requestConfirm({ title: "Disable entitlement", body: disableEntitlementConfirm(item), requiresReason: true, reasonPresets: ENTITLEMENT_DISABLE_REASON_PRESETS, run: ({ idempotencyKey }) => onTransition(item, "disable", idempotencyKey), successFocusTarget: focus, isCurrent })}>Disable</button>}
      {canRunAction(item.status, "reenable") && <button data-focus-action="reenable" disabled={locked} onClick={() => void runConsequenceAction({ run: ({ idempotencyKey }) => onTransition(item, "reenable", idempotencyKey), successFocusTarget: focus, isCurrent })}>Reenable</button>}
      {canRunAction(item.status, "revoke") && <button className="danger" disabled={locked} onClick={() => requestConfirm({ title: "Revoke entitlement", body: revokeEntitlementConfirm(item), requiresReason: true, confirmLabel: "Revoke", typedConfirmation: revokeTypedConfirmation(1), run: ({ idempotencyKey }) => onTransition(item, "revoke", idempotencyKey), successFocusTarget: focus, isCurrent })}>Revoke</button>}
      {!props.scoped && <>{item.license_mode==="floating" && item.status==="active" && <button className="danger" disabled={locked} onClick={() => requestConfirm({ title: "Release seats", body: releaseSeatsConfirm(item), requiresReason: true, run: ({ idempotencyKey }) => onReleaseSeats(item, idempotencyKey), successFocusTarget: focus, isCurrent })}>Release seats</button>}
      <button data-focus-action="devices" disabled={busy} aria-expanded={props.inspection.deviceEntitlementId === item.id} onClick={() => props.onDevices(item.id)}>Devices</button>
      <button data-focus-action="meter" disabled={busy} aria-expanded={props.inspection.meterEntitlementId === item.id} onClick={() => props.onMeter(item.id)}>Meter</button></>}
    </ActionMenu></div>;
  }
  function selection(item: EntitlementRecord): React.ReactElement | null {
    if (props.scoped) return null;
    return <input type="checkbox" aria-label={`Select ${item.project}/${item.feature}`} checked={props.selectedIds.has(item.id)} disabled={locked} onChange={() => props.onSelect(item.id)} />;
  }
  // One confirmation and one reason cover the whole run, however many chunks it takes.
  const chunkCount = Math.ceil(selectedCount / ENTITLEMENT_BATCH_MAX_IDS);
  function confirmBatch(action: "disable" | "revoke", title: string): void {
    const { run, details } = props.batch.begin(action);
    requestConfirm({
      title,
      body: props.bulkConfirmBody(action),
      details,
      // The batch run panel inside `details` keeps announcing "Chunk k of m" while this runs.
      keepDialogLive: true,
      requiresReason: true,
      ...(action === "revoke" ? { confirmLabel: "Revoke", typedConfirmation: revokeTypedConfirmation(selectedCount) } : { reasonPresets: ENTITLEMENT_DISABLE_REASON_PRESETS }),
      run,
      successFocusTarget: props.batch.focusTarget,
      isCurrent,
    });
  }
  const capacity = (item: EntitlementRecord): React.ReactElement => <><div>{item.license_mode?.replaceAll("_", " ") || "Default mode"}</div><span className="muted">{item.license_mode === "floating" ? <>Pool {item.pool_size}</> : <>Device limit {item.max_active_devices}</>}</span></>;
  // Inline, under the triggering row: the device/metering panel for whichever one entitlement has
  // it open (never more than one; see useEntitlementInspection). Every other row has none.
  const inspectorOpenFor = (item: EntitlementRecord): boolean => props.inspection.deviceEntitlementId === item.id || props.inspection.meterEntitlementId === item.id;
  return <section className="tablePane" data-focus-section="entitlements" aria-label="Entitlement list">
    {isSingleEntitlementFilter(filter) && <p role="status" className="singleRecordBanner">Showing 1 entitlement · <button type="button" onClick={() => onFilter(filterAfterShowAll(filter))}>Show all</button></p>}
    {filter.license_id && <p role="status" className="singleRecordBanner">License {filter.license_id} · <button type="button" onClick={() => onFilter(filterAfterShowAll(filter))}>Show all</button></p>}
    {filter.customer_id && <p role="status">License access for customer {filter.customer_id}. {!props.scoped && "Clear filters to browse all grants. This selection lasts for this navigation session."}</p>}
    {!props.scoped && <><div className="listHeader"><button type="button" className="primary" disabled={busy} onClick={props.onCreate}>New entitlement</button></div>
    <div className="filterBar"><label>Project filter<input aria-label="Filter by project" value={filter.project} onChange={(event) => onFilter({ ...filter, project: event.target.value })} /></label><label>Feature filter<input aria-label="Filter by feature" value={filter.feature} onChange={(event) => onFilter({ ...filter, feature: event.target.value })} /></label><label>Status filter<select aria-label="Filter by status" value={filter.status} onChange={(event) => onFilter({ ...filter, status: event.target.value })}><option value="">All statuses</option><option value="active">Active</option><option value="disabled">Suspended</option><option value="revoked">Revoked</option></select></label><button type="button" disabled={!filtered} onClick={() => onFilter({ project: "", feature: "", status: "" })}>Clear filters</button><button type="button" disabled={busy} onClick={props.onExport}>Export CSV</button></div>
    <p className="muted">CSV export: up to 10,000 filtered records.</p></>}
    <ReadNotice loading={props.loading} error={props.error} hasData={items.length > 0} label="entitlements" onRetry={props.onRetry} />
    {!ready && items.length > 0 && <p className="muted">Actions are unavailable until the current list read succeeds.</p>}
    {!props.scoped && <BatchRunPanel store={props.batch.store} onDismiss={() => props.batch.store.set(null)} />}
    {selectedCount > 0 && <div className="bulkBar"><span>{selectedCount} selected{chunkCount > 1 && <span className="muted"> · sent as {chunkCount} chunks of up to {ENTITLEMENT_BATCH_MAX_IDS}</span>}</span><button type="button" disabled={locked} onClick={() => confirmBatch("disable", "Disable selected entitlements")}>Disable</button><button type="button" disabled={locked} onClick={() => void runConsequenceAction({ run: props.batch.begin("reenable").run, successFocusTarget: props.batch.focusTarget, isCurrent })}>Reenable</button><button type="button" className="danger" disabled={locked} onClick={() => confirmBatch("revoke", "Revoke selected entitlements")}>Revoke selected</button><button type="button" disabled={busy} onClick={props.onClearSelection}>Clear</button></div>}
    {narrow
      ? <div className="recordCards" aria-label="Entitlement summaries" aria-busy={props.loading}>{items.flatMap((item) => {
          const card = <article className="recordCard" key={item.id} data-focus-row={`entitlement:${item.id}`}><div className="listHeader"><h3>{item.project} / {item.feature}</h3>{selection(item)}</div><code>{item.customer_id ?? item.id}</code><div><EntitlementValidity item={item} /></div><div>{capacity(item)}</div>{actions(item)}<EntitlementDetails item={item} /></article>;
          if (!inspectorOpenFor(item)) return [card];
          return [card, <div className="inspectorCard" key={`${item.id}-inspector`}><EntitlementInspectorPanel entitlementId={item.id} inspection={props.inspection} busy={busy} onDeviceTransition={props.onDeviceTransition} /></div>];
        })}</div>
      : <div className="desktopRecords tableScroll" role="region" aria-label="Entitlement records" tabIndex={0} aria-busy={props.loading}><table><thead><tr><th className="checkCol">{!props.scoped && <input type="checkbox" aria-label={`Select all ${items.length} loaded`} disabled={locked} checked={props.allSelected} onChange={props.onSelectAll} />}</th><th>Project / feature</th><th>Customer or identifier</th><th>Status / validity</th><th>Capacity</th><th>Actions</th></tr></thead><tbody>{items.flatMap((item) => {
          const row = <tr key={item.id} data-focus-row={`entitlement:${item.id}`}><td className="checkCol">{selection(item)}</td><td className="entitlementIdentity"><strong>{item.project}</strong><div>{item.feature}</div><EntitlementDetails item={item} /></td><td><code>{item.customer_id ?? item.id}</code></td><td><EntitlementValidity item={item} /></td><td>{capacity(item)}</td><td>{actions(item)}</td></tr>;
          if (!inspectorOpenFor(item)) return [row];
          return [row, <tr className="inspectorRow" key={`${item.id}-inspector`}><td colSpan={ENTITLEMENT_TABLE_COLUMN_COUNT}><EntitlementInspectorPanel entitlementId={item.id} inspection={props.inspection} busy={busy} onDeviceTransition={props.onDeviceTransition} /></td></tr>];
        })}</tbody></table></div>}
    {ready && items.length === 0 && <div className="emptyState">{filtered ? "No entitlements match these filters." : "No entitlements yet. Create an entitlement to grant access."}</div>}
    <p className="muted">Lifecycle and date validity are shown; other access restrictions may still apply.</p>
    {ready && <div className="tableFooter"><span className="muted">{items.length} loaded</span>{props.onLoadMore && <button type="button" disabled={busy} onClick={props.onLoadMore}>Load more</button>}</div>}
  </section>;
}
