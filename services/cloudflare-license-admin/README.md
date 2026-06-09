# licensecc Cloudflare admin

Private control-plane Worker and Vite + React console for managing online
verification entitlements stored in the shared D1 database.

This service is intentionally separate from the public verifier Worker. The
admin Worker does not bind or use the online assertion signing secret; it only
reads and mutates D1 rows.

## Local validation

```sh
npm ci
npm run lint
npm test
npm run test:ui
npm run test:e2e
npm run build
npm run dry-run
npm run migrate:local
```

`npm run migrate:local` applies the shared verifier migrations from
`../cloudflare-online-verifier/migrations` because the admin service and public
verifier share the same D1 schema.

`npm run test:e2e` installs the Playwright Chromium runtime when needed, starts
a local Vite preview, and runs a browser workflow with mocked admin API
responses. It covers create, metadata/validity/TTL patch, disable, reenable,
revoke, audit timeline display, duplicate-submit guarding, and UI secret
exposure checks. It does not replace the real Cloudflare Access staging drill
below.

Remote D1 atomicity validation against a staging/test Cloudflare database:

```sh
npm run validate:remote-d1-atomicity -- ../cloudflare-online-verifier/wrangler.toml
```

The script deploys a temporary authenticated Worker bound to the configured D1
database, forces a failed entitlement/audit `DB.batch()`, verifies that no
partial entitlement or event row persisted, and deletes the temporary Worker.

Cloudflare Access staging validation with a real Access JWT:

```sh
cloudflared access login --quiet --auto-close --app https://licensecc-admin.example.workers.dev
LICENSECC_ACCESS_USE_CLOUDFLARED=1 node scripts/access-admin-drill.mjs \
  --url https://licensecc-admin.example.workers.dev
```

The wrapper reads `LICENSECC_ACCESS_JWT` when present, or uses the cached
`cloudflared` application token when `LICENSECC_ACCESS_USE_CLOUDFLARED=1`.
It passes the token as both the Access edge cookie and the origin assertion
header, without putting the token on the command line. The drill verifies
unauthenticated and malformed-JWT rejection, reads the admin summary with the
valid Access JWT, creates a scratch entitlement with an idempotency key, replays
the same mutation without advancing `revocation_seq`, revokes the scratch row
for cleanup, and confirms revoked-terminal reactivation denial. Optionally set
`LICENSECC_NON_ADMIN_ACCESS_JWT=<redacted>` to prove a valid non-admin Access
identity cannot mutate.

## Authentication

Production should be protected by Cloudflare Access. Configure:

- `ADMIN_ACCESS_ISSUER`
- `ADMIN_ACCESS_AUDIENCE`
- `ADMIN_ACCESS_ADMIN_EMAILS`
- `ADMIN_ACCESS_READER_EMAILS`

The Worker validates the Access JWT from `Cf-Access-Jwt-Assertion` using the
issuer JWKS endpoint. Users listed in `ADMIN_ACCESS_ADMIN_EMAILS` can mutate
entitlements. Users listed in `ADMIN_ACCESS_READER_EMAILS` can read only.
Use Access for every hosted environment, including staging.

For local development only, set:

- `ENVIRONMENT=development`
- `ADMIN_DEV_BEARER_ENABLED=1`
- `ADMIN_DEV_BEARER=<local value>`

The Worker refuses dev bearer auth unless `ENVIRONMENT=development`. The Vite
UI does not inject this header automatically; local API smoke tests can use a
manual `Authorization: Bearer <local value>` header or Cloudflare Access.

## API

Read endpoints:

- `GET /api/admin/summary`
- `GET /api/admin/settings`
- `GET /api/admin/entitlements`
- `GET /api/admin/entitlements/:id`
- `GET /api/admin/events`

Mutation endpoints:

- `POST /api/admin/entitlements`
- `PATCH /api/admin/entitlements/:id`
- `POST /api/admin/entitlements/:id/disable`
- `POST /api/admin/entitlements/:id/reenable`
- `POST /api/admin/entitlements/:id/revoke`

User database sync endpoint:

- `POST /api/sync/entitlements`

Mutations require admin role, validate request bodies, atomically increment
`revocation_seq` in D1, and write the entitlement row plus audit event in one
D1 `batch()` transaction. The `Idempotency-Key` header is supported for replay
of completed mutation responses. Mutation requests fail closed if the D1 binding
does not expose `batch()`.

For requests that change an entitlement, the entitlement row, audit event, and
idempotency replay record are written in the same D1 `batch()` transaction. A
no-op request may record replay metadata after the read because no entitlement
mutation occurred.

Revoked entitlements are terminal for this first admin version.

### Break-glass CLI

The shared D1 helper `../cloudflare-online-verifier/scripts/entitlement.mjs` is an
operator break-glass path that **bypasses Cloudflare Access**. It stamps
`actor_type='cli'`, `source='cli'`, requires `--actor`, and computes
`revocation_seq` server-side. Like the admin Worker it treats revoked as terminal:
`upsert`/`disable`/`reenable` will not change a revoked row, and a guarded no-op
writes no audit event (the helper exits non-zero on `--remote`). To deliberately
reactivate a revoked entitlement, run `upsert --allow-revoked-override --reason
<text>`, which records a distinct `revoked-override` audit event. Mutations run via
`wrangler d1 execute --file`, so the entitlement write and its audit event commit
atomically. Prefer the authenticated admin Worker or `/api/sync/entitlements` for
normal, audited writes.

Production deployments should also deploy `../cloudflare-d1-backup` so D1 Time
Travel and scheduled R2 SQL exports are available before admin mutations or
migrations are run against live data.

## User database sync

Use the sync endpoint when your user database, billing system, or CRM is the
source of truth. Configure `SYNC_API_TOKEN` as a Worker secret:

```sh
wrangler secret put SYNC_API_TOKEN
```

Then send a bearer-authenticated projection update:

```json
{
  "project": "DEFAULT",
  "feature": "DEFAULT",
  "license_fingerprint": "<64 hex fingerprint>",
  "status": "active",
  "assertion_ttl_seconds": 300,
  "customer_id": "cus_123",
  "license_id": "lic_123",
  "valid_until": 1767225600,
  "reason": "subscription active"
}
```

The endpoint uses the same validation, D1 batch write, audit event, idempotency,
and revoked-terminal rules as the admin console. Repeated identical projections
return the current row without advancing `revocation_seq`. Disabled and revoked
sync payloads require `reason`.

CLI smoke example:

```sh
LICENSECC_SYNC_TOKEN=<secret> npm run sync:entitlement -- \
  --url https://licensecc-admin.example.workers.dev \
  --fingerprint <64 hex fingerprint> \
  --customer-id cus_123 \
  --license-id lic_123 \
  --status active \
  --reason "subscription active"
```

## Deployment notes

Apply D1 migrations before deploying a Worker version that reads the new
columns. Use distinct D1 databases and Access applications for staging and
production. Keep the public verifier and admin Worker on separate routes.

Do not deploy the admin Worker with local bearer authentication enabled. A
staging deployment should be protected by Cloudflare Access and should validate
`Cf-Access-Jwt-Assertion` against the Access JWKS endpoint before trusting any
identity or role headers.
