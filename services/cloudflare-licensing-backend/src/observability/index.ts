import type { Env } from "../env.js";

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

// Config-consistency warnings (audit R2.3): surface half-configured deploys where a security
// secret is present but its enforcing mode is left off, so an operator who set the peppers/keys
// but forgot to flip a mode sees it on /health instead of silently shipping a permissive posture.
export function configConsistencyWarnings(env: Env): string[] {
  const warnings: string[] = [];
  const has = (v: string | undefined): boolean => typeof v === "string" && v.length > 0;
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
  const scoped = env as unknown as { ORDER_SIGNER_SCOPES?: string; ORDER_SIGNER_SCOPE_MODE?: string };
  if (has(scoped.ORDER_SIGNER_SCOPES) && (scoped.ORDER_SIGNER_SCOPE_MODE ?? "off") === "off") {
    warnings.push(
      "ORDER_SIGNER_SCOPES is set but ORDER_SIGNER_SCOPE_MODE is off — order signer scoping is not enforced",
    );
  }
  return warnings;
}
