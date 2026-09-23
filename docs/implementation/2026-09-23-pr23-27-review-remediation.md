# PR #23–#27 review remediation — implementation report

Execution of the [remediation plan](../superpowers/plans/2026-09-23-pr23-27-review-remediation.md),
which closes every verified finding from the 2026-09-23 review of PRs #23–#27
(`6aecdec`..`6480049`).

## Scope and verified state

Worktree: `C:\Users\HEQ\Projects\licensecc-remediation`. Base for every branch: `main` @
`6480049`. Five independent workstreams, each its own local branch, none merged and none
pushed (Ruling R1 below). This report's own verified commit is the one that follows it on
`fix/review-e-docs-ui` (the plan + this report, committed together per Ruling R6); the CHANGELOG
commit immediately before it is `eaab9a3` (`docs(changelog): record #23-#27 and review
remediation`).

| Workstream | Branch | Head commit (verified) | Commits ahead of `main` |
| --- | --- | --- | --- |
| A — backend protected-device rate limiting | `fix/review-a-device-rate` | `7527214` | 3 |
| B — portal password/email flow | `fix/review-b-portal-password` | `9b63e6c` | 6 |
| C — native Linux protected licensing | `fix/review-c-linux-native` | `1acefa7` | 8 |
| D — backup, ops scripts, SDK loaders | `fix/review-d-backup-ops-sdk` | `1aee995` | 5 |
| E — docs, example CI, UI cleanup, CHANGELOG | `fix/review-e-docs-ui` | `eaab9a3` + this commit | 6 |

No branch was pushed; no PR was opened (Ruling R1). Pushing/opening PRs is left to
`finishing-a-development-branch` with explicit user consent.

## Controller rulings

Every ruling recorded during execution, verbatim from `progress.md`:

- **Ruling R1**: one worktree; each workstream is its own branch from `main`
  (`fix/review-{a..e}-…`), as the plan says. PRs are NOT opened and branches are NOT pushed. The
  plan's "Open PR X" steps become "workstream gate passes"; pushing/opening PRs is left to
  `finishing-a-development-branch` with user consent. Cost if wrong: the user runs `gh pr create`
  ×5.
- **Ruling R2**: in A1's second test, the `"7"` case asserts fallback to the default: the request
  is admitted, since global is 150 < 1000. The plan's implementation deliberately clamps invalid
  values to the default, and the brief's test contradicted it. Cost if wrong: an invalid config
  silently uses 1000 rather than failing.
- **Ruling R3**: B1's `legacy()` test helper awaits both inserts (the brief's snippet only awaited
  the second). An obvious transcription bug; cost of the ruling: none.
- **Ruling R4**: C3 must `fchmod` the created checkpoint directory (0700) as well as the stage
  file; the umask test cannot pass otherwise. Cost if wrong: none (strictly more robust).
- **Ruling R5**: E4 (CHANGELOG) runs on branch E after A–D are complete but unmerged, and
  describes all of them. Cost if wrong: the CHANGELOG overstates if a workstream PR is later
  dropped.
- **Ruling R6**: the plan file itself is committed on branch E alongside this implementation
  report. Cost: none.
- **Ruling R7**: `check:pr` fails only at `test/staging-lease-drill.test.mjs` (7 fail) on host
  Node v24.20.0. That test imports only `scripts/staging-lease-drill.mjs` and `licensing-domain`,
  which no remediation task touches, so it is pre-existing/environmental and out of scope. Every
  workstream gate counts "`check:pr` green except staging-lease-drill" as passing. This report
  re-confirms it below. Cost if wrong: a real regression masked in that one file.
- **Ruling R8**: the `doc/architecture/system-map.md` line-count refresh (commit `7527214`) is
  accepted as part of A2. Line totals there are gated by `test:docs-accuracy`, so every
  implementer must refresh them when a task changes source line counts (this recurred in
  B1/B2/B4/B5/E3).
- **Ruling R9**: 5 pre-existing WSL-environment failures (`test_project`, `test_file_publish`,
  `test_os_linux`, `test_dmi_info`, `test_execution_environment`: DMI/disk-ID unavailable inside
  WSL) are out of scope for Workstream C. CI on real Ubuntu is authoritative. Cost if wrong: masks
  a regression in those tests.
