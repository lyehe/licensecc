Remaining gap closure checklist
###############################

This checklist turns the remaining online-verification, admin-console, backup,
and release-readiness gaps into explicit gates. It is intended to be used after
the core implementation exists, when the question is whether the system is
ready for staging, production, or customer integration.

Use this checklist as a release gate, not as an aspirational roadmap. A required
gate is complete only when its implementation checklist, verification commands,
validation evidence, and exit criteria are all satisfied.

Verification and validation mean different things in this document:

* Verification proves that the implementation behaves as expected under
  deterministic commands, unit tests, integration tests, static checks, or
  controlled local harnesses.
* Validation proves that the same behavior holds in a production-like
  Cloudflare staging environment, with real Workers, D1, Access, R2, secrets,
  routes, and operator workflows.

Unit tests can mark an implementation item verified, but they do not validate
Cloudflare Access, remote D1 semantics, R2 backup recovery, or deployed Worker
secret separation. Any skipped external validation keeps the gate at ``[~]``
even when the local release runner reports ``ok=true``.

Scope
=====

Required for production
-----------------------

* C++ local, anti-tamper, and online-verification behavior is deterministic and
  covered by tests.
* Cloudflare verifier and admin Workers pass local CI gates.
* Admin mutations are authenticated, audited, idempotent, and atomic in D1.
* Break-glass CLI paths cannot violate admin invariants silently.
* Staging Cloudflare Access, D1, Worker, and backup flows are exercised against
  real Cloudflare resources.
* Documentation accurately describes limits, cache behavior, rollback floors,
  backups, and residual risks.

Explicitly not required for v1
------------------------------

* Generic debugger, VM, module-injection, process-list, or self-hash checks in
  the core library.
* Built-in C++ HTTP transport.
* A multi-tenant SaaS admin system.
* A claim that local licensing is tamper-proof.
* Server challenge/response that makes offline local execution impossible.

Evidence format
===============

For every gate, capture:

* date and environment;
* commit hash or working-tree diff reference;
* exact command or Cloudflare action;
* exit code or HTTP status;
* relevant response body, redacted where needed;
* screenshots for UI flows;
* D1 database name and migration list for staging;
* Worker version or deployment id;
* reviewer name or tool for final reviews.

Do not use production customer rows for validation. Use a scratch or staging D1
database and a staging Cloudflare Access application.

The top-level release runner writes a machine-readable summary when invoked
with ``--json-out``. Interpret the summary strictly:

* ``ok=true`` means no command that was actually run failed.
  It also requires internally consistent result evidence: no duplicate result
  labels and no malformed result statuses.
* ``complete=true`` means no command failed and no requested external gate was
  skipped.
* ``production_ready=true`` means ``--require-external`` was used, every
  deterministic local gate passed, and the Access, R2 restore, and backup
  deployment staging drills all ran without being skipped.
* ``complete=false`` means the run is useful evidence, but it is not a
  production release sign-off.
* ``blocking_reasons`` lists command failures and, in strict mode, missing
  staging inputs or skipped staging drills that caused the process to exit
  nonzero.
  Duplicate result labels and malformed result statuses are always blocking,
  even outside strict external mode.
  In strict production mode, missing required local or external result labels
  are also blocking.
* ``--require-external`` runs a secret-redacted external input preflight before
  local gates, then makes skipped staging drills fail the process. Use it for
  production sign-off once the Access JWT and R2 restore variables are present.
* External gate IDs, drill labels, required variables, optional variables,
  secret flags, redacted command templates, and skipped-command strings are
  defined in the shared release-gate contract. The preflight, runner, and
  readiness assertion consume that contract instead of maintaining separate
  label or environment-variable lists.
* Deterministic local gates run with known release secrets and staging input
  identifiers stripped from their subprocess environments. The external Access
  and R2 drills receive only their drill-specific allowlisted environment
  variables.
* The repository hygiene gate checks tracked working-tree diffs, staged diffs,
  and untracked non-ignored text files, so new release files cannot bypass
  trailing-whitespace validation before they are committed.
* ``external_inputs_present`` records whether the credentials and resource
  names needed for staging drills were present. It must not contain secret
  values.

Release evidence acceptance rules
=================================

Use these rules when turning a plan, review, or staging run into a release
checklist. A checklist item is not accepted just because the implementation
exists; it must have verification evidence, validation evidence when the item
depends on Cloudflare behavior, and an explicit pass/fail decision.

Per-item acceptance checklist:

* [ ] The item has a stable evidence id using the gate prefix from the evidence
      matrix, for example ``G3-ACCESS-MUTATION-2026-06-05``.
* [ ] The implementation path is named: file, script, endpoint, Worker,
      C++ API, migration, or runbook.
* [ ] The verification command is recorded exactly as run.
* [ ] The verification result is captured with exit code, HTTP status, or CTest
      status.
* [ ] The validation action is recorded when the item depends on deployed
      Cloudflare behavior.
* [ ] The validation evidence names the staging Worker, D1 database, migration
      list, R2 object, Access application, or C++ build used.
* [ ] Secret-bearing values are redacted, and the evidence proves redaction by
      showing only variable names, key ids, hashes, prefixes, or presence flags.
* [ ] Any skipped item states why it was skipped and whether that skip blocks
      production.
* [ ] Any failure has an owner and a follow-up action.
* [ ] The final status is one of ``[ ]``, ``[~]``, ``[x]``, or ``[!]``.

Machine-readable summary checklist:

* [ ] ``ok``, ``complete``, ``production_ready``, ``quick``, ``full``,
      ``external``, and ``require_external`` are booleans.
* [ ] ``generated_at`` is an ISO timestamp.
* [ ] ``platform``, ``node_version``, and ``cwd`` are present as nonempty
      summary metadata.
* [ ] ``results`` is an array.
* [ ] Every result has a nonempty, trimmed, unique ``label``.
* [ ] Every result records the exact command or action in a nonempty, trimmed
      ``command`` field.
* [ ] Every required local result command matches the shared release-gate
      contract, not only the expected result label.
* [ ] External drill command evidence matches the redacted command templates
      and contains no extra literal staging resource arguments. Required
      placeholders include ``<redacted-admin-url>``,
      ``<redacted-r2-bucket>``, ``<redacted-r2-object-key>``, and
      ``<redacted-scratch-d1>``.
* [ ] Skipped external drill rows use only ``not run: <drill label>`` for the
      ``command`` field, without staging URLs, bucket names, object keys, or
      database names.
* [ ] Every result ``status`` is an integer exit code or the string
      ``"skipped"``.
* [ ] Every result records a nonnegative integer ``duration_ms``.
* [ ] Every skipped result records a nonempty, trimmed ``reason``.
* [ ] ``external_inputs_present`` contains only the expected boolean keys:
      ``access_admin``, ``access_non_admin_jwt``, ``r2_restore``, and
      ``backup_deploy``.
* [ ] ``external_inputs_present`` does not contain token, JWT, URL, Worker
      name, bucket, object-key, or database values.
* [ ] Deterministic local result commands did not receive Access JWTs,
      Cloudflare API tokens, D1 REST tokens, signing keys, sync tokens,
      dev/admin bearer tokens, admin URLs, R2 backup object keys, bucket names,
      scratch database names, source database names, or staging wrangler config
      paths in their subprocess environment.
* [ ] Repository hygiene evidence includes tracked diff checks and untracked
      non-ignored text-file trailing-whitespace checks.
* [ ] Access staging drill subprocesses did not receive Cloudflare API tokens,
      D1 REST tokens, signing keys, sync tokens, or dev/admin bearer tokens.
* [ ] R2 restore drill subprocesses did not receive Access JWTs, signing keys,
      sync tokens, dev/admin bearer tokens, or backup trigger tokens.
* [ ] Every production result has status ``0``.
* [ ] No production result row has status ``"skipped"``.
* [ ] ``blocking_reasons`` is an array.
* [ ] There are no ``invalid_result_label`` blockers.
* [ ] There are no ``duplicate_result_label`` blockers.
* [ ] There are no ``invalid_result_status`` blockers.
* [ ] There are no ``invalid_result_command``,
      ``invalid_result_duration``, or ``invalid_skipped_result_reason``
      blockers.
* [ ] There are no ``invalid_result_command_contract`` blockers.
* [ ] There are no ``missing_required_result`` blockers.
* [ ] ``summary.skipped`` matches the number of result rows with status
      ``"skipped"``.
* [ ] In production sign-off, ``blocking_reasons`` is empty.
* [ ] In production sign-off, ``skipped`` is ``0``.
* [ ] In production sign-off, ``ok``, ``complete``, and
      ``production_ready`` are all ``true``.

Checklist notation
==================

Use the checklist as an executable release worksheet:

* ``[ ]`` means not started or no evidence captured.
* ``[~]`` means implemented locally but missing one or more validation gates.
* ``[x]`` means complete, with reproducible evidence attached.
* ``[!]`` means blocked or failed and must not be promoted.

Every checked item must point to evidence. Use a short evidence id such as
``G3-AUTH-ACCESS-JWT-2026-06-05`` and attach the command output, HTTP
transcript, CI run, screenshot, or review report in the release packet.

Execution order
===============

Run the gates in this order. Do not advance to the next stage while a required
item in the current stage is ``[!]``.

1. Gate 0 repository hygiene. Stop immediately if tracked files contain
   secrets, private keys, real JWTs, bearer tokens, or unreviewed deployment
   files.
2. Gate 1 local deterministic validation. Stop if unit tests, CTest, lint,
   dry-runs, docs, schema parity, or secret scans fail.
3. Gate 2 admin data-integrity checks. Stop if any write can persist without
   its audit event or idempotency record, or if revoked terminal behavior is
   inconsistent.
4. Gate 3 staging deploy and Access. Stop if Access is not cryptographically
   enforced for admin mutations, or if secrets are bound to the wrong Worker.
5. Gate 4 online C++ end-to-end. Stop if the C++ verifier accepts an assertion
   signed by the wrong key family, accepts rollback, or masks ordinary local
   license failures.
6. Gate 5 admin UI workflow. Stop if UI actions bypass API invariants or rely
   on development bearer auth.
7. Gate 6 user database sync. Stop if sync uses a different mutation path than
   admin API, or can reactivate revoked rows.
8. Gate 7 backup and restore. Stop before production mutations if no R2 export
   plus scratch-D1 restore drill has passed.
9. Gate 8 abuse and observability. Stop if public verifier abuse can create
   unbounded signing or D1 cost for expected low-volume deployment.
10. Gate 9 documentation and claims. Stop if docs overclaim local tamper
    resistance or omit known rollback, cache, revocation-latency, and recovery
    limits.
11. Gate 10 final review. Stop unless Critical and High findings are resolved
    and all accepted residual risks are recorded.

Current production-blocker burn-down
====================================

Use this section as the short execution checklist for closing the remaining
gaps. The later gate sections contain the detailed rationale, but these items
are the production blockers that must move from ``[ ]`` or ``[~]`` to ``[x]``.

For each blocker:

* ``implemented`` means the code/config path exists.
* ``verified`` means deterministic local commands passed.
* ``validated`` means the flow passed against real staging Cloudflare
  resources.
* ``accepted`` means the evidence is attached to the release packet and a
  reviewer or owner has signed off.

Production-blocker status ledger
--------------------------------

Use this ledger as the front page of the release packet. Each row must keep its
four evidence columns separate; do not mark a blocker accepted just because its
implementation or local tests exist.

