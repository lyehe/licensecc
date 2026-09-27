export declare const MAX_WEBHOOK_URL_SIZE: 2048;

export declare function safeWebhookUrl(value: unknown): string | null;

export declare const WEBHOOK_TEST_STATUS_CLASSES: readonly ["2xx", "3xx", "4xx", "5xx", "network_error"];

export type WebhookTestStatusClass = (typeof WEBHOOK_TEST_STATUS_CLASSES)[number];
