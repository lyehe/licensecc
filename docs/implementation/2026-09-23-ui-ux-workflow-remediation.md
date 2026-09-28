# UI/UX workflow remediation — implementation report

Execution of the [UI/UX workflow remediation plan](../superpowers/plans/2026-09-23-ui-ux-workflow-remediation.md),
which fixes the findings of the 2026-09-23 UI/UX workflow review of the customer portal and the
admin console, including the journeys that cross both. The plan has 39 tasks: F1, A1–A6, B1–B5,
C1–C6, D1–D6, E0–E10, E4b, F2, F3 and F5. There is no F4: the plan decided "no change" for its
finding #37 (code splitting).

## Scope and verified state

- **Worktree:** a dedicated local git worktree, separate from the primary checkout.
- **Base:** `main` @ `4050889`.
- **Final head:** this report's own commit on `fix/ux-f-consistency`, directly on top of
  `1b3d976` (`fix(admin-ui): guard DeviceLimitForm's unsaved-change prompt on the retained flag
  (final review)`).
- **Size:** `4050889..1b3d976` is 222 commits; `git diff --shortstat` gives 344 files changed,
  +25,583/−3,778.
- **Nothing was pushed or merged, and no PR was opened** (Ruling R1). Checked when this report was
  written: no `fix/ux-*` branch has an upstream or a remote-tracking ref (`git for-each-ref`), and
  `gh pr list --state all --search "head:fix/ux"` returns no PR. Pushing and opening PRs is left to
  `finishing-a-development-branch`, with explicit consent.
- **Plan:** committed unedited as the first commit on `fix/ux-f1-glossary` (`b6a2350`, Ruling R2).
  `git diff b6a2350..1b3d976` on the plan file is empty. Its "Status: proposed … not executed" line
  was left alone, because plans stay fixed during execution; this report records the execution. The
  committed plan has the same blob id (`6443afb`) as the untracked copy in the primary checkout.
- **Delivery shape:** the plan describes one PR per workstream. Ruling R1 replaced that with one
  stack of branches, because the workstreams overlap at file level.
- **Global constraints, checked with git over `4050889..1b3d976`:** no migration, `schema.sql` or
  `schema.pg.sql` file changed; `package-lock.json` is unchanged; the only change to
  `scripts/hotspot-baseline.json` removes the `controls.tsx` entry (no ratchet was raised); the
  contract baselines changed only in `test/contracts/admin.json` and `test/contracts/portal.json`;
  no local Wrangler config (`wrangler.jsonc` or `wrangler.toml`), `dist/` or `node_modules` path is
  in the diff. Native and SDK files changed only in B4's six commits.
- **Method:** subagent-driven execution. Each task had an implementer and a reviewer, then fix
  rounds until the review was clean. A controller kept a ledger of every dispatch, verdict and
  ruling. The ledger and the per-task reports were session files and are not committed; everything
  this report needs from them is reproduced here.

## Branch stack

Each branch starts at the head of the branch above it. Values from `git rev-parse <branch>` and
`git rev-list --count <branch below>..<branch>`.

| # | Branch | Head | Commits ahead of the branch below | Contents |
| --- | --- | --- | --- | --- |
| 1 | `fix/ux-f1-glossary` | `deee018` | 4 (ahead of `main` `4050889`) | the plan (`b6a2350`) and F1 |
| 2 | `fix/ux-a-accounts` | `c9e7a0d` | 33 | A1–A6 |
| 3 | `fix/ux-b-protected` | `780283d` | 33 | B1–B5 |
| 4 | `fix/ux-c-portal-feedback` | `6e84c1a` | 23 | C1–C6 |
| 5 | `fix/ux-d-portal-devices` | `30938e5` | 27 | D1–D6 |
| 6 | `fix/ux-e-admin` | `ce2ca8c` | 57 | E0–E10 and E4b |
| 7 | `fix/ux-f-consistency` | `1b3d976` + this commit | 45 at `1b3d976` | F2, F3, F5 (10), F2's pin fix `d227b42` (1), the final fix wave (32), the closing nits (2) |

The seven counts add up to the 222 commits in `4050889..1b3d976`.

## Tasks

The commit range is `base..head` (the base is excluded), taken from the ledger's "Task X: complete
(commits a..b, review clean)" line. Every range was checked with `git rev-list --count` and
`git merge-base --is-ancestor`. The ranges chain without gaps: each task's base is the previous
task's head. The outcome is the plan's own task title, sometimes with detail from the commit
subjects. In the review columns, C, I and M mean Critical, Important and Minor.

| Task | Outcome | Commits | # | Fix rounds | First review | Final verdict |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | One glossary, applied to both apps | `b6a2350..deee018` | 3 | 1 | 3 I | Approved |
| A1 | OAuth never duplicates a password-login account | `deee018..6ec16c7` | 3 | 1 | Needs fixes: 2 I, 4 M | Approved |
| A2 | The magic link signs in and lands on Apps | `6ec16c7..8cc2b9b` | 6 | 1 | Needs fixes: 2 I, 5 M | Approved |
| A3 | Suspended accounts are told so, with a support contact | `8cc2b9b..35b5ed4` | 4 | 0 | Approved: 6 M (handled by R15) | Approved |
| A4 | Show which account is signed in | `35b5ed4..c52a6bd` | 4 | 1 | Approved: 1 I, 1 M (tests-only round, R19) | Approved |
| A5 | No plaintext initial password by default | `c52a6bd..811f05c` | 5 | 1 | Needs fixes: 2 I, 8 M | Approved |
| A6 | Unlink sign-in providers; document account deletion | `811f05c..c9e7a0d` | 11 | 1 | Needs fixes: 1 I, 5 M | Approved |
| B1 | Operators create license records; protected-create errors name the rule | `c9e7a0d..b3e3eef` | 9 | 1 | Needs fixes: 1 I, 7 M | Approved |
| B2 | Device limit visible and settable; policies editable; customer typeahead | `b3e3eef..a04a83f` | 11 | 1 | Needs fixes: 1 C, 6 M | Approved |
| B3 | The consent page shows devices in use and blocks a full license before approval | `a04a83f..8162366` | 3 | 1 | Needs fixes: 3 I, 6 M | Approved |
| B4 | Native reports "device limit reached" as an outcome detail | `8162366..0b53b34` | 6 | 1 | Needs fixes: 1 I, 4 M | Approved |
| B5 | Operators see capacity and denied attempts (no migration) | `0b53b34..780283d` | 4 | 1 | Needs fixes: 2 I, 1 M | Approved |
| C1 | A human message for every code, with a reference fallback | `780283d..b37ec1d` | 2 | 0 | Approved: 3 M | Approved |
| C2 | Network failures are visible | `b37ec1d..145f432` | 4 | 0 | Approved: 1 I outside its scope (carried to C6, R33), 2 M | Approved |
| C3 | A mid-session 401 returns to sign-in on every `api()` path | `145f432..270d421` | 4 | 1 | Needs fixes: 1 C, 1 M | Approved |
| C4 | Refresh failures say what failed | `270d421..ba1dd95` | 2 | 0 | Approved | Approved |
| C5 | Lifecycle states give a next step; trial end is visible | `ba1dd95..bd72063` | 7 | 2 | Needs fixes: 1 I, 3 M | Approved |
| C6 | Sign-in copy, focus and titles | `bd72063..6e84c1a` | 4 | 1 | Approved: 1 I, 2 M (fixed anyway, R37) | Approved |
| D1 | One devices page in customer terms | `6e84c1a..a556844` | 2 | 0 | Approved: 3 M | Approved |
| D2 | Results next to the control; seat state visible | `a556844..ac4f49c` | 7 | 2 | Needs fixes: 1 I, 2 M | Approved |
| D3 | Signing out doesn't orphan browser seats | `ac4f49c..de05304` | 4 | 1 | Needs fixes: 1 C, 2 I, 2 M | Approved |
| D4 | Dialogs name their target; one native pattern | `de05304..7aece7c` | 3 | 0 | Approved: 3 M | Approved |
| D5 | Visual fixes: primary hover contrast, header alignment, auth error colour, seat and consent state emphasis | `7aece7c..4d06b3f` | 7 | 1 | Needs fixes: 1 I, 2 M | Approved |
| D6 | License choice shows meaningful labels | `4d06b3f..30938e5` | 4 | 1 | Needs fixes: 3 I, 1 M | Approved |
| E0 | Split `OperatorControlsProvider` before E6 and E9 touch it | `30938e5..3aa6ab8` | 2 | 0 | Approved: 4 M | Approved |
| E1 | No refetch storm, no blanking, one render | `3aa6ab8..b04a429` | 6 | 1 | Needs fixes: 1 C, 1 M | Approved |
| E2 | Deep links open the exact record | `b04a429..d159acd` | 3 | 1 | Needs fixes: 1 C, 2 I, 2 M | Approved |
| E3 | Events show who and why, filterable and paged | `d159acd..b18b055` | 4 | 1 | Needs fixes: 3 I, 2 M | Approved |
| E4 | Webhooks: valid types and editing | `b18b055..8b739bc` | 3 | 1 | Needs fixes: 1 C, 1 I | Approved |
| E4b | "Send test event" through the backend that holds the secret | `8b739bc..4bb8e8a` | 2 | 0 | Approved: 7 M (carried, parked or follow-up) | Approved |
| E5 | Batch actions scale beyond 4 | `4bb8e8a..5d93f8c` | 4 | 1 | Approved: 10 M (Minors 1–7 fixed, R48) | Approved |
| E6 | Confirmation matches the risk | `5d93f8c..a65e9fe` | 4 | 1 | Needs fixes: 1 C, 1 I, 7 M | Approved |
| E7 | Validity dates display in UTC | `a65e9fe..34f1a15` | 6 | 2 | Needs fixes: 1 I, 2 M | Approved (1) |
| E8 | Drill-downs are in history; no stale unsaved prompt | `34f1a15..b3f539f` | 10 | 3 | Needs fixes: 1 I, 4 M | Approved |
| E9 | Admin feedback is readable, local and fresh | `b3f539f..6bfcc1f` | 7 | 1 | Needs fixes: 3 I, 7 M | Approved |
| E10 | Workspace layout and navigation polish | `6bfcc1f..ce2ca8c` | 6 | 1 | Needs fixes: 3 I, 4 M | Approved |
| F2 | Drift-proof style tokens (no new package) | `ce2ca8c..3f96d35`, then `d227b42` | 4 + 1 | 2 | Needs fixes: 2 I, 3 M | Approved (2) |
| F3 | Admin accessibility fixes: the workspace heading is the page's one h1; touch-target minimums | `3f96d35..7cb56ab` | 4 | 1 | Needs fixes: 1 C, 2 M | Approved (1) |
| F5 | One native dialog implementation in admin | `7cb56ab..dd37aa6` | 2 | 0 | Approved, no issues | Approved |

