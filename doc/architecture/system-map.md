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

`extern/license-generator` is a pinned submodule. Its dirty nested worktree is
user-owned and deliberately outside this task's change set.

## Current TypeScript package edges

There is no `packages/` directory yet. The only production cross-workspace
edges are temporary, exact service-to-service imports:

| Importer | Target | Exact imports | Removal |
| --- | --- | ---: | --- |
| `cloudflare-license-admin` | `@licensecc/cloudflare-licensing-backend` | 17 | `org/04-shared-packages` |
| `cloudflare-customer-portal` | `@licensecc/cloudflare-licensing-backend` | 6 | `org/04-shared-packages` |
| `cloudflare-licensing-backend` | workspace package/service | 0 | — |
| `cloudflare-d1-backup` | workspace package/service | 0 | — |

Every one of the 23 edges records its importing file and backend export subpath
in `scripts/architecture-boundaries.json`. The checker treats a new edge, a
different subpath, an unused entry, or an expired entry as a failure.

## Worker contracts

The reviewed JSON snapshots in `test/contracts/` are created from compiled
JavaScript only, after all four current `npm --prefix <service> run build`
commands complete.

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
remain beneath `${CMAKE_BINARY_DIR}`. Presets currently install into
`install/<preset>` for developer/Linux shapes and `C:/licensecc` for the Windows
CI shapes. Task 2 owns making this build/source boundary fully pure.

## Measured hotspots

Measurements are tracked source lines at the accepted baseline, collected from
the top-level implementation and public-header trees. They identify ownership
pressure; they are not a quality score.

| Path | Lines | Current concern |
| --- | ---: | --- |
| `services/cloudflare-license-admin/src/worker/index.ts` | 2,983 | Admin Worker composition, dispatch, validation, and use cases are concentrated together. |
| `services/cloudflare-license-admin/src/ui/main.tsx` | 2,532 | Operator UI state and presentation are concentrated in one entry point. |
| `services/cloudflare-license-admin/src/worker/openapi.ts` | 2,214 | Large generated-like API description remains one document. |
| `services/cloudflare-licensing-backend/src/index.ts` | 2,205 | Backend composition root owns many bounded contexts. |
| `src/library/licensecc.cpp` | 1,373 | C++ public API orchestration is a central runtime hotspot. |
| `services/cloudflare-license-admin/src/ui/operatorWorkflow.ts` | 1,207 | Operator UI workflow state is concentrated. |
| `services/cloudflare-licensing-backend/src/openapi.ts` | 1,074 | Backend API description is a second large document. |
| `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs` | 1,008 | Fulfillment ingestion is a bounded-context hotspot. |

Current service-source totals are 10,427 lines for license-admin, 8,517 for
licensing-backend, 3,053 for customer-portal, and 510 for D1-backup. Later
tasks use these measurements to split responsibility without moving code merely
to improve a count.

## Enforced rules

`npm run check:architecture` scans only tracked production
`services/*/src` and `packages/*/src` files. It resolves relative imports,
including TypeScript `.js` fallbacks, static literal dynamic imports, package
manifests, exports, and declared dependencies. It rejects package-to-service,
service-to-service (except the exact temporary inventory), UI-to-worker,
undeclared workspace, unresolved relative/subpath, and cross-workspace-relative
imports. It also checks tracked repository hygiene without inspecting ignored
local build output.

Use `npm run test:architecture` for mutation fixtures, `npm run test:contracts`
for reviewed contract comparison, and `npm run write:contract-baselines` only
after intentionally reviewing a contract change.
