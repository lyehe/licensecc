# Codebase smells, SOLID, and DX implementation checklist

**Date:** 2026-06-11
**Status:** draft implementation checklist
**Scope:** C++ core/library and CMake boundaries, public API packaging, Cloudflare
Worker/Admin services, local validation tooling, contributor setup, examples, and
developer documentation.

> **For implementers:** work this checklist in order. Each item must move from
> unchecked to checked only with file evidence and validation evidence. Do not
> use broad rewrites where a smaller seam plus characterization tests can reduce
> risk.

## Review baseline

This checklist comes from a repo-wide review using three independent lanes:

- Code-smell lane: long orchestration, duplicated schemas and validators,
  brittle example parsing, future-only API surface.
- SOLID/design lane: CMake boundary leaks, generated public-header coupling,
  SRP/OCP/DIP violations, process-global policy.
- DX lane: fragmented validation commands, missing toolchain metadata, test
  prerequisite gaps, stale setup documentation.

The local evidence pass registered 35 CTest tests with:

```console
ctest --test-dir build -N
```

No implementation work should be marked complete unless the relevant focused
tests and the listed boundary scans pass.

## Priority model

- `P0`: prevents false confidence in local validation or blocks principled
  contributor feedback.
- `P1`: reduces structural change cost in actively edited core/service areas.
- `P2`: polish or compatibility cleanup that is valuable but can follow the
  larger seams.

## Global completion rules

- Every checked item must include:
  - files changed or inspected,
  - focused tests or static checks run,
  - why the check covers the requirement,
  - residual risks or skipped checks.
- Keep public behavior compatible unless the item explicitly says otherwise.
- For C++ refactors, add characterization tests before moving behavior.
- For Worker/Admin refactors, keep routes, response codes, request envelopes,
  and existing database semantics unchanged unless a task explicitly changes
  them.
- Exclude `extern/`, build output, generated docs output, `node_modules`, and
  vendored `SimpleIni`/`ConvertUTF` from smell cleanup unless a task names them.

---

## Phase 0 - Preserve the current baseline

### Task 0.1: Capture current validation topology

**Priority:** `P0`
**Finding covered:** DX confidence before refactors.
**Files:**

- Inspect: `CMakeLists.txt`
- Inspect: `test/CMakeLists.txt`
- Inspect: `services/*/package.json`
- Create or update: a short validation note in this checklist, a PR body, or a
  release evidence file.

- [ ] Record current CTest inventory from `ctest --test-dir build -N`.
- [ ] Record current service scripts from:
  - `services/cloudflare-license-admin/package.json`
  - `services/cloudflare-licensing-backend/package.json`
  - `services/cloudflare-d1-backup/package.json`
- [ ] Record which commands are known to be fast, focused, full, and external.
- [ ] Record any local prerequisites missing on the developer machine.

**Validation:**

```console
ctest --test-dir build -N
node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local.json
```

**Acceptance criteria:**

- The repo has a visible baseline of available tests before refactors start.
- Any skipped release-gate item is explained by a prerequisite, not ignored.

### Task 0.2: Add a no-regression boundary scan list

**Priority:** `P0`
**Finding covered:** boundary leaks and duplicated contracts need repeatable
checks.
**Files:**

- Modify or create: `scripts/workspace_hygiene_check.mjs` or a new focused
  boundary script.
- Tests: matching `node --test` coverage if a new script is added.

- [ ] Add a scan for accidental broad internal includes outside approved tests:

```console
rg -n "\.\./\.\./src/library" test
```

- [ ] Add a scan for new root/global CMake include leakage:

```console
rg -n "include_directories\(" CMakeLists.txt src test cmake
```

- [ ] Add a scan or documented exception list for duplicated entitlement status
  constants.
- [ ] Wire the scans into the quick local gate only after exceptions are
  documented, so existing known debt does not block unrelated work without a
  migration path.

**Validation:**

```console
node --test scripts/workspace_hygiene_check.test.mjs
node scripts/workspace_hygiene_check.mjs
```

**Acceptance criteria:**

- The scans report current debt clearly.
- New violations can be blocked once the existing debt is reduced or allowlisted.

---

## Phase 1 - Make local validation principled and hard to misuse

