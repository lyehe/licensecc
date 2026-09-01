# Customer portal Worker

This directory owns the customer-facing Worker, authentication/session routes,
self-service routes, OpenAPI fragments, and React UI. It is independently
deployable; it does not import another service's implementation. Shared
portable policy and Cloudflare mechanics come from the explicit workspace
packages documented in [`../../doc/architecture/system-map.md`](../../doc/architecture/system-map.md).

**Audience:** portal contributors and authorized hosted-platform operators.
Offline native integrations and server-token verification do not require this
deployable.

| Goal | Start here | Side effects |
| --- | --- | --- |
| Validate code locally | [Local checks](#local-checks) | Local build/test output only |
| Review credential forwarding | [Credential-bearing destinations](#credential-bearing-destinations) | Read-only documentation |
| Validate a deployed portal | Use the staged/production drill below | Sends an authorized session to the named remote origin |
| Judge production readiness | [Production readiness](../../doc/operations/production-readiness.md) | Evidence review; deployment remains an operator decision |

Unless a block explicitly says "repository root," run service-local commands
from `services/cloudflare-customer-portal` after the single root workspace
install. Remote validation requires authority for the target and a deliberately
scoped credential.

## Local checks

From the repository root after the pinned root install:

```powershell
npm run lint --workspace @licensecc/cloudflare-customer-portal
npm run typecheck --workspace @licensecc/cloudflare-customer-portal
npm run test --workspace @licensecc/cloudflare-customer-portal
npm run test:ui --workspace @licensecc/cloudflare-customer-portal
npm run test:openapi --workspace @licensecc/cloudflare-customer-portal
npm run dry-run --workspace @licensecc/cloudflare-customer-portal
```

Browser smoke tests require the explicit one-time setup command
`npm run setup:browsers`, followed by `npm run test:e2e`.

The deployed portal drill also verifies that the built UI shell and health
endpoint load before authenticating. With an existing session cookie and the
mutation flags left unset, it is safe for a production post-deploy read gate:

Run this block from the service directory. It is application-read-only but
still transmits the supplied session cookie to the configured remote origin.

```powershell
$env:LICENSECC_PORTAL_URL = "https://portal.example.workers.dev"
$env:LICENSECC_PORTAL_SESSION_COOKIE = "<redacted-session-cookie>"
npm run validate:staging-portal
```

The protected staging bootstrap path additionally requires an unauthenticated
`/api/portal/me` denial, verifies the newly issued `lccp_session` cookie has
`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and a positive `Max-Age`, and
requires another denial after logout. The existing-cookie production read gate
does not issue or log out that operator-supplied session, so it does not claim
cookie-issuance or post-logout coverage.

The shipped browser/session workflow does not hold a native device private key.
The standard protected four-Worker topology therefore uses
`DEVICE_PROOF_MODE=off`: absence is permitted, but the backend still verifies
every proof that a native client presents. Global `required` mode is a future
client-registration/signing migration; never place a device private key in this
Worker or in browser-delivered configuration to simulate possession.

## Credential-bearing destinations

`BACKEND_ORIGIN` and the optional `PORTAL_EMAIL_API_BASE` are strict canonical
HTTPS origins: use `https://host.example` (or the same origin with one terminal
slash) only. Userinfo, a path, query, fragment, malformed spelling, and HTTP
are rejected before the Worker mints/sends a bearer or constructs an email API
key request. There is no HTTP local-development exception; use a local HTTPS
endpoint when overriding either destination.

The portal currently retains the validated-origin configuration rather than a
Worker service binding. The backend also has independent local-host, preview,
and deployment targets, and the tracked configuration has no reviewed
per-environment binding map for all of them. Add a service binding only with an
explicit target mapping for every deployment environment; until then invalid
destinations fail closed and readiness returns its existing 503 envelope.

See the [change guide](../../doc/architecture/change-guide.md) before adding
a route, migration, policy rule, UI workflow, or OpenAPI operation. Keep real
Wrangler configuration and secrets local; commit only the `wrangler.example.*`
templates.
