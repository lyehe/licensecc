import type {
  EntitlementInput,
  EntitlementPatch,
  EntitlementRecord,
  EntitlementStatus,
  ExpiryStrategy,
  PolicyInput,
  PolicyType,
  TrialExpirationBasis,
} from "../shared/api";

export type EntitlementAction = "disable" | "reenable" | "revoke";

export interface EntitlementFilter {
  project: string;
  feature: string;
  status: string;
}

export interface EntitlementFormState {
  // When set (non-empty), the create submits `policy_id` so the backend STAMPS the entitlement
  // from that template (gated by POLICY_STAMP_MODE=on). Empty -> a plain direct create. The other
  // fields then act as per-field overrides on the stamp (matching the backend createFromPolicy seam).
  policy_id: string;
  project: string;
  feature: string;
  license_fingerprint: string;
  device_hash: string;
  assertion_ttl_seconds: number;
  // valid_from / valid_until are now `YYYY-MM-DD` strings from <input type="date"> (empty = unset),
  // converted to epoch seconds on submit by dateInputToEpoch.
  valid_from: string;
  valid_until: string;
  notes: string;
  customer_id: string;
  license_id: string;
}

export interface EntitlementEditState {
  device_hash: string;
  assertion_ttl_seconds: number;
  // `YYYY-MM-DD` date strings (see EntitlementFormState), converted to epoch on submit.
  valid_from: string;
  valid_until: string;
  notes: string;
  customer_id: string;
  license_id: string;
}

export const emptyEntitlementForm: EntitlementFormState = {
  policy_id: "",
  project: "DEFAULT",
  feature: "DEFAULT",
  license_fingerprint: "",
  device_hash: "",
  assertion_ttl_seconds: 300,
  valid_from: "",
  valid_until: "",
  notes: "",
  customer_id: "",
  license_id: "",
};

export const emptyEntitlementEditForm: EntitlementEditState = {
  device_hash: "",
  assertion_ttl_seconds: 300,
  valid_from: "",
  valid_until: "",
  notes: "",
  customer_id: "",
  license_id: "",
};

export function shortHash(value: string): string {
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

export function entitlementsPath(filter: EntitlementFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.feature !== "") params.set("feature", filter.feature);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/entitlements${params.size === 0 ? "" : `?${params.toString()}`}`;
}

function parseBoundedInteger(value: number, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

// (The former parseOptionalEpoch — raw integer-epoch parsing — was replaced by the date
// converters below now that the Valid-from/until inputs are <input type="date">.)

// ── Date <-> epoch converters (pure, unit-tested) ────────────────────────────
// The Valid-from / Valid-until inputs are <input type="date"> (YYYY-MM-DD). We interpret the
// calendar day as UTC midnight so the epoch is deterministic and timezone-independent (the same
// operator on any host produces the same stored boundary). Empty string -> null (unset).
//
// dateInputToEpoch("1970-01-01") === 0, ("2024-03-09") === 1709942400.
export function dateInputToEpoch(value: string, label: string): number | null {
  if (value === "") {
    return null;
  }
  // Strict YYYY-MM-DD so a typo / partial value is rejected rather than silently coerced.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}_must_be_a_valid_date`);
  }
  const epochMs = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(epochMs) || epochMs < 0) {
    throw new Error(`${label}_must_be_a_valid_date`);
  }
  return Math.floor(epochMs / 1000);
}

