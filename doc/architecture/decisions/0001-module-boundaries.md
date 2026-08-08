# ADR 0001: Module boundaries and dependency direction

- Status: Accepted
- Date: 2026-08-08
- Decision owners: repository maintainers

## Context

The repository currently contains C++ runtime code, four independently
deployable Cloudflare services, and temporary direct imports from the admin and
portal deployables into the licensing-backend deployable. This made a shared
implementation look like a deployable dependency and left architectural intent
implicit in source paths.

The organization plan needs a direction that supports independently deployable
Workers while retaining a small, explicit home for truly shared policy and
runtime adapters.

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

## Transitional exception

Until Task 4, exactly 23 production imports from admin/portal into
`@licensecc/cloudflare-licensing-backend` are documented in
`scripts/architecture-boundaries.json`. Each entry includes the importing file,
the backend export subpath, a reason, and `removeBy:
org/04-shared-packages`. No wildcard or broader service allowance is valid.
Task 4 must move the shared implementation into the two packages above and
delete every entry rather than retaining compatibility forwarding shims.

`pyvenv.cfg` is separately documented temporary build-purity debt and carries
both `owner` and `removeBy` `org/02-build-purity`. Task 2 removes it.

## Consequences

- Refactors get an immediate failure when they introduce an architectural edge
  that has not been explicitly designed and documented.
- Services remain independently built/deployed; a workspace is dependency
  orchestration, not a combined runtime.
- Extracting shared code requires deliberately choosing domain versus runtime,
  avoiding a generic shared-package junk drawer.
- The temporary direct imports are intentionally visible and will cause failure
  once their exact source use disappears, preventing stale debt metadata.
