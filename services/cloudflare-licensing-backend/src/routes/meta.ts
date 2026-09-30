import { json, secureHtml } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env } from "../env.js";
import { boundDeviceReadiness } from "../device/bound_readiness.mjs";
import { configConsistencyWarnings } from "../observability/index.js";
import { invalidSecurityModeNames } from "../security_modes.mjs";
import { docsHtml } from "../docs_page.js";
import { openApiSpec } from "../openapi/document.js";

export function handleOpenApi(): Response {
  return json(openApiSpec);
}

export function handleDocs(): Response {
  return secureHtml(docsHtml);
}

export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const configWarnings = configConsistencyWarnings(env);
  const invalidConfigModes = invalidSecurityModeNames(env);
  const { ready } = await boundDeviceReadiness(env);
  const ok = invalidConfigModes.length === 0 && ready;
  return json({
    ok,
    service: "licensecc-online-verifier",
    // One boolean for the whole protected device-bound configuration. It exposes no
    // registry, key or per-check detail, so dependent Workers and the post-deploy smoke
    // can prove protected readiness without duplicating that configuration.
    protected_device_ready: ready,
    ...(invalidConfigModes.length > 0
      ? { code: "config_error", invalid_config_modes: invalidConfigModes }
      : {}),
    ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),
  }, ok ? 200 : 503);
}
