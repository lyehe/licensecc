import type { Env } from "../env.js";
import { safeErrorType } from "@licensecc/cloudflare-runtime/http/kit";
import {
  invalidSecurityModeNames as invalidSecurityModeNamesFromEnv,
  parseAccountTokenMode,
  parseOrderSignerScopeMode,
  parseRequestSignatureMode,
} from "../security_modes.mjs";

export type LogSeverity = "info" | "warn" | "error";

const LOG_FIELD_NAMES = new Set([
  "assertion_ttl_seconds",
  "attempts",
  "client_hardening",
  "d1_duration_ms",
  "delivery_id",
  "detail",
  "endpoint_id",
  "error_type",
  "event_type",
  "invalid_config_modes",
  "last_status",
  "method",
  "mode",
  "path",
  "request_id",
  "request_proof",
  "request_signature_mode",
  "result",
  "revocation_seq",
  "skipped",
  "source",
  "success",
  "target",
  "window_from",
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
// secret is present but its enforcing mode is left off, so an operator who set the peppers/keys
// but forgot to flip a mode sees it on /health instead of silently shipping a permissive posture.
export function configConsistencyWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const has = (v: string | undefined): boolean => typeof v === "string" && v.length > 0;
  const accountToken = parseAccountTokenMode(env);
  const requestSignature = parseRequestSignatureMode(env);
  const orderSignerScope = parseOrderSignerScopeMode(env);
  for (const name of invalidSecurityModeNames(env)) {
    warnings.push(`${name} has an invalid value — use only its documented exact mode names`);
  }
  if (has(env.ACCOUNT_TOKEN_PEPPERS) && accountToken.valid && accountToken.mode !== "required") {
    warnings.push(
      "ACCOUNT_TOKEN_PEPPERS is set but ACCOUNT_TOKEN_MODE is not 'required' — per-customer isolation is not enforced",
    );
  }
  if (has(env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM) && requestSignature.valid && requestSignature.mode === "off") {
    warnings.push(
      "online signing is configured but REQUEST_SIGNATURE_MODE is off — request device-proofs are not enforced",
    );
  }
  if (has(env.ORDER_SIGNER_SCOPES) && orderSignerScope.valid && orderSignerScope.mode === "off") {
    warnings.push(
      "ORDER_SIGNER_SCOPES is set but ORDER_SIGNER_SCOPE_MODE is off — order signer scoping is not enforced",
    );
  }
  return warnings;
}
