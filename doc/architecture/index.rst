Architecture
============

This page is the landing page for repository structure, ownership, and
change-routing rules. It describes the accepted implementation at the current
repository base; it does not replace service-local runbooks or public API
documentation.

Start here:

* :doc:`system-map` — deployables, package direction, contracts, build roots,
  and measured hotspots.
* :doc:`change-guide` — the smallest correct place to make common changes,
  including repository tooling and layout changes.
* :doc:`ownership` — role-based ownership plus the repository-wide
  ``.github/CODEOWNERS`` fallback, without inventing unconfirmed teams.
* :doc:`decisions/0001-module-boundaries` — package and deployable boundaries.
* :doc:`decisions/0002-node-workspace` — the final root-workspace outcome.
* :doc:`decisions/0003-route-openapi-ownership` — route and OpenAPI ownership.
* :doc:`decisions/0004-build-bootstrap-purity` — source-tree and bootstrap
  purity rules.
* :doc:`decisions/0005-platform-version-and-release-tags` — platform version
  projections, independent C++ versioning, and release tag namespaces.

Documentation split
-------------------

``doc/`` is the maintained project documentation tree: user guides,
maintainer notes, architecture, and API reference pages. ``docs/superpowers/
plans/`` contains execution plans and is intentionally protected from normal
implementation commits. ``docs/implementation/`` contains evidence and
implementation reports for completed work. A plan may point to an evidence
report, but a report must not silently rewrite a protected plan.

Boundary summary
----------------

The TypeScript dependency direction is::

    packages/licensing-domain <- packages/cloudflare-runtime <- services/*

Each service owns its routes, OpenAPI inventory/fragments, D1 migrations,
deployment configuration, and UI. Use the change guide before adding a new
cross-workspace import or public operation. Run the exact validation commands
listed in :doc:`change-guide` and in ``AGENTS.md`` from the repository root.
