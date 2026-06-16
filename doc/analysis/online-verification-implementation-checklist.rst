Online verification implementation checklist
############################################

This checklist gates a Cloudflare-backed online verification module for
Licensecc. It is intentionally implementation-oriented: each gate defines what
must be built, how it must be validated, and what evidence is required before
moving to the next stage.

The target architecture is HTTP-free inside the core C++ library. The host
application owns network transport through a callback. Licensecc builds an
online verification request, the host sends it to the Cloudflare Worker, and
Licensecc verifies the signed server assertion before allowing online policy to
affect the license result.

Scope and non-goals
===================

In scope
--------

* Add public C-compatible options for online verification through
  ``LicenseCheckOptions`` without changing existing public structs.
* Keep ``acquire_license()`` compatibility behavior unchanged.
* Add ``acquire_license_ex()`` online policy handling after the local license
  verifier succeeds.
* Keep network I/O outside Licensecc core; use a host callback for transport.
* Add a C++ online verification module that creates nonce-bound requests and
  verifies signed server assertions offline.
* Add a Cloudflare Worker reference service for low-volume deployments.
* Add unit, integration, API, Worker, and CI label coverage.
* Document secure defaults, fail-closed enforcement, assertion lifetime, and
  failure semantics.

Out of scope for v1
-------------------

* No built-in C++ HTTP client in ``licensecc``.
* No attempt to make a customer-controlled machine tamper-proof.
* No generic debugger, VM, process-list, injection, or self-hash checks in core.
* No payment-provider integration.
* No multi-tenant SaaS administration UI.
* No server challenge protocol that depends on a live connection for local
  signature verification.

Gate 0: baseline and compatibility freeze
=========================================

**Purpose**


Capture the current public API, ABI-sensitive structs, local verification
behavior, and test labels before adding online verification.

**Entry criteria**


* The anti-tamper API exists and ``acquire_license_ex()`` is already the
  extensibility point.
* Existing tests for public API, signature verification, standard local license
  verification, anti-tamper, and CTest label audit can run locally.

**Implementation checklist**


* Record current values for all public ``LCC_EVENT_TYPE`` enum entries.
* Record ``sizeof`` and key offsets for these public structs:

  * ``LicenseInfo``
  * ``CallerInformations``
  * ``LicenseLocation``
  * ``AuditEvent``
  * ``ExecutionEnvironmentInfo``
  * current ``LicenseCheckOptions``

* Record behavior of ``acquire_license()`` for:

  * valid local license;
  * missing license;
  * malformed license;
  * corrupted signature;
  * hardware mismatch;
  * expired license.

* Record behavior of ``acquire_license_ex()`` with anti-tamper disabled, audit,
  and enforce modes.
* Confirm the project already has deterministic audit severity support through
  ``EventRegistry``.
* Confirm CTest label audit currently requires ``security``, ``public_api``,
  and ``anti_tamper`` coverage.

**Validation evidence**


Run these commands and save the output in the implementation notes or PR:

.. code-block:: console

   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
   cmake --build build --config Debug --target test_public_api test_signature_verifier test_standard_license test_anti_tamper
   ctest --test-dir build -C Debug -R "test_(public_api|signature_verifier|standard_license|anti_tamper)$" --output-on-failure
   ctest --test-dir build -C Debug -R "test_ctest_label_audit$" --output-on-failure

**Exit criteria**


* Baseline tests pass before online work begins.
* Any failing baseline test is either fixed first or documented as unrelated
  with a reproducible reason.
* No online API design work starts until the compatibility snapshot exists.

Gate 1: public API and ABI contract
===================================

**Purpose**


Add online verification options and result codes without breaking existing
consumers or altering existing public structs.

**Entry criteria**


* Gate 0 is complete.
* The public contract for online policies, callback behavior, and assertion
  buffer ownership is agreed.

**Implementation checklist**


