# UI UX gap closure implementation evidence

Implemented on branch `fix/ui-ux-gap-closure-20261025`.
Verified implementation commit: `cd919d91c945db2e96d740efc86d0706f12a64c5`.
Review baseline: `a22baa14cfa2dcd3bf799517e85757ed6e7d129b`.

All six reviewed workflow gaps are closed within the existing admin and customer-portal deployables.
The [design](../superpowers/specs/2026-10-25-ui-ux-gap-closure-design.md) and
[execution plan](../superpowers/plans/2026-10-25-ui-ux-gap-closure.md) remain unchanged after their initial commit.
This evidence records the implementation and validation rather than rewriting the protected plan.

## Implementation commits

| Commit | Result |
| --- | --- |
| `49cf1449` | Saved the reviewed design and execution plan. |
| `0fab2c91` | Added explicit account setup, contextual access details, guided creation, and inclusive validity dates in admin. |
| `cd919d91` | Added inline capacity recovery, bounded account-wide device search, compatible portal contracts, and current source measurements. |

## Finding and packet closure

| Packet and finding | Implemented result | Authoritative proof |
| --- | --- | --- |
| T1 / UX-1 | Manage devices operates inside the mounted consent owner. Return re-inspects the same attempt before approval. Selection, comparison confirmation, original deadline, ownership, saved disconnects, and exact retries are retained. | [Consent feature](../../services/cloudflare-customer-portal/src/ui/features/consent/ConsentFeature.tsx), [inline manager](../../services/cloudflare-customer-portal/src/ui/features/consent/ConsentDevices.tsx), [consent browser scenarios](../../services/cloudflare-customer-portal/test/portal-ui.consent.e2e.mjs). |
| T2 / UX-2 | Customer sets password replaces Invite. Account creation supplies copyable setup instructions and explicitly sends no email. Set or reset password uses the existing verified request and completion flow, including the existing direct entry. | [Add user](../../services/cloudflare-license-admin/src/ui/features/customers/AddUser.tsx), [password sign-in](../../services/cloudflare-customer-portal/src/ui/features/auth/PasswordSignIn.tsx), [admin workspace cases](../../services/cloudflare-license-admin/test/admin-ui.workspace.e2e.mjs), [portal setup cases](../../services/cloudflare-customer-portal/test/portal-ui.e2e.mjs). |
| T3 / UX-5 | Valid through includes the whole selected UTC day. The editor previews the exact expiry; summaries and reports use the same presentation. Custom and out-of-range deadlines retain their original seconds unless explicitly replaced. | [Expiry adapter](../../services/cloudflare-license-admin/src/ui/features/entitlements/expiry.ts), [expiry field](../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementExpiry.tsx), [semantic tests](../../services/cloudflare-license-admin/test/admin-ui-workflow/entitlements.test.mjs), [browser date cases](../../services/cloudflare-license-admin/test/admin-ui.datedisplay.e2e.mjs). |
| T4 / UX-4 | Manage access opens contextual details and existing lifecycle actions directly. Scoped refreshes reject another customer's grant; history, unsaved-change protection, confirmation, and sensitive-ID boundaries remain. | [Detail presentation](../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementList.tsx), [controller](../../services/cloudflare-license-admin/src/ui/features/entitlements/Entitlements.tsx), [workspace cases](../../services/cloudflare-license-admin/test/admin-ui.workspace.e2e.mjs), [navigation cases](../../services/cloudflare-license-admin/test/admin-ui.navigation.e2e.mjs). |
| T5 / UX-3 | Grant access starts from an empty or populated customer workspace. Customer/app context is prefilled, catalog choices remain optional, and a fingerprint is generated once per draft. Zero/one/multiple-license cases are handled explicitly. The two existing writes retain independent intents and recover partial completion safely. | [Guided fields](../../services/cloudflare-license-admin/src/ui/features/entitlements/GuidedGrantFields.tsx), [shared creation workflow](../../services/cloudflare-license-admin/src/ui/features/entitlements/useEntitlementCreate.ts), [license creation](../../services/cloudflare-license-admin/src/ui/features/entitlements/CreateLicense.tsx), [onboarding cases](../../services/cloudflare-license-admin/test/admin-ui.onboarding.e2e.mjs). |
| T6 / UX-6 | Search scans the owned account with bounded candidate pages and exact app scoping. Sparse pages advance safely; the client traverses at most five requests per interaction and exposes incomplete searches. Literal Unicode matching, response fences, and independent disconnect reconciliation are preserved. | [Binding route](../../services/cloudflare-customer-portal/src/worker/routes/device-bindings.ts), [shared matcher](../../services/cloudflare-customer-portal/src/shared/deviceSearch.ts), [bounded UI reads](../../services/cloudflare-customer-portal/src/ui/features/devices/useDeviceBindings.ts), [Worker cases](../../services/cloudflare-customer-portal/test/portal-worker-bindings.test.mjs), [search browser cases](../../services/cloudflare-customer-portal/test/portal-ui.devices-search.e2e.mjs). |
| T7 / combined workflows | Browser walkthroughs connect admin account creation, copied instructions, guided access, first password, portal sign-in, and native callback handoff at 1440px and 390px. Capacity recovery searches beyond page one, disconnects an owned device, and returns to the same attempt. Contextual editing preserves custom seconds and converts an explicitly selected included day correctly. | Full concern-specific browser suites and the local combined-journey proof below; screenshots were inspected for setup, grant, details, recovery, and portal screens. |

