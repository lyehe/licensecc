# UI cleanup commit review

## Reviewed scope

Base: `7c8df2e2693441ee391ce52e9685fc23f3e77925`.
The commit candidate was assembled and verified in an isolated worktree,
`licensecc-ui-review`. It includes the customer/admin UI simplification and
native callback presentation. Password-email APIs, migration 0042, OAuth fixes,
calculator integration, generated output and protected plans are excluded.
Those existing changes remain in the original checkout.

The review preserved licensing authority and recovery behavior. It removed
redundant lifecycle predicates already enforced by action visibility, simplified
the sidebar's active-group update, combined repeated delivery headings, and
removed unused download styles. Customer assignment clears stale clean editors
and carries customer/project context. New-grant project changes invalidate
dependent selections. Pending requests remain in the recovery provider.

One license list replaces the duplicate download table. Activity, browser seats,
technical IDs and advanced settings remain available as secondary content.
Active browser seats and pending releases remain visible. Account has one shell
Sign out action, and activation keeps code comparison and slot/trial consequences.
The callback says approval was sent, rather than claiming native activation
has finished. No Worker/API contract or database behavior changes are included.

The isolated password component retains the committed registration/recovery
protocol while sharing its login/register display state with the heading.
Unfinished email-link registration and reset code is deliberately not a
dependency of this UI commit.

## Verification

Pinned toolchain: Node 22, Python 3.12 and uv 0.12.5.

| Command | Result |
| --- | --- |
| `npm ci` | Passed; zero reported vulnerabilities |
| `npm run check:pr` | Passed, including both schema-parity checks |
| `npm run test:e2e` | Passed: 100 admin + 63 customer portal scenarios |
| `npm run test:e2e --workspace @licensecc/cloudflare-customer-portal -- --grep "sign-in headings"` | Passed after the final equivalent heading-expression cleanup |
| `npm run check:docs` | Passed |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | Passed: 37 tests; unchanged source fingerprints |
| `cmake --preset ci-windows-device-identity-test` | Passed |
| `cmake --build build/ci-windows-device-identity-test --config Debug --target device_bound_callback_test` | Passed |
| `ctest --test-dir build/ci-windows-device-identity-test -C Debug -R device_bound_callback_test --output-on-failure` | Passed: 1 test |

The first build-purity run detected a concurrent edit made during review. It
passed after freezing the candidate and rerunning the complete purity check.

Browser coverage includes narrow/desktop layouts, old route hashes,
registration mode switching, download availability, customer/project context,
focus restoration and mutation recovery. Callback coverage verifies its copy,
viewport metadata and exact inline-style CSP hash. Prior full-worktree Astra Max
review found no remaining blockers; this commit's extraction and cleanup were
reviewed locally.

Logs and screenshots stay in ignored build/test directories. Full SDK tests,
Linux native execution, actual 200% browser zoom, live Cloudflare checks and
deployment were not run for this presentation-only commit. No changes were
pushed or deployed as part of the commit.
