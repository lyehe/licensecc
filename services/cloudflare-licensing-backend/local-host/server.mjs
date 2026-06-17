// server.mjs
//
// A node:http front-end that runs the UNMODIFIED licensecc Worker
// (services/cloudflare-licensing-backend/src/index.ts, compiled to dist/index.js)
// off Cloudflare, backed by standard SQLite via db-sqlite.mjs.
//
// It does three things per request:
//   1. Build a WHATWG `Request` from the incoming node req (method/url/headers/body).
//   2. Build the Worker `Env`:
//        - DB                 = the better-sqlite3 D1 adapter (the only D1 binding)
//        - VERIFY_RATE_LIMITER = undefined  -> Worker falls back to its D1-backed
//                                              rate-limit tiers (checkD1RateLimitTier),
//                                              which our adapter fully supports.
//        - everything else    = passed through from process.env (secrets/vars).
//   3. Call worker.fetch(request, env) and stream the WHATWG Response back to node.
//
// ZERO changes to the Worker's security code: we import its default export and
// call .fetch(request, env) exactly as the existing test harness does
// (test/online-verifier.test.mjs imports `worker` from ../dist/index.js and
// calls `worker.fetch(new Request(...), env)`). The Worker's fetch signature is
// `async fetch(request, env)` — there is no ctx/ExecutionContext, so no
// waitUntil hook is needed.
//
// Build the Worker first:  npm run build   (tsc -> dist/index.js)
//
// Run:
//   PORT=8787 DB_PATH=app.db \
//   ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM="$(cat online-private-key.pem)" \
//   ONLINE_SIGNING_KEY_ID="sha256:..." \
//   node server.mjs

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

import { openDatabase } from "./db-sqlite.mjs";

// --- Node <20 crypto shim -------------------------------------------------
// The Worker uses WebCrypto (crypto.subtle) for RSA signing / ECDSA verify.
// Node 20+ exposes a global `crypto`; older Node needs this shim. Guarded so we
// never clobber an existing global.
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = webcrypto;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the COMPILED Worker (dist/index.js). We do NOT touch its source.
// local-host/ is inside the service dir, so dist/ is one level up.
const workerModulePath = resolve(__dirname, "..", "dist", "index.js");
// Dynamic import() of an absolute path needs a file:// URL on Windows
// (a bare "C:\\..." path is rejected by the ESM loader).
const workerModuleUrl = pathToFileURL(workerModulePath).href;
let worker;
try {
  ({ default: worker } = await import(workerModuleUrl));
} catch (error) {
  console.error(
    `Failed to import compiled Worker at ${workerModulePath}.\n` +
      `Build it first from the service directory:  npm run build\n` +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
if (!worker || typeof worker.fetch !== "function") {
  console.error(`Imported module from ${workerModulePath} has no default { fetch }.`);
  process.exit(1);
}

// --- Open the SQLite-backed D1 adapter ------------------------------------
const DB_PATH = process.env.DB_PATH ?? "app.db";
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const { adapter: DB } = openDatabase(resolve(DB_PATH));

// --- Build the Worker Env from process.env --------------------------------
// DB is the only binding we synthesize. VERIFY_RATE_LIMITER is left undefined
// on purpose so the Worker uses its D1 rate-limit fallback. Every other field
// is a plain string var / secret read straight from the environment.
//
// Required by the Worker (it will fail to sign assertions without them):
//   ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM, ONLINE_SIGNING_KEY_ID
function buildEnv() {
  const passthrough = [
    "ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM",
    "ONLINE_SIGNING_KEY_ID",
    "MAX_ASSERTION_TTL_SECONDS",
    "MAX_CACHE_TTL_SECONDS",
    "LOG_RATE_LIMIT_DECISIONS",
    "D1_RATE_LIMIT_ENABLED",
    "D1_RATE_LIMIT_LIMIT",
    "D1_RATE_LIMIT_PERIOD_SECONDS",
    "D1_CLIENT_RATE_LIMIT_LIMIT",
    "D1_CLIENT_RATE_LIMIT_PERIOD_SECONDS",
    "D1_ENTITLEMENT_RATE_LIMIT_LIMIT",
    "D1_ENTITLEMENT_RATE_LIMIT_PERIOD_SECONDS",
    "D1_GLOBAL_RATE_LIMIT_ENABLED",
    "D1_GLOBAL_RATE_LIMIT_LIMIT",
    "D1_GLOBAL_RATE_LIMIT_PERIOD_SECONDS",
    "REQUEST_SIGNATURE_MODE",
    "REQUEST_SIGNATURE_MAX_SKEW_SECONDS",
  ];
  const env = {
    DB,
    // VERIFY_RATE_LIMITER intentionally omitted (undefined): use D1 fallback.
  };
  for (const key of passthrough) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

if (!process.env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM || !process.env.ONLINE_SIGNING_KEY_ID) {
  console.warn(
    "WARNING: ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM and/or ONLINE_SIGNING_KEY_ID are not set.\n" +
      "         /v1/verify will fail to sign assertions (the Worker requires these).\n" +
      "         /health will still respond.",
  );
}

// --- node req -> WHATWG Request -------------------------------------------
function nodeRequestToWeb(req) {
  const scheme = req.socket && req.socket.encrypted ? "https" : "http";
  const host = req.headers.host ?? `${HOST}:${PORT}`;
  const url = `${scheme}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  return new Promise((resolveReq, rejectReq) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", rejectReq);
    req.on("end", () => {
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
      const init = {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      };
      try {
        resolveReq(new Request(url, init));
      } catch (error) {
        rejectReq(error);
      }
    });
  });
}

// --- WHATWG Response -> node res ------------------------------------------
async function webResponseToNode(response, res) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }
  res.writeHead(response.status, headers);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

const server = createServer(async (req, res) => {
  try {
    const request = await nodeRequestToWeb(req);
    const response = await worker.fetch(request, buildEnv());
    await webResponseToNode(response, res);
  } catch (error) {
    // The Worker itself maps its own errors to JSON 500s; this only catches
    // failures in the node<->WHATWG bridge (e.g. malformed request).
    const message = error instanceof Error ? error.message : "host bridge error";
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "host_error", error: message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`licensecc local host listening on http://${HOST}:${PORT}`);
  console.log(`  DB:     ${resolve(DB_PATH)}`);
  console.log(`  Worker: ${workerModulePath}`);
  console.log(`  Routes: GET /health, POST /v1/verify`);
});
