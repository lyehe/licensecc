# UI simplification implementation

## Scope and source

Implemented the non-optional presentation and workflow changes from
[the protected plan](../superpowers/plans/2026-09-22-ui-simplification.md).
Verified commit: `efb3bb00dab3fab5ae2198643194a832fba5661a` on
`fix/portal-oauth-navigation`. The commit is isolated from the concurrent
password/email, migration, and calculator changes that remain in the worktree.

Existing OAuth/password-email work, migration 0042 and schema mirrors, calculator
integration, and protected plans were already present. They were preserved.
This task changes UI presentation, navigation, UI tests, callback presentation,
calculator session error copy and related documentation. No database changes,
new sign-in providers, new licensing capabilities, or paid-service changes were
introduced by this task. Generated screenshots, logs, native build products and
test-account configuration remain ignored local output.

## Implemented

- Customer app pages use one license list, contextual activation/download actions
  and a collapsed Activity section. Runtime-status qualifications remain visible
  on mobile. Legacy download forms use full-width mobile rows.
- Browser sessions is secondary but retains active-seat and pending-release
  visibility. Last-seat release keeps the panel open and restores focus. Renew
  seat replaces the ambiguous Refresh label; uncertainty behavior is retained.
- Account has one shell Sign out action. Sign-in headings follow the active
  password/register/reset or email-code method.
- Activation keeps code comparison, selection, expiry and slot consequences.
  Sign out is visible with the restart consequence. The native callback says
  approval was sent and directs the customer back to the app to finish.
- Admin daily navigation is Overview, Customers and License access. Configuration,
  Activity and Related records are expandable; old route hashes still work.
- Customer assignment carries customer/project context to the existing access
  editor. Explicit navigation discards an unrelated untouched editor after the
  navigation guard. Project changes in new drafts clear license/policy selection;
  customer changes clear a new draft's selected license.
- Policy selections show names. Advanced controls, event diagnostics and webhook
  deliveries are secondary. Inapplicable entitlement transitions are absent.
  Exact-request reconciliation, stale-read locking and existing record lookup
  remain in place.
- Removed duplicated download tables, sign-out framing, repeated selected-license
  labels, metric copy and obsolete download CSS.

## Verification

Commands used Node 22, Python 3.12 and repository-pinned uv 0.12.5.

| Command | Outcome |
| --- | --- |
| `npm ci` | Passed |
| `npm run test:e2e --workspace @licensecc/cloudflare-license-admin` | 100 passed |
| `npm run test:e2e --workspace @licensecc/cloudflare-customer-portal` | 64 passed |
| `npm run check:pr` | Passed (exit 0), including service checks and both schema-parity checks |
| `npm run check:dry-run` | Passed on the isolated commit; all four Worker bundles validated without deployment |
| `npm run check:docs` | Passed after README updates |
| `npm run test:docs-accuracy` | 14 passed |
| `cmake --build build/calculator-native --config Debug --target install` | Passed |
| `cmake --build build/calculator-example --config Debug` | Passed installed consumer |
| `ctest --test-dir build/calculator-example -C Debug --output-on-failure` | 5 passed |
| `cmake --build build/ci-windows-device-identity-test --config Debug --target device_bound_callback_test` | Passed |
| `ctest --test-dir build/ci-windows-device-identity-test -C Debug -R device_bound_callback_test --output-on-failure` | 1 passed |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | Passed; source fingerprints unchanged |
| `git diff --check` | Passed |

The initial repository gate caught the expected browser-test inventory increase;
the inventory was updated from 95 to 96 literal test declarations (100 generated
admin scenarios). Early browser runs caught outdated label/disclosure assertions
and a real narrow-screen download overflow, which were corrected before passing.

Rendered coverage includes admin routes at 320, 390, 768, 1024, 1280 and 1440px,
customer access at 320, 390, 768, 1280 and 1440px, mobile dialogs, keyboard focus,
Back/Forward, stale and failed reads, exact-key recovery, unknown legacy release
outcomes and customer-context transitions. Desktop and phone screenshots were
visually inspected. Actual browser 200% zoom was not separately tested.

Astra Max independently reviewed the implementation. Its findings about final-seat
focus, sign-in method headings, mobile-menu focus, mobile status qualification,
stale clean editors and control targets were corrected. Final source review found no remaining blocking findings; it also verified that
explicit navigation preserves immutable pending requests and idempotency keys.

Local logs are under `build/ui-simplify-*`; screenshots are in the two services'
ignored `test-results` directories. No live customer enrollment or approval
was performed during this UI work.

## Release boundary and deferred work

Optional friendly consent identity and missing provisioning APIs remain separate,
as specified by packet 5. No contract or schema work was added for them.

Staging and production were not deployed. The isolated deployment dry-run
passed, but a live staging deploy still requires the materialized staging
Wrangler configurations and their target bindings; those are deliberately not
checked in and are absent from this checkout. Deploying the dirty worktree
would include unrelated password/email and migration changes. No push was made.
Full SDK checks, native
documentation quickstart and Linux-native callback execution were not rerun for
these presentation changes. Browser installation was unnecessary because both
pinned Chromium revisions were already available.