// epochToDateInput reverses dateInputToEpoch: epoch seconds -> the UTC YYYY-MM-DD it falls on.
// null/undefined -> "" (empty input). Used to seed the edit form from a stored epoch.
export function epochToDateInput(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function parseNotes(value: string): string {
  if (value.length > 1000 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("notes_must_be_at_most_1000_chars");
  }
  return value;
}

function parseNullableIdentifier(value: string, label: string): string | null {
  if (value === "") {
    return null;
  }
  if (value.length > 128 || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label}_must_be_at_most_128_chars`);
  }
  return value;
}

export function normalizeEntitlementForm(form: EntitlementFormState): EntitlementInput {
  return {
    project: form.project,
    feature: form.feature,
    license_fingerprint: form.license_fingerprint,
    device_hash: form.device_hash,
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    valid_from: dateInputToEpoch(form.valid_from, "valid_from"),
    valid_until: dateInputToEpoch(form.valid_until, "valid_until"),
    notes: parseNotes(form.notes),
    customer_id: parseNullableIdentifier(form.customer_id, "customer_id"),
    license_id: parseNullableIdentifier(form.license_id, "license_id"),
  };
}

// Build the create body for the "pick a policy then override" flow. When a policy is selected
// the backend STAMPS from it; we send policy_id PLUS the (override) fields. Empty/unset override
// fields (date strings -> null, empty identifiers -> null) are still sent — the backend treats a
// present-but-null override as an explicit value, so we only attach policy_id and let the standard
// EntitlementInput ride along as overrides. The target tuple (project/feature/fingerprint) is required.
export function normalizeCreateFromPolicy(form: EntitlementFormState): EntitlementInput & { policy_id: string } {
  return { ...normalizeEntitlementForm(form), policy_id: form.policy_id };
}

export function editFormFromEntitlement(item: EntitlementRecord): EntitlementEditState {
  return {
    device_hash: item.device_hash,
    assertion_ttl_seconds: item.assertion_ttl_seconds,
    valid_from: epochToDateInput(item.valid_from),
    valid_until: epochToDateInput(item.valid_until),
    notes: item.notes,
    customer_id: item.customer_id ?? "",
    license_id: item.license_id ?? "",
  };
}

export function normalizeEntitlementPatch(form: EntitlementEditState): EntitlementPatch {
  return {
    device_hash: form.device_hash,
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    valid_from: dateInputToEpoch(form.valid_from, "valid_from"),
    valid_until: dateInputToEpoch(form.valid_until, "valid_until"),
    notes: parseNotes(form.notes),
    customer_id: parseNullableIdentifier(form.customer_id, "customer_id"),
    license_id: parseNullableIdentifier(form.license_id, "license_id"),
  };
}

export function patchPath(item: Pick<EntitlementRecord, "id">): string {
  return `/api/admin/entitlements/${item.id}`;
}

export function transitionPath(item: Pick<EntitlementRecord, "id">, action: EntitlementAction): string {
  return `/api/admin/entitlements/${item.id}/${action}`;
}

export function canEditEntitlement(status: EntitlementStatus): boolean {
  return status !== "revoked";
}

export function canRunAction(status: EntitlementStatus, action: EntitlementAction): boolean {
  if (action === "disable") {
    return status === "active";
  }
  if (action === "reenable") {
    return status === "disabled";
  }
  return status !== "revoked";
}

export interface CustomerListFilter {
  status: string;
  q: string;
}

export function customersPath(filter: CustomerListFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== "") params.set("status", filter.status);
  if (filter.q !== "") params.set("q", filter.q);
  return `/api/admin/customers${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function customerDetailPath(id: string): string {
  return `/api/admin/customers/${encodeURIComponent(id)}`;
}

export type CustomerAction = "disable" | "reenable";

export function customerTransitionPath(id: string, action: CustomerAction): string {
  return `/api/admin/customers/${encodeURIComponent(id)}/${action}`;
}

export function canRunCustomerAction(status: string, action: CustomerAction): boolean {
  if (action === "disable") {
    return status === "active";
  }
  return status === "disabled";
}

export interface LicenseListFilter {
  project: string;
  customer_id: string;
  q: string;
}

export function licensesPath(filter: LicenseListFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.customer_id !== "") params.set("customer_id", filter.customer_id);
  if (filter.q !== "") params.set("q", filter.q);
  return `/api/admin/licenses${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export interface OrderListFilter {
  status: string;
  subscription_id: string;
}

export function ordersPath(filter: OrderListFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== "") params.set("status", filter.status);
  if (filter.subscription_id !== "") params.set("subscription_id", filter.subscription_id);
  return `/api/admin/orders${params.size === 0 ? "" : `?${params.toString()}`}`;
}

// ── License-policy templates (Stage 5 UI) ────────────────────────────────────
// Pure helpers for the Policies tab: list/detail/transition path builders and the policy editor
// form normalizer. They mirror the entitlement helpers' shape (URLSearchParams filters, bounded
// validators throwing `<label>_must_be_*` errors) so the React layer stays declarative.

export interface PolicyFilter {
  project: string;
  type: string;
  status: string;
}

export function policiesPath(filter: PolicyFilter): string {
  const params = new URLSearchParams();
  if (filter.project !== "") params.set("project", filter.project);
  if (filter.type !== "") params.set("type", filter.type);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/policies${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function policyPath(id: string): string {
  return `/api/admin/policies/${encodeURIComponent(id)}`;
}

export type PolicyAction = "disable" | "reenable";

export function policyTransitionPath(id: string, action: PolicyAction): string {
  return `/api/admin/policies/${encodeURIComponent(id)}/${action}`;
}

export function canRunPolicyAction(status: string, action: PolicyAction): boolean {
  if (action === "disable") {
    return status === "active";
  }
  return status === "disabled";
}

// Confirm copy for disabling a policy template (a meaningful action: it blocks NEW stamps, though
// already-stamped entitlements are frozen and untouched). Pure (unit-tested).
export function disablePolicyConfirm(policy: { name: string; type: string }): string {
  return `Disable policy "${policy.name}" (${policy.type}). New entitlements can no longer be stamped from it; already-stamped entitlements are frozen and unaffected.`;
}

// The editor form. type is required and frozen post-create; the Trial sub-panel fields only matter
// when type === "trial". All numeric fields are kept as numbers (parsed/bounded on submit).
export interface PolicyFormState {
  project: string;
  name: string;
  type: PolicyType;
  valid_from_offset_sec: string;
  duration_sec: string;
  assertion_ttl_seconds: number;
  pool_size: number;
  max_active_devices: number;
  max_borrow_sec: number;
  expiry_strategy: ExpiryStrategy;
  trial_expiration_basis: TrialExpirationBasis;
  trial_duration_sec: number;
  trial_one_per_device: boolean;
  trial_require_device_proof: boolean;
  notes: string;
}

export const emptyPolicyForm: PolicyFormState = {
  project: "DEFAULT",
  name: "",
  type: "trial",
  valid_from_offset_sec: "",
  duration_sec: "",
  assertion_ttl_seconds: 300,
  pool_size: 0,
  max_active_devices: 1,
  max_borrow_sec: 0,
  expiry_strategy: "fixed_window",
  trial_expiration_basis: "from_issue",
  trial_duration_sec: 0,
  trial_one_per_device: false,
  trial_require_device_proof: false,
  notes: "",
};

// An optional bounded-integer text field: "" -> null (column default / SQL NULL), else a bounded int.
function parseOptionalBoundedInteger(value: string, label: string, min: number, max: number): number | null {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}_must_be_between_${min}_and_${max}`);
  }
  return parsed;
}

