# Database Backends

licensecc uses a small D1-shaped database contract internally:

- `prepare(sql)`
- `statement.bind(...values)`
- `statement.first()`
- `statement.all()`
- `statement.run()`
- optional `batch(statements)`
- optional `withSession(mode)`

## Supported Backends

| Backend | Status | Scope | Validation |
| --- | --- | --- | --- |
| Cloudflare D1 | Production default | Full deployed Workers | Existing SQL, E2E, Wrangler, and staging drills |
| Local SQLite | Supported local/dev backend | Node local host, scripts, tests, D1-shaped adapter consumers | `npm --prefix services/cloudflare-licensing-backend run test:db` |
| PostgreSQL/Supabase | Fenced partial adapter | `GET /health`, `POST /v1/verify` only | `npm --prefix services/cloudflare-licensing-backend run test:pg` |

## Local SQLite

The local SQLite adapter lives at `services/cloudflare-licensing-backend/local-host/db-sqlite.mjs`.
It uses Node's built-in `node:sqlite` module and applies the real D1 migrations.

Common commands:

```bash
npm --prefix services/cloudflare-licensing-backend run db:local:init
npm --prefix services/cloudflare-licensing-backend run db:local:reset
npm --prefix services/cloudflare-licensing-backend run local:server
npm --prefix services/cloudflare-licensing-backend run test:db
```

Set `DB_PATH` to choose the SQLite file; it defaults to `app.db`.

## Promotion Rule

A backend is not a full runtime target until it passes:

- DB conformance tests for the D1-shaped contract.
- Real migration application.
- SQL/API tests for shared mutators.
- Worker-boundary E2E tests.
- Staging or equivalent live smoke tests.

Until then, production documentation and deployment runbooks should call out the backend as partial or fenced.
