# UI and UX design conformance audit

At the audited commit, the normal workflows followed the design, but three P2 gaps remained in guided
creation and trial validity. That implementation was not fully consistent with the October 25 design.
UX-3 and the trial portion of UX-5 remained open despite the closure claim in the
[implementation report](2026-10-25-ui-ux-gap-closure.md).

Follow-up: all three findings were confirmed and fixed in `5025070a93d4c6855cd745a4180b810c5c41fa57`.
The [verification report](2026-10-25-design-conformance-fixes.md) records the regression coverage and
passing required gates. Findings below preserve the audit evidence at its original ref.

Audited on 2026-10-25 at commit `41164ebd8718bda4b2c0e58ca33b6dc4f8c73487`, branch
`fix/ui-ux-gap-closure-20261025`. The worktree was clean before this audit. This report adds evidence;
it changes no application behavior or protected execution plan.

## Baseline and scope

The acceptance baseline is the [October 25 design](../superpowers/specs/2026-10-25-ui-ux-gap-closure-design.md)
and its [execution plan](../superpowers/plans/2026-10-25-ui-ux-gap-closure.md). That design explicitly defers
the larger [October 1 redesign](../superpowers/specs/2026-10-01-customer-license-device-workflow-design.md).

Scope covers both UI deployables, shared visual tokens, portal binding search, ownership boundaries,
and the six designed workflows. Findings are implementation and usability issues; the evidence does
not establish deceptive intent or a dark pattern.

## Findings

### A grant can finish without its exact read succeeding

Severity: P2. Confidence: high. Category: implementation and workflow design.

Guided creation supplies a general refresh, and the entitlement list accepts any valid page as proof,
including an empty page. The form closes and the customer workspace opens before a read confirms the
created grant. If subsequent reads omit it, the operator sees an empty workspace and an app-not-found
notice without the required Refresh status recovery.

Verbatim evidence:

