# Database Backends

The licensing backend uses a small D1-shaped database contract internally:

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
| Cloudflare D1 | Production default | Deployed Workers | SQL, API, Wrangler dry-runs, and staging drills |
| Local SQLite | Supported local/dev backend | Local Node host, scripts, tests, and D1-shaped adapter consumers | `npm --prefix services/cloudflare-licensing-backend run test:db` and `npm --prefix services/cloudflare-licensing-backend run test:sql` |
| PostgreSQL/Supabase | Fenced partial adapter | `GET /health`, `POST /v1/verify`, and selected order-apply adapter tests | `npm --prefix services/cloudflare-licensing-backend run test:pg` |

## Local SQLite

The local SQLite adapter lives at:

```text
services/cloudflare-licensing-backend/local-host/db-sqlite.mjs
```

It uses Node's experimental `node:sqlite` module and applies the same migration files as the D1-backed Worker.

Common commands:

```console
npm --prefix services/cloudflare-licensing-backend run db:local:init
npm --prefix services/cloudflare-licensing-backend run db:local:reset
npm --prefix services/cloudflare-licensing-backend run local:server
npm --prefix services/cloudflare-licensing-backend run test:db
npm --prefix services/cloudflare-licensing-backend run test:sql
```

Set `DB_PATH` to choose the SQLite file; it defaults to `app.db`.

## PostgreSQL/Supabase

The PostgreSQL/Supabase adapter is intentionally fenced. It is not a full runtime target until it passes the full backend promotion gate.

Current validation:

```console
npm --prefix services/cloudflare-licensing-backend run test:pg
```

## Promotion Rule

A backend is not a full runtime target until it passes:

- DB conformance tests for the D1-shaped contract.
- Real migration application.
- SQL/API tests for shared mutators.
- Worker-boundary E2E tests.
- Staging or equivalent live smoke tests.

Until then, production documentation and deployment runbooks must call out the backend as partial or fenced.