### Task 1.1: Make missing Boost fail loudly when tests are requested

**Priority:** `P0`
**Finding covered:** tests silently disabled.
**Evidence:** `CMakeLists.txt` currently gates tests behind `IF(Boost_FOUND)`
and only warns with `message(WARNING "Boost not found, disabling tests")`.
**Files:**

- Modify: `CMakeLists.txt`
- Modify: `README.md`
- Modify: `doc/development/Dependencies.md` or the closest dependency page.

- [ ] Add a CMake option such as `LCC_ALLOW_TESTS_DISABLED` defaulting to `OFF`.
- [ ] When `BUILD_TESTING=ON` and Boost is missing, emit `FATAL_ERROR` unless
  `LCC_ALLOW_TESTS_DISABLED=ON`.
- [ ] Keep non-test runtime builds possible with `BUILD_TESTING=OFF`.
- [ ] Update README/dependency docs with the exact opt-out and when it is
  appropriate.
- [ ] Add or update a CMake smoke test if the repo has a pattern for testing
  configure-time failures.

**Validation:**

```console
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=licensecc_ci -DLCC_PROJECTS_BASE_DIR=%TEMP%/licensecc-projects
ctest --test-dir build -N
```

On a machine without Boost, verify:

```console
cmake -S . -B build-no-boost -DBUILD_TESTING=ON
```

fails with a clear message, and:

```console
cmake -S . -B build-no-tests -DBUILD_TESTING=OFF
```

still configures if runtime dependencies are present.

**Acceptance criteria:**

- A contributor cannot accidentally run a build that silently has zero C++
  tests because Boost was missing.

### Task 1.2: Add root validation entry points

**Priority:** `P0`
**Finding covered:** no contributor-facing single entry point for C++,
services, docs, and release gates.
**Evidence:** no root `package.json` or `CMakePresets.json`; commands are
spread across service packages and `scripts/validate_release_gates.mjs`.
**Files:**

- Create: `CMakePresets.json`
- Create or modify: root `package.json` or `scripts/dev.mjs`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] Add CMake presets for common local flows:
  - `debug`
  - `release`
  - `debug-no-tests`
  - optional `fuzz` if local prerequisites are reasonable.
- [ ] Add root commands:
  - `check:quick` for whitespace, script tests, core service builds/tests, and
    focused C++ tests when `build/CTestTestfile.cmake` exists.
  - `check:cpp` for configure/build and CTest.
  - `check:services` for all three Cloudflare service packages.
  - `check:docs` for docs link check and docs build.
  - `check:full` as a wrapper around the existing release-gate runner.
- [ ] Reuse `scripts/validate_release_gates.mjs` where possible instead of
  duplicating its command contract.
- [ ] Make root commands print the focused next command when prerequisites are
  missing, for example "run cmake --preset debug first".
- [ ] Document the commands in README and CONTRIBUTING.

**Validation:**

```console
npm run check:quick
npm run check:services
npm run check:docs
node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local.json
```

**Acceptance criteria:**

- A new contributor can discover the correct fast and full validation commands
  from the repo root.
- Existing release-gate contract remains the source of truth for release
  evidence.

### Task 1.3: Pin and advertise Node and package setup requirements

**Priority:** `P1`
**Finding covered:** CI requires Node 22, but package metadata does not.
**Evidence:** workflows pin `node-version: "22"` and scripts use
`node --experimental-sqlite`.
**Files:**

- Create: `.node-version` or `.nvmrc`
- Modify: `services/*/package.json`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] Add a single Node version file with `22`.
- [ ] Add `engines.node` to each service `package.json`.
- [ ] Add a root bootstrap command that runs `npm ci` for all service packages.
- [ ] Make cross-service tests check or bootstrap the needed sibling package
  before running.
- [ ] Document Node 22, `uv`/`uvx`, CMake, Boost, OpenSSL, Doxygen, and
  Wrangler prerequisites in one setup section.

**Validation:**

```console
npm --prefix services/cloudflare-license-admin ci
npm --prefix services/cloudflare-licensing-backend ci
npm --prefix services/cloudflare-d1-backup ci
npm --prefix services/cloudflare-licensing-backend run test:e2e
```

**Acceptance criteria:**