* Append enum values only. Do not renumber existing event codes.
* Keep ``LICENSE_TAMPER_DETECTED == 10``.
* Add online result codes after existing values, for example:

  * ``LICENSE_ONLINE_REQUIRED``
  * ``LICENSE_ONLINE_VERIFICATION_FAILED``
  * ``LICENSE_ONLINE_ASSERTION_INVALID``
  * ``LICENSE_ONLINE_CACHE_EXPIRED`` reserved for future persistent-cache APIs

* Add online policy enum:

  * ``LCC_ONLINE_DISABLED``: no callback, no assertion verification;
  * ``LCC_ONLINE_REQUIRE``: require a fresh valid server assertion.

* Add callback status enum with explicit transport and host-decision outcomes:

  * callback success;
  * transport unavailable;
  * timeout;
  * output buffer too small;
  * host declined;
  * malformed host response.

* Add a versioned request struct passed to the callback. It should include:

  * struct size and version;
  * project name;
  * feature name;
  * license fingerprint;
  * optional device hash or host-provided binding hash;
  * nonce generated by core;
  * requested online policy;
  * configured timeout in milliseconds.

* Add online callback typedef:

  * input: ``const LccOnlineRequest*``;
  * output: caller-provided assertion buffer;
  * output size: in/out ``size_t*`` so the callback can report required size.

* Append fields to ``LicenseCheckOptions`` only after existing anti-tamper
  fields:

  * ``online_policy``;
  * ``online_flags``;
  * ``online_timeout_ms``;
  * ``online_check``;
  * ``online_user_data``;
  * optional fixed-size device hash buffer if core needs to verify that claim.

* Bump ``LCC_LICENSE_CHECK_OPTIONS_VERSION``.
* Update ``lcc_init_license_check_options()``:

  * size is ``sizeof(LicenseCheckOptions)``;
  * version is the new version;
  * tamper defaults to enforce mode with strict source-shadowing;
  * online defaults to disabled unless a callback is supplied;
  * timeout defaults to a bounded value such as 3000 ms.

* Update options normalization so older initialized structs are accepted when
  ``size`` covers the fields they contain.
* Reject impossible options fail-closed:

  * version is unsupported;
  * size is smaller than the v1 anti-tamper fields;
  * online policy requires a callback but callback is null;
  * timeout is zero or above the documented maximum;
  * flags contain unknown bits.

**Validation evidence**


Add and run public API tests that prove:

* appended enum values have stable expected integer values;
* old public struct sizes and offsets are unchanged;
* ``LicenseCheckOptions`` initialization sets the new size and version;
* a simulated v1 options struct remains accepted and preserves anti-tamper
  behavior;
* invalid size/version combinations return ``LICENSE_MALFORMED``;
* new public symbols link from a C++ consumer target.

**Exit criteria**


* Public API tests pass on Windows and Linux.
* No existing public struct except ``LicenseCheckOptions`` changes size.
* Existing consumers using ``acquire_license()`` or v1
  ``LicenseCheckOptions`` keep working.

Gate 2: online assertion format and crypto boundary
===================================================

**Purpose**


Define a deterministic server assertion format that can be verified offline by
the C++ library and generated by the Cloudflare Worker.

**Entry criteria**


* Gate 1 is complete.
* The project has an existing RSA PKCS#1 SHA-256 signature verifier and key-id
  infrastructure.

**Implementation checklist**


* Use a compact signed assertion envelope:

  * prefix: ``lccoa1``;
  * payload: canonical bytes encoded with canonical base64url or canonical
    base64;
  * signature: signature over exact payload bytes.

* Keep the envelope parse minimal before signature verification:

  * split prefix/payload/signature;
  * decode base64;
  * reject non-canonical encoding;
  * verify signature before parsing claims.

* Use deterministic canonical payload fields with a fixed order:

  * purpose;
  * assertion version;
  * signature algorithm;
  * key id;
  * project;
  * feature;
  * license fingerprint;
  * device hash;
  * nonce;
  * decision status;
  * issued-at epoch seconds;
  * expires-at epoch seconds;
  * cache-until epoch seconds, equal to expires-at in v1;
  * revocation sequence.

