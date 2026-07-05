# Testing Coverage Map

This checklist maps the licensing workflows to local verification and the gated staging drill.

## Verification Commands

- `npm --prefix services/cloudflare-license-admin run test:ui`
- `npm --prefix services/cloudflare-license-admin run test:e2e`
- `npm --prefix services/cloudflare-license-admin run test:sql`
- `npm --prefix services/cloudflare-license-admin run validate:staging-catalog`
- `npm --prefix services/cloudflare-customer-portal run test:ui`
- `npm --prefix services/cloudflare-customer-portal run test:e2e`
- `npm --prefix services/cloudflare-customer-portal run test`
- `npm --prefix services/cloudflare-licensing-backend run test:db`
- `npm --prefix services/cloudflare-licensing-backend run test:sql`
- `npm --prefix services/cloudflare-licensing-backend run test:e2e`

`validate:staging-catalog` exits as skipped when no staging variables are configured. If any staging variable is present, it requires a complete staging configuration and fails on partial setup.

## Coverage Checklist

| Workflow | Local validation | E2E validation | Staging validation | Status |
| --- | --- | --- | --- | --- |
| Admin catalog feature/plan lifecycle | `cloudflare-license-admin test:sql` covers create, patch, disable, re-enable, and audit events. | `admin-ui.e2e.mjs` creates, edits, disables, re-enables, exports, imports, and selects catalog rows. | `validate:staging-catalog` reads catalog plans and exports a configured plan. | Covered |
| Catalog import dry-run/apply | `plan-projection-admin.test.mjs` verifies dry-run, apply, idempotent replay, export, and unchanged re-import. | `admin-ui.e2e.mjs` previews an import, applies a manifest with an idempotency key, and verifies imported rows render. | `validate:staging-catalog` runs import dry-run against staging. | Covered |
| Plan projection preview/apply | Admin and backend SQL tests verify concrete entitlement diffs, disabled policy rejection, assignment rows, and idempotency. | `admin-ui.e2e.mjs` previews and applies a plan projection from the UI. | `validate:staging-catalog` previews a configured plan; `STAGING_ALLOW_MUTATION=1` also applies it. | Covered |
| Admin-worker to verifier boundary | `cloudflare-license-admin test:sql` validates admin APIs against real migrations. | `cloudflare-licensing-backend test:e2e` imports catalog rows through the admin worker, applies a plan, then verifies concrete entitlements through the public verifier worker. | Same staging drill checks the deployed admin boundary; public verifier staging remains covered by `validate:public-verifier`. | Covered |
| Portal floating-seat lifecycle | `cloudflare-customer-portal test` covers session scoping, checkout proxying, no fingerprint oracle, and token scope. | `portal-ui.e2e.mjs` signs in, checks out a floating seat, heartbeats, releases, verifies seat id/client instance continuity, and checks button state transitions. | Covered by backend seat operations and portal worker tests; no separate browser staging drill exists. | Covered locally |
| Portal node-locked download | Portal worker tests cover server-resolved entitlement ownership. | `portal-ui.e2e.mjs` downloads a node-locked license without exposing fingerprints, bearer tokens, private keys, or cross-tenant ids. | Covered by portal deployment smoke tests when available. | Covered locally |
| Feature gating by license/tier | SQL projection tests verify included features and add-ons become concrete entitlement rows; disabled features/plans/policies are blocked or skipped. | Admin UI E2E confirms add-on selection projects a floating feature and concrete rows. | Staging projection preview shows the concrete diff for the configured plan/add-ons. | Covered |

## Staging Drill Variables

- `STAGING_ADMIN_BASE_URL`: deployed admin worker URL.
- `STAGING_ACCESS_TOKEN`: Cloudflare Access JWT for an admin identity.
- `STAGING_PROJECT`: project, defaults to `DEFAULT`.
- `STAGING_PLAN_ID` or `STAGING_PLAN_KEY`: catalog plan to export and project.
- `STAGING_LICENSE_ID`: scratch or existing staging license id for projection preview/apply.
- `STAGING_LICENSE_FINGERPRINT`: 64-hex staging fingerprint.
- `STAGING_CUSTOMER_ID`: optional customer id.
- `STAGING_SUPPORT_UNTIL`: optional Unix timestamp.
- `STAGING_ADDONS`: optional comma-separated add-ons.
- `STAGING_CATALOG_IMPORT_MANIFEST_JSON`: optional manifest for import dry-run; defaults to an empty manifest.
- `STAGING_ALLOW_MUTATION=1`: opt in to projection apply.

## Operational Follow-up

- The local and worker-boundary gaps from the audit are covered by the tests above.
- A live portal browser staging drill still needs a stable staging portal URL, test customer, and OTP/bootstrap path. Until those operational inputs exist, the portal workflow is covered locally by the strict browser fixture plus portal worker isolation tests.