- Running a service command with the wrong Node major fails early with a clear
  reason.
- Cross-service e2e setup no longer relies on undocumented sibling installs.

### Task 1.4: Bring stale toolchain documentation back to the CI baseline

**Priority:** `P1`
**Finding covered:** docs cite obsolete CMake/GCC/Visual Studio baselines.
**Files:**

- Modify: `README.md`
- Modify: `doc/development/Build-the-library.md`
- Modify: `doc/development/Build-the-library-windows.rst`
- Modify: `doc/development/Dependencies.md`

- [ ] Align documented CMake minimum with `cmake_minimum_required(VERSION 3.16
  FATAL_ERROR)`.
- [ ] Align Linux support examples with CI's Ubuntu 22.04 and 24.04 coverage.
- [ ] Align Windows support examples with Windows 2022/MSVC 2022 CI coverage.
- [ ] Label MinGW/cross-compile guidance as legacy unless a CI gate enforces it.
- [ ] Replace `make test` guidance with `ctest --test-dir build ... --no-tests=error`.

**Validation:**

```console
uv run --no-project python scripts/check_docs_links.py doc README.md CONTRIBUTING.md
uv run --no-project python scripts/build_docs.py
```

**Acceptance criteria:**

- The docs no longer direct contributors to an unsupported or unverified
  toolchain as the primary path.

---

## Phase 2 - Enforce C++ module and public API boundaries

### Task 2.1: Replace root/global include directories with target-scoped includes

**Priority:** `P1`
**Finding covered:** CMake does not enforce private module boundaries.
**Evidence:** root `include_directories(...)` makes broad include paths
available everywhere.
**Files:**

- Modify: `CMakeLists.txt`
- Modify: `src/library/CMakeLists.txt`
- Modify: subdirectory `CMakeLists.txt` files as needed.

- [ ] Remove or shrink root `include_directories(...)`.
- [ ] Move required public includes to `target_include_directories` on
  `licensecc_static`.
- [ ] Move private implementation includes to the object libraries that need
  them.
- [ ] Ensure test targets declare their own includes instead of relying on
  global state.
- [ ] Keep installed target usage unchanged for consumers.

**Validation:**

```console
cmake -S . -B build-clean -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=licensecc_ci -DLCC_PROJECTS_BASE_DIR=build-clean/projects
cmake --build build-clean --target install
ctest --test-dir build-clean --output-on-failure --no-tests=error
```

**Acceptance criteria:**

- The library and tests build without root-level include leakage.
- Install/package consumer smokes still pass.

### Task 2.2: Make internal test dependencies explicit

**Priority:** `P1`
**Finding covered:** tests include `../../src/library/...` directly.
**Files:**

- Modify: tests that include implementation headers directly.
- Modify: `test/**/CMakeLists.txt`
- Optional create: internal test support target under `src/library` or `test/support`.

- [ ] Inventory all direct implementation includes:

```console
rg -n "\.\./\.\./src/library" test
```

- [ ] Classify each include:
  - legitimate white-box unit test,
  - public API test that should stop peeking into internals,
  - integration test that needs a test-only seam.
- [ ] Add explicit internal test target/include exposure for legitimate
  white-box tests.
- [ ] Convert public/integration tests to public headers or test fixtures.
- [ ] Add the boundary scan to local gates once the inventory is clean or
  allowlisted.

**Validation:**

```console
rg -n "\.\./\.\./src/library" test
ctest --test-dir build -C Debug -R "test_public_api|test_anti_tamper|test_license_locator|test_crack" --output-on-failure
```

**Acceptance criteria:**

- Direct internal includes are intentional and documented, not accidental
  coupling.

### Task 2.3: Reduce generated-header coupling in the installed public API

**Priority:** `P1`
**Finding covered:** public API depends on generated project headers via
compile definitions.
**Evidence:** `datatypes.h` includes `LCC_PROJECT_CONFIG_HEADER`.
**Files:**

- Modify: `include/licensecc/datatypes.h`
- Modify: `include/licensecc/licensecc.h`
- Modify: generated templates under `src/templates/`
- Modify: `src/library/CMakeLists.txt`
- Modify: install/package smoke tests.

