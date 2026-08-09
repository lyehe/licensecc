# Repository agent guidance

Before editing, read the applicable rules in
[`doc/architecture/index.rst`](doc/architecture/index.rst), especially the
[change guide](doc/architecture/change-guide.md),
[ownership map](doc/architecture/ownership.md), and ADRs. Keep changes inside
the owning boundary and do not duplicate those documents here.

Preserve concurrent work in every checkout. Dirty submodules and untracked
plans or evidence are user-owned when present: classify them, preserve them,
and never reset, clean, stage, patch, or otherwise mutate them without clear
ownership. Do not commit generated trees, local Wrangler configuration,
secrets, or build output.

From a clean or intentionally classified worktree, the deterministic PR gate
is:

```powershell
npm ci
npm run check:pr
```

Use the dedicated commands for additional surfaces:
`npm run test:sdks`, `npm run setup:browsers` (one explicit command installing
both retained Playwright Chromium revisions), `npm run test:e2e`,
`npm run check:dry-run`, and `npm run check:docs`. The docs gate requires
Doxygen; use `npm run check:docs:links` only for scheduled/manual network
validation. Core changes also require
`pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`.

The documentation split is deliberate: `doc/` contains maintained project and
architecture documentation; `docs/superpowers/plans/` contains protected
execution plans; `docs/implementation/` contains evidence reports.
