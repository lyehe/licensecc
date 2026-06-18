# Anti-Tamper Hardening Implementation Plan

Date: 2026-06-12

This plan consolidates three independent review passes:

- Agent 1: core runtime, public ABI, anti-tamper, and online verification composition.
- Agent 2: host integration, examples, documentation, and developer experience.
- Agent 3: tests, CI labels, release/package smoke coverage, and docs drift.

Scope: improve tamper resistance and production integration without claiming local tamper-proof enforcement. A fully controlled customer machine can still patch binaries, hook APIs, replace libraries, or spoof local state.

## Highest Priority Findings

1. Public option normalization can read `online_device_hash` before proving the caller field is NUL-terminated.

   Evidence: `src/library/anti_tamper/AntiTamper.cpp` copies `options->online_device_hash` with `mstrlcpy` before bounded validation. This should be validated with `mstrnlen_s` on the source field before any string copy.

2. The newly added `test_online_callback_failover` is registered and labeled, but not listed in `test/ctest_label_audit.cmake`.

   Evidence: `test/library/CMakeLists.txt` adds/registers/labels the test, while `test/ctest_label_audit.cmake` rejects discovered tests missing from its expected list.

3. CI facet loops omit the dedicated `anti_tamper` and `online` labels.

   Evidence: `.github/workflows/linux.yml` and `.github/workflows/windows.yml` iterate security/parser/signature/etc. but not `anti_tamper` or `online`.

4. Strict source-shadowing only reports malformed/invalid-format shadow candidates.

   Evidence: `find_source_shadowing_signal()` currently checks `LICENSE_MALFORMED` and `FILE_FORMAT_NOT_RECOGNIZED`. Corrupted, expired, wrong-machine, or identifier-mismatch shadow candidates can be demoted when a later source succeeds.

5. Production-safe decision flow is documented but not demonstrated.

   Evidence: docs recommend `lcc_acquire_license_decision()`, but runnable online examples still center `acquire_license_ex()` and therefore only get process-local rollback floors.

6. Host integrity guidance is currently a stub.

   Evidence: `examples/anti_tamper_host/main.cpp` hardcodes a clean result and does not provide composable probes, a failure policy, or privacy guidance for detail strings.

## Phase 0: Immediate Correctness And CI Gates

Goal: close current correctness/CI holes before larger hardening work.

Changes:

- In `AntiTamper::normalize_options`, validate `options->online_device_hash` with bounded source-length checks before copying it into `normalized`.
- Add regression tests for a non-NUL-terminated `online_device_hash`.
- Reject nonzero `LccLicenseDecisionOptions.reserved` until it has defined semantics.
- Add `test_online_callback_failover|security,public_api,online` to `test/ctest_label_audit.cmake`.
- Add `anti_tamper` and `online` to Linux/Windows CI label loops.
- Add `anti_tamper` and `online` to sanitizer label loops where package/install exclusions are already handled.

Acceptance:

- `ctest --test-dir build -C Debug -R "test_ctest_label_audit|test_public_api|test_anti_tamper|test_online_callback_failover" --output-on-failure --no-tests=error`
- `ctest --test-dir build -C Debug -L anti_tamper --output-on-failure --no-tests=error`
- `ctest --test-dir build -C Debug -L online --output-on-failure --no-tests=error`
- `git diff --check`

## Phase 1: Broaden Source-Shadowing Semantics

Goal: make strict source-shadowing mean "a suspicious rejected source was shadowed by a later valid source," not only malformed/format failures.

Changes:

- Extend source-shadowing detection to consider source-level warning/error events such as:
  - `LICENSE_CORRUPTED`
  - `IDENTIFIERS_MISMATCH`
  - `PRODUCT_EXPIRED`
  - `PRODUCT_NOT_LICENSED`
- Keep `LICENSE_FILE_NOT_FOUND` out of strict shadowing unless there is a clear reason to treat missing optional paths as suspicious.
- Preserve legacy `acquire_license()` behavior unless global `lcc_set_strict_source_fatal_enabled(true)` is enabled.
- Ensure single-source failures keep their original failure code and are not relabeled as tamper.

Tests:

- Malformed env data plus explicit valid path still returns `LICENSE_TAMPER_DETECTED` under `acquire_license_ex()`.
- Corrupted signature env data plus explicit valid path returns `LICENSE_TAMPER_DETECTED`.
- Wrong-machine or identifier mismatch env data plus explicit valid path returns `LICENSE_TAMPER_DETECTED`.
- Flag disabled: same shadow candidate does not produce `LICENSE_TAMPER_DETECTED`.
- Detail string includes the `source-shadowing` prefix and bounded source detail.

Acceptance:

- `ctest --test-dir build -C Debug -R "test_anti_tamper|test_public_api" --output-on-failure --no-tests=error`

## Phase 2: Harden Decision Wrapper Composition

Goal: prove `lcc_acquire_license_decision()` fails closed in every relevant composition branch.

Changes:

- Add tests where decision wrapper denies on host-integrity failure before online callback and floor callbacks run.
- Add tests where source-shadowing denies before online callback and floor callbacks run.
- Add tests where revocation-floor load failure denies before online callback runs.
- Add tests where local failures such as malformed, corrupted, expired, or wrong-machine licenses do not invoke tamper, online, or floor callbacks.
- Clarify that `LccLicenseDecision.tamper_enforced` currently means "enforce policy configured" rather than "tamper check evaluated."

