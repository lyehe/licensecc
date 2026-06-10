# Anti-tamper improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a best-effort host-integrity example and route the local tamper verdict to the Cloudflare verifier as audit telemetry, without adding brittle detection to core or weakening any guarantee.

**Architecture:** Two independent, sequenced increments. Part A (Move 3) is an example only — no library change. Part B (Move 1) extends the online-verification *request* (client→server) with a fixed enumerated `tamper_signal` bitset that the verifier records for audit/operator action; it is telemetry, never allow/deny input, and the signed assertion is untouched.

**Tech Stack:** C++17 core (`src/library`), CMake + Boost.Test, Cloudflare Worker (TypeScript, `services/cloudflare-online-verifier`), Node test runner.

**Spec:** `docs/superpowers/specs/2026-06-09-anti-tamper-improvements-design.md`

---

## Already done — Move 2 (verify/lock fail-closed): NO WORK

Re-grounding shows the fail-closed flow is implemented and locked by tests; do **not** re-implement it. Evidence in `test/library/anti_tamper_test.cpp`: `default_policy_records_tamper_error_and_denies_license` (ENFORCE is the default, tamper→`LICENSE_TAMPER_DETECTED`, `license_version` cleared to 0), `invalid_license_result_is_not_masked_by_tamper_callback` (ordinary failure not masked, callback not even called), `invalid_options_fail_closed_with_malformed`, `v1_options_size_remains_accepted_and_ignores_online_tail` (ABI back-compat), `legacy_acquire_license_does_not_emit_tamper_signal`. The only optional addition is a one-line invariant comment (Task A0).

## File structure

- `src/library/licensecc.cpp` — add invariant comment (A0); thread tamper bitset into the online request (B2).
- `include/licensecc/datatypes.h` — extend `LccOnlineRequest` with `tamper_signal`, bump `LCC_ONLINE_REQUEST_VERSION` (B1).
- `src/library/online_verification/OnlineVerification.hpp/.cpp` — carry `tamper_signal` on `OnlineVerificationRequest` and set it on the public `LccOnlineRequest` (B2).
- `examples/anti_tamper_host/` (new: `CMakeLists.txt`, `main.cpp`, `README.md`) — best-effort host-integrity example (A1–A3).
- `examples/online_callback/main.cpp` — forward `tamper_signal` in the request body (B4).
- `services/cloudflare-online-verifier/src/index.ts` — accept/bound/log optional `tamper_signal` in `validateVerifyRequest`, never use it for allow/deny (B3).
- `services/cloudflare-online-verifier/test/online-verifier.test.mjs` — tests for B3.
- `doc/analysis/security-model.rst` (or online-verification doc) — document the telemetry field + its honest semantics (B5).

---

## Part A — Move 3: honest host-integrity example (no core change)

### Task A0: Lock the fail-closed invariant with a comment

**Files:**
- Modify: `src/library/licensecc.cpp` (in `acquire_license_with_runtime_checks`, at the tamper/online decision block — re-locate by content, it begins `if (result == LICENSE_OK) {` followed by the `AntiTamperRequest` construction).

- [ ] **Step 1: Add the comment above the first `if (result == LICENSE_OK) {` that builds the `AntiTamperRequest`.**

```cpp
	// INVARIANT: runtime checks run ONLY after the base license returns LICENSE_OK, so an ordinary
	// license failure (expired/mismatch/malformed) is never masked or overwritten. Tamper under ENFORCE
	// and a failed required online check both fail closed (clear license_out, return the failure code).
	// Do not reorder these so a runtime check can run before the base verdict, or hide a base failure.
	if (result == LICENSE_OK) {
```

- [ ] **Step 2: Build to verify it still compiles.**