- [ ] Document the current generated-header contract with header-hygiene tests
  before changing behavior.
- [ ] Decide the target shape:
  - explicit installed project facade header, or
  - stable public header plus project-specific include path from target usage
    requirements.
- [ ] Keep private key/public key plumbing out of broad public compile
  definitions where possible.
- [ ] Add a consumer smoke that includes only the documented public header path.
- [ ] Preserve existing `find_package(licensecc REQUIRED COMPONENTS <project>)`
  behavior.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_install_consumer_smoke|test_package_consumer_smoke|test_public_api" --output-on-failure --no-tests=error
```

**Acceptance criteria:**

- The public API has a documented, tested include contract.
- Consumers do not need to understand generated source-tree paths.

---

## Phase 3 - Split C++ runtime policy into smaller, testable seams

### Task 3.1: Characterize current `acquire_license*` behavior before refactor

**Priority:** `P1`
**Finding covered:** `licensecc.cpp` is a hub facade.
**Files:**

- Modify: `test/library/public_api_test.cpp`
- Modify: `test/library/anti_tamper_test.cpp`
- Modify: `test/library/online_verification_test.cpp`

- [ ] Add or confirm tests for:
  - ordinary license failures are not masked by tamper or online checks,
  - `acquire_license` keeps legacy behavior,
  - `acquire_license_ex` clears `license_out` on runtime hardening failure,
  - `lcc_acquire_license_decision` requires online and revocation-floor
    callbacks,
  - audit events remain exported in the same order/severity expected today.
- [ ] Add test names to the checklist evidence before refactoring.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_public_api|test_anti_tamper|test_online_verification" --output-on-failure --no-tests=error
```

**Acceptance criteria:**

- Refactor work has behavior coverage around the exported C API.

### Task 3.2: Extract an internal license acquisition service

**Priority:** `P1`
**Finding covered:** `licensecc.cpp` mixes C API adaptation and core
acquisition.
**Files:**

- Create: `src/library/license_acquisition/` or similar local module.
- Modify: `src/library/licensecc.cpp`
- Modify: `src/library/CMakeLists.txt`

- [ ] Move `AcquiredLicenseContext`, `VerifiedLicenseCandidate`, license
  merging, fingerprint selection, and base `LicenseReader`/`LicenseVerifier`
  orchestration into an internal acquisition service.
- [ ] Keep C structs and exported API functions in `licensecc.cpp`.
- [ ] Return an internal result object containing:
  - event type,
  - exported `LicenseInfo`,
  - event registry,
  - acquired license context.
- [ ] Avoid changing public behavior.

**Validation:**

```console
cmake --build build --target licensecc_static
ctest --test-dir build -C Debug -R "test_license_reader|test_license_verifier|test_public_api" --output-on-failure
```

**Acceptance criteria:**

- `licensecc.cpp` no longer directly owns the full base acquisition workflow.
- Public functions remain thin adapters.

### Task 3.3: Extract runtime hardening and online decision collaborators

**Priority:** `P1`
**Finding covered:** tamper, online, revocation floors, and audit clearing are
coupled in one function.
**Files:**

- Create or modify: internal runtime hardening module.
- Modify: `src/library/licensecc.cpp`
- Modify: `src/library/online_verification/*`
- Modify: tests.

- [ ] Introduce a `RuntimeHardeningRequest` and `RuntimeHardeningResult`.
- [ ] Move tamper evaluation, online request assembly, revocation floor
  load/store, and fail-closed clearing rules behind the collaborator.
- [ ] Keep the invariant: runtime checks run only after base `LICENSE_OK`.
- [ ] Keep client hardening telemetry behavior unchanged.
- [ ] Add tests for revocation floor load/store failure paths.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_online_verification|test_anti_tamper|test_public_api" --output-on-failure --no-tests=error
```

**Acceptance criteria:**

- Adding a future online/tamper policy does not require editing unrelated C API
  adaptation code.

### Task 3.4: Move hardware strategy construction out of the abstract strategy

**Priority:** `P2`
**Finding covered:** OCP/DIP violation in `IdentificationStrategy`.
**Evidence:** `IdentificationStrategy::get_strategy` includes concrete
strategy headers and switches over the enum.
**Files:**

- Modify: `src/library/hw_identifier/identification_strategy.*`
- Modify: `src/library/hw_identifier/hw_identifier_facade.*`
- Optional create: `src/library/hw_identifier/strategy_factory.*`
- Modify: tests under `test/library/hw_identifier/`

- [ ] Leave `IdentificationStrategy` as the pure strategy contract.
- [ ] Move enum-to-concrete construction into a factory or registry owned by
  the facade/default policy layer.
- [ ] Add a fake strategy test if a registry is introduced.
- [ ] Preserve public enum behavior.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_hw_identifier|test_hw_identifier_facade|test_network|test_windows_disk_info" --output-on-failure --no-tests=error
```