- **Ruling (C2)**: the relative-PATH test in the browser-launcher hardening was vacuous
  (plan-mandated weakness) — fixed by strengthening it with a real relative `xdg-open` plus an
  empty-entry case, and adding a `SIG_IGN` + exec-failure test. Cost: small test churn.
- **Ruling (D1)**: the reviewer's non-blocking "Important" finding (Workflows at-least-once replay
  could make cleanup delete a dump an earlier run already manifested) is deferred to the final fix
  wave as SHOULD FIX: check that the manifest key is absent before deleting. Pre-existing platform
  semantics with a cheap guard; cost if wrong: a rare lost backup until the next scheduled run.

## Per-task summary

### Workstream A — backend protected-device rate limiting (`fix/review-a-device-rate`)

- **A1** (`9ec4926`, "stop one source from exhausting the protected-device budget"): global fuse
  now counts only per-source-admitted traffic; added `BOUND_GLOBAL_RATE_LIMIT` (validated,
  clamped to default 1000 outside `[100, 1000000]`) and an edge `BOUND_SESSION_RATE_LIMITER` for
  non-registration routes, checked before any D1 write. `npm run test:sql` (backend): RED 304
  pass/3 fail → GREEN 307/307; `typecheck` clean. No fix round.
- **A2** (`2500ef2`, + `7527214` self-found docs fix): replaying a committed lease never
  rate-limits (moved `limitBoundVerified` after the operation-replay early return); per-customer
  verified budget now scales as `max(240, 2 × max_active_devices)`. `test:sql`: RED 307/2 fail →
  GREEN 309/309. `7527214` refreshed a `system-map.md` total that A1 had left stale (blocking
  `test:docs-accuracy`); not a defect in A1's own scope, fixed here to unblock the gate. No fix
  round. Workstream gate: `check:pr` green except Ruling R7.
- Deferred minor findings: A1 — the straddle test tolerates a 1-row client-counter leak on a
  failed straddled batch (plan-mandated); the observed read under true concurrency can spuriously
  429 (fails safe, pre-existing). A2 — no HTTP-level test of the scaled customer cap (only direct
  `limitBoundVerified`).

### Workstream B — portal password/email flow (`fix/review-b-portal-password`)

- **B1** (`addf08a`): pre-verification (`email = ''`) legacy accounts recover through a verified
  reset and adopt the proven email, gated by a same-transaction `NOT EXISTS` guard against another
  customer already owning the address. `npm test` (portal): RED 146/1 fail → GREEN 147/147, then
  150/150 after later tasks stacked on top.
- **B2** (`04e607f`): link requests answer before any account lookup/delivery (work moved into
  `ctx.waitUntil`); a provider timeout no longer deletes the emailed link (`email_send_indeterminate`
  is treated as indeterminate, not a definite failure). RED: 1 fail (assertion) + 1 timeout →
  GREEN 10/10 targeted, 149+22 full suite.
- **B3** (`9d0c970`, fix round 1 `9b63e6c`): login only accepts addr-spec emails, rejecting
  display-name/list/quoted forms and control characters. Round 1 fixed a root-lint
  `no-control-regex` gap found during B5's `check:pr` (an eslint-disable with justification, no
  behavior change). `packages/cloudflare-runtime` tests 26/26; portal 171/171; root `lint` clean
  after the fix.
- **B4** (`b98bc62`): a committed reset always reports success (`password_updated`, 200) even if
  the follow-on sign-in mint fails — no more 401/500 after a committed credential write; password
  OpenAPI response maps split and corrected per route; `test/contracts/portal.json` regenerated
  (6 operations changed). RED 149/1 fail → GREEN 150/150; `test:openapi` 14/14; `test:ui` 15/15.
- **B5** (`9dd240d`): portal UI hides email-only actions when no email sender is configured
  (`emailApiOrigin` check), aligns password length bounds with the server's 15–128, and renders a
  distinct `password_updated` message. Worker unit RED→GREEN, e2e RED (2 fail) → GREEN 66/66;
  `test:ui` 15/15; `test:openapi` 14/14. Surfaced (not fixed here) the B3 root-lint gap that
  became B3's fix round 1.
