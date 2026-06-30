# Production Deploy Runbook — licensecc operations back-office

**Date:** 2026-06-30
**Scope:** Deploy the three Cloudflare Workers + one D1 database that make up the licensecc
operations back-office, plus the companion D1 backup Worker. All four currently live on the
`feature/operations-back-office` branch (pushed to the `lyehe` fork only — **NOT** on
`develop`/mainline, **NOT** yet deployed).
**Audience:** the operator performing the cutover.
**Status:** operational guide. Every command below is derived from the real files in
`services/`. Values you must supply are flagged `<LIKE_THIS>` (placeholder).

> This runbook is faithful to the repo as of the branch above. Where a step needs an operator
> decision or a value you must supply, it says so explicitly. Open gaps/uncertainties are listed
> at the very end — read them before you start.

---

## 1. Overview & topology

Four Cloudflare Workers, **one** shared entitlements D1 database:

| Worker (deployed `name`) | Directory | Binds D1? | Role |
|---|---|---|---|
| `licensecc-online-verifier` | `services/cloudflare-licensing-backend/` | yes (`DB`) | Public verifier (`POST /v1/verify` → signed `lccoa1.` assertion), order-ingest (`POST /v1/orders`), lease/seat platform, account-token isolation, the `*/5` cron sweeps + webhook dispatch. **Owns the migrations.** |
| `licensecc-admin` | `services/cloudflare-license-admin/` | yes (`DB`, same DB) | Private admin Worker + React console for managing entitlements. Cloudflare Access protected. Runs **no** migrations of its own. |
| `licensecc-customer-portal` | `services/cloudflare-customer-portal/` | yes (`DB`, same DB) | Customer self-service portal (magic-link OTP login, downloads, seat actions proxied to the backend with per-action account tokens). Runs **no** migrations of its own. |
| `licensecc-d1-backup` | `services/cloudflare-d1-backup/` | no (uses D1 REST API + R2) | Scheduled D1 → R2 SQL-dump backups, Time Travel, restore drill. |

Topology invariants (these are baked into the repo, do not "fix" them):

- **One entitlements D1, one audit log, no split-brain.** Admin and portal bind the **same**
  `database_name`/`database_id` as the backend. Their `migrations_dir` points at
  `../cloudflare-licensing-backend/migrations` so a stray `wrangler d1 migrations apply` in
  admin/portal cannot diverge the schema. The licensing-backend is the single migration owner.
- **The deployed Worker `name` and D1 `database_name` intentionally remain
  `licensecc-online-verifier`** even though the directory was renamed to
  `cloudflare-licensing-backend`. This is deliberate so live infra and hardcoded client URLs are
  not orphaned. Do not rename the deployed Worker or the database.
- The optional two-D1 replica topology (`PUBLIC_VERIFIER_URL` + `SYNC_API_TOKEN` +
  `/api/sync/entitlements`) is **not** the source of truth here and is not used in this single-D1
  deployment.

> There is a fifth directory `services/cloudflare-online-verifier/` — the **pre-rename** copy.
> Deploy from `cloudflare-licensing-backend/`, not the old one.

---

## 2. Prerequisites

You must have / decide:

- A **Cloudflare account** with Workers Paid (the D1-backup uses Cloudflare **Workflows** and the
  backend uses a **rate-limit binding**; both may require a paid plan). `<CLOUDFLARE_ACCOUNT_ID>`.
- **wrangler** authenticated: `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`). Node + npm
  installed. All four services pin `wrangler ^4.x` as a devDependency, so `npx wrangler` from each
  service directory uses the local pinned version.
- A **D1 database** (you create it in §3). One database serves all three app Workers.
- An **R2 bucket** for backups (§3).
- A **Cloudflare Access application** in front of the admin console (issuer, audience, JWKS), and
  the **admin/reader email allowlists** (§9). `<ADMIN_ACCESS_*>`.
- An **email provider** for the portal — Resend or a Resend-compatible API (`POST {base}/emails`,
  `Authorization: Bearer <key>`). `<PORTAL_EMAIL_*>`. (Email being unconfigured does **not** 503 the
  portal — it falls back to the operator bootstrap path; see §9.)
- A C++ build of the licensecc verifier with the **online-assertion public key ring** compiled in,
  whose key-id matches the server signing key (§4, §10).
- A `uv`/Python toolchain (for `check-schema-parity.py`, run via `uv run`).

Per-service local validation before you touch production (run from each service dir):

```console
npm ci
npm run lint
npm test
npm run build      # backend: tsc; admin/portal: build:worker (tsc) + build:ui (vite) → ./dist
npm run dry-run    # wrangler deploy --dry-run; catches config/binding errors without deploying
```

---

## 3. Provision Cloudflare resources

### 3.1 Create the shared D1 database

From `services/cloudflare-licensing-backend/`:

```console
npx wrangler d1 create licensecc-online-verifier
```

Record the returned **`database_id`** — call it `<D1_DATABASE_ID>`. (Keep the name
`licensecc-online-verifier`; see §1.)

### 3.2 Create the R2 backup bucket

From `services/cloudflare-d1-backup/`:

```console
npx wrangler r2 bucket create licensecc-d1-backups
```

### 3.3 Copy each `wrangler.example.*` to a real config and fill in ids