* Reject payloads with:

  * duplicate keys;
  * unknown keys;
  * missing required keys;
  * non-canonical line endings;
  * invalid integer fields;
  * unsupported algorithm;
  * missing or retired key id;
  * signature mismatch.

* Support a separate online assertion verification key ring if feasible:

  * preferred: generated project header exposes dedicated online public key
    records;
  * acceptable v1 fallback: use the existing project public key with explicit
    documentation that issuer and online assertion keys should be separated in
    production when key generation support is added.

* Bind the assertion to the current request:

  * project matches;
  * feature matches;
  * license fingerprint matches;
  * device hash matches when provided;
  * nonce matches;
  * assertion status is accepted;
  * assertion time window is valid;
  * cache-until is not earlier than expires-at and does not extend acceptance
    beyond expires-at in v1.

**Validation evidence**


Add C++ verifier tests for:

* valid assertion;
* wrong prefix;
* non-canonical base64;
* signature over modified payload;
* unknown key;
* duplicate key;
* missing key;
* unsupported algorithm;
* retired key id;
* mismatched project;
* mismatched feature;
* mismatched license fingerprint;
* mismatched nonce;
* expired assertion;
* not-yet-valid assertion if an issued-at skew window is enforced;
* denied assertion status;
* cache-until earlier than expires-at.

**Exit criteria**


* Assertion verification is a pure C++ function with no network dependency.
* Tests prove signature verification happens before claim parsing.
* The Worker and C++ tests use the same canonical payload rules.

Gate 3: C++ online verification module
======================================

**Purpose**


Add an internal module that creates online requests, invokes the host callback,
verifies assertions, and returns deterministic audit/result information.

**Entry criteria**


* Gates 1 and 2 are complete.
* The module boundaries are agreed.

**Implementation checklist**


* Add ``src/library/online_verification/`` with:

  * ``OnlineVerification.hpp``;
  * ``OnlineVerification.cpp``;
  * ``CMakeLists.txt``.

* Define internal request context:

  * caller project;
  * caller feature;
  * local license fingerprint;
  * optional device hash;
  * online policy;
  * flags;
  * timeout;
  * nonce;
  * current time provider for tests.

* Define internal result:

  * accepted;
  * used cache;
  * event type;
  * severity;
  * bounded detail string;
  * callback status;
  * assertion decision status.

* Generate nonce in core:

  * use platform entropy where available;
  * encode as fixed-length hex or base64url;
  * make nonce generation injectable for tests.

* Bound all external data:

  * assertion response max size;
  * detail string max size;
  * request string max sizes;
  * callback output NUL termination where public C strings are used.

* Add policy evaluation:

  * disabled: do not call callback;
  * require: deny unless callback returns a valid fresh assertion.

* Add deterministic result-code mapping:

  * callback transport failure in require mode returns
    ``LICENSE_ONLINE_VERIFICATION_FAILED``;
  * invalid signed assertion returns ``LICENSE_ONLINE_ASSERTION_INVALID``;
  * required online check without callback returns ``LICENSE_ONLINE_REQUIRED``
    or ``LICENSE_MALFORMED`` according to API contract;
  * expired assertions return ``LICENSE_ONLINE_ASSERTION_INVALID``;
  * denied assertion returns ``LICENSE_ONLINE_VERIFICATION_FAILED``.

**Validation evidence**


Add unit tests for:

* no callback leaves online verification disabled;
* require policy denies on transport failure;
* require policy accepts a valid assertion;
* require policy rejects an invalid assertion;
* callback detail is bounded and NUL-terminated;
* callback output size handling rejects truncation safely;
* unknown flags fail closed.

**Exit criteria**


* The module builds into ``licensecc_static``.
* It has no direct dependency on HTTP, curl, WinHTTP, Boost.Asio, Drogon, or
  any server framework.
