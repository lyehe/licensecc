# Repository scripts

The root command surface in `package.json` is the public entry point for normal
development and CI. Files in this directory implement those commands; callers
should not depend on an internal module merely because it is executable.

## Validation profiles

| Command | Exact scope | Intentionally separate |
| --- | --- | --- |
| `npm run check:pr` | Deterministic secret, repository, version, capability, lint, type, architecture, contract, and service checks used by pull requests. | SDKs, Worker dry-runs, rendered docs, browsers/E2E, native build purity, network links, staging, and production evidence. |
| `npm run check:review` | `check:pr`, `test:sdks`, `check:dry-run`, and `check:docs`. | Browser setup/E2E, native build purity, the offline docs quickstart, network link validation, staging, and production evidence. |
| `npm run check:all` | Deprecated compatibility alias for `check:review`; retained so existing callers keep the same behavior. | The same surfaces excluded from `check:review`; “all” is not a literal completeness claim. |
| `npm run test:docs-quickstart` | Disposable offline native integration journey: configure/build/install Licensecc, issue a local license, build `examples/minimal` against the install, and require `license OK`. | Cloudflare services, network access, browser/E2E, and production deployment. |

Run the dedicated command for every excluded surface affected by a change.
Report the verified commit/ref, exact commands and outcomes, and relevant
commands not run as described in `CONTRIBUTING.md`; do not summarize a subset as
bare “all green.”

`test:docs-quickstart` owns a uniquely generated workspace below
`build/docs-quickstart`. The runner snapshots source git status and fingerprints
before and after execution, refuses source-tree project/license paths, and
removes only a workspace carrying its matching ownership marker. It is a
deliberately separate gate from `check:docs` because it validates an installed
native consumer rather than the rendered documentation build.

`script-catalog.json` assigns every tracked path to exactly one category:

- `architecture-contracts`: dependency, API, documentation-evidence, capability,
  ownership, and hotspot contracts;
- `build-development`: bootstrap, type checking, native build purity, SDK, and
  local test helpers;
- `release-deployment`: version, packaging, deployment-config, and canonical
  artifact assembly contracts;
- `security-workflow`: secret, Wrangler, and GitHub Actions policy checks;
- `repository-hygiene`: the script inventory and non-destructive local doctor.

Stable root script paths are intentional because package scripts, workflows,
documentation, and operator runbooks call them directly. New internal helpers
belong in a category-specific subdirectory when there is a real module boundary;
do not move stable commands solely to make the directory look shallower.

Run `npm run check:scripts` after adding, deleting, or moving a script. Run
`npm run doctor` for advisory local branch, worktree, remote, output, and
toolchain diagnostics; use `npm run doctor -- --strict-local` when preparing a
fully clean local handoff.
