# Ownership map

Ownership here is by role and repository boundary. It intentionally names no
individuals or teams that have not been confirmed.

| Role | Authoritative paths | Owns |
| --- | --- | --- |
| C++ ABI and core maintainer | `include/licensecc/`, `src/library/`, `test/`, `cmake/`, root CMake files | Public headers, ABI behavior, licensing runtime, platform adapters, CMake targets, and C++ tests. |
| Shared licensing-domain maintainer | `packages/licensing-domain/` | Portable entitlement values, policy transitions, catalog DTOs, pure projections, contracts, and audit logic. No Worker bindings. |
| Shared Cloudflare-runtime maintainer | `packages/cloudflare-runtime/` | Reused HTTP/auth/D1 mechanics and protocol adapters. No deployable route or service-specific business transition. |
| Backend deployable maintainer | `services/cloudflare-licensing-backend/` | Licensing verification, fulfillment, leases, seats, webhooks, D1 queries/migrations, backend OpenAPI, and backend deployment. |
| Admin deployable maintainer | `services/cloudflare-license-admin/` | Operator Worker routes, authorization/use cases, admin OpenAPI, catalog/policy workflows, UI features, and deployment. |
| Customer-portal deployable maintainer | `services/cloudflare-customer-portal/` | Customer auth/session/public routes, portal OpenAPI, self-service UI/workflows, and deployment. |
| D1-backup deployable maintainer | `services/cloudflare-d1-backup/` | D1 export/R2 backup Worker, restore drill, Workflow, operational checks, and deployment. |
| SDK maintainer | `sdks/python/`, `sdks/dotnet/`, `test/vectors/` | Python/.NET public client behavior, token/vector compatibility, package tests, and SDK documentation. |
| API-contract maintainer | Each service's route inventory, `src/**/openapi/`, `test/contracts/`, contract tests | Served route sets, OpenAPI operations/components, canonical hashes, and compatibility review. The serving deployable remains the owner. |
| Release and CI maintainer | `.github/workflows/`, `package.json`, `package-lock.json`, `scripts/`, `CMakePresets.json` | Reproducible installs, local/CI command parity, purity gates, architecture/secret checks, release evidence, and workflow configuration. |
| Documentation and architecture maintainer | `README.md`, `CONTRIBUTING.md`, `doc/`, `docs/implementation/` | Repository map, maintainer guidance, architecture decisions, user/developer docs, and evidence reports. Protected plans remain under `docs/superpowers/plans/`. |

## Boundary rules

* A deployable owns its composition root, route dispatch, service-specific
  authorization, persistence, migrations, UI, and deployment configuration.
* Shared code must have a named purpose and at least two consumers. A package
  must not become a catch-all for service implementation.
* Route and OpenAPI ownership stay together in the serving deployable.
* `extern/license-generator` is repository-owned vendored source. Its license
  and `PROVENANCE.md` are part of the review boundary; build and documentation
  work never fetch, patch, or overwrite it.