Coverage includes leap day and year rollover, invalid and upper-bound dates, policy inheritance,
untouched precise instants, unknown outcomes for both creation writes, duplicate submission,
policy detours, clean generated defaults, late lookups, customer switches, long capacity holds,
expiry while recovering a saved disconnect, changed comparison codes, stale refreshes,
Unicode and literal search characters, sparse pages, cursor loops, and query A to B to A.

## Compatibility decisions

The existing licensing records, native ABI, SDKs, cryptography, and lease/capacity-hold policy are unchanged.
Server authority still decides eligibility and capacity; browser checks explain the current state only.

The portal binding list adds optional `q` and `project`. Existing unfiltered and exact-binding clients
retain their behavior and response fields. Search is opt-in: its cursor advances over scanned candidates,
so a page can be empty with `has_more` true. Exact binding lookup remains separate from search.
Only [the portal canonical baseline](../../test/contracts/portal.json) changes; route counts remain
backend 8, admin 68, and portal 29. The serving deployable owns the route, OpenAPI fragment, and tests.

Deploy the compatible portal Worker before serving the new search UI in a later authorized rollout;
rollback restores the older UI first. No deployment or production-data change was performed by this task.

Account creation still requires the operator to share setup instructions. Automatic invitation delivery
was excluded from this plan. Large searches can require explicit continuation, and existing signed leases
can keep a device slot occupied beyond the connection attempt's lifetime. Those limits are stated in the UI.

## Validation

Commands ran from the repository root with Node 24.20.0, npm 10.9.8, Python 3.12, and uv 0.12.18.
The documentation command uses its maintained Python 3.13 environment and Sphinx 9.2.0.
The npm wrapper below selects the repository's exact npm version without changing global tools.

