# Worktree reconciliation plan

Status: proposed; reconciliation and deletion have not been executed.

## Objective and authority

Recover every unique local change, establish one verified integration branch,
and retire stale working copies without losing source, plans, evidence, local
configuration, or operational state. Reconciliation is not another broad
refactoring pass.

Follow [the change guide](../../../doc/architecture/change-guide.md),
[ownership map](../../../doc/architecture/ownership.md),
[module-boundary ADR](../../../doc/architecture/decisions/0001-module-boundaries.md),
and [task-packet convention](../../../CONTRIBUTING.md#task-packets-and-handoffs).
Keep this plan fixed during execution; record findings and completed steps in
`docs/implementation/2026-09-22-worktree-reconciliation.md`.

## Observed baseline

Inventory taken September 22, 2026, after fetching origin:

| Worktree/ref | Observed HEAD | State |
| --- | --- | --- |
| `licensecc`, `main` | `ffd9ac3` | 209 tracked status entries, 298 untracked files; no staged diff |
| `licensecc-dependabot-review`, `fix/portal-oauth-navigation` | `b32a330` | Clean; 14 commits ahead of origin/main; no upstream configured |
| `licensecc-backend-ui-review` | `ef925f2` | Clean |
| `licensecc-feature-session-review` | `413c015` | Clean |
| `origin/main` | `7c8df2e2693441ee391ce52e9685fc23f3e77925` | Fetched reference |

The 209 tracked entries comprise 196 modifications and 13 intent-to-add
entries. There are nine untracked plans and 41 untracked implementation
reports within the main checkout's 298 untracked files.

A preliminary Git-filtered content comparison found 364 of the 507 local
paths identical to at least one of the three review branch tips. Another 143
did not match those tips. These are triage counts, not deletion decisions:
they do not yet cover all retained refs, history, renames, raw-byte differences,
or files that were intentionally removed later.

The older native and backend/UI work was integrated through squash commits
`f6e8af6` (#20) and `690e99d` (#21); later main commits include Linux support
and verification fixes. Do not merge old branches merely because their original
commits are absent from main's ancestry. The local-only main commit `ffd9ac3`
also needs content comparison; do not assume it is missing from the product.

`wip/pre-cleanup-snapshot` at `7e6ee84` explicitly says DO NOT MERGE. It is a
recovery reference only, not an integration candidate.

## 1. Preserve and inventory

Owner: repository/release boundary. No source edits in the dirty checkout.

1. Refresh the inventory: worktree paths, full commit IDs, branches, upstreams,
   status including intent-to-add entries, stashes, tags, and submodule state.
   Record any concurrent changes since the baseline and reclassify them.
2. Create an access-restricted local recovery directory outside every worktree.
   Save a Git bundle of required refs, separate binary-capable staged/unstaged
   patches, status/index metadata, and copies of dirty/untracked source.
   A patch or Git bundle alone does not preserve untracked files.
3. Inventory ignored files separately. Preserve local Wrangler configurations,
   secrets, databases, enrollment keys/checkpoints, deployment evidence and
   test-specific operational state locally. Do not print secret contents or
   add them to a Git commit, PR, or shared artifact.
4. Record path, size and SHA-256 for each copied file; verify the copies.
   Demonstrate restoration of source and index state in a disposable directory.
   Protect dirty submodules separately if any are discovered.
5. Take a second status/hash inventory before migration. If files changed during
   capture, repeat capture for those files instead of treating the first copy
   as a reliable snapshot.

Exit: a verified recovery snapshot exists and every local path has an owner
and initial classification. No deletion has occurred.

## 2. Build a reconciliation ledger

Owner: each source boundary, coordinated through one local ledger.

Compare all candidate paths against current origin/main, the cleanup branch,
all relevant retained refs and, where needed, commit history. Check raw bytes
as well as Git-normalized content; handle line endings, executable modes,
renames and deletions explicitly. Use merge-base diffs and patch equivalence
as aids, not substitutes for reviewing squashed or edited changes.

Required ledger columns: original worktree/path; original hash; owning
boundary; matching commit/path or comparison evidence; disposition; recovery
copy; destination commit/path; required tests; final verification state.

| Disposition | Required evidence and treatment |
| --- | --- |
| Already integrated | Exact content match or reviewed equivalent behavior in the chosen integration base; do not replay |
| Superseded | A newer implementation demonstrably replaces the local version; preserve recovery copy and record rationale |
| Unique source fix/feature | Review intent, compatibility and tests; port only the required change into its owning boundary |
| Unfinished or ambiguous | Preserve separately, name the gap and owner; do not silently drop or merge |
| Plan/evidence | Preserve until classified as active, completed, superseded or historical; connect to implementation evidence |
| Generated/reproducible output | Confirm regeneration command and absence of unique state before considering removal |
| Local operational state | Retain outside Git with an explicit owner and recovery location |

Classify all 507 observed paths, not only the 143 initially unmatched paths.
An old matching copy can still be superseded by an important later fix.

Exit: every path has a justified disposition; uncertainty is listed explicitly.

## 3. Assemble an isolated integration candidate

Owner: repository integration, with separate commits per owning boundary.

Create a new clean reconciliation branch/worktree. Use `b32a330` as the
candidate starting point if refreshed origin/main is still its ancestor.
If origin/main advanced, incorporate its updates in this isolated branch and
review conflicts before porting local work. Never use the dirty main checkout
as the integration workspace.

Review the existing 14-commit cleanup stack as a whole. Preserve its tested
changes without replaying them again. Then apply only ledger-approved unique
deltas, in this order:

1. Native C/C++ API, protected-device runtime and examples.
2. SDK/native bridges and their packaging or CI requirements.
3. Backend/shared runtime and admin/portal changes, respecting dependencies.
4. Repository/release tooling and maintained documentation.

Adjust ordering for documented dependencies. Each packet must state allowed
paths, acceptance criteria, focused tests, and compatibility impact. Do not
copy whole stale files over newer Linux support, transaction guards, APIs or
UI fixes. Do not merge the recovery snapshot or old squash-source branches.

Audit the nine old plans and 41 reports against code and verification evidence.
Older dates alone do not prove obsolescence. Retain unresolved requirements
with a named follow-up; completed plans must point to a verified result before
retirement is proposed. Keep local deployment/test details out of public docs.

Exit: unique work is either implemented in focused commits or preserved with a
specific unresolved task. No unexplained omissions remain.

## 4. Validate the final candidate

Run focused checks after each packet. On the final candidate, with Python 3.12,
uv 0.12.5, npm 10.9.8 and the repository's supported CI Node version, run:

```powershell
npm ci
npm run check:pr
npm run test:sdks
npm run setup:browsers
npm run test:e2e
npm run check:dry-run
npm run test:docs-accuracy
npm run check:docs
npm run test:docs-quickstart
pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug
```

Also run affected native configure/build/CTest presets and installed-consumer
tests on Windows and Linux; simulator coverage is the previously agreed Linux
TPM scope. Report physical-TPM or live-environment coverage as unrun where
applicable. Dry-run packaging is not a deployment. Network documentation-link
validation remains a separate optional manual check.

Record the full tested commit ID, exact commands, pass/fail/blocked outcomes,
and excluded surfaces. Existing tests at `b32a330` prove that cleanup patch,
not subsequently reconciled native/backend work. Fix failures and rerun the
affected gate; do not substitute stale evidence for final-candidate validation.

## 5. Review, integrate, then retire stale copies

1. Produce a reviewable diff, ledger and validation report. Request publication
   or merge authorization if not already supplied for that action.
2. Push the approved candidate and check its required CI results before merge.
   Verify the resulting remote main commit contains each accepted change.
3. Prepare an exact retirement list: absolute paths, hashes, dispositions,
   recovery locations, and the reason each path is safe to remove or restore.
   Recheck those hashes immediately before any mutation. New concurrent edits
   invalidate the proposed action for that path.
4. Obtain explicit approval for deleting user-owned work, protected plans,
   operational artifacts or worktrees where existing authorization is absent.
   This planning request does not authorize those deletions.
5. Only then reconcile the original checkout using path-specific actions.
   Verify resolved paths remain within the approved worktree/directory.
   Do not use blanket `git clean`, hard reset, force checkout, or force worktree
   removal. Preserve local settings and unresolved work in their designated
   locations before switching or updating the original branch.
6. Retire redundant branches/worktrees only after their source is accounted
   for and the recovery archive has been verified. Agree a retention policy
   for the archive; do not delete it as part of the same cleanup.

## Completion criteria and handoff

- Every inventoried source, plan and evidence file has a recorded disposition.
- No unique work is lost or represented as complete without verification.
- The integration candidate passes required gates at its recorded commit.
- Approved changes are on remote main, or publication remains explicitly pending.
- Retained worktrees are clean or have a precise, owned exception list.
- Secrets and operational state remain local and recoverable.
- Deletion decisions are based on verified content, not branch names or age.

If unresolved work remains, deliver a bounded follow-up list rather than claim
the repository is fully reconciled. Stop before a destructive action whenever
ownership, snapshot validity or the destination commit cannot be established.
