import { json } from "@licensecc/cloudflare-runtime/http/kit";
import type { Env } from "../env.js";
import { configConsistencyWarnings } from "../observability/index.js";
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
  return json({
    ok: true,
    service: "licensecc-online-verifier",
    ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),
  });
}
