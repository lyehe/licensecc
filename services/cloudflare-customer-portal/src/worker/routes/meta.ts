// Documentation and backend-truth-bearing readiness routes.

import { DOCS_HTML } from "../docs_page.js";
import { openApiDocument } from "../openapi/document.js";
import { backendOrigin } from "../../auth/portal_destination.mjs";
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
const READINESS_TIMEOUT_MS = 2_000;
const READINESS_MAX_JSON_BYTES = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provesRequiredAccountTokenMode(value: unknown): boolean {
  return isRecord(value) &&
    value.ok === true &&
    value.service === BACKEND_SERVICE &&
    value.account_token_mode === REQUIRED_ACCOUNT_TOKEN_MODE;
}

function readChunkWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("backend health request timed out"));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("backend health request timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  try {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && /^(?:0|[1-9][0-9]*)$/.test(contentLength) && Number(contentLength) > READINESS_MAX_JSON_BYTES) {
      return null;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await readChunkWithAbort(reader, signal);
      if (done) break;
      if (value === undefined) return null;
      total += value.byteLength;
      if (total > READINESS_MAX_JSON_BYTES) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    // Release the upstream body even for a malformed, oversized, or stalled health response.
    try {
      await reader.cancel();
    } catch {
      // A completed body is already closed; there is nothing left to cancel.
    }
    reader.releaseLock();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed upstream cancellation still fails readiness closed through the caller's 503 envelope.
  }
}

async function backendRequiresAccountTokenMode(env: Env): Promise<boolean> {
  const origin = backendOrigin(env);
  if (origin === null) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    const response = await fetch(new URL("/health", origin).toString(), { signal: controller.signal });
    if (response.status !== 200) {
      // The status is enough to fail readiness, but its body may be an endless upstream stream. Drain
      // no bytes and cancel it before returning the established 503 envelope.
      await cancelResponseBody(response);
      return false;
    }
    return provesRequiredAccountTokenMode(await readBoundedJson(response, controller.signal));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
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
