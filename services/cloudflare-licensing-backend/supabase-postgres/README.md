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

The **order-ingest apply path** (`order-apply-pg.mjs`, the port of `src/fulfillment/order_ingest.mjs`)
introduces three more translations the entitlement port never exercised — pinned by
`order-apply-pg.test.mjs`:

- `json_object(k, v, ...)` -> `json_build_object(k, v, ...)::text`. PG16's `json_object` has
  different (array/format) argument semantics; `json_build_object` takes the positional `k,v,...`
  form, and the `::text` cast keeps the `next_json` **TEXT** column contract.
- `seat_checkouts.rowid` -> `ctid` (the seat-reclaim delete-by-physical-row). Safe **only** because
  the `SELECT ctid` and `DELETE … WHERE ctid IN (…)` run in the **same transaction** with no
  intervening `UPDATE` to `seat_checkouts` — exactly the window the SQLite `rowid` version relies on.
  Do not split the subquery out of the transaction.
- `max(0, x)` -> `GREATEST(0, x)` (the reclaim `LIMIT` count clamp; same family as the scalar-`max`
  rule above).
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

## Run the verify Worker on Postgres (server.mjs)

`server.mjs` runs the **unmodified** compiled Worker (`dist/index.js`) on Postgres — the
counterpart of `local-host/server.mjs` (SQLite). The Worker emits D1/SQLite SQL, so the host
wires the adapter with `{ workerSql: true }`, which translates the Worker's verify-path
statements to PostgreSQL at `prepare()` time:

- `?` placeholders → `$1..$n`;
- the bare `ON CONFLICT … DO UPDATE SET request_count = request_count + 1` → table-qualified
  (`rate_limit_counters.request_count + 1`). PostgreSQL rejects the bare self-reference as
  ambiguous (the existing row **and** `excluded` both expose the column); D1/SQLite accepts
  it, which is why the Worker uses it.

```bash
npm install postgres                                          # adapter runtime dep
npm run build                                                 # tsc -> dist/index.js
psql "$DATABASE_URL" -f supabase-postgres/schema.pg.sql       # apply the schema
node scripts/generate-online-key.mjs --out-dir .online-key    # signing key (.online-key is gitignored)

DATABASE_URL=postgresql://user:pass@host:5432/db \
  ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM="$(cat .online-key/online_private_key.pkcs8.pem)" \
  ONLINE_SIGNING_KEY_ID="sha256:local-dev-key" \
  node supabase-postgres/server.mjs
# GET /health ; POST /v1/verify {project,feature,license_fingerprint,device_hash,nonce}
```

**Verified 2026-06-16 on PostgreSQL 16 (Docker):** the compiled Worker served a genuine signed
`lccoa1.` assertion for a seeded entitlement (`verify.ok`) and `entitlement_denied` (200, not
500) for a miss — full parity with the SQLite host. `smoke-worker-sql.mjs` re-runs the
data-layer proof (7/7) against any Postgres: `npm i postgres && node smoke-worker-sql.mjs`.

## Exposing the host safely

`/v1/verify` is a **signing oracle** — it mints signed `lccoa1.` assertions. Off Cloudflare you
lose the edge WAF, the per-client rate limiter, and a trustworthy client IP, so `server.mjs` closes
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

## Full admin CLI on Postgres

`scripts/entitlement.mjs` (the D1 admin CLI) is **not** modified by this port. Instead this
directory ships a **parallel** PostgreSQL CLI with the same command surface, flags, validation,
output, and exit codes -- but it runs against Postgres/Supabase via `postgres.js` (reusing
`createPool` / `closePool` from `db-postgres.mjs`) instead of shelling out to
`wrangler d1 execute`.