* Tests cover every policy branch.

Gate 4: acquire_license_ex orchestration
========================================

**Purpose**


Wire online verification into the runtime without masking ordinary local
license failures or changing ``acquire_license()`` behavior.

**Entry criteria**


* Gate 3 is complete.
* Local verifier can expose enough context for online checks: project, feature,
  and a deterministic license fingerprint.

**Implementation checklist**


* Refactor the internal acquire path to return a local verification context
  when the license succeeds.
* Compute license fingerprint deterministically from signed license data:

  * preferred: SHA-256 over canonical signed payload plus signature;
  * acceptable if payload is unavailable: SHA-256 over the signature bytes with
    documentation and tests.

* Preserve local failure precedence:

  * if local result is not ``LICENSE_OK``, do not run online verification;
  * return the original local result;
  * preserve local audit events.

* Preserve anti-tamper behavior:

  * anti-tamper runs only after local ``LICENSE_OK``;
  * if anti-tamper enforcement returns ``LICENSE_TAMPER_DETECTED``, do not mask
    it with online status;
  * anti-tamper failures stop online verification.

* Run online verification after the local license would otherwise be accepted.
* Export online events through ``EventRegistry`` with explicit severity:

  * online failures use ``SVRT_ERROR``;
  * successful online verification may be silent or a low-severity audit event,
    according to the existing audit style.

* Keep ``acquire_license()`` on the compatibility path:

  * no online callback;
  * no online events;
  * no changed return codes.

**Validation evidence**


Add integration tests for:

* ``acquire_license()`` ignores online options because it has no options path.
* ``acquire_license_ex()`` with online disabled equals legacy local behavior.
* Valid local license plus audit-mode callback failure returns ``LICENSE_OK``
  and emits warning.
* Valid local license plus require-mode callback failure returns online failure
  and emits error.
* Valid local license plus require-mode valid assertion returns ``LICENSE_OK``.
* Invalid local license plus failing callback returns original local failure
  and callback is not invoked.
* Anti-tamper enforce failure is not replaced by an online result.
* Strict source-shadowing audit plus successful online check returns
  ``LICENSE_OK`` with both diagnostics preserved.

**Exit criteria**


* No ordinary local license failure is masked by online verification.
* Existing ``acquire_license()`` tests pass unchanged.
* New online integration tests pass under the ``online`` and ``security``
  labels.

Gate 5: fresh assertion and revocation semantics
================================================

**Purpose**


Keep online verification fail-closed while making revocation behavior explicit
and deterministic.

**Entry criteria**


* Gate 4 is complete.
* The revocation and outage threat model is documented.

**Implementation checklist**


* Require a fresh signed assertion whenever online verification runs.
* Do not expose public cache policy or cache TTL knobs in v1.
* Keep the assertion ``cache-until`` claim equal to ``expires-at`` for wire
  compatibility; do not accept expired assertions as cache.
* Do not write cache files from core C++.
* Do not allow stale assertions to override an explicit server denial returned
  during a fresh online check.
* Define revocation sequence behavior:

  * server includes monotonically increasing sequence per license or account;
  * client rejects assertions below its in-process last-seen floor;
  * client does not try to infer newer revocations while offline.

**Validation evidence**


Add tests for:

* transport failure rejects in require mode;
* expired assertion rejected;
* assertion for different feature rejected;
* assertion for different license fingerprint rejected;
* assertion with ``cache-until`` earlier than ``expires-at`` rejected;
* assertion below the in-process revocation floor rejected;
* disabled online policy ignores the callback.

**Exit criteria**


* Fresh assertion behavior is deterministic and bounded.
* No implicit cache file path is introduced in core.
* Documentation makes clear that process-local revocation floors are not
  restart-persistent unless the host persists its own state.

Gate 6: Cloudflare Worker service
=================================

**Purpose**


Provide a small reference online verification service suitable for a low number
of users on Cloudflare Workers.

**Entry criteria**