.. list-table::
   :header-rows: 1
   :widths: 10 17 23 27 23

   * - Blocker
     - Current status
     - Verification gate
     - Validation gate
     - Acceptance gate
   * - PB-0 strict release-gate preflight
     - ``[~]`` local strict-missing-input smoke passed; production credentialed
       strict run still required
     - ``external_gate_preflight.mjs``,
       ``validate_release_gates.mjs --full --require-external``, and
       ``assert_release_ready.mjs`` produce consistent evidence
     - Same strict run executes Access, R2 restore, and backup deployment
       drills instead of recording skipped rows
     - ``production_ready=true``, ``complete=true``, ``skipped=0``, empty
       ``blocking_reasons``, and evidence file attached
   * - PB-1 Cloudflare Access admin mutation drill
     - ``[~]`` local Access validator exists, admin Worker tests pass, and
       staging Access routing is configured; real user Access JWT mutation
       still required
     - Admin tests, lint, and
       ``validate-access-admin.mjs --help`` pass
     - Real allowlisted Access JWT mutates staging D1; malformed,
       unauthenticated, and non-admin identities are rejected
     - Mutation transcript, D1 entitlement row, audit event, and idempotency
       evidence attached
   * - PB-2 R2 backup export and scratch-D1 restore drill
     - ``[~]`` backup service and restore wrapper exist; a real R2 object was
       restored into scratch D1 with row-count parity plus restored active and
       revoked semantic checks; the backup Worker is deployed with cron and a
       Workflow binding, but a real backup-service export still needs
       ``D1_REST_API_TOKEN`` staging evidence
     - Backup tests, lint, dry-run, ``restore-drill.mjs --help``, and deploy
       validator checks pass
     - Real staging backup object restores into scratch D1, row counts match,
       restored revoked denial semantics pass, and restored active verifier
       acceptance passes
     - Backup object id, restore transcript, row-count comparison, verifier
       responses, and cleanup notes attached
   * - PB-3 admin UI and operator workflow validation
     - ``[~]`` UI build, local workflow tests, and local browser e2e cover
       create, patch payloads, lifecycle action rules, duplicate-submit
       guarding, audit timeline display, and API path construction; operator
       browser workflow still needs staging evidence
     - Admin UI build and available browser/e2e tests pass
     - Access-authenticated operator completes create, patch, disable,
       reenable, revoke, revoked-denial, and audit-timeline flows
     - Screenshots or traces prove UI matches API invariants and exposes no
       secrets
   * - PB-4 abuse, observability, and cost-control validation
     - ``[~]`` local verifier behavior exists; staging burst/log validation
       still required
     - Verifier tests and local verifier/admin e2e pass
     - Controlled staging burst hits the intended limiter, normal low-volume
       traffic recovers, denials remain unsigned by default, and logs stay
       redacted
     - Burst transcript, limiter response, recovery check, and log review are
       attached
   * - PB-5 final evidence packet and review
     - ``[ ]`` pending until PB-0 through PB-4 are closed or explicitly blocked
     - Docs link check, docs build, risky-claim scan, secret scan, and
       whitespace check pass
     - Final evidence packet includes Access, R2 restore, UI, deployment, D1,
       and review artifacts
     - Release decision is recorded as ``ship``, ``defer``, or ``blocked`` with
       owners for residual risk

Close-rule checklist:

* [ ] ``implemented`` is checked only when the named code, script, Worker,
      migration, or runbook exists in the release candidate.
* [ ] ``verified`` is checked only when the exact deterministic command has
      been run and captured with exit status.
* [ ] ``validated`` is checked only when the production-like Cloudflare staging
      action has been run against scratch or staging resources.
* [ ] ``accepted`` is checked only when the evidence is attached, redacted, and
      reviewed.
* [ ] A blocker with ``implemented`` and ``verified`` but no staging
      ``validated`` evidence remains ``[~]`` and cannot count as production
      sign-off.
* [ ] Any blocker with failing evidence is ``[!]`` until the failure is fixed
      and the verification or validation command is rerun.

PB-0: strict release-gate preflight
-----------------------------------

Purpose:
  Prove the release candidate cannot be mistaken for production-ready while
  external staging inputs are missing.

Prerequisites:

* [ ] Release candidate commit or diff reference selected.
* [ ] Staging Access admin URL known.
* [ ] Staging Access admin JWT available to the operator.
* [ ] R2 backup object and scratch D1 database selected for restore drill.
* [ ] C++ build tree exists and ``build/CTestTestfile.cmake`` is present.
* [ ] No real secret values will be copied into logs or committed files.

Verification checklist:

* [ ] Run the external input preflight:

  .. code-block:: console

     node scripts/external_gate_preflight.mjs --json

* [ ] Confirm the preflight output lists only variable names, presence flags,
      and secret metadata, not secret values.
* [ ] If any required variable is missing, record the missing variable names
      and stop production sign-off.
* [ ] Run the strict release gate only after the preflight is ready:

  .. code-block:: console

     node scripts/validate_release_gates.mjs --full --require-external --json-out build/release-gates/production-candidate.json

* [ ] Assert the evidence cannot pass unless external drills ran:

  .. code-block:: console

     node scripts/assert_release_ready.mjs build/release-gates/production-candidate.json

Validation checklist:

* [ ] ``production-candidate.json`` has ``ok=true``.
* [ ] ``production-candidate.json`` has ``complete=true``.
* [ ] ``production-candidate.json`` has ``production_ready=true``.
* [ ] ``production-candidate.json`` has ``require_external=true``.
* [ ] ``production-candidate.json`` has ``skipped=0``.
* [ ] ``production-candidate.json`` has an empty ``blocking_reasons`` array.
* [ ] ``external_inputs_present.access_admin=true``.
* [ ] ``external_inputs_present.r2_restore=true``.
* [ ] ``external_inputs_present.backup_deploy=true``.
* [ ] ``external_inputs_present.public_verifier_abuse=true``.
* [ ] Required deterministic local result labels are present with status ``0``,
      including ``admin UI build``, ``online verifier/admin local e2e``,
      ``focused C++ security/API tests``, and ``full CTest suite``.
* [ ] All external drill result labels are present with status ``0``:
      ``Cloudflare Access admin staging drill``,
      ``Cloudflare R2 backup restore staging drill``,
      ``Cloudflare backup deployment staging drill``, and
      ``Cloudflare public verifier abuse staging drill``.

Exit criteria:

* [ ] The strict runner exits ``0`` only when every local and external gate
      passed.
* [ ] The readiness assertion exits ``0`` against the same evidence file.
* [ ] The evidence file is attached to the release packet.

PB-1: Cloudflare Access admin mutation drill
--------------------------------------------

Purpose:
  Validate that a real Cloudflare Access JWT can perform an allowed admin
  mutation and that unauthorized identities cannot mutate entitlements.

Prerequisites:

* [ ] Admin Worker deployed to staging behind Cloudflare Access.
* [ ] ``ACCESS_ISSUER``, ``ACCESS_AUDIENCE``, JWKS URL, and admin allowlist
      configured for the admin Worker.
* [ ] Development bearer auth absent or refused outside local development.
* [ ] Admin Worker has no online signing private key secret.
* [ ] Staging D1 migrations applied.
* [ ] Operator has ``LICENSECC_ADMIN_URL`` and either a valid
      ``LICENSECC_ACCESS_JWT`` for an allowlisted admin or a cached
      ``cloudflared`` Access application token with
      ``LICENSECC_ACCESS_USE_CLOUDFLARED=1``.
* [ ] Optional: operator has ``LICENSECC_NON_ADMIN_ACCESS_JWT`` for a valid
      Access identity that is not allowlisted.

Verification checklist:

* [ ] Run admin local tests:

  .. code-block:: console

     npm --prefix services/cloudflare-license-admin test

* [ ] Run admin lint:

  .. code-block:: console

     npm --prefix services/cloudflare-license-admin run lint

* [ ] Confirm the Access validation script contract:

  .. code-block:: console

     node services/cloudflare-license-admin/scripts/validate-access-admin.mjs --help
     node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --help

  The drill wrapper reads ``LICENSECC_ACCESS_JWT`` when present or a cached
  ``cloudflared`` token when ``LICENSECC_ACCESS_USE_CLOUDFLARED=1``. It sends
  the application token as both ``CF_Authorization`` cookie and
  ``Cf-Access-Jwt-Assertion`` header so it can validate a fully Access-protected
  route and a direct Worker JWT-validation setup without putting the token on
  the command line.

* [ ] Confirm external preflight reports Access inputs present:

  .. code-block:: console

     node scripts/external_gate_preflight.mjs --json

Validation checklist:

* [ ] Run the real Access mutation drill:

  .. code-block:: console

     cloudflared access login --quiet --auto-close --app https://licensecc-admin.example.workers.dev
     LICENSECC_ACCESS_USE_CLOUDFLARED=1 node services/cloudflare-license-admin/scripts/access-admin-drill.mjs \
       --url https://licensecc-admin.example.workers.dev

* [ ] If a non-admin JWT is available, run the same drill with the non-admin
      denial check enabled.
* [ ] Capture unauthenticated admin request rejection.
* [ ] Capture malformed ``Cf-Access-Jwt-Assertion`` rejection.
* [ ] Capture valid non-allowlisted Access JWT rejection when available.
* [ ] Capture valid allowlisted Access JWT read success.
* [ ] Capture valid allowlisted Access JWT mutation success.
* [ ] Inspect staging D1 after mutation:

  * [ ] entitlement row exists with expected fingerprint, status, project, and
        ``revocation_seq``;
  * [ ] matching audit event exists with ``actor_type='admin'`` or equivalent
        Access actor metadata;
  * [ ] idempotency replay row exists when an idempotency key was supplied;
  * [ ] no secret values are present in event JSON, logs, or response bodies.

Exit criteria:

* [ ] Admin mutation succeeds only with a cryptographically verified and
      allowlisted Access identity.
* [ ] Unauthorized, malformed, and non-admin identities cannot mutate.
* [ ] Entitlement, audit event, and idempotency evidence are attached.

PB-2: R2 backup export and scratch-D1 restore drill
---------------------------------------------------

Purpose:
  Validate that entitlement data can be exported, stored in R2, restored into a
  scratch D1 database, and used by the verifier after restoration.

Prerequisites:

* [ ] D1 backup Worker or Workflow deployed to staging.
* [ ] Backup Worker has no verifier signing private key and no admin sync token.
* [ ] D1 REST export token is scoped to the intended staging database.
* [ ] R2 bucket and backup prefix configured.
* [ ] Scratch D1 database created for restore validation.
* [ ] Operator has ``LICENSECC_R2_BACKUP_BUCKET``.
* [ ] Operator has ``LICENSECC_R2_BACKUP_OBJECT_KEY`` for the backup to test.
* [ ] Operator has ``LICENSECC_RESTORE_SCRATCH_D1``.
* [ ] Optional source/scratch/R2 wrangler config paths are available when the
      default config is not the intended staging config.

Verification checklist:

* [ ] Run backup service tests:

  .. code-block:: console

     npm --prefix services/cloudflare-d1-backup test

* [ ] Run backup lint:

  .. code-block:: console

     npm --prefix services/cloudflare-d1-backup run lint

* [ ] Run backup dry-run:

  .. code-block:: console

     npm --prefix services/cloudflare-d1-backup run dry-run

