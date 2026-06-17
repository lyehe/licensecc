# Supabase / PostgreSQL port of the licensing backend data layer

This directory is a **drop-in replacement for the D1 (SQLite) data layer** of the licensing
Worker (`services/cloudflare-licensing-backend/src/index.ts`). It ports **only the SQL and
the DB adapter** -- the Worker's security/crypto code (signing, request-proof, claims,
rate-limit policy) is untouched and continues to call the exact same
`D1DatabaseLike` / `D1PreparedStatementLike` surface.

| File | What it is |
|---|---|
| `schema.pg.sql` | Full PostgreSQL schema, faithful 1:1 to the ground-truth `schema.sql` (all 7 tables + every index, CHECK enum, composite PK, and the composite `ON DELETE CASCADE` FK). |
| `statements.pg.sql` | The four verify-path Worker statements (group A) plus the admin/CLI statements that carry the SQLite-isms (group B), each annotated with the original SQL it replaces. |
| `db-postgres.mjs` | A `postgres.js`-backed adapter exposing the **same** `prepare/bind/first/all/run` surface, throwing on error, with one long-lived pool and a BIGINT(int8)->number type parser. |

## Why `postgres.js` and not `@supabase/supabase-js`

The rate-limit counter upsert is an **atomic read-modify-write** expressed as one statement:

```sql
INSERT INTO rate_limit_counters (...) VALUES (...)
ON CONFLICT (namespace, rate_key, window_start)
DO UPDATE SET request_count = request_count + 1, ...
RETURNING request_count;
```

The PostgREST query builder behind `@supabase/supabase-js` **cannot express
`request_count = request_count + 1`** (a column-relative increment) in an upsert -- its
`.upsert()` only sets literal/known values, so an increment would require read-then-write
(a race) or a separate RPC. It also cannot cleanly express `ON CONFLICT ... DO UPDATE
... WHERE <guard>` or the `RETURNING` we read back. `postgres.js` runs the exact SQL
verbatim, preserving the atomicity the rate limiter depends on. So: **raw SQL via
`postgres.js`.**

## What changed vs. D1 (and what didn't)

Port rules applied (see inline notes in the `.sql` files for exact locations):

- `INTEGER PRIMARY KEY AUTOINCREMENT` -> `BIGINT GENERATED ALWAYS AS IDENTITY` (`entitlement_events.id`).
- Epoch / counter `INTEGER` columns -> `BIGINT` (`created_at`, `updated_at`, `valid_from`,
  `valid_until`, `last_seen_at`, `window_start`, `expires_at`, `revocation_seq`,
  `request_count`, `assertion_ttl_seconds`, `cache_ttl_seconds`). 32-bit unix seconds
  overflow in 2038; counters/seq are 64-bit-intent.
- `?` placeholders -> `$1, $2, ...`.
- `unixepoch()` -> `EXTRACT(EPOCH FROM now())::bigint`.
- `lower(hex(randomblob(8)))` -> `encode(gen_random_bytes(8), 'hex')` (needs `pgcrypto`).
- **Two-arg scalar `max(a, b)` -> `GREATEST(a, b)` (SILENT-BREAKAGE risk).** In SQLite
  `max(x, y)` is the scalar greatest-of; in Postgres `max()` is an aggregate that takes one
  arg. Naively collapsing it breaks the `revocation_seq` monotonicity invariant silently.
  The inner `MAX(revocation_seq)` over `entitlement_events` stays `MAX` (genuine aggregate).
- `CHECK (col IN (...))` enums kept **verbatim** (incl. the values migrations 0006/0007 added).
- `TEXT NOT NULL DEFAULT ''` and `metadata_json TEXT DEFAULT '{}'` kept as `TEXT`
  (jsonb variants noted in comments; kept TEXT for byte-compatibility with existing tooling).
- Composite TEXT primary keys and the composite `FOREIGN KEY ... ON DELETE CASCADE`: verbatim.
- The `rate_limit_counters` composite PK is the **`ON CONFLICT` arbiter** -- do not drop it,
  or the upsert errors with "no unique or exclusion constraint matching the ON CONFLICT".

The adapter requires callers to pass **`$n` placeholders** (it does not rewrite `?`), which
is why the Worker's SQL strings are ported to `$n` in `statements.pg.sql`.

### BIGINT (int8) columns arrive as numbers, not strings

