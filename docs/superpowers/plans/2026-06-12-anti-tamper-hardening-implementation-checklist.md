# Anti-Tamper Hardening Implementation Checklist

**Date:** 2026-06-12
**Status:** completed local implementation checklist
**Source plan:** `docs/superpowers/plans/2026-06-12-anti-tamper-hardening-implementation-plan.md`
**Scope:** anti-tamper option validation, source-shadowing semantics, secure
decision composition, online callback failover, production examples, docs,
installed-package smoke coverage, and server-side posture telemetry.

**Local evidence recorded:** focused C++ anti-tamper/online tests, label
facets, installed/package consumer smokes, release-gate quick validation,
Cloudflare verifier tests, docs link/build checks, and `git diff --check` all
passed on 2026-06-12. Quick release-gate evidence was written to
`build/release-gates/quick-local.json`.

> **For implementers:** work this checklist in order. Mark an item checked only
> after recording the files changed and the focused validation command that
> passed. Keep behavior compatible unless an item explicitly changes policy.

## Priority Model

- `P0`: correctness, fail-closed behavior, or CI confidence gap.
- `P1`: production integration, security posture, or public API clarity.
- `P2`: polish, documentation drift, or optional observability improvement.

## Global Completion Rules

- [x] Every checked task records file evidence in the PR body or commit notes.
- [x] Every checked task records focused test evidence.
- [x] Public ABI struct sizes and enum values remain compatible unless a task
      explicitly introduces a versioned extension.
- [x] No docs or examples claim local tamper-proof enforcement.
- [x] Local posture signals remain advisory unless backed by server-side policy.
- [x] Existing unrelated worktree changes are not reverted.

---

## Phase 0 - Immediate Correctness And CI Gates

Goal: close the highest-risk correctness issue and make CI facets enforce the
new online/anti-tamper surface.

### Task 0.1: Validate `online_device_hash` before copying

**Priority:** `P0`
**Finding covered:** caller-provided `online_device_hash` is copied before the
source field is proven NUL-terminated.
**Files:**

- Modify: `src/library/anti_tamper/AntiTamper.cpp`
- Modify: `test/library/anti_tamper_test.cpp` or
  `test/library/online_verification_test.cpp`

- [x] Change `AntiTamper::normalize_options` to run a bounded source-length
      check on `options->online_device_hash` before any string copy.
- [x] Return `LICENSE_TAMPER_DETECTED` or the existing hardening validation
      failure path for a non-NUL-terminated source field.
- [x] Add a regression test using a fully filled device-hash buffer with no NUL.
- [x] Confirm valid max-length and ordinary device hashes still pass.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_anti_tamper|test_online_verification" --output-on-failure --no-tests=error
git diff --check
```

### Task 0.2: Reject reserved decision options

**Priority:** `P0`
**Finding covered:** `LccLicenseDecisionOptions.reserved` currently has no
defined semantics.
**Files:**

- Modify: `src/library/licensecc.cpp`
- Modify: `test/library/online_verification_test.cpp`

- [x] Fail closed when any `LccLicenseDecisionOptions.reserved` byte is nonzero.
- [x] Add a regression test for nonzero reserved bytes.
- [x] Confirm zeroed reserved bytes preserve current behavior.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_online_verification|test_public_api" --output-on-failure --no-tests=error
```

### Task 0.3: Fix CTest label audit metadata

**Priority:** `P0`
**Finding covered:** `test_online_callback_failover` is registered but missing
from the label-audit allowlist.
**Files:**

- Modify: `test/ctest_label_audit.cmake`

