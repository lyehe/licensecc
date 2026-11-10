# Offline access consequence corrections

Date: 2026-10-25. Initial baseline:
`c5b1b268f82704e2f6d5d651cba8c7adf37e60b0` on
`fix/ui-ux-gap-closure-20261025`.

The [design specification](../superpowers/specs/2026-10-25-offline-access-consequences-design.md)
and [execution plan](../superpowers/plans/2026-10-25-offline-access-consequences-plan.md)
were committed at `435f5a2ec88c31aa961b9838edb7cae6dab4387f` before implementation.
Both remain unchanged throughout implementation.

Verified implementation: `74a92d2c2292f16ee5bb27dd3fd8ce2e0a86f691`.
All scoped wording gaps are closed. The 15 validated candidate files were
committed without content changes, and the worktree was clean at that ref.

## Confirmed gaps and correction

The portal and admin device-disconnect confirmations explained delayed expiry
and release, but omitted the online authorization required after an app restart.
Grant suspension said verification stopped, customer suspension claimed all
license/token authorization was immediately severed, and grant revocation
omitted the possible continuation of existing offline permission. Bulk actions
had separate wording with the same omissions.

The accepted runtime behavior is defined by
[ADR 0006](../../doc/architecture/decisions/0006-device-bound-licensing.md),
the [native session reference](../../doc/api/device_identity.rst),
[lease policy](../../packages/licensing-domain/src/lease/device_policy.mjs),
the backend issue/retirement owners, and the native session's denial handling.
Existing offline permission can outlast a lifecycle action; process restart
requires fresh online permission. Capacity holds are separate from client expiry.

| Surface | Visible correction |
| --- | --- |
| Portal device disconnect | Renewal stops; existing offline access may continue until its current permission expires; restarting needs an online check that the disconnected connection cannot pass. Slot release includes a safety allowance and does not extend offline access. |
| Admin device disconnect | The same expiry/restart distinction, plus the existing authoritative hold time and permanent connection retirement/transfer guidance. |
| Customer suspension | Portal access and new authorization/renewals stop until resumed. Existing offline access may continue until expiry; restart requires an online check. The customer is still not notified. |
| Single grant suspension | New authorization and renewals stop until resumed, with explicit offline-expiry and restart consequences. |
| Single grant revocation | Existing permanence/target confirmation plus new-authorization/renewal refusal, possible existing offline access and restart consequences. |
| Bulk grant suspension | Uses the same lifecycle consequence helper as the single-grant action. |
| Bulk grant revocation | Uses the same lifecycle consequence helper, retains irreversible confirmation and explains already-revoked access is skipped. |

The operator UI keeps the shared expiry/restart wording in its own
`shared/accessConsequences.ts`; single and bulk grant actions use the same
grant-owned consequence helper. The portal owns its wording locally. The
[glossary](../../doc/architecture/glossary.md) defines the common meaning,
and both service READMEs explain it. No cross-service UI import or generic
copy framework was introduced.

The browser never computes offline expiry from a hold timestamp and does not
hard-code a lease duration. This corrects the presentation of current behavior;
it does not add offline authority after restart. Native code, backend authority,
lease policy, capacity holds, wire contracts, permissions and data are unchanged.

## Validation

Commands used npm `10.9.8` through `npx --yes npm@10.9.8`, uv `0.12.18`,
and Python `3.12.8` for the deterministic gate. The docs runner selects
Python 3.13 explicitly. Commands needing uv used this environment prefix:

```powershell
$env:PATH='C:\Users\HEQ\Projects\licensecc\build\gap-closure-20261011-c5095b8c\uv;'+$env:PATH
$env:UV_PYTHON='3.12'
```

| Exact command | Outcome |
| --- | --- |
| `npx --yes npm@10.9.8 ci` | Exit 0; 357 packages installed, zero audit vulnerabilities. |
| `node --test services/cloudflare-license-admin/test/admin-ui-workflow.test.mjs` | Exit 0; 135 existing workflow tests. |
| `npx --yes npm@10.9.8 run typecheck --workspace @licensecc/cloudflare-license-admin --workspace @licensecc/cloudflare-customer-portal` | Exit 0 for both UI workspaces. |
| `npx --yes npm@10.9.8 run lint --workspace @licensecc/cloudflare-license-admin --workspace @licensecc/cloudflare-customer-portal` | Exit 0 for both UI workspaces. |
| `npx --yes npm@10.9.8 run check:pr` | Exit 0; 1,807 Node tests in 26 blocks, zero failures, with lint, types, architecture, contracts, service/SQL tests and schema parity. |
| `npx --yes npm@10.9.8 run setup:browsers` | Exit 0; the one root setup command covers Chromium in both UI workspaces. |
| `node build/offline-consequences-20261025-c5b1b268/run-browser-gate.mjs` | Exit 0; the root `npx --yes npm@10.9.8 run test:e2e` passes 8 integration cases, 227 admin and 150 portal browser cases. The focused run passes 4 admin cases and 1 portal case. Exact focused child commands are retained in local validation metadata. |
| `npx --yes npm@10.9.8 run check:dry-run` | Exit 0; all four Workers build and dry-run. |
| `npx --yes npm@10.9.8 run check:docs` | Exit 0; fresh Doxygen XML and strict Sphinx HTML. |
| `npx --yes npm@10.9.8 run test:docs-accuracy` | Exit 0; 18 documentation checks after adding this evidence. |
| `git diff --check` | Exit 0. |

The candidate manifest confirms all 15 owned files were unchanged before
commit. All ten UI files served by the isolated browser builds were
byte-identical to the final service builds (`browser-asset-proof.json`).
The plan/specification diff against `435f5a2e` is empty.

The existing consequence journeys were extended rather than creating a
separate copy snapshot suite. Five focused browser cases inspect seven affected
confirmations at 1440px and 390px, yielding fourteen screenshots. The checks
preserve cancellation without mutation, reason gating, exact typed revocation
and disconnection, single-submit behavior, exact body/key identity and final
status/focus behavior. Unrelated configuration confirmations retain their
existing language and protections.

Representative portal-mobile, bulk-revoke-mobile and admin-desktop screenshots
were visually inspected. The messages wrap within the dialogs and their
confirmation controls remain reachable. Source measurements in the maintained
system map were refreshed from the final candidate.

Local artifacts belong to this task under
`build/offline-consequences-20261025-c5b1b268/`: logs, candidate manifest,
isolated browser builds, asset comparison and fourteen screenshots. Browser
previews use ports 45173/45174 and stop after the gate. Generated output is
not committed.

## Scope and external validation

This closes the consequence wording gaps. Restartable offline permission is
an explicit native design boundary in ADR 0006 and was not changed by UI text.
The task did not change native integration instructions or SDK/runtime code,
so SDK, native build-purity and native install/docs-quickstart gates were not
rerun. Live TPM, live provider/email, production deployment and remote-data
changes were outside this task. All browser mutations use synthetic fixtures.
Existing protected plans, previous evidence and unrelated artifacts were
preserved.