The committed `wrangler.toml` files in `cloudflare-license-admin/` and
`cloudflare-customer-portal/` are the operator's **existing staging/test** configs (Worker names
end in `-test`, with a real staging `database_id`). For a **new production** deployment, copy the
`*.example.*` template, then fill the placeholders. Decide whether you reuse the existing
staging infra or stand up production-named Workers — the runbook below assumes you produce real
production configs from the examples.

| Service | Copy command | Fill in |
|---|---|---|
| backend | `cp wrangler.example.toml wrangler.toml` | `[[d1_databases]] database_id` ← `<D1_DATABASE_ID>` (replace `replace-with-d1-database-id`). Confirm `[[ratelimits]] namespace_id` is a positive-integer string (e.g. `"1001"`); if your account can't use the binding, remove the `[[ratelimits]]` block (Worker still runs). Set `[vars]` cutover modes per §8. |
| admin | `cp wrangler.example.jsonc wrangler.jsonc` | `d1_databases[0].database_id` ← `<D1_DATABASE_ID>`; `vars.ADMIN_ACCESS_*` per §9; pick the Worker `name` (default `licensecc-admin`). |
| portal | `cp wrangler.example.jsonc wrangler.jsonc` | `d1_databases[0].database_id` ← `<D1_DATABASE_ID>`; `vars.PORTAL_PUBLIC_ORIGIN`, `vars.BACKEND_ORIGIN`, `vars.PORTAL_EMAIL_FROM`; keep `vars.ACCOUNT_TOKEN_MODE = "required"` (§9). |
| d1-backup | `cp wrangler.example.jsonc wrangler.jsonc` | `vars.ACCOUNT_ID` ← `<CLOUDFLARE_ACCOUNT_ID>`; `vars.DATABASE_ID` ← `<D1_DATABASE_ID>`; keep `DATABASE_NAME = "licensecc-online-verifier"`, `BACKUP_PREFIX`, `BACKUP_RETENTION_DAYS`; confirm `r2_buckets[0].bucket_name = "licensecc-d1-backups"`. |

> **Config-file naming gotcha.** The backend's `migrate:remote` script and several READMEs
> reference `wrangler.toml`; `npm run dry-run` for the backend references `wrangler.example.toml`.
> Admin/portal `migrate:local` and `dry-run` reference the backend's `wrangler.example.toml` /
> their own `wrangler.example.jsonc`. **For a real deploy, point each command at the config you
> actually filled in** (e.g. `--config wrangler.toml` / `--config wrangler.jsonc`) rather than the
> `.example.` file. The example files keep the `replace-with-d1-database-id` placeholder.

---

## 4. Generate signing material (and how it must match the C++ verifier)

There are **three independent key systems** plus several HMAC secret maps. Generate the keys
first; their public halves must be compiled into the C++ verifier before clients can validate.

### 4.1 Online-assertion signing key (RSA-3072, the `lccoa1.` assertion)

From `services/cloudflare-licensing-backend/`:

```console
npm run generate-online-key -- --out-dir .online-key
```

Produces (do not commit `.online-key/`):
- `online_private_key.pkcs8.pem` — PKCS#8 PEM → Worker secret **`ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM`**.
- The printed **`key id: sha256:<hex>`** → Worker secret **`ONLINE_SIGNING_KEY_ID`**.
- `online_public_key_record.cmake.txt` and `online_public_key.json` containing a
  `-DLCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS=...` CMake value (a
  `license::os::SignaturePublicKey("sha256:<hex>", std::vector<uint8_t>{...}, 3072)` record).

**Why this matters (the single most important crypto fact):** the C++ verifier only accepts an
assertion whose key-id is in its compiled-in ring. The server signs with the RSA private key and
stamps `ONLINE_SIGNING_KEY_ID`; that `sha256:<hex>` must exactly equal the SHA-256 of the DER of a
public-key record compiled into the verifier via `LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` (and not
be in `LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS`). Production verifier builds **fail closed** with no
configured ring. Algorithm is fixed: `rsa-pkcs1-sha256`, min 3072 bits. **Never reuse the
license-issuing project key for online assertions.** (See §10 for wiring the CMake value.)

### 4.2 Config-attestation signing key (RSA-3072, the `lcccfg1.` token) — optional

Only needed if you use signed config tokens (`lcc_verify_config`). From the backend dir:

```console
npm run generate-config-key -- --out-dir .config-key   # (script: scripts/generate-config-key.mjs)
```

Produces `config_private_key.pkcs8.pem` (kept offline — used by `config-sign.mjs`, **not** loaded
into the Worker) and a `-DLCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS=...` CMake value to compile
into the verifier. Config tokens are signed **offline** by tooling and consumed in C++ — the
Worker does not issue them.

### 4.3 Device-proof key (ECDSA P-256, request proof-of-possession) — optional

Per-device keys for relay-resistance. Generated client/device-side; only the public SPKI is
registered server-side:

```console
npm run device-key -- generate --out-dir .device-key
npm run entitlement -- device-upsert \
  --fingerprint <64-HEX-FINGERPRINT> \
  --device-key-id sha256:<64-HEX-KEY-ID> \
  --public-key-spki-der-base64 <BASE64-FROM-.device-key/device_public_key.json> \
  --actor <OPERATOR@EXAMPLE.COM> \
  --reason "initial device enrollment" \
  --remote --config wrangler.toml
```