* [ ] Confirm restore drill script contract:

  .. code-block:: console

     node services/cloudflare-d1-backup/scripts/restore-drill.mjs --help

* [ ] Confirm deploy validator script contract:

  .. code-block:: console

     node services/cloudflare-d1-backup/scripts/validate-deploy.mjs --help

* [ ] Confirm external preflight reports R2 restore inputs present:

  .. code-block:: console

     node scripts/external_gate_preflight.mjs --json

Validation checklist:

* [ ] Trigger a staging backup or select the latest scheduled staging backup.
* [ ] Validate the deployed backup Worker without printing secrets:

  .. code-block:: console

     npm --prefix services/cloudflare-d1-backup run validate:deploy -- --url <backup-worker-url> --worker-name <backup-worker-name> --workflow-name <workflow-name> --json

* [ ] For production sign-off, require the D1 REST token:

  .. code-block:: console

     node services/cloudflare-d1-backup/scripts/validate-deploy.mjs --url <backup-worker-url> --worker-name <backup-worker-name> --workflow-name <workflow-name> --require-d1-rest-token --json

* [ ] Confirm the R2 object exists without printing secret credentials:

  .. code-block:: console

     npx wrangler r2 object get <bucket>/<object-key> --file build/release-gates/restore-drill-backup.sql

* [ ] Run the restore drill against scratch D1:

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

* [ ] Compare source and scratch row counts for:

  * [ ] ``entitlements``;
  * [ ] ``entitlement_events``;
  * [ ] ``mutation_idempotency``.

* [ ] Verify a restored active entitlement through a verifier bound to scratch
      D1.
* [ ] Verify a restored revoked entitlement denies through a verifier bound to
      scratch D1.
* [ ] Confirm the restore drill reports
      ``restored_entitlement_semantics.verifier_candidates.active_accept >= 1``
      and ``revoked_deny >= 1`` when the required status flags are used.
* [ ] Confirm restore did not target a production D1 database.
* [ ] Record backup object key, object size, restore command, row counts,
      verifier responses, and cleanup actions.

Exit criteria:

* [ ] A real R2 backup object was restored into scratch D1.
* [ ] Restored row counts match expected source counts.
* [ ] Restored active and revoked entitlement behavior matches source state.
* [ ] Restore evidence is attached to the release packet.

PB-3: admin UI and operator workflow validation
-----------------------------------------------

Purpose:
  Ensure operators can perform the expected entitlement lifecycle without using
  dev-only paths or manual D1 edits.

Prerequisites:

* [ ] Admin UI built from the same release candidate as the admin Worker.
* [ ] Admin UI served behind the same Access policy as the admin API.
* [ ] Test entitlement/customer/license identifiers selected.
* [ ] Browser trace or screenshot capture enabled.

Verification checklist:

* [ ] Run the UI build:

  .. code-block:: console

     npm --prefix services/cloudflare-license-admin run build

* [ ] Run available UI or browser tests:

  .. code-block:: console

     npm --prefix services/cloudflare-license-admin run test:ui
     npm --prefix services/cloudflare-license-admin run test:e2e

Validation checklist:

* [ ] Unauthenticated browser request is rejected by Access.
* [ ] Allowed admin can open the dashboard.
* [ ] Create entitlement from UI.
* [ ] Patch metadata, validity window, or assertion TTL from UI.
* [ ] Disable entitlement from UI.
* [ ] Reenable entitlement from UI.
* [ ] Revoke entitlement from UI.
* [ ] Attempt to reenable revoked entitlement and capture terminal-state
      denial.
* [ ] Confirm audit timeline displays every lifecycle event.
* [ ] Confirm duplicate form submission does not duplicate mutations.
* [ ] Confirm no UI screen exposes private keys, JWTs, bearer tokens, sync
      tokens, or signing material.

Exit criteria:

* [ ] Operator lifecycle actions work through Access-authenticated UI.
* [ ] UI cannot bypass API invariants.
* [ ] Screenshots or traces are attached to the release packet.

PB-4: abuse, observability, and cost-control validation
-------------------------------------------------------

Purpose:
  Prove the public verifier remains cheap and diagnosable for the expected
  low-volume deployment.

Prerequisites:

* [ ] Verifier staging Worker deployed with intended rate-limiter bindings.
* [ ] Test client source selected for controlled burst.
* [ ] Log capture or Wrangler tail ready.
* [ ] Expected normal request rate and abuse threshold documented.

Verification checklist:

* [ ] Run verifier tests:

  .. code-block:: console

     npm --prefix services/cloudflare-licensing-backend test

* [ ] Run local verifier/admin e2e:

  .. code-block:: console

     npm --prefix services/cloudflare-licensing-backend run test:e2e

* [ ] Run the public verifier abuse drill against staging:

  .. code-block:: console

     node services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs --url <staging-verifier-url> --expect-rate-limit --json

Validation checklist:

* [ ] Malformed fingerprints are rejected before signing work.
* [ ] Unknown or denied entitlements return unsigned denial by default.
* [ ] Controlled burst hits the expected limiter path.
* [ ] Normal request rate is accepted after the limiter window.
* [ ] Logs include request id, status, and redacted diagnostic context.
* [ ] Logs do not include private keys, JWTs, bearer tokens, or signing
      material.

Exit criteria:

* [ ] Abuse controls match the expected low-volume deployment.
* [ ] Logs are sufficient for support without exposing secrets.

PB-5: final evidence packet and review
--------------------------------------

Purpose:
  Make the release decision from evidence instead of memory of prior local
  runs.

Prerequisites:

* [ ] PB-0 through PB-4 are complete or explicitly blocked.
* [ ] Release candidate commit or diff reference is stable.
* [ ] All generated evidence is stored outside tracked source unless the repo
      intentionally tracks it.

Verification checklist:

* [ ] Run docs link check:

  .. code-block:: console

     uv run --no-project python scripts/check_docs_links.py doc

* [ ] Run docs build:

  .. code-block:: console

     uv run --no-project python scripts/build_docs.py

* [ ] Run risky-claim scan:

  .. code-block:: console

     rg -n "prevents cracking|tamper-proof|uncrackable|impossible to bypass" README.md doc services

* [ ] Run final secret hygiene scan:

  .. code-block:: console

     node scripts/secret_hygiene_scan.mjs

* [ ] Run final whitespace check:

  .. code-block:: console

     git diff --check

Validation checklist:

* [ ] Attach strict release gate JSON.
* [ ] Attach Cloudflare Access admin mutation transcript.
* [ ] Attach R2 backup and scratch-D1 restore transcript.
* [ ] Attach admin UI screenshots or traces.
* [ ] Attach D1 migration list and Worker deployment ids.
* [ ] Attach final C++ API/protocol review.
* [ ] Attach final Worker/D1/security review.
* [ ] Attach final UI/DX/docs review.
* [ ] Record all accepted residual risks and owners.

Exit criteria:

* [ ] No unresolved Critical or High review findings.
* [ ] No Medium findings affecting signing keys, admin auth, customer state,
      audit integrity, data recovery, or public claims.
* [ ] Production rollout decision is recorded as ``ship``, ``defer``, or
      ``blocked`` with evidence ids.

Hard blockers
=============

These items block production regardless of other green checks:

* [ ] A real online signing private key is present in any tracked file.
* [ ] The admin Worker has access to ``ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM``.
* [ ] The verifier Worker exposes admin mutation routes.
* [ ] Admin mutation succeeds without a verified Cloudflare Access JWT or an
  explicitly documented equivalent production auth layer.
* [ ] Development bearer auth works in staging or production.
* [ ] A state-changing entitlement mutation can persist without an audit event.
* [ ] A state-changing entitlement mutation with an idempotency key can persist
  without a replay record.
* [ ] Revoked entitlements can be reactivated through ordinary admin, sync, or
  break-glass CLI flows.
* [ ] C++ online verification accepts assertions signed by the offline project
  license key instead of the online assertion key.
* [ ] Missing online assertion public keys allow access when online
  verification is required.
* [ ] The public verifier signs denial responses by default.
* [ ] No staging Cloudflare Access admin mutation drill has passed.
* [ ] No real D1 SQL export stored in R2 plus scratch-D1 restore drill has
  passed.

Evidence matrix
===============

.. list-table::
   :header-rows: 1
   :widths: 10 18 34 28

   * - Gate
     - Evidence prefix
     - Verification artifact
     - Validation artifact
   * - 0
     - ``G0-HYGIENE``
     - ``git diff --check`` output, secret scan output, ignored-path proof
     - reviewer note that no real secrets or unreviewed deployment files are
       tracked
   * - 1
     - ``G1-LOCAL``
     - release runner JSON, CTest output, npm test/lint/dry-run logs, docs
       build log
     - explicit statement that skipped external gates are not counted as
       production sign-off
   * - 2
     - ``G2-ATOMICITY``
     - admin test output and remote D1 atomicity script output
     - staging D1 row/event/idempotency inspection showing no partial writes
   * - 3
     - ``G3-ACCESS``
     - Wrangler deploy, secret list, D1 migration list
     - Access JWT read and mutation transcript, non-admin denial transcript,
       malformed JWT denial transcript
   * - 4
     - ``G4-ONLINE-CPP``
     - C++ online tests and remote C++ validator output
     - active, disabled, reenabled, revoked, expired, wrong-key, and rollback
       staging transcripts
   * - 5
     - ``G5-ADMIN-UI``
     - UI build and browser/e2e logs
     - screenshots or traces for create, patch, disable, reenable, revoke,
       revoked denial, and audit timeline
   * - 6
     - ``G6-SYNC``
     - sync tests and sync CLI help output
     - staging source-system fixture synced to D1, verified, disabled, revoked,
       and inspected in audit log
   * - 7
     - ``G7-BACKUP``
     - backup tests, lint, dry-run, and restore-drill help output
     - R2 backup object id, scratch-D1 restore transcript, row-count compare,
       and verifier checks on restored rows
   * - 8
     - ``G8-ABUSE``
     - verifier tests and local e2e output
     - controlled staging burst transcript and redacted log review
   * - 9
     - ``G9-DOCS``
     - docs link check, docs build, risky-phrase scan
     - reviewer note that public docs match deployed behavior and residual
       risks
   * - 10
     - ``G10-REVIEW``
     - final review reports with file/line references
     - owner sign-off, blocker disposition, and accepted residual-risk record

Release gate dashboard
======================