// A generous-but-bounded ceiling (~100 years in seconds) matching the Worker's MAX_DURATION_SECONDS,
// so the client rejects the same absurd/overflow values the server would.
const MAX_POLICY_DURATION_SECONDS = 3_153_600_000;

// Normalize the editor form into the PolicyInput create body. Trial sub-panel fields are always sent
// (the backend ignores them for non-trial types); only the target identity (project/name/type) is
// load-bearing. Throws `<label>_must_be_*` for an out-of-range numeric field so the React layer can
// surface the message, matching normalizeEntitlementForm's contract.
export function normalizePolicyForm(form: PolicyFormState): PolicyInput {
  return {
    project: form.project,
    name: form.name,
    type: form.type,
    valid_from_offset_sec: parseOptionalBoundedInteger(
      form.valid_from_offset_sec, "valid_from_offset_sec", -MAX_POLICY_DURATION_SECONDS, MAX_POLICY_DURATION_SECONDS,
    ),
    duration_sec: parseOptionalBoundedInteger(form.duration_sec, "duration_sec", 0, MAX_POLICY_DURATION_SECONDS),
    assertion_ttl_seconds: parseBoundedInteger(form.assertion_ttl_seconds, "assertion_ttl_seconds", 1, 3600),
    pool_size: parseBoundedInteger(form.pool_size, "pool_size", 0, 1_000_000),
    max_active_devices: parseBoundedInteger(form.max_active_devices, "max_active_devices", 0, 1_000_000),
    max_borrow_sec: parseBoundedInteger(form.max_borrow_sec, "max_borrow_sec", 0, MAX_POLICY_DURATION_SECONDS),
    expiry_strategy: form.expiry_strategy,
    trial_expiration_basis: form.trial_expiration_basis,
    trial_duration_sec: parseBoundedInteger(form.trial_duration_sec, "trial_duration_sec", 0, MAX_POLICY_DURATION_SECONDS),
    trial_one_per_device: form.trial_one_per_device ? 1 : 0,
    trial_require_device_proof: form.trial_require_device_proof ? 1 : 0,
    notes: parseNotes(form.notes),
  };
}