* Gates 2 and 3 define the exact assertion format and signing algorithm.
* The Worker can sign assertions with a server-side private key stored outside
  source control.

**Implementation checklist**


* Add a Worker module directory, for example
  ``services/cloudflare-licensing-backend/``.
* Use TypeScript.
* Add local package metadata:

  * ``package.json``;
  * ``wrangler.toml.example``;
  * ``tsconfig.json``;
  * test runner config;
  * README.

* Add routes:

  * ``GET /health`` returns service status without secrets;
  * ``POST /v1/verify`` verifies request shape and returns signed assertion;
  * optional admin routes only when protected by explicit admin auth.

* Define request schema:

  * project;
  * feature;
  * license fingerprint;
  * device hash;
  * nonce;
  * client timestamp if used;
  * optional client version.

* Define response schema:

  * assertion envelope;
  * server timestamp;
  * diagnostic code safe for clients;
  * no private signing material.

* Use Cloudflare storage appropriate for low-volume deployment:

  * D1 for entitlement records and revocation sequence;
  * KV for coarse public configuration if needed;
  * Durable Objects only if strong per-license serialization becomes necessary.

* Add D1 schema:

  * licenses or entitlements table;
  * revoked or status field;
  * project;
  * feature;
  * license fingerprint;
  * optional device hash;
  * max cache TTL;
  * revocation sequence;
  * created and updated timestamps.

* Add signing support:

  * private key stored as Worker secret;
  * key id stored as config or secret;
  * assertion algorithm exactly matches C++ verifier;
  * output payload canonicalization shared with tests.

* Add abuse controls:

  * reject oversized bodies;
  * strict JSON schema validation;
  * no reflection of arbitrary client strings in signed payload without
    canonical validation;
  * basic per-IP or per-license rate limiting when available;
  * constant safe error categories for clients.

**Validation evidence**


Add Worker tests for:

* health route;
* valid verification request returns signed assertion;
* revoked entitlement returns denied assertion or configured denial response;
* unknown entitlement returns denial;
* malformed JSON rejected;
* missing required field rejected;
* oversized body rejected;
* nonce is copied exactly into assertion;
* cache TTL capped by entitlement and service max;
* generated assertion verifies with the C++ verifier test vector.

Run:

.. code-block:: console

   cd services/cloudflare-licensing-backend
   npm ci
   npm test
   npm run lint
   npx wrangler deploy --dry-run

**Exit criteria**


* Worker tests pass.
* No private key material is committed.
* Worker-generated assertions are accepted by C++ verifier tests.
* C++-generated bad requests are rejected by Worker schema tests.

Gate 7: cross-language vectors
==============================

**Purpose**


Prove that the C++ verifier and Cloudflare Worker implement the same assertion
format.

**Entry criteria**


* Gates 2 and 6 are complete.

**Implementation checklist**


* Add shared test vectors under ``test/vectors/online/``:

  * canonical payload bytes;
  * payload base64;
  * signature base64;
  * full assertion envelope;
  * public key id;
  * expected claims;
  * expected result.

* Add a C++ test that verifies Worker-generated vectors.
* Add a Worker test that reproduces or verifies the C++ fixture.
* Add negative vectors:

  * wrong nonce;
  * expired assertion;
  * changed feature;
  * changed signature;
  * duplicate claim;
  * unsupported algorithm.

**Validation evidence**


Run:

.. code-block:: console

   cmake --build build --config Debug --target test_online_verification
   ctest --test-dir build -C Debug -R "test_online_verification$" --output-on-failure
   cd services/cloudflare-licensing-backend
   npm test

**Exit criteria**


* Cross-language valid vectors pass in both directions.
* Cross-language negative vectors fail with explicit expected result codes.

Gate 8: examples and host integration docs
==========================================

**Purpose**


Give host applications enough guidance to integrate online verification without
mistaking the reference Worker for a complete anti-tamper system.

**Entry criteria**


* Gates 1 through 6 are complete.

