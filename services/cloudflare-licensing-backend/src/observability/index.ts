import type { Env } from "../env.js";
import { safeErrorType } from "@licensecc/cloudflare-runtime/http/kit";

export type LogSeverity = "info" | "warn" | "error";

// Only fields that a remaining event emits: request failures (app.ts), protected-device
// cleanup (maintenance/device_cleanup.ts) and the webhook dispatcher.
const LOG_FIELD_NAMES = new Set([
  "affected_rows",
  "attempts",
  "backlog_age_seconds",
  "backlog_present",
  "delivery_id",
  "endpoint_id",
  "error_type",
  "last_status",
  "limit_reached",
  "measured_at",
  "oldest_expired_at",
  "path",
  "request_id",
  "skipped",
  "source",
  "target",
]);

function safeLogValue(value: unknown): string | number | boolean | null | string[] | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.replace(/\p{Cc}/gu, "?").slice(0, 256);
  if (Array.isArray(value) && value.length <= 16 && value.every((entry) => typeof entry === "string")) {
    return value.map((entry) => entry.replace(/\p{Cc}/gu, "?").slice(0, 64));
  }
  return undefined;
}

export function logEvent(severity: LogSeverity, event: string, fields: Record<string, unknown>): void {
  const safeFields: Record<string, string | number | boolean | null | string[]> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!LOG_FIELD_NAMES.has(name)) continue;
    if (name === "error_type") {
      safeFields[name] = safeErrorType(value);
      continue;
    }
    const safe = safeLogValue(value);
    if (safe !== undefined) safeFields[name] = safe;
  }
  const safeEvent = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(event) ? event : "observability.invalid_event_name";
  const line = JSON.stringify({ event: safeEvent, severity, ...safeFields });
  if (severity === "error") {
    console.error(line);
    return;
  }
  if (severity === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

// Config-consistency warnings: names-only /health signals for a deploy that would otherwise
// silently fail closed on every order (a missing signer-scope map) or run a protected route
// with no edge rate limit (a stale or manual deploy that dropped a binding).
export function configConsistencyWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const has = (v: string | undefined): boolean => typeof v === "string" && v.length > 0;
  if (!has(env.ORDER_SIGNER_SCOPES)) {
    warnings.push(
      "ORDER_SIGNER_SCOPES is not set — every order will be refused with config_error",
    );
  }
  if (env.BOUND_REGISTRATION_RATE_LIMITER === undefined) {
    warnings.push(
      "BOUND_REGISTRATION_RATE_LIMITER is not bound — registration has no edge rate limit",
    );
  }
  if (env.BOUND_SESSION_RATE_LIMITER === undefined) {
    warnings.push(
      "BOUND_SESSION_RATE_LIMITER is not bound — challenge/exchange/renew traffic has no edge rate limit",
    );
  }
  return warnings;
}
