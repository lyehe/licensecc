import { dateInputToEpoch } from "../../shared/dates";

/** The entitlement_events.event_type CHECK constraint values (schema.sql), for the filter select. */
export const EVENT_TYPES = ["create", "update", "disable", "reenable", "revoke", "upsert", "revoked-override"] as const;

export interface EventFilter {
  entitlement_id?: string;
  project: string;
  feature: string;
  event_type: string;
  actor: string;
  /** <input type="date"> values (YYYY-MM-DD), UTC-anchored like the entitlement validity fields. */
  since: string;
  until: string;
}

export const emptyEventFilter: EventFilter = { project: "", feature: "", event_type: "", actor: "", since: "", until: "" };

/** A malformed intermediate value should never reach the query string; a native date input only
 * ever commits empty or a well-formed date, so this is a defensive fallback, not the common path. */
function dateFilterToEpoch(value: string, label: string): number | null {
  if (value === "") return null;
  try {
    return dateInputToEpoch(value, label);
  } catch {
    return null;
  }
}

export function eventsPath(filter: EventFilter, cursor: string | null = null): string {
  const params = new URLSearchParams();
  if (filter.entitlement_id) params.set("entitlement_id", filter.entitlement_id);
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.feature !== "") params.set("feature", filter.feature);
  if (filter.event_type !== "") params.set("event_type", filter.event_type);
  if (filter.actor !== "") params.set("actor", filter.actor);
  const since = dateFilterToEpoch(filter.since, "since");
  if (since !== null) params.set("since", String(since));
  // `until` names a whole calendar day (UTC); its epoch is that day's LAST second, so a same-day
  // since/until pair still matches an event created any time during that day.
  const until = dateFilterToEpoch(filter.until, "until");
  if (until !== null) params.set("until", String(until + 86399));
  if (cursor !== null) params.set("cursor", cursor);
  return `/api/admin/events${params.size === 0 ? "" : `?${params.toString()}`}`;
}

/** A "History" deep link from an entitlement row names the exact entitlement; only then does the
 * list show the "Showing events for 1 entitlement" banner. */
export function isSingleEntitlementEventsFilter(filter: Pick<EventFilter, "entitlement_id">): boolean {
  return typeof filter.entitlement_id === "string" && filter.entitlement_id !== "";
}

/** "Show all" drops the deep link's identity filter and keeps only the plain browsing filters. */
export function eventsFilterAfterShowAll(filter: EventFilter): EventFilter {
  return { project: filter.project, feature: filter.feature, event_type: filter.event_type, actor: filter.actor, since: filter.since, until: filter.until };
}
