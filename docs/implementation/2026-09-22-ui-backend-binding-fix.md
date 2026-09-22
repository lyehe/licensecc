# Staging backend binding follow-up

## Finding

The first isolated staging rollout left the portal `/health` route at HTTP 503
even though the backend itself was healthy. A remote Worker runtime probe
returned Cloudflare error 1042 when the portal fetched the backend's
`workers.dev` hostname. Cloudflare documents that same-zone Worker-to-Worker
requests require a service binding (or the strictly-public compatibility flag).

## Change

The portal now accepts a `BACKEND` service binding and uses it for backend
readiness checks and credentialed self-service proxy calls. The HTTPS origin
remains validated and is retained as the local/test fallback. The example
Wrangler configuration declares the default service binding alongside the
existing `DeviceConsent` entrypoint binding.

## Verification

- Portal build and TypeScript generation passed with the new binding type.
- Portal unit/runtime suite passed: 143 tests; focused OpenAPI/drill suite: 22 tests.
- Customer portal browser E2E passed: 64 tests.
- Staging redeployed with `BACKEND -> licensecc-online-verifier-staging`:
  - Worker: `licensecc-portal-staging`
  - Version: `18e9dc31-7189-45f0-9ed5-46b062eafbb3`
  - URL: https://licensecc-portal-staging.donight.workers.dev
- Staging portal `/health` now returns HTTP 200 with
  `account_token_mode_required: true`.
- Production remains untouched.

Temporary runtime probes and deployment worktrees are local-only and are not
committed.
