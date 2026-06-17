// server.mjs
//
// A node:http front-end that runs the UNMODIFIED licensecc Worker
// (services/cloudflare-licensing-backend/src/index.ts, compiled to dist/index.js)
// off Cloudflare, backed by PostgreSQL / Supabase via db-postgres.mjs.
//
// This is the Postgres counterpart of local-host/server.mjs (which is SQLite). It is
// IDENTICAL except for the DB binding:
//   - DB = createPostgresDatabase(DATABASE_URL, { workerSql: true })
//     The Worker emits D1/SQLite SQL; the adapter translates it to PG (`?`->`$n` and the
//     bare ON CONFLICT counter update -> table-qualified). The CLI keeps the default (no
//     translation). schema.pg.sql must already be applied.
//   - VERIFY_RATE_LIMITER = undefined  -> Worker uses its D1 rate-limit fallback
//     (checkD1RateLimitTier), which the Postgres adapter fully supports (the rate-limit
//     upsert is the load-bearing ON CONFLICT ... RETURNING statement).
//
// ZERO changes to the Worker's security code: we import its default export and call
// .fetch(request, env) exactly as the test harness does. The Worker's fetch signature is
// `async fetch(request, env)` — no ctx/ExecutionContext, so no waitUntil hook is needed.
//
// Setup:
//   npm install postgres            # postgres.js (the adapter's runtime dep)
//   npm run build                   # tsc -> dist/index.js
//   psql "$DATABASE_URL" -f supabase-postgres/schema.pg.sql   # apply the schema once
//
// Run:
//   PORT=8787 \
//   DATABASE_URL=postgresql://user:pass@host:5432/db \
//   ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM="$(cat .online-key/online_private_key.pkcs8.pem)" \
//   ONLINE_SIGNING_KEY_ID="sha256:..." \
//   node supabase-postgres/server.mjs

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";

import { createPostgresDatabase, closePool } from "./db-postgres.mjs";

// --- Node <20 crypto shim (the Worker uses crypto.subtle for RSA sign / ECDSA verify) ---
if (typeof globalThis.crypto === "undefined") {
  globalThis.crypto = webcrypto;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the COMPILED Worker (dist/index.js); we do NOT touch its source. supabase-postgres/
// is one level under the service dir, so dist/ is one level up (same as local-host/).
const workerModulePath = resolve(__dirname, "..", "dist", "index.js");
const workerModuleUrl = pathToFileURL(workerModulePath).href; // absolute path needs file:// on Windows
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

// --- Open the Postgres-backed D1 adapter (one pool at startup) -------------
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (e.g. postgresql://user:pass@host:5432/db).");
  process.exit(1);
}

// workerSql: true -> translate the UNMODIFIED Worker's D1/SQLite SQL to run on Postgres.
const DB = createPostgresDatabase(DATABASE_URL, { workerSql: true });

// --- Build the Worker Env from process.env --------------------------------
// DB is the only binding we synthesize. VERIFY_RATE_LIMITER is left undefined so the
// Worker uses its D1 rate-limit fallback. Everything else is a plain var/secret.
// Required to sign: ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM, ONLINE_SIGNING_KEY_ID.
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
    // The Worker maps its own errors to JSON 500s; this only catches node<->WHATWG bridge failures.
    const message = error instanceof Error ? error.message : "host bridge error";
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "host_error", error: message }));
  }
});

// Close the pool on shutdown so the process exits cleanly.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}

server.listen(PORT, HOST, () => {
  console.log(`licensecc Postgres host listening on http://${HOST}:${PORT}`);
  console.log(`  DB:     ${DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`  Worker: ${workerModulePath}`);
  console.log(`  Routes: GET /health, POST /v1/verify`);
});
