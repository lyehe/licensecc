License admin Vite React implementation plan
############################################

This planning report consolidates three independent Claude CLI max-effort
reviews of the proposed Vite + React license administration design. The
reviewers used three lenses:

* architecture, protocol, C++ API, and maintainability;
* Cloudflare Workers, D1, Wrangler, Vite, React, and operations;
* security, UX, DX, migration, and validation.

The full advisory reviews were written by Claude CLI outside the repository:

* ``C:\Users\HEQ\.claude\plans\you-are-an-independent-pure-tide.md``
* ``C:\Users\HEQ\.claude\plans\you-are-an-independent-playful-origami.md``
* ``C:\Users\HEQ\.claude\plans\you-are-an-independent-magical-shamir.md``

The common conclusion is that the previous design direction is correct, but it
should be reframed as additive work on an already implemented verifier instead
of a greenfield build. The public verifier, online assertion format,
``acquire_license_ex()``, anti-tamper flow, D1 entitlement table, entitlement
CLI, rate limiting, and online callback example already exist. The new scope is
the admin plane, stronger service CI, data-model growth, validity-window
enforcement, revocation semantics, key/secret operations, Vite + React admin UX,
and a product-facing C++ decision wrapper.

Scope
=====

In scope
--------

* Preserve the existing public verifier Worker as a minimal public service.
* Add a separate private admin Worker that serves a Vite + React SPA through
  Workers Static Assets and exposes ``/api/admin/*``.
* Add additive D1 migrations for customers, licenses, entitlement validity
  windows, notes, actor-aware audit events, and UI indexes.
* Harden the existing verifier behavior where the reviews found concrete gaps.
* Add Cloudflare service CI and real-D1 tests before building admin mutations.
* Add a C++ product integration wrapper that returns structured licensing
  decisions instead of raw low-level status arrays.
* Keep Drogon as an optional self-hosted/on-prem alternative, not the default
  Cloudflare path.

Out of scope
------------

* Rewriting the existing verifier protocol from scratch.
* Moving network transport into the core C++ library.
* Adding payment-provider integration.
* Building a broad multi-tenant SaaS platform before the single-vendor admin
  console is correct.
* Claiming instant revocation for clients that can use cached online assertions.

Current baseline
================

Already implemented and should be preserved:

* ``services/cloudflare-online-verifier`` with ``GET /health`` and
  ``POST /v1/verify``.
* D1 ``entitlements`` and ``rate_limit_counters`` tables.
* D1 and Cloudflare rate-limit layers.
* Signed online assertion envelope with key id, nonce, expiry, cache window, and
  revocation sequence.
* C++ online assertion verification with compiled public key records.
* ``acquire_license_ex()`` and ``LicenseCheckOptions``.
* Anti-tamper audit/enforce behavior.
* ``examples/online_callback`` host-transport example.
* Entitlement CLI for upsert, revoke, disable, get, and list.

Net-new or materially incomplete:

* Admin Worker and Vite + React UI.
* Admin authentication and authorization.
* Actor-aware audit log schema and write path.
* ``customers`` and ``licenses`` tables.
* ``valid_from`` and ``valid_until`` enforcement.
* Server-owned monotonic ``revocation_seq`` handling.
* Cross-language golden assertion conformance test.
* Cloudflare service CI.
* Real-D1 Worker integration tests.
* Environment separation for dev, staging, and production.
* Server-side signing-key rotation workflow.
* Product-facing C++ decision/cache wrapper.

Important review findings
=========================

1. The wire format needs a contract test
----------------------------------------

The TypeScript Worker and C++ verifier independently implement the canonical
online assertion payload. Add a normative protocol spec and a golden fixture
that is signed by the Worker code path and verified by the C++ code path. This
prevents a field-ordering or formatting change from silently breaking online
verification.

2. Validity windows must be enforced by the verifier
----------------------------------------------------

Adding ``valid_from`` and ``valid_until`` as admin metadata is misleading unless
``/v1/verify`` enforces them. Recommended behavior:

* ``NULL`` means unbounded.
* deny if ``now < valid_from``;
* deny if ``now >= valid_until``;
* clamp issued ``expires_at`` so no signed assertion outlives ``valid_until``;
  ``cache_until`` mirrors ``expires_at`` for wire compatibility.

3. Revocation sequence needs ownership and enforcement
------------------------------------------------------

``revocation_seq`` should not be human-supplied by the admin UI. The admin write
kernel should compute it monotonically for every mutation. The C++ decision/cache
layer should persist the last seen sequence for a
``(project, feature, license_fingerprint)`` tuple and reject assertions that move
backward.

This does not make revocation instant. Clients continue until their current
fresh assertion expires. The admin UI should surface the assertion TTL because
that is the effective revocation latency for this design.

4. Denials should not be signed by default
------------------------------------------

The current verifier signs denied assertions. The reviewers flagged this as an
avoidable signing oracle and CPU-amplification surface. Prefer unsigned denial
JSON for ordinary unknown/denied entitlements:

.. code-block:: json

   { "ok": false, "code": "entitlement_denied" }

If a product later needs signed denials, make them explicit, short-lived, and
separately rate-limited.

5. Admin auth is the crown-jewel boundary
-----------------------------------------

The admin Worker can mutate revenue-critical entitlement data. It must not rely
only on front-door configuration or spoofable headers. Requirements:

* put the admin Worker behind Cloudflare Access;
* disable ``workers.dev`` for the admin Worker in staging and production;
* validate the Access JWT inside the Worker on every ``/api/admin/*`` request;
* verify issuer, audience, expiry, and signature;
* make dev bearer auth impossible to enable in production;
* record only server-verified identity in audit events.

6. Admin Worker must not hold the signing private key
-----------------------------------------------------

The verifier signs online assertions. The admin Worker manages entitlements. Do
not give the admin Worker ``ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM``. The admin
``smoke-test`` endpoint should call the verifier through a configured URL or
service binding rather than minting assertions itself.

7. Worker tests need real D1 coverage and CI
--------------------------------------------

The Cloudflare service currently has local tests, but the reviews found that the
service should be part of CI before new admin code is trusted. SQL-sensitive
paths should be tested under a Workers runtime with D1 rather than only with
hand mocks.

Open decisions to lock before implementation
============================================

* **D1 boundary:** one shared D1 database with strict code-level write
  separation, or separate admin/source-of-truth and verifier/read-model
  databases. For the current low-volume target, shared D1 is acceptable if the
  verifier never exposes entitlement writes and tests assert the admin Worker has
  no signing key. A separate read model can be added later if operational risk
  warrants it.
* **Signed denials:** drop by default, or keep only behind an explicit opt-in.
  Recommended: drop by default.
* **Validity windows:** verifier-enforced or metadata-only. Recommended:
  verifier-enforced.
* **CLI future:** route CLI mutations through the admin API, or keep the D1 CLI
  as break-glass. Recommended: keep a break-glass CLI, but stamp
  ``source='cli'`` and an actor and document that it bypasses Access.
* **RBAC scope:** single-vendor admin-only for v1, or multi-project roles.
  Recommended: single-vendor v1 with an explicit ``role`` model left extensible.
* **C++ wrapper ABI:** C++ convenience-only wrapper, or public C ABI decision
  struct. Recommended: start with C++ wrapper; add C ABI only if consumers need
  it, with ``size``/``version`` and public offset tests.

Improved implementation plan
============================

Phase 0: foundations, decisions, and CI
---------------------------------------

Purpose
~~~~~~~

Create the safety rails before changing trusted behavior or adding admin
mutation paths.

Implementation
~~~~~~~~~~~~~~

* Record the open decisions above in this document or a follow-up ADR.
* Add Cloudflare service CI:

  * ``npm ci``;
  * TypeScript build;
  * Worker unit tests;
  * lint;
  * ``wrangler deploy --dry-run``;
  * local D1 migration apply.

* Add a service secret scan for:

  * private key PEM markers;
  * bearer/admin secrets;
  * Cloudflare API tokens;
  * accidentally bundled secrets in any built UI asset.

* Add Wrangler environment structure for dev, staging, and production.
* Generate Worker types with ``wrangler types`` and move toward typed bindings.
* Decide the admin custom domain and Access application shape.

Exit gates
~~~~~~~~~~

* Cloudflare service CI is a required check.
* Existing C++ CTest suite still passes.
* Existing Worker tests still pass.
* Staging and production configs cannot share signing keys.
* No admin bearer path can be enabled when ``ENVIRONMENT=production``.

Phase 1: protocol contract and verifier hardening
-------------------------------------------------

Purpose
~~~~~~~

Freeze and test the current online assertion protocol, then close verifier
abuse and correctness gaps before adding an admin surface.

Implementation
~~~~~~~~~~~~~~

* Write a normative online assertion spec:

  * envelope prefix;
  * base64 encoding;
  * field names;
  * field order;
  * integer formatting;
  * purpose value;
  * version semantics;
  * signature algorithm;
  * cache and clock-skew semantics.

* Add a golden assertion fixture:

  * fixed test key;
  * fixed request and claims;
  * assertion generated by Worker signing code;
  * assertion verified by C++ ``verify_assertion_envelope``.

* Stop signing ordinary denials by default, or place signed denials behind an
  explicit config flag.
* Add per-IP and global signing ceilings in addition to the existing
  fingerprint-based limiter.
* Add ``valid_from`` and ``valid_until`` support after Phase 2 migrations land,
  or prepare the verifier code with backward-compatible ``NULL`` handling.

Exit gates
~~~~~~~~~~

* Worker-signed golden assertion verifies in C++.
* C++-built golden assertion, if retained for tests, matches the protocol spec.
* Unknown entitlement denial does not perform RSA signing by default.
* Rate-limit tests cover per-fingerprint, per-IP, and global signing ceilings.

Phase 2: additive data model and shared write kernel
----------------------------------------------------

Purpose
~~~~~~~

Extend entitlement data without breaking the existing verifier read path.

Migrations
~~~~~~~~~~

Add only forward migrations, starting after the existing applied migrations:

* ``customers``:

  * ``id``;
  * ``display_name``;
  * ``contact_email``;
  * ``external_ref``;
  * ``notes``;
  * ``created_at``;
  * ``updated_at``.

* ``licenses``:

  * ``license_fingerprint`` primary key;
  * ``customer_id`` nullable;
  * ``label``;
  * ``notes``;
  * ``created_at``;
  * ``updated_at``.

* ``entitlements`` additions:

  * ``valid_from`` nullable integer;
  * ``valid_until`` nullable integer;
  * ``notes`` text default ``''``.

* ``entitlement_events`` additions:

  * ``actor``;
  * ``actor_type``;
  * ``source``;
  * ``request_id``;
  * ``ip``;
  * ``prev_json``;
  * ``next_json``.

* UI indexes:

  * project, feature, status;
  * license fingerprint;
  * customer id;
  * updated timestamp.

Write kernel
~~~~~~~~~~~~

Create a shared TypeScript module for entitlement operations:

* input validation;
* state transitions;
* monotonic ``revocation_seq`` calculation;
* D1 prepared statements;
* audit event creation;
* consistent API result objects.

The admin Worker should use this kernel directly. The existing CLI should either
call the admin API or use the same validation and event semantics at its edge.

Exit gates
~~~~~~~~~~

* Migrations are additive and idempotent.
* Existing verifier tests pass against the migrated schema.
* Entitlements without validity windows behave exactly as before.
* Validity windows are enforced when present.
* ``expires_at`` never exceeds ``valid_until`` and ``cache_until`` equals
  ``expires_at``.
* Every mutation increases ``revocation_seq``.
* Every mutation writes exactly one audit event with a server-derived actor or
  documented CLI actor.

Phase 3: admin Worker skeleton with auth first
----------------------------------------------

Purpose
~~~~~~~

Build the private control plane boundary before any mutation endpoint ships.

Implementation
~~~~~~~~~~~~~~

Create ``services/cloudflare-license-admin``:

.. code-block:: text

   services/cloudflare-license-admin/
     package.json
     wrangler.jsonc
     vite.config.ts
     index.html
     src/worker/index.ts
     src/worker/auth.ts
     src/worker/db.ts
     src/shared/schemas.ts
     src/shared/api.ts
     src/ui/main.tsx
     src/ui/App.tsx

Recommended libraries:

* Vite + React + TypeScript;
* Hono or small typed router for admin API routes;
* Zod for request and response validation;
* TanStack Query for React server state;
* React Router or TanStack Router for UI routing.

Read-only admin API:

* ``GET /api/admin/summary``;
* ``GET /api/admin/entitlements``;
* ``GET /api/admin/entitlements/:id``;
* ``GET /api/admin/events``;
* ``GET /api/admin/settings``.

Auth requirements:

* validate Access JWT in the Worker;
* reject missing, expired, wrong-audience, and invalid-signature tokens;
* disable ``workers.dev`` for staging and production admin deployments;
* allow dev bearer only when explicitly configured outside production.

Exit gates
~~~~~~~~~~

* Anonymous admin API requests return 401 or 403.
* Forged Access identity headers without a valid JWT are rejected.
* Wrong audience JWT is rejected.
* Valid admin identity can read summary/list/detail.
* Admin Worker config scan proves no signing private key binding exists.
* Public verifier still exposes no admin routes.

Phase 4: admin mutating API
---------------------------

Purpose
~~~~~~~

Add revenue-critical mutations only after the auth boundary and write kernel are
proven.

Endpoints
~~~~~~~~~

* ``POST /api/admin/entitlements``;
* ``PATCH /api/admin/entitlements/:id``;
* ``POST /api/admin/entitlements/:id/revoke``;
* ``POST /api/admin/entitlements/:id/disable``;
* ``POST /api/admin/entitlements/:id/reenable``;
* ``POST /api/admin/smoke-test``.

Rules
~~~~~

* All mutations go through the shared write kernel.
* No mutation accepts caller-supplied ``revocation_seq``.
* Destructive actions require a reason.
* Events are append-only.
* Smoke test calls the real verifier path and never signs assertions in the
  admin Worker.
* Use idempotency keys for create/revoke operations where repeated browser
  submissions are plausible.

Exit gates
~~~~~~~~~~

* Every mutating endpoint has real-D1 tests.
* No mutation path can skip audit event creation.
* Revoked terminal behavior is defined and tested.
* Disable and reenable transitions are defined and tested.
* Smoke test cannot be pointed at arbitrary URLs.

Phase 5: Vite + React admin UI
------------------------------

Purpose
~~~~~~~

Give operators a safe, low-friction control plane without exposing raw database
or licensing internals.

Screens
~~~~~~~

Overview
  Health, environment, entitlement counts, revoked/disabled counts, recent
  events, active signing key id, and D1 limiter state.

Entitlements
  Searchable, paginated table with status, project, feature, customer, short
  fingerprint, validity window, updated time, and assertion TTL.

Entitlement detail
  Full entitlement state, customer/license metadata, safe copy controls, event
  timeline, last mutation actor, and server-computed revocation sequence.

Create/edit entitlement
  Project, feature, fingerprint, optional device hash, validity window, cache
  TTL, assertion TTL, notes, and customer/license association.

Diagnostics
  Paste fingerprint, request id, or short hash; inspect server-side entitlement
  state and run constrained smoke checks.

Settings
  Environment label, verifier URL, active key id, public key id, Access audience,
  and operational warnings. No secrets displayed.

UX requirements
~~~~~~~~~~~~~~~

* Redact hashes by default.
* Require typed confirmation for revoke and disable.
* Show effective revocation time based on ``assertion_ttl_seconds``.
* Show request ids on all errors.
* Keep tokens and secrets out of the SPA bundle.
* Use the Access session cookie; do not embed API tokens in JavaScript.

Exit gates
~~~~~~~~~~

* UI can list, create, revoke, disable, reenable, and inspect events in local
  dev.
* Destructive actions cannot be one-click.
* Error states include request ids.
* Tables work at desktop and mobile widths.
* Bundle scan finds no secrets.

Phase 6: C++ product decision wrapper
-------------------------------------

Purpose
~~~~~~~

Make the integration experience product-friendly without changing the existing
low-level C API.

Recommended name
~~~~~~~~~~~~~~~~

Prefer ``LicenseSession`` or ``LccDecision`` over ``LicenseGate`` to avoid
possible naming collision with other licensing products.

Implementation
~~~~~~~~~~~~~~

Add a C++ wrapper that:

* accepts product/project, feature, local license source, online endpoint, online
  policy, tamper policy, and cache path;
* calls ``acquire_license_ex()``;
* owns persistent online assertion cache state;
* persists last-seen ``revocation_seq`` per entitlement tuple;
* maps raw local, tamper, and online events to a stable decision model.

Example decision:

.. code-block:: cpp

   struct LicenseDecision {
       bool allowed;
       LicenseDecisionState state;
       LicenseDecisionReason reason;
       std::string user_message;
       std::string diagnostics;
       std::chrono::system_clock::time_point checked_at;
       std::optional<std::chrono::system_clock::time_point> grace_until;
       std::optional<std::chrono::system_clock::time_point> assertion_expires_at;
   };

States:

* ``Active``;
* ``OfflineGrace``;
* ``NeedsRefresh``;
* ``Expired``;
* ``Revoked``;
* ``Denied``;
* ``TamperSignal``;
* ``NetworkUnavailable``;
* ``MalformedLicense``.

Exit gates
~~~~~~~~~~

* Raw ``acquire_license()`` behavior is unchanged.
* ``acquire_license_ex()`` ABI tests remain green.
* Wrapper tests cover every local/online/tamper state.
* Cached assertion replay with lower ``revocation_seq`` is rejected by the
  wrapper/cache layer.
* Diagnostics contain no private keys or secrets.

Phase 7: environments, key rotation, and operations
---------------------------------------------------

Purpose
~~~~~~~

Make staging and production deployment repeatable.

Implementation
~~~~~~~~~~~~~~

* Separate D1 databases for dev, staging, and production.
* Separate online signing keys for staging and production.
* Per-environment Worker routes.
* A build gate tying the expected public key id to the target environment.
* Server-side multi-key signing configuration, or at minimum a documented
  one-active-key process.
* Key rotation runbook:

  1. generate new key;
  2. add public key to client trust ring;
  3. deploy clients;
  4. switch verifier active signing key;
  5. wait for max cache and update window;
  6. retire old key id;
  7. validate old-key rejection.

* D1 backup/export and restore runbook.
* Structured logs and retention plan.

Exit gates
~~~~~~~~~~

* Staging-signed assertion is rejected by a production-keyed client unless the
  production client explicitly trusts staging.
* Production deploy cannot use staging signing private key.
* D1 export and restore have been dry-run.
* Rollback path is documented and tested at least once.

Phase 8: staging end-to-end and release gates
---------------------------------------------

Purpose
~~~~~~~

Prove the complete system before production.

Staging smoke
~~~~~~~~~~~~~

Script a staging flow:

1. create test customer/license/entitlement;
2. run verifier ``/health``;
3. run ``POST /v1/verify`` and receive an online assertion;
4. verify that assertion with the C++ client built with the staging public key;
5. revoke entitlement through admin API;
6. verify that a fresh online check is denied;
7. verify that an old assertion is rejected after ``expires_at``;
8. inspect audit event with verified actor and request id;
9. clean up test rows.

Exit gates
~~~~~~~~~~

* Staging smoke passes before production deploy.
* Production deploy is manual or protected.
* Public verifier, admin API, React UI, D1 migration, and C++ wrapper tests are
  all green.
* Documentation states revocation latency and offline cache behavior honestly.

Verification checklist
======================

The following gates are mandatory before the design should be considered
production-ready:

* Cloudflare service CI is active.
* Worker-signed golden assertion verifies in C++.
* Denials are unsigned by default or explicitly opt-in.
* Per-fingerprint, per-IP, and global signing ceilings exist.
* Migrations are additive and do not break existing entitlements.
* Validity windows are enforced by the verifier.
* Assertion and cache TTLs are clamped to ``valid_until``.
* ``revocation_seq`` is server-owned and monotonic.
* Client or wrapper rejects decreasing ``revocation_seq`` for cached assertions.
* Admin Worker validates Access JWT cryptographically.
* Admin ``workers.dev`` is disabled in staging and production.
* Dev bearer auth cannot run in production.
* Admin Worker does not hold the online signing private key.
* Every mutation writes one append-only audit event.
* Audit actor is server-derived, not request-body-derived.
* Admin write paths use D1 prepared statements.
* SQL-sensitive paths have real-D1 tests.
* SPA bundle contains no secrets.
* Destructive UI actions require typed confirmation.
* Staging and production use distinct D1 databases and signing keys.
* Staging end-to-end smoke passes before production.
* D1 backup/restore and key rotation runbooks exist.

Summary
=======

The improved design is:

* keep the existing verifier small and public;
* harden its protocol, denial, validity, revocation, and CI gaps first;
* add a separate authenticated admin Worker;
* put all entitlement writes through one audited, monotonic write kernel;
* use Vite + React only after the admin API contract is proven;
* add a C++ decision wrapper as a product integration layer rather than another
  core ABI churn point.

The most important sequencing change from the original plan is to do CI,
protocol conformance, verifier hardening, auth, and migrations before building
the React UI. The UI should be the operator surface for a proven control plane,
not the first place where entitlement behavior is defined.
