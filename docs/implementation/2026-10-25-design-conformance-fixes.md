# Design conformance fixes

The three findings in the [design audit](2026-10-25-design-conformance-audit.md) were confirmed, fixed,
and verified. The full PR gate, 358 browser cases, Worker dry runs, and strict documentation build
pass. These fixes close the reported UX-3 gaps and the trial-validity portion of UX-5.

Verified implementation: `5025070a93d4c6855cd745a4180b810c5c41fa57` on
`fix/ui-ux-gap-closure-20261025`, based on `41164ebd8718bda4b2c0e58ca33b6dc4f8c73487`.
The following evidence commit changes only the audit and this verification report.

## Confirmation and closure

Seven new browser cases failed against the original implementation before the fixes. They reproduced
the missing grant confirmation, hidden partial-save state, and incorrect trial expiry presentation.
The final regressions expand that coverage across desktop and mobile and all three exact-read failures.

| Finding | Final behavior | Regression evidence |
| --- | --- | --- |
| Exact grant confirmation | Guided creation keeps the draft until an exact entitlement GET confirms the saved ID, customer, project, feature, fingerprint, license, and status. A missing, mismatched, or unavailable read retains Refresh status. A known successful POST is never sent again to recover its read. | Six cases cover empty, wrong-owner, and unavailable reads at 1440px and 390px, including a second failed refresh, a later matching read, and a single entitlement POST throughout. |
| Trial expiry meaning | Lists, customer access, contextual details, and the editor distinguish a frozen trial clock from the stored grant date. Pending trials show duration and start basis. Started trials show their derived deadline, capped by an earlier grant expiry. Health badges use that effective deadline. | Browser cases at both widths cover pending and started trials plus a perpetual grant. Unit cases cover first activation, first use, issue-based expiry, an earlier grant cap, invalid clocks, and precise seconds. |
| Partial license creation | After license-only reconciliation, the form persistently says License created. Access not granted. Save access to finish. The message is independent of global recovery feedback, scoped to the same customer/app/license/fingerprint, and removed while an entitlement outcome is uncertain. A conclusive refusal restores it. | Desktop and mobile cases confirm zero entitlement attempts after license-only recovery, identical license retries under one key, and reuse of the same license and fingerprint on the next save. |

The implementation uses the existing admin detail endpoint and keyed-mutation lifecycle. Surrounding
lists still refresh. Advanced creation retains its existing known-write navigation and list-focus
behavior while its operation remains protected by exact-read recovery. Trial calculations here explain
authoritative frozen fields; the server remains the licensing authority.

The [October 25 design](../superpowers/specs/2026-10-25-ui-ux-gap-closure-design.md) is the acceptance
baseline. The protected [execution plan](../superpowers/plans/2026-10-25-ui-ux-gap-closure.md) is unchanged.
The larger October 1 redesign remains explicitly deferred by that design.

## Changed ownership surfaces

The admin deployable owns the creation hook, contextual controller, validity presenter, editor copy,
customer summary, service README, and concern-specific regression tests. A small UI-local validity
module keeps trial presentation consistent across those views. The architecture map records the new
production-source total of 22,790 admin lines. Browser inventory metadata accounts for the recovery
case becoming parameterized; the executed admin suite grows from 207 to 216 cases.

## Verification

Toolchain: Node 24.20.0, npm 10.9.8, Python 3.12.8, and uv 0.12.18. The PR command uses the pinned uv
directory on PATH and `UV_PYTHON=3.12`. The documentation runner selects its maintained Python 3.13
environment and builds Doxygen plus strict Sphinx.

| Exact command | Outcome |
| --- | --- |
| `npx --yes npm@10.9.8 ci` | Passed; 357 packages installed, 364 audited, zero vulnerabilities reported. |
| `npx --yes npm@10.9.8 run check:pr` | Passed; 1,799 Node tests across 26 reported blocks, zero failures, plus lint, types, architecture, hotspots, contracts, and schema parity. |
| `npx --yes npm@10.9.8 run setup:browsers` | Passed for both UI workspaces through the root command. |
| `node build/design-conformance-fixes-20261025-41164ebd/run-browser-gate.mjs` | Passed. Invokes `npx --yes npm@10.9.8 run test:e2e`: 216 admin and 142 portal browser cases, plus the backend E2E stage. |
| `npx --yes npm@10.9.8 run check:dry-run` | Passed for all four Workers. |
| `npx --yes npm@10.9.8 run check:docs` | Passed with Doxygen and strict Sphinx. |
| `node --test scripts/docs-accuracy.test.mjs` | Passed, 18 cases, after the final source-count update. |
| `node --test services/cloudflare-license-admin/test/admin-ui-workflow/entitlements.test.mjs` | Passed, 20 cases, including the two new trial presentation cases. |
| `npx --yes npm@10.9.8 run lint --workspace @licensecc/cloudflare-license-admin` | Passed. |
| `npx --yes npm@10.9.8 run typecheck --workspace @licensecc/cloudflare-license-admin` | Passed. |
| `node --test services/cloudflare-license-admin/test/admin-ui-e2e-layout.test.mjs` | Passed after the parameterized-case inventory update. |
| `npx --yes npm@10.9.8 run scan:secrets` | Passed again after staging the new source file. |
| `git diff --check` | Passed. |

The browser gate uses fresh isolated builds on task-owned ports 44573 and 44574. API routes contain
synthetic data. All ten frozen browser assets match the final service builds byte for byte. Both
preview processes have stopped. Local ignored evidence is under
`build/design-conformance-fixes-20261025-41164ebd/`, including the full logs,
[browser outcomes](../../build/design-conformance-fixes-20261025-41164ebd/browser-gate.json),
[asset comparison](../../build/design-conformance-fixes-20261025-41164ebd/browser-asset-proof.json), and
ten screenshots. The mobile partial-save, failed exact-read, and trial-detail captures were inspected.

Representative results:

- [Partial license save at 390px](../../build/design-conformance-fixes-20261025-41164ebd/screenshots/partial-license-390.png)
- [Exact-read recovery at 390px](../../build/design-conformance-fixes-20261025-41164ebd/screenshots/exact-read-empty-390.png)
- [Derived trial expiry at 390px](../../build/design-conformance-fixes-20261025-41164ebd/screenshots/trial-details-390.png)

Real tenant behavior, real email delivery, and a native application GUI were not exercised. SDK and
native build/purity gates were not rerun for these admin UI changes; the native documentation
quickstart and network link checker were also outside this scope. No deployment was performed.
