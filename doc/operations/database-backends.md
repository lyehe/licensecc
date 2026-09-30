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
| Local SQLite | Test and local schema adapter | Backend test suite and `db:local:init`/`db:local:reset` | `test:db` and `test:sql` in the backend workspace |

The status values above describe implemented repository surfaces. Production
promotion still requires the external evidence in {doc}`production-readiness`.

## Local SQLite

The SQLite adapter at
`services/cloudflare-licensing-backend/local-host/db-sqlite.mjs` uses Node's
experimental `node:sqlite` module and applies the backend-owned D1 migrations.
It backs the backend's own test suite and local schema initialization; it does
not run an HTTP host.

From the repository root in PowerShell or a POSIX shell:

```console
npm run db:local:init --workspace @licensecc/cloudflare-licensing-backend
```

Set `DB_PATH` before that command to select the SQLite file; otherwise the
adapter uses its documented default. Resetting the database deletes local test
data, so use the reset command only for a disposable database:

```console
npm run db:local:reset --workspace @licensecc/cloudflare-licensing-backend
```

Focused verification from the repository root is:

```console
npm run test:db --workspace @licensecc/cloudflare-licensing-backend
npm run test:sql --workspace @licensecc/cloudflare-licensing-backend
```
