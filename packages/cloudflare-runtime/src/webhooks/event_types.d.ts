export interface WebhookEventTypesBySource {
  readonly entitlement: readonly string[];
  readonly customer: readonly string[];
  readonly order: readonly string[];
}

export declare const WEBHOOK_EVENT_TYPES: WebhookEventTypesBySource;
