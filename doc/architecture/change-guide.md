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
portal workflow under
`services/cloudflare-customer-portal/src/ui/features/<workflow>/` when it has
a demonstrated portal-local responsibility. Put browser API plumbing in the
service's existing shared UI layer. `main.tsx` mounts, `App.tsx` composes, and
feature modules own workflow state and presentation. Do not import Worker
implementation files into UI code. Preserve neutral consequence text and
deliberate confirmation for destructive actions.

Run the service UI workflow tests and the relevant browser smoke test. Admin
browser scenarios live in concern-specific `admin-ui.*.e2e.mjs` specs and
share only the API fixture in `admin-ui.fixture.mjs`; add a scenario to the
owning concern rather than rebuilding a monolithic suite. Do not change the
route contract merely to make a UI feature easier to compose.

## Release assembly

Release orchestration stays in `scripts/assemble-release-artifacts.mjs` while
format validation and filesystem boundaries live under `scripts/release/`.
Keep those modules pure or dependency-injected where possible, preserve the
canonical-HEAD input contract, and never relax output ownership or archive
validation to accommodate a tool. Run `npm run test:release-artifacts`; a real
release proof additionally requires two confined, byte-identical assemblies.

## Repository tooling or layout

Keep stable root commands in `package.json` and stable operator-facing script
paths intact unless a compatibility migration is part of the change. Every
path under `scripts/` must have exactly one purpose category in
`scripts/script-catalog.json`; internal helpers may move into a subdirectory
when that reflects a real module boundary rather than cosmetic depth.

Keep the confirmed repository-wide fallback in `.github/CODEOWNERS`. When
role-specific GitHub teams are introduced, align their path rules with
`doc/architecture/ownership.md`. For a first-party production file already at
or above the checked threshold, do not raise its line-count ratchet as a routine
consequence of a feature. Extract a coherent responsibility or explain and
review the explicit baseline change.

Run `npm run test:repository`, `npm run check:scripts`, and
`npm run check:hotspots`. `npm run doctor` is the read-only local diagnostic;
its branch, worktree, output, remote, and optional-tool findings do not become a
portable PR failure unless they represent a repository contract.

## SDK change

Change the relevant package under `sdks/python/`, `sdks/dotnet/`, or
`sdks/java/`, keeping wire-format and token verification behavior aligned with
the canonical fixtures. Add package-local tests and update the SDK README when
supported runtime or install behavior changes. Run `npm run test:sdks` from
the root; this command runs Python, .NET, and Java checks without changing the
root lockfile.

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
