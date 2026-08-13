# Repository scripts

The root command surface in `package.json` is the public entry point for normal
development and CI. Files in this directory implement those commands; callers
should not depend on an internal module merely because it is executable.

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