**Acceptance criteria:**

- Adding a strategy no longer requires editing the abstract strategy
  implementation.

### Task 3.5: Add per-call source and strictness options

**Priority:** `P2`
**Finding covered:** process-global runtime policy.
**Evidence:** `lcc_set_environment_license_sources_enabled`,
`lcc_set_strict_source_fatal_enabled`, and `LocatorFactory` static atomics.
**Files:**

- Modify: `include/licensecc/datatypes.h`
- Modify: `include/licensecc/licensecc.h`
- Modify: `src/library/licensecc.cpp`
- Modify: `src/library/locate/LocatorFactory.*`
- Modify: tests.

- [ ] Add per-call source policy fields to `LicenseCheckOptions` or a future
  versioned options struct.
- [ ] Keep global setters as compatibility defaults.
- [ ] Update locator factory to accept per-call policy.
- [ ] Add parallel tests where two calls use different policy without toggling
  global state.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_public_api|test_license_locator|test_anti_tamper" --output-on-failure
```

**Acceptance criteria:**

- Multi-tenant hosts can avoid mutable process-global source policy for new
  calls.

---

## Phase 4 - Centralize license document and v201 schema rules

### Task 4.1: Create a typed internal license document

**Priority:** `P1`
**Finding covered:** string-key map and scattered field rules.
**Evidence:** `FullLicenseInfo` owns `std::map<std::string, std::string>
m_limits`.
**Files:**

- Modify: `src/library/LicenseReader.hpp`
- Modify: `src/library/LicenseReader.cpp`
- Modify: `src/library/limits/license_verifier.*`
- Modify: `src/library/base/v201_canonical_payload.*`
- Modify: tests.

- [ ] Add a typed `LicenseDocument` or `ParsedLicense` that separates:
  - source,
  - project/feature,
  - format version,
  - signature metadata,
  - date limits,
  - version limits,
  - client signature and source strength,
  - extra data.
- [ ] Keep raw string parsing at the reader boundary.
- [ ] Keep v200 behavior strict and characterized.
- [ ] Preserve signing/canonical payload bytes for existing golden vectors.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_license_reader|test_v201_canonical_payload|test_license_verifier|test_signature_verifier" --output-on-failure --no-tests=error
```

**Acceptance criteria:**

- Adding a new limit has a single typed location before it fans out to policy.

### Task 4.2: Centralize v201 schema and version parsing

**Priority:** `P1`
**Finding covered:** duplicated v201 allowed/required fields and version rules.
**Files:**

- Create or modify: `src/library/base/v201_schema.*`
- Modify: `src/library/LicenseReader.cpp`
- Modify: `src/library/base/v201_canonical_payload.cpp`
- Modify: `src/library/limits/license_verifier.cpp`
- Modify: tests.

- [ ] Move v201 allowed keys, required keys, canonical order, and version
  parsing into one module.
- [ ] Keep v200 rules separate so compatibility decisions remain explicit.
- [ ] Add tests that compare parser acceptance and canonical payload required
  field expectations.
- [ ] Add one test proving an invalid caller version and invalid license
  version limit fail in the documented ways.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_license_reader|test_v201_canonical_payload|test_license_verifier" --output-on-failure