.. list-table::
   :header-rows: 1
   :widths: 12 16 30 30

   * - Gate
     - Current status
     - Verification required
     - Validation required
   * - Gate 0 hygiene
     - ``[~]`` local checks required before commit
     - ``git diff --check``, ignore checks, secret-marker scan
     - dirty-tree review and no real secrets in tracked files
   * - Gate 1 local deterministic
     - ``[~]`` mostly exercised
     - CTest, Worker tests, lint, dry-runs, docs build
     - failures fixed or explicitly waived before staging
   * - Gate 2 admin atomicity
     - ``[x]`` implemented; remote rollback drill exercised
     - admin tests and ``validate:remote-d1-atomicity``
     - no mutation without audit/idempotency, revoked terminal everywhere
   * - Gate 3 real staging
     - ``[~]`` Workers/D1 deployed; Access mutation still missing
     - Wrangler deploys, secret list, D1 migration list
     - Cloudflare Access JWT read and mutation success/failure cases
   * - Gate 4 online C++ E2E
     - ``[x]`` remote Worker assertion verified by C++
     - ``test_online_verification`` and ``validate:remote-cpp``
     - active/revoked behavior and signature/key separation proven
   * - Gate 5 admin UI workflow
     - ``[~]`` local build path exists
     - UI build and browser/e2e workflow tests
     - operator screenshots/traces for lifecycle actions
   * - Gate 6 user DB sync
     - ``[x]`` staged sync flow exercised
     - sync tests and sync CLI help
     - create, replay, revoke, and terminal reactivation denial in real D1
   * - Gate 7 backups
     - ``[~]`` real R2 restore drill passed; backup Worker cron and Workflow
       deploy validated; backup-service export still needs D1 REST token
       evidence
     - backup tests, lint, dry-run, deploy, and R2 restore release gate
     - real scheduled export plus scratch-D1 restore drill and restored verifier
       checks
   * - Gate 8 abuse resistance
     - ``[~]`` local verifier checks exist
     - verifier tests and staging rate-limit checks
     - burst behavior, denial signing policy, and log quality
   * - Gate 9 docs and claims
     - ``[~]`` local docs pass; final claim review needed
     - strict docs build and risky-phrase search
     - docs match production behavior and residual risks
   * - Gate 10 final review
     - ``[ ]`` pending final evidence packet
     - three focused reviews and release-blocker checklist
     - owner sign-off or explicit defer/block decision

Minimum production checklist
============================

The deployment is not production-ready until every required item below is
checked and linked to evidence.

Cloudflare staging and auth
---------------------------

* [ ] ``licensecc-online-verifier`` staging Worker deployed from the intended
  config.
* [ ] ``licensecc-license-admin`` staging Worker deployed from the intended
  config.
* [ ] Verifier and admin Workers are bound to the intended staging D1 database.
* [ ] D1 remote migration list matches the committed migrations.
* [ ] Verifier Worker has ``ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM`` secret.
* [ ] Admin Worker does not have any online signing private key secret.
* [ ] Admin dev bearer is absent or refused outside local development.
* [ ] Cloudflare Access issuer, audience, JWKS URL, and allowlist are
  configured for staging.
* [ ] Unauthenticated admin request is rejected before any D1 write.
* [ ] Malformed ``Cf-Access-Jwt-Assertion`` is rejected.
* [ ] Valid Access JWT for a non-allowlisted email is rejected.
* [ ] Valid Access JWT for an allowed admin can read.
* [ ] Valid Access JWT for an allowed admin can create or mutate an
  entitlement.
* [ ] Admin mutation through Access writes entitlement, audit event, and
  idempotency record atomically.

Online verification and C++ client
----------------------------------

* [ ] Local invalid license failure is not masked by online verification.
* [ ] Local valid license plus active online entitlement returns allowed.
* [ ] Disabled entitlement denies a fresh verification.
* [ ] Reenabled entitlement allows fresh verification with higher
  ``revocation_seq``.
* [ ] Revoked entitlement denies fresh verification.
* [ ] Expired online assertion is rejected by C++.
* [ ] Assertion signed by unknown online key id is rejected.
* [ ] Assertion signed by the offline project key is rejected.
* [ ] Missing online key ring fails closed when online verification is required.
* [ ] Lower ``revocation_seq`` than the process floor is rejected.
* [ ] Host integration docs explain how to persist a restart-resilient
  revocation floor when required.

Admin, sync, and data integrity
-------------------------------

* [ ] Admin API and sync API use the same write kernel for entitlement changes.
* [ ] Every state-changing mutation uses one D1 ``batch()`` for entitlement,
  audit, and idempotency writes.
* [ ] Missing D1 ``batch()`` fails closed.
* [ ] Revoked entitlements are terminal through admin API.
* [ ] Revoked entitlements are terminal through sync API.
* [ ] Revoked entitlements are terminal through the break-glass CLI.
* [ ] Break-glass CLI cannot silently reactivate revoked rows through normal
  ``upsert``.
* [ ] ``revocation_seq`` is server-derived and monotonic across recreated rows.
* [ ] Duplicate idempotency key replay does not advance ``revocation_seq``.
* [ ] Audit events include actor type, actor id, source, request id, previous
  state, next state, and resulting ``revocation_seq``.
* [ ] Admin UI cannot bypass API invariants.
* [ ] Operator UI shows lifecycle state and audit timeline without exposing
  secrets.

Backups and recovery
--------------------

* [ ] Backup Worker/Workflow deployed separately from verifier and admin
  Workers.
* [ ] Backup Worker has no verifier signing key or admin sync token.
* [ ] D1 REST export token is scoped to the intended database.
* [ ] R2 bucket and backup prefix are configured.
* [ ] Scheduled backup run creates SQL export and metadata manifest in R2.
* [ ] Manual backup trigger requires ``BACKUP_TRIGGER_TOKEN``.
* [ ] Restore drill imports a backup into a scratch D1 database.
* [ ] Restored scratch D1 row counts match source counts for
  ``entitlements``, ``entitlement_events``, and ``mutation_idempotency``.
* [ ] Restored active entitlement verifies through a verifier bound to scratch
  D1.
* [ ] Restored revoked entitlement denies through a verifier bound to scratch
  D1.
* [ ] Restore runbook documents expected downtime and destructive Time Travel
  behavior.

Abuse resistance and observability
----------------------------------

* [ ] Malformed fingerprints are rejected before signing work.
* [ ] Unknown or denied entitlements are unsigned by default.
* [ ] Client-source rate limiting is configured.
* [ ] Entitlement/fingerprint tier limiting is configured.
* [ ] Controlled staging burst hits the expected rate-limit path.
* [ ] Normal low-volume requests recover after the limiter window.
* [ ] ``public-verifier-drill.mjs`` exits ``0`` with redacted target evidence.
* [ ] Logs include request id and redacted diagnostic context.
* [ ] Logs do not include private keys, bearer tokens, Access JWTs, or raw
  online signing material.

Documentation and review
------------------------

* [ ] README and docs avoid claims such as "tamper-proof", "uncrackable", or
  "prevents cracking".
* [ ] Security model explains tamper-resistant local enforcement and residual
  bypass risk on fully controlled client machines.
* [ ] Integration docs recommend ``acquire_license_ex()`` for hardened
  integrations.
* [ ] Docs describe ``acquire_license()`` as compatibility behavior.
* [ ] Docs explain offline project key and online assertion key separation.
* [ ] Docs explain cache TTL, assertion TTL, revocation latency, and failure
  modes.
* [ ] Docs explain process-local revocation floor and host persistence
  responsibility.
* [ ] Backup and restore docs include deploy, manual trigger, status, restore,
  and validation commands.
* [ ] Final Worker/D1/security review has no unresolved Critical or High
  findings.
* [ ] Final C++ API/ABI/protocol review has no unresolved Critical or High
  findings.
* [ ] Final admin UI/DX/docs review has no unresolved Critical or High
  findings.

Evidence worksheet template
===========================

Use this template for each validation run:

.. code-block:: text

   Evidence id:
   Gate:
   Date/time:
   Operator:
   Commit or diff reference:
   Environment:
   Cloudflare account:
   Worker name/version/deployment id:
   D1 database and migration list:
   Command or action:
   Exit code / HTTP status:
   Redacted output:
   Rows inspected:
   Screenshot / trace:
   Pass or fail:
   Follow-up owner:

Gate 0: repository hygiene and secret safety
============================================

Purpose
-------

Confirm the repository is reviewable and does not contain private deployment
material before running deeper validation.

Implementation checklist
------------------------

* Keep generated local Cloudflare files ignored:

  * ``services/cloudflare-licensing-backend/wrangler.toml``
  * ``services/cloudflare-license-admin/wrangler.toml``
  * ``services/cloudflare-licensing-backend/.dev.vars``
  * ``services/cloudflare-license-admin/.dev.vars``
  * ``services/cloudflare-licensing-backend/.online-key/``

* Keep D1 backup destination names, account ids, and Worker routes in examples
  unless the deployment file is intentionally private.
* Do not commit Cloudflare API tokens, Access JWTs, dev bearer secrets, sync
  tokens, or online signing private keys.
* Confirm CI does not require production Cloudflare credentials for ordinary
  pull-request validation.

Verification
------------

Run:

.. code-block:: console

   git status --short
   git diff --check
   git check-ignore services/cloudflare-licensing-backend/wrangler.toml services/cloudflare-license-admin/wrangler.toml
   git check-ignore services/cloudflare-licensing-backend/.dev.vars services/cloudflare-license-admin/.dev.vars
   git check-ignore services/cloudflare-licensing-backend/.online-key

Run a local secret-marker scan:

.. code-block:: console

   node scripts/secret_hygiene_scan.mjs

The top-level release gate runner also runs this scan. The legacy raw ``rg``
form is useful for manual inspection:

.. code-block:: console

   rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' "-----BEGIN (RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----|CLOUDFLARE_API_TOKEN=|ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM=|ADMIN_BEARER=|SYNC_API_TOKEN=|CF_API_TOKEN=" .

Validation
----------

* Every match is either an intentional documentation/example reference or a
  false positive.
* Real secret values are absent from tracked files.
* CI workflow permissions are least-privilege for validation jobs.

Exit criteria
-------------

* No private key, token, JWT, or bearer value is tracked.
* All local deployment files that can contain secrets are ignored.
* Any dirty working-tree entries are understood and intentionally included or
  intentionally left out of the release change.

Gate 1: local deterministic validation
======================================

Purpose
-------

Prove the repo's deterministic gates pass before spending time on staging.

Implementation checklist
------------------------

* Use ``uv`` or ``uvx`` for Python-based documentation and schema helpers.
* Build the C++ library and run the focused security/API tests.
* Run the full CTest suite.
* Run Cloudflare verifier tests, lint, schema parity, dry-run, migration, and
  local end-to-end tests.
* Run admin Worker tests, lint, dry-run, migration, and UI build.
* Build strict documentation after any documentation change.
* Keep the ``Release_Gates`` CI workflow green for root release-gate tooling,
  secret hygiene, and release-readiness assertion tests.

Verification
------------

Top-level local gate runner:

.. code-block:: console

   node scripts/validate_release_gates.mjs --quick --external

Use ``--quick`` for a smoke run. For release evidence, run the full deterministic
gate:

.. code-block:: console

   node scripts/validate_release_gates.mjs --full --external --json-out build/release-gates/full-latest.json

For production sign-off, require the staging drills instead of allowing skips:

.. code-block:: console

   node scripts/external_gate_preflight.mjs
   node scripts/validate_release_gates.mjs --full --require-external --json-out build/release-gates/production-latest.json
   node scripts/assert_release_ready.mjs build/release-gates/production-latest.json

The ``--external`` flag runs staging Access, R2 restore, and backup deployment
drills only when the required environment variables are present; otherwise it
records explicit skip reasons.
The ``--require-external`` flag implies ``--external``, runs a secret-redacted
input preflight before local gates, exits immediately with
``external_input_missing`` blockers when required external variables are
absent, requires ``build/CTestTestfile.cmake`` so C++ release tests cannot be
silently omitted, and exits nonzero if a staging drill is skipped. Full
``--full`` runs have the same CTest metadata prerequisite. The resulting JSON
is archived in the ignored build directory and must show ``complete=true``,
``production_ready=true``, and an empty ``blocking_reasons`` list before it can
be used as production sign-off.
``assert_release_ready.mjs`` checks those fields and also confirms that required
deterministic local gate labels, including C++ tests and the admin UI build,
and all Cloudflare staging drills are present with status ``0``.
``external_gate_preflight.mjs`` is a fast, secret-redacted check that fails
before the long local gate run when required external environment variables
are missing.