| Exact command | Outcome |
| --- | --- |
| `npx --yes npm@10.9.8 ci` | Passed; 357 packages installed, 364 audited, zero vulnerabilities reported. |
| `npx --yes npm@10.9.8 run check:pr` | Passed; 1,797 Node tests across 26 reported blocks, plus all invoked lint, type, architecture, contract, hotspot, and schema gates. |
| `npx --yes npm@10.9.8 run setup:browsers` | Passed for both workspaces through the one root command. |
| `npx --yes npm@10.9.8 run test:e2e` | Passed: 207 admin and 142 portal cases (349 total). |
| `npx --yes npm@10.9.8 run check:dry-run` | Passed for all four Workers; no deployment. |
| `npx --yes npm@10.9.8 run test:docs-accuracy` | Passed, 18 tests, including final source totals and candidate-file accounting. |
| `npx --yes npm@10.9.8 run check:docs` | Passed, Doxygen plus strict Sphinx build. |
| `npx --yes npm@10.9.8 run test:openapi --workspace @licensecc/cloudflare-customer-portal` | Passed, 17 tests. |
| `npx --yes npm@10.9.8 run write:contract-baselines` | Completed after review; only the intended portal contract changed. |
| `npx --yes npm@10.9.8 run test:contracts` | Passed for backend, admin, portal, and backup. |
| `npx --yes npm@10.9.8 run check:architecture` | Passed; no cross-deployable or UI-to-Worker imports. |
| `npx --yes npm@10.9.8 run check:hotspots` | Passed without increasing a ratchet. |
| `npx --yes npm@10.9.8 run lint --workspace @licensecc/cloudflare-license-admin` | Passed. |
| `npx --yes npm@10.9.8 run lint --workspace @licensecc/cloudflare-customer-portal` | Passed. |
| `npx --yes npm@10.9.8 run typecheck --workspace @licensecc/cloudflare-license-admin` | Passed. |
| `npx --yes npm@10.9.8 run typecheck --workspace @licensecc/cloudflare-customer-portal` | Passed. |
| `npx --yes npm@10.9.8 run test:ui --workspace @licensecc/cloudflare-license-admin` | Passed; semantic behavior tests are also included in check:pr. |
| `npx --yes npm@10.9.8 run test:ui --workspace @licensecc/cloudflare-customer-portal` | Passed, 44 tests; rerun after the final browser inventory update. |
| `node build/ux-gap-implementation-20261025/combined-journey.mjs` | Passed at 1440px and 390px with shared synthetic account/grant data, keyboard activation, copied instructions, overflow assertions, and intercepted native callback. |
| `git diff --check` and `git diff --cached --check` | Passed. |

The root PR gate invokes the admin and portal Worker tests, admin SQL tests, and UI workflow tests
through their maintained root aggregates. Focused concern runs additionally exercised onboarding,
workspace navigation, expiry, consent, nodes, search, and session recovery. A focused double-submit
recheck passed after strengthening the guided-creation scenario.

Browser runs used `LICENSECC_ADMIN_UI_E2E_BASE_URL=http://127.0.0.1:44373` and
`LICENSECC_PORTAL_UI_E2E_BASE_URL=http://127.0.0.1:44374`, served by owned local Vite previews.
They used frozen copies of the final compiled UI assets, allowing independent packaging checks without
changing pages under test. All 10 copied assets were checked against the final build byte for byte.

Local logs, screenshots, the full command environment, and machine-readable proof are retained under
`build/ux-gap-implementation-20261025/` and are intentionally excluded from Git.
Key files are `check-pr.log`, `e2e-final.log`, `check-dry-run.log`, `check-docs.log`,
`combined-journey.json`, `browser-asset-proof.json`, and `validation.json`.

## Limits and unrun surfaces

The browser API and email-token fixtures are synthetic. A live configured tenant, actual email delivery,
a real native application GUI, TPM enrollment, and a real callback/lease exchange were not exercised.
The intercepted callback proves the browser handoff rather than native activation.

Dedicated SDK tests, native build purity, offline docs quickstart, and network link validation were not run:
this increment changes neither those surfaces nor their contracts. Their commands remain
`npm run test:sdks`,
`pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`,
`npm run test:docs-quickstart`, and `npm run check:docs:links` if a later change requires them.

Existing protected plans, unrelated generated trees, local configurations, and shared toolchains were preserved.
The new code and test changes are committed; the evidence commit adds only this report.
