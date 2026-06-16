# Structure Cleanup: shared signed-token core, service rename, naming clarity

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute task-by-task, and `superpowers:using-git-worktrees` for PHASE 0. Steps use checkbox (`- [ ]`) syntax. Do NOT skip PHASE 0; the working tree collides with every file move.

> **PLAN-FILE STATUS (correction):** This plan is supplied **inline only** — it is NOT yet written to disk. The path `docs/superpowers/plans/2026-06-15-structure-cleanup-shared-token-and-service-rename.md` does **not** exist; `docs/superpowers/plans/` currently contains files dated only up to **2026-06-14**. If you want this plan persisted, write it to that path as a first action; do not assume any cross-reference to it already resolves.

> **SHELL/TOOLING NOTE (correction — read before running any command):** The primary shell on this host is **PowerShell**, where `/tmp` paths and `rg` (ripgrep) do **NOT** exist (`which rg` returns empty; `rg` is not installed). The commands in this plan are written for **Git Bash** (POSIX). Either (a) run all shell snippets under **Git Bash**, or (b) translate to PowerShell equivalents. Concrete substitutions you MUST make:
> - `/tmp/lcc-wip-snapshot.txt` → a real, writable path. Git Bash: `/tmp/...` works. PowerShell: use `$env:TEMP\lcc-wip-snapshot.txt` (e.g. `C:\Users\HEQ\AppData\Local\Temp\lcc-wip-snapshot.txt`).
> - `rg -n "PATTERN" --glob '!...'` → use **`git grep -n "PATTERN" -- <pathspec>`** (verified available: `/mingw64/bin/git`) or the agent's **Grep tool**. `git grep` excludes untracked files; for sweeps that must include untracked scratch, prefer the Grep tool. Pathspec exclusions use `':(exclude)node_modules'` syntax, not `--glob`.
> - `git status --porcelain=v1` is fine under both shells (it is a git command, not a shell builtin).

**Goal:** Remove the highest-value structural debt in `licensecc` without changing public behavior: (1) extract the duplicated signed-token plumbing shared by `online_verification` and `config_attestation` into a `src/library/signed_token/` core; (2) rename `services/cloudflare-online-verifier/` to a multi-role name; (3) commit the untracked `0008` migration + `device-key.mjs` as the atomic prerequisite for the rename; (4) resolve `example/` vs `examples/` naming clarity (clarity only — `example/` stays); (5) resolve `doc/` vs `docs/` (lower-risk: kill the dead Doxygen stub, keep the orientation note, do NOT rename `docs/`).

**Strategy:** Sequence by dependency and by blast radius. The untracked-file commit gates the rename (a half-renamed migrations dir would break schema parity). The shared-token extraction is the riskiest C++ change, so it goes behind characterization tests first and is done on an isolated worktree off a clean tree. The service rename touches ~30+ fragile CI/script paths, so it is one mechanical pass with a single verification gate. The two naming-clarity workstreams are tiny and deferred to the end.

**Tech stack:** C++11, CMake (OBJECT libraries), Boost.Test/CTest (MSVC is ground truth — IGNORE clang/IDE diagnostics), Node 22 (`node --test`), Cloudflare Wrangler, `git mv`.

**Cross-plan alignment — read before starting:**
- This plan IS the "needs_clean_tree" / shared signed-token core effort referenced by `docs/superpowers/features/signed-config-token-status.md` (lines 14, 28, 35, 40) and `CLAUDE.md:157,179`. **WORKSTREAM A (shared token) below = the signed-config "Plan 2b" DRY-extraction deliverable. It is done HERE, not duplicated in Plan 2b.** When Plan 2b is written, its "shared-helper DRY extraction" task must be a one-line pointer to this plan, not a re-implementation. After Workstream A lands, update `signed-config-token-status.md` lines 28/40 to mark "shared-helper DRY — DONE here" and re-scope Plan 2b to key-gen/factory/floor/platform-SHA/example/docs only.
- **ACTIVE (not historical) signed-config docs that reference this work** and must be kept consistent rather than swept blindly into "DEFER": `docs/superpowers/specs/2026-06-14-signed-config-token-design.md` and `docs/superpowers/plans/2026-06-14-signed-config-token-plan-2a-public-api-signer.md`. Both are tracked and current (dated 2026-06-14, the latest plan date on disk). When Workstream B's repo-wide sweep finds `cloudflare-online-verifier` strings inside these two files, treat them as **active references to update**, not dated historical text to leave alone. Distinguish them from the genuinely historical dated RST checklists.
- This plan does NOT contradict `docs/superpowers/plans/2026-06-11-codebase-smells-solid-dx-implementation-checklist.md`. It complements it: that checklist's Phase 3-5 (split `licensecc.cpp`, centralize entitlement contracts) are OUT OF SCOPE here and remain that checklist's job. Workstream A here is a strict prerequisite-grade DRY seam the 06-11 checklist did NOT enumerate (the 06-11 checklist names the admin-Worker `services/shared/` extraction in Task 5.1 — that is a DIFFERENT extraction in TypeScript, not this C++ one). No overlap, no conflict.