export function formatEpoch(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "-";
  }
  return new Date(value * 1000).toLocaleString();
}

// Append a `cursor` query param to an admin list path (which may already carry filters), for the
// "Load more" pager that consumes the API's next_cursor. Pure so the pagination URL is unit-tested.
export function withCursor(path: string, cursor: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

// Confirmation copy for the irreversible / broad-blast operator actions, echoing the exact target so
// the typed-confirm modal can never fire on the wrong row. Pure (unit-tested).
export function revokeEntitlementConfirm(item: { project: string; feature: string; license_fingerprint: string }): string {
  return `Revoke the entitlement for ${item.project} / ${item.feature} (fingerprint ${shortHash(item.license_fingerprint)}). This is TERMINAL and cannot be undone.`;
}

export function disableCustomerConfirm(customer: { id: string; name: string }): string {
  const who = customer.name !== "" ? `${customer.name} (${customer.id})` : customer.id;
  return `Disable customer ${who}. This immediately severs all of their license/token auth and customer-portal access until you re-enable them.`;
}

// ── Workstream C UI: bulk transitions, global search, CSV export (pure helpers) ───────────────
// All path/parse helpers live here (unit-tested) so the React layer stays a thin, declarative shell
// over them — exactly as the entitlement/customer/policy helpers above. None of these touch the
// shared mutation core; the backend composes transitionEntitlement per-row (createEntitlement is
// byte-identical and untouched).

// The batch transition endpoint. Body { action, reason, ids[] }; one bad row never aborts the rest.
export function batchPath(): string {
  return "/api/admin/entitlements/batch";
}

// Build the body the batch endpoint validates. `reason` rides along (the backend requires it for
// disable/revoke); ids are the encoded entitlement ids of the selected rows. Pure so the body is
// asserted without a network round-trip.
export function batchBody(action: EntitlementAction, ids: ReadonlyArray<string>, reason: string): {
  action: EntitlementAction;
  reason: string;
  ids: string[];
} {
  return { action, reason, ids: [...ids] };
}

// Per-row result the batch endpoint returns (one entry per input id, in input order).
export interface BatchRowResult {
  id: string;
  ok: boolean;
  code: string;
}

// Roll a batch result up into a one-line operator summary, e.g. "12 ok, 1 revoked-terminal, 1 not-found".
// The ok count is collapsed to a single "<n> ok"; every distinct failure code is counted and rendered
// with the `entitlement_`/`_entitlement_is_terminal` noise trimmed to a short slug. Pure (unit-tested).
export function summarizeBatchResults(results: ReadonlyArray<BatchRowResult>): string {
  const okCount = results.filter((row) => row.ok).length;
  const failures = new Map<string, number>();
  for (const row of results) {
    if (!row.ok) {
      const slug = batchFailureSlug(row.code);
      failures.set(slug, (failures.get(slug) ?? 0) + 1);
    }
  }
  const parts: string[] = [`${okCount} ok`];
  for (const [slug, count] of failures) {
    parts.push(`${count} ${slug}`);
  }
  return parts.join(", ");
}

// Shorten a per-row failure code to a compact slug for the summary line. Unknown codes pass through.
function batchFailureSlug(code: string): string {
  if (code === "revoked_entitlement_is_terminal") {
    return "revoked-terminal";
  }
  if (code === "invalid_entitlement_id") {
    return "invalid-id";
  }
  if (code === "not_found") {
    return "not-found";
  }
  if (code === "mutation_failed") {
    return "failed";
  }
  return code;
}

// ── Global search ─────────────────────────────────────────────────────────────
export function searchPath(q: string): string {
  const params = new URLSearchParams();
  params.set("q", q);
  return `/api/admin/search?${params.toString()}`;
}

// A single mixed-type search result row (mirrors the Worker's SearchData items). `type` + the
// type-specific identity fields drive the deep-link via navigationForResult.
export type SearchResultType = "customer" | "license" | "entitlement" | "order";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  label: string;
  project?: string;
  feature?: string;
  license_fingerprint?: string;
  email?: string;
  status?: string;
  external_ref?: string | null;
  customer_id?: string | null;
}