Run: `cmake --build build --target licensecc_static` (or the project's configured build dir)
Expected: builds clean.

- [ ] **Step 3: Commit.**

```bash
git add src/library/licensecc.cpp
git commit -m "docs(core): document the fail-closed runtime-check invariant"
```

### Task A1: Create the host-integrity example skeleton + CMake

**Files:**
- Create: `examples/anti_tamper_host/CMakeLists.txt`
- Create: `examples/anti_tamper_host/main.cpp`
- Modify: `examples/CMakeLists.txt` if it enumerates subdirectories (check first with `grep -n add_subdirectory examples/CMakeLists.txt`; mirror how `online_callback` is added).

- [ ] **Step 1: Write `examples/anti_tamper_host/main.cpp`** — a runnable example that uses `acquire_license_ex` with a host integrity callback. The callback is deliberately trivial and labeled best-effort.

```cpp
// Best-effort host-integrity example.
//
// IMPORTANT: this is NOT tamper-proof. A host_integrity_check is a best-effort signal on a machine the
// attacker may fully control; it can be patched out or hooked. Treat it as one input to a layered defense
// (server-side entitlement checks, online verification, telemetry), never as a guarantee.
#include <cstdio>
#include <cstring>

#include <licensecc/licensecc.h>

namespace {

// Replace the body with product-specific best-effort checks (e.g. a debugger probe, a self-measurement,
// a parent-process check). Return false to signal a tamper suspicion; write a short reason into detail_out.
bool host_integrity_check(void* user_data, char* detail_out, size_t detail_out_size) {
	(void)user_data;
	const bool suspicious = false;  // demo: always "clean"; real hosts implement a check here.
	if (suspicious && detail_out != nullptr && detail_out_size > 0) {
		std::snprintf(detail_out, detail_out_size, "example: integrity probe failed");
		return false;
	}
	return true;
}

}  // namespace

int main(int argc, char** argv) {
	if (argc < 2) {
		std::fprintf(stderr, "usage: %s <license-path>\n", argv[0]);
		return 2;
	}
	lcc_set_environment_license_sources_enabled(false);

	LicenseLocation location;
	if (!lcc_set_license_path(&location, argv[1])) {
		std::fprintf(stderr, "license path is too long\n");
		return 2;
	}
	CallerInformations caller;
	lcc_init_caller_informations(&caller);

	LicenseCheckOptions options;
	lcc_init_license_check_options(&options);  // tamper_policy defaults to LCC_TAMPER_ENFORCE
	options.host_integrity_check = host_integrity_check;

	LicenseInfo info{};
	const LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);
	if (result == LICENSE_OK) {
		std::printf("license OK (runtime integrity check passed)\n");
		return 0;
	}
	char message[LCC_API_ERROR_BUFFER_SIZE];
	print_error(message, &info);
	std::fprintf(stderr, "denied: %s\n  detail: %s\n", lcc_strerror(result), message);
	return 1;
}
```

- [ ] **Step 2: Write `examples/anti_tamper_host/CMakeLists.txt`** — copy the structure of `examples/online_callback/CMakeLists.txt` (read it first), changing the target name and source to `anti_tamper_host` / `main.cpp`. Use the same `find_package`/link to `licensecc::licensecc_static` that the sibling example uses.

- [ ] **Step 3: Register the example** if `examples/CMakeLists.txt` lists subdirectories: add `add_subdirectory(anti_tamper_host)` next to the existing `add_subdirectory(online_callback)`.

- [ ] **Step 4: Configure + build the example to verify it compiles and links.**

Run: `cmake --build build --target anti_tamper_host` (after re-running cmake configure so the new subdir is picked up)
Expected: builds clean.

- [ ] **Step 5: Commit.**

```bash
git add examples/anti_tamper_host examples/CMakeLists.txt
git commit -m "examples: add best-effort host-integrity (acquire_license_ex) example"
```

### Task A2: README that restates the threat model

**Files:**
- Create: `examples/anti_tamper_host/README.md`

- [ ] **Step 1: Write the README** — explain what `host_integrity_check` is for, that the default tamper policy is `ENFORCE` (a `false` return denies the license with `LICENSE_TAMPER_DETECTED`), and a prominent "best-effort, not tamper-proof; combine with server-side entitlement checks and online verification" note. Show the build/run commands mirroring `examples/online_callback/README.md`.

- [ ] **Step 2: Run the repo docs link check (it scans text files) to ensure no malformed links.**

Run: `uv run --no-project python scripts/check_docs_links.py examples`
Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add examples/anti_tamper_host/README.md
git commit -m "docs(examples): document the best-effort host-integrity example"
```

---

## Part B — Move 1: server-anchored tamper telemetry

> **Re-ground before starting B1–B2:** the core is under active development. Before editing, re-read the CURRENT `include/licensecc/datatypes.h` (`LccOnlineRequest`, `LCC_ONLINE_REQUEST_VERSION`), `src/library/online_verification/OnlineVerification.hpp/.cpp` (`OnlineVerificationRequest`, `evaluate()` where it builds the public `LccOnlineRequest`), and `src/library/licensecc.cpp` (`acquire_license_with_runtime_checks`, the tamper block ~`AntiTamperResult` and the `OnlineVerificationRequest` build). Confirm field names/positions before applying edits.

### Task B1: Extend the online-request ABI with a tamper bitset

**Files:**
- Modify: `include/licensecc/datatypes.h`

- [ ] **Step 1: Add tamper-signal bit constants near `LCC_ONLINE_FLAG_NONE`.**

```c
#define LCC_TAMPER_SIGNAL_NONE 0u
#define LCC_TAMPER_SIGNAL_HOST_INTEGRITY 0x00000001u
#define LCC_TAMPER_SIGNAL_SOURCE_SHADOWING 0x00000002u
```

- [ ] **Step 2: Bump the request version and add the field to `LccOnlineRequest` (append at the end to preserve the size/version-prefixed layout).**

```c
#define LCC_ONLINE_REQUEST_VERSION 2u
```

In `struct LccOnlineRequest`, append after `timeout_ms`:

```c
	uint32_t tamper_signal;  // bitset of LCC_TAMPER_SIGNAL_*; 0 when tamper policy is disabled or clean
```

- [ ] **Step 3: Build the static lib to verify the header still compiles.**

Run: `cmake --build build --target licensecc_static`
Expected: builds clean (the field is additive).

- [ ] **Step 4: Commit.**

```bash
git add include/licensecc/datatypes.h
git commit -m "feat(api): add tamper_signal to LccOnlineRequest (version 2)"
```

### Task B2: Populate `tamper_signal` from the tamper verdict

**Files:**
- Modify: `src/library/online_verification/OnlineVerification.hpp` (add `uint32_t tamper_signal = 0;` to `OnlineVerificationRequest`)
- Modify: `src/library/online_verification/OnlineVerification.cpp` (`evaluate()`: set `public_request.tamper_signal = request.tamper_signal;` where it fills the other `public_request` fields, and set `public_request.version = LCC_ONLINE_REQUEST_VERSION;` — already set, just confirm)
- Modify: `src/library/licensecc.cpp` (`acquire_license_with_runtime_checks`: compute a bitset from the `AntiTamperResult` and assign it to the online request before `online_verification::evaluate`)
- Modify: `src/library/anti_tamper/AntiTamper.hpp/.cpp` (add a helper that maps the result's signals to the bitset; or expose the bits on `AntiTamperResult`)

- [ ] **Step 1 (test first): add a unit assertion** in `test/library/online_verification_test.cpp` (or `anti_tamper_test.cpp`) that, given a tamper signal under a non-disabled policy, the `OnlineVerificationRequest` carries `tamper_signal != 0`, and is `0` when tamper is `DISABLED`. Use the existing test scaffolding (a fake `online_check` callback that captures the `LccOnlineRequest`). Write the assertion against a small seam: have the fake callback record `request->tamper_signal` and assert it.

- [ ] **Step 2: Run it and confirm it fails** (field not yet populated).

Run: `ctest --test-dir build -R online_verification --output-on-failure` (or the anti-tamper test name)
Expected: FAIL.

- [ ] **Step 3: Add `tamper_signal` to `OnlineVerificationRequest`** (`OnlineVerification.hpp`) and set `public_request.tamper_signal = request.tamper_signal;` in `evaluate()` (`OnlineVerification.cpp`).

- [ ] **Step 4: In `licensecc.cpp`**, after the tamper `evaluate()` result is known and before building the `OnlineVerificationRequest`, derive the bitset. Map: a `HostIntegrityCheck` signal → `LCC_TAMPER_SIGNAL_HOST_INTEGRITY`; a source-shadowing signal → `LCC_TAMPER_SIGNAL_SOURCE_SHADOWING`. Assign `request.tamper_signal = bitset;`. (Add an `AntiTamper` helper `uint32_t tamper_signal_bits(const AntiTamperResult&)` keyed off `signal.license_reference` to avoid string matching in `licensecc.cpp`.)

- [ ] **Step 5: Run the test to confirm it passes; run the full anti-tamper + online suites.**

Run: `ctest --test-dir build -R "online_verification|anti_tamper" --output-on-failure`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add include/licensecc/datatypes.h src/library/online_verification src/library/anti_tamper src/library/licensecc.cpp test/library
git commit -m "feat(core): carry local tamper signal into the online verification request"
```

### Task B3: Verifier accepts, bounds, logs `tamper_signal` (telemetry only)

**Files:**
- Modify: `services/cloudflare-online-verifier/src/index.ts` (`VerifyRequest` type + `validateVerifyRequest` + the `verify.*` log call)
- Test: `services/cloudflare-online-verifier/test/online-verifier.test.mjs`

> Re-read `validateVerifyRequest` and the log call first; match the existing validation style (`safeString`/bounded-int helpers) and the structured-log shape.

- [ ] **Step 1 (test first): add a node:test** asserting (a) a request with `tamper_signal: 3` is accepted and the response is unchanged vs. no signal (allow/deny identical — telemetry only), and (b) a malformed `tamper_signal` (negative, non-integer, or > a small max like 0xffff) is rejected with `invalid_request` OR coerced to absent — pick reject-and-bound to match the existing strictness. Assert the entitlement decision does not change with vs. without the field.

- [ ] **Step 2: Run it; confirm it fails.**

Run: `cd services/cloudflare-online-verifier && npm test`
Expected: FAIL (field not validated yet).

- [ ] **Step 3: Add an optional `tamper_signal?: number` to `VerifyRequest`**, validate it in `validateVerifyRequest` as a non-negative integer `<= 0xffff` (default `0`/absent), and include `tamper_signal` in the structured `verify.ok` / `verify.denied` log fields. Do NOT branch allow/deny on it.

- [ ] **Step 4: Run tests.**

Run: `cd services/cloudflare-online-verifier && npm test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add services/cloudflare-online-verifier/src/index.ts services/cloudflare-online-verifier/test/online-verifier.test.mjs
git commit -m "feat(verifier): record optional tamper_signal as audit telemetry (not allow/deny)"
```

### Task B4: Forward `tamper_signal` from the example callback

**Files:**
- Modify: `examples/online_callback/main.cpp` (and `main_winhttp.cpp` if it builds the same JSON body)

- [ ] **Step 1: In the request-body serialization, include `tamper_signal`** from `request->tamper_signal` (guard on `request->version >= 2` / `request->size` covering the field). Read the current body-building code first and add the integer field to the JSON in the same style.

- [ ] **Step 2: Build the example.**

Run: `cmake --build build --target online_callback`
Expected: builds clean.

- [ ] **Step 3: Commit.**

```bash
git add examples/online_callback
git commit -m "examples: forward tamper_signal in the online verification request body"
```

### Task B5: Document the telemetry field honestly

**Files:**
- Modify: `doc/analysis/security-model.rst` (online verification section) and/or `services/cloudflare-online-verifier/README.md`

- [ ] **Step 1: Add a short paragraph**: the client→server request may include a `tamper_signal` bitset reflecting local best-effort tamper detection; the verifier records it for audit and operator action (e.g. investigate/revoke) but does NOT use it for allow/deny because a controlled client can spoof it. No PII; fixed enumerated bits only.

- [ ] **Step 2: Docs link check.**

Run: `uv run --no-project python scripts/check_docs_links.py doc`
Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add doc services/cloudflare-online-verifier/README.md
git commit -m "docs: document the tamper_signal telemetry field and its semantics"
```

---

## Self-review

- **Spec coverage:** Move 2 → marked done with test evidence (Task A0 comment only). Move 3 → Tasks A1–A2. Move 1 → Tasks B1–B5 (ABI, populate, verifier, example, docs). All spec sections mapped.
- **Placeholder scan:** code shown for the example, the ABI field, the bit constants, the invariant comment. B2/B3/B4 reference existing functions that must be re-read at execution (the tree is volatile) — flagged explicitly at the top of Part B; field names and the bit semantics are concrete.
- **Type consistency:** `tamper_signal` is `uint32_t` in `LccOnlineRequest` (B1), `OnlineVerificationRequest` (B2), and bounded `<= 0xffff` in the verifier (B3); bit constants `LCC_TAMPER_SIGNAL_*` defined once in B1 and reused.
- **Scope:** two independent shippable parts; Part A has no library change, Part B is additive ABI + telemetry. No allow/deny behavior change anywhere.
