import { isSupportedPgRoute } from "./pg-route-guard.mjs";

export const PG_MAX_BODY_BYTES = 4 * 1024;

export class BodyTooLargeError extends Error {}

export function declaredBodyTooLarge(req, maxBytes = PG_MAX_BODY_BYTES) {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const value = req.headers?.["content-length"];
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return false;
  try {
    return BigInt(value) > BigInt(maxBytes);
  } catch {
    return false;
  }
}

export async function readNodeBody(req, maxBytes = PG_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause?.();
      reject(error);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(new BodyTooLargeError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new Error("request body aborted"));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

export function createNodeRequestToWeb({ defaultHost, clientIpHeaders, clientIpFromRequest }) {
  return async (req) => {
    const scheme = req.socket?.encrypted ? "https" : "http";
    const host = req.headers.host ?? defaultHost;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || clientIpHeaders.includes(key.toLowerCase())) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    headers.set("cf-connecting-ip", clientIpFromRequest(req));
    const body = await readNodeBody(req);
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;
    return new Request(`${scheme}://${host}${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? body : undefined,
    });
  };
}

function writeJson(res, status, code, { close = false } = {}) {
  const body = JSON.stringify({ ok: false, code });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...(close ? { connection: "close" } : {}),
  });
  res.end(body);
}

function rejectOversizedBody(req, res) {
  writeJson(res, 413, "body_too_large", { close: true });
  // Drain without retaining bytes. `connection: close` prevents reuse, while avoiding
  // req.destroy() until after the response has reached the client (which can surface as ECONNRESET).
  req.resume?.();
}

export function createPgHttpHandler({ worker, buildEnv, nodeRequestToWeb, webResponseToNode }) {
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!isSupportedPgRoute(req.method, pathname)) {
      writeJson(res, 501, "not_supported_on_postgres_adapter");
      return;
    }
    if (declaredBodyTooLarge(req)) {
      rejectOversizedBody(req, res);
      return;
    }
    try {
      const request = await nodeRequestToWeb(req);
      await webResponseToNode(await worker.fetch(request, buildEnv()), res);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        rejectOversizedBody(req, res);
        return;
      }
      writeJson(res, 500, "host_error");
    }
  };
}