Acceptance:

- `ctest --test-dir build -C Debug -R "test_online_verification|test_anti_tamper" --output-on-failure --no-tests=error`

## Phase 3: Production Decision Host Example

Goal: provide one copyable production-shaped integration path.

New example: `examples/production_decision_host/`

Behavior:

- Uses `lcc_acquire_license_decision()`, not `acquire_license_ex()`.
- Accepts:
  - `--license PATH`
  - `--floor-store PATH`
  - `--verifier-url URL` repeated for primary/backup endpoints
  - optional test-only `--allow-insecure-http-for-test`
- Reuses the online callback transport helper where possible.
- Implements a small file-backed revocation-floor store with save-max semantics.
- Uses atomic write/replace for the floor store.
- Includes a host-integrity callback that composes multiple best-effort probes behind clear platform guards.
- Never logs raw hardware identifiers, secrets, or full license fingerprints.

Acceptance:

- Example builds with `-DLCC_BUILD_EXAMPLES=ON`.
- Clean path allows a valid license when online assertion and floor store succeed.
- Forced host-integrity failure returns `LICENSE_TAMPER_DETECTED`.
- Missing floor callbacks or floor store path denies.
- Store failure denies.
- Simulated restart with lower `revocation_seq` denies.
- Higher `revocation_seq` advances persisted floor.

## Phase 4: Safer Example Transport And Host Integrity DX

Goal: reduce production copy-paste risk.

Changes:

- In `examples/online_callback`, reject non-HTTPS endpoints by default.
- Add an explicit test/development override for HTTP.
- Cap verifier response bodies.
- Add failover tests for HTTP rejection, response size cap, and request body `client_hardening` behavior.
- Replace the anti-tamper stub with realistic but clearly best-effort probes:
  - Windows debugger-present check.
  - Optional self-measurement hook or placeholder with exact integration comments.
  - Parent-process policy placeholder.
- Keep all warnings that local host integrity is not tamper-proof.

Acceptance:

- `ctest --test-dir build -C Debug -R "test_online_callback_failover|test_anti_tamper" --output-on-failure --no-tests=error`
- Examples still build on Windows and non-Windows supported configs.

## Phase 5: Documentation And Public API Contracts

Goal: make the secure path easy to discover and hard to misuse.

Changes:

- Update `doc/api/public_api.rst` to expose callback typedefs, hardening defines, revocation-floor records, and decision fields.
- Add Doxygen comments for:
  - `LCC_HOST_INTEGRITY_CHECK`
  - `LCC_ONLINE_CHECK`
  - `LCC_REVOCATION_FLOOR_LOAD`
  - `LCC_REVOCATION_FLOOR_STORE`
  - `LccLicenseDecision`
  - `LccRevocationFloorRecord`
  - `LCC_CLIENT_HARDENING_*`
- Remove or mark historical stale "audit-mode" wording.
- Add an example progression:
  - minimal
  - fail-closed host
  - anti-tamper host
  - online callback
  - production decision host
- Keep explicit "tamper-resistant, not tamper-proof" language in README, security notes, and integration docs.

Acceptance:

- Docs build successfully.
- Grep gate finds no current-policy docs claiming audit mode or tamper-proof guarantees outside historical plans.

## Phase 6: Installed Package And Release-Gate Coverage

Goal: prove hardened APIs work from installed/package artifacts, not only build-tree tests.

Changes:

- Extend install/package smokes with an installed consumer using `lcc_acquire_license_decision()`.
- Build or run `anti_tamper_host` from an installed package context, or add an equivalent installed-consumer test that forces `LICENSE_TAMPER_DETECTED`.
- Include `test_online_callback_failover` in focused release-gate regexes if those gates enumerate online tests explicitly.

Acceptance:

- Install and package smokes pass in CI.
- Release-gate validation includes anti-tamper, online verification, online callback failover, and label audit.

## Phase 7: Optional Server-Side Posture Semantics

Goal: improve server visibility without pretending client-reported posture is proof.

Changes:

- Keep `client_hardening` telemetry-only by default.
- Extend Cloudflare verifier tests to assert `client_hardening` is logged on allow and deny paths and remains absent from signed assertion payloads.
- Consider a future assertion protocol revision that records "server considered required posture bits" rather than "client posture is trustworthy."
- Do not use client-reported posture as cryptographic proof of host integrity.

Acceptance:

- Worker tests prove posture is logged, not signed, and not used as a standalone allow/deny proof unless a future explicit policy revision is implemented.

## Suggested Implementation Order

1. Phase 0, because it closes an immediate safety bug and CI metadata gap.
2. Phase 2 tests, because they protect behavior before larger examples are added.
3. Phase 1 source-shadowing broadening.
4. Phase 3 production decision host example.
5. Phase 4 transport/example hardening.
6. Phase 5 docs and API contracts.
7. Phase 6 release/package proof.
8. Phase 7 server-side posture semantics.

## Non-Goals

- No claim that Licensecc can make a customer-controlled machine trustworthy.
- No generic debugger, VM, injection, or self-hash checks in core by default.
- No ABI-breaking changes to existing public structs or enum values.
- No use of client-reported posture as cryptographic proof.