- Workstream gate: `check:pr` green except Ruling R7 (the B3 lint blocker was the only other
  failure, fixed in B3's round 1).
- Deferred minor findings: B1 — no test for the address being claimed by another customer between
  reset request and complete (write-time guard verified only by reading). B2 — `portal_otp.mjs`'s
  `deliveryErrorType` maps only `email_send_failed` to `send_failed`, so OTP timeouts are now
  labeled `invalid_result` (SHOULD FIX in a future wave); the "answer before lookup" test only
  gates `fetch`, not the absence of a `portal_password_actions` row. B3 — C1 control characters
  (`\u0080`–`\u009f`) are not excluded from the email syntax. B4 — the settings `GET` shared
  response map still documents codes `GET` cannot emit (pre-existing).
- Step 5 (B3's staging D1 query for existing invalid-format accounts) was **not run**: no staging
  access.

### Workstream C — native Linux protected licensing (`fix/review-c-linux-native`, verified via WSL Ubuntu 24.04)

- **C1** (`a446a39`): loopback callbacks accepted only from the same local user, via a new
  `/proc/net/tcp[6]` peer-ownership check (`bound_loopback_peer_owned`). `ctest` 3/3 targeted;
  full-suite 54/59 (5 pre-existing WSL failures, Ruling R9).
- **C2** (`a418ab2`, fix round 1 `06c5278`): browser launcher resolves `xdg-open` only from
  absolute `PATH` entries, tolerates hosts that set `SIGCHLD` to `SIG_IGN`, and CLOEXECs
  inherited fds in the grandchild before `execve`. Round 1 strengthened a vacuous relative-PATH
  test and added an ECHILD/exec-failure regression guard (test-only; verified it actually catches
  the regression by temporarily reintroducing it). `ctest` 1/1 targeted, re-run 5× for flakiness;
  3/3 wider selection.
- **C3** (`8133dee`, fix round 1 `6f8ea72`): checkpoint stage files, namespace lock files, and
  created directories are `fchmod`'d to 0600/0700 so a restrictive umask can't strip owner bits;
  hard-linked TPM2 key references are rejected as `LCC_DEVICE_KEY_CORRUPT`. Round 1 fixed a
  reviewer-found regression where the lock-file `fchmod` also ran on a **pre-existing** unsafe
  lock file (mutating it before validation instead of failing closed) — now gated to the
  `O_CREAT|O_EXCL` creation branch only. `ctest` 54/59 and 44/50 (tpm2 preset) full-suite, same 5
  pre-existing WSL failures both times.
- **C4** (`527821d`): `LCC_ENABLE_LINUX_DESKTOP` defaults ON only with `LCC_ENABLE_TPM2_OPENSSL`
  or the test provider, else OFF, with a configure-time `FATAL_ERROR` if forced ON without either;
  `find_package(CURL 7.85)` now reports a clear `FATAL_ERROR` (with the version found) instead of
  a generic `REQUIRED` failure. Verified via forced-`OFF`/forced-`ON` configure runs and
  `-DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON` (this host's libcurl is 8.5.0, so the real old-curl path
  could not be reproduced locally — see Surfaces not run). `check:build-purity -Preset dev-debug`
  passed (37/37); `test:docs-accuracy` 14/14; `test:workflow-pins` 21/21.
- **C5** (`b1ace13`, + `1acefa7` unrelated hotspot-baseline fix): pinned the Linux HTTPS
  response-completion rules with unit tests (pure refactor, `finish_response` extracted, zero
  behavior change — both new tests passed on first build); added a dedicated
  `ci-linux-sanitizers-device-identity` ASan/UBSan preset and CI job. `1acefa7` bumped the
  hotspot ratchet for `tpm2_openssl.cpp` (2016→2023 lines), drift left by C3's own already-committed
  change, not C5's. Sanitizer run: 54/59 (same 5 pre-existing failures), zero ASan/UBSan findings.
  `check:pr` green except Ruling R7 (after the hotspot-baseline fix); `check:build-purity` passed.
- Workstream gate: `check:pr` green except Ruling R7; `check-build-purity.ps1 -Preset dev-debug`
  passed; sanitizer suite clean.
- Deferred minor findings: C1 — no socket-state filter for `TIME_WAIT` uid-0 edge; the `tcp6` unit
  case has no decoy server row. C2 — 65536 fd ceiling in the `fcntl` fallback; the PATH-unset
  fallback is untested; the poll timeout change (1000ms→3000ms) is an observable behavior change.
  C3 — a `renameat2`-unsupported `linkat` fallback can leave `nlink==2` after a crash (permanent
  `KEY_CORRUPT`, needs documentation or a sweep); a hard-linked reference with a bad owner/mode
  now returns `KEY_CORRUPT` instead of `ACCESS_DENIED`; directories already created 0500 are never
  repaired. C4 — `_lcc_linux_desktop_default` is not explicitly `unset()`; the consumer-side curl
  message lacks a remediation step; the real old-curl FATAL path is unexercised anywhere in this
  session. C5 — the native-security contract test inspects only literal `cacheVariables`, so an
  inherited sanitizer preset would not be detected.

### Workstream D — backup, ops scripts, SDK loaders (`fix/review-d-backup-ops-sdk`)

- **D1** (`6ddf0d9`, fix round 1 `1aee995`): D1 backup export polling extended to ~20 minutes (40
  retries); a `d1_export_provider_failed` is now terminal (`NonRetryableError`, stops retrying
  immediately); a dump that fails post-upload checks is deleted from R2 so no orphan, unmanifested
  dump is left behind. Round 1 fixed a gap found during D3's `check:pr`: the new
  `cloudflare:workflows` import broke `test:contracts` because the VM-sandbox linker in
  `scripts/canonical-contracts.mjs` only shimmed `cloudflare:workers`/`node:crypto` — added an
  equivalent `NonRetryableError` shim plus a regression test. `npm test` (backup): RED 74/1 fail →
  GREEN 91/91; `test:docs-accuracy` and `check:hotspots` both required a one-line refresh
  (`core.ts` crossed 500 lines, ratcheted).
- **D2** (`6878621`, fix round 1 `1b6a3c9`): `protected-device-readiness.mjs` accepts `--env=<name>`
  to check environment-scoped Wrangler vars, falling back to top-level `vars`, returning
  `protected_configuration_unavailable` for a missing environment. Round 1 strengthened the
  missing-env test to assert the actual stdout JSON payload, not just the exit code. Targeted
  tests 2/2 both rounds; backend suite 363/370 (7 pre-existing, see below).
- **D3** (`842c0b2`): Java and .NET SDK native-loader error messages are OS-neutral and accurate
  on Linux; .NET now P/Invokes `dlopen`/`dlerror` directly (with a priming call + immediate
  read-back, since `dlerror()` is cleared by the runtime's own first P/Invoke stub resolution) to
  surface the real libc diagnostic instead of a generic .NET message. Verified on WSL Ubuntu 24.04
  (Java 17, .NET 8.0.131) and Windows (.NET 8.0.425, Java absent). Surfaced (not fixed here) the
  `cloudflare:workflows` contract gap that became D1's fix round 1.
- Workstream gate: `check:pr` green except Ruling R7 (confirmed independently by D3 after the D1
  fix round 1 landed).
- Deferred minor findings: D1 — older integrity-failure tests do not assert the dump is removed;
  the README does not mention a manifest-put failure as a cleanup trigger. D3 — no explicit
  `LPUTF8Str` on the `dlopen` path parameter; the Windows host lacks the pinned .NET SDK 8.0.423
  and Java (tests ran in WSL instead).

### Workstream E — docs, example CI, UI cleanup, CHANGELOG (`fix/review-e-docs-ui`)

- **E1** (`da45c3e`): Cloudflare setup guide and portal README aligned with the email-verified
  password flow and the `BACKEND` service binding. `test:docs-accuracy` 14/14; `check:docs`
  (Sphinx) succeeded; `test:wrangler-pins` 1/1.
- **E2** (`318c778`): `examples/device_bound` (protected application, feature-session, calculator)
  now builds and runs its isolated CTest suite in CI on both Windows and Linux, via a new
  `scripts/ci/build-device-bound-example.ps1`; Linux build docs completed for the calculator
  example. Found and fixed a real bug in the brief's own draft script (unquoted multi-dot `-D`
  values silently truncate on Windows PowerShell — confirmed by reproduction, fixed by quoting
  every `-D` argument). Verified end to end on WSL Ubuntu 24.04 (5/5 example tests) and native
  Windows/VS2022 (5/5, same tests) against real installed packages built from the CI presets.
  `test:workflow-pins` 21/21; `test:repository` 13/13; `check:scripts` clean; `test:docs-accuracy`
  14/14; `check:docs` succeeded.
- **E3** (`5dc68e0`, fix round 1 `164b9a6`): admin "Assign existing license" button renamed to
  "View assigned licenses" (honest label); the portal's browser-sessions panel no longer forces
  itself open — it now honestly collapses to a closed `<details>` once the last live seat is
  released; removed two dead empty-state copy constants and a vacuous e2e assertion. Round 1
  (Critical, reviewer-found): the panel's collapse left focus stranded on `<body>` after the last
  seat release because the original fix moved the workaround into the tests instead of the code;
  fixed by adding a verify-then-fallback focus chain in `DevicesFeature.tsx` that lands focus on
  the collapsed panel's own `<summary>` when the start button/seat card are no longer focusable,
  and restored the two focus assertions in the e2e test that the first round had weakened.
  `test:e2e` (customer-portal): first run 63/64 (the focus regression), GREEN 64/64 after round 1;
  `test:e2e` (license-admin) 100/100; `test:ui` 15/15 both rounds; `test:docs-accuracy` 14/14
  after two `system-map.md` refreshes (`DevicesFeature.tsx` grew 389→397→404 lines).
- **E4** (this task, `eaab9a3` + this commit): see below.
- Deferred minor findings: E1 — none noted. E2 — the Windows CI step's
  `-Generator "$env:CMAKE_GENERATOR"` is untested against the real `windows-2025-vs2026` runner
  (only local VS2022 was available); the new script has no unit test (matches sibling scripts).
  E3 — the brief's `-g "seat|session"` Playwright filter matches no test title in this suite (the
  real flow is titled "... walks every screen without leaking secrets"), so it gave false
  confidence until the full suite caught the regression.

## Deferred minor findings — consolidated list

All items above, gathered in one place for triage before/at merge:

1. A1: straddle test tolerates a 1-row client-counter leak on a failed straddled batch
   (plan-mandated).
2. A1: an observed read under true concurrency can spuriously 429 (fails safe, pre-existing).
3. A2: no HTTP-level test of the scaled customer cap (only direct `limitBoundVerified`).
4. B1: no test for the address being claimed by another customer between reset request and
   complete (write-time guard verified only by reading).
5. B2 (SHOULD FIX): `portal_otp.mjs`'s `deliveryErrorType` maps only `email_send_failed` to
   `send_failed`; add an `email_send_indeterminate` → `send_failed` mapping.
6. B2: the "answer before any account lookup" test only gates `fetch`; strengthen it to assert no
   `portal_password_actions` row exists before `settle()`.
7. B3: C1 control characters (`\u0080`–`\u009f`) are not excluded from the email syntax.
8. B4: the settings `GET` shared response map still documents codes `GET` cannot emit
   (pre-existing).
9. C1: no socket-state filter in the `/proc` tcp match (`TIME_WAIT` uid-0 edge); the `tcp6` unit
   case has no decoy server row.
10. C2: 65536 fd ceiling in the `fcntl` fallback; the PATH-unset fallback is untested; the 3s poll
    is an observable behavior change from the prior 1s.
11. C3: a `renameat2`-unsupported `linkat` fallback can leave `nlink==2` after a crash, causing
    permanent `KEY_CORRUPT` (document or sweep).
12. C3: a hard-linked reference with a bad owner/mode now returns `KEY_CORRUPT` instead of
    `ACCESS_DENIED` (would need the nlink check moved after the `S_ISREG`/uid check to change).
13. C3: redundant `nlink` condition in `load_reference` needs a comment; the directory fix has no
    dedicated unit test; directories already created 0500 are never repaired (release note).
14. C4: `_lcc_linux_desktop_default` is not explicitly `unset()`; the consumer-side curl message
    lacks a remediation step.
15. C5: the native-security contract test inspects only literal `cacheVariables`, so an inherited
    sanitizer preset is not detected.
16. D1: older integrity-failure tests do not assert the dump is removed; the README does not
    mention a manifest-put failure as a cleanup trigger.
17. D3: no explicit `LPUTF8Str` on the `dlopen` path parameter.
18. E1: none.
19. E2: the Windows CI step's generator variable is untested against the real VS2026 runner; no
    unit test for the new script (matches sibling scripts).
20. E3: the brief's `-g "seat|session"` Playwright filter matches no test title in this suite.
21. (Process, E1) the commit trailer on `da45c3e` names "Claude Haiku 4.5" instead of the required
    session trailer; history was not rewritten.

## Surfaces not run

- **Real GitHub Actions execution** of the modified/added workflows (`linux.yml`, `windows.yml`,
  `native-security.yml`) — every workstream verified by reproducing the same install layout and
  running the exact CI-invoked commands locally (WSL Ubuntu 24.04 and native Windows/VS2022), but
  no branch was pushed and no Actions run was triggered.
- **Real swtpm hardware / physical TPM** beyond the software simulator — all TPM2-path tests in
  C3–C5 ran against `swtpm`/the in-process test provider; no physical TPM was used, matching the
  project's existing CI posture (real hardware is out of scope for local verification).
- **Staging D1 query** (B3, Step 5): checking `portal_passwords` for existing accounts with
  invalid-format emails — not run; no staging access.
- **Real email provider** — password-link send/timeout paths (B1, B2, B5) were verified against
  mocked `fetch`/`sendEmail`; no live provider was contacted.
- **Windows VS2026 runner** — E2's Windows CI step was validated locally only against VS2022 (the
  only Windows toolchain on this host); the actual `windows-2025-vs2026` runner image and
  generator were not exercised.
