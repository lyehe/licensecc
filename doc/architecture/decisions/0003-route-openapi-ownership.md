# ADR 0003: Route and OpenAPI ownership

- Status: Accepted
- Date: 2026-08-08
- Decision owners: repository maintainers

## Context

The repository has four independently deployable Workers with route
inventories, bounded-context handlers, and OpenAPI descriptions. A route or
operation can be served correctly while its inventory, specification, or
contract fixture silently drifts unless one deployable owns the complete
surface. Shared packages provide reusable mechanics, but they must not own a
service's dispatch table or public contract.

## Decision

The deployable that serves a route owns all of the following:

1. The route inventory and dispatch registration.
2. The handler, authorization boundary, persistence transition, and route
   tests.
3. The matching OpenAPI path/component fragment and OpenAPI cross-check.
4. The canonical contract fixture and compatibility review for intentional
   wire changes.

The current ownership boundaries are:

| Deployable | Route and contract owner |
| --- | --- |
| Licensing backend | `services/cloudflare-licensing-backend/src/routes/`, route inventory, and `src/openapi/`. |
| License admin | `services/cloudflare-license-admin/src/worker/groups/`, bounded-context groups, route inventory, and `src/worker/openapi/`. |
| Customer portal | `services/cloudflare-customer-portal/src/worker/routes/`, public/auth/session inventory, and `src/worker/openapi/`. |
| D1 backup | `services/cloudflare-d1-backup/src/` Worker/Workflow surface; it has no route/OpenAPI contract fixture. |

An OpenAPI operation is added beside the owning bounded-context path module and
is linked to the inventory's method and `inSpec` metadata. Every operation has
a unique `operationId`, declared authentication where expected, and at least
one response. Metadata or self-description routes stay outside the spec only
when the canonical inventory explicitly marks them out of scope.

`test/contracts/` compares the reviewed canonical route/OpenAPI surfaces after
the service builds. Service OpenAPI tests also reject duplicate route,
component, path/method, and operation identifiers. `npm run check:architecture`
enforces that route and UI/Worker composition boundaries remain in the serving
deployable.

## Consequences

* A route change is a bounded-context change with one clear owner and a
  predictable validation set.
* Shared packages can carry portable contracts or mechanics, but cannot hide
  service dispatch or authorization policy.
* Canonical contract snapshots are intentionally review material, not generated
  from handlers. A semantic wire change needs explicit API review.
* Contributors update the inventory, OpenAPI fragment, tests, and evidence in
  the same change; omission fails the contract checks instead of publishing an
  undocumented operation.