- [Entitlements.tsx, line 138](../../services/cloudflare-license-admin/src/ui/features/entitlements/Entitlements.tsx#L138): `return EXACT_READ_PROOF;`
- [Entitlements.tsx, line 227](../../services/cloudflare-license-admin/src/ui/features/entitlements/Entitlements.tsx#L227): `refresh: async()=>await refreshCore(true),`
- [Design, line 96](../superpowers/specs/2026-10-25-ui-ux-gap-closure-design.md#L96) requires stable intent and exact-read success proof.

Reproduction: select one existing eligible license, return a successful entitlement POST, then return
well-formed empty entitlement and customer-access reads. At 1440px and 390px the form disappears,
navigation returns to the customer, and No records found appears. Refresh status is absent. This is a
client confirmation gap; the reproduction does not establish loss of the server write.

Smallest fix: confirm the created grant through an existing exact-ID read, validating customer,
project, feature, and identity. Keep a known successful write in refresh recovery until that read
succeeds. Refresh surrounding lists separately. Recovery for this known success must issue only GETs.

Validation: valid empty, wrong-owner, or failed reads retain Refresh status and do not finish navigation.
A matching read finishes navigation without another POST or a new fingerprint.

Proof: [390px screenshot](../../build/design-conformance-audit-20261025-41164ebd/missing-exact-read-390.png)
and [1440px screenshot](../../build/design-conformance-audit-20261025-41164ebd/missing-exact-read-1440.png).

### Trial access can claim No expiry

Severity: P2. Confidence: high. Category: presentation and domain meaning.

Validity presentation reads only stored `valid_until`. An activation-based trial can legitimately have
that field set to null while its frozen duration limits access. Both unstarted and started 24-hour
trials display No expiry in contextual details without their trial basis or duration. The contextual
branch also omits the license-mode label still displayed in the global list. A policy ID and generic
restrictions footnote do not explain this deadline.

Verbatim evidence:

- [EntitlementList.tsx, line 47](../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementList.tsx#L47): `expiryDescription(item.valid_until)`
- [Runtime trial rule, line 24](../../packages/cloudflare-runtime/src/device/bound_trial.mjs#L24): `expiresAt = (pending ? now : row.trial_started_at) + row.trial_duration_sec;`
- [Design, line 111](../superpowers/specs/2026-10-25-ui-ux-gap-closure-design.md#L111) requires policy-derived and trial deadlines to remain visibly derived.

Reproduction: an owned active grant has `is_trial: 1`, `trial_expiration_basis: from_first_activation`,
`trial_duration_sec: 86400`, and `valid_until: null`. Test an unstarted trial and a started trial with
its valid frozen device key. The production `boundTrialState` helper accepts both fixtures and computes
finite deadlines. Manage access shows No expiry and no trial explanation at both widths.

Smallest fix: make validity presentation aware of authoritative trial fields. Distinguish the stored
grant deadline from the trial duration, start basis, and derived end. Reuse this in lists and customer
access while preserving inclusive calendar conversion and untouched exact seconds.

Validation: unstarted trials explain when the clock starts; started trials show their derived end;
an earlier stored grant deadline stays visible; perpetual grants still show No expiry. Cover details
and customer summaries at both widths.

Proof: [started trial](../../build/design-conformance-audit-20261025-41164ebd/trial-started-1440.png)
and [unstarted trial](../../build/design-conformance-audit-20261025-41164ebd/trial-not-started-390.png).
The proof JSON includes each fixture and its production helper result.

### License reconciliation hides the incomplete grant state

Severity: P2. Confidence: high. Category: recovery feedback.

After a lost license response, reconciliation correctly replays that license operation with the same
key and selects the confirmed license. It does not continue to the entitlement write. The guided
callback sets Access not granted, but later feedback replaces it. The final green banner says Status
reconciled although no entitlement POST occurred. The design requires explicit incomplete-access copy.

Verbatim evidence:

- [CreateLicense.tsx, line 34](../../services/cloudflare-license-admin/src/ui/features/entitlements/CreateLicense.tsx#L34): `onCreated(license.id);` is followed by replacement feedback on line 35.
- [useKeyedMutation.ts, line 364](../../services/cloudflare-license-admin/src/ui/shared/useKeyedMutation.ts#L364): `"Status reconciled."`
- [Guided callback, line 36](../../services/cloudflare-license-admin/src/ui/features/entitlements/useEntitlementCreate.ts#L36) sets the incomplete-access message before those later updates.
- [Design, line 97](../superpowers/specs/2026-10-25-ui-ux-gap-closure-design.md#L97) requires Access not granted when only the license succeeds.

Reproduction: abort the first license response, then choose Reconcile status. At both widths the
confirmed license is selected, Save access is enabled, and the green Status reconciled banner appears.
There are two identical license attempts under one key and zero entitlement attempts. Access not
granted is absent. Retry identity is correct; workflow status is incomplete.

Smallest fix: keep a persistent message within the guided form, independent of the global banner:
License created. Access not granted. Save access to finish. Keep the same license and fingerprint.

Validation: after license-only reconciliation the incomplete-access copy remains; the next save reuses
the identity and creates only the missing entitlement. Generic recovery feedback cannot hide this state.

Proof: [1440px screenshot](../../build/design-conformance-audit-20261025-41164ebd/partial-license-1440.png)
and [390px screenshot](../../build/design-conformance-audit-20261025-41164ebd/partial-license-390.png).

## Coverage

| Design surface | Result |
| --- | --- |
| UX-1 connection recovery | Aligned in code and focused consent tests: mounted owner, app-scoped management, comparison retention, reinspection, retirement recovery, holds, expiry, and mutation exclusion. |
| UX-2 account setup | Aligned in source and browser tests: honest password setup label, explicit manual sharing, copied instructions, and existing portal reset route. Automatic invitation email remains deferred. |
| UX-3 guided access | Normal creation, license selection, stable identity, and retries pass. Exact grant confirmation and license-only recovery feedback remain open above. |
| UX-4 contextual access | Detail/actions replace the generic list. Customer isolation, missing/wrong records, history, navigation, focus, and unsaved drafts are covered by workspace tests. Trial explanation remains open under UX-5. |
| UX-5 validity | Inclusive conversion and custom-second preservation pass entitlement/report workflow tests. Trial meaning remains open above. |
| UX-6 device search | Source and browser cases cover debounce, ownership/app fences, sparse pages, literal matching, bounded continuation, and incomplete results. Worker ownership/project predicates precede the candidate limit; exact lookup remains separate. |
| Visual consistency | All 9 shared-token tests pass. Eight fresh captures at 1440px and 390px were inspected and fit the viewport without horizontal document overflow. |
| Ownership and structure | Architecture policy and hotspot growth checks pass. No new boundary exception is needed. |

An account-change hypothesis was ruled out: session revalidation sets auth to loading, unmounting the
enrollment component before a different authenticated account renders. The normal Devices view is
also keyed by customer. No finding is raised for that hypothesis.

## Verification

Both UIs were built afresh from the audited commit into the audit-owned ignored directory. The browser
driver served those builds on strict task-owned ports 44473 and 44474, using synthetic API routes. Both
servers were stopped after the driver finished. No production writes were made.

| Exact command | Outcome |
| --- | --- |
| From admin: `node ../../node_modules/vite/bin/vite.js build --outDir C:\Users\HEQ\Projects\licensecc\build\design-conformance-audit-20261025-41164ebd\admin-ui` | Passed, with the existing bundle-size advisory. |
| From portal: `node ../../node_modules/vite/bin/vite.js build --outDir C:\Users\HEQ\Projects\licensecc\build\design-conformance-audit-20261025-41164ebd\portal-ui` | Passed. |
| `node build/design-conformance-audit-20261025-41164ebd/conformance-proof.mjs` | Three gaps reproduced at both widths; focused suites passed: 39 admin and 65 portal cases. |
| `node build/design-conformance-audit-20261025-41164ebd/conformance-proof.mjs --proof-only` | Final 8 observations passed, including validation of both trial states against the production rule. |
| `node --test services/cloudflare-license-admin/test/admin-ui-workflow/entitlements.test.mjs services/cloudflare-license-admin/test/admin-ui-workflow/lists-reports.test.mjs` | 37 passed. |
| `node --test scripts/ui-token-parity.test.mjs` | 9 passed. |
| `node --test scripts/docs-accuracy.test.mjs` | 18 passed. |
| `node scripts/check-architecture.mjs` | Passed. |
| `node scripts/report-hotspots.mjs --check` | Passed without a ratchet increase. |
| `git diff --check` | Passed. |

The driver invokes the existing Playwright CLI with the admin onboarding/workspace specs and portal
consent/device-search specs. It sets each workspace's `LICENSECC_*_UI_E2E_BASE_URL` to its owned preview
and writes test output under the audit directory. The exact subprocess arguments are in the
[proof driver](../../build/design-conformance-audit-20261025-41164ebd/conformance-proof.mjs).
[Reproduction data](../../build/design-conformance-audit-20261025-41164ebd/reproductions.json),
[suite outcomes](../../build/design-conformance-audit-20261025-41164ebd/acceptance-suites.json), screenshots,
and logs are local ignored evidence. The proof asserts that current drift is reproducible; these are
not passing closure tests. The existing suites do not cover the three failing acceptance states.

This audit did not rerun the full PR gate, all browser concerns, Worker dry runs, SDK/native gates, or
Sphinx/Doxygen. Earlier results remain in the prior implementation report. Real email delivery, a live
tenant, native GUI handoff, and the deferred October 1 redesign remain outside this audit's evidence.

## Closure order

Confirm the exact created grant first, restore trial meaning next, and make partial grant status
persistent. Add each focused validation above and rerun the owning UI/browser gates plus the required
repository PR gate for those implementation changes. UX-3 and UX-5 close when those states pass.