The generated private key is for local integration/bootstrap only; production hosts should create
the P-256 key in the OS keystore / secure enclave / TPM.

### 4.4 Per-project license keypair (C++ side, separate from all of the above)

This is the offline license-issuing key, generated by `lccgen` at C++ configure time — see §10.
It is **distinct** from the online/config/device keys above (design rule: hot lease key ≠ online
assertion key ≠ cold-root project key).

### 4.5 HMAC / pepper secret maps (no generator script — you mint random bytes)

These are JSON maps `{ "<keyId>": "<base64-secret>" }`, each decoded secret **≥ 32 bytes**, loaded
fail-closed (a missing/short/malformed map → the feature rejects). Generate a value with, e.g.,
`openssl rand -base64 32`. They are set as Worker secrets in §5:

- `ORDER_HMAC_SECRETS` — order-ingest HMAC keys (backend).
- `WEBHOOK_SIGNING_SECRETS` — webhook delivery HMAC keys (backend).
- `ACCOUNT_TOKEN_PEPPERS` — per-customer account-token HMAC peppers (backend + portal).
- `PORTAL_OTP_PEPPERS`, `PORTAL_SESSION_PEPPERS` — portal OTP and session HMAC peppers (portal).

The matching active-key **selectors** (`ACCOUNT_TOKEN_ACTIVE_PEPPER_ID`, `WEBHOOK_SIGNING_KEY_ID`)
are non-secret and live in `[vars]`; they must name a key that exists in the corresponding map.

---

## 5. Set secrets per Worker (`wrangler secret put …`)

Run from each service directory. Every secret below; **bold** = required for that Worker to do its
job; the shape notes call out the `≥32-byte` / JSON-map constraints.

### 5.1 Backend (`services/cloudflare-licensing-backend/`)

```console
npx wrangler secret put <NAME>
```

| Secret | Shape / constraint | Purpose |
|---|---|---|
| **`ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM`** | PKCS#8 PEM (RSA-3072) | Signs the `lccoa1.` assertion returned by `/v1/verify`. |
| **`ONLINE_SIGNING_KEY_ID`** | `sha256:<64-hex>` | Key-id stamped into each assertion; must match a compiled-in verifier record (§4.1). |
| `LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM` | PKCS#8 PEM (RSA) | Hot lease key for `/v1/activate`, `/v1/renew` (v201 `.lic` leases). Required only if you use the lease platform. |
| `LEASE_SIGNING_KEY_ID` | `sha256:<64-hex>` | Key-id for issued leases. |
| `LEASE_ISSUE_BEARER` | opaque string | Phase-1 lease authn placeholder; superseded by account tokens. Used only when `ACCOUNT_TOKEN_MODE=off`. |
| **`ACCOUNT_TOKEN_PEPPERS`** | JSON `{id: base64≥32B}` | Keyed HMAC under which per-customer account tokens are stored. Fail-closed: null/short ⇒ 503 on the 6 scoped paths. Required once `ACCOUNT_TOKEN_MODE≠off`. |
| **`ORDER_HMAC_SECRETS`** | JSON `{key_id: base64≥32B}` | HMAC keys verifying `POST /v1/orders`. Asserted non-empty/well-formed at verify time. Required in `ORDER_INGEST_MODE=required` (the default). |
| `WEBHOOK_SIGNING_SECRETS` | JSON `{keyId: base64≥32B}` | HMAC keys the cron webhook dispatcher signs deliveries with. Fail-closed: no usable key ⇒ dispatcher logs + **skips** (never sends unsigned). Required if you enable webhooks. |
| `EMERGENCY_OPERATOR_BEARER` | opaque string | Break-glass bearer for the **separate** `/v1/emergency/*` route only (forces a non-isolated path; every use logged at warn). **Unset = route 404 (closed).** Leave unset in steady state. |

Non-secret selectors that belong in `[vars]` (not secrets): `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID`
(e.g. `"p1"`), `WEBHOOK_SIGNING_KEY_ID` (names the active webhook key). `ORDER_INGEST_AUDIENCE`
(e.g. `"prod"`) is also a `[vars]` value, asserted non-empty in `required` mode.

> Optional two-D1 replica only: the backend does **not** read `SYNC_API_TOKEN`; that secret is the
> admin Worker's (§5.2).

### 5.2 Admin (`services/cloudflare-license-admin/`)

| Secret | Shape | Purpose |
|---|---|---|
| `SYNC_API_TOKEN` | opaque string | Bearer for the **optional** `/api/sync/entitlements` replica path only. Unset ⇒ that route returns `401 sync_auth_not_configured`. Not needed in the single-D1 topology. |
| `ADMIN_DEV_BEARER` | opaque string | **Dev only.** A static bearer that grants admin without Access. The Worker refuses it unless `ENVIRONMENT=development` (returns `500 dev_bearer_forbidden_in_environment` otherwise). **Do not set in production.** |

All real admin auth comes from Cloudflare Access via `[vars]` (`ADMIN_ACCESS_*`, §9), not a secret.

### 5.3 Portal (`services/cloudflare-customer-portal/`)

