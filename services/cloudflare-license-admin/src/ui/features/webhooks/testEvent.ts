import { WEBHOOK_TEST_STATUS_CLASSES, type WebhookTestStatusClass } from "@licensecc/cloudflare-runtime/webhooks/webhook_endpoint";
import type { WebhookTestResult } from "../../../shared/api";
import { apiFailureDetails, parseExactApiSuccess } from "../../shared/api";

/**
 * "Send test event" results. The backend reports only the receiver's status class, so the operator
 * reads a sentence about it; the code and request id belong under Technical details and an
 * unrecognized code only ever reaches the operator there, never as the sentence.
 */
export type WebhookTestTone = "success" | "warning" | "error";

export interface WebhookTestOutcome {
  tone: WebhookTestTone;
  sentence: string;
  code: string;
  requestId: string;
}

const STATUS_CLASS_COPY: Readonly<Record<WebhookTestStatusClass, readonly [WebhookTestTone, string]>> = {
  "2xx": ["success", "The endpoint answered with a 2xx success."],
  "3xx": ["warning", "The endpoint answered with a 3xx redirect. Deliveries never follow redirects, so save the final https address instead."],
  "4xx": ["warning", "The endpoint answered with a 4xx client error. Check that the receiver accepts this URL and verifies signatures with the current signing key."],
  "5xx": ["warning", "The endpoint answered with a 5xx server error. Check the receiver's logs."],
  network_error: ["warning", "The endpoint could not be reached, or did not answer within 5 seconds."],
};

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  not_found: "This endpoint no longer exists or is disabled, so no test event was sent.",
  invalid_url: "This endpoint's saved URL is not a valid https address, so no test event was sent. Edit the URL first.",
  webhook_signing_unconfigured: "Webhook signing is not configured on the licensing backend, so no test event was sent.",
  webhook_operator_not_configured: "Sending test events is not set up for this admin console yet. Connect it to the licensing backend first.",
  admin_role_required: "Only administrators can send test events.",
  admin_role_denied: "Only administrators can send test events.",
};

const FALLBACK_COPY = "The test event could not be sent. Try again shortly.";

export function webhookTestPath(id: string): string {
  return `/api/admin/webhooks/${encodeURIComponent(id)}/test`;
}

function isWebhookTestResult(value: unknown): value is WebhookTestResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const statusClass = (value as Record<string, unknown>).status_class;
  return typeof statusClass === "string" && (WEBHOOK_TEST_STATUS_CLASSES as readonly string[]).includes(statusClass);
}

function retryAfterSeconds(response: unknown): number | null {
  if (response === null || typeof response !== "object") return null;
  const data = (response as Record<string, unknown>).data;
  if (data === null || typeof data !== "object") return null;
  const seconds = (data as Record<string, unknown>).retry_after;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : null;
}

export function webhookTestOutcome(response: unknown): WebhookTestOutcome {
  const sent = parseExactApiSuccess<WebhookTestResult>(response, "webhook_test_sent", isWebhookTestResult);
  if (sent !== null) {
    const [tone, sentence] = STATUS_CLASS_COPY[sent.data.status_class];
    return { tone, sentence, code: sent.code, requestId: sent.requestId };
  }
  const { code, requestId } = apiFailureDetails(response);
  if (code === "webhook_test_sent") {
    // A success envelope without a known status class is not proof that anything was sent.
    return { tone: "error", sentence: FALLBACK_COPY, code: "invalid_api_response", requestId };
  }
  if (code === "rate_limited") {
    const seconds = retryAfterSeconds(response);
    const wait = seconds === null ? "a minute" : `${seconds} second${seconds === 1 ? "" : "s"}`;
    return { tone: "error", sentence: `A test event was sent to this endpoint less than a minute ago. Try again in ${wait}.`, code, requestId };
  }
  return { tone: "error", sentence: Object.hasOwn(REFUSAL_COPY, code) ? REFUSAL_COPY[code]! : FALLBACK_COPY, code, requestId };
}