| File | Role |
|---|---|
| `pg-sql.mjs` | `pgSqlFor(command, args)` -> `{ text, params }` (or an **ordered array** of them for multi-statement mutations). A faithful, command-for-command mirror of `entitlement.mjs`'s `sqlFor()` -- it reuses the **exact** validators, field builders, and per-command branching, so the two CLIs accept/reject identical inputs with identical messages. Only the SQL dialect (`$n` placeholders, `EXTRACT(EPOCH FROM now())::bigint`, `GREATEST`, `encode(gen_random_bytes(8),'hex')`, `EXCLUDED`) and the value-passing (`$n` + params, not embedded literals) differ. |
| `entitlement-pg.mjs` | The runnable CLI. Parses the same flags, validates the same way, runs reads via one `pool.unsafe()` and mutations as an ordered list inside one `pool.begin()` transaction, and prints the same-shaped output. |
| `entitlement-pg.test.mjs` | A `node --test` suite mirroring `test/sql/entitlement-cli-sql.test.mjs`, but executing `pgSqlFor()`'s statements against **`pg-mem`** (in-memory Postgres). |
| `order-apply-pg.mjs` | The Slice-1 **order-ingest APPLY** port (mirror of `src/fulfillment/order_ingest.mjs`): per-event floor-guarded `{text, params}` builders (`pgCreateStatement`/`pgPatchStatement`/`pgTransitionStatement`/`pgCapacityStatement`/`pgOrderEventStatement`/`pgReclaimStatement`/`pgProcessedMark`/`pgAcceptBatch`) + `runApplyTransaction(pool, statements)` running the apply group in one `pool.begin()` transaction and returning the **primary RETURNING row** (applied vs superseded), not `result.count`. Preserves accept-then-apply, the apply-time monotonic floor, fingerprint ownership, and the in-txn processed-mark. **SQL + transaction runner only** — `POST /v1/orders` (HMAC/nonce/normalization) stays the unmodified Worker and is **not** wired into the PG server. |
| `order-apply-pg.test.mjs` | Hermetic, **zero-dep** (`npm run test:pg`): pure SQL-shape/translate assertions over the builders + a mock-pg-client transaction test of `runApplyTransaction` (statement order, empty-RETURNING => `applied:false` superseded, reclaim seat-id mapping, rollback on throw). |
| `order-apply-smoke-real-pg.mjs` | Real-PG16 smoke for the apply path, **gated on `DATABASE_URL`** (clean skip when unset). Exercises the constructs `pg-mem` cannot: the ON CONFLICT correlated floor, `FLOOR_PREDICATE_UPDATE` suppression, `json_build_object::text`, and the `ctid` + `GREATEST(0,..)` reclaim. *(No `pg-mem` layer is added for the apply path: the correlated floor needs the `pgMemRewrite` shim and `ctid`/reclaim is a `pg-mem` gap — the mock + this smoke are the authoritative checks, per the design.)* |

### Commands and flags

Identical to the D1 CLI minus the wrangler-only flags (`--database` / `--config` / `--remote` /
`--local` are dropped; `--remote`/`--local` are still **accepted but ignored** for muscle-memory
parity -- the Postgres CLI always targets the single `DATABASE_URL` connection):

```text
upsert        --fingerprint <64-hex> --actor <op> [--project DEFAULT] [--feature DEFAULT] [--device-hash <64-hex>]
              [--status active] [--assertion-ttl 300] [--valid-from <epoch>] [--valid-until <epoch>]
              [--customer-id <text>] [--license-id <text>] [--reason <text>] [--allow-revoked-override]
revoke        --fingerprint <64-hex> --actor <op> --reason <text> [--project] [--feature]
disable       --fingerprint <64-hex> --actor <op> --reason <text> [--project] [--feature]
reenable      --fingerprint <64-hex> --actor <op> [--reason <text>] [--project] [--feature]
get           --fingerprint <64-hex> [--project] [--feature]
list          [--project] [--feature]
device-upsert --fingerprint <64-hex> --device-key-id sha256:<64-hex> --public-key-spki-der-base64 <b64> --actor <op>
              [--status active] [--reason <text>] [--project] [--feature]
device-disable --fingerprint <64-hex> --device-key-id sha256:<64-hex> --actor <op> --reason <text> [--project] [--feature]
device-revoke  --fingerprint <64-hex> --device-key-id sha256:<64-hex> --actor <op> --reason <text> [--project] [--feature]
device-list    --fingerprint <64-hex> [--project] [--feature]
```

