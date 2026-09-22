# Password invalidation cleanup

Base: `43401e7`, branch `fix/portal-oauth-navigation`.
Worktree: `licensecc-dependabot-review`; the dirty main checkout was not modified.

## Change

The portal owns a single prepared-statement builder for password-related
session, OTP, email-action and account-token invalidation. Routes still own
credential authorization, writes, transaction execution and result checking.
Statement ordering and fresh-hash guards are preserved. Registration does not
advance account-token revocation; settings changes and email resets do.

Added a deterministic race regression: a credential changed between reading
and executing the batch produces a conflict without replacing the winning
hash, revoking sessions, consuming OTPs or advancing token revocation.
Registration coverage also asserts that it creates no token-revocation row.
Updated the measured portal source count in the architecture map.

## Validation

On the implementation patch over the base above:

- `npm ci`: passed with Node 22 and npm 10.9.8.
- `npm run build:worker --workspace @licensecc/cloudflare-customer-portal`:
  passed.
- `node --experimental-sqlite --test services/cloudflare-customer-portal/test/portal-worker-password.test.mjs services/cloudflare-customer-portal/test/portal-worker-password-email.test.mjs`:
  12 passed, none failed or skipped.
- `npm run check:pr`: passed end to end on the final code and source-count
  patch, including both schema parity gates. An earlier attempt caught a
  source-count typo, which was corrected before this complete run.
- `npm run check:docs`: passed, including Doxygen and Sphinx.
- `git diff --check`: passed.

Node commands used `npx --yes --package=node@22 --package=npm@10.9.8 --call`
for the repository-pinned npm and CI Node major. Python gates used
`UV_PYTHON=3.12` and uv 0.12.5. Documentation used the installed global npm.
Local logs are ignored under `build/cleanup-password-{focused,pr,docs}.log`.

Not run: browser E2E, SDK tests, native build-purity, Worker deployment dry-run,
network documentation links, or live Cloudflare checks. This pass changes no
UI, SDK, native, schema, deployment configuration or public API contract.
