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
npm run build
npm run dry-run
npm run migrate:local
```

`npm run migrate:local` applies the shared verifier migrations from
`../cloudflare-online-verifier/migrations` because the admin service and public
verifier share the same D1 schema.

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

Mutations require admin role, validate request bodies, atomically increment
`revocation_seq` in D1, and write the entitlement row plus audit event in one
D1 `batch()` transaction. The `Idempotency-Key` header is supported for replay
of completed mutation responses. Mutation requests fail closed if the D1 binding
does not expose `batch()`.

The idempotency record is written after the entitlement/audit batch commits. A
process failure between those two writes can make a retried create/update run
again and advance `revocation_seq`; this preserves monotonicity and auditability
but does not make browser retries a strict exactly-once transaction.

Revoked entitlements are terminal for this first admin version.

## Deployment notes

Apply D1 migrations before deploying a Worker version that reads the new
columns. Use distinct D1 databases and Access applications for staging and
production. Keep the public verifier and admin Worker on separate routes.

Do not deploy the admin Worker with local bearer authentication enabled. A
staging deployment should be protected by Cloudflare Access and should validate
`Cf-Access-Jwt-Assertion` against the Access JWKS endpoint before trusting any
identity or role headers.