Notes:

1. The last round's re-review was done by the controller, which checked the diff and ran
   targeted tests (see Process deviations).
2. F2's second fix round (`d227b42`, Ruling R65) was committed after F5 and lies outside F2's
   range. It was verified by `test:workflow-pins` 21/21, `test:repository` 22/22, `check:scripts`
   and a full re-run of the F checkpoint.

Totals: 36 fix rounds across 30 tasks; 9 tasks (A3, C1, C2, C4, D1, D4, E0, E4b, F5) needed none.
E8's first fix round passed re-review with new Minors that R56 chose to fix, and its second round's
re-review found a pre-existing Important (B-1) that became round 3. E7's round-1 re-review found a
new Important that became round 2.

## Controller rulings

Every ruling recorded during execution, R1–R69, quoted verbatim from the controller ledger in
numeric order. R13, R14, R16, R17, R18 and R25 were numbered when their task's decisions were saved
and written into the ledger when the task was dispatched, so the ledger lists them out of numeric
order. Only the list formatting was changed: continuation sentences became sub-bullets, and two
tokens (`__proto__`, `<SupportContact/>`) were put in code spans so that they render. A script
extracted the blocks, and a second script checked that every line matches the ledger word for word.

Some rulings name controller working files and review numbering: task briefs, `task-…-decisions.md`
files, the decision numbers ("decision A6-2(c)"), reviewer finding numbers ("Minor 3", "I-1") and
`final-review-*.md`. Those files were session files and are not in the repository. Each ruling states
its decision in full without them. "The R7 evidence report" is this report.

- **Ruling R1**: branches.
  - Decision: one worktree with stacked branches:
    - `fix/ux-f1-glossary` (from main);
    - then `fix/ux-a-accounts`, `fix/ux-b-protected`, `fix/ux-c-portal-feedback`, `fix/ux-d-portal-devices`, `fix/ux-e-admin`, `fix/ux-f-consistency`, each branched from the previous head.
  - No push and no PRs until finishing-a-development-branch asks the user.
  - Why: the workstreams overlap at file level.
  - Cost if wrong: independent PRs off main would need a rebase.
- **Ruling R2**: plan committed. The plan file is committed as the first commit on fix/ux-f1-glossary (b6a2350). Plans are committed protected docs, and agents in the worktree need it. Cost: none.
- **Ruling R3**: debounce hook. B2 creates admin `src/ui/shared/useDebouncedValue.ts`, and E1 reuses it instead of creating it. Why: B2 runs first and needs debounce. Cost: none.
- **Ruling R4**: network code copy. C2 adds a `network_unavailable` copy entry to `RESULT_CODE_COPY`, and C3 adds copy for its session-ended code. Why: C1's coverage test would otherwise fail. Cost: none.
- **Ruling R5**: B4 struct scope. B4 renames only `LccDeviceBoundOutcome.reserved` (device_bound.h around line 116). The `uint32_t reserved; /**< Must be zero. */` at line 80 belongs to another struct and stays. Cost: none.
- **Ruling R6**: final review model. The final whole-branch review runs on fable, the user's chosen reviewer model. Cost: none.
- **Ruling R7**: evidence report. After the final review, one agent writes docs/implementation/2026-09-23-ui-ux-workflow-remediation.md (AGENTS.md evidence convention). Cost: none.
- **Ruling R8**: A1 copy.
  - Decision: account_link_required = "An account already uses this email. Sign in with the method you already use for it, then connect Google or GitHub under Account. Contact your administrator if you can't sign in."
  - Why: the code also fires for customers.email matches (Google/GitHub/email-code users with no password) and when password sign-in is off. The brief's "Sign in with your password" breaks C6's configured-methods rule and drops the "Contact your administrator" hook that A3 turns into `<SupportContact/>`.
  - Cost if wrong: one copy string.
- **Ruling R9**: A1 check-then-insert race with a simultaneous admin create (reviewer Minor 2).
  - Decision: deferred to the evidence report.
  - Why: the pre-check covers every sequential case. The window needs an admin create for the same verified email in the same millisecond, and a conditional insert would add an FK-abort path the tests cannot exercise.
  - Cost if wrong: a rare duplicate customer, detectable with the Minor 3 query.
- **Ruling R10**: A2 form-path outcomes.
  - Decision: every outcome of the form-encoded magic-redeem branch 303-redirects:
    - signed_in → /#/apps;
    - invalid_otp → link_expired;
    - rate_limited → rate_limited;
    - anything else (config_error, invalid_request, body_too_large) → sign_in_failed.
  - 403 cross_site_forbidden (before media dispatch), 415 and every JSON-caller response stay JSON envelopes.
  - Why: the form branch is a browser navigation, so any JSON there is a dead end. The brief lists four codes, and body_too_large is the only unlisted form outcome.
  - Cost if wrong: the status code of crafted oversized forms; one line to revert.