// The tabs a search result can deep-link into (a subset of App's activeTab union).
export type NavigableTab = "customers" | "entitlements" | "licenses" | "fulfillment";

// A deep-link target: which tab to open, the filter to apply on that tab, and (for a customer) the
// id to select. The React layer applies `filter` to the destination tab's filter state and switches
// `tab`; `selectCustomerId` (customer only) drives selectCustomer so the detail pane opens.
export interface SearchNavigation {
  tab: NavigableTab;
  filter: Record<string, string>;
  selectCustomerId?: string;
}

// Map a search result to its deep-link navigation (pure, unit-tested):
//   customer    -> Customers tab, search filter q=id, AND select the customer (detail pane opens).
//   entitlement -> Entitlements tab filtered to its exact project + feature.
//   license     -> Licenses tab filtered to its project (when known) + q=id so the single row anchors.
//   order       -> Fulfillment tab filtered by subscription_id (the result id IS the subscription id).
export function navigationForResult(result: SearchResult): SearchNavigation {
  if (result.type === "customer") {
    return { tab: "customers", filter: { status: "", q: result.id }, selectCustomerId: result.id };
  }
  if (result.type === "entitlement") {
    return { tab: "entitlements", filter: { project: result.project ?? "", feature: result.feature ?? "", status: "" } };
  }
  if (result.type === "license") {
    return { tab: "licenses", filter: { project: result.project ?? "", customer_id: "", q: result.id } };
  }
  return { tab: "fulfillment", filter: { status: "", subscription_id: result.id } };
}

// ── CSV export ──────────────────────────────────────────────────────────────────
// Append `format=csv` to an admin list path (which may already carry filters), so the
// "Export CSV" button downloads the current-filter CSV the JSON list would have returned.
// Pure so the export URL is unit-tested, mirroring withCursor's contract.
export function csvExportPath(base: string): string {
  return `${base}${base.includes("?") ? "&" : "?"}format=csv`;
}

// ── Workstream F UI: usage-analytics reports, expiring-soon, entitlement-health, force-release ──
// Pure helpers (unit-tested) for the inline-SVG charts (geometry only — CSS owns aesthetics), the
// expiring-soon panel, the entitlement-health classifier, and the stuck-seat force-release verb.
// None of these touch the shared mutation core; the backend is byte-identical and untouched.

// The time-series window selector offers a small fixed set of look-backs (last 7d / 30d / 90d).
// `range` is the look-back in seconds; the path lets the backend default `to` to now and bucket
// the [now-range, now] window. `buckets` is optional (the backend defaults + clamps it).
export type TimeseriesRange = 7 | 30 | 90;

export const TIMESERIES_RANGE_DAYS: ReadonlyArray<TimeseriesRange> = [7, 30, 90];

// Build the time-series path for a "last N days" look-back. We send `from` (now - N*86400) and let
// the backend default `to` to now, so the window always ends at the current instant. `buckets` rides
// along when provided (the backend clamps it to [1,200]); omit it to take the backend default of 24.
export function timeseriesPath(rangeDays: TimeseriesRange, buckets?: number, now: number = Math.floor(Date.now() / 1000)): string {
  const from = now - rangeDays * 86400;
  const params = new URLSearchParams();
  params.set("from", String(from));
  params.set("to", String(now));
  if (buckets !== undefined) {
    params.set("buckets", String(buckets));
  }
  return `/api/admin/report/timeseries?${params.toString()}`;
}

// Build the expiring-soon path for a "within N days" horizon. The backend clamps within_days to
// [1,365] and paginates with limit/cursor; we only attach within_days here (the pager appends cursor
// via withCursor, exactly like the other list endpoints).
export function expiringPath(withinDays: number): string {
  const params = new URLSearchParams();
  params.set("within_days", String(withinDays));
  return `/api/admin/report/expiring?${params.toString()}`;
}

// The force-release verb: POST /api/admin/entitlements/:id/release-seats. The id is the SAME encoded
// entitlement id the other entitlement routes use (it may contain '/', so it is path-segment encoded).
export function releaseSeatsPath(id: string): string {
  return `/api/admin/entitlements/${id}/release-seats`;
}

