# Local SQLite host for the licensecc online verifier

Run the **unmodified** licensecc verifier Worker
(`services/cloudflare-licensing-backend/src/index.ts`) off Cloudflare, on a
plain Node process backed by Node's built-in SQLite. **Zero changes
to the Worker's security code.** The Worker is imported as-is and called via its
exported `fetch(request, env)`; only the `DB` binding is swapped for a SQLite
adapter that implements the same `D1DatabaseLike` / `D1PreparedStatementLike`
surface the Worker expects.

This host is for loopback-only evaluation and development. It does not deploy
or modify Cloudflare resources. The commands below create ignored build output,
an untracked local SQLite database, and an ignored local test signing key; none
of those artifacts is production configuration. Do not stage or commit the
database or private key. Follow the backend's owning hosted runbook for a
staging or production deployment.

## What's here

| File | Role |
|---|---|
| `db-sqlite.mjs` | Node `node:sqlite` adapter implementing `prepare(sql).bind(...).first()/.all()/.run()`, `batch()`, and `withSession()`. `.first()` returns the row or `null`; a real query error **throws** (so the Worker's try/catch maps it to HTTP 500). Opens with `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`. |
| `migrate.mjs` | Applies the real `../migrations/*.sql` to a SQLite file. Idempotent via a `_migrations` ledger. Produces the same final schema the schema-parity contract asserts (`../schema.sql`). |
| `server.mjs` | `node:http` front-end. Builds a WHATWG `Request` per request, constructs the Worker `Env` (`DB` = the adapter, `VERIFY_RATE_LIMITER` = undefined -> Worker uses its D1 rate-limit fallback, all other vars from `process.env`), imports the compiled Worker's default `{ fetch }`, calls it, and writes the `Response` back. |

## Prerequisites

- Node 22.5+ with `--experimental-sqlite`. The package scripts include the
  flag; `node:sqlite` was introduced in Node 22.5.
- The root npm workspace installed once from the repository root:

  ```console
  npm ci
  ```

  Do not run `npm ci` in this service and do not use `npm --prefix`; the root
  lockfile is the dependency authority.
- The Worker compiled to `../dist/index.js` (the host imports the **compiled**
  Worker, never edits the source).
- An RSA signing key (PKCS#8 PEM) + key id — the Worker requires these to sign
  `lccoa1.` assertions. For local evaluation, generate a disposable key as
  shown below and never ship or commit its private material.

## Run steps

After the root install above, all remaining commands are run from the service
directory (`services/cloudflare-licensing-backend/`).

First build the Worker and generate a disposable local signing key. These
commands are the same in PowerShell and Bash:

```console
# Build the Worker (tsc -> dist/index.js).
npm run build

# Generate a disposable local signing key (writes ignored .online-key/ files).
node scripts/generate-online-key.mjs --out-dir .online-key
```

In Bash, initialize the local database, set the signing environment, and start
the foreground server:

```bash
export DB_PATH=app.db
npm run db:local:init

export PORT=8787
export ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM="$(cat .online-key/online_private_key.pkcs8.pem)"
export ONLINE_SIGNING_KEY_ID="sha256:local-dev-key"
npm run local:server
```

In PowerShell, perform the same initialization before starting the foreground
server:

```powershell
$env:DB_PATH = "app.db"
npm run db:local:init

$env:PORT = "8787"
$env:ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM = Get-Content .online-key/online_private_key.pkcs8.pem -Raw
$env:ONLINE_SIGNING_KEY_ID = "sha256:local-dev-key"
npm run local:server
```

Leave that terminal running. Use a second terminal in the same service
directory for the seed and verification commands below.

## Exposing the host safely

`/v1/verify` is a **signing oracle** — it mints signed `lccoa1.` assertions. Off Cloudflare you
lose the edge WAF, the per-client rate limiter, and a trustworthy client IP, so the host closes
the two gaps the security review flagged:

- **Spoofable client IP.** The Worker keys its per-client rate-limit tier on `cf-connecting-ip`,
  which off Cloudflare is attacker-supplied. The host **strips** any inbound `cf-connecting-ip` /
  `x-forwarded-for` / `x-real-ip` and re-derives the caller IP from the **real socket peer**.
  Behind a reverse proxy, set `TRUST_PROXY_HEADER` (e.g. `x-real-ip`, or `x-forwarded-for` to take
  the rightmost hop) — and ensure that proxy overwrites the header from untrusted clients.
- **Non-loopback bind guard.** The host binds `127.0.0.1` by default and **refuses to bind a
  non-loopback address unless rate limiting is enabled** (`D1_RATE_LIMIT_ENABLED=1` + the
  `D1_*_RATE_LIMIT_*` tiers).

**Recommendation:** keep `HOST=127.0.0.1` and front the host with a reverse proxy that does TLS,
authentication, and rate limiting. Never expose `/v1/verify` directly. The guard + IP logic live
in `../host-common.mjs` (unit-tested in `../host-common.test.mjs`).

## Seed an entitlement, then verify

The verify path reads from `entitlements` (and optionally
`entitlement_devices`). In the second terminal, seed a row with the existing
CLI, or run this shell-independent Node command directly:

```console
# Existing project tooling (writes to the same SQLite file via its own path):
#   node scripts/entitlement.mjs ...   (see that script's --help)

# Or seed directly for a smoke test:
node --experimental-sqlite -e 'import("node:sqlite").then(({DatabaseSync})=>{const db=new DatabaseSync("app.db");const now=Math.floor(Date.now()/1e3);db.prepare("INSERT OR REPLACE INTO entitlements (project,feature,license_fingerprint,device_hash,status,assertion_ttl_seconds,cache_ttl_seconds,revocation_seq,created_at,updated_at,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("DEFAULT","DEFAULT","a".repeat(64),"","active",300,3600,0,now,now,"");db.close();})'
```

Then verify from Bash:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"service":"licensecc-online-verifier"}

curl -s -X POST http://127.0.0.1:8787/v1/verify \
  -H 'content-type: application/json' \
  -d "{\"project\":\"DEFAULT\",\"feature\":\"DEFAULT\",\"license_fingerprint\":\"$(printf 'a%.0s' {1..64})\",\"device_hash\":\"\",\"nonce\":\"$(printf 'b%.0s' {1..64})\"}"
# {"ok":true,"code":"entitlement_ok","assertion":"lccoa1...."}
```

Or verify from PowerShell:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8787/health

$body = @{
  project = "DEFAULT"
  feature = "DEFAULT"
  license_fingerprint = "a" * 64
  device_hash = ""
  nonce = "b" * 64
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri http://127.0.0.1:8787/v1/verify `
  -Method Post -ContentType "application/json" -Body $body
```

The health response reports `ok` and the service name. The verification
response reports `ok`, `code = entitlement_ok`, and a signed `assertion`.

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

The Worker uses a deliberately tiny DB surface (`src/env.ts`):
`prepare(sql)` -> chainable `.bind(...)` -> `.first<T>()` (row or `null`),
`.all<T>()`, `.run()`, transactional `.batch()`, and optional `.withSession()`.
The verify path imports exactly six statements from `src/db/verify-statements.mjs` — the
`rate_limit_counters` `INSERT ... ON CONFLICT ... RETURNING` upsert and cleanup
`DELETE`, the `entitlements` SELECT, the `entitlement_devices` SELECT, and the
`request_proof_nonces` consume and cleanup statements. The
adapter honours the load-bearing contract: **`null` for an empty result, a
thrown `Error` for a real failure** — which is what the Worker's two
`try { ... } catch` branches rely on to distinguish "no entitlement / unknown
device" (a denial) from "D1 error" (HTTP 500).
