# Local SQLite host for the licensecc online verifier

Run the **unmodified** licensecc verifier Worker
(`services/cloudflare-licensing-backend/src/index.ts`) off Cloudflare, on a
plain Node process backed by standard SQLite (`better-sqlite3`). **Zero changes
to the Worker's security code.** The Worker is imported as-is and called via its
exported `fetch(request, env)`; only the `DB` binding is swapped for a SQLite
adapter that implements the same `D1DatabaseLike` / `D1PreparedStatementLike`
surface the Worker expects.

## What's here

| File | Role |
|---|---|
| `db-sqlite.mjs` | `better-sqlite3` adapter implementing `prepare(sql).bind(...).first()/.all()/.run()`. `.first()` returns the row or `null`; a real query error **throws** (so the Worker's try/catch maps it to HTTP 500). Opens with `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`. |
| `migrate.mjs` | Applies the real `../migrations/0001..0008` (in order) to a SQLite file. Idempotent via a `_migrations` ledger. Produces the same final schema the schema-parity contract asserts (`../schema.sql`). |
| `server.mjs` | `node:http` front-end. Builds a WHATWG `Request` per request, constructs the Worker `Env` (`DB` = the adapter, `VERIFY_RATE_LIMITER` = undefined -> Worker uses its D1 rate-limit fallback, all other vars from `process.env`), imports the compiled Worker's default `{ fetch }`, calls it, and writes the `Response` back. |

## Prerequisites

- Node 20+ (Node 18/19 also work — `server.mjs` shims `globalThis.crypto` from
  `node:crypto`). Tested on Node 22.
- The Worker compiled to `../dist/index.js` (the host imports the **compiled**
  Worker, never edits the source).
- An RSA signing key (PKCS#8 PEM) + key id — the Worker requires these to sign
  `lccoa1.` assertions.

## Run steps

All commands are run from the service directory
(`services/cloudflare-licensing-backend/`).

```bash
# 1. Install the SQLite driver (native module; needs a C toolchain or prebuilt).
npm i better-sqlite3

# 2. Build the Worker (tsc -> dist/index.js). Already wired in package.json.
npm run build

# 3. Create + migrate the database.
node local-host/migrate.mjs app.db

# 4. Provide a signing key. Reuse the project's generator:
#      node scripts/generate-online-key.mjs
#    or generate a throwaway PKCS#8 RSA-3072 key for local testing:
node -e '(async()=>{const {webcrypto:c}=await import("node:crypto");const k=await c.subtle.generateKey({name:"RSASSA-PKCS1-v1_5",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["sign","verify"]);const p=Buffer.from(new Uint8Array(await c.subtle.exportKey("pkcs8",k.privateKey))).toString("base64");require("fs").writeFileSync("online-private-key.pem","-----BEGIN PRIVATE KEY-----\n"+p.match(/.{1,64}/g).join("\n")+"\n-----END PRIVATE KEY-----\n")})()'

# 5. Start the host.
PORT=8787 DB_PATH=app.db \
  ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM="$(cat online-private-key.pem)" \
  ONLINE_SIGNING_KEY_ID="sha256:local-dev-key" \
  node local-host/server.mjs
```

On Windows PowerShell, set the env vars first, then run:

```powershell
$env:PORT="8787"; $env:DB_PATH="app.db"
$env:ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM = Get-Content online-private-key.pem -Raw
$env:ONLINE_SIGNING_KEY_ID = "sha256:local-dev-key"
node local-host/server.mjs
```

## Seed an entitlement, then verify

The verify path reads from `entitlements` (and optionally `entitlement_devices`).
Seed a row with the existing CLI, or directly:

```bash
# Existing project tooling (writes to the same SQLite file via its own path):
#   node scripts/entitlement.mjs ...   (see that script's --help)

# Or seed directly for a smoke test:
node -e '(async()=>{const {default:D}=await import("better-sqlite3");const db=new D("app.db");const now=Math.floor(Date.now()/1e3);db.prepare("INSERT OR REPLACE INTO entitlements (project,feature,license_fingerprint,device_hash,status,assertion_ttl_seconds,cache_ttl_seconds,revocation_seq,created_at,updated_at,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("DEFAULT","DEFAULT","a".repeat(64),"","active",300,3600,0,now,now,"");})()'
```

Then:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"service":"licensecc-online-verifier"}

curl -s -X POST http://127.0.0.1:8787/v1/verify \
  -H 'content-type: application/json' \
  -d "{\"project\":\"DEFAULT\",\"feature\":\"DEFAULT\",\"license_fingerprint\":\"$(printf 'a%.0s' {1..64})\",\"device_hash\":\"\",\"nonce\":\"$(printf 'b%.0s' {1..64})\"}"
# {"ok":true,"code":"entitlement_ok","assertion":"lccoa1...."}
```

A request for a license fingerprint with no active entitlement returns
`{"ok":false,"code":"entitlement_denied"}` with HTTP **200** (a denial, not an
error). A real DB failure returns HTTP **500** `{"ok":false,"code":"verification_error"}`.

## Environment variables

`server.mjs` passes these through from `process.env` into the Worker `Env`
(same names as `../wrangler.example.toml`). Only the first two are required.

| Var | Required | Notes |
|---|---|---|
| `ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM` | yes | PKCS#8 PEM RSA private key used to sign `lccoa1.` assertions. |
| `ONLINE_SIGNING_KEY_ID` | yes | e.g. `sha256:<id>`; embedded in the assertion header. |
| `MAX_ASSERTION_TTL_SECONDS`, `MAX_CACHE_TTL_SECONDS` | no | TTL clamps. |
| `LOG_RATE_LIMIT_DECISIONS` | no | `1` to log limiter decisions. |
| `D1_RATE_LIMIT_ENABLED` | no | `1` to enable the D1-backed limiter tiers (default off, matching the example). |
| `D1_RATE_LIMIT_LIMIT`, `D1_RATE_LIMIT_PERIOD_SECONDS` | no | base tier defaults (20 / 60). |
| `D1_CLIENT_RATE_LIMIT_*`, `D1_ENTITLEMENT_RATE_LIMIT_*`, `D1_GLOBAL_RATE_LIMIT_*` | no | per-tier overrides. |
| `REQUEST_SIGNATURE_MODE`, `REQUEST_SIGNATURE_MAX_SKEW_SECONDS` | no | proof-of-possession rollout (`off`/`soft`/`required`). |
| `PORT`, `HOST`, `DB_PATH` | no | host-only knobs (defaults `8787`, `127.0.0.1`, `app.db`). |

## Bindings that do NOT exist locally

- **`VERIFY_RATE_LIMITER`** — the Cloudflare native rate-limiter binding. There
  is no off-Cloudflare equivalent, so `server.mjs` leaves it `undefined`. The
  Worker already treats it as optional and falls back to its **D1-backed**
  rate-limit tiers (`checkD1RateLimitTier`), which the SQLite adapter fully
  supports (the `rate_limit_counters` upsert + cleanup). To exercise rate
  limiting locally, set `D1_RATE_LIMIT_ENABLED=1`.

Everything else the verify path needs (`DB`, the signing secrets, the string
vars) is satisfied here, so the Worker's security logic runs unchanged.

## How the adapter maps to the Worker's DB contract

The Worker uses a deliberately tiny DB surface (`src/index.ts` lines 9-17):
`prepare(sql)` -> chainable `.bind(...)` -> `.first<T>()` (row or `null`) and
`.run()` (result ignored). The verify path issues exactly four statements — the
`rate_limit_counters` `INSERT ... ON CONFLICT ... RETURNING` upsert and cleanup
`DELETE`, the `entitlements` SELECT, and the `entitlement_devices` SELECT. The
adapter honours the load-bearing contract: **`null` for an empty result, a
thrown `Error` for a real failure** — which is what the Worker's two
`try { ... } catch` branches rely on to distinguish "no entitlement / unknown
device" (a denial) from "D1 error" (HTTP 500).
