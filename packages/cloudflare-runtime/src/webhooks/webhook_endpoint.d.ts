export declare const MAX_WEBHOOK_URL_SIZE: 2048;

export declare function safeWebhookUrl(value: unknown): string | null;

export declare const WEBHOOK_TEST_STATUS_CLASSES: readonly ["2xx", "3xx", "4xx", "5xx", "network_error"];

export type WebhookTestStatusClass = (typeof WEBHOOK_TEST_STATUS_CLASSES)[number];

export declare const WEBHOOK_ENDPOINT_CHANGED: "endpoint_changed";

export declare const WEBHOOK_INVALID_URL: "invalid_url";

export declare const WEBHOOK_STOP_REASONS: readonly ["invalid_url", "endpoint_changed"];

export interface WebhookEndpointScope {
  scope_kind?: unknown;
  scope_project?: unknown;
  scope_customer_id?: unknown;
}

export declare function endpointScopeMatches(
  endpoint: WebhookEndpointScope,
  source: string,
  event: { project?: unknown; customer_id?: unknown },
): boolean;

export declare function deliveryWithinEndpointScope(
  delivery: WebhookEndpointScope & { event_source: string; payload_json: unknown },
): boolean;