```

**Acceptance criteria:**

- v201 field changes no longer require independent edits in parser,
  canonicalizer, and verifier.

---

## Phase 5 - Centralize Cloudflare entitlement contracts

### Task 5.1: Introduce a shared entitlement contract module

**Priority:** `P1`
**Finding covered:** entitlement status/field rules duplicated across schema,
admin Worker, verifier Worker, UI, and CLIs.
**Files:**

- Create: `services/shared/` or a package-local shared module that both
  relevant services can import.
- Modify: `services/cloudflare-license-admin/src/shared/api.ts`
- Modify: `services/cloudflare-license-admin/src/worker/index.ts`
- Modify: `services/cloudflare-license-admin/src/ui/operatorWorkflow.ts`
- Modify: `services/cloudflare-license-admin/scripts/sync-entitlement.mjs`
- Modify: `services/cloudflare-licensing-backend/src/index.ts`
- Modify: `services/cloudflare-licensing-backend/scripts/entitlement.mjs`

- [ ] Define shared constants for:
  - statuses,
  - max project length,
  - max feature length,
  - max note length,
  - max customer/license id length,
  - default/min/max assertion TTL,
  - hex fingerprint/device hash validation.
- [ ] Define runtime validators for entitlement input and patches.
- [ ] Reuse validators in admin Worker and CLI.
- [ ] Keep Worker-side validation authoritative.
- [ ] Decide whether UI uses the same runtime validator directly or wraps it
  with form-state parsing.

**Validation:**

```console
npm --prefix services/cloudflare-license-admin run build
npm --prefix services/cloudflare-license-admin run test
npm --prefix services/cloudflare-license-admin run test:ui
npm --prefix services/cloudflare-licensing-backend test
npm --prefix services/cloudflare-licensing-backend run schema:parity
```

**Acceptance criteria:**

- Status or TTL rule changes happen in one shared contract module.
- Admin, verifier, UI, and CLI tests all use the shared rules.

### Task 5.2: Generate or assert schema parity from the shared contract

**Priority:** `P1`
**Finding covered:** SQL/TS contract drift.
**Files:**

- Modify: `services/cloudflare-licensing-backend/scripts/check-schema-parity.py`
- Modify or create: contract tests in both service packages.
- Optional modify: `schema.sql` comments with generated markers.

- [ ] Extend schema parity checks to cover status values and field defaults.
- [ ] Check that `assertion_ttl_seconds` defaults and bounds match the shared
  contract.
- [ ] Check that nullable fields match API type expectations.
- [ ] Add tests that fail when SQL and TS contracts diverge.

**Validation:**

```console
npm --prefix services/cloudflare-licensing-backend run schema:parity
npm --prefix services/cloudflare-licensing-backend run test:sql
npm --prefix services/cloudflare-license-admin run test:sql
```

**Acceptance criteria:**

- Drift between `schema.sql` and runtime validators is caught locally.

### Task 5.3: Centralize entitlement SQL projection and audit JSON shapes

**Priority:** `P1`
**Finding covered:** entitlement row shape repeated in SQL projections, mutation
SQL, audit JSON, and idempotency JSON.
**Files:**

- Modify: `services/cloudflare-license-admin/src/worker/index.ts`
- Optional create: `services/cloudflare-license-admin/src/worker/entitlementSql.ts`
- Modify tests.

- [ ] Extract `ENTITLEMENT_COLUMNS`.
- [ ] Extract helpers for:
  - `SELECT ... FROM entitlements`,
  - returned row JSON shape,
  - audit `next_json`,
  - idempotency response JSON.
- [ ] Keep SQL parameter binding explicit.
- [ ] Add a test that a newly added column cannot be returned in one path but
  omitted from idempotency/audit without test failure.

**Validation:**

```console
npm --prefix services/cloudflare-license-admin run test
npm --prefix services/cloudflare-license-admin run test:sql
```

**Acceptance criteria:**

- Entitlement row projection changes have one implementation point.

---

## Phase 6 - Split the admin Worker by responsibility

### Task 6.1: Extract auth without route behavior changes

**Priority:** `P1`
**Finding covered:** admin Worker SRP violation.
**Files:**

- Create: `services/cloudflare-license-admin/src/worker/auth.ts`
- Modify: `services/cloudflare-license-admin/src/worker/index.ts`
- Modify: tests as needed.

- [ ] Move `Actor`, bearer parsing, timing-safe compare, JWKS cache,
  `authenticate`, `authenticateSync`, and `requireAdmin`.
- [ ] Keep response envelope codes unchanged.
- [ ] Keep dev bearer environment guard unchanged.
- [ ] Add focused tests for auth module if current worker tests are too broad.

**Validation:**

```console
npm --prefix services/cloudflare-license-admin run test
```

**Acceptance criteria:**

- Auth changes no longer require editing persistence or routing logic.

### Task 6.2: Extract repository and transactional write service

**Priority:** `P1`
**Finding covered:** SQL persistence and audit/idempotency mixed into routing.
**Files:**

- Create: `services/cloudflare-license-admin/src/worker/entitlementRepository.ts`
- Create: `services/cloudflare-license-admin/src/worker/entitlementService.ts`
- Modify: `services/cloudflare-license-admin/src/worker/index.ts`
- Modify: tests.

- [ ] Move D1 query helpers, `findEntitlement`, `listEntitlements`,
  `listEvents`, `summary`, and SQL projection helpers into repository module.
- [ ] Move create/patch/transition/sync and idempotency handling into service
  module.
- [ ] Preserve the invariant that entitlement write, audit event, and
  idempotency record commit atomically via D1 `batch`.
- [ ] Keep route response codes and envelope bodies unchanged.

**Validation:**

```console
npm --prefix services/cloudflare-license-admin run test
npm --prefix services/cloudflare-license-admin run test:ui
npm --prefix services/cloudflare-license-admin run test:sql
```

**Acceptance criteria:**

- `index.ts` is primarily routing and asset fallback.
- Repository/service modules have focused tests or are covered by unchanged
  worker tests.

### Task 6.3: Extract router and API envelope helpers

**Priority:** `P2`
**Finding covered:** routing, envelopes, and assets mixed with business logic.
**Files:**

- Create: `services/cloudflare-license-admin/src/worker/router.ts`
- Create: `services/cloudflare-license-admin/src/worker/http.ts`
- Modify: `services/cloudflare-license-admin/src/worker/index.ts`

- [ ] Move `json`, `envelope`, request id, body parsing, and route dispatch to
  small modules.
- [ ] Keep default export shape unchanged for Wrangler.
- [ ] Keep static asset fallback unchanged.

**Validation:**

```console
npm --prefix services/cloudflare-license-admin run build:worker
npm --prefix services/cloudflare-license-admin run test
npm --prefix services/cloudflare-license-admin run dry-run
```

**Acceptance criteria:**

- Worker entrypoint is small and expresses dependency wiring.

---

## Phase 7 - Clean smaller code smells after structural seams exist

### Task 7.1: Replace duplicated JSON parser in online callback examples

**Priority:** `P2`
**Finding covered:** brittle handwritten parser duplicated in examples.
**Files:**

- Modify: `examples/online_callback/main.cpp`
- Modify: `examples/online_callback/main_winhttp.cpp`
- Optional create: shared helper under `examples/online_callback/`.

- [ ] Factor the duplicated `extract_json_string` into one shared helper.
- [ ] Add minimal tests if examples have a test harness; otherwise add a
  comment limiting the parser to the documented Worker response shape.
- [ ] Prefer a tiny tested parser boundary over encouraging host apps to copy
  ad hoc parsing broadly.

**Validation:**

```console
cmake --build build --target online_callback
cmake --build build --target licensecc_static
```

**Acceptance criteria:**

- The examples no longer maintain two copies of the same JSON extraction logic.

### Task 7.2: Clarify future-only public API placeholders

**Priority:** `P2`
**Finding covered:** unimplemented `confirm_license` and `release_license`
remain discoverable public functions.
**Files:**

- Modify: `include/licensecc/licensecc.h`
- Modify: `src/library/licensecc.cpp`
- Modify: `test/library/public_api_test.cpp`

- [ ] Decide whether placeholders can be removed before a stable ABI promise.
- [ ] If retained, add compiler-visible deprecation where portable.
- [ ] Make docs and `lcc_strerror` expectations clear: these functions always
  return `PRODUCT_NOT_LICENSED` today.
- [ ] Add public API tests locking the documented placeholder behavior.

**Validation:**

```console
ctest --test-dir build -C Debug -R test_public_api --output-on-failure
```

**Acceptance criteria:**

- Callers are not encouraged to wire future-only APIs as if implemented.

---

## Phase 8 - Documentation and release evidence alignment

### Task 8.1: Use or document one docs-build entry point

**Priority:** `P1`
**Finding covered:** local docs and Read the Docs use different build paths.
**Files:**

- Modify: `.readthedocs.yaml`
- Modify: `scripts/build_docs.py`
- Modify: `README.md`
- Modify: docs build tests if present.

- [ ] Decide whether RTD should call `scripts/build_docs.py` or keep a
  different constrained path.
- [ ] If same helper: update `.readthedocs.yaml` and verify RTD-compatible
  command usage.
- [ ] If different path: document why RTD invokes Doxygen directly while local
  builds use the helper.
- [ ] Ensure both paths fail on Sphinx warnings and malformed docs links.

**Validation:**

```console
uv run --no-project python scripts/check_docs_links.py doc
uv run --no-project python scripts/build_docs.py
```

**Acceptance criteria:**

- Contributors know which docs command proves local doc health.

### Task 8.2: Document service dry-run gates in deploy guides

**Priority:** `P2`
**Finding covered:** online verifier README skips dry-run despite CI/script
support.
**Files:**

- Modify: `services/cloudflare-licensing-backend/README.md`
- Modify: `services/cloudflare-license-admin/README.md`
- Modify: `services/cloudflare-d1-backup/README.md`

- [ ] Make `npm run dry-run` part of each deploy checklist.
- [ ] State which config file each dry-run uses.
- [ ] Link dry-run to CI job names where useful.

**Validation:**

```console
npm --prefix services/cloudflare-licensing-backend run dry-run
npm --prefix services/cloudflare-license-admin run dry-run
npm --prefix services/cloudflare-d1-backup run dry-run
```

**Acceptance criteria:**

- Operators see a dry-run before deploy in each service guide.

### Task 8.3: Keep release-gate contracts as the canonical full check

**Priority:** `P1`
**Finding covered:** release-gate script is strong but not surfaced as the
daily/full command model.
**Files:**

- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `scripts/release_gate_contract.mjs` only if command contracts change.

- [ ] Document:
  - quick local evidence,
  - full local evidence,
  - external staging evidence,
  - production sign-off evidence.
- [ ] Explain when `--require-external` is expected to fail locally.
- [ ] Ensure root `check:full` delegates to `validate_release_gates.mjs --full`.

**Validation:**

```console
node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local.json
node scripts/assert_release_ready.mjs build/release-gates/quick-local.json
```

The second command is expected to fail for non-production quick evidence; the
failure should be clear and documented.

**Acceptance criteria:**

- Developers understand the difference between useful local evidence and
  production release evidence.

---

## Suggested execution order

1. Task 0.1 and 0.2: capture baseline and scans.
2. Task 1.1 and 1.2: make validation trustworthy and discoverable.
3. Task 1.3 and 1.4: remove setup/documentation drift.
4. Task 2.1 to 2.3: enforce C++ build and public-header boundaries.
5. Task 3.1 to 3.3: split `licensecc.cpp` only after characterization tests.
6. Task 4.1 and 4.2: centralize license schema once acquisition seams exist.
7. Task 5.1 to 5.3: centralize Cloudflare entitlement contracts and SQL shapes.
8. Task 6.1 to 6.3: split admin Worker responsibilities.
9. Task 7.1 to 7.2: clean smaller smells.
10. Task 8.1 to 8.3: align docs and release evidence.

## Final completion gate

- [ ] `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`
- [ ] `node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local.json`
- [ ] `npm --prefix services/cloudflare-license-admin run test`
- [ ] `npm --prefix services/cloudflare-license-admin run test:ui`
- [ ] `npm --prefix services/cloudflare-licensing-backend test`
- [ ] `npm --prefix services/cloudflare-licensing-backend run schema:parity`
- [ ] `npm --prefix services/cloudflare-d1-backup test`
- [ ] `uv run --no-project python scripts/check_docs_links.py doc README.md CONTRIBUTING.md`
- [ ] `uv run --no-project python scripts/build_docs.py`

Do not mark this checklist complete until every checked implementation task has
its own focused evidence and the final gate is either green or explicitly
documented with justified skips.
