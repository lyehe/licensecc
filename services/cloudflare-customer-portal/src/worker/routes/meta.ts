// Documentation and backend-truth-bearing readiness routes.

import { DOCS_HTML } from "../docs_page.js";
import { openApiDocument } from "../openapi/document.js";
import { secureHtml } from "@licensecc/cloudflare-runtime/http/kit";
import { backendOrigin } from "../../auth/portal_destination.mjs";
import type { Env, ExecutionContextLike, TopRoute } from "../env.js";
import { envelope, json } from "../support.js";

export const META_DISPATCH = {
  "GET /openapi.json": () => json(openApiDocument, 200, { "cache-control": "no-store" }),
  "GET /docs": () => secureHtml(DOCS_HTML),
};

const BACKEND_SERVICE = "licensecc-online-verifier";
const READINESS_TIMEOUT_MS = 2_000;
const READINESS_MAX_JSON_BYTES = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provesProtectedReadiness(value: unknown): boolean {
  return isRecord(value) &&
    value.ok === true &&
    value.service === BACKEND_SERVICE &&
    value.protected_device_ready === true;
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

// True only when the backend's own /health proves protected readiness. Every missing, malformed,
// mismatched, non-200 or unreachable backend answer fails closed as not ready.
async function backendProtectedReady(env: Env): Promise<boolean> {
  const origin = backendOrigin(env);
  if (origin === null) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
  try {
    // Redirects are terminal, even though readiness carries no credential: never let an untrusted
    // Location turn this explicit backend trust check into a second request.
    const target = new URL("/health", origin).toString();
    const init = { signal: controller.signal, redirect: "manual" as RequestRedirect };
    const response = env.BACKEND === undefined
      ? await fetch(target, init)
      : await env.BACKEND.fetch(new Request(target, init));
    if (response.status !== 200) {
      // The status is enough to fail readiness, but its body may be an endless upstream stream. Drain
      // no bytes and cancel it before returning the established 503 envelope.
      await cancelResponseBody(response);
      return false;
    }
    return provesProtectedReadiness(await readBoundedJson(response, controller.signal));
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
  const ready = await backendProtectedReady(env);
  return envelope(
    reqId,
    ready ? "healthy" : "backend_not_ready",
    { backend_protected_ready: ready },
    ready ? 200 : 503,
  );
}

export const HEALTH_DISPATCH = {
  "GET /health": handleHealth,
} satisfies Record<string, TopRoute>;