- [x] Add `test_online_callback_failover|security,public_api,online`.
- [x] Confirm label audit catches no missing discovered tests.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_ctest_label_audit|test_online_callback_failover" --output-on-failure --no-tests=error
```

### Task 0.4: Add CI facets for anti-tamper and online tests

**Priority:** `P0`
**Finding covered:** Linux/Windows CI facet loops omit dedicated `anti_tamper`
and `online` labels.
**Files:**

- Modify: `.github/workflows/linux.yml`
- Modify: `.github/workflows/windows.yml`
- Modify as needed: sanitizer workflow or release-gate scripts that enumerate
  label facets.

- [x] Add `anti_tamper` to Linux and Windows label loops.
- [x] Add `online` to Linux and Windows label loops.
- [x] Add the same labels to sanitizer facet loops where package/install
      exclusions already exist.
- [x] Confirm `--no-tests=error` is used for each label facet.

**Validation:**

```console
ctest --test-dir build -C Debug -L anti_tamper --output-on-failure --no-tests=error
ctest --test-dir build -C Debug -L online --output-on-failure --no-tests=error
```

---

## Phase 1 - Broaden Source-Shadowing Semantics

Goal: make strict source-shadowing detect suspicious rejected sources that are
hidden by a later valid source.

### Task 1.1: Extend source-shadowing signal classification

**Priority:** `P1`
**Finding covered:** only malformed and invalid-format candidates currently
count as source-shadowing.
**Files:**

- Modify: `src/library/anti_tamper/AntiTamper.cpp`
- Modify: `test/library/anti_tamper_test.cpp`

- [x] Treat `LICENSE_CORRUPTED` as a source-shadowing signal.
- [x] Treat `IDENTIFIERS_MISMATCH` as a source-shadowing signal.
- [x] Treat `PRODUCT_EXPIRED` as a source-shadowing signal.
- [x] Treat `PRODUCT_NOT_LICENSED` as a source-shadowing signal only when the
      surrounding event source is a rejected license candidate, not a missing
      optional path.
- [x] Keep `LICENSE_FILE_NOT_FOUND` out of strict source-shadowing unless the
      implementation adds an explicit source policy for required paths.
- [x] Preserve single-source failure codes instead of relabeling them as tamper.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_anti_tamper|test_public_api" --output-on-failure --no-tests=error
```

### Task 1.2: Add source-shadowing regression coverage

**Priority:** `P1`
**Files:**

- Modify: `test/library/anti_tamper_test.cpp`

- [x] Malformed environment license plus explicit valid path returns
      `LICENSE_TAMPER_DETECTED` under strict source fatal mode.
- [x] Corrupted-signature environment license plus explicit valid path returns
      `LICENSE_TAMPER_DETECTED`.
- [x] Wrong-machine or identifier-mismatch environment license plus explicit
      valid path returns `LICENSE_TAMPER_DETECTED`.
- [x] Disabled source-shadowing flag preserves non-tamper behavior.
- [x] Detail string includes the `source-shadowing` prefix and bounded source
      detail.

**Validation:**

```console
ctest --test-dir build -C Debug -R test_anti_tamper --output-on-failure --no-tests=error
```

---

## Phase 2 - Harden Decision Wrapper Composition

Goal: prove `lcc_acquire_license_decision()` fails closed and runs checks in the
intended order.

### Task 2.1: Add fail-closed ordering tests

**Priority:** `P0`
**Files:**

- Modify: `test/library/online_verification_test.cpp`
- Modify as needed: `test/library/anti_tamper_test.cpp`

- [x] Host-integrity failure denies before online callback and floor callbacks.
- [x] Source-shadowing failure denies before online callback and floor
      callbacks.
- [x] Revocation-floor load failure denies before online callback.
- [x] Local failures such as malformed, corrupted, expired, or wrong-machine
      licenses do not invoke tamper, online, or floor callbacks.
- [x] Missing floor callbacks fail closed when online verification is required.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_online_verification|test_anti_tamper" --output-on-failure --no-tests=error
```

### Task 2.2: Clarify decision-field semantics

**Priority:** `P1`
**Finding covered:** `tamper_enforced` means policy configured, not necessarily
that a host tamper probe ran.
**Files:**

- Modify: `include/licensecc/licensecc.h`
- Modify: `doc/api/public_api.rst`
- Modify tests if public API expectations are documented in assertions.

- [x] Document `LccLicenseDecision.tamper_enforced` precisely.
- [x] Add or update a test locking that field's intended value.
- [x] Avoid renaming or ABI-breaking field changes.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_public_api|test_online_verification" --output-on-failure --no-tests=error
```

---

## Phase 3 - Production Decision Host Example

Goal: provide one production-shaped example that composes host integrity, online
verification, backup verifier endpoints, and persisted revocation floors.

### Task 3.1: Add `examples/production_decision_host`

**Priority:** `P1`
**Files:**

- Create: `examples/production_decision_host/`
- Modify: examples CMake files.
- Modify as needed: shared online callback helper files.

- [x] Use `lcc_acquire_license_decision()`, not `acquire_license_ex()`.
- [x] Accept `--license PATH`.
- [x] Accept `--floor-store PATH`.
- [x] Accept repeated `--verifier-url URL` for primary and backup endpoints.
- [x] Accept optional `--allow-insecure-http-for-test`.
- [x] Reuse existing online callback transport helpers where possible.
- [x] Never print raw hardware identifiers, secrets, or full license
      fingerprints.

**Validation:**

```console
cmake --build build --target production_decision_host --config Debug
```

### Task 3.2: Add file-backed revocation-floor store

**Priority:** `P1`
**Files:**

- Modify or create: `examples/production_decision_host/*`
- Modify tests if an example test harness exists.