`postgres.js` returns `BIGINT`/`int8` columns as **JavaScript strings** by default (to avoid
silently truncating values past `Number.MAX_SAFE_INTEGER`). The verify path would *survive*
that by coincidence -- every BIGINT it reads is numerically coerced downstream
(`Number(request_count)`, `boundedTime()`'s `Number()`, the TTL `Math.min/Math.max`), and
`revocation_seq` is only string-interpolated into the signed canonical payload (so a string
`'0'` produces byte-identical signed text) -- but relying on that incidental coercion is
fragile. The adapter therefore installs an **int8 -> JS number type parser** in `createPool`
so BIGINT columns arrive as numbers, matching D1/`better-sqlite3` (which returns INTEGER
columns as numbers). The parser only narrows values that are exactly representable
(`Number.isSafeInteger`); anything larger keeps its string form rather than truncate, so it
is strictly safer than the default for this schema and never loses precision. All widened
columns here hold unix seconds or small counters/sequences, comfortably inside the safe range.

## Setup

### 1. Create the database

**Supabase:** create a project, then grab a connection string from
*Project Settings -> Database -> Connection string*:

- **Serverless / edge / Workers** (recommended): use the **transaction pooler** host on
  port **6543** (`...pooler.supabase.com:6543`). The adapter sets `prepare: false`, which is
  required for the transaction-mode pooler.
- **Long-running Node host:** the **direct** connection on port **5432** is fine.

Export it:

```bash
export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres'
```

### 2. Apply the schema

```bash
psql "$DATABASE_URL" -f schema.pg.sql
```

`schema.pg.sql` runs `CREATE EXTENSION IF NOT EXISTS pgcrypto;` first (preinstalled on
Supabase). Every statement is `IF NOT EXISTS`, so re-running is safe.

Verify:

```bash
psql "$DATABASE_URL" -c '\dt'
# expect: entitlements, entitlement_devices, customers, licenses,
#         entitlement_events, mutation_idempotency, rate_limit_counters
```

### 3. Install the adapter dependency

```bash
npm install postgres
```

### 4. Wire the adapter into the Worker / host

```js
import { createPostgresDatabase } from "./supabase-postgres/db-postgres.mjs";

// Create ONE pool at startup and reuse it for every request.
const DB = createPostgresDatabase(process.env.DATABASE_URL);

// env.DB is a D1DatabaseLike; the rest of Env is unchanged (signing secrets, the optional
// VERIFY_RATE_LIMITER binding, and the D1_*/MAX_*/REQUEST_SIGNATURE_* string vars).
const env = {
  DB,
  ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM: process.env.ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM,
  ONLINE_SIGNING_KEY_ID: process.env.ONLINE_SIGNING_KEY_ID,
  // ...optional D1_RATE_LIMIT_* etc...
};

// handleVerify(request, env) and the /v1/verify path now run against Postgres unchanged.
```

The handler signature is `fetch(request, env)` -- there is **no** `ctx`/`ExecutionContext`,
so no background/deferred work hook is needed; every DB call is `await`ed inline.

### 5. Run

For a Node host, import the handler and serve it as usual. To sanity-check connectivity:

```bash
node -e "import('./supabase-postgres/db-postgres.mjs').then(async (m) => {
  const db = m.createPostgresDatabase(process.env.DATABASE_URL);
  const row = await db.prepare('select 1 as ok').bind().first();
  console.log(row);            // { ok: 1 }
  await m.closePool();
})"
```

## Error contract (must hold for the Worker to behave correctly)

- A real query failure **rejects/throws an `Error`** -> the Worker maps it to `d1_error` /
  HTTP 500 `verification_error` (fail-closed).
- An empty result set resolves to **`null`** (`.first()`) / **`[]`** (`.all()`), **not** an
  error -> that is the legitimate "no entitlement" / "unknown device" denial path.

`postgres.js` already rejects on SQL/connection errors and returns an empty result for zero
rows, and the adapter never swallows errors, so this contract holds.

## Notes / caveats

- **Placeholder style is `$n`, not `?`.** The adapter is a thin pass-through; it does not
  rewrite `?`. The ground-truth statements are ported to `$n` in `statements.pg.sql`.
- **BIGINT columns are parsed to JS numbers.** The adapter installs an int8 type parser so
  the Worker reads numbers (like D1), not postgres.js's default strings; out-of-safe-range
  values keep their string form rather than truncate. See "BIGINT (int8) columns arrive as
  numbers" above.
- **`metadata_json` / `prev_json` / `next_json` / `response_json` stay `TEXT`.** jsonb is a
  drop-in option (noted in `schema.pg.sql`), but TEXT preserves byte-compatibility with the
  existing admin/CLI tooling that treats them as opaque JSON strings (and `prev_json`/
  `next_json` legitimately default to the empty string `''`, which is not valid jsonb).
- **Migrations:** this port ships a single consolidated `schema.pg.sql` equivalent to the
  final state of D1 migrations `0001..0008`. If you want incremental Postgres migrations,
  split it along the same boundaries (the per-table comments name the source migration).
