import type { Env } from "../env.js";
import { invalidSecurityModeNames as invalidSecurityModeNamesFromEnv } from "../security_modes.mjs";

export type LogSeverity = "info" | "warn" | "error";

export function logEvent(severity: LogSeverity, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...fields });
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
  for (const name of invalidSecurityModeNames(env)) {
    warnings.push(`${name} has an invalid value — use only its documented exact mode names`);
  }
  if (has(env.ACCOUNT_TOKEN_PEPPERS) && env.ACCOUNT_TOKEN_MODE !== "required") {
    warnings.push(
      "ACCOUNT_TOKEN_PEPPERS is set but ACCOUNT_TOKEN_MODE is not 'required' — per-customer isolation is not enforced",
    );
  }
  if (has(env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM) && (env.REQUEST_SIGNATURE_MODE ?? "off") === "off") {
    warnings.push(
      "online signing is configured but REQUEST_SIGNATURE_MODE is off — request device-proofs are not enforced",
    );
  }
  if (has(env.ORDER_SIGNER_SCOPES) && (env.ORDER_SIGNER_SCOPE_MODE ?? "off") === "off") {
    warnings.push(
      "ORDER_SIGNER_SCOPES is set but ORDER_SIGNER_SCOPE_MODE is off — order signer scoping is not enforced",
    );
  }
  return warnings;
}
