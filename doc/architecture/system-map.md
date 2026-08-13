# System map

## Accepted baseline

The repository organization work starts from Task 0 commit
`456f701270bf75040992c8e1bd0136fde8792fa2`. Architecture checks and the
contract baselines below describe that accepted implementation, not a proposed
rewrite.

## Modules and deployables

| Area | Responsibility | Deployable/public output |
| --- | --- | --- |
| `include/licensecc/` | Stable C/C++-linkage public ABI: license acquisition, device identification, online decision/seat lifecycle, and configuration-token verification types. | Installed public headers `licensecc.h` and `datatypes.h`; CMake target `licensecc::licensecc_static`. |
| `src/library/` | C++ licensing implementation, parsing, hardware identification, online verification, anti-tamper, and configuration attestation. | Static runtime library. |
| `cmake/`, root `CMakeLists.txt`, `CMakePresets.json` | CMake configuration, project/key generation, install/export configuration, and build presets. | Build-tree generated project material and install tree. |
| `services/cloudflare-licensing-backend/` | Licensing API Worker and D1-backed entitlement, lease, fulfillment, audit, and webhook behavior. | Cloudflare licensing backend Worker. |
| `services/cloudflare-license-admin/` | Administrative Worker API and its React/Vite operator UI. | Cloudflare license-admin Worker plus static UI assets. |
| `services/cloudflare-customer-portal/` | Customer portal Worker, session/auth flow, and React/Vite customer UI. | Cloudflare customer-portal Worker plus static UI assets. |
| `services/cloudflare-d1-backup/` | D1 export-to-R2 backup Worker and Workflow composition. | Cloudflare D1 backup Worker and `D1BackupWorkflow`. |
| `sdks/` | Python, .NET, and Java client surfaces. | Client SDK packages. |
| `test/` | C++/service tests and deterministic public golden vectors. | Test-only fixtures and suites. |

`extern/license-generator` is repository-owned vendored source. Its
`PROVENANCE.md` records the reviewed upstream import and BSD-3-Clause license.
`scripts/bootstrap.ps1 -CheckOnly` validates source presence without mutation;
build/check commands never fetch, patch, or update that source.

## Current TypeScript dependency direction

The shared-package extraction is complete. Production dependencies flow from
portable domain rules through Cloudflare/Web-platform adapters into the four
independently deployable services:

```text
packages/licensing-domain <- packages/cloudflare-runtime <- services/*
```

An arrow points toward a dependency. `licensing-domain` has no Worker or D1
binding; `cloudflare-runtime` may depend on the domain package but never on a
deployable; each service owns its composition root, routes, persistence
queries, migrations, UI, and deployment configuration. No service imports
another service, and no UI imports Worker implementation code.

| Importer | Allowed workspace targets | Notes |
| --- | --- | --- |
| `packages/licensing-domain` | none | Portable policy, values, contracts, and pure projections. |
| `packages/cloudflare-runtime` | `@licensecc/licensing-domain` | Shared HTTP/auth/D1 mechanics used by multiple deployables. |
| `cloudflare-licensing-backend` | `@licensecc/cloudflare-runtime`, `@licensecc/licensing-domain` | Backend route and D1 ownership. |
| `cloudflare-license-admin` | `@licensecc/cloudflare-runtime`, `@licensecc/licensing-domain` | Admin Worker and operator UI ownership. |
| `cloudflare-customer-portal` | `@licensecc/cloudflare-runtime`, `@licensecc/licensing-domain` | Portal Worker and customer UI ownership. |
| `cloudflare-d1-backup` | none | Backup Worker and Workflow remain service-local. |

`npm run check:architecture` enforces this direction and the composition-root
rules in `scripts/architecture-boundaries.json`. A new cross-workspace edge,
undeclared dependency, service-to-service import, or UI/Worker boundary breach
fails the check.

## Worker contracts

The reviewed JSON snapshots in `test/contracts/` are created from compiled
JavaScript only, after the four service `build` scripts run through the root
workspace install.

| Service | Captured exports | Canonical route inventory |
| --- | --- | ---: |
| Licensing backend | `routes.allCanonicalRoutes`, `BACKEND_ROUTE_KEYS`, `openApiSpec` | 19 |
| License admin | `ALL_ROUTES`, `API_BINDING_KEYS`, `openApiDocument` | 65 |
| Customer portal | `ALL_ROUTES`, `PORTAL_ROUTE_KEYS`, `openApiDocument` | 18 |
| D1 backup | default `fetch`/`scheduled` handlers and `D1BackupWorkflow` prototype surface | No route/OpenAPI contract |