| Secret | Shape | Purpose |
|---|---|---|
| **`PORTAL_OTP_PEPPERS`** | JSON `{key_id: base64≥32B}` | HMACs the magic-link OTP at rest. Unset/malformed ⇒ `503 config_error`. |
| **`PORTAL_SESSION_PEPPERS`** | JSON `{key_id: base64≥32B}` | HMACs the opaque portal session cookie at rest. Unset/malformed ⇒ `503 config_error`. |
| **`ACCOUNT_TOKEN_PEPPERS`** | JSON `{key_id: base64≥32B}` | Mints the per-action `lcca_` account token the portal proxies to the backend. Unset/malformed ⇒ `503 config_error`. |
| `PORTAL_EMAIL_API_KEY` | Resend API key | Transactional email for magic links. Unconfigured does **not** 503 — login still returns `200 otp_requested`, no email sent, operator uses bootstrap to read the code. |
| `PORTAL_BOOTSTRAP_BEARER` | opaque string | Break-glass operator OTP issuance (returns the secret directly). **Unset = route 404 (closed).** Leave unset in steady state. |

`ACCOUNT_TOKEN_ACTIVE_PEPPER_ID` selector and `PORTAL_BOOTSTRAP_REQUIRE_ACCESS` flag go in
`[vars]` (§9).

### 5.4 D1 backup (`services/cloudflare-d1-backup/`)

| Secret | Shape | Purpose |
|---|---|---|
| **`D1_REST_API_TOKEN`** | Cloudflare API token | Least-privilege token that can **export only** the target D1 database. Required. |
| `BACKUP_TRIGGER_TOKEN` | opaque string | Optional. Enables the authenticated `POST /backup/run` + `GET /backup/status/:id`. Unset ⇒ manual trigger is fail-closed (no oracle). |

---

## 6. Apply migrations

The licensing-backend owns the **0001 … 0020** forward migration sequence (20 files in
`services/cloudflare-licensing-backend/migrations/`). Admin and portal run **none** of their own
— they point at the backend's `migrations_dir`.

**Pre-deploy gate — schema parity.** Confirm the committed `schema.sql` snapshot equals the
applied migrations *before* migrating production. From the backend dir:

```console
npm run schema:parity      # = uv run --no-project python scripts/check-schema-parity.py
```

Apply locally first, then remotely. From the backend dir (point `--config` at your real config):

```console
npm run migrate:local                       # wrangler d1 migrations apply DB --local  --config wrangler.example.toml
npx wrangler d1 migrations apply DB --remote --config wrangler.toml   # = npm run migrate:remote
```

`migrate:remote` runs `wrangler d1 migrations apply DB --remote --config wrangler.toml`, which
applies any unapplied files in `migrations/` (0001 → 0020) to the bound remote D1, recording them
in D1's migration log. **Apply migrations before deploying a Worker version that reads new
columns.** Take a backup first (deploy/enable the d1-backup Worker, §7/§11, or
`POST /backup/run`) before running migrations against live data.

