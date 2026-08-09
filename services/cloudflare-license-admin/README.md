# licensecc Cloudflare admin

Private control-plane Worker and Vite + React console for managing online
verification entitlements stored in the shared D1 database.

This service is intentionally separate from the public verifier Worker. The
admin Worker does not bind or use the online assertion signing secret; it only
reads and mutates D1 rows.

## Local validation

Install dependencies once from the repository root; the root `package-lock.json`
is authoritative for every Worker workspace:

```sh
npx --yes npm@10.9.8 ci
npm run lint --workspace @licensecc/cloudflare-license-admin
npm run test --workspace @licensecc/cloudflare-license-admin
npm run test:ui --workspace @licensecc/cloudflare-license-admin
npm run test:e2e --workspace @licensecc/cloudflare-license-admin
npm run build --workspace @licensecc/cloudflare-license-admin
npm run dry-run --workspace @licensecc/cloudflare-license-admin
npm run migrate:local --workspace @licensecc/cloudflare-license-admin
```

After the root install, the same `npm run <script>` commands also work from
this service directory; do not create a package-local lockfile.

`npm run migrate:local` applies the shared verifier migrations from
`../cloudflare-licensing-backend/migrations` because the admin service and public
verifier share the same D1 schema.

Run `npm run setup:browsers` once from the repository root before browser
checks; that command installs both retained Playwright Chromium revisions for
the admin and portal workspaces. `npm run test:e2e` itself does not install
browsers. It starts a local Vite preview and runs a browser workflow with
mocked admin API responses. It covers create, metadata/validity/TTL patch,
disable, reenable, revoke, audit timeline display, duplicate-submit guarding,
and UI secret exposure checks. It does not replace the real Cloudflare Access
staging drill below.

Remote D1 atomicity validation against a staging/test Cloudflare database:

