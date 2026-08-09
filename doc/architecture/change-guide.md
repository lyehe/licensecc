# Change guide

This guide routes common changes to the owner that can validate them. Read the
{doc}`system map <system-map>` and applicable
{doc}`module-boundaries ADR <decisions/0001-module-boundaries>` before crossing
a package or deployable boundary.

## C++ public API

1. Add or change the stable declaration under `include/licensecc/`.
2. Implement it in the owning `src/library/` module; keep C++ ABI and
   platform-specific code behind the existing public boundary.
3. Add focused coverage under `test/` and update an example only when the user
   workflow changes.
4. If installation, generated headers, or CMake targets change, update the
   relevant `cmake/` or root CMake documentation and run the core purity gate.

Use `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
and the CTest command for the selected preset. Public ABI or license-format
changes require a compatibility note in the pull request and the API docs.

## Worker route

Add a route only inside the service that deploys it:

* backend: `services/cloudflare-licensing-backend/src/routes/` and its route
  inventory;
* admin: `services/cloudflare-license-admin/src/worker/groups/` and its
  bounded-context dispatch modules;
* portal: `services/cloudflare-customer-portal/src/worker/routes/` or the
  owning public/auth/session group;
* backup: the backup service's `src/` route/Workflow boundary.

Keep the Worker entrypoint and app composition-only. Add characterization or
route-group tests beside the owning service. Do not import another deployable;
shared mechanics belong in `packages/cloudflare-runtime` only when at least
two deployables use the same protocol primitive.

## D1 query or migration

The canonical licensing D1 migrations and schema-parity inputs live under
`services/cloudflare-licensing-backend/migrations/` and its `schema.sql`/
`scripts/check-schema-parity.py` tooling. Admin and portal local migration
commands deliberately apply that backend-owned schema; they do not create a
second migration history. Put a service-specific query beside the route or
bounded context that owns the data transition. Shared D1 binding mechanics
belong in `packages/cloudflare-runtime` when reused by multiple deployables;
service-specific SQL, authorization, and atomicity stay local. Update backend
SQL/parity tests and each affected operational README when the migration
changes deployment order or recovery behavior.

## Policy rule

Portable policy values, transitions, catalog DTOs, and pure classification
rules belong in `packages/licensing-domain`. Cloudflare/D1 policy persistence
adapters belong in `packages/cloudflare-runtime` only when reused by multiple
deployables. A route-specific authorization or state transition remains in
the owning service. Keep the server as the policy source of truth; UI checks
are convenience and explanatory copy only.

## UI feature

Add an admin feature under
`services/cloudflare-license-admin/src/ui/features/<workflow>/` or keep a
portal workflow in `services/cloudflare-customer-portal/src/ui/` when it has a
demonstrated portal-local responsibility. Put browser API plumbing in the
service's existing shared UI layer. `main.tsx` mounts, `App.tsx` composes, and
feature modules own workflow state and presentation. Do not import Worker
implementation files into UI code. Preserve neutral consequence text and
deliberate confirmation for destructive actions.

Run the service UI workflow tests and the relevant browser smoke test. Do not
change the route contract merely to make a UI feature easier to compose.

## SDK change

Change the relevant package under `sdks/python/` or `sdks/dotnet/`, keeping
wire-format and token verification behavior aligned with the canonical
fixtures. Add package-local tests and update the SDK README when supported
runtime or install behavior changes. Run `npm run test:sdks` from the root;
this command runs Python and .NET checks without changing the root lockfile.

## OpenAPI operation

The deployable that serves the route owns both the route inventory and its
OpenAPI fragments. Add the operation beside the owning bounded-context path
module, update the inventory's `inSpec`/method metadata, and add or update the
service OpenAPI cross-check. Keep operation IDs unique, declare auth and at
least one response, and preserve the canonical contract unless a deliberate
API change is approved. Meta/self-description routes may remain outside the
spec only when the inventory marks them that way.

Run `npm run test:contracts`, the owning service's `test:openapi`, and
`npm run check:architecture`. Do not generate OpenAPI from handlers or let a
shared package own a service dispatch table.

## Final validation surface

For a normal pull request, run:

```powershell
npm run check:pr
```

For work outside that deterministic gate, use the dedicated commands:
`npm run test:sdks`, `npm run setup:browsers`, `npm run test:e2e`,
`npm run check:dry-run`, and `npm run check:docs`. The docs command requires
Doxygen; `npm run check:docs:links` is network-sensitive and scheduled/manual.
