# Worktree reconciliation evidence

Execution of the [reconciliation plan](../superpowers/plans/2026-09-22-worktree-reconciliation.md).

## Scope and candidate

The isolated `reconcile/local-work-20260922` branch starts at
`ca81ba7313df9c2223cb662cc99516e5e7420972`, which includes the reviewed cleanup
stack and plan. Fetched origin/main was `7c8df2e2693441ee391ce52e9685fc23f3e77925`
and remains an ancestor. The original main checkout at `ffd9ac3` was not edited,
staged, reset or cleaned. No production or staging action was performed.

## Recovery and inventory

An access-restricted local recovery directory outside the worktrees contains:
the verified all-refs Git bundle; separate binary-capable staged/unstaged
patches; original index and status; source and ignored-file manifests; copies
of all 507 changed/untracked source files; and 27,825 ignored local-state files.
Secrets, deployment settings and test-specific evidence remain local only.

Copies have SHA-256 checks and were compared again to their originals. Five
long-path copy failures were resolved using extended Windows paths and verified.
Another 33,332 dependency/cache/compiled-output candidates and 19 reparse points
remain in place and are not approved for removal. No junction was traversed
during the explicit reparse inventory.

A disposable clone from the bundle reproduced all 507 source hashes and the
original status, including 13 intent-to-add entries and an empty staged diff.
Copied index stat entries initially produced false modified flags on 228 clean
checkout files. Each was checked against its index blob before refreshing only
those entries in the disposable clone; the restored status then matched exactly.
The final original-source status/hash check also passed.

## Source dispositions

The private ledger records every original path/hash, recovery copy, ownership
boundary, candidate destination, matching refs or history, rationale and checks.

| Disposition | Files | Treatment |
| --- | ---: | --- |
| Identical to candidate | 251 | Keep committed candidate version |
| Equivalent after the same C++ formatter | 49 | Keep committed formatting; preserve original bytes in recovery |
| Older blob already in candidate ancestry | 113 | Preserve newer committed version; record path history |
| Reviewed superseded version | 44 | Preserve later implementation or renamed destination |
| Historical plans/evidence | 50 | Retain locally; do not publish or delete |

No local-only source behavior requiring a port was identified. In particular,
replaying old files would undo Linux support, feature-bound comparison codes,
same-second checkpoint recovery, the linear JSON scanner, modern CI toolchain
selection, native bridge packaging, or the completed UI/example cleanup.
The removed Windows checkpoint header maps to `bound_checkpoint_platform.hpp`;
namespace construction moved to `bound_checkpoint_namespace.cpp`.

The local-only commit `ffd9ac3` contains the earlier portal account/auth flow.
Its functional surfaces exist in the candidate, including later verified-email
registration/recovery. Its original commit and historical reports are preserved
in the recovery bundle. Old squash-source branches and the explicitly marked
DO NOT MERGE snapshot were not replayed.

The nine old plans and 41 reports remain historical evidence. Several still say
proposed or incomplete despite later integration. Those labels and unchecked
cleanup boxes are not current release qualification. Requirement-by-requirement
retirement of those documents remains pending; maintained `doc/`, current
contracts and executable checks remain authoritative.

## Validation

Validated the unchanged implementation at
`ca81ba7313df9c2223cb662cc99516e5e7420972`; this report adds no production code.

| Command | Outcome |
| --- | --- |
| `npm ci` | Passed |
| `npm run check:pr` | Passed end to end, including both schema parity gates |
| `npm run test:sdks` | Passed: Python 222 passed/3 skipped; .NET 62 passed/3 skipped; Java suite passed |
| `npm run setup:browsers` | Passed for both retained revisions |
| `npm run test:e2e` | Passed: backend 7, admin browser 100, portal browser 64 |
| `npm run check:dry-run` | Passed for all four Workers; nothing deployed |
| `npm run test:docs-accuracy` | Passed, 14 tests |
| `npm run check:docs` | Passed, Doxygen/Sphinx |
| `npm run test:docs-quickstart` | Passed: install, issue, build minimal consumer, verify license |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | Passed: configure/build, 37 CTests, unchanged source fingerprints |
| `git diff --check` | Passed |

Install/PR and browser/packaging checks used Node 22 and npm 10.9.8. Python
used `UV_PYTHON=3.12` and uv 0.12.5. The first SDK attempt selected an incompatible
system .NET SDK; the complete rerun used the existing pinned .NET 8.0.423 and
Java 17 toolchains without changing repository pins. Logs remain ignored under
`build/reconciliation-*.log`.

Optional installed native-bridge tests were skipped by the SDK suites because
fixture-library paths were not configured. No fresh Linux/TPM simulator or
physical-TPM enrollment qualification was performed: no native implementation
was ported in this reconciliation. Live services and network documentation-link
validation were not exercised. These limits are separate from the successful
portable SDK, Windows default native, browser and packaging checks.

## Remaining actions

No source cleanup has been executed in the original checkout. A private,
non-executable retirement proposal lists 457 source paths, original hashes,
recovery locations and candidate commit, with approval false for every entry.
The 50 historical documents and ignored operational state are excluded.

Publication/merge and retirement of original paths/worktrees remain pending.
Recheck original hashes and remote main immediately before any approved action.
Retain the recovery archive until a separate retention decision is made.
This report does not establish physical-TPM or live-service qualification.