// Confirm copy for the force-release verb. It force-reclaims ALL live seats for the entitlement so a
// stuck/dead-machine seat frees up; the seats reappear the moment a live client re-checks-out. Pure
// (unit-tested), echoing the exact target so the typed-confirm modal can never fire on the wrong row.
export function releaseSeatsConfirm(item: { project: string; feature: string; license_fingerprint: string }): string {
  return `Force-release ALL live seats for ${item.project} / ${item.feature} (fingerprint ${shortHash(item.license_fingerprint)}). This frees a seat stuck on a dead/unreachable machine; live clients simply re-acquire on their next checkout.`;
}

// ── Inline-SVG chart geometry (pure, unit-tested; NO charting dependency) ──────
// These return ONLY geometry (path `d` strings / rect arrays / scaled y positions). The SVG element
// carries the geometry + an aria-label; the CSS owns every colour/stroke/fill. Coordinates use the
// SVG convention y-down (0 at the top), so a larger value maps to a SMALLER y. An empty/degenerate
// input yields an empty path or empty rect list (the React layer renders an empty-state instead).

// Scale a value into [0, height] with y-down orientation, given the data's [min,max]. When min===max
// (a flat series, including all-zero) every point sits on the horizontal mid-line so the chart reads as
// "flat" rather than collapsing to the top or bottom. `pad` insets the top/bottom so the stroke is not
// clipped at the edges.
export function scaleY(value: number, min: number, max: number, height: number, pad = 2): number {
  const usable = Math.max(0, height - pad * 2);
  if (max <= min) {
    return pad + usable / 2;
  }
  const t = (value - min) / (max - min);
  // y-down: the max value sits at the top (pad), the min at the bottom (height - pad).
  return pad + (1 - t) * usable;
}

// Even x positions for N points across [0, width] (first at x=0, last at x=width). One point pins to
// the left edge; zero points yields an empty array.
export function pointXs(count: number, width: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [0];
  }
  const step = width / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step * 1000) / 1000);
}

// linePath(values, width, height) -> an SVG path `d` string with min/max auto-scaling (y-down). Each
// value maps to an evenly-spaced x; the path is a polyline (M ... L ...). An empty input -> "" (the
// caller renders the empty-state). A single value -> a short flat segment at its scaled y so a 1-point
// series still draws. The scale spans [min(values), max(values)] (a flat series renders on the mid-line).
export function linePath(values: ReadonlyArray<number>, width: number, height: number, pad = 2): string {
  if (values.length === 0) {
    return "";
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xs = pointXs(values.length, width);
  if (values.length === 1) {
    const y = round(scaleY(values[0] ?? 0, min, max, height, pad));
    // A flat 1-point segment across the full width so a single bucket still renders a visible line.
    return `M 0 ${y} L ${round(width)} ${y}`;
  }
  return values
    .map((value, i) => `${i === 0 ? "M" : "L"} ${round(xs[i] ?? 0)} ${round(scaleY(value, min, max, height, pad))}`)
    .join(" ");
}

// linePathScaled is linePath drawn on an EXTERNAL [scaleMin, scaleMax] y-scale instead of the
// values' own min/max, so several series can share one axis (e.g. a denials line read against the
// combined checkouts+denials range). Empty values -> "". A degenerate scale (scaleMax<=scaleMin)
// puts every point on the mid-line. A single value draws a flat full-width segment at its scaled y.
export function linePathScaled(
  values: ReadonlyArray<number>,
  scaleMin: number,
  scaleMax: number,
  width: number,
  height: number,
  pad = 2,
): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    const y = round(scaleY(values[0] ?? 0, scaleMin, scaleMax, height, pad));
    return `M 0 ${y} L ${round(width)} ${y}`;
  }
  const xs = pointXs(values.length, width);
  return values
    .map((value, i) => `${i === 0 ? "M" : "L"} ${round(xs[i] ?? 0)} ${round(scaleY(value, scaleMin, scaleMax, height, pad))}`)
    .join(" ");
}