- **Ubuntu 22.04 old-curl FATAL path** (C4) — this WSL host's libcurl is 8.5.0; the real
  sub-7.85 rejection was exercised only indirectly, via `-DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON`
  forcing `NOT CURL_FOUND` (confirms the message/control-flow branch, not CMake's real
  version-parsing against an actual old libcurl — that remains covered only by CI's Ubuntu 22.04
  job).
- **`npm run test:sdks` as a single literal invocation on the Windows host** (D3) — this host has
  no .NET SDK matching `global.json`'s pinned `8.0.423` and no Java/`mvn`/`gradle` at all; the
  Python leg passed standalone, and the .NET/Java legs were verified via WSL Ubuntu instead.
- **`npm run check:dry-run`** (Worker dry-run deploy validation) — not called for by this
  remediation's Decisions; not run.
- **Actual staging/production Cloudflare deployment** — none of the five branches were deployed;
  all verification is local (SQLite/`node:sqlite`, WSL, or Windows-native builds).

## Known pre-existing failures

- **`services/cloudflare-licensing-backend/test/staging-lease-drill.test.mjs`** — 7 of 369 tests
  fail on this host's Node v24.20.0. Root-caused (A2): `crypto.createPublicKey({...
  type:"pkcs1"}).export({... type:"pkcs1"})` throws `Failed to encode public key` on Node 24 even
  for a key it just parsed; `scripts/staging-lease-drill.mjs`'s `leaseVerificationKey` relies on
  that round-trip. Confirmed byte-identical to the pre-remediation baseline (`git diff` on that
  script/test file across every workstream is empty); reproduced in isolation with a 5-line
  Node-only repro script, no project code involved. Every workstream gate in this session (A
  through E) hit exactly this same 7-test failure and nothing else in `test:backend` (Ruling R7).
- **5 pre-existing WSL-environment CTest failures**: `test_project`, `test_file_publish`,
  `test_os_linux`, `test_dmi_info`, `test_execution_environment`. Confirmed as DMI/disk-ID
  unavailability inside WSL2 (no real BIOS/DMI table, no real disk IDs), unrelated to
  `device_identity` or any Workstream C change (Ruling R9). Observed identically across C1, C3's
  two presets, and C5's sanitizer build — never a new failure, never a different failure set.

## This task's (E4) own verification

### CHANGELOG (`CHANGELOG.md`, commit `eaab9a3`)

Merged three new bullets into the existing `[Unreleased]` `### Added` heading (Linux protected
device licensing + feature-scoped consent for #25; email-verified password flow for #27; the
`examples/device_bound` CI coverage; the new sanitizer CI job; the readiness script's `--env`
support), four into `### Changed` (the #27 portal/BACKEND simplification; the
`LCC_ENABLE_LINUX_DESKTOP` default change with its curl diagnostic; the rate-limiter/verified-budget
changes; the admin/portal UI honesty fixes), and seven into `### Fixed` (the #23/#24 fixes; the D1
backup polling/terminal-failure/orphan-cleanup fix; the Linux loopback/browser/checkpoint hardening;
the consolidated password-flow fix — sends links after responding, keeps links redeemable through
provider timeouts, rejects display-name/list email forms, reports committed resets as success; the
SDK Linux loader message fix). Adjusted from the brief's literal bullets where the ledger's own
examples required it (backup polling/orphan cleanup detail, readiness `--env`, the sanitizer job,
SDK Linux load errors — none of which were in the brief's original four bullets — plus the fuller
password-flow and rate-limiter wording) so the CHANGELOG matches what actually landed, not just
what was planned.