**Implementation checklist**


* Add or update a C++ example that:

  * calls ``lcc_init_license_check_options``;
  * implements the online callback;
  * sends the request to an application-owned HTTP client;
  * returns the assertion to Licensecc;
  * fails closed when the verifier cannot return a fresh valid assertion.

* Add a Cloudflare Worker setup guide:

  * create D1 database;
  * apply schema;
  * set signing private key secret;
  * set key id;
  * deploy Worker;
  * add one entitlement;
  * run a local verification request.

* Update security model:

  * online verification improves revocation and diagnostics;
  * local bypass remains possible on a fully controlled machine;
  * online verification is fail-closed when configured;
  * hosts should validate transport reliability before enabling online checks at
    feature boundaries.

* Update public API docs:

  * options versioning;
  * online policies;
  * callback contract;
  * assertion size limits;
  * failure result codes;
  * audit severity.

* Update README without overclaims:

  * do not say online verification prevents cracking;
  * say it allows server-side entitlement and revocation checks when host
    transport is configured.

**Validation evidence**


Run:

.. code-block:: console

   uv run --no-project python scripts/check_docs_links.py doc
   sphinx-build -b html doc build/doc-html

**Exit criteria**


* Docs build.
* README and security model describe online verification accurately.
* Example compiles or has an explicit smoke test.

Gate 9: CI and CTest labels
===========================

**Purpose**


Make online verification coverage visible and required in the project test
audit.

**Entry criteria**


* C++ online tests exist.
* Worker tests exist or are explicitly marked as service-module tests.

**Implementation checklist**


* Add CTest label ``online``.
* Label online tests with:

  * ``online``;
  * ``security``;
  * ``public_api`` where public symbols are covered.

* Update ``test/ctest_label_audit.cmake`` so ``online`` coverage is required.
* Add CI jobs or steps for:

  * C++ online tests on Linux;
  * C++ online tests on Windows;
  * Worker TypeScript tests;
  * Worker dry-run deploy or static validation.

* Ensure CI fails if:

  * no tests match the ``online`` label;
  * public API tests are skipped;
  * Worker tests are not run when Worker files changed.

**Validation evidence**


Run:

.. code-block:: console

   ctest --test-dir build -C Debug -N -L online
   ctest --test-dir build -C Debug -L online --output-on-failure
   ctest --test-dir build -C Debug -R "test_ctest_label_audit$" --output-on-failure

**Exit criteria**


* ``online`` label reports at least one test.
* Label audit fails when online tests are removed.
* CI configuration includes C++ and Worker coverage.

Gate 10: security review
========================

**Purpose**


Review the implementation for API misuse, signature-validation mistakes,
replay gaps, cache bypasses, and secret-handling failures.

**Entry criteria**


* Gates 1 through 9 are complete.
* Tests pass locally.

**Implementation checklist**


* Review C++ for:

  * signed bytes verified before claim parsing;
  * canonical encoding enforced;
  * nonce generated per request;
  * request fields bounded;
  * callback output bounded;
  * no callback invocation before local license success;
  * local failure result precedence;
  * no implicit network dependency;
  * no secret material embedded in runtime.

* Review Worker for:

  * private key only in secrets;
  * no secret logging;
  * strict request schema;
  * body size limit;
  * assertion TTL cap;
  * safe denial behavior;
  * entitlement lookup cannot be bypassed by feature/project confusion;
  * request strings canonicalized before signing.

* Review docs for:

  * no "prevents cracking" or tamper-proof claims;
  * clear audit versus enforce guidance;
  * clear cache limitations;
  * Cloudflare setup does not require committing secrets.

**Validation evidence**


Run full local gates:

.. code-block:: console

   cmake --build build --config Debug
   ctest --test-dir build -C Debug --output-on-failure
   cd services/cloudflare-licensing-backend
   npm test
   npm run lint
   npx wrangler deploy --dry-run

**Exit criteria**