C++:

.. code-block:: console

   cmake --build build --config Debug --target licensecc_static
   ctest --test-dir build -C Debug -R "test_(public_api|anti_tamper|online_verification|ctest_label_audit)$" --output-on-failure
   ctest --test-dir build -C Debug --output-on-failure --timeout 900

Online verifier:

.. code-block:: console

   npm --prefix services/cloudflare-licensing-backend ci
   npm --prefix services/cloudflare-licensing-backend test
   npm --prefix services/cloudflare-licensing-backend run test:e2e
   npm --prefix services/cloudflare-licensing-backend run lint
   npm --prefix services/cloudflare-licensing-backend run schema:parity
   npm --prefix services/cloudflare-licensing-backend run dry-run
   npm --prefix services/cloudflare-licensing-backend run migrate:local

Admin Worker/UI:

.. code-block:: console

   npm --prefix services/cloudflare-license-admin ci
   npm --prefix services/cloudflare-license-admin test
   npm --prefix services/cloudflare-license-admin run lint
   npm --prefix services/cloudflare-license-admin run build
   npm --prefix services/cloudflare-license-admin run dry-run
   npm --prefix services/cloudflare-license-admin run migrate:local
   node services/cloudflare-license-admin/scripts/validate-access-admin.mjs --help
   node services/cloudflare-license-admin/scripts/access-admin-drill.mjs --help

Docs:

.. code-block:: console

   uv run --no-project python scripts/check_docs_links.py doc
   uv run --no-project python scripts/build_docs.py

Release gate tooling:

.. code-block:: console

   node --test scripts/assert_release_ready.test.mjs scripts/secret_hygiene_scan.test.mjs scripts/validate_release_gates.test.mjs
   node --test scripts/external_gate_preflight.test.mjs
   node --test scripts/release_gates_workflow.test.mjs
   node scripts/secret_hygiene_scan.mjs

Validation
----------

* Failures are fixed before staging unless they are unrelated and documented.
* Local D1 migration failures caused by stale Wrangler state are reproduced,
  diagnosed, cleaned up, and rerun successfully.
* Test output includes the relevant test counts and no skipped release-critical
  suites.

Exit criteria
-------------

* All commands pass locally.
* The CI workflows run the same Python helper path used locally.
* CTest label audit requires public API, security, anti-tamper, and online
  verification coverage.

Gate 2: admin mutation atomicity and invariants
===============================================

Purpose
-------

Close the highest-risk admin data-integrity gaps: mutation without audit,
non-atomic idempotency, and terminal revoked-state bypasses.

Implementation checklist
------------------------

* Use one D1 ``batch()`` for every state-changing entitlement mutation.
* Include the entitlement write, audit event insert, and idempotency replay
  insert in that same batch when an idempotency key is supplied.
* Fail closed when the D1 binding does not expose ``batch()``.
* Keep no-op idempotency replay safe: it may be recorded after a read only when
  no entitlement mutation occurred.
* Ensure ``revocation_seq`` is computed by SQL from current row and historical
  events, not accepted from a client.
* Keep revoked entitlements terminal for v1.
* Ensure the break-glass CLI cannot reactivate revoked entitlements through a
  normal ``upsert``.
* If a future revoked override is added, require an explicit flag, a distinct
  event type, and documentation.

Verification
------------

Run the admin tests:

.. code-block:: console

   npm --prefix services/cloudflare-license-admin test

Required test cases:

* create with ``Idempotency-Key`` writes entitlement, audit, and replay record in
  one batch;
* duplicate idempotency key does not double-increment ``revocation_seq``;
* audit insert failure rolls back entitlement and idempotency writes;
* D1 ``batch()`` unavailable fails closed;
* revoked entitlement cannot be patched, disabled, reenabled, revoked again, or
  upserted through the break-glass CLI;
* every mutation records server-derived actor/source/request id;
* unauthorized mutation is rejected before any D1 write.

Validation
----------

Against real staging D1, perform:

* a successful create with idempotency key;
* a replay of the same request;
* a mutation with deliberately failing audit insert in a scratch Worker or test
  route;
* a revoked-row CLI upsert attempt;
* a query of ``entitlements``, ``entitlement_events``, and
  ``mutation_idempotency`` after each step.

The repository includes an operator script for the failing-audit rollback
drill:

.. code-block:: console

   npm --prefix services/cloudflare-license-admin run validate:remote-d1-atomicity -- ../cloudflare-licensing-backend/wrangler.toml

Expected evidence:

* successful mutation creates exactly one row, one event, and one replay record;
* replay returns the original response without advancing ``revocation_seq``;
* forced audit failure leaves no partial entitlement or idempotency row;
* revoked-row CLI upsert leaves the row revoked and creates no normal upsert
  event.

Exit criteria
-------------

* No entitlement state change can persist without an audit event.
* No state-changing mutation with an idempotency key can persist without its
  replay record.
* Revoked terminal behavior is consistent between admin API and CLI.

Gate 3: real Cloudflare staging resources
=========================================

Purpose
-------

Prove the Worker, D1, Access, routes, and secrets work in a real Cloudflare
account, not only in local mocks.

Implementation checklist
------------------------

* Create or select a staging D1 database for verifier/admin entitlements.
* Deploy verifier Worker to a staging route or workers.dev hostname.
* Deploy admin Worker behind Cloudflare Access.
* Store online signing private key only in the verifier Worker secret.
* Store admin dev bearer only for local development; do not enable it in
  staging or production.
* Configure Access issuer, audience, JWKS URL, and admin allowlist.
* Configure rate-limiter bindings for verifier abuse control.
* Configure backup Workflow and R2 bucket before live mutations.

Verification
------------

Use Wrangler against staging:

.. code-block:: console

   npx wrangler d1 migrations apply <staging-db-name> --remote --config services/cloudflare-licensing-backend/wrangler.toml
   npx wrangler deploy --config services/cloudflare-licensing-backend/wrangler.toml
   npx wrangler deploy --config services/cloudflare-license-admin/wrangler.toml

Confirm secrets are set without printing values:

.. code-block:: console

   npx wrangler secret list --config services/cloudflare-licensing-backend/wrangler.toml
   npx wrangler secret list --config services/cloudflare-license-admin/wrangler.toml

Validation
----------

* Verifier ``/health`` returns healthy from the deployed URL.
* Admin API returns unauthorized without Cloudflare Access.
* Admin API accepts a valid Access JWT for an allowed admin.
* Admin API rejects a valid Access JWT for a non-allowlisted email.
* Admin API rejects malformed or garbage ``Cf-Access-Jwt-Assertion`` values.
* Dev bearer configuration is absent or refused in staging.
* Deployed admin Worker has no signing private key binding.
* Deployed verifier Worker has no admin-only sync/admin mutation routes.

The repository includes an operator script for the Access JWT mutation drill:

.. code-block:: console

   cloudflared access login --quiet --auto-close --app https://licensecc-admin.example.workers.dev
   LICENSECC_ACCESS_USE_CLOUDFLARED=1 node services/cloudflare-license-admin/scripts/access-admin-drill.mjs \
     --url https://licensecc-admin.example.workers.dev

Alternatively set ``LICENSECC_ACCESS_JWT=<redacted>`` before running
``access-admin-drill.mjs``. Optionally set
``LICENSECC_NON_ADMIN_ACCESS_JWT=<redacted>`` to prove a real non-admin Access
identity cannot mutate.

Exit criteria
-------------

* Staging deploys are reachable and bound to the intended D1 database.
* Access authorization is cryptographic and role-enforced.
* Secrets are scoped to the correct Worker.

Gate 4: staging online verification end-to-end
==============================================

Purpose
-------

Prove the C++ host path, verifier Worker, signing key, D1 state, and revocation
floor work together.

Implementation checklist
------------------------

* Build the C++ test or sample with staging online assertion public key records.
* Use a host transport callback to call the staging verifier URL.
* Keep online verification required in the test host.
* Exercise active, disabled, reenabled, revoked, expired, and rollback cases.
* Persist a host revocation floor in the sample if restart-resilient rollback
  detection is in scope for the host project.

Verification
------------

Run local C++ tests after embedding the staging public key records:

.. code-block:: console

   cmake --build build --config Debug --target test_online_verification
   ctest --test-dir build -C Debug -R "test_online_verification$" --output-on-failure

For a staging/test Worker-signed assertion, run:

.. code-block:: console

   npm --prefix services/cloudflare-licensing-backend run validate:remote-cpp -- wrangler.toml ../../build Debug

Run the staging host sample or e2e harness and capture:

* request payload without private secrets;
* verifier response status and signed assertion;
* C++ final license result;
* audit/tamper/online diagnostic result.

Validation
----------

Expected behavior:

* valid local license plus active online entitlement returns allowed;
* invalid local license returns the local failure and does not mask it as online
  failure;
* disabled entitlement denies fresh verification;
* reenabled entitlement allows fresh verification with a higher
  ``revocation_seq``;
* revoked entitlement denies fresh verification;
* assertion with expired ``expires_at`` is rejected;
* assertion signed by unknown key id is rejected;
* assertion signed with offline project key instead of online key is rejected;
* assertion with lower ``revocation_seq`` than the process floor is rejected;
* missing online public key ring fails closed when online verification is
  required.

Exit criteria
-------------

* C++ and Worker agree on canonical assertion fields and signature policy.
* Online verification runs only after local verification succeeds.
* Revocation floor behavior is documented as process-local unless the host
  persists it.

Gate 5: admin UI and operator workflow
======================================

Purpose
-------

Validate that the Vite + React admin console is useful without weakening the
security model.

Implementation checklist
------------------------

* Keep admin UI behind Cloudflare Access.
* Use typed API contracts shared with the Worker.
* Use idempotency keys for mutating form submissions.
* Show entitlement status, validity windows, assertion TTL, revocation sequence,
  notes, customer id, license id, and audit timeline.
* Do not expose private keys or raw tokens in the UI.
* Make revoked terminal behavior clear through disabled actions and API errors.
* Provide sync workflow for user-database/billing-system source of truth.

Verification
------------

Run:

.. code-block:: console

   npm --prefix services/cloudflare-license-admin run build
   npm --prefix services/cloudflare-license-admin run test:ui
   npm --prefix services/cloudflare-license-admin run test:e2e

For staging, capture screenshots or Playwright traces for:

* unauthenticated access rejected;
* admin summary loaded;
* create entitlement;
* patch metadata/validity/TTL;
* disable;
* reenable;
* revoke;
* revoked reenable rejected;
* audit timeline shown;
* sync endpoint result shown or logged.

Validation
----------

* UI actions match API semantics.
* Duplicate browser submissions do not duplicate mutations.
* Error messages are operator-useful without exposing secrets.
* Audit timeline includes actor/source/request id for every mutation.

Exit criteria
-------------

* Operators can complete normal lifecycle tasks from UI or sync endpoint.
* UI cannot bypass revoked terminal behavior.
* No UI workflow depends on dev bearer in staging or production.

Gate 6: user database sync and DX
=================================

Purpose
-------

Make integration with an application's own user database predictable and
operator-friendly.

Implementation checklist
------------------------