| Command | Outcome |
| --- | --- |
| `npm run test:docs-accuracy` | 14/14 pass |
| `npm run check:versions` | exit 0, no output (silent pass) |

### `npm run check:docs`

Sphinx build succeeded (52 source files, Doxygen XML step ran clean, "build succeeded"); no
warnings/errors in the run.

### `npm run check:pr`

**Result: exit 1, failing only at the pre-identified Ruling R7 exception** — every other step in
the chain passed:

`scan:secrets` → `test:scan:secrets` (13/13) → `test:docs-accuracy` (14/14) → `test:wrangler-pins`
(1/1) → `test:clean-checkout` (6/6) → `test:workflow-pins` (21/21) → `test:security-governance`
(5/5) → `test:native-security` (6/6) → `test:repository` (13/13) → `check:scripts` (clean) →
`test:versions` (38/38) → `test:release-artifacts` (24/24) → `test:release-operations` (30/30) →
`check:versions` (clean) → `test:capabilities` (17/17) → `check:capabilities` (clean) → `lint`
(clean) → `typecheck` (all workspaces + `test:wrangler-env-drift` 4/4) → `check:architecture`
(clean) → `check:hotspots` ("18 files ratcheted at 500+ lines", no drift) → `test:architecture`
(32/32) → `test:contracts` (all four canonical contracts matched, no baseline regen needed) →
`test:services`: `licensing-domain` 22/22, `cloudflare-runtime` 25/25, then `test:backend` fails —
**369 tests, 362 pass, 7 fail, all 7 in `test/staging-lease-drill.test.mjs`** (Ruling R7). The
`&&`-chained script stopped there, so `test:admin`/`test:portal`/`test:backup`/
`check:schema-parity` did not run in that single invocation.

