# Database backends

This page is the maintained status and promotion boundary for storage behind
the licensing backend. Run all commands from the repository root after the
single root `npm ci` required by the workspace contract.

The backend uses a deliberately small D1-shaped interface internally:

- `prepare(sql)`;
- `statement.bind(...values)`;
- `statement.first()`, `statement.all()`, and `statement.run()`;
- optional `batch(statements)`; and
- optional `withSession(mode)`.

## Support status

| Backend | Status | Scope | Focused validation |
| --- | --- | --- | --- |
| Cloudflare D1 | Production default | Deployed Workers | SQL/API tests, Wrangler dry-runs, staging, backup, and recovery drills |
| Local SQLite | Supported local evaluation | Local Node host and D1-shaped adapter consumers | `test:db` and `test:sql` in the backend workspace |

The status values above describe implemented repository surfaces. Production
promotion still requires the external evidence in {doc}`production-readiness`.

## Local SQLite

The SQLite adapter at
`services/cloudflare-licensing-backend/local-host/db-sqlite.mjs` uses Node's
experimental `node:sqlite` module and applies the backend-owned D1 migrations.
It is the preferred first online evaluation path because it needs no
Cloudflare account and makes no remote changes.

From the repository root in PowerShell or a POSIX shell:

```console
npm run db:local:init --workspace @licensecc/cloudflare-licensing-backend
npm run local:server --workspace @licensecc/cloudflare-licensing-backend
```

Set `DB_PATH` before those commands to select the SQLite file; otherwise the
host uses its documented default. Resetting the database deletes local test
data, so use the reset command only for a disposable evaluation database:

```console
npm run db:local:reset --workspace @licensecc/cloudflare-licensing-backend
```

Focused verification from the repository root is:

```console
npm run test:db --workspace @licensecc/cloudflare-licensing-backend
npm run test:sql --workspace @licensecc/cloudflare-licensing-backend
```

See the backend's
[local-host README](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-licensing-backend/local-host/README.md)
for environment variables, entitlement seeding, and expected HTTP responses.