* Treat the application database, billing system, or CRM as source of truth.
* Use ``POST /api/sync/entitlements`` for service-to-service sync.
* Store ``SYNC_API_TOKEN`` as a Worker secret.
* Validate project, feature, license fingerprint, device hash, status, validity
  windows, TTLs, customer id, license id, and notes.
* Use the same write kernel as admin UI mutations.
* Write audit events with ``source='sync'`` or equivalent explicit source.
* Document a small sync client and example payloads.

Verification
------------

Run:

.. code-block:: console

   npm --prefix services/cloudflare-license-admin test
   node services/cloudflare-license-admin/scripts/sync-entitlement.mjs --help

Required tests:

* missing sync token rejected;
* invalid sync token rejected;
* valid sync token can create/update allowed fields;
* sync cannot reactivate revoked rows unless a future explicit override is
  designed;
* sync writes audit and idempotency records using the same atomic path.

Validation
----------

In staging:

* create a test user/license in the source system or fixture;
* sync it to D1;
* verify it through the public verifier;
* change status to disabled in source system and sync;
* verify fresh denial;
* revoke and confirm terminal behavior;
* inspect audit timeline.

Exit criteria
-------------

* A host project can manage entitlements from its own database without manual
  D1 edits.
* Sync follows the same security and audit rules as the admin API.

Gate 7: backup, restore, and migration safety
=============================================

Purpose
-------

Ensure entitlement and audit data can be recovered before production mutation
traffic starts.

Implementation checklist
------------------------

* Deploy the D1 backup Workflow before production admin mutations.
* Export D1 data to R2 on a schedule.
* Keep backup Worker separate from verifier signing secrets.
* Document restore steps and expected downtime.
* Define retention and access policy for R2 backups.
* Run migration dry-runs on staging data before production.

Verification
------------

Run local backup service gates:

.. code-block:: console

   npm --prefix services/cloudflare-d1-backup ci
   npm --prefix services/cloudflare-d1-backup test
   npm --prefix services/cloudflare-d1-backup run lint
   npm --prefix services/cloudflare-d1-backup run dry-run
   node services/cloudflare-d1-backup/scripts/restore-drill.mjs --help

In staging, trigger or wait for a scheduled export, then confirm the R2 object
exists.

Validation
----------

Run a restore drill against a scratch D1 database:

* export staging D1;
* restore to scratch D1;
* run the restore drill wrapper:

  .. code-block:: console

     node services/cloudflare-d1-backup/scripts/restore-drill.mjs \
       --bucket licensecc-d1-backups \
       --object-key <backup-key> \
       --scratch-database licensecc-online-verifier-restore-drill \
       --source-database licensecc-online-verifier \
       --confirm-scratch \
       --remote

* compare row counts for ``entitlements``, ``entitlement_events``, and
  ``mutation_idempotency``;
* verify a restored active entitlement through the staging verifier wired to the
  scratch database;
* verify a restored revoked entitlement denies.

Exit criteria
-------------

* Backup export exists and is readable by authorized operators.
* Restore drill succeeds against scratch D1.
* Migration rollback or recovery path is documented.

Gate 8: rate limiting and abuse resistance
==========================================

Purpose
-------

Keep the public verifier cheap and stable for low-volume deployments.

Implementation checklist
------------------------

* Rate-limit by client network identity where Cloudflare metadata is available.
* Rate-limit by entitlement key or fingerprint tier after canonical validation.
* Consider a global signing tier for very small deployments if abuse cost is a
  larger risk than burst tolerance.
* Keep denial responses unsigned by default.
* Do not expose an active-entitlement enumeration path.

Verification
------------

Run verifier tests:

.. code-block:: console

   npm --prefix services/cloudflare-licensing-backend test
   npm --prefix services/cloudflare-licensing-backend run test:e2e

Required tests:

* malformed fingerprints are rejected before expensive signing work;
* repeated invalid requests hit the configured limiter path;
* rotating fingerprints from one source cannot bypass the client tier;
* denied entitlements are not signed by default;
* valid active entitlement still receives signed assertion under normal limits.

Validation
----------

In staging:

* send a controlled burst from one client source;
* confirm rate-limit response code and body;
* confirm normal traffic resumes after limiter window;
* confirm logs include request id and enough redacted context for diagnosis.

Exit criteria
-------------

* Expected low-volume usage is not rate-limited.
* Obvious scripted abuse is throttled before excessive D1/signing cost.

Gate 9: documentation and claims review
=======================================

Purpose
-------

Ensure users understand what the system does and does not protect.

Implementation checklist
------------------------

* Security model says local enforcement is tamper-resistant, not tamper-proof.
* Online verification docs describe fail-closed behavior when configured.
* Docs explain that ``acquire_license()`` remains compatibility mode and
  ``acquire_license_ex()`` is the hardened integration path.
* Docs explain that online signing key and offline project key are separate.
* Docs explain cache TTL and revocation latency.
* Docs explain process-local revocation floor and host persistence option.
* Docs include Cloudflare setup, Access setup, D1 migration, backup/restore, key
  rotation, and sync endpoint guidance.
* README avoids claims such as "prevents cracking".

Verification
------------

Run:

.. code-block:: console

   uv run --no-project python scripts/check_docs_links.py doc
   uv run --no-project python scripts/build_docs.py
   rg -n "prevents cracking|tamper-proof|uncrackable|impossible to bypass" README.md doc services

Validation
----------

* Any risky phrase is removed or rewritten with accurate scope.
* Security docs list residual risks plainly.
* Operator docs include exact commands but not real secrets.

Exit criteria
-------------

* Strict docs build passes.
* Public docs match implementation behavior.
* Residual risks are visible and concrete.

Gate 10: final review and release decision
==========================================

Purpose
-------

Make the final production decision evidence-based.

Implementation checklist
------------------------

* Run one security/data-integrity review for Workers, D1, Access, and backups.
* Run one C++ API/ABI/protocol review.
* Run one admin UI/DX/docs review.
* Resolve all Critical and High findings.
* Resolve Medium findings that affect customer state, signing keys, admin auth,
  data recovery, or release claims.
* Record accepted residual risk for any deferred Low finding.

Verification
------------

Each review report must include:

* findings ordered by severity;
* file and line references;
* missing tests;
* staging evidence reviewed;
* explicit blockers or explicit sign-off.

Final release-blocking checklist:

* Public verifier has no admin mutation routes.
* Admin Worker has no online signing private key.
* Online signing key is distinct from the offline project key.
* Admin auth validates Cloudflare Access JWT or equivalent cryptographically.
* Dev bearer cannot run in production.
* Admin mutations fail closed without D1 ``batch()``.
* Entitlement write, audit event, and idempotency record are atomic for
  state-changing mutations.
* Revoked entitlements are terminal across admin API, sync API, and CLI.
* Denied verifier responses are unsigned by default.
* Rate limiting is configured for expected low-volume abuse cases.
* Worker-signed staging assertion verifies in C++.
* ``revocation_seq`` rollback is rejected.
* Validity windows are enforced.
* Backup export and restore drill passed.
* Staging Cloudflare Access E2E passed.
* Documentation avoids overclaims and describes residual risks.

Validation
----------

Assemble a final evidence packet with:

* local command outputs;
* CI run links;
* staging deployment ids or Worker versions;
* D1 migration list;
* staging E2E transcript;
* backup object id and restore drill notes;
* screenshots for admin workflows;
* active online public key id and retired key ids, if any;
* final review reports;
* known residual risks and owners.

Exit criteria
-------------

* No release-blocking checklist item is false.
* Remaining risks are documented and accepted by the project owner.
* Production rollout starts in audit/observe mode where applicable, then moves
  to enforcement only after false-positive testing.

Current local evidence snapshot
===============================

The following local gates were run successfully on June 6, 2026 in the Windows
development workspace:

* admin Worker tests, lint, explicit admin UI build, dry-run, and local
  migration;
* online verifier tests, e2e test, lint, schema parity, dry-run, and local
  migration;
* D1 backup Worker tests, lint, build, and Wrangler dry-run;
* D1 backup restore drill wrapper help and unit tests;
* Access admin validator and Access admin drill wrapper help and unit tests;
* workspace hygiene checker tests and local scan covering tracked and untracked
  release-candidate text files;
* secret hygiene scanner tests and local scan;
* release readiness assertion tool tests;
* external gate preflight tests;
* release gate contract tests for required result labels, required local command
  evidence, summary keys, external input keys, and redacted external drill
  command templates;
* release gates workflow coverage tests;
* ``Release_Gates`` CI workflow added for release tooling tests, local secret
  hygiene scan, ignored-path checks on ``.gitignore`` changes, and a negative
  readiness assertion without production secrets; the negative assertion now
  proves local command-contract validation is active, not only that incomplete
  evidence fails for unrelated reasons;
* top-level
  ``node scripts/validate_release_gates.mjs --full --external --json-out build/release-gates/full-latest.json``
  runner: local gates passed with ``ok=true``, ``complete=false``, and
  ``production_ready=false`` because the credential-dependent staging drills
  were skipped; this run included the release readiness assertion tests,
  release-gate command-contract checks, explicit admin UI build, local e2e,
  Worker dry-runs, focused C++ public API, anti-tamper, online verification,
  label-audit tests, and the full Debug CTest suite;
* ``node scripts/assert_release_ready.mjs build/release-gates/full-latest.json``
  returned exit code ``1`` against that refreshed full evidence, proving the
  full local run cannot be mistaken for production sign-off while external
  staging validation is absent;
* strict missing-external smoke run
  ``node scripts/validate_release_gates.mjs --quick --require-external --json-out build/release-gates/strict-missing-external.json``
  returned exit code ``1`` before local checks, with ``production_ready=false``
  and ``blocking_reasons`` listing secret-redacted ``external_input_missing``
  blockers for the missing external staging variables; this proves
  production strict mode fails closed before a long local run when required
  external validation inputs are missing;
* refreshed quick release-gate run
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-latest.json``
  returned exit code ``0`` with workspace hygiene, release tooling, admin
  Worker, online verifier, D1 backup, docs, and focused C++ security/API gates
  passing; it recorded ``complete=false`` and ``production_ready=false``
  because external staging drills were skipped;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-latest.json``
  was run as an expected-negative check and rejected the partial quick evidence
  for production readiness;
* refreshed chunked quick release-gate run
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-chunked-latest.json``
  returned exit code ``0`` through the parallel-chunk execution path. It ran
  independent hygiene checks, release tooling tests, package test suites,
  lint/schema/help jobs, docs, and focused C++ security/API tests in grouped
  phases while preserving stable result labels and command evidence. It
  recorded ``complete=false`` and ``production_ready=false`` because
  credential-dependent external drills were skipped;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-chunked-latest.json``
  was run as an expected-negative check and rejected the partial quick evidence
  for production readiness;
* quick release-gate run with the R2 restore inputs present
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-r2-restore-latest.json``
  returned exit code ``0`` with ``ok=true``, ``complete=false``,
  ``production_ready=false``, ``skipped=1``,
  ``external_inputs_present.r2_restore=true``, and
  ``external_inputs_present.access_admin=false``; the Cloudflare R2 restore
  drill ran with status ``0`` and the Access drill was the only skipped
  external result;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-r2-restore-latest.json``
  was run as an expected-negative check and rejected the partial quick evidence
  because the Access drill, full-mode dry-runs, full CTest result, and strict
  production flags were still absent;