**Prerequisites:**
- A clean-ish entry point: PHASE 0 commits/stashes all WIP. Do NOT begin any `git mv` while the tree is dirty.
- Boost present and `build/` configured (per MEMORY: Boost 1.87.0, `build/` already configured). If `build/` is stale, reconfigure: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug`.
- Node 22 for service tests (`node --experimental-sqlite` is used).
- `git worktree` available (fallback per `superpowers:using-git-worktrees`).

**Global git hygiene (every commit step):** stage ONLY the exact paths named. NEVER `git add -A` / `git add .` / `git commit -a`. The 06-11/2a WIP must not be swept into cleanup commits.

---

## PHASE 0 — WIP gate + untracked-file commit + isolated worktree (HARD PREREQUISITE)

The working tree has 34 modified + 10 untracked files (multi-feature WIP: anti-tamper, online verification, service hardening, relay-resistant UX). Every move in later phases collides with it. This phase ends with a clean tree on an isolated worktree.

### Task 0.1: Snapshot and preserve ALL existing WIP

- [ ] **Step 1 — record the starting state.** Run `git status --porcelain=v1 > /tmp/lcc-wip-snapshot.txt` (Git Bash) or `git status --porcelain=v1 > "$env:TEMP\lcc-wip-snapshot.txt"` (PowerShell) and `git stash list`. Keep the snapshot file for the duration.
- [ ] **Step 2 — decide WIP disposition with the user.** The WIP belongs to in-flight efforts (signed-config 2a, anti-tamper hardening, relay-resistant UX). DEFAULT: `git stash push --include-untracked -m "WIP before structure-cleanup 2026-06-15"` to set the whole tree aside — EXCEPT the two prerequisite files handled in Task 0.2, which must be committed first. **Order matters: do Task 0.2 BEFORE stashing**, because the stash would otherwise carry the untracked prerequisite files away.
- **Verification:** after Task 0.2 + stash, `git status --porcelain=v1` is empty.
- **Rollback:** `git stash pop` restores the WIP exactly.

### Task 0.2: Commit the untracked prerequisite files (0008 migration + device-key.mjs)

These two files are referenced by tracked-but-modified tests and `package.json`, and are required before the service rename can move `migrations/`. They have **zero commit history** (verified) and are part of the relay-resistance subsystem already documented in `CLAUDE.md:177-179`.

- [ ] **Step 1 — verify they are the only prerequisite untracked files.** Confirm exactly these two paths are untracked-and-required:
  - `services/cloudflare-online-verifier/migrations/0008_create_entitlement_devices.sql`
  - `services/cloudflare-online-verifier/scripts/device-key.mjs`
  Command: `git status --porcelain services/cloudflare-online-verifier/migrations/ services/cloudflare-online-verifier/scripts/`
- [ ] **Step 2 — confirm the test + manifest wiring on disk.** Verify the references exist (read-only): `schema.sql` defines `entitlement_devices` (CREATE TABLE + indexes); `test/online-verifier.test.mjs` reads `migrations/0008_*.sql` and spawns `scripts/device-key.mjs`; `package.json` has the `device-key` script. (These are tracked-modified — do NOT commit those test/manifest edits in this commit; they belong to the relay-resistance WIP. This commit adds ONLY the two new files.)
- [ ] **Step 3 — stage ONLY the two files and commit.**
  ```
  git add services/cloudflare-online-verifier/migrations/0008_create_entitlement_devices.sql services/cloudflare-online-verifier/scripts/device-key.mjs
  git commit
  ```
  Message: `feat(online-verifier): add entitlement_devices migration 0008 + device-key CLI` with the Co-Authored-By trailer.
- **Verification:** `git ls-files services/cloudflare-online-verifier/migrations/0008_create_entitlement_devices.sql services/cloudflare-online-verifier/scripts/device-key.mjs` returns both paths. `git status --porcelain` no longer shows them as `??`.
- **Caveat — do NOT run the relay-resistance tests green here.** Those tests are in the still-stashed WIP (`test/online-verifier.test.mjs` is tracked-modified). Confirming them green requires the full WIP, which is out of scope for this cleanup. The commit's correctness is: the two files match what the WIP tests reference. This is a structural prerequisite commit, not a feature landing.
- **Rollback:** `git reset --soft HEAD~1 && git restore --staged .` returns the two files to untracked.

### Task 0.3: Create the isolated worktree off the clean tree

- [ ] **Step 1 — stash remaining WIP** (Task 0.1 Step 2) so the current branch tip is clean except for the 0.2 commit.
- [ ] **Step 2 — create a worktree on a fresh branch off `develop`-derived current branch.** Per `superpowers:using-git-worktrees`, prefer the native tool; fallback:
  ```
  git worktree add ../licensecc-cleanup -b improve/structure-cleanup
  ```
  (Branch off the current `improve/codebase-smells-fixes` HEAD so the 0.2 commit is included; this stays GitFlow-correct relative to `develop`.)
- [ ] **Step 3 — in the worktree, configure a build tree:** `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug` (the worktree has its own `build/`). Run `ctest --test-dir build -N` and record the count as the baseline.
  - **Baseline test count (corrected, precise):** the **32** registered `ADD_TEST` entries in the tracked tree decompose as **test/ = 8, test/functional = 5, test/library = 13, test/library/hw_identifier = 2, test/library/os = 4** (these are the categories that gate this plan). `test/fuzz` adds 2 more `add_test()` calls outside those categories; depending on `BUILD_TESTING`/fuzz config your `ctest -N` total may read higher. **Important worktree caveat:** the worktree is built off **HEAD (tracked tree)**, so it will **NOT** include the WIP `test_online_callback_failover` target — its `.cpp` is **untracked** and its only wiring is in a **working-tree-modified `test/library/CMakeLists.txt`** that the stash carries away. Therefore the worktree's `ctest -N` baseline is **lower** than any count taken on the current dirty tree. Record the worktree's own number as the only baseline you compare against; do not expect it to match a dirty-tree count.
- **Verification:** `git -C ../licensecc-cleanup status` is clean; `ctest --test-dir ../licensecc-cleanup/build -N` lists the baseline tests (expect the 32-from-tracked categories, fuzz-dependent, WITHOUT the WIP failover test).
- **Rollback:** `git worktree remove ../licensecc-cleanup --force` then `git branch -D improve/structure-cleanup`.

> All subsequent phases run **inside the worktree** `../licensecc-cleanup`. Paths below are repo-relative within the worktree.

---

## WORKSTREAM A — Extract `src/library/signed_token/` shared core (= signed-config Plan 2b DRY task)

> **This is the signed-config "Plan 2b" shared-helper DRY extraction. Do it here; cross-reference, do not duplicate.** Aligns with the 06-11 checklist's "smaller seam plus characterization tests" principle (lines 11, 50). Riskiest workstream → most guardrails. Highest priority of the structural items: it removes ~120-140 lines of *near*-duplicated plumbing (see the `parse_uint64` divergence below — not all of it is byte-identical) and unblocks Plan 2b.

### Task A.1: Characterization tests BEFORE moving any behavior

The two public headers (`OnlineVerification.hpp`, `ConfigAttestation.hpp`) are the seam. The extraction must leave every public symbol byte-for-byte equivalent. Lock that with tests first (06-11 checklist line 50: "add characterization tests before moving behavior").

- [ ] **Step 1 — confirm existing coverage.** `config_attestation_test.cpp` (committed) exercises `build_canonical_config_payload`, `build_config_envelope`, `verify_config_envelope`, `set_trusted_public_keys_for_tests`. `online_verification_test.cpp` is **tracked-modified (` M`)** — it is part of the in-flight WIP and will be set aside by the PHASE 0 stash, but it is a tracked file with committed history, not an untracked WIP file. DECISION: prefer adding a small **committed** characterization test in the already-committed `config_attestation_test.cpp` so the extraction does not depend on the stashed online-test modifications. If you need the online test to verify A.3, restore it from the stash read-only (see A.3 Step / Verification) rather than depending on it being present.
- [ ] **Step 2 — add a golden round-trip assertion** in `test/library/config_attestation_test.cpp` (already committed, safe to extend): a known payload → `build_config_envelope` → `verify_config_envelope` returns OK with expected claims, AND a tampered envelope returns the exact existing error string ("config token signature verification failed"). This pins the error-noun behavior that the shared `error_noun` parameter must preserve.
- [ ] **Step 3 — build + run, record green.**
  ```
  cmake --build build --target test_config_attestation --config Debug
  ctest --test-dir build -C Debug -R test_config_attestation --output-on-failure
  ```
- **Verification:** test passes; capture the output as the pre-extraction baseline.
- **Rollback:** revert the test edit; no source moved yet.

### Task A.2: Create the `signed_token` OBJECT library (header + impl + CMake), wired but unused

Create the module exactly mirroring `config_attestation/CMakeLists.txt` so the build wiring is proven before any call site changes.

> **DEDUP REALITY CHECK (correction — `parse_uint64` is NOT byte-identical).** The two `parse_uint64` implementations differ in their digit test:
> - `src/library/online_verification/OnlineVerification.cpp:106` uses `if (!std::isdigit(ch)) { ... }` (locale-sensitive, and UB-prone if `ch` is a signed `char` with a negative value).
> - `src/library/config_attestation/ConfigAttestation.cpp:67` uses `if (ch < '0' || ch > '9') { ... }` (locale-safe range form).
>
> Step 1 below RESOLVES this divergence by standardizing on the range form. Do not describe the resulting shared body as a "byte-identical lift" of *both* originals — for `parse_uint64` specifically it is a **reconciliation** (online's `std::isdigit` body is intentionally changed to match config's range form). Verify the online-verification tests still pass after this normalization (digit parsing of ASCII numerics is unaffected; the only observable difference would be locale/`signed char` edge cases, which the canonical payloads never produce). The *other* primitives (envelope split/build, claim-line appenders, signature verify) are genuinely byte-identical between the two files and may be lifted verbatim.

- [ ] **Step 1 — create `src/library/signed_token/SignedToken.hpp`** with the non-domain primitives and the test-override abstraction, per the extract investigation's API: `now_epoch_seconds`, `value_has_line_breaks_or_equals`, `append_claim_line`, `append_uint_claim_line`, `parse_uint64` (use the `ch < '0' || ch > '9'` range form with an overflow guard — locale-safe; this is the reconciled form that replaces online's `std::isdigit`), `extract_preverify_field`, `split_envelope(token, expected_prefix, error_noun, ...)`, `build_envelope(prefix, payload, sig_b64)`, `parse_fields_in_order(payload, FieldSpec*, n, error_noun, error)`, `verify_payload_signature(payload, sig, payload_text, license_version, policy, error_noun, error)`, and a **new** templated test-override abstraction `template<typename PublicKey> struct TrustedKeyOverride` with `static store()/mutex()/set()/get()`. Namespace `license::signed_token`. Includes: `../base/base64.h`, `../os/os.h`, `../os/signature_verifier.hpp`.
  > **NOTE (correction — `TrustedKeyOverride<PublicKey>` is a genuinely new abstraction, not a lift.** No such struct exists today. The current code uses **free functions**: `trusted_public_keys_override()` / `trusted_public_keys_override_mutex()` and a `current_trusted_public_keys()` getter (see `ConfigAttestation.cpp:18,23,56` and the `set_trusted_public_keys_for_tests` writer at `:316-317`), with the analogous `trusted_public_keys_override_for_tests()` set in the online module. Introducing `TrustedKeyOverride<PublicKey>` is a **new templated wrapper** over per-type statics — design and test it as new code (it replaces those free functions per module), do not treat it as a mechanical copy.
- [ ] **Step 2 — create `src/library/signed_token/SignedToken.cpp`** implementing every non-template function. The shared bodies are lifted **byte-identically from the investigation (§1a-1k) for all primitives EXCEPT `parse_uint64`**, whose body is the reconciled range form described in the box above (config's form, replacing online's `std::isdigit`). Do not claim a blanket "byte-identical shared bodies" lift; call out `parse_uint64` as the one reconciled function.
- [ ] **Step 3 — create `src/library/signed_token/CMakeLists.txt`** identical in shape to `config_attestation/CMakeLists.txt` (OBJECT lib named `signed_token`, same `target_include_directories` PRIVATE block, same two `LCC_PROJECT_*_HEADER` compile-defs).
- [ ] **Step 4 — wire into `src/library/CMakeLists.txt`** at the three exact sites from the investigation:
  - Add `add_subdirectory("signed_token")` as the FIRST line (before `base`), since `online_verification`/`config_attestation` will depend on it at source level.
  - Add `signed_token` to the `foreach(... IN ITEMS ...)` list on line 9 (so it gets `add_dependencies(signed_token project_initialize)`).
  - Add `$<TARGET_OBJECTS:signed_token>` to the `ADD_LIBRARY(licensecc_static STATIC ...)` list (lines 15-27), before `online_verification`.
- [ ] **Step 5 — reconfigure + build the static lib** to prove the new OBJECT lib compiles and links even though nothing calls it yet:
  ```
  cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
  cmake --build build --target licensecc_static --config Debug
  ```
- **Verification:** clean build of `licensecc_static`; `signed_token` object lib appears in the build. Full suite still green: `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`.
- **Rollback:** `git clean -fd src/library/signed_token` + revert the `src/library/CMakeLists.txt` edit; the build returns to baseline.
- **Commit:** stage only `src/library/signed_token/` + `src/library/CMakeLists.txt`. Message: `feat(signed-token): add shared signed-token core (unused)`.

### Task A.3: Migrate `OnlineVerification.cpp` to the shared core

Per the extract investigation §5 (OnlineVerification.cpp). Public header (`OnlineVerification.hpp`) does NOT change — tests stay green.

- [ ] **Step 1** — add `#include "../signed_token/SignedToken.hpp"`.
- [ ] **Step 2** — delete the local primitives now in the core (`value_has_line_breaks_or_equals`, `append_claim_line`, `append_uint_claim_line`, `now_epoch_seconds`, `parse_uint64` — note this deletes online's `std::isdigit` form in favor of the shared range form, `extract_preverify_field`) and the local `split_envelope`/`verify_payload_signature`; replace call sites with `signed_token::` equivalents passing `kEnvelopePrefix` (`"lccoa1"`), error-noun `"online assertion"`, `license::os::LCC_ONLINE_ASSERTION_SIGNATURE_VERSION`, and `signature_policy_for_expected(expected)`.
- [ ] **Step 3** — replace `build_assertion_envelope` body with `return signed_token::build_envelope(kEnvelopePrefix, payload, signature_base64);`.
- [ ] **Step 4** — replace the online module's free-function trusted-key override (the `trusted_public_keys_override_for_tests()` / `current_*` getters) with `using OVKeyOverride = license::signed_token::TrustedKeyOverride<OnlineVerificationPublicKey>;` and route `set_trusted_public_keys_for_tests`→`OVKeyOverride::set`, the reader→`OVKeyOverride::get`.
- [ ] **Step 5** — in `parse_canonical_payload`, keep the domain-specific `fields[]` table local; replace the loop body with `signed_token::parse_fields_in_order(...)` (or leave the loop local if the table coupling makes the call awkward — the primitives are the load-bearing dedup; the field-table loop is optional). Keep `now_epoch_seconds` call → `signed_token::now_epoch_seconds()`.
- [ ] **Step 6 — build + run online tests.**
  ```
  cmake --build build --target licensecc_static --config Debug
  ctest --test-dir build -C Debug -R "online" --output-on-failure --no-tests=error
  ```
- **Verification:** all online-verification tests green with zero changes to `OnlineVerification.hpp`. Because `online_verification_test.cpp` is in the stash (tracked-modified), temporarily restore it read-only into the worktree to verify (`git checkout stash@{0} -- test/library/online_verification_test.cpp` or `git stash show -p`), then revert/re-stash — do NOT commit the stashed WIP test edits here.
- **Rollback:** `git checkout -- src/library/online_verification/OnlineVerification.cpp`.

### Task A.4: Migrate `ConfigAttestation.cpp` to the shared core

Symmetric to A.3, per extract investigation §5 (ConfigAttestation.cpp). `kEnvelopePrefix` = `"lcccfg1"`, error-noun `"config token"`, version `kConfigSignatureVersion` (9002), policy `config_signature_policy(expected)`. Note the policy builder STAYS local (it builds from scratch with `min_public_key_bits=0`, no compile-time key ring) — only the primitives + envelope + signature-verify call move. Config's `parse_uint64` (`ch < '0' || ch > '9'`, `:67`) is already the canonical form the shared core adopts, so config loses no behavior here.

- [ ] **Step 1-5** — mirror A.3 steps with config nouns/constants; replace the free-function override (`trusted_public_keys_override()` / `current_trusted_public_keys()` at `:18,56`) with `using CAKeyOverride = license::signed_token::TrustedKeyOverride<ConfigAttestationPublicKey>;`.
- [ ] **Step 6 — build + run config tests + full suite.**
  ```
  cmake --build build --target licensecc_static --config Debug
  ctest --test-dir build -C Debug -R test_config_attestation --output-on-failure
  ctest --test-dir build -C Debug --output-on-failure --no-tests=error
  ```
- **Verification:** `config_attestation_test` green (the characterization test from A.1 still passes, proving error-noun preservation), full suite green. Confirm `OnlineVerificationPublicKey` and `ConfigAttestationPublicKey` remain distinct types so the two `TrustedKeyOverride<>` specializations get distinct statics (extract investigation §6 risk note).
- **Rollback:** `git checkout -- src/library/config_attestation/ConfigAttestation.cpp`.
- **Commit:** stage only `src/library/online_verification/OnlineVerification.cpp`, `src/library/config_attestation/ConfigAttestation.cpp`, and the A.1 test. Message: `refactor(signed-token): route online + config modules through shared core`.

### Task A.5: Update docs to record the dedupe and re-scope Plan 2b

- [ ] **Step 1** — edit `CLAUDE.md:157` ("Known duplication (planned dedupe, not yet done)") to "Shared signed-token core: `src/library/signed_token/` — DONE 2026-06-15" and adjust `CLAUDE.md:179`'s rename caveat as needed (Workstream B updates the rename line).
- [ ] **Step 2** — edit `docs/superpowers/features/signed-config-token-status.md` lines 28 and 40: mark "shared-helper DRY extraction — DONE (see this structure-cleanup plan)" and re-scope the Plan 2b row (line 14) to drop "shared-helper DRY". Also reconcile the two **active** signed-config docs noted in the cross-plan alignment (`docs/superpowers/specs/2026-06-14-signed-config-token-design.md`, `docs/superpowers/plans/2026-06-14-signed-config-token-plan-2a-public-api-signer.md`) if they describe the helper duplication as still-pending.
- **Verification:** `git grep -n "signed_token\|DRY" -- CLAUDE.md docs/superpowers/features/signed-config-token-status.md` shows the updated status. (Use `git grep` / the Grep tool — `rg` is not installed.)
- **Commit:** stage only the touched docs. Message: `docs(signed-token): record shared-core extraction; re-scope Plan 2b`.

---

## WORKSTREAM B — Rename `services/cloudflare-online-verifier/`

> Highest blast radius (30+ fragile path references across CI, scripts, sibling services, test vectors). One mechanical pass, one verification gate. **The deployed Cloudflare Worker `name` is a SEPARATE decision from the directory name** — keep `name = "licensecc-online-verifier"` in `wrangler.example.toml` and the D1 `database_name` UNCHANGED (renaming them would orphan the live Worker / DB and break every hardcoded client URL). This workstream renames the DIRECTORY and npm package only.

> **TOOLING (correction):** every `rg` command below MUST be run as **`git grep`** (verified present) or via the **Grep tool**. `rg` is not installed on this host. For sweeps that must catch untracked files (e.g. the untracked `examples/production_decision_host/`), use the **Grep tool** rather than `git grep`, since `git grep` skips untracked paths.

**Decide the target name FIRST (with the user).** The investigation's rationale: the dir now hosts the online verifier + config signer + device/relay subsystem. Candidate: `services/cloudflare-licensing-backend/` (matches `CLAUDE.md:179` "the licensing backend"). Use that below as the target; substitute the user's choice.

### Task B.1: The `git mv` and self-contained identity files

- [ ] **Step 1 — move the directory.** `git mv services/cloudflare-online-verifier services/cloudflare-licensing-backend`. All child paths update automatically in the index.
- [ ] **Step 2 — fix the directory's own identity files** (rename investigation §4), EXCEPT the deployed Worker/DB names:
  - `package.json:2` + `package-lock.json:2,8`: `@licensecc/cloudflare-online-verifier` → `@licensecc/cloudflare-licensing-backend`.
  - `src/index.ts` `/health` body `service: "licensecc-online-verifier"` → KEEP (it is the deployed service identity, not the dir). Confirm with user; default KEEP.
  - `wrangler.example.toml:1` `name` + `:37` `database_name` → KEEP `licensecc-online-verifier` (deployed identity).
  - `scripts/entitlement.mjs:8` `DEFAULT_DATABASE` → KEEP (matches live D1 DB name).
  - `README.md:23,131` `wrangler d1 create` / example URL → KEEP the DB/URL names; they reflect deployed identity.
- [ ] **Step 3 — operator note in the moved README:** add a short paragraph that the gitignored `wrangler.toml`, `.dev.vars`, `.online-key/`, `node_modules/`, `.wrangler/` must be re-created/reinstalled at the new path by the operator (`npm ci` from the new location), and that the deployed Worker `name` is intentionally unchanged.
- **Verification:** `git status --porcelain services/` shows renames (`R`) not delete+add; `ls services/cloudflare-licensing-backend/` lists the tree.
- **Rollback:** `git mv services/cloudflare-licensing-backend services/cloudflare-online-verifier` + `git checkout -- services/`.

### Task B.2: Update every FRAGILE path reference (one sweep)

Work the rename investigation's exhaustive list. Use a search to find all, then edit each. Run the find first (NOT `rg` — not installed): `git grep -n "cloudflare-online-verifier"` (tracked files; excludes `package-lock.json` paths you handle via regenerate), then **also** run the **Grep tool** for `cloudflare-online-verifier` to catch untracked files (notably `examples/production_decision_host/`). Handle `package-lock.json` separately by regenerating via `npm install`.

- [ ] **Step 1 — `.gitignore:54`** path-specific ignore → new path. (Critical: prevents secret-leak of the real `wrangler.toml`.)
- [ ] **Step 2 — GitHub Actions** (CI will stop triggering otherwise): rename `.github/workflows/cloudflare-online-verifier.yml` → `cloudflare-licensing-backend.yml` and update its self-referencing path triggers (`:1,6,7,12,13,26,34,54,58`); update `cloudflare-license-admin.yml:8,14` and `release-gates.yml:36-38,74-76,108`.
- [ ] **Step 3 — repo-level scripts** (called by release gate): `scripts/release_gate_contract.mjs:129,135-137,146,216`, `scripts/release_gate_contract.test.mjs:169`, `scripts/validate_release_gates.mjs:388,434-436,446,449`, `scripts/validate_release_gates.test.mjs:367,933`, `scripts/secret_hygiene_scan.mjs:19,23,25`, `scripts/secret_hygiene_scan.test.mjs:11`, `scripts/assert_release_ready.test.mjs:57,487`, `scripts/release_gates_workflow.test.mjs:38-40,72`.
- [ ] **Step 4 — sibling services** (hardcoded relative paths that break at runtime): `cloudflare-license-admin/package.json:16`, `scripts/remote-d1-atomicity.mjs:11,202`, `test/sql/audit-json-object.test.mjs:18`, `wrangler.example.jsonc:20`, `README.md:24,37,124`; **`cloudflare-d1-backup/README.md:124,133`** (config PATHS only — the `--config ../cloudflare-online-verifier/wrangler.toml` lines; leave any `--database licensecc-online-verifier` DB-NAME strings unchanged since the deployed DB keeps its name). **CORRECTION: this file has only TWO `cloudflare-online-verifier` matches — lines 124 and 133. There is NO line 152 match; the earlier `124,133,152` citation was wrong. Verified via `git grep -n "cloudflare-online-verifier" -- services/cloudflare-d1-backup/README.md`.** NOTE: the `database_name`/`DATABASE_NAME` literals in `cloudflare-d1-backup` (`src/core.ts:72`, `wrangler.example.jsonc:14-15`, the `backup-*.test.mjs` files) and `cloudflare-license-admin/wrangler.example.jsonc:18` are DEPLOYED-DB identities → KEEP. Only `--config ../cloudflare-online-verifier/...` PATH references change.
- [ ] **Step 5 — test vectors:** `test/vectors/config_attestation/_gen_golden.mjs:8` three-level-up relative path to `config-sign.mjs` → new dir.
- [ ] **Step 6 — README + CLAUDE.md + examples:** `README.md:158` markdown link; `CLAUDE.md:171,177,179` service-table rows + rename caveat (mark rename DONE); `examples/online_callback/README.md:19` example URL → KEEP (deployed URL).
- [ ] **Step 6b — untracked example with a RUNNABLE stale path (NEW — must not be missed):** `examples/production_decision_host/README.md:49` contains a runnable command `npm --prefix services/cloudflare-online-verifier run device-key -- generate --out-dir .device-key`. This is a **real stale path** after the rename, not deployed-identity text. This file is currently **untracked** (the whole `examples/production_decision_host/` dir is WIP `??`), so it is in the PHASE 0 stash and `git grep` will NOT find it during the sweep — **use the Grep tool** to catch it. Update the `--prefix` path to `services/cloudflare-licensing-backend`. **Critically, PHASE Z must also fix this on stash restore** (it is called out there): when the WIP is popped after the rename merges, this command must point at the new dir name or it breaks. (Phase Z's original restore note only mentioned `test/online-verifier.test.mjs`; this README command is the second path that breaks on restore.)
- [ ] **Step 7 — regenerate the lockfile:** `npm install --prefix services/cloudflare-licensing-backend` to refresh `package-lock.json` name fields.
- [ ] **Step 8 — DEFER doc/RST + .tmp, but DO fix the two ACTIVE signed-config docs:** the `doc/analysis/*.rst`, `doc/usage/cloudflare-backups.rst`, and the *dated historical* `docs/superpowers/{plans,specs}` checklists (rename investigation §9, §10) are historical/planning text — they do NOT break CI and may be left as-is. **However, the two ACTIVE signed-config docs are NOT historical** and must be updated in this sweep: `docs/superpowers/specs/2026-06-14-signed-config-token-design.md` and `docs/superpowers/plans/2026-06-14-signed-config-token-plan-2a-public-api-signer.md` (both dated 2026-06-14, the current frontier; tracked; referenced by the cross-plan alignment). Also fix `docs/superpowers/features/signed-config-token-status.md`. `.tmp/*` is untracked scratch — ignore.
- **Verification (the single gate):** Run via `git grep` (NOT `rg`) plus the Grep tool for untracked files:
  ```
  git grep -n "cloudflare-online-verifier" -- ':(exclude)doc/analysis'
  ```
  and the Grep tool: pattern `cloudflare-online-verifier`, excluding `node_modules`, `doc/analysis`, and `.tmp` — this catches the untracked `examples/production_decision_host/` hit that `git grep` misses.
  Remaining hits must be ONLY intentional deployed-identity strings (Worker `name`, D1 `database_name`, `/health` service, hardcoded deployed URLs) — enumerate and confirm each. Then run the gate scripts that don't need live infra:
  ```
  node --test scripts/secret_hygiene_scan.test.mjs scripts/release_gates_workflow.test.mjs scripts/validate_release_gates.test.mjs scripts/assert_release_ready.test.mjs scripts/release_gate_contract.test.mjs
  node scripts/secret_hygiene_scan.mjs
  npm --prefix services/cloudflare-licensing-backend test
  npm --prefix services/cloudflare-license-admin run test:sql
  ```
- **Rollback:** the rename is one atomic change; `git checkout -- .` + `git mv` back. Commit AFTER the gate is green.
- **Commit:** one commit, message `refactor(services): rename cloudflare-online-verifier -> cloudflare-licensing-backend (dir + npm pkg; deployed Worker/DB names unchanged)`.

---

## WORKSTREAM C — `example/` vs `examples/` NAMING CLARITY (clarity only — `example/` STAYS)

> `example/` is MAINTAINED (last changed 2026-06-05, commit `8991607`; `CLAUDE.md:101` documents it as the canonical single-file `find_package` consumer). It is standalone (NOT in any root `add_subdirectory`; root only wires `examples/online_callback|anti_tamper_host|production_decision_host` via `LCC_BUILD_EXAMPLES`). **Do NOT delete or merge it.** The only problem is the confusable name. Lowest priority — do last, or DEFER entirely if the user prefers zero churn.

### Task C.1: Make the singular `example/` self-explaining (no rename)

- [ ] **Step 1 — DECISION (default: keep the name, add a header note).** Renaming `example/` to e.g. `examples/installed_consumer/` is technically low-impact (no root `add_subdirectory`, no CI, no doc/smoke-test reference per the misc investigation) but adds history churn for a 3-file demo. DEFAULT: do NOT rename; instead add a one-line banner to `example/README.md` ("This is the canonical single-file `find_package(licensecc)` consumer demo, intentionally separate from the richer `examples/` set — see CLAUDE.md") and confirm `example/CMakeLists.txt` project name `licensecc_workflow_example` is descriptive enough (it is).
- [ ] **Step 2 — ALTERNATIVE (only if user wants the rename):** `git mv example examples/installed_consumer`, update `example/CMakeLists.txt`'s `project(...)` name, and update `CLAUDE.md:101,113`. No CI/smoke-test edits needed (none reference `example/`).
- **Verification:** `git grep -n "\bexample/\b" -- CMakeLists.txt .github/workflows test` returns no build-critical hit (confirms the rename, if chosen, breaks nothing). (Use `git grep`/Grep tool — not `rg`.)
- **Commit:** `docs(example): clarify singular example/ is the canonical find_package demo` (or the rename commit).

---

## WORKSTREAM D — `doc/` vs `docs/` reconciliation (LOWER-RISK option; do NOT rename `docs/`)

> The docs investigation is decisive: **do not rename `docs/`.** Build isolation is already perfect (neither Sphinx nor Doxygen ingests `docs/`; the CMake `docs/sphinx` var is a build-TREE path, unrelated to source `docs/`). A rename = 15+ link updates across 8 files for zero functional gain. The real, orthogonal defect is the dead `doc/structure.dox` Doxygen stub. Lowest priority.

### Task D.1: Remove the dead `doc/structure.dox` stub (the actual fix)

- [ ] **Step 1 — confirm it is dead.** `doc/structure.dox` generates 3 orphan placeholder pages (`A simple manual`/`intro`/`advanced`, lorem text), hidden from nav (`DoxygenLayout.xml:8` `<tab type="pages" visible="no">`), referenced by NO `.rst`. It is wired only via `doc/Doxyfile:8` `INPUT`.
- [ ] **Step 2 — DECISION (default: delete).** Either delete `doc/structure.dox` and remove it from `doc/Doxyfile:8`'s `INPUT` line (a two-token edit), OR replace it with a genuine architecture overview referenced from `doc/index.rst`. DEFAULT: delete (lower effort; the architecture overview already lives in `CLAUDE.md`). `git rm doc/structure.dox` + edit `doc/Doxyfile:8`.
- **Verification:** `git grep -n "structure.dox" -- doc/Doxyfile` returns nothing; docs build still succeeds if Doxygen present: `uv run --no-project python scripts/build_docs.py` (skip if Doxygen/Sphinx unavailable locally — note the skip).
- **Commit:** `docs(doxygen): remove dead structure.dox placeholder stub`.

### Task D.2: Keep the `docs/` orientation note (do NOT rename)

- [ ] **Step 1 — confirm the disambiguation already exists** at `CLAUDE.md:107-115` (callout box) and `docs/superpowers/README.md`. No action needed beyond verifying it is still accurate after Workstream A/B doc edits. If anything drifted, touch up the one line. **Explicitly: no `git mv docs/`.**
- **Verification:** `CLAUDE.md:113` still reads "`doc/` = published site, `docs/` = internal plans".
- **Commit:** only if a touch-up was needed.

---

## PHASE Z — Land and restore WIP

- [ ] **Step 1 — final full verification in the worktree:**
  ```
  ctest --test-dir build -C Debug --output-on-failure --no-tests=error
  node --test scripts/secret_hygiene_scan.test.mjs scripts/release_gates_workflow.test.mjs
  npm --prefix services/cloudflare-licensing-backend test
  ```
- [ ] **Step 2 — integrate the cleanup branch** per `superpowers:finishing-a-development-branch` (PR into the working branch or `develop`; GitFlow — never `master`).
- [ ] **Step 3 — remove the worktree** after merge: `git worktree remove ../licensecc-cleanup`.
- [ ] **Step 4 — restore the stashed WIP** in the main worktree: `git stash pop`. Re-base the WIP onto the now-merged cleanup if the rename touched WIP paths. **The relay-resistance + production-decision-host WIP references the OLD dir name in at least TWO places that must be replayed under the new dir name:**
  1. `test/online-verifier.test.mjs` (under the OLD `services/cloudflare-online-verifier/` dir — now `services/cloudflare-licensing-backend/`).
  2. **`examples/production_decision_host/README.md:49`** — the runnable command `npm --prefix services/cloudflare-online-verifier run device-key ...` (this whole dir is untracked WIP carried in the stash; the rename sweep could not touch it). Update its `--prefix` to `services/cloudflare-licensing-backend` on restore, or the documented command breaks.
  Use the PHASE 0 snapshot (`/tmp/lcc-wip-snapshot.txt` or `$env:TEMP\lcc-wip-snapshot.txt`) to confirm nothing was lost.
- **Verification:** `git status` against the snapshot; WIP files present under the new service path; both stale-path sites above now reference `cloudflare-licensing-backend`.

---

## What to do now vs defer (opinionated)

- **DO NOW:** PHASE 0 (gate), Workstream A (shared token — unblocks Plan 2b, highest structural value), Workstream B (service rename — fragile CI debt compounds the longer it waits), Workstream D.1 (delete dead stub — trivial, real defect).
- **DEFER / OPTIONAL:** Workstream C (naming clarity only; default to a one-line README note, not a rename), Workstream D.2 rename of `docs/` (explicitly DO NOT). The `doc/analysis/*.rst` historical-reference path updates from Workstream B Step 8 are deferred (no CI impact) — but the two **active** 2026-06-14 signed-config docs are NOT deferred; update them in B.2 Step 8.
- **OUT OF SCOPE (belongs to the 06-11 checklist):** splitting `licensecc.cpp` (Phase 3), centralizing entitlement TS contracts / `services/shared/` (Phase 5), CMake include-boundary tightening (Phase 2). This plan must not start those.