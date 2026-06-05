License admin Vite React execution checklist
############################################

This checklist turns the Vite + React admin design into an executable delivery
plan. It is intentionally gate-oriented: each phase defines implementation
tasks, validation, test coverage, end-to-end evidence, documentation updates,
and review requirements.

The plan assumes the current baseline:

* The public Cloudflare verifier Worker exists under
  ``services/cloudflare-online-verifier``.
* The C++ online verifier, anti-tamper flow, ``acquire_license_ex()``, and
  ``examples/online_callback`` exist.
* The public verifier currently has several review findings that must be closed
  before an admin UI is treated as production-ready.
* The admin console will use Vite + React + TypeScript and Cloudflare Workers
  Static Assets.

Cloudflare references used for this plan:

* Workers best practices:
  ``https://developers.cloudflare.com/workers/best-practices/workers-best-practices/``
* Workers Static Assets:
  ``https://developers.cloudflare.com/workers/static-assets/``
* Wrangler environments:
  ``https://developers.cloudflare.com/workers/wrangler/environments/``
* D1:
  ``https://developers.cloudflare.com/d1/``

Non-negotiable principles
=========================

* Keep the public verifier small: ``GET /health`` and ``POST /v1/verify`` only.
* Keep admin mutations out of the public verifier Worker.
* Keep the online signing private key out of the admin Worker.
* Treat all admin inputs as untrusted.
* Use D1 prepared statements for Worker write paths.
* Make ``revocation_seq`` server-owned and monotonic.
* Do not claim instant revocation while cached assertions are allowed.
* Preserve existing public C ABI unless an explicitly versioned ABI extension is
  added and pinned by tests.
* Do not build the React UI before the admin API/auth/write-kernel gates pass.

Phase 0: review baseline and freeze current behavior
====================================================

Purpose
-------

Establish a reproducible baseline before modifying verifier, schema, CI, or
admin flows.

Implementation tasks
--------------------

* Record current git status.
* Record current live Worker URL, D1 database names, and key ids in private
  implementation notes, not in public docs if sensitive.
* Confirm generated validation artifacts are not present:

  * ``services/cloudflare-online-verifier/node_modules``;
  * ``services/cloudflare-online-verifier/.wrangler``;
  * ``services/cloudflare-online-verifier/dist``;
  * local online private-key directories.

* Confirm existing public APIs remain unchanged:

  * ``acquire_license()`` compatibility behavior;
  * ``acquire_license_ex()`` behavior;
  * ``LicenseCheckOptions`` size/version behavior;
  * public enum values.

Verification commands
---------------------

.. code-block:: console

   ctest --test-dir build -C Debug --output-on-failure --timeout 900
   python scripts/check_docs_links.py

For the Worker:

.. code-block:: console

   cd services/cloudflare-online-verifier
   npm ci
   npm test
   npm run lint
   npm run dry-run
   npm run migrate:local

Cleanup after local Worker validation:

.. code-block:: powershell

   Remove-Item -LiteralPath services/cloudflare-online-verifier/node_modules -Recurse -Force
   Remove-Item -LiteralPath services/cloudflare-online-verifier/.wrangler -Recurse -Force
   Remove-Item -LiteralPath services/cloudflare-online-verifier/dist -Recurse -Force

Exit criteria
-------------

* Full CTest passes.
* Worker tests, lint, dry-run, and local migrations pass.
* Docs link check passes.
* No generated Worker artifacts or private keys remain in the source tree.
* Existing behavior is documented before changes begin.

Phase 1: Cloudflare service CI and hygiene
==========================================

Purpose
-------

Make Worker regressions visible before changing verifier security behavior or
adding admin code.

Implementation tasks
--------------------