* refreshed quick release-gate run with R2 restore inputs and
  ``LICENSECC_RESTORE_REQUIRE_STATUSES=revoked``
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-r2-semantic-latest.json``
  returned exit code ``0`` with ``ok=true``, ``complete=false``,
  ``production_ready=false``, ``skipped=1``, and the R2 restore drill command
  evidence redacted while preserving the explicit
  ``--require-restored-status revoked`` check;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-r2-semantic-latest.json``
  was run as an expected-negative check and rejected the partial quick evidence
  because it is not a strict full production run and the Access drill is still
  skipped;
* refreshed chunked quick release-gate run with R2 restore inputs and
  ``LICENSECC_RESTORE_REQUIRE_STATUSES=active,revoked``
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-r2-active-latest.json``
  returned exit code ``0`` with ``ok=true``, ``complete=false``,
  ``production_ready=false``, ``skipped=1``, and
  ``external_inputs_present.r2_restore=true``. The R2 restore drill command
  evidence stayed redacted while preserving the explicit
  ``--require-restored-status active`` and
  ``--require-restored-status revoked`` checks;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-r2-active-latest.json``
  was run as an expected-negative check and rejected the partial quick evidence
  because it is not a strict full production run and the Access drill is still
  skipped;
* external preflight with the staging admin URL and R2 restore inputs present
  returned ``ready=false`` with
  ``LICENSECC_ACCESS_JWT or LICENSECC_ACCESS_USE_CLOUDFLARED`` as the only
  missing credential alternative; this confirms the remaining Access
  release-gate blocker is a user-scoped Access application token, not the admin
  URL or R2 restore inputs;
* backup Worker package tests were rerun after the scheduled-trigger helper was
  added:
  ``npm --prefix services/cloudflare-d1-backup test`` passed 31/31, including
  the scheduled helper test that creates a bounded Workflow instance id, the
  scheduled reason payload, and the deployment validator parser/secret-presence
  coverage;
* backup Worker dry-run was rerun with the Worker-cron-plus-Workflow config:
  ``npm --prefix services/cloudflare-d1-backup run dry-run`` exited ``0`` under
  Wrangler 4.98.0 and reported the Workflow binding, R2 bucket binding, and
  expected non-secret environment variables;
* focused release tooling tests were rerun:
  ``node --test scripts/release_gate_contract.test.mjs scripts/external_gate_preflight.test.mjs scripts/assert_release_ready.test.mjs scripts/validate_release_gates.test.mjs scripts/release_gates_workflow.test.mjs``
  passed 71/71, including the grouped concurrent chunk tests, restored status
  requirement evidence parsing, backup deployment and public verifier abuse
  external-gate contract/redaction checks, and CI workflow coverage for the
  backup deploy validator plus public verifier drill files;
* focused CI workflow and backup deploy validator tests
  ``node --test scripts/release_gates_workflow.test.mjs services/cloudflare-d1-backup/test/backup-validate-deploy.test.mjs``
  passed 11/11. The release-gates workflow now triggers on
  ``services/cloudflare-d1-backup/scripts/validate-deploy.mjs``,
  ``services/cloudflare-d1-backup/test/backup-validate-deploy.test.mjs``, and
  ``services/cloudflare-d1-backup/package.json``, and its synthetic incomplete
  evidence includes ``external_inputs_present.backup_deploy=false``;
* backup deploy validator was added at
  ``services/cloudflare-d1-backup/scripts/validate-deploy.mjs``. The live
  staging command
  ``npm --prefix services/cloudflare-d1-backup run validate:deploy -- --url https://licensecc-d1-backup-test.splattingworks.workers.dev --worker-name licensecc-d1-backup-test --workflow-name licensecc-d1-backup-test --json``
  exited ``0`` and reported ``backup_ready``, unauthenticated
  ``backup_trigger_not_configured``, secret-name presence
  ``D1_REST_API_TOKEN=false`` and ``BACKUP_TRIGGER_TOKEN=false``, and Workflow
  describe status ``0`` without printing secret values;
* the strict backup deploy validator command
  ``node services/cloudflare-d1-backup/scripts/validate-deploy.mjs --url https://licensecc-d1-backup-test.splattingworks.workers.dev --worker-name licensecc-d1-backup-test --workflow-name licensecc-d1-backup-test --require-d1-rest-token --json``
  exited ``1`` with the single blocker
  ``D1_REST_API_TOKEN secret is required but not configured``, proving the
  production backup-export readiness check fails closed until that secret is
  present;
* top-level quick release-gate run
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-three-external-latest.json``
  exited ``0`` with ``ok=true``, ``complete=false``,
  ``production_ready=false``, ``skipped=3``, and
  ``external_inputs_present.backup_deploy=false``. It now records three
  external drill rows: Access admin, R2 restore, and backup deployment;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-three-external-latest.json``
  was run as an expected-negative check and rejected the partial quick evidence
  because it is not a full strict run and all three external drills were
  skipped;
* top-level quick release-gate run with only backup deployment staging
  identifiers present
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-backup-deploy-strict-latest.json``
  exited ``1`` after running the redacted backup deployment drill. The summary
  recorded ``external_inputs_present.backup_deploy=true`` and the backup
  deployment drill result failed with status ``1`` because the deployed Worker
  has ``D1_REST_API_TOKEN=false``. This proves the top-level runner now fails
  closed on missing backup export credentials, not only the standalone
  validator;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-backup-deploy-strict-latest.json``
  was run as an expected-negative check and rejected the failed backup
  deployment evidence for production readiness;
* admin UI workflow coverage was rerun after adding entitlement edit/patch
  controls:
  ``npm --prefix services/cloudflare-license-admin run test:ui`` passed 5/5,
  including filtered API paths, create payload normalization, edit patch
  payload normalization, lifecycle action rules, patch paths, and short
  fingerprint rendering;
* admin UI browser e2e was added and run:
  ``npm --prefix services/cloudflare-license-admin run test:e2e`` passed 1/1.
  The Playwright test starts a local Vite preview with mocked admin API
  responses, creates an entitlement, verifies duplicate create submissions are
  guarded, patches metadata/validity/assertion TTL, disables, reenables,
  revokes, confirms revoked edit/reenable controls are disabled, checks the
  audit timeline, and scans visible UI text for secret/token markers;
* admin Worker and Access local tests were rerun after allowing empty notes and
  adding UI patch coverage:
  ``npm --prefix services/cloudflare-license-admin test`` passed 34/34,
  including Access admin mutation, reader denial, malformed/unknown JWT
  rejection, sync rules, idempotency, D1 batch rollback, revoked-terminal, and
  patch/transition sequence behavior, plus explicit empty-note UI payloads;
* admin lint was rerun:
  ``npm --prefix services/cloudflare-license-admin run lint`` exited ``0`` with
  ``lint ok``;
* the grouped quick local release gate was rerun after admin UI patch support:
  ``node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local-ui-patch-latest.json``
  exited ``0`` with ``ok=true``, ``complete=true``, ``production_ready=false``,
  ``skipped=0``, and empty ``blocking_reasons``. The quick run exercised the
  conservative concurrent local gate chunks and wrote the evidence file under
  ``build/release-gates``;
* the full local release gate was rerun after adding admin UI browser e2e:
  ``node scripts/validate_release_gates.mjs --full --json-out build/release-gates/full-local-admin-ui-e2e-latest.json``
  exited ``0`` with ``ok=true``, ``complete=true``,
  ``production_ready=false``, ``skipped=0``, and empty
  ``blocking_reasons``. It included ``admin UI browser e2e`` with status ``0``,
  all Worker dry-runs, the online verifier/admin local e2e, focused C++
  security/API tests, and the full CTest suite 35/35;
* ``node scripts/assert_release_ready.mjs build/release-gates/full-local-admin-ui-e2e-latest.json``
  was run as an expected-negative check and rejected the local-only full
  evidence because ``external=true``, ``require_external=true``, the required
  external input presence flags, and all external drill result rows were
  missing;
* public verifier abuse drill tests were added and rerun:
  ``npm --prefix services/cloudflare-licensing-backend test`` passed 28/28,
  including malformed-request rejection, unsigned unknown-entitlement denial,
  npm config/equals-form argument parsing, rate-limit/recovery drill behavior,
  and failure when an expected limiter is not observed;
* public verifier npm wrapper smoke
  ``npm --prefix services/cloudflare-licensing-backend run validate:public-verifier --url=https://licensecc-online-verifier-test.splattingworks.workers.dev --burst-count=1 --json``
  exited ``0`` with redacted target evidence, proving the documented npm
  invocation path works on the current Windows shell;
* live public verifier smoke drill
  ``node services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs --url https://licensecc-online-verifier-test.splattingworks.workers.dev --burst-count 1 --json``
  exited ``0`` with redacted target evidence. It reported
  ``malformed.status=400`` with ``code=invalid_request``, unsigned
  ``unknown_denial.status=200`` with ``code=entitlement_denied``, and no
  failures;
* live public verifier abuse drill
  ``node services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs --url https://licensecc-online-verifier-test.splattingworks.workers.dev --expect-rate-limit --json``
  exited ``0`` with redacted target evidence. The bounded burst made 25
  attempts, observed six ``429`` responses, first hit the limiter at attempt
  20, and recovered after the wait with unsigned ``entitlement_denied``;
* the public verifier abuse drill was also exercised through the top-level
  quick external release-gate runner:
  ``node scripts/validate_release_gates.mjs --quick --external --json-out build/release-gates/quick-public-verifier-external-latest.json``
  with ``LICENSECC_VERIFIER_URL`` set to the staging verifier URL. The runner
  exited ``0`` with ``ok=true``, ``complete=false``,
  ``production_ready=false``, ``skipped=3``, and
  ``external_inputs_present.public_verifier_abuse=true``. It recorded the
  ``Cloudflare public verifier abuse staging drill`` row with status ``0``,
  redacted command evidence, 25 attempts, six ``429`` responses, first limiter
  hit at attempt 20, and successful recovery;
* ``node scripts/assert_release_ready.mjs build/release-gates/quick-public-verifier-external-latest.json``
  was run as an expected-negative check. It rejected the partial quick
  evidence because full strict production evidence and the Access, R2 restore,
  and backup deployment external rows are still missing; it did not reject the
  public verifier abuse row;
* release readiness assertion was hardened so production evidence also requires
  ``external_inputs_present.public_verifier_abuse=true`` instead of relying
  only on the public verifier result row. The regression test confirms a
  passing public verifier row with a false input flag is rejected, and skipped
  external rows no longer produce duplicate missing-row diagnostics;
* focused release tooling tests were rerun after that assertion hardening:
  ``node --test scripts/release_gate_contract.test.mjs scripts/external_gate_preflight.test.mjs scripts/validate_release_gates.test.mjs scripts/assert_release_ready.test.mjs scripts/release_gates_workflow.test.mjs``
  passed 72/72;
* the full local grouped release gate was rerun after adding the public
  verifier abuse gate contract:
  ``node scripts/validate_release_gates.mjs --full --json-out build/release-gates/full-local-public-verifier-latest.json``
  exited ``0`` with ``ok=true``, ``complete=true``,
  ``production_ready=false``, ``skipped=0``, and empty
  ``blocking_reasons``. It included full CTest 35/35, admin UI browser e2e,
  all Worker dry-runs, docs, hygiene, release tooling, and local Worker tests;
* ``node scripts/assert_release_ready.mjs build/release-gates/full-local-public-verifier-latest.json``
  was run as an expected-negative check and rejected the local-only evidence,
  including the missing ``Cloudflare public verifier abuse staging drill``
  external row;