Ran the remaining sub-steps individually to close out the chain with real evidence rather than
inferring "probably fine":

| Command | Outcome |
| --- | --- |
| `npm run test:sql --workspace @licensecc/cloudflare-licensing-backend` | 304/304 pass |
| `npm run test:pg --workspace @licensecc/cloudflare-licensing-backend` | 49/49 pass |
| `npm run test:admin` (test + test:sql + test:ui, chained) | exit 0 (last block shown: 59/59) |
| `npm run test:portal` (test + test:ui, chained) | exit 0 (last block shown: 15/15) |
| `npm run test:backup` | 89/89 pass |
| `npm run check:schema-parity` | "schema parity ok"; "pg schema semantic parity ok (50 tables, 75 explicit indexes, 6 generation trigger groups)" |

No failure beyond the one documented, pre-existing, environmental exception (Ruling R7) was found
anywhere in `check:pr`.

### `npm run test:e2e` (root)

Chains backend, admin, and portal browser suites: `tests 7 / pass 7 / fail 0` (backend e2e) →
`100 passed (1.4m)` (license-admin, Playwright) → `64 passed (22.4s)` (customer-portal,
Playwright). **Exit 0, no failures.**

## Files changed by this task

- `CHANGELOG.md` (merged Added/Changed/Fixed entries into `[Unreleased]`).
- `docs/superpowers/plans/2026-09-23-pr23-27-review-remediation.md` (new; byte-identical copy of
  the plan, confirmed via `diff` and matching SHA-256 against the source in
  `.superpowers/sdd/2026-09-23-pr23-27-review-remediation/plan-copy.md`; not edited, per Ruling
  R6 and the plan-is-fixed-during-execution convention).
