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
| `sdks/` | Python and .NET client surfaces. | Client SDK packages. |
| `test/` | C++/service tests and deterministic public golden vectors. | Test-only fixtures and suites. |

`extern/license-generator` is a pinned submodule. `scripts/bootstrap.ps1
-CheckOnly` reports its expected revision without mutation; initialization is an
explicit bootstrap action and build/check commands never patch or update the
submodule.

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

Measurements are tracked source lines at the Task 11 base, collected from
production `src` trees. They identify ownership pressure; they are not a
quality score. The large files below have explicit owners in
{doc}`ownership` and are not shared implementation by accident.

| Path | Lines | Responsibility audit |
| --- | ---: | --- |
| `src/library/licensecc.cpp` | 1,462 | C++ public API orchestration; changes pair with public ABI tests and CMake packaging. |
| `services/cloudflare-license-admin/src/worker/openapi/components.ts` | 988 | Admin contract components; API-contract ownership stays with the admin deployable. |
| `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs` | 1,091 | Backend order-ingest bounded context; persistence and exactly-once tests stay backend-owned. |
| `services/cloudflare-licensing-backend/src/routes/verify.ts` | 985 | Backend verification route and abuse controls; it is not a shared package concern. |
| `services/cloudflare-customer-portal/src/ui/main.tsx` | 640 | Portal UI composition and customer workflows; portal-local UI ownership. |
| `services/cloudflare-d1-backup/src/core.ts` | 326 | D1 export/R2 backup orchestration; backup remains independently deployable. |

Composition roots remain intentionally small. The Task 9 accepted final and
Task 11 current counts are:

| Deployable | Task 9 accepted | Task 11 current |
| --- | ---: | ---: |
| Backend `src/index.ts` / `src/app.ts` | 1 / 73 | 1 / 80 |
| Admin Worker `src/worker/index.ts` / `src/worker/app.ts` | 1 / 50 | 1 / 54 |
| Admin UI `src/ui/main.tsx` / `src/ui/app/App.tsx` | 4 / 75 | 6 / 81 |
| Portal Worker `src/worker/index.ts` / `src/worker/app.ts` | 2 / 67 | 2 / 75 |

Current production-source totals are 10,940 lines for license-admin, 5,946 for
licensing-backend, 3,480 for customer-portal, and 568 for D1-backup. These
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

Use `npm run test:architecture` for mutation fixtures, `npm run test:contracts`
for reviewed contract comparison, and `npm run write:contract-baselines` only
after intentionally reviewing a contract change.