* Security review findings are fixed or explicitly deferred with rationale.
* All validation commands pass or have documented environment blockers.
* No private keys, tokens, account IDs, or real customer data are present in
  committed files.

Gate 11: release readiness
==========================

**Purpose**


Confirm the feature is ready for an opt-in release without surprising existing
offline users.

**Entry criteria**


* Gate 10 is complete.

**Implementation checklist**


* Release notes include:

  * new online verification API;
  * new event/result codes;
  * Cloudflare Worker reference module;
  * known limitations;
  * migration guidance.

* Versioning decision is recorded:

  * source-compatible addition;
  * ABI implications of changed ``LicenseCheckOptions``;
  * how older initialized options are accepted.

* Packaging includes:

  * public headers;
  * CMake target updates;
  * example source;
  * Worker module if intentionally shipped.

* Rollback plan exists:

  * hosts can omit ``online_check`` or set ``LCC_ONLINE_DISABLED``;
  * enforcement can be disabled without replacing license files.

**Validation evidence**


Run release-adjacent smoke tests:

.. code-block:: console

   cmake --build build --config Release --target install
   ctest --test-dir build -C Release --output-on-failure

**Exit criteria**


* Existing offline integrations remain compatible.
* Online verification is opt-in.
* Release notes and docs match implemented behavior.

Final go/no-go checklist
========================

Do not mark online verification complete until every required item below is
true.

API and compatibility
---------------------

* ``acquire_license()`` behavior is unchanged.
* ``acquire_license_ex()`` is the only runtime entry point that can trigger
  online verification.
* Existing public structs remain unchanged except appended
  ``LicenseCheckOptions`` fields.
* Older ``LicenseCheckOptions`` sizes are accepted when valid.
* Invalid options fail closed with explicit result codes.

C++ behavior
------------

* Online verification runs only after local license success.
* Local license failures are never masked by online failures.
* Anti-tamper enforcement is not masked by online failures.
* Require mode denies missing, failed, invalid, expired, or denied assertions.
* Expired assertions are not accepted as cache.
* Audit events use explicit severity.

Assertion security
------------------

* Assertion signature is verified over exact canonical bytes.
* Claims are parsed only after signature verification.
* Nonce, project, feature, license fingerprint, and device hash are bound.
* Expiration, cache-until, algorithm, key id, and status are enforced.
* Cross-language vectors pass.

Cloudflare Worker
-----------------

* Worker signs assertions with a secret private key.
* Worker validates request schema and body size.
* Worker denies unknown, revoked, or mismatched entitlements.
* Worker caps assertion and cache TTL.
* Worker tests pass.
* Dry-run deploy succeeds.

Testing and CI
--------------

* Public API tests pass.
* Online C++ unit tests pass.
* Online integration tests pass.
* Worker tests pass.
* Cross-language vectors pass.
* ``online`` CTest label is present and audited.
* Linux and Windows CI include online tests.

Documentation
-------------

* Security model is updated.
* Public API docs are updated.
* Example workflow is updated.
* Cloudflare setup guide is present.
* README avoids overclaims.

Evidence log template
=====================

Use this template in the PR or implementation notes.

.. code-block:: text

   Gate 0 baseline:
     command:
     result:
     notes:

   Gate 1 public API:
     command:
     result:
     notes:

   Gate 2 assertion verifier:
     command:
     result:
     notes:

   Gate 3 C++ module:
     command:
     result:
     notes:

   Gate 4 acquire orchestration:
     command:
     result:
     notes:

   Gate 5 cache semantics:
     command:
     result:
     notes:

   Gate 6 Worker:
     command:
     result:
     notes:

   Gate 7 vectors:
     command:
     result:
     notes:

   Gate 8 docs/examples:
     command:
     result:
     notes:

   Gate 9 CI labels:
     command:
     result:
     notes:

   Gate 10 security review:
     reviewer:
     result:
     notes:

   Gate 11 release readiness:
     command:
     result:
     notes:
