Cloudflare D1 backups
=====================

The hosted verifier stores online entitlements in Cloudflare D1. Treat that D1
database as production state: migrations and admin actions should have an
operator-visible recovery path.

Recovery layers
---------------

Use two layers:

* D1 Time Travel for recent point-in-time recovery.
* Scheduled D1 exports to R2 for longer retention and offline SQL dumps.

Time Travel is the fastest way to recover from an accidental mutation or failed
migration within Cloudflare's supported window. It restores the database in
place, so it should be used only during an incident with an explicit operator
decision.

The R2 export service lives in ``services/cloudflare-d1-backup``. Its default
configuration uses a top-level Worker cron trigger to start a Cloudflare
Workflow. The Workflow calls the D1 export REST API, waits until the SQL dump is
ready, stores the dump in R2, writes a JSON metadata manifest beside it, and
prunes objects older than ``BACKUP_RETENTION_DAYS``.

Deployment
----------

Copy ``services/cloudflare-d1-backup/wrangler.example.jsonc`` to
``wrangler.jsonc`` and set the account, database, backup prefix, retention, and
R2 bucket names. Store secrets with Wrangler:

.. code-block:: console

   wrangler secret put D1_REST_API_TOKEN
   wrangler secret put BACKUP_TRIGGER_TOKEN

``D1_REST_API_TOKEN`` should be scoped to exporting the target D1 database.
``BACKUP_TRIGGER_TOKEN`` is optional; without it the scheduled Worker cron can
still start the Workflow, but the HTTP manual trigger and status endpoints fail
closed. The Workflow itself still requires ``D1_REST_API_TOKEN`` to perform an
export.

Run local gates before deploy:

.. code-block:: console

   cd services/cloudflare-d1-backup
   npm ci
   npm run lint
   npm test
   npm run dry-run

After deploy, validate the live backup Worker, configured secret names, and
Workflow registration without printing secret values:

.. code-block:: console

   npm run validate:deploy -- \
     --url https://licensecc-d1-backup.example.workers.dev \
     --worker-name licensecc-d1-backup \
     --workflow-name licensecc-d1-backup \
     --json

For production readiness, require the D1 export token to be present:

.. code-block:: console

   npm run validate:deploy -- \
     --url https://licensecc-d1-backup.example.workers.dev \
     --worker-name licensecc-d1-backup \
     --workflow-name licensecc-d1-backup \
     --require-d1-rest-token \
     --json

The example config uses ``triggers.crons`` on the Worker, not direct Workflow
``schedules``. Keep that default unless your Cloudflare plan explicitly
supports direct Workflow schedules.

Manual backup
-------------

Trigger a manual backup before risky production changes:

.. code-block:: console

   curl -X POST https://licensecc-d1-backup.example.workers.dev/backup/run \
     -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>" \
     -H "Content-Type: application/json" \
     --data '{"reason":"pre-migration backup"}'

Keep the Workflow instance ID from the response. Query status with:

.. code-block:: console

   curl https://licensecc-d1-backup.example.workers.dev/backup/status/<instance-id> \
     -H "Authorization: Bearer <BACKUP_TRIGGER_TOKEN>"

Restore policy
--------------

Use Time Travel for short-window recovery:

.. code-block:: console

   npm run time-travel -- info \
     --database licensecc-online-verifier \
     --timestamp "2026-06-05T14:30:00Z" \
     --config ../cloudflare-online-verifier/wrangler.toml

The restore wrapper requires ``--confirm`` because D1 Time Travel restore is
destructive:

.. code-block:: console

   npm run time-travel -- restore \
     --database licensecc-online-verifier \
     --bookmark <bookmark> \
     --config ../cloudflare-online-verifier/wrangler.toml \
     --confirm

For R2 SQL dumps, restore to staging first, validate schema and verifier
behavior, and only then decide whether production should be restored.

Use the restore drill wrapper for repeatable release evidence:

.. code-block:: console

   node services/cloudflare-d1-backup/scripts/restore-drill.mjs \
     --bucket licensecc-d1-backups \
     --object-key <backup-key> \
     --scratch-database licensecc-online-verifier-restore-drill \
     --source-database licensecc-online-verifier \
     --require-restored-status active \
     --require-restored-status revoked \
     --confirm-scratch \
     --remote

The drill downloads the R2 SQL dump, restores it into the named scratch D1
database, verifies the required entitlement tables exist, and compares
``entitlements``, ``entitlement_events``, and ``mutation_idempotency`` row
counts when ``--source-database`` is provided. It also reports restored
entitlement status counts and verifier-facing candidates. The
``--require-restored-status`` flags make the drill fail closed unless the
restored scratch database contains at least one currently acceptable active
entitlement and at least one revoked entitlement that the verifier should deny.
