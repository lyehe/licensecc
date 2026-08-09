# ADR 0002: One reproducible npm workspace install

- Status: Accepted
- Date: 2026-08-08
- Decision owners: repository maintainers

## Context

The repository contains four independently buildable and deployable Cloudflare
Workers, but each service previously carried its own npm lockfile and the root
scripts installed or invoked them with `npm --prefix`. That allowed dependency
resolution and CI cache inputs to drift between services.

The workspace is dependency orchestration only. It must not combine Worker
bundles, change deployment boundaries, or make one service's runtime depend on
another service's generated output.

## Decision

The repository uses one root npm workspace install:

1. The six declared workspaces are the two reviewed shared packages and four
   independently deployable service directories: `licensing-domain`,
   `cloudflare-runtime`, `cloudflare-licensing-backend`,
   `cloudflare-license-admin`, `cloudflare-customer-portal`, and
   `cloudflare-d1-backup`.
2. `package-lock.json` at the repository root is the authoritative lockfile.
   Package-local lockfiles are not tracked.
3. The package-manager policy is pinned to `npm@10.9.8` through the root
   `packageManager` field and matching npm engine, with Node `>=22`.
4. Root scripts invoke service scripts with
   `npm run <script> --workspace <workspace-name>`. A service remains
   independently runnable: after the root install, `npm run <script>` from a
   service directory resolves through the workspace root.
5. Workspace dependency declarations point only to explicit shared packages
   or ordinary third-party dependencies. The temporary service-to-service
   `file:` dependencies were removed during the shared-package extraction;
   services do not depend on another deployable's implementation.
6. CI caches and installs from the root lockfile with one `npm ci`.
7. Optional real-PostgreSQL or `pg-mem` smoke dependencies are not ordinary
   workspace dependencies. Their opt-in instructions must install them
   explicitly and must not rewrite or extend the authoritative lockfile.

The local service gate checks `npm --version` and fails unless it is exactly
`10.9.8`. On a fresh machine, bootstrap the pinned CLI for the root install
with `npx --yes npm@10.9.8 ci`; CI explicitly selects the same npm version
before running its single `npm ci`.

## Consequences

- A clean checkout has one deterministic install and one dependency graph.
- Every Worker still has its own manifest, build command, Wrangler config, and
  deployable bundle.
- Dependency additions are reviewed at the root and lockfile generation is
  performed by the pinned npm version; lockfile content is never hand-edited.
- Service-local `npm ci` is no longer a supported installation path because no
  package-local lockfile exists.
- Optional PostgreSQL smoke tests remain intentionally separate from ordinary
  service and CI installs, avoiding flaky network/database prerequisites.

## Final workspace outcome

As of the accepted Task 10 base on 2026-08-08, the workspace decision is
implemented and no longer transitional:

* `package-lock.json` is the only tracked **npm workspace** lockfile and covers
  the six declared workspaces: `licensing-domain`, `cloudflare-runtime`, and
  the four deployables. SDK-specific lock/material files such as Python's
  `uv.lock` remain separate concerns.
* `npm ci` with npm `10.9.8` installs one reproducible dependency graph; no
  service-local lockfile or install command is part of the repository contract.
* The four Workers still build and deploy independently. A workspace install
  does not combine their bundles or make one service's runtime depend on
  another service.
* `npm run check:architecture` reports no service-to-service debt, and package
  boundaries are enforced by explicit exports and dependencies.
* CI and local checks use the same root command surface; optional SDK, browser,
  dry-run, and documentation checks remain dedicated commands described in
  the root README.
