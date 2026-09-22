# UI simplification staging rollout

## Candidate

The reviewed UI candidate is commit `efb3bb00dab3fab5ae2198643194a832fba5661a`.
The verification record is commit `da599dbb7b0603ba20507686ffa42c77673af3b7`.
The rollout used an isolated detached worktree at the reviewed commit, so the
unrelated dirty work in the main checkout was not deployed.

## Deployment

The candidate was deployed to the existing staging Workers in account
`88389204e426525a49d661b67a2700b6` using temporary, untracked Wrangler
configuration. Dashboard variables and secrets were retained with
`--keep-vars`; password login remained disabled.

| Worker | Version | URL |
| --- | --- | --- |
| `licensecc-portal-staging` | `5ef9bf91-f616-4067-ae6a-4d49f6d311f4` | https://licensecc-portal-staging.donight.workers.dev |
| `licensecc-admin-staging` | `0adf69a3-095b-4288-b727-9b23de0b8b57` | https://licensecc-admin-staging.donight.workers.dev |

Production Workers were not changed.

## Post-deploy checks

- Portal `/` returned HTTP 200 with the expected HTML shell and security headers.
- Portal `/portal/v1/auth/providers` returned HTTP 200. Google, GitHub, password,
  and email providers remain disabled in this staging environment.
- The customer portal loaded in the authenticated browser session at `#/apps`
  and showed the simplified Apps view with one app card and contextual access.
- Admin `/` returned the Cloudflare Access sign-in page, confirming the staging
  admin remains protected.
- Backend `/health` returned HTTP 200 with `account_token_mode: required`.
- Portal `/health` returned HTTP 503 with `account_token_mode_not_required`.
  This is an existing portal/backend configuration mismatch, not a UI change;
  no backend setting was altered during this rollout. The portal health check
  should be treated as a staging readiness follow-up before production rollout.

## Cleanup

The temporary deployment worktree and its local Wrangler files are removed
after verification. No Wrangler configuration, secret, build output, or test
account data is committed.
