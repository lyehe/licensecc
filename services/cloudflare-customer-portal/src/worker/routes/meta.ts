// Documentation and backend-truth-bearing readiness routes.

import { DOCS_HTML } from "../docs_page.js";
import { openApiDocument } from "../openapi/document.js";
import type { Env, ExecutionContextLike, TopRoute } from "../env.js";
import { envelope, json } from "../support.js";

export const META_DISPATCH = {
  "GET /openapi.json": () => json(openApiDocument, 200, { "cache-control": "no-store" }),
  "GET /docs": () =>
    new Response(DOCS_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    }),
};

const BACKEND_SERVICE = "licensecc-online-verifier";
const REQUIRED_ACCOUNT_TOKEN_MODE = "required";

function backendOrigin(env: Env): string {
  return (env.BACKEND_ORIGIN ?? "").replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provesRequiredAccountTokenMode(value: unknown): boolean {
  return isRecord(value) &&
    value.ok === true &&
    value.service === BACKEND_SERVICE &&
    value.account_token_mode === REQUIRED_ACCOUNT_TOKEN_MODE;
}

async function backendRequiresAccountTokenMode(env: Env): Promise<boolean> {
  const origin = backendOrigin(env);
  if (origin.length === 0) return false;
  try {
    const response = await fetch(`${origin}/health`);
    if (response.status !== 200) return false;
    return provesRequiredAccountTokenMode(await response.json());
  } catch {
    return false;
  }
}

export async function handleHealth(
  _request: Request,
  env: Env,
  _ctx: ExecutionContextLike | undefined,
  reqId: string,
): Promise<Response> {
  // The existing envelope is retained for callers. `account_token_mode_required:true` now means
  // the portal verified the backend's actual resolved mode; every missing, malformed, mismatched,
  // off, or unreachable backend state fails closed as false/503.
  const required = await backendRequiresAccountTokenMode(env);
  return envelope(
    reqId,
    required ? "healthy" : "account_token_mode_not_required",
    { account_token_mode_required: required },
    required ? 200 : 503,
  );
}

export const HEALTH_DISPATCH = {
  "GET /health": handleHealth,
} satisfies Record<string, TopRoute>;
