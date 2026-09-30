import type { WebhookEndpoint, WebhookEndpointInput, WebhookEndpointPatch, WebhookScopeKind } from "../../../shared/api";
import { WEBHOOK_EVENT_TYPES } from "@licensecc/cloudflare-runtime/webhooks/event_types";
import { fieldForCode } from "../../shared/fieldErrors";

export interface WebhookFilter {
  status: string;
}

export interface WebhookDeliveryFilter {
  endpoint_id: string;
  status: string;
}

export interface WebhookFormState {
  url: string;
  event_types: string;
  description: string;
  // "" until the operator picks one: every endpoint's scope is an explicit choice.
  scope_kind: WebhookScopeKind | "";
  scope_project: string;
  scope_customer_id: string;
}

export type WebhookAction = "disable" | "reenable";

export const emptyWebhookForm: WebhookFormState = {
  url: "",
  event_types: "",
  description: "",
  scope_kind: "",
  scope_project: "",
  scope_customer_id: "",
};

/** The scope selector's choices, in order. */
export const WEBHOOK_SCOPE_OPTIONS: ReadonlyArray<{ kind: WebhookScopeKind; label: string }> = [
  { kind: "global", label: "Every event (operator-wide)" },
  { kind: "project", label: "One project" },
  { kind: "customer", label: "One customer" },
];

/** The endpoint list's Scope cell. */
export function webhookScopeLabel(endpoint: Pick<WebhookEndpoint, "scope_kind" | "scope_project" | "scope_customer_id">): string {
  if (endpoint.scope_kind === "project") return `project:${endpoint.scope_project ?? ""}`;
  if (endpoint.scope_kind === "customer") return `customer:${endpoint.scope_customer_id ?? ""}`;
  return "operator-wide";
}

export type WebhookEventSource = "entitlement" | "customer" | "order";

const WEBHOOK_EVENT_SOURCES: readonly WebhookEventSource[] = ["entitlement", "customer", "order"];
const WEBHOOK_EVENT_SOURCE_LABELS: Record<WebhookEventSource, string> = { entitlement: "Entitlement", customer: "Customer", order: "Order" };

/**
 * The checkbox editor's grouping, by source -- DERIVED from WEBHOOK_EVENT_TYPES
 * (packages/cloudflare-runtime/src/webhooks/event_types.mjs), the single source of truth also
 * used by the admin worker's validator and the schema-parity test, so the token lists can never
 * drift from what the dispatcher actually emits. That module is pure (its only import is the
 * pure domain intents module), so importing it here is the same shape of import this file already
 * makes into `@licensecc/licensing-domain` elsewhere in the admin UI. Only the 3 source names and
 * their display labels are UI-local. "disable"/"reenable" deliberately appear in BOTH the
 * entitlement and customer groups: they are the exact same csv token either way, so checking
 * either box selects the identical filter value and both checkboxes reflect the same state.
 */
export const WEBHOOK_EVENT_TYPE_GROUPS: ReadonlyArray<{ source: WebhookEventSource; label: string; tokens: readonly string[] }> =
  WEBHOOK_EVENT_SOURCES.map((source) => ({
    source,
    label: WEBHOOK_EVENT_SOURCE_LABELS[source],
    tokens: WEBHOOK_EVENT_TYPES[source],
  }));

// De-duplicated: "disable"/"reenable" appear in two groups above, but each is one csv token.
const WEBHOOK_EVENT_TYPE_CANONICAL_ORDER: readonly string[] = [...new Set(WEBHOOK_EVENT_TYPE_GROUPS.flatMap((group) => group.tokens))];

export function webhookEventTypesArray(csv: string): string[] {
  return csv.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
}

export function isWebhookEventTypeChecked(csv: string, token: string): boolean {
  return webhookEventTypesArray(csv).includes(token);
}

/**
 * Toggle one token's membership in the csv filter, re-serialized in canonical order. A checkbox
 * only ever names a known token, and a stored filter only ever holds known tokens (the admin
 * Worker and the database both refuse any other), so the result is always a canonical filter.
 */