> Do **not** run `wrangler d1 migrations apply` from the admin or portal directory against
> production — their configs deliberately route `migrations_dir` to the backend, but the single
> owner of the apply step is the backend. (`admin`'s `migrate:local` exists only for local dev.)

---

## 7. Deploy each Worker

No service ships a `deploy` npm script — deploy with `npx wrangler deploy` (the dry-run scripts
exist for pre-flight). Deploy order: **backend first** (it owns the schema and is the origin the
portal proxies to), then admin and portal, then the backup Worker. Run from each service dir.

### 7.1 Backend

```console
npm ci
npm test
npm run lint
npm run schema:parity
npx wrangler deploy --config wrangler.toml
```

Cron: `[triggers] crons = ["*/5 * * * *"]` (every 5 min). The `scheduled()` handler runs, in order:
reclaim lapsed concurrent seats, reclaim over-capacity seats after a downgrade, prune
`usage_events` (90-day retention), prune `lease_issuance` (180-day retention), sweep expired
`portal_otp`, sweep revoked/expired `portal_sessions`, and **last** drain + deliver the webhook
outbox (`enqueueAndDeliverWebhooks`). The webhook dispatcher is the only place webhooks are sent;
it signs each delivery HMAC-SHA256 over `"<t>.<rawjsonbody>"` and sends header
`Licensecc-Signature: t=<epoch>,keyid=<id>,v1=<hex>` (receivers must enforce a 5-minute replay
window on `t`).

### 7.2 Admin

```console
npm ci
npm run build           # build:worker (tsc) + build:ui (vite) → ./dist
npm test
npx wrangler deploy --config wrangler.jsonc
```

(The admin Worker serves the React console from the `ASSETS` binding = `./dist`.)

### 7.3 Portal

```console
npm ci
npm run build           # build:worker + build:ui → ./dist
npm test
npx wrangler deploy --config wrangler.jsonc
```

### 7.4 D1 backup

```console
npm ci
npm test
npm run dry-run
npx wrangler deploy --config wrangler.jsonc
```

Cron: `triggers.crons = ["0 3 * * *"]` (daily 03:00 UTC). The cron starts the `D1BackupWorkflow`,
which exports D1 to R2 under `BACKUP_PREFIX` and prunes objects older than `BACKUP_RETENTION_DAYS`.

---

## 8. PRODUCTION CUTOVER — flip the modes (read this twice)

**This is the single most common foot-gun.** Several security gates default to **off / observe**
so that a fresh deployment is permissive and back-compatible. Until you flip them, the deployment
is *not enforcing isolation or proof* even though it looks healthy. Set every one of these to its
production value.

The backend `wrangler.example.toml` already ships several of these at the production value
(`REQUEST_SIGNATURE_MODE=required`, `ORDER_INGEST_MODE=required`, `ACCOUNT_TOKEN_MODE=required`) —
but the **runtime defaults in code are the conservative ones**, so if a var is missing from your
config the code default applies. Verify each var is present with the right value.

| Mode (where set) | Code default if unset | **Production value** | What flipping it enforces |
|---|---|---|---|
| `ACCOUNT_TOKEN_MODE` (backend `[vars]`) | **`off`** (FAIL-OPEN: no per-customer isolation, legacy bearer path, shadow-eval logging) | **`required`** | This is what makes per-customer isolation bind: the 6 scoped paths require a valid account token and only match the caller's `customer_id`; NULL-owner and cross-customer rows are denied. Without it the deployment is permissive. Stage `off → soft → required`. |
| `REQUEST_SIGNATURE_MODE` (backend `[vars]`) | **`off`** (no device-proof check) | **`required`** | `/v1/verify` denies any request whose ECDSA device proof is missing/stale/invalid/replayed. `soft` logs but allows. |
| `DEVICE_PROOF_MODE` (backend `[vars]`) | **`off`** | **`required`** (when you want the hardware lock to bind) | Lease/seat issuance (`/v1/activate`, `/v1/renew`, `/v1/checkout`) denies when no device proof is presented — a cloned `hw_id` alone cannot get a lease/seat. (Example ships `off`; set `required` to bind hardware.) |
| `ORDER_INGEST_MODE` (backend `[vars]`) | **`required`** (already the secure default) | **`required`** | `POST /v1/orders` must pass HMAC signature + nonce; mutates entitlements. `soft` = verify+observe (never mutates); `off` = 404 (dev only). Keep `required`. |
| `POLICY_STAMP_MODE` (admin `[vars]`) | **`off`** | **`on`** (if you use policy templates) | Gates whether `POST /api/admin/entitlements` honors a `policy_id` and stamps from the policy template. Policy CRUD is always allowed; only honoring a `policy_id` is gated. With `off`, a create carrying `policy_id` is rejected `400 policy_stamping_disabled`. |
| Portal `/health` gate via `ACCOUNT_TOKEN_MODE` (portal `[vars]`) | not `required` ⇒ `/health` returns **503 `account_token_mode_not_required`** | **`required`** | The portal proxies per-action account tokens to the backend, so it refuses to report healthy unless the backend enforces isolation. Set the portal's `ACCOUNT_TOKEN_MODE=required` **and** ensure the backend is actually in `required` (the portal only asserts it; the backend enforces it). |

Supporting `[vars]` to set alongside the modes:

- Backend: `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID` (e.g. `"p1"`, must exist in `ACCOUNT_TOKEN_PEPPERS`);
  `ORDER_INGEST_AUDIENCE` (e.g. `"prod"`, non-empty in `required`); `WEBHOOK_SIGNING_KEY_ID` (must
  exist in `WEBHOOK_SIGNING_SECRETS`); `REQUEST_SIGNATURE_MAX_SKEW_SECONDS` (default 300);
  `ORDER_MAX_SKEW_SECONDS` (default 300, cap 3600); `MAX_ASSERTION_TTL_SECONDS` (default 300, cap
  3600); `MAX_CACHE_TTL_SECONDS` (default 86400, cap 604800).
- Backend rate limiting: `D1_RATE_LIMIT_ENABLED` (`"0"` default — set `"1"` to enable the D1
  fallback client + entitlement tiers); leave `D1_GLOBAL_RATE_LIMIT_ENABLED` off unless you observe
  cross-IP rotating-fingerprint abuse; keep the optional `VERIFY_RATE_LIMITER` binding.

**Staged cutover for `ACCOUNT_TOKEN_MODE`** (the riskiest flip): `off → soft` (flip when
`account.shadow_nomatch` for active callers is 0) → `required` (flip when zero active NULL-owner
entitlements remain). Use `account-token.mjs link --list-orphans` to find NULL-owner entitlements
and `link`/`merge-customer` to assign them before flipping to `required`.

After editing `[vars]`, re-deploy the affected Worker (`npx wrangler deploy --config …`). Vars take
effect on the next deploy.

---

## 9. Cloudflare Access (admin) + portal origin / email / bootstrap

### 9.1 Admin — Cloudflare Access

Production admin auth is Cloudflare Access JWT verification (via `jose`), configured entirely in
admin `[vars]`:

- `ADMIN_ACCESS_ISSUER` — `<https://<team>.cloudflareaccess.com>`. **Required**; empty ⇒ `401
  admin_auth_not_configured`.
- `ADMIN_ACCESS_AUDIENCE` — `<ACCESS_APP_AUD_TAG>`. **Required** (same 401 if empty).
- `ADMIN_ACCESS_JWKS_URL` — optional. If unset, defaults to
  `<ADMIN_ACCESS_ISSUER>/cdn-cgi/access/certs`.
- `ADMIN_ACCESS_ADMIN_EMAILS` — comma-separated allowlist that can **mutate** entitlements.
- `ADMIN_ACCESS_READER_EMAILS` — comma-separated allowlist that can **read** only.

The Worker reads the `Cf-Access-Jwt-Assertion` header, verifies it against the issuer JWKS, and
maps the `email` claim to admin/reader. **If both email lists are empty, every authenticated user
is denied** (`403 admin_role_denied`) — fail-closed. Keep `ADMIN_DEV_BEARER_ENABLED="0"` and do not
set `ADMIN_DEV_BEARER` in production (the Worker hard-fails the dev bearer outside
`ENVIRONMENT=development`). Set the admin Worker's `ENVIRONMENT` to a non-`development` value
(the staging config uses `"staging"`).

Set up the Access application in the Cloudflare dashboard (Self-hosted application on the admin
Worker's hostname), then put its issuer/audience into the vars above.

### 9.2 Portal — origin, email seam, bootstrap

Portal `[vars]`:

- `ACCOUNT_TOKEN_MODE = "required"` — see §8 (also gates `/health`).
- `PORTAL_PUBLIC_ORIGIN = "<https://portal.example.com>"` — the portal's public origin. Used to
  build magic-link URLs (never the request `Host`) and for the CSRF same-origin check. **If empty,
  every cross-site-checked POST is rejected `403 cross_site_forbidden`** (fail-closed) — so set it.
- `BACKEND_ORIGIN = "<https://licensecc-online-verifier.<acct>.workers.dev>"` — the backend the
  portal proxies per-action tokens to (`/v1/activate`, `/v1/checkout`, `/v1/heartbeat`,
  `/v1/release`). Empty ⇒ `503 backend_unconfigured`.
- `PORTAL_EMAIL_FROM = "<noreply@example.com>"` and `PORTAL_EMAIL_API_BASE`
  (default `https://api.resend.com`) — with the `PORTAL_EMAIL_API_KEY` secret (§5.3). If
  unconfigured, login still returns `200 otp_requested` (no enumeration) but sends no email; the
  operator reads the code via the bootstrap path. It does **not** 503.
- `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID` — names which `ACCOUNT_TOKEN_PEPPERS` key mints new tokens;
  falls back to the first map key if unset/unknown.
- `PORTAL_BOOTSTRAP_REQUIRE_ACCESS = "1"` — optional; require a Cloudflare Access JWT header on the
  break-glass bootstrap route (header presence checked; rely on Access terminating in front).

The break-glass `PORTAL_BOOTSTRAP_BEARER` secret (§5.3) is the only path that returns an OTP secret
directly. Unset = the bootstrap route 404s. Leave it unset in steady state and set it only during
an incident (e.g. email outage).

---

## 10. C++ host integration

The Cloudflare backend is useless without a C++ host that calls it. The host side is built from
this same repo.

### 10.1 Initialize the per-project license keypair (lccgen, at CMake configure)

At configure time CMake invokes the vendored `lccgen` to generate the per-project RSA keypair and
headers:

```
license_generator::lccgen project initialize \
  -t "<repo>/src/templates" -n "<LCC_PROJECT_NAME>" -p "<LCC_PROJECTS_BASE_DIR>"
```

Key CMake options:
- `LCC_PROJECT_NAME` — the software name being licensed (defaults to `DEFAULT`; pick a real name —
  release builds reject reserved names like `DEFAULT`).
- `LCC_PROJECTS_BASE_DIR` — where generated files land (default `${CMAKE_BINARY_DIR}/projects`).
- `LCC_PROJECT_MAGIC_NUM` — anti-tamper magic baked in; the host must pass the same value via
  `CallerInformations.magic`.

Generated (never hand-edit; git-ignored):
`projects/<NAME>/include/licensecc/<NAME>/public_key.h` (embeds `PUBLIC_KEY`,
`LCC_PUBLIC_KEY_ID "sha256:<hex>"`) and `…/licensecc_properties.h` (API sizes, format range,
magic, hw-id strategy). This is the **offline license-issuing** key — separate from the online key.

### 10.2 Compile in the online-assertion (and config) public key ring

Pass the CMake value emitted by `generate-online-key.mjs` (§4.1) at configure time:

```
-DLCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS="license::os::SignaturePublicKey(\"sha256:<hex>\", std::vector<uint8_t>{...}, 3072)"
```

(and `-DLCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS=…` from `generate-config-key.mjs` if you use
config tokens). These are applied as compile definitions directly to the `online_verification` /
`config_attestation` library targets and `licensecc_static` — **not** routed through
`licensecc_properties.h`. Retired key-ids go in `LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS` /
`LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS`. The compiled key-id **must equal**
`ONLINE_SIGNING_KEY_ID` on the server (§4.1) or the verifier rejects every assertion.

### 10.3 Wire the online check + use the decision wrapper

Public API (in `include/licensecc/licensecc.h` and `datatypes.h`):

- Implement an `LCC_ONLINE_CHECK` callback:
  ```c
  typedef LCC_ONLINE_CALLBACK_STATUS (*LCC_ONLINE_CHECK)(void* user_data, const LccOnlineRequest* request,
                                                         char* assertion_out, size_t* assertion_out_size);
  ```
  It serializes the core-populated `LccOnlineRequest` (project, feature, license_fingerprint,
  device_hash, core-generated `nonce`, client_hardening, optional request-proof fields) as JSON,
  POSTs to `<BACKEND_ORIGIN>/v1/verify`, and copies the returned `"assertion"` (`lccoa1.` envelope)
  into `assertion_out` (max `LCC_API_ONLINE_ASSERTION_SIZE` = 4096). `entitlement_denied` → return
  `LCC_ONLINE_CB_HOST_DECLINED`.
- **Prefer the production decision wrapper** over `acquire_license_ex()`:
  ```c
  LCC_EVENT_TYPE lcc_acquire_license_decision(const CallerInformations*, const LicenseLocation*,
                                              LicenseInfo*, LccLicenseDecision*,
                                              const LccLicenseDecisionOptions*);
  ```
  Its options require `online_check` + a `revocation_floor_load`/`revocation_floor_store` pair so
  process restarts cannot silently accept older assertions. It allows only when the decision is
  `ALLOW` **and** `event_type == LICENSE_OK`; it fails closed on floor load/store failure.
  Raw `acquire_license_ex()` keeps only a process-local revocation floor.
- Config attestation entry: `lcc_verify_config(...)` consumes an `lcccfg1.` token + the exact
  config bytes via `LccConfigInput`, returning `LICENSE_OK` only when the local license is valid
  and the token verifies (signature/binding/config-hash/window/rollback floor).

Reference implementations to copy:
- `examples/production_decision_host/main.cpp` + `CMakeLists.txt` + `README.md` — the
  production-shaped client: online check POSTing to `/v1/verify` (cURL or WinHTTP), fail-closed
  `lcc_acquire_license_decision`, host-integrity check, and revocation-floor persistence to a file
  (atomic temp-file rename, stores `max(existing, new)`), plus optional ECDSA-P256 request proof.
- `examples/online_callback/online_callback_common.hpp` — the shared `OnlineClient` / JSON
  build+parse / request-proof canonical payload.
- `example/` (singular) — the local-only `find_package(licensecc)` consumer (no online check);
  useful as the minimal integration reference, not the backend consumer.

---

## 11. Post-deploy verification (run the drills) + enable backups

Run these against your **staging/test** infra first; the destructive ones create scratch Workers/DBs.

### 11.1 Liveness / health

```console
curl https://licensecc-online-verifier.<acct>.workers.dev/health        # backend: {"ok":true,"service":"licensecc-online-verifier"}
curl https://<portal-host>/health                                       # portal: 200 healthy ONLY if ACCOUNT_TOKEN_MODE=required, else 503
curl https://licensecc-d1-backup.<acct>.workers.dev/health              # backup Worker health
```

The portal `/health` returning 503 `account_token_mode_not_required` is your tripwire that §8 was
not completed.

### 11.2 Public verifier abuse-control drill (backend)

```console
npm run validate:public-verifier --url=https://licensecc-online-verifier.<acct>.workers.dev --expect-rate-limit --json
```

Sends a malformed request, an unknown-entitlement request, and a bounded burst; expects unsigned
denial for unknowns and a `429 rate_limited`. (Use the `--flag=value` form through `npm run`.)

### 11.3 End-to-end C++ assertion validation (backend)

```console
npm run validate:remote-cpp -- wrangler.toml ../../build Debug
```

Deploys a temporary verifier Worker with generated key material, creates a scratch entitlement,
obtains a real `lccoa1.` assertion, runs `test_online_verification` with the matching public key,
then revokes/cleans up.

### 11.4 Admin Access + D1 atomicity drills (admin)

```console
# Real Access JWT drill:
cloudflared access login --quiet --auto-close --app https://<admin-host>
LICENSECC_ACCESS_USE_CLOUDFLARED=1 node scripts/access-admin-drill.mjs --url https://<admin-host>

# Static config validation of the deployed Access wiring:
npm run validate:access-admin

# Remote D1 atomicity (no partial entitlement/audit row on failed batch):
npm run validate:remote-d1-atomicity -- ../cloudflare-licensing-backend/wrangler.toml
```

### 11.5 Backups: schedule + restore drill (d1-backup)

```console
# Validate the deployed backup Worker/Workflow, requiring the export token:
npm run validate:deploy -- \
  --url https://licensecc-d1-backup.<acct>.workers.dev \
  --worker-name licensecc-d1-backup --workflow-name licensecc-d1-backup \
  --require-d1-rest-token --json

# Optional manual backup (needs BACKUP_TRIGGER_TOKEN):
curl -X POST https://licensecc-d1-backup.<acct>.workers.dev/backup/run \
  -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>" -H "Content-Type: application/json" \
  --data '{"reason":"post-deploy backup"}'

# Restore drill (release evidence; refuses to run without --confirm-scratch):
node scripts/restore-drill.mjs \
  --bucket licensecc-d1-backups --object-key <backup-key> \
  --scratch-database licensecc-online-verifier-restore-drill \
  --source-database licensecc-online-verifier \
  --require-restored-status active --require-restored-status revoked \
  --confirm-scratch --remote
```

The daily `0 3 * * *` cron starts the export Workflow automatically once the Worker is deployed and
`D1_REST_API_TOKEN` is set. D1 Time Travel (`npm run time-travel -- info|restore …`) is the
short-window emergency path; R2 dumps are the long-retention path.

---

## 12. Mainline / merge note

- This back-office (the three app Workers + the customer-portal, and the `cloudflare-licensing-backend`
  rename) currently lives **only** on `feature/operations-back-office`, pushed to the **`lyehe`
  fork**. It is **not** on `develop`/mainline and **not** deployed anywhere yet.
- Merging to `develop` is a **separate human decision** (GitFlow: work on `develop`, `master` is
  for stable releases). This runbook does not perform or assume that merge.
- The `services/cloudflare-licensing-backend/supabase-postgres/` path is **SQL + a `postgres.js`
  adapter only** (a drop-in alternative data layer with schema/statement translation and tests).
  **D1 is the live runtime** for this deployment. Do not treat the Postgres port as a deploy target
  here.

---

## 13. Rollback / cutover-back

Every mode in §8 is reversible:

- **Soften isolation/proof:** set `ACCOUNT_TOKEN_MODE=soft` (or `off`), `REQUEST_SIGNATURE_MODE=soft`
  (or `off`), `DEVICE_PROOF_MODE=off`, `POLICY_STAMP_MODE=off` in the relevant `[vars]`, then
  re-deploy that Worker. `off`/`soft` revert to permissive/observe behavior. (Note: reverting the
  backend's `ACCOUNT_TOKEN_MODE` below `required` will make the portal `/health` flip to 503.)
- **Order ingest:** `ORDER_INGEST_MODE=soft` makes `/v1/orders` verify-and-observe (never mutate);
  `off` 404s it (dev only).
- **Disable a Worker** (take it offline): `npx wrangler delete --name <worker-name>` removes the
  deployment, or in the dashboard disable the route / `workers.dev` subdomain. To stop a cron
  without deleting the Worker, remove the `[triggers] crons` (backend) / `triggers.crons`
  (d1-backup) block and re-deploy.
- **Break-glass:** set `EMERGENCY_OPERATOR_BEARER` (backend) or `PORTAL_BOOTSTRAP_BEARER` (portal)
  only for the duration of an incident, then unset and re-deploy (unset = route 404 = closed).
- **Data rollback:** D1 Time Travel `restore --confirm` for recent mistakes; an R2 SQL dump
  restored into a staging DB first for older recovery. Production restore is a deliberate
  incident-response action, not a routine step.
- **Key rotation:** add a new key/pepper id to the relevant map before retiring the old (online
  key: add the new public record to `LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` and the old id to the
  retired list; account-token peppers: `account-token.mjs repepper --from <old> --to <new>`).

---

## Gaps / uncertainties found

1. **No `deploy` npm script in any service.** Only `dry-run` (and `migrate:*`) scripts exist. The
   runbook uses `npx wrangler deploy --config <file>` directly, consistent with the backend
   README's step 8 (`npx wrangler deploy`). Confirm the operator's intended deploy invocation.
2. **`wrangler.toml` vs `wrangler.example.*` mismatch in scripts.** The backend's `migrate:remote`
   targets `wrangler.toml` while its `dry-run` targets `wrangler.example.toml`; admin/portal
   `migrate:local`/`dry-run` target the `.example.` files. The committed admin/portal `wrangler.toml`
   are real **staging/test** configs (`*-test` names, a real staging `database_id`
   `3fdd9f7a-…`). The runbook instructs copying `*.example.*` → real config and pointing `--config`
   at it; the operator must decide whether to reuse the existing staging infra or stand up
   production-named Workers/DB.
3. **`LEASE_SIGNING_*` / `LEASE_ISSUE_BEARER` are not in `wrangler.example.toml`.** They appear only
   in the Worker `Env` interface and are documented here as optional (lease platform). There is no
   `generate-lease-key` script found — `lease-sign.mjs` consumes a PKCS#8 lease key via
   `--private-key`, but how that lease key is generated for production was not located (likely reuse
   `generate-online-key.mjs` output or an externally produced RSA PKCS#8 key). Confirm the intended
   lease-key provenance before enabling `/v1/activate`/`/v1/renew`.
4. **`MAX_CACHE_TTL_SECONDS` is in the `Env` interface but not in `wrangler.example.toml`.** Default
   86400s (cap 604800) applies if unset; documented in §8 as a tunable.
5. **`PORTAL_BOOTSTRAP_REQUIRE_ACCESS` checks header presence only**, relying on Cloudflare Access
   to terminate in front and cryptographically verify the JWT — the portal Worker does not itself
   verify it (unlike the admin Worker). If you enable bootstrap, ensure Access actually fronts the
   portal route.
6. **`namespace_id = "1001"` in `[[ratelimits]]`** is an example value; the README says it must be a
   positive-integer string. Confirm the value your account expects (and remove the block if your
   account cannot use the rate-limit binding).
7. **Two backend directories exist** (`cloudflare-licensing-backend` and the pre-rename
   `cloudflare-online-verifier`). Deploy from `cloudflare-licensing-backend/`. The old directory was
   not audited for whether it still contains a live config and could deploy by accident.
8. **`generate-config-key.mjs` invocation via npm.** There is no `generate-config-key` entry in the
   backend `package.json` scripts (only `generate-online-key` and
   `generate-online-assertion-fixture`). Run it directly: `node scripts/generate-config-key.mjs
   --out-dir .config-key`.
