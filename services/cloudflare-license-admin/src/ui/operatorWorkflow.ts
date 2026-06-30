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