// areaPath(values, width, height) -> a CLOSED `d` string: the linePath, dropped to the baseline
// (y=height) at the last x, back to the baseline at the first x, and closed. Used as a filled area
// UNDER the checkouts line. Empty input -> "". Shares linePath's scaling so the fill hugs the stroke.
export function areaPath(values: ReadonlyArray<number>, width: number, height: number, pad = 2): string {
  const line = linePath(values, width, height, pad);
  if (line === "") {
    return "";
  }
  const xs = pointXs(values.length, width);
  const lastX = values.length === 1 ? width : (xs[xs.length - 1] ?? 0);
  const firstX = values.length === 1 ? 0 : (xs[0] ?? 0);
  return `${line} L ${round(lastX)} ${round(height)} L ${round(firstX)} ${round(height)} Z`;
}

// areaPathScaled is areaPath on an EXTERNAL [scaleMin,scaleMax] y-scale (so the filled area hugs a
// line drawn with linePathScaled). Empty values -> "".
export function areaPathScaled(
  values: ReadonlyArray<number>,
  scaleMin: number,
  scaleMax: number,
  width: number,
  height: number,
  pad = 2,
): string {
  const line = linePathScaled(values, scaleMin, scaleMax, width, height, pad);
  if (line === "") {
    return "";
  }
  const xs = pointXs(values.length, width);
  const lastX = values.length === 1 ? width : (xs[xs.length - 1] ?? 0);
  const firstX = values.length === 1 ? 0 : (xs[0] ?? 0);
  return `${line} L ${round(lastX)} ${round(height)} L ${round(firstX)} ${round(height)} Z`;
}

// One positioned bar for a bar/spark chart.
export interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// barRects(values, width, height) -> evenly-spaced bars across [0,width]. Each bar's height is its
// value scaled by the data MAX (not min/max): a zero value is a zero-height bar, the max value fills
// the chart, so a fulfillment-events spark reads as true magnitudes from the baseline. `gap` (a
// fraction in [0,1)) is the inter-bar spacing as a fraction of the slot width. Empty input -> []; an
// all-zero series -> zero-height bars at the baseline (the caller may swap in the empty-state).
export function barRects(values: ReadonlyArray<number>, width: number, height: number, gap = 0.2): BarRect[] {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values, 0);
  const slot = width / values.length;
  const clampedGap = Math.min(Math.max(gap, 0), 0.9);
  const barWidth = slot * (1 - clampedGap);
  const offset = (slot - barWidth) / 2;
  return values.map((value, i) => {
    const h = max <= 0 ? 0 : round((value / max) * height);
    return {
      x: round(i * slot + offset),
      y: round(height - h),
      w: round(barWidth),
      h,
    };
  });
}

// Whether a numeric series is empty OR entirely zero — the guard the chart components use to render an
// empty-state ("no activity in this window") instead of a flat-line/zero-bar chart that reads as data.
export function isEmptySeries(values: ReadonlyArray<number>): boolean {
  return values.length === 0 || values.every((value) => value === 0);
}

// ── Entitlement-health classifier (pure, unit-tested) ─────────────────────────
// Classify an entitlement for the health badge. Precedence (most-severe-first):
//   suspended — status is disabled or revoked (an operator/terminal kill, regardless of dates).
//   expired   — ACTIVE but valid_until is set and in the past (valid_until <= now).
//   expiring  — ACTIVE and valid_until is within the next `expiringWithinDays` days.
//   healthy   — everything else (active, non-expiring, or expiring beyond the horizon).
// A null/undefined valid_until on an active row is non-expiring -> always healthy.
export type EntitlementHealth = "healthy" | "expiring" | "expired" | "suspended";

export function entitlementHealth(
  status: string,
  validUntil: number | null | undefined,
  now: number,
  expiringWithinDays = 30,
): EntitlementHealth {
  if (status === "disabled" || status === "revoked") {
    return "suspended";
  }
  // Anything not active and not suspended (an unknown status) is treated as healthy — the status pill
  // already surfaces the raw value; the badge only escalates on the cases above.
  if (status !== "active") {
    return "healthy";
  }
  if (validUntil === null || validUntil === undefined) {
    return "healthy";
  }
  if (validUntil <= now) {
    return "expired";
  }
  if (validUntil <= now + expiringWithinDays * 86400) {
    return "expiring";
  }
  return "healthy";
}

// Round to 3 decimals so the emitted SVG path strings are compact and the unit tests assert exact
// values (sub-pixel precision beyond this is invisible and just bloats the markup).
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
