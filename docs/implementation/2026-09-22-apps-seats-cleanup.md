# Apps and seat-release cleanup

Base: `4a3a718`, branch `fix/portal-oauth-navigation`, in the
`licensecc-dependabot-review` checkout. The dirty main checkout was preserved.

## Changes

Apps now group entitlements once per render and reuse those groups for rows
and details. Unique feature counts are computed once per row. Existing
lexicographic app ordering and entitlement order are preserved.
Seat-release confirmation uses one try/catch/finally instead of nested blocks;
recovery messages, unknown-outcome handling and focus restoration are unchanged.
Removed a redundant state-updater type assertion. No new shared abstraction,
API, dependency or deployment configuration was introduced.

Browser coverage now checks out-of-order input, duplicate features, app order,
and singular/plural counts. Architecture measurements were refreshed.

## Validation

Validated the implementation patch over the base above:

- `npm ci`: passed.
- `npm run check:pr`: passed end to end, including schema parity. The first
  attempt caught a stale hotspot count, corrected before the complete rerun.
- `npm run setup:browsers`: passed for both retained browser revisions.
- `npm run test:e2e --workspace @licensecc/cloudflare-customer-portal`:
  all 64 scenarios passed.
- `npm run check:docs`: passed (Doxygen and Sphinx).
- `git diff --check`: passed.

Install and PR checks ran through
`npx --yes --package=node@22 --package=npm@10.9.8 --call`, with
`UV_PYTHON=3.12` and uv 0.12.5. Browser and documentation commands used global
npm. Logs are ignored under `build/cleanup-ui-*.log`.

Not run: admin/backend browser E2E, SDK tests, native build-purity, deployment
dry-run, live Cloudflare checks or network documentation-link validation.
