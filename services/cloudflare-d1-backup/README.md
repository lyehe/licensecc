# Cloudflare D1 Backup

Scheduled D1 export infrastructure for the hosted license verifier database.
This service is intentionally separate from the public verifier and admin UI:
it owns backup automation only, uses a least-privilege D1 REST API token, and
stores SQL dumps plus metadata manifests in R2.

## Local validation

Install dependencies once from the repository root; the root `package-lock.json`
is authoritative for every Worker workspace:

```sh
npx --yes npm@10.9.8 ci
npm run lint --workspace @licensecc/cloudflare-d1-backup
npm run test --workspace @licensecc/cloudflare-d1-backup
npm run build --workspace @licensecc/cloudflare-d1-backup
npm run dry-run --workspace @licensecc/cloudflare-d1-backup
```

After the root install, the same `npm run <script>` commands also work from
this service directory; do not create a package-local lockfile.

After deploying to staging, validate the deployed Worker and Workflow without
printing secret values:

```sh
npm run validate:deploy -- \
  --url https://licensecc-d1-backup.example.workers.dev \
  --worker-name licensecc-d1-backup \
  --workflow-name licensecc-d1-backup \
  --json
```

For production readiness, require the D1 export token:

```sh
npm run validate:deploy -- \
  --url https://licensecc-d1-backup.example.workers.dev \
  --worker-name licensecc-d1-backup \
  --workflow-name licensecc-d1-backup \
  --require-d1-rest-token \
  --json
```

## What it provides

- Daily Worker cron trigger that starts a Cloudflare Workflow export of the D1
  database to R2.
- Manual authenticated trigger: `POST /backup/run`.
- Authenticated status lookup: `GET /backup/status/:workflow_instance_id`.
- Retention pruning for old R2 backup objects under the configured prefix.
- Metadata manifest next to every SQL dump.
- Time Travel wrapper for emergency point-in-time lookup and restore.
- Restore drill wrapper that imports a content-verified backup into an empty
  scratch D1, verifies snapshot-pinned row counts, applies the checked-out
  backend migration suffix, and validates the current canonical schema and
  verifier-facing entitlement state semantics.
- Deploy validator that checks Worker health, unauthenticated manual-trigger
  fail-closed behavior, Worker secret-name presence, and Workflow registration.

Cloudflare D1 Time Travel remains the first emergency recovery tool for recent
mistakes. The R2 export path gives you longer retention and an offline SQL dump.

## Cloudflare setup

1. Create an R2 bucket:

   ```sh
   wrangler r2 bucket create licensecc-d1-backups
   ```

2. Copy `wrangler.example.jsonc` to `wrangler.jsonc` and set:

   - `ACCOUNT_ID`
   - `DATABASE_ID`
   - `DATABASE_NAME`
   - `BACKUP_PREFIX`
   - `BACKUP_RETENTION_DAYS`
   - `r2_buckets[0].bucket_name`

3. Create a Cloudflare API token with permission to export only the target D1
   database, then store it as a Worker secret:

   ```sh
   wrangler secret put D1_REST_API_TOKEN
   ```

4. Optional: enable manual trigger/status endpoints:

   ```sh
   wrangler secret put BACKUP_TRIGGER_TOKEN
   ```

5. Deploy:

   ```sh
   npm run dry-run
   npx wrangler deploy --config wrangler.jsonc
   ```

The default config uses top-level Worker cron triggers (`triggers.crons`) to
start the Workflow. This keeps scheduling in the Worker deployment path while
the Workflow owns the long-running export. Do not add `schedules` directly to
the Workflow binding unless you have confirmed that your Cloudflare plan
supports direct Workflow schedules.

## Manual trigger

```sh
curl -X POST https://licensecc-d1-backup.example.workers.dev/backup/run \
  -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"reason":"pre-migration backup"}'
```

The response includes a Workflow instance ID. Check status with:

```sh
curl https://licensecc-d1-backup.example.workers.dev/backup/status/<instance-id> \
  -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>"
```

### Pre-migration backup gate

Deploy automation should use the repository-owned run-and-wait gate instead
of applying a migration immediately after starting a backup. Inject
`BACKUP_TRIGGER_TOKEN` through the protected CI environment, then run:

```sh
npm run backup:pre-migration --workspace @licensecc/cloudflare-d1-backup -- \
  --url https://licensecc-d1-backup.example.workers.dev \
  --database-id <expected-d1-database-id> \
  --database-name licensecc-online-verifier
```

The command rejects redirects, bounds response bodies and total wait time,
and follows queued/running/waiting Workflow states with exponential backoff.
It succeeds only when the Workflow reports exact `complete` status and its
output contains the expected database identity, a bookmark, and a matching
SQL-object/manifest-object pair. It also rejects missing or malformed snapshot
and R2-upload timestamps, stale snapshot requests, and malformed SHA-256,
byte-size, ETag, R2-version, or snapshot-inventory bindings. Public JSON reports
the RPO age, a redacted integrity summary, and only the number of snapshot-counted
tables; it omits row counts, the digest, ETag, R2 version, trigger token, and
Worker URL. Tokens are accepted only through the environment; there is
intentionally no token command-line option.