export function toggleWebhookEventType(csv: string, token: string, checked: boolean): string {
  const tokens = new Set(webhookEventTypesArray(csv));
  if (checked) {
    tokens.add(token);
  } else {
    tokens.delete(token);
  }
  return WEBHOOK_EVENT_TYPE_CANONICAL_ORDER.filter((known) => tokens.has(known)).join(",");
}

export function webhooksPath(filter: WebhookFilter): string {
  const params = new URLSearchParams();
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/webhooks${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function webhookPath(id: string): string {
  return `/api/admin/webhooks/${encodeURIComponent(id)}`;
}

export function webhookTransitionPath(id: string, action: WebhookAction): string {
  return `/api/admin/webhooks/${encodeURIComponent(id)}/${action}`;
}

export function canRunWebhookAction(status: string, action: WebhookAction): boolean {
  return action === "disable" ? status === "active" : status === "disabled";
}

export function webhookDeliveriesPath(filter: WebhookDeliveryFilter): string {
  const params = new URLSearchParams();
  if (filter.endpoint_id !== "") params.set("endpoint_id", filter.endpoint_id);
  if (filter.status !== "") params.set("status", filter.status);
  return `/api/admin/webhooks/deliveries${params.size === 0 ? "" : `?${params.toString()}`}`;
}

export function webhookRedrivePath(deliveryId: string): string {
  return `/api/admin/webhooks/deliveries/${encodeURIComponent(deliveryId)}/redrive`;
}

export function disableWebhookConfirm(endpoint: { url: string }): string {
  return `Disable webhook endpoint ${endpoint.url}. New events will no longer be delivered to it; queued or failed deliveries already recorded are unaffected.`;
}

/** The editor's view of an existing endpoint, for PATCH /api/admin/webhooks/{id}. */
export function webhookFormFromEndpoint(endpoint: WebhookEndpoint): WebhookFormState {
  return {
    url: endpoint.url,
    event_types: endpoint.event_types,
    description: endpoint.description,
    scope_kind: endpoint.scope_kind,
    scope_project: endpoint.scope_project ?? "",
    scope_customer_id: endpoint.scope_customer_id ?? "",
  };
}

export function normalizeWebhookForm(form: WebhookFormState): WebhookEndpointInput {
  const url = form.url.trim();
  if (url === "" || url.length > MAX_WEBHOOK_URL_SIZE || /\s/.test(url)) {
    throw new Error("url_must_be_a_single_https_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url_must_be_a_single_https_url");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("url_must_be_https");
  }
  if (form.description.length > MAX_WEBHOOK_DESCRIPTION_SIZE || hasControlChars(form.description)) {
    throw new Error("description_invalid");
  }
  const scope = normalizeWebhookScopeChoice(form);
  return {
    url: parsed.href,
    event_types: normalizeWebhookEventTypes(form.event_types),
    description: form.description,
    ...scope,
  };
}

/**
 * The scope the form names: the kind the operator chose and only that kind's value. A value typed
 * for another kind is sent blank, which also clears it on a PATCH that moves to a new kind.
 */
function normalizeWebhookScopeChoice(form: WebhookFormState): Pick<WebhookEndpointInput, "scope_kind" | "scope_project" | "scope_customer_id"> {
  if (form.scope_kind === "") {
    throw new Error("scope_kind_required");
  }
  const scopeProject = form.scope_kind === "project" ? normalizeWebhookScope(form.scope_project, "scope_project") : "";
  const scopeCustomer = form.scope_kind === "customer" ? normalizeWebhookScope(form.scope_customer_id, "scope_customer_id") : "";
  if (form.scope_kind === "project" && scopeProject === "") {
    throw new Error("scope_project_required");
  }
  if (form.scope_kind === "customer" && scopeCustomer === "") {
    throw new Error("scope_customer_id_required");
  }
  return { scope_kind: form.scope_kind, scope_project: scopeProject, scope_customer_id: scopeCustomer };
}

/**
 * PATCH /api/admin/webhooks/{id}: only the fields that actually differ from `baseline` (the form
 * as it was loaded from the endpoint), so an unchanged field is never rewritten. The scope travels
 * as a whole: when its kind or either value changed, the PATCH names the kind and both values, so
 * the server checks the full scope and a value left from the old kind is cleared. Comparing the
 * raw form fields (not the normalized output) means an edit that only reformats a value (e.g.
 * re-typing the identical URL) still counts as unchanged.
 */
export function normalizeWebhookPatch(form: WebhookFormState, baseline: WebhookFormState): WebhookEndpointPatch {
  const normalized = normalizeWebhookForm(form);
  const patch: WebhookEndpointPatch = {};
  if (form.url !== baseline.url) patch.url = normalized.url;
  if (form.event_types !== baseline.event_types) patch.event_types = normalized.event_types;
  if (form.description !== baseline.description) patch.description = normalized.description;
  if (form.scope_kind !== baseline.scope_kind || form.scope_project !== baseline.scope_project || form.scope_customer_id !== baseline.scope_customer_id) {
    patch.scope_kind = normalized.scope_kind;
    patch.scope_project = normalized.scope_project;
    patch.scope_customer_id = normalized.scope_customer_id;
  }
  return patch;
}

const MAX_WEBHOOK_URL_SIZE = 2048;
const MAX_WEBHOOK_EVENT_TYPES_SIZE = 1024;
const MAX_WEBHOOK_DESCRIPTION_SIZE = 500;
const MAX_WEBHOOK_SCOPE_SIZE = 128;

function hasControlChars(value: string): boolean {
  return value.includes("\n") || value.includes("\r") || value.includes("\0");
}

function normalizeWebhookEventTypes(value: string): string {
  if (value.length > MAX_WEBHOOK_EVENT_TYPES_SIZE || hasControlChars(value)) {
    throw new Error("event_types_invalid");
  }
  const tokens = value.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/\s/.test(token)) {
      throw new Error("event_types_token_has_whitespace");
    }
  }
  // Only the event types the dispatcher emits; the checkboxes can pick nothing else.
  if (tokens.some((token) => !WEBHOOK_EVENT_TYPE_CANONICAL_ORDER.includes(token))) {
    throw new Error("invalid_event_types");
  }
  return tokens.join(",");
}

