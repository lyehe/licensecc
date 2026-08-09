# ADR 0001: Module boundaries and dependency direction

- Status: Accepted
- Date: 2026-08-08
- Decision owners: repository maintainers

## Context

The repository contains C++ runtime code and four independently deployable
Cloudflare services. During the completed organization transition, temporary
direct imports from the admin and portal deployables into the
licensing-backend deployable made shared implementation look like a deployable
dependency and left architectural intent implicit in source paths.

The organization plan required a direction that supports independently
deployable Workers while retaining a small, explicit home for truly shared
policy and runtime adapters.

## Decision

The TypeScript dependency direction is:

```text
licensing-domain  <-  cloudflare-runtime  <-  deployables
```

An arrow points toward a dependency. Deployables may depend on
`cloudflare-runtime`; `cloudflare-runtime` may depend on `licensing-domain`;
neither lower layer may depend on a deployable. The C++ runtime remains its own
public ABI and does not become an implementation dependency of Worker packages.

Placement rules are:

1. `packages/licensing-domain` contains portable policy, entitlement values and
   transitions, catalog DTOs and pure classification rules, shared API
   contracts, and pure audit logic. D1-backed catalog projection and
   single-service usage reporting stay with their owning deployable. The domain
   package has no Worker `Env`, D1 binding, service, secret, or route ownership
   dependency.
2. `packages/cloudflare-runtime` contains Cloudflare/Web-standard mechanics
   reused by at least two deployables, such as HTTP helpers, account-token
   primitives, D1 contracts/adapters, and idempotency. A single-consumer
   adapter remains service-local: the current seat-reclaim implementation is
   admin-owned and webhook delivery is backend-owned. Only an independently
   shared protocol primitive may move. The runtime package may depend on
   `licensing-domain`, but never on a service.
3. Each `services/*` deployable owns its Worker composition root, bindings,
   routes, service-specific authorization/use cases, migrations, static UI, and
   deployment configuration. A deployable never imports another deployable.
4. UI code under `src/ui` never imports Worker code under `src/worker`, directly
   or through a workspace export. Shared browser/Worker data contracts belong in
   `licensing-domain/contracts`, not a Worker implementation file.
5. Cross-workspace code moves use an explicit package import and a declared
   `dependencies` entry. Relative paths may not cross a workspace root.
6. Public package exports are explicit subpaths. A package-to-service import,
   an undeclared workspace dependency, or an unexported subpath is invalid.
7. Every Worker route inventory and OpenAPI object is a reviewed contract. Route
   ownership stays with its deployable; shared packages do not own a service's
   dispatch table.

`scripts/check-architecture.mjs` is the executable enforcement of these rules.
It scans tracked production code only, emits deterministic diagnostics, and
fails repository hygiene debt that is expired or unused.

## Historical transition outcome

The 23 exact admin/portal-to-backend imports described during the transition
were moved into the two packages above and the compatibility edges were
removed. `scripts/architecture-boundaries.json` now has an empty
`serviceImportAllowances` list; a new service-to-service edge fails closed.

The temporary `pyvenv.cfg` build-purity exception was also removed. These
historical exceptions remain described here so their closure is auditable, not
as permission for new source changes.

## Consequences

- Refactors get an immediate failure when they introduce an architectural edge
  that has not been explicitly designed and documented.
- Services remain independently built/deployed; a workspace is dependency
  orchestration, not a combined runtime.
- Extracting shared code requires deliberately choosing domain versus runtime,
  avoiding a generic shared-package junk drawer.
- Closed transition inventories are kept empty and fail closed, preventing a
  stale compatibility allowance from becoming a new service boundary.