## Restore runbook

For recent accidental writes or migrations, prefer D1 Time Travel first:

```sh
npm run time-travel -- info \
  --database licensecc-online-verifier \
  --timestamp "2026-06-05T14:30:00Z" \
  --config ../cloudflare-licensing-backend/wrangler.toml
```

The restore command is destructive and requires `--confirm`:

```sh
npm run time-travel -- restore \
  --database licensecc-online-verifier \
  --bookmark <bookmark> \
  --config ../cloudflare-licensing-backend/wrangler.toml \
  --confirm
```

For R2 SQL dumps, restore into a staging D1 database first:

```sh
wrangler r2 object get licensecc-d1-backups/<backup-key> --file restored.sql
wrangler d1 execute licensecc-online-verifier-staging --remote --file restored.sql
```

Use the restore drill wrapper for release evidence. It refuses to run without
an explicit scratch confirmation, and it rejects a scratch database containing
any pre-existing non-system table, even an unrelated empty table. There is no
nonempty-scratch override:

```sh
node scripts/restore-drill.mjs \
  --bucket licensecc-d1-backups \
  --object-key <backup-key> \
  --expected-database-id <expected-d1-database-id> \
  --expected-database-name licensecc-online-verifier \
  --max-backup-age-seconds 3600 \
  --scratch-database licensecc-online-verifier-restore-drill \
  --scratch-config ../cloudflare-licensing-backend/wrangler.toml \
  --source-database licensecc-online-verifier \
  --source-config ../cloudflare-licensing-backend/wrangler.toml \
  --require-restored-status active \
  --require-restored-status revoked \
  --confirm-scratch \
  --remote
```

For an R2 source, the drill first downloads `<backup-key>.metadata.json` and
fails before restoring unless the bounded manifest is valid UTF-8/JSON, names
the expected D1 database and SQL object, carries a nonempty bookmark, and binds
the SQL bytes to a SHA-256 digest and exact size. Backup upload hashes the dump
and derives names-and-counts-only durable-table inventory from the same
backpressured stream sent to R2. The bounded SQL scanner retains no exported
values and fails closed on an unsupported insert form. Restore hashes the
downloaded file in bounded 64 KiB chunks and rejects a size or digest mismatch
before invoking D1. The manifest also records the snapshot-pinned table counts,
R2's returned size, opaque ETag, version, and object-upload timestamp.

RPO is measured from `snapshot_requested_at`, captured immediately before the
D1 export request and durably stored with its bookmark. The later R2 object
time remains available as `created_at` but cannot make an old snapshot appear
fresh. Canonical timestamps more than five minutes in the future and
inconsistent timestamp order are rejected. The redacted summary records both
timestamps, `backup_age_seconds`, streamed content-integrity evidence, and the
scratch import's `elapsed_ms`.

This binding detects accidental or isolated dump corruption; it does not prove
authenticity. The adjacent manifest is not signed and shares the R2 write trust
boundary with the SQL object, so a principal able to replace both can replace
the digest too. ETag (and R2's default MD5 behavior) is not treated as an
authenticity mechanism. Restore evidence therefore reports
`authenticity_verified: false`. Older R2 manifests without the strong integrity
and snapshot-time fields fail closed; a local `--sql-file` drill remains
explicitly unverified.

Immediately after import, and before changing the scratch schema, the drill
requires the manifest's durable-table inventory to exactly match the counted
tables present in the historical snapshot and requires every pinned count to
match. This proves import fidelity against the exported snapshot rather than
against a live database that may have advanced. It then requires
`d1_migrations` to be present and to name an exact prefix of the checked-out
backend migrations, records the historical schema-object digest, and runs
`wrangler d1 migrations apply` against the scratch target when that prefix is
old. Missing, divergent, ahead-of-repository, or incomplete migration history
fails closed. A migration upgrade requires `--scratch-config` pointing at the
backend configuration.

After the migration suffix is applied, the drill compares the normalized
SQLite DDL signature for all 38 tables, 58 named indexes, and 18 triggers
against the canonical generated `cloudflare-licensing-backend/schema.sql`
signature. Evidence emits only SHA-256 signatures and object/count metadata,
not DDL or row values. High-churn/swept delivery, meter, nonce, session, and
preview/projection tables remain presence- and schema-checked rather than
snapshot-counted. When `--source-database` is supplied, its current counts are
reported explicitly as informational and never invalidate a valid historic
snapshot merely because the live source has received later writes.

The drill also reports entitlement status counts, restored active rows that
are currently eligible for verifier acceptance, and revoked/disabled rows that
should deny. The `--require-restored-status` flags turn those semantic checks
into release blockers. Wrangler failures expose only operation, exit status,
and error class; raw stdout/stderr is never copied into the error. Validate row
counts and verifier behavior before any production restore. Production restore
should be a deliberate incident-response action, not a routine deploy step.
