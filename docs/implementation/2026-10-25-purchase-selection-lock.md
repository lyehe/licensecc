# Purchase selection during access creation

The purchase-selection race is fixed and verified: guided access creation locks its draft while saving and
confirming the result. This prevents a different app or purchase from appearing selected while
the immutable request still saves the original purchase. The full PR gate, focused regressions,
all 360 browser cases, documentation, and Worker dry runs pass.

Verified implementation: `b81ec72731ffc89ccea6746669985fae6d34b334`, based on
`86c80b814b4574a4b02b5bb06babedb2a6ba4c6d`, branch `fix/ui-ux-gap-closure-20261025`.
The following evidence commit adds only this report.

## Confirmation and implementation

The [follow-up reproduction](../../build/design-followup-review-20261025-86c80b81/license-selection-proof.json)
confirmed the original issue at 1440px and 390px: the operator could choose purchase B while the
POST for purchase A was pending, and the form closed with A without warning. Both new regression
cases failed against that implementation before the fix.

The [guided editor](../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementEditor.tsx#L81)
now uses `disabled={locked || (guided && busy)}` on its existing fieldset. Locking the whole guided
draft also prevents an app change from indirectly resetting its license selection. The existing
operation lock keeps it protected while an uncertain result requires reconciliation.

The creation hook can still populate the automatically created license ID through React state.
That assignment remains compatible with the original immutable request, fingerprint, and exact-read
confirmation. After a conclusive refusal or license-only reconciliation, editing becomes available
again. The condition applies to guided creation; the full browser suite covers the existing advanced
editor and navigation behavior.

These changes stay inside the admin UI boundary. The service README documents the lock, and the
architecture map records the final admin production-source total of 22,791 lines. The protected
[execution plan](../superpowers/plans/2026-10-25-ui-ux-gap-closure.md) is unchanged.

## Regression coverage

The onboarding spec holds the entitlement POST response, then separately holds the exact GET used
for confirmation. At 1440px and 390px it verifies that the app and purchase controls are disabled
in both phases, the selected purchase stays fixed, and only one entitlement write occurs with the
original license and fingerprint. Successful confirmation returns to customer access.

Existing cases now also verify that purchase selection stays locked for an unknown entitlement
outcome and a failed exact read, then becomes editable after a conclusive refusal or license-only
reconciliation. The latter cases exercise automatic license assignment and reuse of the original
license, fingerprint, and idempotency key.

## Verification

Commands use Node 24.20.0, npm 10.9.8, Python 3.12, and pinned uv 0.12.18. The PR gate runs with
the pinned uv directory on PATH and `UV_PYTHON=3.12`. The docs runner selects its maintained Python
3.13 environment and builds Doxygen plus strict Sphinx.

| Exact command | Outcome |
| --- | --- |
| `npx --yes npm@10.9.8 ci` | Passed; zero vulnerabilities reported. |
| `npx --yes npm@10.9.8 run test:e2e --workspace @licensecc/cloudflare-license-admin -- --grep 'locks purchase selection' --output C:\Users\HEQ\Projects\licensecc\build\purchase-save-lock-20261025-86c80b81\red-results` | Before the fix: both new cases failed. |
| `npx --yes npm@10.9.8 run test:e2e --workspace @licensecc/cloudflare-license-admin -- admin-ui.onboarding.e2e.mjs --grep 'locks purchase\|license-only\|GET-only\|retains a created\|uncertain grant' --output C:\Users\HEQ\Projects\licensecc\build\purchase-save-lock-20261025-86c80b81\final-focused-results` | Passed, 12 cases. |
| `npx --yes npm@10.9.8 run check:pr` | Passed: 1,799 Node tests across 26 reported blocks, zero failures, plus lint, types, architecture, hotspots, contracts, and schema parity. |
| `npx --yes npm@10.9.8 run setup:browsers` | Passed for both workspaces through the root command. |
| `node build/purchase-save-lock-20261025-86c80b81/run-browser-gate.mjs` | Passed: 218 admin and 142 portal browser cases, plus the backend E2E stage. |
| `npx --yes npm@10.9.8 run check:dry-run` | Passed for all four Workers. |
| `npx --yes npm@10.9.8 run check:docs` | Passed with Doxygen and strict Sphinx. |
| `node --test scripts/docs-accuracy.test.mjs` | Passed, 18 cases, after the implementation commit. |
| `npx --yes npm@10.9.8 run lint --workspace @licensecc/cloudflare-license-admin` | Passed; final source is also covered by the PR gate. |
| `npx --yes npm@10.9.8 run typecheck --workspace @licensecc/cloudflare-license-admin` | Passed; final source is also covered by the PR gate. |
| `npx --yes npm@10.9.8 run scan:secrets` | Passed again for the staged changes. |
| `git diff --check` | Passed. |

The root browser driver serves fresh isolated UI builds on owned ports 44773 and 44774, sets the
two workspace E2E base URLs, and runs `npx --yes npm@10.9.8 run test:e2e`. Its logs, snapshots,
and metadata are local ignored evidence under `build/purchase-save-lock-20261025-86c80b81/`.
All browser API data is synthetic; no production writes or deployment are part of this task.

The four new phase screenshots were retained, including the inspected
[mobile confirmation view](../../build/purchase-save-lock-20261025-86c80b81/screenshots/purchase-confirming-390.png).
All ten browser assets match the final service builds byte for byte; see the
[asset proof](../../build/purchase-save-lock-20261025-86c80b81/browser-asset-proof.json) and
[browser results](../../build/purchase-save-lock-20261025-86c80b81/browser-gate.json).
Both owned preview processes have stopped.

SDK, native build/purity, real tenant, real email, native GUI, documentation quickstart, and network
link checks were not run for this admin UI change.
