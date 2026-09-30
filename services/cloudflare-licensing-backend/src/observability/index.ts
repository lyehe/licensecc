import type { Env } from "../env.js";
import { safeErrorType } from "@licensecc/cloudflare-runtime/http/kit";
import {
  invalidSecurityModeNames as invalidSecurityModeNamesFromEnv,
  parseOrderSignerScopeMode,
} from "../security_modes.mjs";

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
  "invalid_config_modes",
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

// The app composition root already owns the observability dependency. Re-export the
// names-only config check here so routing can log/reject invalid security config
// without adding another composition edge.
export function invalidSecurityModeNames(env: Env): string[] {
  return invalidSecurityModeNamesFromEnv(env);
}

// Config-consistency warnings (audit R2.3): surface half-configured deploys where a security
// secret is present but its enforcing mode is left off, so an operator who set the scope map
// but forgot to flip the mode sees it on /health instead of silently shipping a permissive posture.
export function configConsistencyWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const has = (v: string | undefined): boolean => typeof v === "string" && v.length > 0;
  const orderSignerScope = parseOrderSignerScopeMode(env);
  for (const name of invalidSecurityModeNames(env)) {
    warnings.push(`${name} has an invalid value — use only its documented exact mode names`);
  }
  if (has(env.ORDER_SIGNER_SCOPES) && orderSignerScope.valid && orderSignerScope.mode === "off") {
    warnings.push(
      "ORDER_SIGNER_SCOPES is set but ORDER_SIGNER_SCOPE_MODE is off — order signer scoping is not enforced",
    );
  }
  return warnings;
}