```sh
npm run validate:remote-d1-atomicity -- ../cloudflare-licensing-backend/wrangler.toml
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

This list is the complete route inventory and is kept in lockstep with the
canonical dispatcher table in `src/worker/routes.ts` (`API_ROUTES`). Paths use
OpenAPI `{param}` templating. `test/openapi-crosscheck.test.mjs` fails if the
dispatcher, the OpenAPI spec, and this inventory drift apart.

Summary, reporting, and audit:

- `GET /api/admin/summary`
- `GET /api/admin/report`
- `GET /api/admin/report/timeseries`
- `GET /api/admin/report/expiring`
- `GET /api/admin/audit/verify`

Customers:

- `GET /api/admin/customers`
- `GET /api/admin/customers/{id}`
- `POST /api/admin/customers/{id}/disable`
- `POST /api/admin/customers/{id}/reenable`

Licenses, orders, search, and settings:

- `GET /api/admin/licenses`
- `GET /api/admin/orders`
- `GET /api/admin/search`
- `GET /api/admin/settings`

Policies:

- `GET /api/admin/policies`
- `POST /api/admin/policies`
- `GET /api/admin/policies/{id}`
- `PATCH /api/admin/policies/{id}`
- `POST /api/admin/policies/{id}/disable`
- `POST /api/admin/policies/{id}/reenable`

Catalog features:

- `GET /api/admin/catalog/features`
- `POST /api/admin/catalog/features`
- `GET /api/admin/catalog/features/{id}`
- `PATCH /api/admin/catalog/features/{id}`
- `POST /api/admin/catalog/features/{id}/disable`
- `POST /api/admin/catalog/features/{id}/reenable`

Catalog plans and import/export:

- `GET /api/admin/catalog/plans`
- `POST /api/admin/catalog/plans`
- `POST /api/admin/catalog/import`
- `GET /api/admin/catalog/plans/{id}`
- `PATCH /api/admin/catalog/plans/{id}`
- `POST /api/admin/catalog/plans/{id}/disable`
- `POST /api/admin/catalog/plans/{id}/reenable`
- `GET /api/admin/catalog/plans/{id}/export`
- `GET /api/admin/catalog/plans/{id}/features`
- `POST /api/admin/catalog/plans/{id}/features`
- `POST /api/admin/catalog/plans/{id}/features/{featureKey}/disable`
- `POST /api/admin/catalog/plans/{id}/features/{featureKey}/reenable`

License-plan projection:

- `POST /api/admin/license-plans/preview`
- `POST /api/admin/license-plans/apply`

Webhooks:

- `GET /api/admin/webhooks`
- `POST /api/admin/webhooks`
- `GET /api/admin/webhooks/deliveries`
- `POST /api/admin/webhooks/deliveries/{id}/redrive`
- `GET /api/admin/webhooks/{id}`
- `PATCH /api/admin/webhooks/{id}`
- `POST /api/admin/webhooks/{id}/disable`
- `POST /api/admin/webhooks/{id}/reenable`

Entitlements:

- `GET /api/admin/entitlements`
- `POST /api/admin/entitlements`
- `POST /api/admin/entitlements/batch`
- `POST /api/admin/entitlements/{id}/release-seats`
- `GET /api/admin/entitlements/{id}`
- `PATCH /api/admin/entitlements/{id}`
- `POST /api/admin/entitlements/{id}/disable`
- `POST /api/admin/entitlements/{id}/reenable`
- `POST /api/admin/entitlements/{id}/revoke`
- `GET /api/admin/entitlements/{id}/devices`
- `GET /api/admin/entitlements/{id}/meter`
- `POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke`
- `POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/disable`
- `POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable`

Events:

- `GET /api/admin/events`

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

## License mode setup

`license_mode` is derived from entitlement capacity, not stored as a separate
operator switch:

- `node_locked`: `pool_size = 0`
- `floating`: `pool_size > 0`
- `trial`: `is_trial = 1`

Use policy stamping for normal setup. Enable `POLICY_STAMP_MODE=on`, create a
policy, then create an entitlement with that `policy_id`. The policy is frozen
onto the entitlement at stamp time; later policy edits affect new stamps only.

Node-locked policy example:

```json
{
  "project": "DEFAULT",
  "name": "Pro node locked",
  "type": "node_locked",
  "pool_size": 0,
  "max_active_devices": 1,
  "max_borrow_sec": 0,
  "assertion_ttl_seconds": 300
}
```

Floating policy example:

```json
{
  "project": "DEFAULT",
  "name": "Team floating 5 seats",
  "type": "floating",
  "pool_size": 5,
  "max_active_devices": 5,
  "max_borrow_sec": 0,
  "assertion_ttl_seconds": 300
}
```

Then stamp an entitlement from either policy:

```json
{
  "project": "DEFAULT",
  "feature": "PRO",
  "license_fingerprint": "<64 hex fingerprint>",
  "policy_id": "<policy id>",
  "customer_id": "cus_123",
  "license_id": "lic_123",
  "status": "active"
}
```

For catalog-driven tiers, create catalog features and plans, attach each plan
feature to a policy or set explicit capacity overrides on the plan feature, then
use `/api/admin/license-plans/preview` and `/api/admin/license-plans/apply`.
Runtime checks read the stamped entitlement rows, not plan or tier names.

Client behavior differs by mode:

- Node-locked clients use `/v1/activate` and `/v1/renew`; `max_active_devices`
  controls how many distinct devices can hold a lease in the rebind window.
- Floating clients use `/v1/checkout`, `/v1/heartbeat`, and `/v1/release`;
  `pool_size` is the live seat pool, and `max_borrow_sec > 0` enables bounded
  borrowed/offline seats.

The `/api/sync/entitlements` helper creates the base entitlement projection but
does not expose seat capacity fields. Use policies, catalog plan projection, or
the admin API paths that stamp capacity when setting up floating licenses.

### Break-glass CLI

The shared D1 helper `../cloudflare-licensing-backend/scripts/entitlement.mjs` is an
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