* strict documentation link check and Sphinx build through ``uv``;
* targeted C++ public API, anti-tamper, online verification, and CTest label
  audit tests;
* full Debug CTest suite, 35/35 tests passed during the full release-gate run.

This snapshot is useful local evidence. It now includes real R2 restore drills
through the top-level release-gate runner with restored active-acceptance and
revoked-denial semantic checks, but it does not replace a real Cloudflare
Access JWT admin mutation test or real backup-service export evidence.

Current Cloudflare test evidence snapshot
=========================================

The following real Cloudflare test gates were run successfully on June 5-6,
2026 against ``licensecc-online-verifier-test`` and ``licensecc-admin-test`` in
the Splattingworks account:

* verifier Worker deployed to
  ``https://licensecc-online-verifier-test.splattingworks.workers.dev``;
* remote D1 migration list includes
  ``0006_allow_sync_actor_type.sql``;
* verifier ``/health`` returned healthy;
* malformed verifier request returned ``invalid_request``;
* unknown entitlement returned unsigned ``entitlement_denied``;
* active scratch entitlement returned a signed ``lccoa1`` assertion;
* revoked scratch entitlement returned ``entitlement_denied``;
* admin test Worker deployed to
  ``https://licensecc-admin-test.splattingworks.workers.dev`` with dev bearer
  disabled;
* before staging Access routing was configured, unauthenticated admin summary
  returned ``admin_auth_not_configured``;
* a Cloudflare Access application was created for the admin Worker's
  ``workers.dev`` route with an exact-email allow policy, and the admin Worker
  was redeployed with the Access issuer, audience, and admin email allowlist;
* unauthenticated admin API and UI requests now return a Cloudflare Access
  redirect before reaching the Worker, proving the ``workers.dev`` route is
  protected by Access;
* ``cloudflared access token --app <admin-url>`` did not return a token because
  no local Access login token was cached; ``cloudflared access login`` must be
  completed by an allowlisted user before the real Access mutation drill can
  run;
* ``access-admin-drill.mjs --use-cloudflared --login`` was attempted against
  the staging admin URL on June 6, 2026 and timed out without a cached token;
  a follow-up ``--use-cloudflared`` run failed closed with the documented
  instruction to run ``cloudflared access login``;
* sync endpoint created a scratch entitlement through real D1;
* duplicate sync idempotency key replayed the original response without
  advancing ``revocation_seq``;
* sync revoke advanced ``revocation_seq`` and wrote a ``sync`` audit event;
* sync reactivation after revoke returned
  ``revoked_entitlement_is_terminal``;
* remote D1 inspection confirmed scratch rows ended in ``revoked`` state,
  audit events used ``actor_type='sync'`` and ``source='sync'``, and
  idempotency replay rows were present.
* ``validate:remote-d1-atomicity`` deployed a temporary Worker, forced a D1
  ``batch()`` failure with an invalid audit event, returned
  ``d1_batch_atomic``, reported zero entitlement/event rows before cleanup, and
  deleted the temporary Worker.
* ``validate:remote-cpp`` deployed a temporary verifier Worker
  (``licensecc-online-cpp-f3ffb08e``), generated a dedicated temporary online
  signing key, obtained a real ``lccoa1`` assertion for a scratch active
  entitlement, verified that assertion with C++ ``test_online_verification``,
  revoked the scratch entitlement, confirmed the scratch row ended in
  ``revoked`` state, and deleted the temporary Worker.
* A remote D1 SQL export was produced from the staging verifier D1 database,
  uploaded to a scratch R2 bucket, and restored into an empty scratch D1
  database with ``restore-drill.mjs --remote``. The drill returned
  ``ok=true`` with matching row counts for the required entitlement tables:
  ``entitlements=7``, ``entitlement_events=21``, and
  ``mutation_idempotency=5``.
* The restore drill was rerun with
  ``--require-restored-status revoked`` against scratch D1
  ``licensecc-restore-semantic-drill-20260606``. It returned ``ok=true``,
  matching source/restored counts, ``status_counts.revoked=7``,
  ``verifier_candidates.revoked_deny=7``,
  ``verifier_candidates.active_accept=0``, and no semantic mismatches. The
  active count is zero because the current staging source/backup contains only
  revoked rows.
* A staging-only active fixture was created with the break-glass entitlement
  CLI using actor ``restore-drill-fixture`` and fingerprint
  ``418362f47e208899bcd74319b6abff22b0957f62983dd693d56c24866ce9cbc8``.
  Source D1 then reported ``active=1`` and ``revoked=7``. The public verifier
  returned ``entitlement_ok`` with an ``lccoa1`` assertion for that fixture.
* A fresh manual D1 SQL export including the active fixture was written to
  ``build/release-gates/licensecc-online-verifier-test-active-20260606.sql``
  and uploaded to remote R2 object
  ``d1/licensecc-online-verifier-test/restore-drill-active-20260606.sql`` in
  scratch bucket ``licensecc-restore-drill-20260606``.
* The active export was restored into scratch D1
  ``licensecc-restore-active-gate-20260606`` with
  ``--require-restored-status active`` and
  ``--require-restored-status revoked``. It returned ``ok=true``, matching
  source/restored counts (``entitlements=8``, ``entitlement_events=22``,
  ``mutation_idempotency=5``), ``status_counts.active=1``,
  ``status_counts.revoked=7``, ``verifier_candidates.active_accept=1``,
  ``verifier_candidates.revoked_deny=7``, and no semantic mismatches.
* The same R2 restore evidence was exercised through the top-level quick
  release-gate runner, including the explicit
  ``--require-restored-status revoked`` check against scratch D1
  ``licensecc-restore-semantic-gate-20260606``. The runner recorded the R2
  restore drill with status ``0``, kept the external command evidence
  redacted, and still recorded ``complete=false`` and
  ``production_ready=false`` because the real Access JWT admin mutation drill
  was skipped.
* The active+revoked R2 restore evidence was also exercised through the
  top-level chunked quick release-gate runner against scratch D1
  ``licensecc-restore-active-runner-20260606``. The runner recorded the R2
  restore drill with status ``0``, kept the external command evidence
  redacted, preserved both required-status flags, and still recorded
  ``complete=false`` and ``production_ready=false`` because the real Access JWT
  admin mutation drill was skipped.
* One earlier R2 release-gate attempt correctly refused to restore into a
  non-empty scratch database, which confirms the restore wrapper fails closed
  unless an operator explicitly opts into a non-empty scratch target.
* Cloudflare rejected direct Workflow scheduling for this account during
  validation with ``cron_requires_paid_plan``, so the backup service now uses
  the default Worker cron trigger path and lets the scheduled handler create a
  Workflow instance.
* Backup Worker ``licensecc-d1-backup-test`` was deployed to
  ``https://licensecc-d1-backup-test.splattingworks.workers.dev`` with current
  version ``246282ec-6aa6-4b7f-988d-814df340f39b``. Wrangler reported the
  deployed schedule ``0 3 * * *`` and Workflow
  ``licensecc-d1-backup-test``.
* Backup Worker ``/health`` returned HTTP 200 with ``backup_ready`` for
  ``licensecc-online-verifier-test`` and prefix
  ``d1/licensecc-online-verifier-test``.
* Backup Worker ``POST /backup/run`` without a configured trigger token
  returned HTTP 401 with ``backup_trigger_not_configured``, proving the manual
  trigger fails closed until ``BACKUP_TRIGGER_TOKEN`` is set.
* Workflow ``licensecc-d1-backup-test`` describes successfully with latest
  version ``860b0cca-b1d1-4049-b7a6-8963f63047c0``. A manual Workflow trigger
  queued instance ``e7d444ac-0470-44e4-8b21-ff05a4786ca2`` and the instance
  errored immediately with ``D1_REST_API_TOKEN_required``, proving the deployed
  export path fails closed until the D1 REST export token is configured.
* Public verifier abuse drill
  ``node services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs --url https://licensecc-online-verifier-test.splattingworks.workers.dev --expect-rate-limit --json``
  exited ``0`` on June 6, 2026. Output redacted the target URL, rejected a
  malformed fingerprint with ``400 invalid_request``, returned unsigned
  ``entitlement_denied`` for an unknown entitlement, observed rate limiting in
  the bounded burst, and recovered to unsigned denial after the limiter window.

The backup restore drill is executable through
``node services/cloudflare-d1-backup/scripts/restore-drill.mjs`` and the Access
admin mutation drill is executable through
``node services/cloudflare-license-admin/scripts/access-admin-drill.mjs``.
Both are covered by local tests. The public verifier abuse drill is executable
through
``node services/cloudflare-licensing-backend/scripts/public-verifier-drill.mjs``.
This snapshot now includes real R2 restore evidence with restored
active-acceptance and revoked-denial semantics, a deployed backup
Worker/cron/Workflow fail-closed validation, and a live public verifier
rate-limit/recovery drill, but it still does not replace a real Cloudflare
Access JWT admin mutation test or final backup-service export evidence. The
remaining Access
release-gate input is either a user-scoped ``LICENSECC_ACCESS_JWT`` or a cached
``cloudflared`` application token enabled with
``LICENSECC_ACCESS_USE_CLOUDFLARED=1`` for the configured staging admin URL.
Generating a fresh backup through the backup service still requires the backup
service credentials. ``D1_REST_API_TOKEN`` is required for the Workflow export;
``BACKUP_TRIGGER_TOKEN`` is additionally required for authenticated manual
``/backup/run`` and ``/backup/status/:id`` endpoints. The top-level backup
deployment gate also requires ``LICENSECC_BACKUP_URL`` and
``LICENSECC_BACKUP_WORKER_NAME``; ``LICENSECC_BACKUP_WORKFLOW_NAME`` is
optional when it matches the Worker name.

The catalog projection staging gate additionally requires the staging admin
URL/token pair plus ``LICENSECC_CATALOG_PLAN_ID``,
``LICENSECC_CATALOG_LICENSE_ID``, and
``LICENSECC_CATALOG_LICENSE_FINGERPRINT``. Optional catalog inputs include
``LICENSECC_CATALOG_PLAN_KEY``, ``LICENSECC_CATALOG_PROJECT``,
``LICENSECC_CATALOG_CUSTOMER_ID``, ``LICENSECC_CATALOG_SUPPORT_UNTIL``,
``LICENSECC_CATALOG_ADDONS``,
``LICENSECC_CATALOG_IMPORT_MANIFEST_JSON``, and
``LICENSECC_CATALOG_ALLOW_MUTATION``.

The customer portal staging gate requires ``LICENSECC_PORTAL_URL``,
``LICENSECC_PORTAL_EMAIL``, and
``LICENSECC_PORTAL_BOOTSTRAP_BEARER``. Optional portal inputs include
``LICENSECC_PORTAL_ACCESS_JWT`` when bootstrap is Access-gated, plus
``LICENSECC_PORTAL_ALLOW_SEAT_MUTATION``,
``LICENSECC_PORTAL_FLOATING_ENTITLEMENT_ID``,
``LICENSECC_PORTAL_ALLOW_DOWNLOAD``,
``LICENSECC_PORTAL_DOWNLOAD_ENTITLEMENT_ID``, and
``LICENSECC_PORTAL_DEVICE_KEY_ID``. The standalone portal drill also supports
manual session-cookie or OTP-code auth through its ``STAGING_PORTAL_*`` aliases
for operator-run checks.
