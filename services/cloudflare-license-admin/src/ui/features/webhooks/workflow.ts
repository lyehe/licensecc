import type { WebhookEndpointInput } from "../../../shared/api";

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
  scope_project: string;
  scope_customer_id: string;
}

export type WebhookAction = "disable" | "reenable";

export const emptyWebhookForm: WebhookFormState = {
  url: "",
  event_types: "",
  description: "",
  scope_project: "",
  scope_customer_id: "",
};

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
  const scopeProject = normalizeWebhookScope(form.scope_project, "scope_project");
  const scopeCustomer = normalizeWebhookScope(form.scope_customer_id, "scope_customer_id");
  if (scopeProject !== "" && scopeCustomer !== "") {
    throw new Error("scope_set_project_or_customer_not_both");
  }
  return {
    url: parsed.href,
    event_types: normalizeWebhookEventTypes(form.event_types),
    description: form.description,
    scope_project: scopeProject,
    scope_customer_id: scopeCustomer,
  };
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
  return tokens.join(",");
}

function normalizeWebhookScope(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if (trimmed.length > MAX_WEBHOOK_SCOPE_SIZE || trimmed.includes(",") || hasControlChars(trimmed)) {
    throw new Error(`${label}_invalid`);
  }
  return trimmed;
}