### Run it

```bash
npm install postgres                       # the adapter's only runtime dep
export DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres'
psql "$DATABASE_URL" -f schema.pg.sql       # one-time: apply the schema

# create / update an entitlement (writes the row + one audit event, atomically)
node entitlement-pg.mjs upsert --fingerprint <64-hex> --actor alice --customer-id cus_1

# break-glass: reactivate a revoked (terminal) entitlement -- requires --reason, logs a
# distinct 'revoked-override' audit event
node entitlement-pg.mjs upsert --fingerprint <64-hex> --actor alice --allow-revoked-override --reason TICKET-42

node entitlement-pg.mjs revoke  --fingerprint <64-hex> --actor alice --reason leaked
node entitlement-pg.mjs get     --fingerprint <64-hex>          # prints the row(s) as JSON
node entitlement-pg.mjs list    --project DEFAULT              # JSON array, newest first, capped 100

node entitlement-pg.mjs device-upsert  --fingerprint <64-hex> --device-key-id sha256:<64-hex> \
  --public-key-spki-der-base64 <b64> --actor alice --reason enroll
node entitlement-pg.mjs device-revoke  --fingerprint <64-hex> --device-key-id sha256:<64-hex> --actor alice --reason lost
node entitlement-pg.mjs device-list    --fingerprint <64-hex>
```

**Exit codes** (same contract as the D1 CLI):

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage / validation error (bad or missing command, bad flag, missing flag value, any failed validator -- identical messages to `entitlement.mjs`). Thrown **before** any connection is opened or the `postgres` driver is loaded. |
| `3` | a **guarded mutation changed 0 rows** (a terminal `revoked` row for `upsert`/`disable`/`reenable`, or an unknown device for `device-*`): no audit event was written. Prints the same `NO-OP: ...` line with recovery guidance. **Unlike** the D1 CLI, there is no "no-op detection unavailable" caveat -- Postgres always reports the affected-row count (`postgres.js` `result.count`), so the 0-row no-op is detected deterministically. |
| `1` | any other runtime failure (missing `DATABASE_URL`, DB/connection error) -- fail-closed. |

**Atomicity.** The D1 CLI routes mutations through `wrangler ... --file` so the joined
statements (entitlement/device write + parent `revocation_seq` bump + audit event) commit
atomically. The adapter exposes no `.batch()`, so `entitlement-pg.mjs` wraps each mutation's
ordered statement list in one `pool.begin()` transaction (`BEGIN`/`COMMIT`, `ROLLBACK` on error)
on a single connection -- the same all-or-nothing guarantee.

### The pg-mem test

```bash
npm install --no-save pg-mem          # in-memory Postgres, no server needed
node --test supabase-postgres/entitlement-pg.test.mjs
```

It loads `schema.pg.sql` into `pg-mem`, then for each command runs `pgSqlFor()`'s **unmodified**
statement text and asserts the row effects (revoked-terminal guard = zero changes + zero events,
`--allow-revoked-override` reactivates with a `revoked-override` event, monotonic
`revocation_seq`, guarded `disable`/`reenable`, device bump + `update` event only when the device
exists, and the `get`/`list`/`device-list` projections include `notes` / `last_seen_at`).

**`pg-mem` emulation gaps (the test documents each at the top of the file and handles them
faithfully -- the `pg-sql.mjs` output is never changed, only what is handed to `pg-mem`):**

1. **pgcrypto** (`gen_random_bytes` / `encode`) is not built in -> the test registers a pgcrypto
   extension shim so the real ported `request_id` expression `'cli-' ||
   encode(gen_random_bytes(8),'hex')` runs unmodified (it verifies the result matches
   `^cli-[0-9a-f]{16}$`).