function normalizeWebhookScope(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.length > MAX_WEBHOOK_SCOPE_SIZE || trimmed.includes(",") || hasControlChars(trimmed)) {
    throw new Error(`${label}_must_be_a_single_value`);
  }
  return trimmed;
}

const WEBHOOK_FIELD_CODES: Readonly<Record<string, keyof WebhookFormState>> = {
  url_must_be_a_single_https_url: "url",
  url_must_be_https: "url",
  invalid_url: "url",
  description_invalid: "description",
  event_types_invalid: "event_types",
  event_types_token_has_whitespace: "event_types",
  invalid_event_types: "event_types",
  scope_kind_required: "scope_kind",
  scope_project_required: "scope_project",
  scope_customer_id_required: "scope_customer_id",
};

/** The webhook editor field a validation or refusal code belongs to; null keeps it with the whole form. */
export function webhookFieldForCode(code: string): keyof WebhookFormState | null {
  return fieldForCode(code, ["scope_project", "scope_customer_id"], WEBHOOK_FIELD_CODES) as keyof WebhookFormState | null;
}

/**
 * The sentence for a 400 invalid_event_types response (the checkboxes prevent an operator from
 * picking an unknown token, so this is defense-in-depth -- e.g. an out-of-date tab), or null when
 * the response names no allowed list. Shows the server's own `data.allowed` list; the code and
 * request id stay under Technical details.
 */
export function webhookEventTypesErrorMessage(data: unknown): string | null {
  const allowed = data !== null && typeof data === "object" ? (data as Record<string, unknown>).allowed : null;
  if (allowed === null || typeof allowed !== "object") {
    return null;
  }
  const groups = allowed as Record<string, unknown>;
  const parts = (["entitlement", "customer", "order"] as const)
    .filter((source) => Array.isArray(groups[source]))
    .map((source) => `${WEBHOOK_EVENT_SOURCE_LABELS[source]}: ${(groups[source] as unknown[]).join(", ")}`);
  return `One or more event types aren't recognized. Allowed event types — ${parts.join(" · ")}.`;
}
