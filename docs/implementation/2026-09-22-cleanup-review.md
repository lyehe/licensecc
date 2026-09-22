# Cleanup review and verification

Reviewed `4746ca8` through `35e5617` on `fix/portal-oauth-navigation`.
Verification below used `35e5617` plus the two corrections recorded here.

## Findings and corrections

- Recent UI and digest refactors left the architecture source total stale.
  Updated customer-portal source lines from 6,368 to 6,400; no counting rule changed.
- The Windows canonical-contract runner assumed npm was installed beside Node.
  With separately installed Node/npm, direct npm.cmd spawning returned EINVAL
  and the fallback could not locate npm. Use npm_execpath supplied by npm before
  the existing adjacent-install fallback. Commands remain shell-free.
- The route interop assertions improve caller types but do not establish checked
  JavaScript return contracts. Record<string, unknown> options remain broad.
  No runtime defect was established in those type-only edits.
- Prior calculator-plan removal is not evidence that all its live qualification
  steps were completed. Local example tests and live deployment tests are distinct.

## Validation

Local uv was upgraded from 0.5.15 to the repository-required 0.12.5. Python
commands used UV_PYTHON=3.12. CI matches Node 22; the successful pinned run used
Node 22.23.2 and npm 10.9.8 through:

    npx --yes --package=node@22 --package=npm@10.9.8 --call 'npm ci && npm run check:pr'

Installation passed. The PR gate passed every stage preceding test:contracts,
including release artifacts, lint, typecheck, architecture and hotspot tests.
It stopped at the Windows npm-path issue described above. After that correction:

    npx --yes --package=node@22 --package=npm@10.9.8 --call 'npm run test:contracts && npm run test:services'

passed, completing the failed stage and all remaining PR-gate stages. This is a
split verification, not an uninterrupted check:pr success on the final patch.

Additional checks:

- npm run test:docs-accuracy: 14 passed after the source-total correction.
- npm run check:docs: Doxygen and strict Sphinx HTML build passed.
- npm run check:schema-parity: SQLite and PostgreSQL semantic parity passed
  (50 tables, 75 explicit indexes, 6 generation trigger groups).
- node --test services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs:
  39 passed, including real local migration-suffix application.
- cmake --build build/calculator-example --config Debug and
  ctest --test-dir build/calculator-example -C Debug --output-on-failure:
  build and 5 tests passed using Visual Studio's bundled CMake/CTest by absolute
  path and the existing installed consumer configuration.
- git diff --check: passed.

The initial Node 24.20.0 run failed seven lease-drill tests. A standalone
node:crypto reproduction failed to re-export a freshly imported RSA public key
as PKCS1 DER. All eight lease-drill tests passed on Node 22.23.2. These tests
generate local fixtures; the failure was not missing staging credentials.

Browser E2E, SDK suites, live deployments, physical TPM qualification and real
PostgreSQL-server conformance were not rerun in this review. No remote data or
deployment was changed. Local execution logs remain ignored under build/.
