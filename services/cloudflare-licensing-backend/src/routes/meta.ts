import { json } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env } from "../env.js";
import { accountTokenMode } from "../auth/account_auth.mjs";
import { configConsistencyWarnings } from "../observability/index.js";
import { invalidSecurityModeNames } from "../security_modes.mjs";
import { docsHtml } from "../docs_page.js";
import { openApiSpec } from "../openapi/document.js";

export function handleOpenApi(): Response {
  return json(openApiSpec);
}

export function handleDocs(): Response {
  return new Response(docsHtml, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function handleHealth(_request: Request, env: Env): Response {
  const configWarnings = configConsistencyWarnings(env);
  const invalidConfigModes = invalidSecurityModeNames(env);
  return json({
    ok: invalidConfigModes.length === 0,
    service: "licensecc-online-verifier",
    // This is the backend's normalized runtime decision, not a raw configuration value.
    // It intentionally exposes no token/pepper material so dependent Workers can prove their
    // account-isolation readiness without duplicating ACCOUNT_TOKEN_MODE configuration.
    account_token_mode: accountTokenMode(env),
    ...(invalidConfigModes.length > 0
      ? { code: "config_error", invalid_config_modes: invalidConfigModes }
      : {}),
    ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),
  }, invalidConfigModes.length > 0 ? 503 : 200);
}