2. **`BIGINT GENERATED ALWAYS AS IDENTITY`** (the `entitlement_events.id` column) is not parsed by
   some `pg-mem` builds -> the loader retries once, rewriting **only that one column** to
   `BIGSERIAL` (behavior-equivalent auto-increment). No other column/constraint is touched.
3. **Correlated subquery inside `ON CONFLICT DO UPDATE` / `UPDATE`** -- the `revocation_seq` floor
   `GREATEST(<tbl>.revocation_seq, COALESCE((SELECT MAX(...) FROM entitlement_events WHERE project
   = entitlements.project ...), <tbl>.revocation_seq)) + 1` -- references the row being written.
   `pg-mem` **cannot resolve a subquery correlated to the target row** of an `ON CONFLICT` or a
   plain `UPDATE` (it raises `column "entitlements.project" does not exist`). This is a `pg-mem`
   engine gap, **not** a defect in the ported SQL, which is valid Postgres and is exactly what a
   real Supabase/Postgres runs. The test applies one surgical, behavior-preserving transform
   (`pgMemRewrite`) that collapses the floor to `<tbl>.revocation_seq + 1` -- exactly equivalent
   for this hermetic suite, because every audit event is written **from the current entitlement
   row**, so the event-history floor never exceeds the row's own `revocation_seq`. The monotonic
   `+1` increment the tests assert is preserved.
4. **`rowCount` of a guard-suppressed `ON CONFLICT DO UPDATE`** -- when the `DO UPDATE ... WHERE`
   guard suppresses the update (a terminal revoked row), real Postgres reports `rowCount 0` (the
   CLI's exit-3 signal); `pg-mem` leaves the row **correctly unchanged** but reports `rowCount 1`.
   So for the guard-suppressed *upsert* path the test asserts the **observable** no-op (row
   unchanged + zero audit events), exactly like the SQLite ground-truth test, rather than
   `pg-mem`'s `rowCount`. Plain guarded `UPDATE`s (`reenable`'s terminal guard, `device-*` against
   an unknown device) **do** report `rowCount 0` correctly under `pg-mem`, so those keep the
   `rowCount === 0` assertion.

### Real-Postgres / Supabase caveats (not exercised by the hermetic `pg-mem` suite)

- The correlated `revocation_seq` floor subquery (gap #3) runs **as written** against real
  Postgres -- run the unmodified `pg-sql.mjs` SQL there. The floor only ever *raises* the seq when
  the `entitlement_events` history outruns the row's own `revocation_seq` (which the live
  verify-path's revocation handling can produce); the `pg-mem` shim does not need that branch.
  **VERIFIED 2026-06-16 on PostgreSQL 16 (Docker):** `smoke-real-pg.mjs` drove the unmodified
  `pgSqlFor()` output (no rewrite) through node-postgres against a live PG16 — the full lifecycle
  passed **9/9**, including the un-rewritten `ON CONFLICT` correlated floor (`revocation_seq`
  1→2→…→6 monotonic), the conditional `WHERE entitlements.status != 'revoked'` guard (reenable on
  a revoked row = `rowCount 0`, zero audit events), and `pgcrypto`'s `gen_random_bytes`. The
  correlated `entitlements.<col>` reference resolves natively — no rewrite needed off `pg-mem`.
  Re-run it against your own instance: `npm i pg && DATABASE_URL=… node smoke-real-pg.mjs`
  (after `schema.pg.sql` is applied).
- The CLI uses **`postgres.js`** (a wire-protocol client), which `pg-mem` cannot serve. The
  `pg-mem` suite therefore exercises the SQL and the row effects, not a live `entitlement-pg.mjs`
  socket connection. To smoke-test the live CLI, point `DATABASE_URL` at a real Postgres/Supabase
  (the transaction pooler on `:6543` with `prepare: false`, per the adapter notes above).
- Validation and usage errors do **not** require `postgres` to be installed: `entitlement-pg.mjs`
  imports the adapter **lazily** (only once a validated command needs a connection), so a bad
  command exits `2` even before `npm install postgres`.
