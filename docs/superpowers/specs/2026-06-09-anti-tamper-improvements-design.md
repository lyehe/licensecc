# Anti-tamper improvements — design

**Date:** 2026-06-09
**Status:** draft for review
**Scope:** `src/library/anti_tamper/`, the `acquire_license_ex` / `lcc_acquire_license_decision` flow in `src/library/licensecc.cpp`, the online-verification request ABI, the Cloudflare verifier Worker, and `examples/`.

## Guiding principle

This is a *local* licensing library. On a machine the attacker fully controls they can patch the binary or hook `acquire_license`, and the security docs say so plainly. The principled design therefore **refuses security theater**: it does not pile brittle, trivially-bypassed detection heuristics (debugger-present, VM detection, process-list scans, self-hash) into core, because that is an unwinnable arms race, platform-specific maintenance debt, and — worst — a false sense of security.

The existing architecture already makes the right call: **core owns the mechanism** (run a signal → apply policy → emit an audit event), **the host owns product-specific detection policy** via callbacks. These improvements strengthen that split. The durable leverage is (a) the **server**, which the attacker does not control, and (b) **honesty** in what we claim.

## Current state (re-baselined 2026-06-09)

The core hardened during recent work; this design reflects the tree as it stands, not an earlier snapshot:

- `LCC_TAMPER_POLICY` is binary `{DISABLED, ENFORCE}` (no `AUDIT`). `lcc_init_license_check_options()` defaults to **`ENFORCE` + `STRICT_SOURCE_SHADOWING`** — fail-closed by default. `AntiTamperResult::severity()` is always `SVRT_ERROR`.
- `anti_tamper::evaluate()` produces signals from exactly two sources: the host `LCC_HOST_INTEGRITY_CHECK` callback and source-shadowing.
- `acquire_license_with_runtime_checks()` runs tamper **only after** the base license returns `LICENSE_OK` (ordinary license failures keep their codes — not masked), then runs online verification (`REQUIRE`, auto-engaged when a callback is set) with fail-closed revocation-floor `load`/`store`.
- `lcc_acquire_license_decision()` is the secure wrapper (online + tamper + persisted revocation floor).
- **Gap:** the tamper verdict computed at `licensecc.cpp:676` is never threaded into the `OnlineVerificationRequest` built at `:721`. The client→server request ABI (`LccOnlineRequest`) carries no tamper signal, so tamper evidence never reaches the verifier.
- Docs (`security-model.rst`, `security-notes.rst`) are honest: tamper-resistant, not tamper-proof.

## Non-goals (what we will NOT do)

- No debugger / VM / process-list / self-hash detection added to **core**.
- No documentation wording that implies the library is now tamper-proof.
- The verifier will **not** make allow/deny decisions from a client-supplied tamper signal in this version — see Move 1. It is telemetry, not enforcement.

## Move 2 — verify and lock the fail-closed flow (safe base, do first)

Most of this is already implemented; the work is to make it a *tested, locked* invariant rather than incidental behavior.

- Add/confirm C++ regression tests in `test/library/anti_tamper_test.cpp` (and the integration test) for: ENFORCE is the default; a tamper signal under ENFORCE yields `LICENSE_TAMPER_DETECTED` and clears `license_out`; an ordinary license failure (expired/mismatch/malformed) is **never** masked or overwritten by tamper/online logic; `normalize_options` rejects unknown tamper/online policy values; online auto-upgrades to `REQUIRE` when a callback is supplied.
- Add a short invariant comment at the tamper/online decision points in `acquire_license_with_runtime_checks` documenting "runtime checks run only on `LICENSE_OK`; fail closed; do not mask base failures."
- Close any residual gap surfaced while writing the tests (none known today).

**Risk:** very low; core-only; fully verifiable with `ctest`.

## Move 3 — honest host detector examples (no core change)

- Add example `LCC_HOST_INTEGRITY_CHECK` detectors under `examples/` (extend `examples/fail_closed_host` or add `examples/anti_tamper_host`): e.g. debugger-present (per-OS `#ifdef`), binary self-hash, parent-process check.
- Each example is **clearly labeled best-effort and bypassable**, with a README that restates the threat model and points to server-side entitlement checks as the durable control. The point is to give integrators a correct starting point while keeping brittle platform code out of core.

**Risk:** low; examples only; no library ABI or behavior change.

## Move 1 — server-anchored tamper telemetry (north star, do last)

Make local tamper evidence reach the verifier, where the attacker has no control, so it lands in the audit trail and can drive operator revocation.

- **C++ ABI (back-compatible extension):** extend `LccOnlineRequest` (version `1 → 2`, preserving the existing size/version-prefixed extension pattern) with a compact, fixed-size `tamper_signal` bitset (`uint32_t`): e.g. bit0 = host-integrity failed, bit1 = source-shadowing detected. **No free-form host text and no PII** — bounded, enumerated bits only. Populate it from the `AntiTamperResult` *before* the online call at `licensecc.cpp:721`. Under `DISABLED` tamper policy the field is `0`.
- **Protocol:** the host transport callback serializes the request to the Worker; add an **optional** bounded integer `tamper_signal` to the `/v1/verify` request body. Update `examples/online_callback` to forward it. Document the field in the protocol/online-verification docs.
- **Worker (`services/cloudflare-online-verifier`):** `validateVerifyRequest` accepts an optional bounded non-negative integer `tamper_signal` (reject out-of-range; default 0); the verifier **logs** it in the structured `verify.*` event and MAY record it for audit. By default it does **not** change the allow/deny decision.
- **Why telemetry, not enforcement (and why spoofing is fine):** a controlled client can lie — set the bit when clean or clear it when tampered. That is acceptable because the signal is *evidence from honest clients*, not an authorization input. Treating a client-supplied bit as deny-input would let an attacker both evade (clear it) and grief (set it for others is impossible since it is per-request) — and would make the verifier a tamper-policy engine. Recording it preserves the durable value (operators can investigate/revoke) with zero new attack surface.

**Risk:** medium; spans C++ ABI + example + Worker + protocol doc. Sequenced last and shipped as its own increment behind the established versioned-ABI pattern.

## Sequencing

1. **Move 2** — verify/lock fail-closed + tests (safe base).
2. **Move 3** — honest host examples (no core risk).
3. **Move 1** — server-anchored tamper telemetry (ABI + protocol + Worker).

Each increment is independently shippable and independently verifiable.

## Testing strategy

- **Move 2:** `test/library/anti_tamper_test.cpp` unit + integration assertions listed above; `ctest` green on Debug + Release.
- **Move 3:** examples compile in CI; README threat-model wording reviewed; no behavior assertions on core.
- **Move 1:** C++ test that `tamper_signal` is populated from the tamper verdict and zero under `DISABLED`; Worker test that `validateVerifyRequest` accepts/bounds/logs the optional field and that allow/deny is unaffected by it; a cross-language protocol fixture if one exists for the request shape.

## Risks and mitigations

- **Concurrent edits / moving target:** the core is under active development (this design already had to be re-baselined mid-session). Implement in the small increments above, re-grounding against current source before each, and keep each increment self-contained.
- **ABI compatibility:** the `LccOnlineRequest` extension must preserve the existing size/version negotiation so older hosts keep working; covered by a normalize/version test.
- **Privacy:** the tamper signal is a fixed enumerated bitset, never host free-text, so no PII leaves the device.
