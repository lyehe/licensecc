import { json, secureHtml } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env } from "../env.js";
import { boundDeviceReadiness } from "../device/bound_readiness.mjs";
import { configConsistencyWarnings } from "../observability/index.js";
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
  const { ready } = await boundDeviceReadiness(env);
  return json({
    ok: ready,
    service: "licensecc-online-verifier",
    // One boolean for the whole protected device-bound configuration. It exposes no
    // registry, key or per-check detail, so dependent Workers and the post-deploy smoke
    // can prove protected readiness without duplicating that configuration.
    protected_device_ready: ready,
    ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),
  }, ready ? 200 : 503);
}
