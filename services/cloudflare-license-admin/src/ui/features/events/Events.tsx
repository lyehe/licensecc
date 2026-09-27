import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NavigationIntent } from "../../app/types";
import { useAdminNavigation } from "../../app/navigation";
import { ReadNotice } from "../../shared/ReadNotice";
import { api, apiFailureDetails, apiFailureMessage, parseExactApiSuccess } from "../../shared/api";
import { ConfirmRefreshFailure, EXACT_READ_PROOF, type ExactReadProof, useContextGeneration, useOperatorControls } from "../../shared/controls";
import { useCoreRefresh } from "../../shared/coreRefresh";
import { formatEpoch, shortHash } from "../../shared/format";
import { downloadCsv } from "../../shared/pagination";
import { hasEventListData } from "../../shared/mutationGuards";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { useRequestFence } from "../../shared/requestFence";
import { EVENT_TYPES, emptyEventFilter, eventsFilterAfterShowAll, eventsPath, type EventFilter, isSingleEntitlementEventsFilter } from "./workflow";

interface EventItem {
  id: number;
  event_type: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  source: string;
  actor: string;
  actor_type: string;
  revocation_seq: number;
  reason: string;
  detail: string;
  created_at: number;
}

export function Events({ active, navigationIntent, onNavigationHandled }: {
  active: boolean;
  navigationIntent: NavigationIntent | null;
  onNavigationHandled: (intent: NavigationIntent) => void;
}): React.ReactElement | null {
  const [eventsSnapshot, setEvents] = useState<EventItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventFilter>(emptyEventFilter);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { rememberFilters } = useAdminNavigation();
  const { busy: requestBusy, operationLocked, runMutation, setMessage } = useOperatorControls();
  const busy = requestBusy || operationLocked;
  const { registerCoreRefresh } = useCoreRefresh();
  const filterUrl = useMemo(() => eventsPath(filter), [filter]);
  const eventsFence = useRequestFence(filterUrl);
  // Same generation-debounce discipline as the other lists (Workstream E1): the debounced
  // GENERATION, not the filter string, so an A -> B -> A filter change inside one debounce window
  // still reloads. A page change (Next) is a deliberate click, not typing, so it reloads at once.
  const { generation: rawFilterGeneration, isCurrent: isRawFilterGenerationCurrent } = useContextGeneration(filterUrl);
  const filterReloadGeneration = useDebouncedValue(rawFilterGeneration, 300);
  const lastRequestedGeneration = useRef<number | null>(null);

  const load = useCallback(async (targetCursor: string | null, strict = false, isCurrent: () => boolean = () => true): Promise<ExactReadProof | null> => {
    if (!isCurrent()) return null;
    const ticket = eventsFence.begin();
    setLoading(true); setReadError(null);
    const response = await api<{ items: EventItem[]; next_cursor: string | null }>(eventsPath(filter, targetCursor));
    if (!isCurrent() || !eventsFence.isCurrent(ticket)) return null;
    setLoading(false);
    const parsed = parseExactApiSuccess<{ items: EventItem[]; next_cursor: string | null }>(response, "events_listed", hasEventListData);
    if (parsed !== null) {
      if (eventsFence.settle(ticket)) {
        setEvents(parsed.data.items);
        setCursor(targetCursor);
        setNextCursor(parsed.data.next_cursor ?? null);
        return EXACT_READ_PROOF;
      }
    } else if (strict) {
      setReadError(apiFailureMessage(response));
      const failure = apiFailureDetails(response);
      throw new ConfirmRefreshFailure(failure.code, failure.requestId);
    } else {
      setReadError(apiFailureMessage(response));
      setMessage(apiFailureMessage(response));
    }
    return null;
  }, [eventsFence, filter, setMessage]);

  useEffect(() => {
    return registerCoreRefresh(() => load(null));
  }, [load, registerCoreRefresh]);

  useEffect(() => {
    if (navigationIntent?.tab !== "events") return;
    setFilter({ ...emptyEventFilter, entitlement_id: navigationIntent.filter.entitlement_id });
    onNavigationHandled(navigationIntent);
  }, [navigationIntent, onNavigationHandled]);

  useEffect(() => {
    if (!active || navigationIntent?.tab === "events") return;
    rememberFilters("events", { ...filter, entitlement_id: filter.entitlement_id ?? "" });
  }, [active, filter, navigationIntent, rememberFilters]);

  // A filter change reloads page one; entering or leaving this tab with the filter unchanged
  // dispatches nothing, since the generation only advances when the debounced filter itself changes.
  useEffect(() => {
    if (!active || lastRequestedGeneration.current === filterReloadGeneration) return;
    lastRequestedGeneration.current = filterReloadGeneration;
    void load(null, false, () => isRawFilterGenerationCurrent(filterReloadGeneration));
  }, [active, filterReloadGeneration, isRawFilterGenerationCurrent, load]);

  const events = eventsSnapshot;
  const filtered = Object.values(filter).some((value) => value !== undefined && value !== "");

  if (!active) {
    return null;
  }
  return (
    <section className="tablePane full">
      <ReadNotice label="events" loading={loading} error={readError} hasData={eventsFence.isSettled()} onRetry={() => void load(cursor)} />
      {isSingleEntitlementEventsFilter(filter) && <p role="status" className="singleRecordBanner">Showing events for 1 entitlement · <button type="button" onClick={() => setFilter(eventsFilterAfterShowAll(filter))}>Show all</button></p>}
      <div className="filters filterBar" aria-label="Event filters">
        <label>Project<input aria-label="Filter events by project" value={filter.project} onChange={(event) => setFilter({ ...filter, project: event.target.value })} /></label>
        <label>Feature<input aria-label="Filter events by feature" value={filter.feature} onChange={(event) => setFilter({ ...filter, feature: event.target.value })} /></label>
        <label>Event type<select aria-label="Filter events by type" value={filter.event_type} onChange={(event) => setFilter({ ...filter, event_type: event.target.value })}><option value="">All event types</option>{EVENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        {/* Actor/since/until are the less-common filters; a closed disclosure keeps the narrow-viewport
            filter bar as short as the other lists' (project/feature/status), not roughly double it. */}
        <details className="advancedSettings"><summary>More filters</summary><div className="filters filterBar">
          <label>Actor<input aria-label="Filter events by actor" value={filter.actor} onChange={(event) => setFilter({ ...filter, actor: event.target.value })} /></label>
          <label>Since<input aria-label="Filter events since" type="date" min="1970-01-01" value={filter.since} onChange={(event) => setFilter({ ...filter, since: event.target.value })} /></label>
          <label>Until<input aria-label="Filter events until" type="date" min="1970-01-01" value={filter.until} onChange={(event) => setFilter({ ...filter, until: event.target.value })} /></label>
        </div></details>
        <button type="button" disabled={!filtered} onClick={() => setFilter(emptyEventFilter)}>Clear filters</button>
        <button type="button" disabled={busy || operationLocked} onClick={() => void downloadCsv(eventsPath(filter), "events.csv", runMutation, setMessage)}>Export CSV</button>
      </div>
      <div className="tableScroll" role="region" aria-label="Audit event records" aria-busy={loading} tabIndex={0}><table>
        <thead><tr><th>Time</th><th>Event</th><th>Project</th><th>Feature</th><th>Reason</th><th>Actor</th><th>Details</th></tr></thead>
        <tbody>
          {events.map((item) => (
            <tr key={item.id}>
              <td>{formatEpoch(item.created_at)}</td>
              <td>{item.event_type}</td>
              <td>{item.project}</td>
              <td>{item.feature}</td>
              <td>{item.reason || "—"}</td>
              <td>{item.actor || "—"}</td>
              <td><details><summary>Event details</summary><dl className="recordMeta"><div><dt>License</dt><dd><code>{shortHash(item.license_fingerprint)}</code></dd></div><div><dt>Source</dt><dd>{item.source}</dd></div><div><dt>Actor type</dt><dd>{item.actor_type}</dd></div><div><dt>Detail</dt><dd>{item.detail}</dd></div><div><dt>Revision</dt><dd>{item.revocation_seq}</dd></div></dl></details></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {!loading && readError === null && events.length === 0 && <p className="emptyState">{filtered ? "No events match these filters." : "No recent events."}</p>}
      <div className="tableFooter"><span className="muted">{eventsFence.isSettled() ? `${events.length} shown` : ""}</span>{eventsFence.isSettled() && nextCursor !== null && <button type="button" disabled={busy} onClick={() => void load(nextCursor)}>Next page</button>}</div>
    </section>
  );
}