* Add a GitHub Actions workflow for ``services/cloudflare-online-verifier``.
* Trigger on:

  * changes under ``services/cloudflare-online-verifier/**``;
  * changes under ``.github/workflows/**``;
  * changes to docs/checklists that describe service behavior.

* Workflow steps:

  * checkout;
  * setup Node;
  * ``npm ci``;
  * ``npm run lint``;
  * ``npm test``;
  * ``npm run dry-run``;
  * ``npm run migrate:local``;
  * scan for private key markers and obvious Cloudflare/API-token patterns;
  * verify no build output is accidentally committed.

* Extend ``scripts/lint.mjs`` or add a service lint script for:

  * private key PEM markers;
  * bearer/admin secrets;
  * ``CLOUDFLARE_API_TOKEN`` literals;
  * accidental ``.dev.vars`` content;
  * generated ``dist`` output.

* Add CI summary output that prints:

  * Worker bundle size from dry-run;
  * migrations applied;
  * test count.

Validation
----------

* Break the Worker test intentionally in a throwaway branch and confirm CI
  fails.
* Break a migration in a throwaway branch and confirm CI fails.
* Add a fake private key marker in a throwaway branch and confirm CI fails.

Exit criteria
-------------

* Cloudflare service CI is required before merge.
* Service CI validates build, tests, dry-run deploy, local D1 migrations, and
  secret scans.
* No production Cloudflare token is needed for pull-request validation.

Phase 2: protocol contract and cross-language fixture
=====================================================

Purpose
-------

Prevent TypeScript Worker and C++ verifier canonicalization drift.

Implementation tasks
--------------------

* Add a normative protocol spec document:

  * envelope prefix;
  * base64 encoding;
  * canonical payload field names;
  * exact field order;
  * integer formatting;
  * line endings;
  * purpose string;
  * version string;
  * key id semantics;
  * algorithm;
  * nonce semantics;
  * assertion expiry versus cache expiry.

* Add fixture generation:

  * fixed online assertion test key;
  * fixed request claims;
  * Worker-generated payload and assertion;
  * C++ expected payload bytes.

* Add Worker tests that assert:

  * canonical payload byte-for-byte equals fixture;
  * generated assertion envelope has expected prefix and three parts;
  * payload mutation invalidates signature if verification helper exists in
    Worker tests.

* Add C++ tests that assert:

  * Worker-generated assertion verifies;
  * Worker-generated assertion fails if payload changes;
  * Worker-generated assertion fails if signature changes;
  * wrong key id fails;
  * unsupported algorithm fails;
  * field reordering fails.

Validation
----------

.. code-block:: console

   cd services/cloudflare-online-verifier
   npm test

.. code-block:: console

   ctest --test-dir build -C Debug -R "test_online_verification" --output-on-failure

Exit criteria
-------------

* Worker-signed golden assertion verifies in C++.
* C++ canonical payload tests are byte-exact.
* Any canonical field order change breaks tests.
* Protocol spec is linked from online verification docs.

Phase 3: verifier hardening
===========================

Purpose
-------

Close the concrete verifier issues found during review before the admin UI
drives more usage.

Implementation tasks
--------------------

Rate limiting
~~~~~~~~~~~~~

* Add a rate-limit plan with at least three tiers:

  * client-network tier, based on Cloudflare-provided client IP or an
    intentionally chosen fallback;
  * entitlement tier, based on ``project:feature:license_fingerprint``;
  * global signing tier, if feasible for low-volume production.

* Ensure a rotating fingerprint flood from one client cannot bypass all limits.
* Ensure a single abusive fingerprint does not block unrelated fingerprints.
* Log only redacted IP/fingerprint data.

Denied responses
~~~~~~~~~~~~~~~~

* Change default unknown/denied entitlement behavior to unsigned generic JSON:

  .. code-block:: json

     { "ok": false, "code": "entitlement_denied" }

* If signed denials remain supported, place them behind explicit config:

  * disabled by default;
  * short negative TTL;
  * separately rate-limited;
  * documented as optional.

Validity windows
~~~~~~~~~~~~~~~~

* Add verifier support for ``valid_from`` and ``valid_until`` after schema
  migration lands.
* Treat ``NULL`` as unbounded.
* Deny when ``now < valid_from``.
* Deny when ``now >= valid_until``.
* Clamp ``expires_at`` to ``valid_until`` and set ``cache_until`` equal to
  ``expires_at`` for wire compatibility.

Worker tests
------------

Add tests for:

* rotating fingerprints from one IP trigger client-network limit;
* entitlement limit does not block different fingerprints;
* D1 limiter failure behavior is explicit;
* unknown entitlement does not sign by default;
* revoked entitlement returns generic denial;
* device mismatch returns generic denial;
* active entitlement still signs ``status=ok``;
* expired validity window denies;
* not-yet-valid window denies;
* ``valid_until`` clamps ``expires_at``; ``cache_until`` mirrors
  ``expires_at``.

Live smoke
----------

Against staging:

* seed active entitlement;
* verify ``ok`` assertion;
* request unknown entitlement and verify unsigned generic denial;
* flood rotating fingerprints and confirm client-network limit;
* clean test rows and counters.

Exit criteria
-------------

* No ordinary denied response performs RSA signing by default.
* Rotating-fingerprint abuse is rate-limited.
* Validity windows are enforced when present.
* Existing valid entitlement flow still passes C++ verification.

Phase 4: D1 schema and shared write kernel
==========================================

Purpose
-------

Extend the database safely and make all entitlement mutations consistent.

Migration tasks
---------------

Add forward-only migrations:

``0003_customers_licenses.sql``
  Create ``customers`` and ``licenses``. Keep relationships loose enough that
  existing entitlements continue to work.

``0004_entitlement_validity_notes.sql``
  Add nullable ``valid_from`` and ``valid_until`` and defaulted ``notes``.

``0005_entitlement_events_actor.sql``
  Add ``actor``, ``actor_type``, ``source``, ``request_id``, ``ip``,
  ``prev_json``, and ``next_json``.

``0006_entitlement_indexes.sql``
  Add indexes needed for admin table filters and event timelines.

If the existing ``event_type`` ``CHECK`` must be widened, perform an explicit
SQLite table-rebuild migration and test it on a populated database.

Write-kernel tasks
------------------

Create a shared TypeScript entitlement module:

* validates project, feature, fingerprint, device hash, TTLs, notes, and
  validity windows;
* uses prepared D1 statements in Worker code;
* computes ``revocation_seq`` server-side;
* writes the entitlement mutation and audit event in the same D1 ``batch()``
  transaction;
* returns a consistent API envelope;
* supports idempotency keys for repeated browser submissions.

Transition rules
----------------

Define and test:

* create missing entitlement;
* patch active entitlement;
* disable active entitlement;
* reenable disabled entitlement;
* revoke active entitlement;
* revoke disabled entitlement;
* whether revoked is terminal. Recommended: revoked is terminal for v1.

CLI tasks
---------

Decide CLI role:

* route normal CLI mutations through admin API; or
* keep D1 CLI as break-glass only.

If break-glass remains:

* stamp ``source='cli'``;
* require ``--actor`` or derive OS user;
* use same validation rules;
* never let ``upsert`` update an existing revoked entitlement unless a future
  explicit override event type is designed and documented;
* document that it bypasses Cloudflare Access.

Testing
-------

* Migration apply on empty DB.
* Migration apply on DB with existing entitlements and events.
* Existing verifier reads migrated schema.
* Prepared-statement write tests for quotes, spaces where allowed, and
  injection-like notes.
* Concurrent mutation tests for monotonic ``revocation_seq``.
* Audit event completeness tests.
* Audit insert failure test that proves the entitlement row is rolled back.
* D1 ``batch()`` unavailable test that proves admin mutations fail closed.

Exit criteria
-------------

* Existing verifier behavior is preserved for rows without validity windows.
* Every mutation increments ``revocation_seq`` exactly once.
* Every mutation writes one audit event with actor/source/request id in the same
  D1 batch as the entitlement write.
* Admin mutations fail closed if the configured D1 binding does not support
  ``batch()``.
* No Worker write path interpolates user values into SQL strings.

Phase 5: C++ revocation cache and decision wrapper
==================================================

Purpose
-------

Make online cache behavior safe and provide a better host integration surface.

Revocation cache tasks
----------------------

* Add internal support for a last-seen revocation floor per:

  * project;
  * feature;
  * license fingerprint.

* Reject assertions with lower ``revocation_seq`` than the floor.
* Advance the floor only after signature and claim validation succeeds.
* Apply the check on fresh and cached assertion paths.
* Keep the core C API unchanged unless a versioned extension is explicitly
  approved.

Decision wrapper tasks
----------------------

Add a C++ convenience layer, for example ``LicenseSession``:

* host configuration:

  * project;
  * feature;
  * license path/source;
  * online endpoint;
  * online policy;
  * tamper policy;
  * cache path;
  * transport callback.

* result model:

  * allowed;
  * state;
  * reason;
  * local result;
  * online result;
  * tamper result;
  * cache status;
  * user-safe message;
  * diagnostic payload.

Suggested states:

* ``Active``;
* ``OfflineGrace``;
* ``NeedsRefresh``;
* ``Expired``;
* ``Revoked``;
* ``Denied``;
* ``TamperSignal``;
* ``NetworkUnavailable``;
* ``MalformedLicense``.

Testing
-------

* Fresh online ``ok`` allows.
* Expired online assertions are rejected.
* Lower ``revocation_seq`` is rejected.
* Higher ``revocation_seq`` advances floor.
* Local license failure masks online result.
* Tamper enforcement denies deterministic tamper signals.
* Tamper enforce denies.
* Network unavailable allows only under configured grace/cache policy.
* Existing public ABI tests are unchanged.

Exit criteria
-------------

* Cached replay with lower ``revocation_seq`` fails.
* Existing ``acquire_license()`` and ``acquire_license_ex()`` compatibility
  behavior remains unchanged.
* The wrapper provides stable product-facing state without exposing raw internals
  by default.

Phase 6: admin Worker auth and read API
=======================================

Purpose
-------

Build the private control-plane boundary before any mutation endpoint ships.

Scaffold
--------

Create ``services/cloudflare-license-admin``:

.. code-block:: text

   package.json
   wrangler.jsonc
   vite.config.ts
   index.html
   src/worker/index.ts
   src/worker/auth.ts
   src/worker/db.ts
   src/worker/routes.ts
   src/shared/api.ts
   src/shared/schemas.ts
   src/ui/main.tsx
   src/ui/App.tsx

Recommended stack:

* Vite + React + TypeScript;
* Workers Static Assets;
* Hono or a small typed router;
* Zod for validation;
* TanStack Query for server state.

Auth tasks
----------

* Put admin Worker behind Cloudflare Access.
* Disable ``workers.dev`` for staging and production admin Worker.
* Validate Access JWT inside Worker:

  * signature;
  * issuer;
  * audience;
  * expiry.

* Add dev bearer only for local development:

  * explicit enable flag;
  * boot refusal in production;
  * no bearer value in source or bundle.

* Add role model:

  * reader;
  * admin.

Read API
--------

* ``GET /api/admin/summary``.
* ``GET /api/admin/entitlements`` with cursor pagination and filters.
* ``GET /api/admin/entitlements/:id``.
* ``GET /api/admin/events``.
* ``GET /api/admin/settings``.

Testing
-------

* No token returns 401.
* Wrong audience returns 403.
* Expired JWT returns 403.
* Forged identity header without JWT is ignored/rejected.
* Reader can read.
* Reader cannot mutate.
* Admin can read and mutate with a valid Access JWT.
* Admin Worker has no signing private-key binding.
* Public verifier does not expose ``/api/admin/*``.

Exit criteria
-------------

* Admin read API is authenticated and authorization-checked.
* Admin Worker does not carry online signing private key.
* No mutation endpoint exists yet.

Phase 7: admin mutation API
===========================

Purpose
-------

Add entitlement writes through the authenticated, audited write kernel.

Endpoints
---------

* ``POST /api/admin/entitlements``.
* ``PATCH /api/admin/entitlements/:id``.
* ``POST /api/admin/entitlements/:id/disable``.
* ``POST /api/admin/entitlements/:id/reenable``.
* ``POST /api/admin/entitlements/:id/revoke``.
* ``POST /api/admin/smoke-test``.

Mutation requirements
---------------------

* Require admin role.
* Validate request body with shared schemas.
* Use idempotency keys for repeated requests.
* Use prepared statements only.
* Compute ``revocation_seq`` server-side.
* Require reason for destructive operations.
* Write audit event with:

  * actor;
  * actor type;
  * source;
  * request id;
  * IP or Cloudflare request metadata if available;
  * previous JSON;
  * next JSON.

Smoke-test requirements
-----------------------

* Use the real verifier path.
* Do not hold signing private key in admin Worker.
* Do not accept arbitrary target URLs.
* Return request id and redacted result.

Testing
-------

* Create entitlement.
* Patch TTLs and notes.
* Disable.
* Reenable disabled.
* Revoke active.
* Revoke disabled.
* Attempt to reenable revoked and assert terminal behavior.
* Duplicate idempotency key does not double-increment sequence.
* Every mutation writes exactly one audit event.
* Audit insert failure rolls back the entitlement write.
* Audit event actor is server-derived.
* Unauthorized mutation is rejected.

Exit criteria
-------------

* No mutation can skip audit.
* No mutation can choose its own ``revocation_seq``.
* Revoke/disable UI semantics are backed by tested API semantics.

Phase 8: Vite + React admin UI
==============================

Purpose
-------

Expose the proven admin API through a safe operational UI.

Screens
-------

Overview
  Health, environment, verifier URL, entitlement counts, recent events, active
  key id, and warnings.

Entitlements
  Paginated table with filters for project, feature, status, customer, validity,
  and text search. Fingerprints are short by default.

Entitlement detail
  Current state, customer/license metadata, device hash, TTLs, validity window,
  revocation sequence, notes, and event timeline.

Create/edit
  Validated forms for entitlement creation and patching.

Diagnostics
  Lookup by fingerprint/request id, run constrained smoke checks, and copy safe
  diagnostics.

Settings
  Environment, Access audience, verifier route, active key id, expected public
  key id, and operational links. No secrets displayed.

UX requirements
---------------

* Redact hashes by default.
* Provide explicit copy buttons for full hashes.
* Require typed confirmation for revoke and disable.
* Show effective revocation latency based on ``assertion_ttl_seconds``.
* Show request id on every error.
* Avoid raw internal status codes in primary UI labels.
* Do not put explanatory marketing text on the first screen.
* Keep tables dense but readable.

Frontend tests
--------------

* Render each route.
* Loading, empty, success, and error states.
* Form validation.
* Typed destructive confirmation.
* Pagination and filters.
* Request id shown on API error.
* No API tokens or secrets in bundle.

Playwright E2E
--------------

Against local dev:

* open overview;
* list entitlements;
* create entitlement;
* view detail;
* disable with typed confirmation;
* reenable;
* revoke with typed confirmation;
* verify event timeline.

Against staging:

* login through Access or CI service-token equivalent;
* read summary;
* create test entitlement;
* run smoke test;
* revoke;
* confirm fresh verifier denial;
* cleanup.

Exit criteria
-------------

* UI workflows pass local Playwright smoke.
* Staging E2E passes with authenticated admin identity.
* UI does not expose secrets or raw private-key material.

Phase 9: environments, deployment, and operations
=================================================

Purpose
-------

Make staging and production deployment repeatable and auditable.

Environment tasks
-----------------

* Commit sanitized Wrangler config with explicit environments where possible.
* Use distinct D1 databases for dev, staging, and production.
* Use distinct online signing keys for staging and production.
* Use distinct routes/domains for verifier and admin Workers.
* Disable admin ``workers.dev`` in staging and production.
* Store secrets via Wrangler secrets or CI secrets, not source.
* Generate Worker types after config changes.

Deployment pipeline
-------------------

Staging:

* install dependencies;
* run tests;
* apply migrations to staging D1;
* deploy verifier;
* deploy admin Worker/UI;
* run staging E2E smoke.

Production:

* require staging E2E success;
* require manual approval;
* apply migrations;
* deploy verifier;
* deploy admin Worker/UI;
* run production smoke with non-destructive fixture or dedicated test project;
* publish release notes.

Rollback and recovery
---------------------

* Document Worker version rollback.
* Document D1 forward-fix procedure.
* Document D1 export and restore.
* Document key rotation.
* Document key compromise response.

Key rotation
------------

* Generate new online signing key.
* Add new public key to client trust ring.
* Release clients.
* Switch verifier active signing key.
* Wait for cache/update window.
* Retire old key id.
* Test old-key rejection.

Exit criteria
-------------

* Staging and production cannot share D1 database ids or signing key ids by
  accident.
* D1 backup/restore has been dry-run.
* Key rotation has been rehearsed in staging.
* Production deploy has documented rollback.

Phase 10: documentation
=======================

Purpose
-------

Make integration, operation, and support behavior understandable without
overclaiming security.

Documentation updates
---------------------

Security model
  Document online verification, cache semantics, revocation latency,
  anti-tamper limitations, and non-goals.

Integration guide
  Show how host apps configure online policy, tamper policy, transport callback,
  cache path, and public key records.

Admin guide
  Explain admin UI workflows: create, disable, reenable, revoke, diagnostics,
  and audit events.

Operations runbook
  Include deploy, rollback, D1 backup/restore, key rotation, Access setup, and
  incident response.

Developer guide
  Include local dev commands, test commands, migration workflow, fixture
  generation, and CI expectations.

User-facing language
  Provide recommended messages for active, offline grace, revoked, expired,
  network unavailable, and tamper states.

Required documentation claims
-----------------------------

* Online verification improves entitlement freshness; it does not make a local
  machine tamper-proof.
* Revocation is bounded by cache policy unless online is required at every
  feature boundary.
* Anti-tamper is best-effort detection, not crack prevention.
* Cloudflare secrets must hold private keys.
* Admin Worker must not hold online signing private key.

Exit criteria
-------------

* Docs build/check passes.
* No docs claim instant revocation unless policy truly requires fresh online
  verification.
* No docs claim the system prevents cracking.
* Setup docs include staging before production.

Phase 11: final validation and final review
===========================================

Purpose
-------

Prove the complete system before marking the project production-ready.

Required validation commands
----------------------------

C++:

.. code-block:: console

   ctest --test-dir build -C Debug --output-on-failure --timeout 900

Worker verifier:

.. code-block:: console

   cd services/cloudflare-online-verifier
   npm ci
   npm test
   npm run lint
   npm run dry-run
   npm run migrate:local

Admin Worker/UI:

.. code-block:: console

   cd services/cloudflare-license-admin
   npm ci
   npm test
   npm run lint
   npm run build
   npm run dry-run
   npm run test:e2e

Docs:

.. code-block:: console

   python scripts/check_docs_links.py
   python -m sphinx -b html -W --keep-going -n doc build/docs/sphinx

Secret/artifact checks:

.. code-block:: console

   npm --prefix services/cloudflare-online-verifier run lint
   rg -n "CLOUDFLARE_API_TOKEN|ADMIN_BEARER|ONLINE_SIGNING_PRIVATE_KEY" .

The secret scan must account for intentional references in docs/config examples
without allowing actual secret values.

Staging E2E checklist
---------------------

* Verifier ``/health`` returns healthy.
* Admin summary is inaccessible without auth.
* Admin summary is accessible with valid admin identity.
* Create test customer/license/entitlement.
* Verify online assertion with staging C++ client.
* Disable entitlement and confirm fresh verifier denial.
* Reenable entitlement and confirm fresh verifier ``ok``.
* Revoke entitlement and confirm fresh verifier denial.
* Confirm expired assertions are rejected.
* Confirm audit timeline includes all actors and request ids.
* Confirm UI displays assertion TTL as effective revocation latency.
* Cleanup test rows and rate-limit counters.

Final review process
--------------------

Run three independent review passes before production:

1. Worker/D1/security review.
2. C++ ABI/protocol/cache review.
3. Admin UI/ops/docs review.

Each review must produce:

* findings ordered by severity;
* file and line references;
* missing tests;
* release-blocking concerns;
* explicit sign-off or explicit blockers.

Release-blocking checklist
--------------------------

The release is blocked if any item is false:

* Public verifier has no admin routes.
* Admin Worker has no online signing private key.
* Admin auth validates Access JWT or equivalent cryptographically.
* Dev bearer cannot run in production.
* Denied entitlements are not signed by default.
* Rotating-fingerprint flood is rate-limited.
* Worker-signed fixture verifies in C++.
* ``revocation_seq`` rollback is rejected.
* Validity windows are enforced.
* Every mutation writes an audit event in the same D1 batch as the entitlement
  write.
* Service CI is required.
* Staging E2E passes.
* Docs accurately describe cache and revocation limitations.

Final evidence packet
---------------------

Before merging, attach:

* command outputs for all validation commands;
* staging E2E transcript;
* screenshots for key admin UI workflows;
* Cloudflare deployment ids or Worker versions;
* D1 migration list;
* active public key id and retired key ids, if any;
* review reports;
* known residual risks.

Residual risks to document
==========================

Even after this plan is complete:

* A fully controlled client machine can still patch or bypass local checks.
* Revocation latency is bounded by cache and online policy.
* Cloudflare account compromise can mutate entitlement state.
* D1 outage can affect fresh verification.
* Admin identity provider compromise can affect entitlement control.
* Signing-key compromise requires key rotation and client trust-ring updates.

These are operational risks, not hidden implementation bugs. They should remain
visible in the security model and release notes.