- [x] Implement load/store callbacks for `LccRevocationFloorRecord`.
- [x] Store only the maximum seen `revocation_seq`.
- [x] Use atomic write and replace semantics.
- [x] Deny if the floor store path is missing when online verification is
      required.
- [x] Deny on load or store failure.
- [x] Simulated restart with lower `revocation_seq` denies.
- [x] Higher `revocation_seq` advances the persisted floor.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_online_verification|test_install_consumer_smoke" --output-on-failure --no-tests=error
```

### Task 3.3: Add composable host-integrity probes

**Priority:** `P1`
**Files:**

- Modify or create: `examples/production_decision_host/*`
- Modify: `examples/anti_tamper_host/main.cpp`

- [x] Add a host-integrity callback that composes multiple best-effort probes.
- [x] Guard platform-specific probes with clear preprocessor checks.
- [x] Include Windows debugger-present detection where available.
- [x] Keep non-Windows behavior buildable and explicit.
- [x] Bound and sanitize all detail strings.
- [x] Document that these probes are tamper-resistant signals, not proof.

**Validation:**

```console
cmake --build build --target anti_tamper_host production_decision_host --config Debug
ctest --test-dir build -C Debug -R test_anti_tamper --output-on-failure --no-tests=error
```

---

## Phase 4 - Safer Example Transport And Online Callback DX

Goal: prevent examples from encouraging insecure transport defaults or unbounded
response handling.

### Task 4.1: Make example transport HTTPS-first

**Priority:** `P1`
**Files:**

- Modify: `examples/online_callback/main.cpp`
- Modify: `examples/online_callback/main_winhttp.cpp`
- Modify: `examples/online_callback/online_callback_common.hpp`
- Modify: `test/library/online_callback_failover_test.cpp`

- [x] Reject non-HTTPS verifier URLs by default.
- [x] Permit HTTP only with an explicit test/development override.
- [x] Cap verifier response body size.
- [x] Add failover tests for HTTP rejection and the response size cap.
- [x] Keep backup verifier failover behavior intact.

**Validation:**

```console
cmake --build build --target online_callback --config Debug
ctest --test-dir build -C Debug -R test_online_callback_failover --output-on-failure --no-tests=error
```

### Task 4.2: Lock request-body posture behavior

**Priority:** `P1`
**Files:**

- Modify: `test/library/online_callback_failover_test.cpp`

- [x] Assert request version 2 includes `client_hardening`.
- [x] Assert request version 1 omits `client_hardening`.
- [x] Confirm posture data remains telemetry, not local proof.

**Validation:**

```console
ctest --test-dir build -C Debug -R test_online_callback_failover --output-on-failure --no-tests=error
```

---

## Phase 5 - Documentation And Public API Contracts

Goal: make the recommended secure path discoverable and hard to misuse.

### Task 5.1: Document public hardening callbacks and structs

**Priority:** `P1`
**Files:**

- Modify: `include/licensecc/licensecc.h`
- Modify: `include/licensecc/datatypes.h`
- Modify: `doc/api/public_api.rst`

- [x] Add Doxygen comments for `LCC_HOST_INTEGRITY_CHECK`.
- [x] Add Doxygen comments for `LCC_ONLINE_CHECK`.
- [x] Add Doxygen comments for `LCC_REVOCATION_FLOOR_LOAD`.
- [x] Add Doxygen comments for `LCC_REVOCATION_FLOOR_STORE`.
- [x] Add Doxygen comments for `LccLicenseDecision`.
- [x] Add Doxygen comments for `LccRevocationFloorRecord`.
- [x] Add Doxygen comments for `LCC_CLIENT_HARDENING_*`.

**Validation:**

```console
uv run --no-project python scripts/build_docs.py
```

### Task 5.2: Remove stale policy wording

**Priority:** `P1`
**Files:**

- Modify: `README.md`
- Modify: `doc/usage/integration.rst`
- Modify: `doc/analysis/security-notes.rst`
- Modify: examples that mention audit mode.

- [x] Remove or mark historical stale "audit-mode" wording.
- [x] Replace it with binary disabled/enforce policy wording.
- [x] Keep explicit "tamper-resistant, not tamper-proof" language.
- [x] Add a docs grep gate or release-gate assertion for current-policy docs.

**Validation:**

```console
rg -n "audit-mode|tamper-proof" README.md doc examples include src test
uv run --no-project python scripts/check_docs_links.py doc README.md CONTRIBUTING.md
```

### Task 5.3: Add example progression documentation

**Priority:** `P2`
**Files:**

- Modify: `README.md`
- Modify: `doc/usage/integration.rst`
- Modify: `examples/README.md` if present.

- [x] Document the recommended progression:
      `minimal` -> `fail_closed_host` -> `anti_tamper_host` ->
      `online_callback` -> `production_decision_host`.
- [x] State which example is suitable for production-shaped integration.
- [x] State which examples are intentionally minimal or demonstrative.

**Validation:**

```console
uv run --no-project python scripts/check_docs_links.py doc README.md CONTRIBUTING.md
```

---

## Phase 6 - Installed Package And Release-Gate Coverage

Goal: prove hardened APIs work from installed/package artifacts, not only from
build-tree tests.

### Task 6.1: Extend installed consumer smoke coverage

**Priority:** `P1`
**Files:**

- Modify: `test/install_consumer_smoke.cmake`
- Modify: `test/package_consumer_smoke.cmake`

- [x] Add an installed consumer that calls `lcc_acquire_license_decision()`.
- [x] Use fake online and floor callbacks in the installed consumer.
- [x] Force or simulate `LICENSE_TAMPER_DETECTED` through installed headers and
      library artifacts.
- [x] Build or run `anti_tamper_host` from an installed package context, or add
      an equivalent installed-consumer test.

**Validation:**

```console
ctest --test-dir build -C Debug -R "test_install_consumer_smoke|test_package_consumer_smoke" --output-on-failure --no-tests=error
```

### Task 6.2: Include failover tests in release gates

**Priority:** `P1`
**Files:**

- Modify: `scripts/release_gate_contract.mjs`
- Modify: `scripts/validate_release_gates.mjs`

- [x] Include `test_online_callback_failover` in focused release-gate regexes
      where online tests are enumerated.
- [x] Ensure release-gate validation includes label audit.
- [x] Ensure release-gate validation includes anti-tamper and online facets.

**Validation:**

```console
node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local.json
```

---

## Phase 7 - Optional Server-Side Posture Semantics

Goal: improve verifier visibility without treating client-reported posture as
cryptographic proof.

### Task 7.1: Assert `client_hardening` logging behavior

**Priority:** `P2`
**Files:**

- Modify: `services/cloudflare-licensing-backend/src/index.ts`
- Modify: `services/cloudflare-licensing-backend/test/online-verifier.test.mjs`

- [x] Assert `client_hardening` is logged on allow paths.
- [x] Assert `client_hardening` is logged on deny paths.
- [x] Assert `client_hardening` remains absent from signed assertion payloads.
- [x] Assert `client_hardening` is not used as standalone allow/deny proof.

**Validation:**

```console
npm --prefix services/cloudflare-licensing-backend test
```

### Task 7.2: Record future protocol posture semantics

**Priority:** `P2`
**Files:**

- Modify: `doc/analysis/security-notes.rst`
- Modify: `services/cloudflare-licensing-backend/README.md`

- [x] Document current telemetry-only posture semantics.
- [x] Add a future protocol note for server-considered required posture bits.
- [x] Do not imply client posture is trustworthy by itself.

**Validation:**

```console
uv run --no-project python scripts/check_docs_links.py doc README.md CONTRIBUTING.md
```

---

## Suggested Execution Order

1. [x] Phase 0: correctness and CI metadata.
2. [x] Phase 2: decision-wrapper composition tests.
3. [x] Phase 1: broaden source-shadowing semantics.
4. [x] Phase 3: production decision host.
5. [x] Phase 4: safer transport and callback DX.
6. [x] Phase 5: docs and public API contracts.
7. [x] Phase 6: installed/package and release-gate proof.
8. [x] Phase 7: server-side posture observability.

## Final Completion Gate

- [x] `ctest --test-dir build -C Debug -R "test_ctest_label_audit|test_public_api|test_anti_tamper|test_online_verification|test_online_callback_failover" --output-on-failure --no-tests=error`
- [x] `ctest --test-dir build -C Debug -L anti_tamper --output-on-failure --no-tests=error`
- [x] `ctest --test-dir build -C Debug -L online --output-on-failure --no-tests=error`
- [x] `ctest --test-dir build -C Debug -R "test_install_consumer_smoke|test_package_consumer_smoke" --output-on-failure --no-tests=error`
- [x] `node scripts/validate_release_gates.mjs --quick --json-out build/release-gates/quick-local.json`
- [x] `npm --prefix services/cloudflare-licensing-backend test`
- [x] `uv run --no-project python scripts/check_docs_links.py doc README.md CONTRIBUTING.md`
- [x] `uv run --no-project python scripts/build_docs.py`
- [x] `git diff --check`

Do not mark this checklist complete until every checked implementation task has
focused evidence and all final completion gates are green or explicitly
documented with justified skips.
