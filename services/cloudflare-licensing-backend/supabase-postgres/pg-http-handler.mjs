import { isSupportedPgRoute } from "./pg-route-guard.mjs";

export const PG_MAX_BODY_BYTES = 4 * 1024;

export class BodyTooLargeError extends Error {}

export async function readNodeBody(req, maxBytes = PG_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const fail = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.destroy?.();
      reject(new BodyTooLargeError("request body exceeds 4 KiB"));
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail();
      chunks.push(chunk);
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    const onError = reject;
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

export function createPgHttpHandler({ worker, buildEnv, nodeRequestToWeb, webResponseToNode }) {
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!isSupportedPgRoute(req.method, pathname)) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "not_supported_on_postgres_adapter" }));
      return;
    }
    try {
      const request = await nodeRequestToWeb(req);
      await webResponseToNode(await worker.fetch(request, buildEnv()), res);
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: status === 413 ? "payload_too_large" : "host_error" }));
    }
  };
}
