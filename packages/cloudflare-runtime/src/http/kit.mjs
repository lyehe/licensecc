// Shared HTTP/security primitives for the Cloudflare Workers in this monorepo (finding 12).
//
// One home for what used to be copy-pasted per worker: the constant-time compare, the
// byte-capped body reader, request-id/client-ip/bearer extraction, the single-line string
// guard, and the JSON response helper. Worker-safe (no `node:` imports, no `Buffer`) and
// runnable raw under `node --test`, so it can be imported by both the `.ts` worker entries
// and the `.mjs` domain modules across services via the package `exports` map.

// The canonical constant-time equality lives in the stateless auth primitive. Re-export it
// here so every worker uses the same implementation instead of a hand-rolled digest compare.
export { constantTimeEqual } from "../auth/primitives.mjs";

// JSON response with a charset-tagged content-type.
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

// Read a request body as text, rejecting as soon as the byte count exceeds maxBytes
// (checks Content-Length first, then streams so a lying header cannot smuggle bytes past).
/**
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, text: string } | { ok: false }>}
 */
export async function readTextBody(request, maxBytes) {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false };
  }
  if (request.body === null) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The response is already determined; cancel errors do not change the rejection.
      }
      return { ok: false };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

// The correlation id for a request: Cloudflare's ray id when present, else a fresh uuid.
export function requestId(request) {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

// The originating client IP per Cloudflare, else "unknown".
export function clientIp(request) {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp !== null && cfIp !== "") {
    return cfIp;
  }
  return "unknown";
}

// The bearer token from the Authorization header, or null. Case-insensitive scheme match and
// tolerant of extra whitespace, so it accepts every form the per-worker copies used to.
export function bearerToken(request) {
  const authorization = request.headers.get("authorization");
  if (authorization === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

// A single-line, delimiter-free string within a length bound, else null. Rejects the
// characters that could break log/key framing (newlines, `=`, NUL) so callers can splice the
// value into `key=value` and `scope:key` contexts without re-escaping.
export function safeString(value, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return null;
  }
  if (value.includes("\n") || value.includes("\r") || value.includes("=") || value.includes("\0")) {
    return null;
  }
  return value;
}