- **Ruling R11**: A2 contract scope.
  - Decision: the ERRORS rate_limited copy already exists and is kept. A2 documents a 303 response on authMagicRedeem in OpenAPI and regenerates contract baselines (A2 is not in the constraint's baseline list, but the response set changes).
  - Why: contract drift fails test:contracts.
  - Cost if wrong: none.
- **Ruling R12**: all 5 A2 minors go into fix round 1, including stripping auth_error/auth_result in the signed-in shell when the page is not account.
  - Why: each is small, and the stale query is a direct consequence of A2's redirect. OAuth link results keep #/account, so AccountFeature still shows them.
  - Cost if wrong: a few lines.
- **Ruling R13**: A5 invite copy.
  - Decision: the admin has no portal-origin config, so the Invite success copy says "the customer portal" instead of {portal origin}. No new admin var.
  - Why: YAGNI. Operators know their portal URL, and a new config surface needs docs, validation and deployment changes.
  - Cost if wrong: one copy line plus an optional var later.
- **Ruling R14**: A6 unlink counts only sign-in methods usable NOW.
  - Usable means: a password row with PORTAL_PASSWORD_ENABLED=1; another identity whose provider is configured; or a non-empty contact email with email delivery configured.
  - Why: this is stricter than the brief, and prevents a lockout when a "remaining" method is switched off.
  - Cost if wrong: some unlinks are refused until the operator enables a method.
- **Ruling R15**: A3 minors are carried to the later tasks that own each area, instead of a fix round on an approved task.
  - Minor 1: no test for `auth_error=__proto__`/`constructor` (the Object.hasOwn crash fix). Carried to C1 (unknown-code fallback).
  - Minor 2: the providers failure→Retry e2e is untested. Carried to C6 (providers-based recovery copy).
  - Minor 3: the mailto regex admits %2C, ';' and C0 controls, contradicting README:374. Carried to A6. Decision: tighten the classes to exclude % ; and C0/DEL; the README stays.
  - Minor 4: README:373 overclaims "wherever it tells a customer to get help" (pool_exhausted is excluded). Carried to A6, which also edits the portal README.
  - Minor 5: the 8b3d36e commit body overstates how a customer learns of suspension. Goes to the R7 evidence report; no history rewrite.
  - Minor 6: the fallback text flashes before providers load. Accepted.
  - Why: the documented carry-pointer mechanism keeps approved diffs closed and puts each fix beside related work.
  - Cost if wrong: one extra small item in three later reviews.
- **Ruling R16**: B2 create-time capacity.
  - Decision: the brief's "write through setEntitlementCapacity appended via extraStatements" cannot work, because that function reads the row itself, needs an existing row and runs its own write. Instead, a no-policy create appends a buildPolicyStampStatement-style side-write guarded by `changes() = 1` before protectedCreateAssertion. PATCH uses setEntitlementCapacity.
  - Why: this is the established policy-stamp pattern and is atomic with the claim.
  - Cost if wrong: a small refactor.
- **Ruling R17**: B3 device_connected.
  - Decision: bound_issue.mjs skips the capacity check when the attempt's key already holds an active binding for that license. The consent page therefore reports page_device_connected, and "full" means in_use >= limit AND NOT device_connected. An already-connected device keeps Approve enabled.
  - Why: the brief's rule would block a reconnection the server allows.
  - Cost if wrong: one boolean column.
- **Ruling R18**: B4 compatibility correction.
  - Decision: the brief's "old SDKs ignore the field" is false. .NET DeviceBoundClient.cs:117 and Python device_bound.py:148 reject a non-zero `reserved`, so an OLD .NET or Python SDK on a NEW native library throws on a device-limit CONFLICT.
  - Fix: all three SDKs read and expose the detail; unknown detail values never throw; the outcome version stays unchanged. The CHANGELOG and device_identity.rst state that the SDK and native library must be upgraded together.
  - Why: the plan's compatibility claim must be accurate.
  - Cost if wrong: none.
- **Ruling R19**: run a tests-only fix round for the precedence Important.
  - Why: the rule drives the trust-relevant "Connecting to {email}" line, and a scrambled COALESCE order would pass every current test.
  - Cost if wrong: two small tests.
- **Ruling R20**: Minors 3-9 go into fix round 1 (all cheap). Minor 10 is carried to C6, which edits PasswordSignIn.tsx:9.
  - The Minors: replay scope per mode; a random-secret invite-shape portal test plus renamed tests; doc accuracy; the OpenAPI wording; quote style; the shared-predicate comment; setup guide step 6.
  - Minor 10: the reset copy "We'll send a reset link to your verified email" is wrong for the unverified invited accounts A5 routes through reset.
  - Why: the fixes are small and local.
  - Cost if wrong: minutes.
- **Ruling R21**: controller decision A6-3 was defective; the implementer's correction is adopted.
  - Defect: the revoke statement's `NOT EXISTS (identity)` is also true for the LOSING request of a concurrent same-provider unlink, so the loser revoked the winner's current session.
  - Adopted fix: add `changes() = 1`, so the revoke fires only when this batch's DELETE removed the row. It is proven with a sabotage test.
  - Cost if wrong: none (strictly safer).
- **Ruling R22**: amend decision A6-2(c).
  - The email-code method counts only when `emailCodesEnabled(env) && loadOtpPeppers(env) !== null`. This departs from the decision's "same predicate as the providers envelope" wording.
  - The shared helper stays unchanged, because the UI's providers.email also drives password email links, which need delivery but not OTP peppers.
  - Why: R14's intent is "usable now".
  - Cost if wrong: an unlink is refused on a deployment that lacks OTP peppers.
- **Ruling R23**: A6 Minors 2-6 go into fix round 1.
  - The in-statement session guard on the DELETE, plus a read-only disambiguation statement: 404 when the identity is gone, 401 when the session is gone, else 409.
  - Keep the unlink status element mounted so it is announced.
  - The runbook nits (a)-(d).
  - A README warning about switching methods off.
  - Reuse the exported provider LABELS.
  - Why: a revoked session must not complete a mutation (the password route already guards this in the statement), and each fix is small.
  - Cost if wrong: one extra read statement.
- **Ruling R24**: all B1 minors go into fix round 1. Minor 1 is the drift-guard blind spots (an exact skeleton equality check, plus a differential test that the would-be row equals the committed row).
  - Why: Minor 1 is the safety net B2 relies on for stampColumns, and the rest are small.
  - Cost if wrong: minutes.
- **Ruling R25**: C5 moves the WHOLE bound_trial module (boundTrialState + boundTrialSql + boundTrialDeadlineSql) to packages/cloudflare-runtime/src/device/.
  - The brief moves only the two SQL functions, which would split an aligned JS/SQL pair across packages.
  - Importers are updated, and the old backend file is deleted with no middle-man.
  - Cost if wrong: one extra export moved.
- **Ruling R26**: the console sends the device limit only when the operator sets it.
  - The field is blank by default, with placeholder 1.
  - The API behaviour stays: an omitted field keeps the stored value; an explicit value writes.
  - Why: this restores the pre-B2 upsert semantics, matches the explicit policy_id precedent, and avoids an in-batch "fresh row" test.
  - Cost if wrong: an operator must type the limit to change it on a re-create.
- **Ruling R27**: Minors 1-5 go into fix round 1; Minor 6 (the optional App.tsx hook extraction) is skipped.
  - The Minors: owner-change copy; stale_transition at zero lines; OpenAPI matches the Worker; advisory-count copy; floating policies show seats.
  - Why: no functional value, only churn.
  - Cost: none.
- **Ruling R28**: amend decision B3-4.
  - Decision: slot_free_at renders with formatTimestamp (local date and time), consistent with the Devices page "slot available {time}" and LicenseChoice's Expires. When slot_free_at >= the request's expires_at, add "This request expires before then. Start connecting again from your app after that time."
  - Why: the UTC formatEpoch rule is for date-granular validity windows, not points in time.
  - Cost if wrong: one formatter call.
- **Ruling R29**: B3 minors 4-7 and 9 go into fix round 1; Minor 8 (styling of .consentCapacity/.consentConnected) is carried to D5.
  - The minors: comment and OpenAPI wording without the "ruling R17" citation; singular copy for limit 1; hide "Uses one device slot…" when device_connected; live region, focus and "Checking…"; the slot_free_at advance test.
- **Ruling R30** (process):
  - Decision: repo files (code, comments, OpenAPI, docs, tests) must never cite controller ruling IDs ("R17") or ledger terms. State the rationale in plain words instead. This goes in every dispatch from now on.
  - Why: implementers cited R10 and R17 in repo text twice, and the published API readers cannot look them up.
  - Cost: none.
- **Ruling R31**: all B4 items go into fix round 1.
  - Why: docs and test tightening only, cheap, and the compatibility text must be accurate.
  - Cost if wrong: none.
- **Ruling R32**: C1 Minors 2-3 are carried into C2 as small leading items.
  - Minor 3: the coverage test walks ALL files under src/ui recursively for localMessage literals and constants; decision C1-3 said "under src/ui".
  - Minor 2: add a source comment on the access_required/bootstrap_otp classification.
  - Why: C2, C3 and D add codes, possibly in new files. A hard-coded list would silently miss them and defeat the test's purpose.
  - Cost: a few lines.
- **Ruling R33**: C2's findings go to the next task that owns each file.
  - Important → C6 (edits passwordMessages.tsx): add network_unavailable → "Couldn't reach the portal. Check your connection and try again." plus a unit test.
  - Minor 1 → C3 (adds copy in portalWorkflow.ts): reword the comment to say the codes are unique to the break-glass route.
  - Minor 2 → C4 (refresh-failure copy): comment or remove the dead usePortalData catch.
  - Why: the carry-pointer mechanism keeps an approved task closed and puts each fix in the task that owns the file.
  - Cost: none.
- **Ruling R34**: C3 fix round 1.
  - (a) Mirror logout's cleanup (clearPortalData, deviceController.clear, downloads.clear) in the confirmed-session-gone branch. Consent and enrollment state stay untouched.
  - (b) Guard stragglers with a session epoch: api() captures the epoch at request start, and the hook ignores a 401 from an older epoch.
  - (c) An e2e test: customer A's session ends, customer B signs in, and none of A's data is ever visible.
  - Why: this is a cross-customer data exposure.
  - Cost: small.
- **Ruling R35**: amend decision C5-2.
  - (i) A legacy SQL twin legacyTrialDeadlineSql(e) sits beside the legacy rule's D1 adapter (runtime lease/trial_store.mjs), with a parity test against evaluateTrialActivation.
  - (ii) The portal picks the rule by enforcement_mode and clamps with min(coalesce(valid_until,MAX), deadline).
  - (iii) A new boolean trial_starts_on_activation.
  - (iv) The UI label: ends/ended date; else "starts when you activate" only with the flag; else "Trial".
  - Tests per the review.
  - Why: the display must never contradict the enforcing rule, and the consent page already uses this shape.
  - Cost if wrong: a slightly larger select.
- **Ruling R36**: C5 fix round 2 folds in Minors 1-2 and the status-gating of the "starts when you activate" phrase (shown only when the row is active or not yet valid).
  - Why: all three break the display-never-contradicts-the-enforcing-rule principle that R35 set; each is one line.
  - Cost: minutes.
- **Ruling R37**: C6 fix round 1 covers all three.
  - Why: an untested hint whose only claimed coverage is false is a real gap, and the fixes are small.
  - Cost: minutes.
- **Ruling R38**:
  - Fix round 1 clears local result messages when the owning page is left (route transition or unmount), and deduplicates the detail formatter into one helper.
  - Minor 1 (seat-state styling) is carried to D5.
  - Why: stale live-region text misleads users and breaks the panel's collapse; the formatter is cheap.
  - Cost: small.
- **Ruling R39**: fix round 2 adds a visit generation.
  - Each entry to Devices or Apps bumps a counter. An action captures it at start, and on response it writes the local message only when the generation is unchanged.
  - Session and seat state still updates normally.
  - An e2e test with a delayed response covers it.
  - Why: this closes the remaining path to the same symptom.
  - Cost: small.
- **Ruling R40**: fix round 1 covers all five.
  - Hydrate on [customer, sessionEpoch], using currentSessionEpoch.
  - A signingOut state disables Sign out, shows "Signing out…" and blocks the busy-gated controls.
  - A pure extraction from DevicesFeature (for example the seat-release confirm flow or controller pieces into sibling modules), targeting 400 lines or fewer so D4 has room.
  - The race comment.
  - The seat summary shows even when logout fails.
  - Why: the Critical reintroduces the bug class D3 exists to fix, and the hotspot would block D4.
  - Cost: moderate.
- **Ruling R41**: D5 is implemented on sonnet instead of haiku, because it now carries several code items (the D4 minors plus the styling carries).
- **Ruling R42**: fix round 1 covers:
  - the error colour for ProviderResult failures and for PasswordSettings failures (full consistency);
  - removal of the R20/R15 ledger citations in portal-ui.e2e.mjs, keeping the plain-words reason.
  - Why: the brief's rule is unqualified, the same screen must behave consistently, and the citation cleanup is cheap here.
  - Cost: minutes.
- **Ruling R43**:
  - Do NOT rewrite history for the missing trailers. The branch is unpushed, but the safety norm is new commits over amending. Record the two SHAs in the R7 evidence report.
  - Fix round 1: delete shortReference; make the mobile test assert the new label format for real (and prove it bites); correct the report's test line.
  - Why: the trailer gap is cosmetic and recorded, and the test and dead-code fixes are real.
  - Cost: none.
- **Ruling R44**: amend brief/decision E1.
  - The entitlements request fence EXCLUDES `active`, like the Licenses/Policies/Webhooks fences the implementer already made active-free. The brief's "fenceKey includes active" is dropped because it causes the Load More regression, and nothing else depends on it (the other three lists prove this).
  - Add an e2e: load 2+ pages, switch away and back, and Load More is still visible and fetches the next page.
  - Wrap the CSS override in @media (max-width:1023px).
  - Why: E1's zero-request tab re-entry makes an active-inclusive fence self-defeating.
  - Cost if wrong: a late in-flight response applies while the tab is inactive, which is harmless because the component stays mounted.
- **Ruling R45**: fix round 1 covers all five items.
  - Reuse the canonical runtime legacyTrialDeadlineSql/boundTrialDeadlineSql by enforcement_mode, with the min(coalesce(valid_until,MAX),…) clamp, as the portal does. Add a test with an earlier valid_until.
  - Restructure the query so the common path range-seeks valid_until (for example a UNION with a trial-only branch). Record the EXPLAIN evidence.
  - Add a visible license filter chip or banner.
  - Add the two e2e tests.
  - Why: this is the display-never-contradicts-the-enforcing-rule principle again (as in C5), and the report is a proactive alert.
  - Cost: moderate.
- **Ruling R46**:
  - Fix round 1 drops the cursor default and regenerates the baseline, and adds aria-busy to the Events region.
  - The missing (created_at,id) index is a TRACKED FOLLOW-UP migration, not this plan: the global constraint says no planned migrations, and the unfiltered list already full-scanned before E3, so it is not a regression. Record it in the R7 evidence report's follow-up list.
  - Cost if wrong: slower deep paging on large audit logs until the follow-up lands.
- **Ruling R47**:
  - (a) The UI PATCH sends only changed fields, so event_types is omitted when unchanged.
  - (b) The server skips closed-set validation when the submitted event_types equals the stored value. This protects API clients.
  - (c) The Edit form shows any legacy tokens explicitly, noting they will be removed if the event types are changed; never drop them silently.
  - (d) Derive the UI groups from the imported WEBHOOK_EVENT_TYPES subpath.
  - Tests: an e2e/worker test that editing the URL of a legacy-token endpoint succeeds, and a server test for an unchanged legacy value.
  - Why: validation must not lock operators out of existing records, and derivation must remove the drift risk.
  - Cost: small.
- **Ruling R48**: E5 minors 1-7 are fixed now in fix round 1, while the implementer still has context; they are not parked.
  - Minor 1: the "rf5" key literal must go (no plan terms in repo text).
  - Minors 2, 3 and 5: copy.
  - Minor 4: a partial refusal followed by a failed refresh must not say "Action succeeded". A display must not contradict the outcome.
  - Minors 6 and 7: runner-test gaps, plus one bulk-Reenable e2e with 5 rows.
  - Minor 8 (aria-busy wrapping the dialog's live region): parked for the final wave (shared E0 dialog, E10 scope).
  - Minors 9 and 10 (per-row failure count; beforeunload; stop-after-chunk): follow-up list.
- **Ruling R49**: presets stay entitlement-only. The preset reasons (payment, customer request, fraud) describe entitlement decisions, and the brief's file list names features/entitlements. Whether other irreversible actions need typed confirmation is a question for the reviewer: fix it if the answer is a clear yes, otherwise park it.
- **Ruling R50**: E6 fix round 1 fixes Critical 1 and Important 1, and also these Minors:
  - 1: freeze the confirmed projection binding and apply only if it is still current;
  - 2: a comment on the gap before the gate is claimed;
  - 3: projection e2e for Escape, the body pin, and Apply staying enabled after Cancel;
  - 4: a shared TypedConfirmationField plus typedConfirmationMatches, used by both dialogs, with send() re-checking;
  - 5: the device-revoke typed gate "REVOKE 1". It is terminal, so it clearly falls under "confirmation matches the risk", which answers R49's open question;
  - 6: accessibility and API nits: a named presets group, focus to the reason field after a preset, autoComplete and spellCheck off, readonly presets, confirmLabel used for Revoke/Apply/Disconnect, glossary term instead of "grant".
  - Catalog import Apply without a typed gate goes to the follow-up list: it is reversible configuration, not terminal. Minor 7 (process note) is recorded only.
- **Ruling R51**: E7 uses sonnet, not haiku. There are 47 date-format call sites across 12 files, and each must be classified as either a validity value or an event timestamp. Getting one wrong would show the wrong day.
  - formatUtcDate shows "YYYY-MM-DD UTC" for epochs on a UTC midnight, and "YYYY-MM-DD HH:MM UTC" otherwise. For example, a computed trial deadline must not lose its time, because the display must not hide when a grant stops.
  - formatEpoch (event, audit, created and updated timestamps) stays local but gains a time-zone suffix.
  - Input parsing (dateInputToEpoch, which already uses UTC midnight) is unchanged.
- **Ruling R52**: both classification concerns are accepted as built.
  - The preview-capability effective_at/expires_at (a 300 s server TTL) is an operational timestamp, not a validity date, so it stays local with a zone.
  - Protected-connection hold and release deadlines and metering period boundaries are enforced or billing instants, so they are shown in UTC. The reviewer confirms the full table.
- **Ruling R53**: formatUtcDate must never throw.
  - A non-finite value (NaN or ±Infinity) shows "Invalid date".
  - A finite value beyond the JS Date range shows "after 275760-09-13 UTC" (the true statement: the grant does not end in any representable time). It must NOT show "-", which would be read as null.
  - A finite value before the range shows "before -271821-04-20 UTC", for symmetry.
  - Pin every case, plus single-digit padding and one negative epoch, in unit tests.
  - Follow-up list: the admin UI has no React error boundary, so one bad row can blank the page, and entitlement valid_until has no upper bound on the server. Both are out of this plan's display scope.
- **Ruling R54**: concern 4 (push, not history.back) is accepted, because it is race-free and the browser Back still steps back. Concern 2 goes to the reviewer: a false "not found" and a stuck loading state would both make the display contradict reality.
- **Ruling R55**: E8 fix round 1 covers:
  - I-1 as the reviewer prescribes:
    - the single-plan GET is the existence check, and only a 404 catalog_plan_not_found resolves as missing;
    - a hidden plan clears the plan filter, with a notice;
    - a transient failure shows "Plan unavailable" with Retry, never a stuck loading state or a false "not found";
    - fixture handler and e2e tests;
  - M-1: the probe uses limit=1;
  - M-2: the resolver takes a customerId;
  - M-3: prune entries far behind the current index, and drop the focus refs of old entries;
  - M-4: skip the editor close while busy or locked; restoring the row focus for the in-app back is optional if cheap.
- **Ruling R56**: N-1 and N-2 are fixed now in fix round 2, not parked. Silent draft loss and an editor shown over the wrong address both break the display principle, and the fix is small.
  - Add NavigationGuard `blocks?: () => boolean`. allowLeave refuses while any guard blocks, like the modal check. The catalog guard passes `blocks: () => busy && editorRef.current !== null`.
  - Simplify the busy-deferred close.
  - N-3: key the memo on the plans array identity.
  - N-4: optional.
- **Ruling R57**: fix B-1 in E8 fix round 3.
  - distance = 0 when the landed index is unknown (a foreign session or a typed address). Overwrite the landed entry through the existing distance-0 branch.
  - Reset restoringKey in transition.
  - Add a reload + refused Back e2e.
- **Ruling R58**: concerns 1, 2 and 6 are accepted.
  - (1): the typed ripple cannot be split and still build, and the branch HEAD is green.
  - (2): the decision says a create opens the record.
  - (6): it is a console-only code with no API impact.
  - The reviewer judges 3, 4 and 7 against the display principle.
- **Ruling R59**: E9 fix round 1 covers:
  - Important 1-3;
  - Minors 4-10 in full (each is a display-honesty or freshness issue, and E9 owns feedback);
  - the optional draft-policy confirmation, for consistency with plan create;
  - dropping the ConfirmRefreshFailure code-shaped super message;
  - routing the pre-existing developer-toned strings "Mutation outcome unknown; do not retry." and "Action succeeded; status refresh failed" through messages.ts if that is cheap.
  - Overview "Disabled" goes to the final wave only if it is a glossary term.
- **Ruling R60**: E10 fix round 1 covers Important 1 and 2 and Minors 1-4. For Minor 3, add a unit parity test that reads both constants.
  - Important 3 is NOT fixed: F5 deletes the fallback branch in its next task, so a test for code about to be deleted adds nothing. The report's coverage claim is corrected instead.
- **Ruling R61**: F3 asserts the axe rules directly in e2e (exactly one h1; target sizes at least 24px; summary at least 44px). It does not add axe-core as a new dependency: the repo has no axe, and one check does not justify a new supply-chain dependency and lockfile change. The F addendum is in task-F-decisions.md.
- **Ruling R62**: F2 fix round 1 covers Important 1-2 and Minor 1 (read only a depth-zero :root, and fail when there is more than one top-level :root or none). It also covers Minor 2: sweep admin's raw base-palette hex onto its own tokens. The values are byte-identical and this completes the "drift-proof" intent cheaply. Minor 3: no action.
- **Ruling R63**: F3 uses sonnet, not haiku. Moving the h1 from the sidebar brand to the workspace heading ripples into the heading-focus helpers and many e2e heading queries, which is beyond a mechanical change.
- **Ruling R64**: F3 fix round 1.
  - Keep the native `display: list-item` marker on every summary. Reach 44px with min-height, padding and line-height, and never set a global display:flex. Summaries with their own indicator (.contextActions) keep their rules.
  - Re-check the .entitlementIdentity density fix.
  - Add an e2e: every visible summary shows an open/closed indicator, meaning either list-item with a list-style other than none, or an explicit indicator element.
  - Radios: record the WCAG 2.5.8 judgement (a radio wrapped in its label makes the label part of the target). Any radio not wrapped in a label goes to 24px.
  - Delete the dead .brand p rule.
- **Ruling R65**: fix it as F2 fix round 2. Update the pin to the new command, which keeps the exact-once contract, and check that lint.yml still runs test:repository once. Then re-run the full F checkpoint.
- **Ruling R66**: the single final fix wave runs as three agents one after another on fix/ux-f-consistency (same worktree, so commits and shared files cannot collide):
  - (1) portal: opus, final-review-portal.md;
  - (2) admin: opus, final-review-admin.md;
  - (3) core/docs: sonnet, final-review-core.md. It runs last, so the CHANGELOG and system-map describe the final state.
  - Each agent fixes every Important item and every Minor classified fix-wave, plus the parked §A items the reviews confirmed. Follow-up and no-action items are left alone and recorded in the evidence report.
  - Also, where the reviews offered a fix-wave-sized option, take it: the admin M-2 visible lock, the core M-7 PORTAL_SUPPORT_CONTACT validation, and the A2 loadSessionPeppers gate (M-5).
  - A scoped fable re-review of the whole fix wave follows, then the checkpoint, then the evidence report.
- **Ruling R67**:
  - (1) is fixed now. No failure may be left with no surface: a release failure whose section is not on screen goes to the page-level status line. The portal agent is resumed.
  - (2) is a dedicated citation sweep over the whole plan diff, run as its own agent after the admin wave. It excludes the committed plan file (R2) and legitimate identifiers such as Cloudflare D1, hex colours and ADR numbers.
  - Fix wave order: (1b) portal follow-up, (2) admin, (3) citation sweep, (4) core/docs.
- **Ruling R68**: all three admin concerns are accepted.
  - (1) is the principled choice: never trade away draft-loss prompts for a visible lock.
  - (2) is recorded for the evidence report.
- **Ruling R69**: fix N-1, N-2 and N-3 in a small closing commit set. The CHANGELOG must be exact, and the guard must be consistent with its sibling guards. N-3 needs no re-review beyond the controller's diff check and targeted tests. Then the evidence report (R7).

## Final whole-branch review

Ruling R6 set the model. The review covered `4050889..dd37aa6`: 187 commits, 341 files,
+24,605/−3,743, confirmed with `git diff --shortstat`. Three read-only area reviewers ran in
parallel. None of them ran tests, because the F checkpoint was running in the same worktree at the
time.

| Area | Critical | Important | Minor | Area verdict |
| --- | --- | --- | --- | --- |
| Core: native, SDKs, backend, runtime and domain packages, portal Worker, scripts, docs | 0 | 2 | 8 | Ship-ready after fix wave |
| Portal UI | 0 | 4 | 15 | Ship-ready after fix wave |
| Admin UI and Worker | 0 | 2 | 22 | Ship-ready after fix wave |
| **Total** | **0** | **8** | **45** | |

The eight Important findings and the commits that fixed them:

| Finding | Commit |
| --- | --- |
| Core I-1: `doc/architecture/system-map.md` gave the admin route count as 74; the contract generator says 75. B1 and E4b each added a route. | `d5a71c5` |
| Core I-2: the CHANGELOG recorded only B4 and the B3 deploy coupling. The other operator- and API-facing changes were missing (new routes, the `PORTAL_SUPPORT_CONTACT` var, the `WEBHOOK_OPERATOR` binding, the Invite default, denial rows and more). | `8f117ae` (16 bullets); wording corrected in `ceff61c` |
| Portal 1: pressing browser Back while a Release confirm was open unmounted the dialog, but `main` stayed `inert` and `aria-hidden`, so the page froze until reload. | `9624156`; follow-up `0c46b3c` (Ruling R67) |
| Portal 2: `LicenseChoice` showed the same `valid_until` as a UTC day in the option and in local time in the summary. | `72b1c72` |
| Portal 3: a seat card disabled Start seat and Renew seat on license dates but gave no reason. | `72b1c72` |
| Portal 4: a successful device release never showed "Device released.", because the row, or the whole section, unmounted on refresh. | `72b1c72` |
| Admin I-1: "Show all" inside Manage access dropped `customer_id` and listed every customer's grants, with the row actions live. | `0573b06` |
| Admin I-2: Expiring soon left out an unstarted activation-basis trial whose stamped `valid_until` fell inside the window. | `416465f` |

How the Minors were classified, counted from each finding's own label:

- **Core (8):** M-1 to M-7 fix-wave. M-5 was fix-wave only for its two-line gate, with no action on
  the rest. M-6 was optional, and M-7 was "fix-wave (small) or follow-up". M-8 was no action.
- **Portal (15):** 11 fix-wave (findings 5–12, 14, 15, 17), 1 follow-up (16) and 3 no action (13,
  18, 19). The review's header line says "9 fix-wave, 1 follow-up, 5 no action", which does not
  match its own per-finding labels. The re-review's cross-check agrees with the per-finding labels.
- **Admin (22):** 14 fix-wave (M-1, M-3 to M-14, M-21), 5 follow-up (M-2, M-15, M-16, M-19, M-20)
  and 3 no action (M-17, M-18, M-22). M-2's label also allowed a one-line fix, which Ruling R66 took.

## Final fix wave

Ruling R66 set the plan: one fix wave of agents run one after another on `fix/ux-f-consistency`.
Rulings R67–R69 added a portal follow-up, a citation sweep and closing nits. Every fix-wave and
closing commit subject ends in "(final review)".

| Part | Range | Commits | Files (+/−) | What it fixed |
| --- | --- | --- | --- | --- |
| 1 portal | `d227b42..158e0ec` | 6 | 25 (+535/−176) | Portal Important 1–4 and Minors 5–12, 14, 15 and 17. Minors 10, 11, 12 and 14 close parked items: the shared busy label, the resend interval, "Show all apps" and unknown apps, and a test comment. RED first in `240cd5d`. |
| 1b portal follow-up | `158e0ec..ade8b83` | 3 | 7 (+151/−15) | Ruling R67: a release refused while its section is off screen is reported in the page-level status line. The line clears on page change, and a session-generation guard drops late results. A device failure hidden by search shows under the list. RED first in `ce140e7`. |
| 2 admin | `ade8b83..f0387a4` | 13 | 44 (+395/−117) | Admin I-1, I-2, M-1 to M-13 and M-21 (M-14 was left to part 4). M-2 took the visible-lock option, split into `operationLocked` and `operationRetained` (Ruling R68). RED first in `ea9d9f7`. |
| 3 citation sweep | `f0387a4..8a5a4d1` | 3 | 73 (+281/−283) | Plan, task, review and ruling IDs removed from repo text in 219 places (hunks), with each reason restated in plain words. Renamed `test/sql/workstream-e.test.mjs` to `events-paging.test.mjs`. The committed plan and legitimate identifiers (Cloudflare D1 and R2, hex colours, the Unicode "C0" control block) were left alone. |
| 4 core/docs | `8a5a4d1..d5a71c5` | 7 | 15 (+195/−25) | Core I-1, I-2 and M-2 to M-7, plus admin M-14. M-5 made the magic link and code redemption check the session peppers before the single-use claim. M-6 added `instr(email,'@') > 1`. M-7 and M-14 made the deploy-config materializer validate `PORTAL_SUPPORT_CONTACT` and name unknown service bindings. `test/contracts/portal.json` was regenerated; only the logout description changed. Core M-1 needed no edit, because no citations remained in its area after the sweep. RED first in `590be25`. |
| 5 closing nits | `d5a71c5..1b3d976` | 2 | 3 (+15/−13) | Ruling R69. `ceff61c` fixed N-1 (the retry-after routes in the CHANGELOG) and N-2 (the Events UTC entry now says only the labels changed). `1b3d976` fixed N-3: `DeviceLimitForm`'s unsaved-change guard now reads `operationRetained`, like its sibling guards, and the system-map total was refreshed. |

Parts 1 to 4 add up to the range the re-review covered: `d227b42..d5a71c5`, 32 commits, 121 files,
+1,545/−604.

Commands and outcomes reported by each part, all run on this Windows host with Node v24.20.0:

| Part | Commands and outcomes |
| --- | --- |
| 1 and 1b | portal `npm test` 198/198 + 28/28; `test:ui` 49/49; `test:e2e` 154, then 156 after 1b; root `lint` and `typecheck` exit 0; `check:hotspots` and `check:architecture` passed; `test:docs-accuracy` 14/14; `test:contracts` 8/8 |
| 2 | admin `npm test` 158/158, `test:sql` 183/183, `test:ui` 126/126, `test:e2e` 198/198; root `test:admin`, `lint`, `typecheck` (with `test:wrangler-env-drift` 4/4), `check:hotspots`, `check:architecture` passed; `test:docs-accuracy` 14/14; `test:contracts` 8/8 (admin 75 routes, portal 36); `check:schema-parity` ok |
| 3 | root `lint`, `typecheck`, `test:docs-accuracy` 14/14, `check:hotspots`, `check:architecture`, `test:repository` 22/22, `check:scripts`, `test:workflow-pins` 21/21; admin 158 + 183 + 126 and `test:e2e` 198/198; portal 198 + 28, `test:ui` 49/49, `test:e2e` 156/156; backend `test/sql/bound-device-http.test.mjs` 34/34 |
| 4 | portal 198 + 28, `test:ui` 49; root `lint`, `typecheck`, `test:docs-accuracy` 14/14, `check:hotspots`, `check:architecture`, `test:architecture` 32/32, `test:contracts` 8/8, `test:repository` 22/22, `check:scripts`, `test:workflow-pins` 21/21, `test:release-operations` 34/34, `test:admin`, `test:portal`, `test:backup` 96/96, `check:schema-parity` ok, `check:docs` exit 0; `check:pr` twice, failing only on the Node-24 exception |
| 5 | root `lint` and `typecheck` exit 0; `test:docs-accuracy` 14/14 (it failed once on the stale admin total, before the refresh); `check:hotspots` passed; admin `npm test` 158/158, `test:ui` 126/126, `test:e2e` 198/198 |

### Re-review of the fix wave

The re-review ran read-only over `d227b42..d5a71c5` and its verdict was **Fix wave quality: Approved**.
Its findings:

- All 8 Important findings are fixed, each in every path the review described and each pinned by a
  test aimed at the exact defect.
- No fix-wave Minor was skipped. The follow-up and no-action items were left alone as classified.
- A strict grep of the added lines for plan, task, review and ruling IDs found one hit: "R2 SQL
  exports", which is the Cloudflare R2 product. No citations remain.
- Of the 16 new CHANGELOG entries (8 Added, 6 Changed, 2 Fixed), two had wording errors (N-1, N-2).
- Every commit carries the attribution trailer and the "(final review)" tag.
- New issues: N-1 and N-2 (the CHANGELOG wording), N-3 (the `DeviceLimitForm` guard read the
  visible lock, although no reachable path dropped a draft) and N-4, a nit with no action. Ruling
  R69 fixed N-1 to N-3 in part 5.

## Verification evidence

### Method

The checkpoint numbers below were re-read from the saved checkpoint command logs, which are
temporary and not committed; they match the ledger. The fix-wave numbers come from the fix-wave
reports. The checks in [Run for this report](#run-for-this-report-at-1b3d976) were run again by the
author of this report. All runs used this Windows host with Node v24.20.0.

`npm run check:pr` chains its stages with `&&`. At every checkpoint, the backend `npm test` inside
`test:services` fails with the seven Node-24 failures described under
[Known Node-24 exception](#known-node-24-exception). That stops the chain, so `test:admin`,
`test:portal`, `test:backup` and `check:schema-parity` never run inside that invocation. At every
checkpoint they were run separately: the backend `test:sql` and `test:pg`, then those four.

### Workstream checkpoints

In the table, the admin figure is `npm test` + `test:sql` + `test:ui`, and the portal figure is
`npm test` (two suites) + `test:ui`.

| Checkpoint | Ref | `npm run check:pr` | Remaining steps, run separately | Browser e2e |
| --- | --- | --- | --- | --- |
| A | `c9e7a0d` | every stage through `test:contracts` passed; licensing-domain 22/22; cloudflare-runtime 26/26; backend `npm test` 364/371 | backend `test:sql` 314/314, `test:pg` 49/49; admin 124 + 133 + 60; portal 187 + 26 + 20; `test:backup` 96/96; `check:schema-parity` ok | none recorded |
| B | `780283d` | same; 22/22; 29/29; backend 364/371 | 321/321, 49/49; admin 135 + 171 + 70; portal 187 + 26 + 20; 96/96; ok | none recorded (the native gates ran in B4, below) |
| C | `6e84c1a` | same; 22/22; 35/35; backend 364/371 | 319/319, 49/49; admin 135 + 171 + 70; portal 198 + 28 + 45; 96/96; ok | portal 117/117 |
| D | `30938e5` | same; 22/22; 35/35; backend 364/371 | 319/319, 49/49; admin 135 + 171 + 70; portal 198 + 28 + 48; 96/96; ok | portal 143/143 |
| E | `ce2ca8c` | same; 23/23; 45/45; backend 364/371 | 330/330, 49/49; admin 158 + 182 + 126; portal 198 + 28 + 48; 96/96; ok | admin 186/186 |
| F | `dd37aa6` | **failed at `test:workflow-pins`, 20/21**: "repository organization contracts are exact-once local PR gates" (the F2 regression, see Process deviations); later stages did not run | 330/330, 49/49; admin 158 + 182 + 126; portal 198 + 28 + 48; 96/96; ok | admin 191/191, portal 143/143 |
| F re-run | `d227b42` | every stage through `test:contracts` passed (`test:repository` 22/22); 23/23; 45/45; backend 364/371 | carried from `dd37aa6`; `d227b42` changes one line of `scripts/workflow-action-pins.test.mjs` | carried from `dd37aa6` |
| **FINAL** | **`d5a71c5`** | every stage through `test:contracts` passed; 23/23; 45/45; backend 364/371 | 330/330, 49/49; admin 158 + 183 + 126; portal 198 + 28 + 49; 96/96; ok | **admin 198/198, portal 156/156** |

`check:schema-parity` printed "schema parity ok" and "pg schema semantic parity ok (50 tables, 75
explicit indexes, 6 generation trigger groups)" at every checkpoint.

**Native gates (B4).** Native and SDK files changed only in B4 (`559ad58` to `0b53b34`), so the
native gates ran there. Neither B4 round compiled the Java JNI bridge with MSVC; see Surfaces not
run. The initial round's checks ran at or just before `6390d2b`. Fix round 1 re-ran them on the tree
that was then committed unchanged as `cd527b3` and `0b53b34`:

- Windows, `ctest --preset ci-windows-device-identity-test -L device_identity --no-tests=error`:
  25/25, in both rounds.
- `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`: passed, 37/37 CTests,
  "source fingerprints were unchanged", in both rounds.
- WSL Ubuntu 24.04, `ci-linux-device-identity-test`: 58/60, in both rounds. The only failures were
  the exempt DMI-skew tests `test_os_linux` and `test_dmi_info`, and all 23 device-identity tests
  passed.
- `npm run test:sdks` on Windows, initial round: exit 145. The Python leg passed (226 passed,
  3 skipped). The .NET leg could not start, because `global.json` pins SDK 8.0.423 and the host has
  8.0.425. The Java leg was not reached, because the host has no JDK. The .NET leg then ran in WSL
  with 8.0.423 (66 passed, 3 skipped), and the Java leg ran in WSL with JDK 17.0.20 ("Java SDK
  tests passed"; round 1 re-ran the Java leg).
- WSL installed bridges, mirroring `linux.yml`, in both rounds: Python 138 passed, 2 skipped; .NET
  68 passed, 1 skipped; all Java JNI checks passed.
- Device-bound example: WSL 5/5 in both rounds; Windows 5/5 in round 1.
- `npm run check:docs`: exit 0, in both rounds.

### Final checkpoint at `d5a71c5`, stage by stage

`npm run check:pr`:

1. `scan:secrets`: ok.
2. `test:scan:secrets`: 13/13.
3. `test:docs-accuracy`: 14/14.
4. `test:wrangler-pins`: 1/1.
5. `test:clean-checkout`: 6/6, plus "CMake tool resolution fixtures passed.".
6. `test:workflow-pins`: 21/21.
7. `test:security-governance`: 5/5.
8. `test:native-security`: 6/6.
9. `test:repository`: 22/22.
10. `check:scripts`: passed.
11. `test:versions`: 38/38.
12. `test:release-artifacts`: 24/24.
13. `test:release-operations`: 34/34.
14. `check:versions`: exit 0.
15. `test:capabilities`: 17/17.
16. `check:capabilities`: exit 0.
17. `lint`: exit 0.
18. `typecheck`: exit 0 (`test:wrangler-env-drift` 4/4).
19. `check:architecture`: "Architecture policy passed.".
20. `check:hotspots`: "Hotspot growth check passed: 18 files ratcheted at 500+ lines.".
21. `test:architecture`: 32/32.
22. `test:contracts`: 8/8, then "Canonical contracts passed: backend (23 routes), admin (75
    routes), portal (36 routes), backup (composition surface).".
23. `test:services`: licensing-domain 23/23 and cloudflare-runtime 45/45. Then the backend
    `npm test` ran 371 tests: 364 passed and 7 failed, all seven in `test/staging-lease-drill.test.mjs`.
    The chain stopped there.

Remaining steps, run separately, all exit 0:

- backend `test:sql` 330/330 and `test:pg` 49/49;
- `test:admin` 158/158 + 183/183 + 126/126;
- `test:portal` 198/198 + 28/28 + 49/49;
- `test:backup` 96/96;
- `check:schema-parity` ok.

Browser e2e: admin `npm run test:e2e` 198 passed (2.4 min); portal `npm run test:e2e` 156 passed
(1.0 min).

### After the final checkpoint

Two closing commits followed `d5a71c5`: `ceff61c` and `1b3d976`. `git diff --name-only
d5a71c5..1b3d976` lists exactly three files: `CHANGELOG.md`,
`services/cloudflare-license-admin/src/ui/features/entitlements/DeviceLimitForm.tsx` and
`doc/architecture/system-map.md`. They were verified with:

- root `npm run lint`: exit 0;
- root `npm run typecheck`: exit 0;
- `npm run test:docs-accuracy`: 14/14 (it failed once on the stale license-admin total, before the
  system-map refresh);
- `npm run check:hotspots`: passed;
- admin `npm test` 158/158, `npm run test:ui` 126/126, `npm run test:e2e` 198/198.

There is no new N-3 e2e test. The entitlement editor and the list are mutually exclusive, so the
scenario cannot be reached. The fix-wave agent confirmed this with a probe test that failed, and it
was then removed.

`check:pr` was not re-run in full after these commits. No portal, backend, package, script or
native file changed after `d5a71c5`, so the final checkpoint's other results still describe
`1b3d976`.

### Run for this report at `1b3d976`

Run by the author of this report at `1b3d976`, Node v24.20.0. The first four commands ran on the
clean worktree before this report existed. The last four ran with this report in place and
uncommitted, which is the only difference from `1b3d976`.

| Command | Outcome |
| --- | --- |
| `npm run test:e2e --workspace @licensecc/cloudflare-licensing-backend` | 7/7 pass, exit 0 (the backend leg of root `test:e2e`, which no checkpoint ran) |
| `npm run check:docs` | exit 0; Doxygen and Sphinx "build succeeded" |
| `npm run typecheck` | exit 0 (`test:wrangler-env-drift` 4/4) |
| `npm run check:hotspots` | "Hotspot growth check passed: 18 files ratcheted at 500+ lines." |
| `npm run test:docs-accuracy` | 14/14 pass |
| `npm run lint` | exit 0 (`--max-warnings 0`) |
| `npm run test:repository` | 22/22 pass |
| `npm run scan:secrets` | "scan:secrets ok" |

## Known Node-24 exception

At every checkpoint, the backend `npm test` failed exactly these 7 tests in
`services/cloudflare-licensing-backend/test/staging-lease-drill.test.mjs`, and no others:

1. lease drill accepts only canonical staging protected fixtures
2. activate and renew exercise account token, fresh device proof, and lease signing without
   leaking fixtures
3. authorization and lease-shape failures fail the drill with safe classifications
4. a live-format lease with an invalid RSA signature cannot satisfy readiness
5. lease time evidence requires ordering, request-clock proximity, and signed-date coherence
6. the signed license section must be the exact protected fixture feature
7. lease responses and request wall time are bounded

This plan did not cause them. The test file, `services/cloudflare-licensing-backend/scripts/staging-lease-drill.mjs`
and `packages/licensing-domain/src/lease/` are all unchanged in `4050889..1b3d976`. The root cause
is recorded in the [previous remediation report](2026-09-23-pr23-27-review-remediation.md): on
Node 24, a PKCS#1 public-key export fails. The plan's Global Constraints name this as the only
known exception and say **CI's Node must pass it**. The repository's workflows pin
`node-version: 22`.

## Surfaces not run

- **`npm ci`:** not repeated for any checkpoint. The worktree used the modules installed by
  `npm ci` when it was created. `package-lock.json` is unchanged in the plan range.
- **A full `npm run check:pr` after the closing commits:** see
  [After the final checkpoint](#after-the-final-checkpoint).
- **`npm run test:sdks` as one Windows command:** it stops at the .NET leg, because the pinned SDK
  8.0.423 is missing (the host has 8.0.425), and the host has no JDK. The .NET and Java legs ran in
  WSL during B4. It was not re-run at the final checkpoint; no SDK or native file changed after B4.
- **`scripts/check-build-purity.ps1 -Preset dev-debug` and WSL Linux ctest:** they last ran in B4
  (both rounds) and were not re-run at the final checkpoint, for the same reason.
- **MSVC compilation of the Java JNI bridge and its fixtures, and CI's Windows TPM installed-bridge
  gates (`ci-windows-msvc-debug-dynamic-tpm`: Python, .NET and Java):** left to CI, as recorded at
  B4. Their Linux equivalents ran in WSL. The Windows example gate did run (5/5).
- **WSL `uv` version:** WSL's `uv` is 0.11.7 and `uv.toml` needs 0.12.5. B4's installed-bridge
  pytest in WSL therefore used an existing Python 3.12.13 venv with the locked pytest 9.1.1, read
  only. The Windows pytest used `uv run --locked` normally.
- **`npm run check:docs:links`:** not run. It is the network link check, meant for scheduled or
  manual runs.
- **`npm run check:dry-run` and `npm run test:docs-quickstart`:** not run. Neither is in the plan's
  Global Constraints gate.
- **GitHub Actions:** no workflow ran, because nothing was pushed. That includes the Node 22 run
  that must pass the staging-lease-drill tests, and the PostgreSQL conformance, Linux, Windows and
  sanitizer jobs.
- **Deployment and live services:** no staging or production deployment, no live email or OAuth
  provider, no physical TPM, and no end-to-end browser-to-native journey. Portal and admin
  behaviour was verified with the Playwright suites against their local fixtures.
- **The final review and its re-review ran no tests,** by design: they were read-only while the
  checkpoints ran.

## Process deviations

- **Commits without a trailer.** `daa97f7` (D6, RED) and `3459f92` (D6, system-map total) have no
  `Co-Authored-By` line. Ruling R43 said not to rewrite history, so they were left as they are.
- **Trailer not parsed.** `889ce04`, `343d34e` and `d159acd` (E2) contain the `Co-Authored-By`
  line, but with no blank line before it, so git does not parse it as a trailer
  (`%(trailers:key=Co-Authored-By)` is empty). Not rewritten. This was found while writing this
  report; the ledger does not mention it.
- **Two trailer wordings.** The first 98 commits, `b6a2350` to `257c0b0`, end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. From `a6e573d` (D2 fix
  round 1) on, they end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The ledger
  records this at D2 as a change in the harness's attribution text. The trailer is the session
  attribution line, not the name of each task's model: subagents ran on the models in the ledger's
  per-task table, and the fix-wave re-review noted this for the core/docs agent.
- **Commit subject tags.**
  - 33 task commits have no task tag in the subject. They are in F1, A1, A2, A3, A5, C3, C4, D5,
    E0, E1, E2, E3 and E4, going by the task ranges above.
  - Six of the 33 say "fix round 1" without naming the task: `deee018`, `6ec16c7`, `b0320d5`,
    `fc77b5a`, `4d06b3f` and `8b739bc`.
  - Other subjects use "(E10 fix round 1)", "(F2 fix round 1)", "(F3 fix round 1)", "(E5 fix 1)"
    and similar forms instead of the plain tag.
  - The 34 fix-wave and closing commits use "(final review)".
  - `d227b42` is tagged "(F2)" but was committed after F5.
- **Ruling IDs in commit messages.** Two A6-range subjects, `a147cf3` and `a49b4e1`, say "(A3
  review, ruling R15)", and 18 commit bodies cite ruling IDs. Ruling R30 binds repository files,
  not commit messages. This report is where those IDs resolve.
- **A commit body that overstates.** `8b3d36e` (A3) says "the customer only learns of it when a
  portal sign-in reports the suspension". The A3 review found that this overstates how a customer
  learns of a suspension (Ruling R15, Minor 5). Not rewritten.
- **C4 combined its test and fix** in `f690b98`, with no separate RED commit. The reviewer traced
  that the new e2e test fails on two independent assertions against `270d421`, and accepted it. C4's
  report was first written into an untracked `.superpowers/` directory inside the worktree. The
  controller moved the report out and removed that directory, which this run had created minutes
  earlier.
- **An intermediate commit fails a test.** `45efaa8` alone fails one unit test,
  `test/admin-ui-workflow/operator-controls.test.mjs`. The next commit, `2b313c9`, fixes it. Not
  rewritten (Ruling R68).
- **F2 broke a gate, caught by the F checkpoint.** F2 appended `scripts/ui-token-parity.test.mjs`
  to `test:repository`. It did not update the exact-command pin in
  `scripts/workflow-action-pins.test.mjs` ("repository organization contracts are exact-once local
  PR gates"). Neither F2's implementer nor its reviewer ran `check:pr`. The checkpoint at `dd37aa6`
  failed at `test:workflow-pins`, and later `check:pr` stages did not run. F2 fix round 2 fixed it
  in `d227b42` (Ruling R65), and the checkpoint was re-run.
- **The controller did some re-reviews itself, for one-line or mechanical fixes.** In each case it
  checked the diff and the trailers and ran targeted tests:
  - E7 round 2 (`34f1a15`): lists-reports 18/18;
  - F2 round 1 (`3f96d35`): parity test 9/9; the implementer ran admin e2e 186/186 and portal e2e
    143/143;
  - F3 round 1 (`7cb56ab`): the implementer ran `test:e2e` 192/192;
  - F2 round 2 (`d227b42`): see above;
  - the closing nits (`ceff61c`, `1b3d976`), per Ruling R69.
- **Model changes.** Rulings R41, R51 and R63 moved D5, E7 and F3 from haiku to sonnet. E6's review
  was upgraded from sonnet to opus, because one concern touched the shared operation gate.
- **A controller decision was wrong.** Ruling R21: decision A6-3 was defective, and the
  implementer's correction was adopted.
- **Report text corrected.** D6's report said "28 passed" where the reviewer's run shows 226
  (fixed in round 1, Ruling R43). E10's report narrative for decision 2 was corrected by the
  controller.
- **The plan's wording for E4b** ("endpoint's secret") is imprecise. There is a single signing key,
  by design, and the code uses the real delivery signer. This was recorded rather than editing the
  plan.
- **A ledger slip.** The ledger first recorded D1 as dispatched when the session had been
  interrupted before the dispatch. It was corrected, then D1 was dispatched.
- **Hygiene.**
  - The controller stopped an orphaned portal `vite preview` on port 4175, left by an earlier e2e
    run (during B1).
  - It removed 5 empty untracked `.admin-ui-workflow-*` temp directories left by a test helper
    (during E0). The helper's temp-directory leak was carried to E6.
  - It stopped an orphaned wait loop left by the fix wave's part-4 agent.
  - The vite dev server on `127.0.0.1:5173` was not started by this work and was left untouched.

## Follow-up list

### Not done in this plan

| Item | Reason |
| --- | --- |
| An `entitlement_events(created_at, id)` index migration | The plan allows no migrations. The unfiltered Events list already full-scanned before E3, so it is not a regression. Cost until done: slower deep paging on large audit logs (Ruling R46). |
| `global_fetch_strictly_public` and a threat-model row for webhook SSRF | Classified as follow-up at the E4b review, not this plan. `safeWebhookUrl` checks only the scheme, so an operator can target any https host and learn a status class and rough timing. |
| A global cap on webhook test sends | Optional (E4b review). A per-endpoint 60 s claim already limits test sends. |
| The backend signs an already-expired lease and records an issuance for an ended legacy trial (`leases.ts`, about lines 344–347); it could answer 403 | A backend behaviour change, outside this plan's scope (parked at C5). |
| A React error boundary in the admin UI | Outside the display scope (Ruling R53). Without one, a single bad row can blank the page. `formatUtcDate` itself no longer throws. |
| An upper bound on the server's entitlement `valid_until` | Outside the display scope (Ruling R53). The admin date display now renders any value. |
| A typed confirmation gate for catalog import Apply | It is reversible configuration, not terminal (Ruling R50). |
| Batch runs: a per-row failure count, a `beforeunload` prompt during a run, and a "stop after this chunk" control | Classified as follow-up by Ruling R48 (E5 Minors 9–10). |
| Webhook PATCH: a CAS or revision guard, and a canonical `event_types` order | A guard needs a new contract field (`expected_updated_at`), OpenAPI and a new baseline. Canonical ordering changes what "unchanged" means for stored legacy rows and for API clients (admin review, parked item 10). The no-op Save part was fixed (admin M-5). |
| An audit row or log (`logEvent`) and the actor for webhook test sends | `webhook_events.event_type` has `CHECK (event_type IN ('disable','reenable'))`, so an audit row needs a migration, and the admin Worker has no structured-log helper (admin M-15). |
| A token for text on accent colours (for example `--ink-on-accent`) | Some F2 swaps match by value, not meaning: `button.primary` text uses `--surface`, and a badge uses `--canvas`. The values are correct. A new token must go into both apps' `:root` blocks to keep the parity test meaningful. Judged low value (admin M-16; portal finding 19). |
| The portal Playwright `testMatch` depends on side-effect imports | `testMatch` matches only `portal-ui.e2e.mjs`, and the seven sibling suites run only because that file imports them. A new suite that forgets the import would silently never run. Fix: widen `testMatch` and delete the imports in the same change. It was left out of the fix wave because changing test discovery while the checkpoint ran would have blurred its counts (portal finding 16). |
| A late "Create license" completion after the customer is changed mid-flight returns the old customer's license id | The server refuses the create with `license_customer_mismatch`, so nothing is written to the wrong customer (admin M-19). |
| The entitlement list's "Expires" ignores a trial clock that Expiring soon clamps | It needs a change to the list payload (admin M-20). |
| The A1 check-then-insert race with a simultaneous admin create for the same verified email | Deferred by Ruling R9. The pre-check covers every sequential case; the race needs an admin create for the same verified email in the same millisecond, and a conditional insert would add an FK-abort path the tests cannot exercise. The cost is a rare duplicate customer. The A1 reviewer also suggested a query to detect duplicates created before the fix. No query text was recorded; one has to be written when this is taken up. |
| A magic link is still burned when the customer is disabled between the request and the redemption | Core M-5's configuration case was fixed (`16160e7`). Mapping `unauthorized` to `account_suspended` here is a design decision (core review). |

### Reviewed and left alone (no action)

- **Portal finding 13, the `RecoveryHint` tail:** deliberate. Both callers concern setting a
  password, so "Contact your administrator to set a password." is right for both.
- **Portal finding 18, live-region roles** (`alert` in some screens, `status` in others): the
  difference predates the plan and is consistent within each screen. Recorded for a later pass:
  failures → `alert`, confirmations → `status`.
- **Portal finding 19, raw colours left in the portal after F2:** a few have exact tokens, the rest
  have none. All are portal-only values, so none is a parity failure.
- **Admin M-22, raw hex values left in the admin after F2:** none has a defined token, so the
  parity test is not weakened.
- **Admin M-17, `activePoliciesFence` and `releaseDetailFence`:** they are not stuck; they cost
  one extra policies GET per tab re-entry. Making them independent of `active` is an optional
  tidy-up.
- **Admin M-18, blind spots in the raw-code scan:** acceptable, because `messages.test.mjs` proves
  every Worker code is mapped.
- **Core M-8:** `system-map.md` still says "Composition roots remain intentionally small", beside
  the grown portal `App.tsx`. The gated numbers are correct.
- **Re-review N-4:** the deploy-config materializer does not trim `PORTAL_SUPPORT_CONTACT`, but the
  Worker does. The materializer is only stricter.
- **Re-review, pre-existing:** a consequence action with an unknown outcome and no `reconciliation`
  would keep its notice with no button. This is not new to the fix wave.
- **A6 parked item 4:** a tab that loses an unlink race shows generic copy. The core reviewer noted
  that the Worker answers 404, 401 or 409 precisely and left the UI side to the portal review,
  which did not triage it.

### Deferred or accepted during task reviews

- **F1:** three deferred Minors were still open at `1b3d976` when this report checked them:
  - the admin customer history's From and To columns show the raw `prev_status` and `next_status`
    (`Customers.tsx`);
  - the "Applying this glossary" section of `doc/architecture/glossary.md` does not mention the
    `'Retiring'` copy guard;
  - no copy guard catches a quoted `'Released'`.
- **Accepted as they are:**
  - A3 Minor 6: the fallback text flashes before providers load (Ruling R15).
  - A4: a duplicated sentence literal in `AppsFeature`.
  - B2 Minor 6: the optional `App.tsx` hook extraction (Ruling R27).
  - C1 Minor 1: two locator fixes after a `p`→`div` change.
  - C4: an optional refactor of the e2e setup helper.
  - C5: the "Trial · ends/ended {date}" label is not status-gated, because it states a clock fact.
  - D3: an inline `PendingSeatFocus` duplicate.
  - D4: `aria-describedby` was dropped, matching `ProtectedNodes`.
  - E8: a refused typed address leaves one duplicate history entry, and navigation state is lost
    across a reload, which is privacy-safe.

## Evidence notes

- The ledger summarises the admin Minors as "14 fix-wave, 5 follow-up, 4 no action", which adds up
  to 23, not 22. The per-finding labels give 14, 5 and 3, and this report uses those.
- The portal review's header says its 15 Minors were "9 fix-wave, 1 follow-up, 5 no action". Its
  per-finding labels give 11, 1 and 3, and the re-review's cross-check agrees with the labels.
- The part-4 fix-wave report says "7 files changed net". `git diff --shortstat 8a5a4d1..d5a71c5`
  gives 15 files, and this report uses the git figure.
- The test counts inside individual task and fix-wave reports (RED and GREEN runs) were not re-run
  for this report. The checkpoint figures were re-read from the saved logs. The checks under
  [Run for this report](#run-for-this-report-at-1b3d976) were run for this report.
