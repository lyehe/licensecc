# Customer portal Worker

This directory owns the customer-facing Worker, authentication/session routes,
self-service routes, OpenAPI fragments, and React UI. It is independently
deployable; it does not import another service's implementation. Shared
portable policy and Cloudflare mechanics come from the explicit workspace
packages documented in [`../../doc/architecture/system-map.md`](../../doc/architecture/system-map.md).

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

See the [change guide](../../doc/architecture/change-guide.md) before adding
a route, migration, policy rule, UI workflow, or OpenAPI operation. Keep real
Wrangler configuration and secrets local; commit only the `wrangler.example.*`
templates.