- `docs/implementation/2026-09-23-pr23-27-review-remediation.md` (this report).

## Remaining risks and follow-up

- None of the five branches are merged or pushed. Two merge-conflict-risk (not logic-conflict)
  pairs were flagged in the plan's pre-flight scan and remain true at integration time: C4 and E2
  both touch `.github/workflows/linux.yml` (different steps, different branches); D2 and E1 both
  touch `doc/operations/cloudflare-setup.md` (different sections, different branches). Whoever
  integrates the five branches should expect textual conflicts there, not behavioral ones.
- `doc/architecture/system-map.md`'s per-service line totals and hotspot rows were refreshed
  incrementally, once per task that changed a tracked file's line count (A1/A2, B1/B2/B4/B5,
  D1, E3 ×2). `check:hotspots`' baseline was also bumped three times across branches
  (`tpm2_openssl.cpp` in C, `core.ts` in D, `DevicesFeature.tsx` in E). Each was independently
  verified against `test:docs-accuracy`/`check:hotspots` at the time, but once the five branches
  are combined onto one integration branch, a single fresh `test:docs-accuracy` +
  `check:hotspots` pass should be run against the merged tree rather than assuming the
  incremental refreshes compose correctly.
- The 21-item deferred minor findings list above (mostly SHOULD-FIX-later test-coverage gaps and
  one real SHOULD FIX: `portal_otp.mjs`'s OTP-timeout telemetry label) should be triaged before or
  shortly after merge; none block this remediation, but B2's is the most concrete undone item.
- This report and the CHANGELOG describe workstreams A–D as already complete on their own
  branches; if any of A–D is dropped or substantially changed before merge, this CHANGELOG entry
  and this report would need a follow-up correction (the risk Ruling R5 explicitly accepted).

## Self-review

- Verified the plan copy is byte-identical (`diff` empty; SHA-256 match) before committing it
  unedited, per the "plans are fixed during execution" instruction.
- Cross-checked every CHANGELOG bullet against the actual per-branch `git log --oneline
  main..fix/review-<x>` output and the corresponding task reports before writing it, rather than
  copying the brief's bullets verbatim — the brief's four Fixed-section remediation bullets were
  expanded to name the four password-flow behaviors the ledger explicitly called out (sends links
  after responding, keeps links on provider timeouts, rejects display-name forms, reports
  committed resets as success), and three new Added bullets (sanitizer job, readiness `--env`, and
  the fuller device-bound CI description) were added because the brief's original four bullets
  didn't mention them at all.
- Ran every command this task's Decisions section required (`test:docs-accuracy`, `check:versions`,
  `check:docs`, `check:pr`, `test:e2e`) from the worktree root, and — since `check:pr`'s `&&` chain
  stops at the first failure — additionally ran every sub-step the chain never reached
  (`test:sql`/`test:pg`/`test:admin`/`test:portal`/`test:backup`/`check:schema-parity`)
  individually, so "green except Ruling R7" is evidence, not inference.
- Did not touch any file outside `CHANGELOG.md`, the new plan copy, and this report; did not edit
  the plan; did not push; did not open a PR.

## Concerns

- None blocking. The only open item specific to this task is cosmetic: the CHANGELOG's
  remediation bullets are necessarily denser than the brief's original four-bullet draft, since
  they now have to carry the ledger's own "adjust to match what landed" examples verbatim; a
  human editor may want to trim wording further at actual release time, but nothing in it
  overstates or omits landed behavior as far as this task's cross-checks could determine.
