# Cloudflare D1 Backup

Scheduled D1 export infrastructure for the hosted license verifier database.
This service is intentionally separate from the public verifier and admin UI:
it owns backup automation only, uses a least-privilege D1 REST API token, and
stores SQL dumps plus metadata manifests in R2.

## Local validation

```sh
npm ci
npm run lint
npm test
npm run build
npm run dry-run
```

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
- Restore drill wrapper that imports a backup into scratch D1 and validates
  required table counts plus verifier-facing entitlement state semantics.
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
an explicit scratch confirmation:

```sh
node scripts/restore-drill.mjs \
  --bucket licensecc-d1-backups \
  --object-key <backup-key> \
  --scratch-database licensecc-online-verifier-restore-drill \
  --source-database licensecc-online-verifier \
  --require-restored-status active \
  --require-restored-status revoked \
  --confirm-scratch \
  --remote
```

The drill reports required table counts, entitlement status counts, restored
active rows that are currently eligible for verifier acceptance, and
revoked/disabled rows that should deny. The `--require-restored-status` flags
turn those semantic checks into release blockers. Validate schema parity, row
counts, and verifier behavior before any production restore. Production restore
should be a deliberate incident-response action, not a routine deploy step.