The contract runner recursively sorts object keys but keeps array order. It
checks duplicate route keys and runtime OpenAPI operation IDs, and parses the
compiled OpenAPI modules with TypeScript before import so duplicate schema,
path, or method literals cannot be hidden by JavaScript object-key overwrite.

## CMake output roots

The CMake presets use `build/<preset>` as their binary directories. The
top-level build writes generated project material beneath
`${CMAKE_BINARY_DIR}/projects` and generated templates beneath
`${CMAKE_BINARY_DIR}/generated-project-templates`; lease-ring generation also
uses `${CMAKE_BINARY_DIR}/lease_test_ring` and
`${CMAKE_BINARY_DIR}/lease_ring_records.cmake`. Export/configuration artifacts
remain beneath `${CMAKE_BINARY_DIR}`. All checked-in presets install into
`build/<preset>/install`; the build/source boundary is enforced by the CMake
path guard and the build-purity script.

## Measured hotspots and responsibility audit

Measurements are current tracked source lines collected from production `src`
trees and verified by `scripts/docs-accuracy.test.mjs`. They identify ownership
pressure; they are not a quality score. The large files below have explicit
owners in {doc}`ownership` and are not shared implementation by accident.

`scripts/hotspot-baseline.json` adds a no-growth ratchet for every first-party
production file at or above 500 lines. Shrinkage is always accepted; a new
oversized file or growth above an accepted maximum requires either a coherent
responsibility extraction or an explicit, reviewed baseline decision. The
repository-owned third-party `src/library/ini/` sources are excluded.

| Path | Lines | Responsibility audit |
| --- | ---: | --- |
| `src/library/licensecc.cpp` | 1,486 | C++ public API orchestration; changes pair with public ABI tests and CMake packaging. |
| `services/cloudflare-license-admin/src/worker/openapi/components.ts` | 1,308 | Admin contract components; API-contract ownership stays with the admin deployable. |
| `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs` | 1,159 | Backend order-ingest bounded context; persistence and exactly-once tests stay backend-owned. |
| `services/cloudflare-licensing-backend/src/routes/verify.ts` | 983 | Backend verification route and abuse controls; it is not a shared package concern. |
| `services/cloudflare-license-admin/src/ui/features/catalog/Catalog.tsx` | 740 | Catalog list/mutation coordinator; consequence-heavy import/projection workflows and presentation stay in sibling catalog modules. |
| `services/cloudflare-customer-portal/src/ui/features/devices/DevicesFeature.tsx` | 408 | Portal device/floating-seat workflow; portal-local state and consequences remain feature-owned. |
| `services/cloudflare-d1-backup/src/core.ts` | 326 | D1 export/R2 backup orchestration; backup remains independently deployable. |

Composition roots remain intentionally small. Current counts are:

| Deployable | Entry lines | App lines |
| --- | ---: | ---: |
| Backend `src/index.ts` / `src/app.ts` | 1 | 98 |
| Admin Worker `src/worker/index.ts` / `src/worker/app.ts` | 1 | 55 |
| Admin UI `src/ui/main.tsx` / `src/ui/app/App.tsx` | 6 | 81 |
| Portal Worker `src/worker/index.ts` / `src/worker/app.ts` | 2 | 69 |
| Portal UI `src/ui/main.tsx` / `src/ui/app/App.tsx` | 6 | 109 |

Current production-source totals are 17,095 lines for license-admin, 6,590
lines for licensing-backend, 4,672 lines for customer-portal, and 637 lines for
D1-backup. These
counts include TypeScript, TSX, JavaScript, and MJS under each service's
tracked `src` tree. They are evidence for responsibility review, not a reason
to move code without a behavioral or ownership boundary.

## Enforced rules

`npm run check:architecture` scans only tracked production
`services/*/src` and `packages/*/src` files. It resolves relative imports,
including TypeScript `.js` fallbacks, static literal dynamic imports, package
manifests, exports, and declared dependencies. It rejects package-to-service,
service-to-service, UI-to-worker,
undeclared workspace, unresolved relative/subpath, and cross-workspace-relative
imports. It also checks tracked repository hygiene without inspecting ignored
local build output.

The remaining repository tooling boundaries are executable too:

* `.github/CODEOWNERS` supplies the confirmed repository-wide review fallback,
  while {doc}`ownership` defines semantic path boundaries;
* `scripts/script-catalog.json` assigns every script exactly one category;
* `npm run check:hotspots` enforces the measured-file growth ratchets; and
* `npm run doctor` reports local branch, worktree, remote, ignored-output, and
  toolchain drift without mutating the checkout.

Use `npm run test:architecture` for mutation fixtures, `npm run test:contracts`
for reviewed contract comparison, and `npm run write:contract-baselines` only
after intentionally reviewing a contract change.
