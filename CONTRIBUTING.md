# Contributing to Licensecc

## Getting Help

Use [GitHub issues on this repository](https://github.com/lyehe/licensecc/issues) for questions, integration help, documentation gaps, reproducible bugs, and actionable feature requests. (The upstream `open-license-manager` discussions cover the original project, not this fork.)

## Reporting Bugs

Before opening a bug report, check whether the issue already exists. If an open issue already describes the problem, add your details there instead of opening a duplicate.

Good bug reports include:

- A clear title.
- Exact reproduction steps.
- The expected behavior and actual behavior.
- The operating system, compiler, CMake version, and whether you are cross-compiling.
- The CMake command or preset you used.
- Whether the application is running in a VM, container, or bare-metal environment.
- A minimal test case or example when possible.
- Crash logs, stack traces, or `open-license.log` output when relevant.

Before reporting a build issue, inspect the pinned generator checkout:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
```

## Suggesting Enhancements

Open an enhancement issue for feature requests that affect public APIs, license formats, build behavior, SDKs, services, or documented workflows. Larger design changes should include the problem being solved, expected users, compatibility impact, and validation approach.

## Code Contributions

For normal work on this public fork, target `main` unless an issue or maintainer says otherwise.

Before opening a pull request:

```powershell
npm ci
npm run check:pr
```

For service, SDK, database-backend, and portal changes, run the relevant local gates as well:

```powershell
npm run test:sdks
npm run setup:browsers
npm run test:e2e
npm run check:dry-run
npm run check:docs
```

The root `package.json` exposes the same service-oriented entry points:

```powershell
npm run test:services
npm run test:contracts
npm run check:architecture
```

For C++ changes, first inspect the pinned generator and then run the
non-mutating source-purity gate:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset dev-debug
```

If a platform cannot run the PowerShell wrapper, use the equivalent configure,
build, and test commands:

```console
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --preset dev-debug
```

Do not repair, reset, or patch the generator checkout from a build command. Use
`scripts/bootstrap.ps1` only for the explicit bootstrap action, after
preserving any local generator work; `-CheckOnly` is safe for inspection.

The tracked generator compatibility patch is transitional and must be removed only with its reviewed replacement generator revision and gitlink update.

Manual fallback without presets:

```console
cmake -S . -B build/dev-debug -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=test -DCMAKE_INSTALL_PREFIX=build/dev-debug/install
cmake --build build/dev-debug
ctest --test-dir build/dev-debug --output-on-failure
```

## Repository Hygiene

Do not commit generated files or local-only state:

- `build/`
- `install/`
- `.venv/`
- `.wrangler/`
- `dist/`
- `dist-worker/`
- `node_modules/`
- local Wrangler configs such as `services/**/wrangler.toml` and `services/**/wrangler.jsonc`
- service secrets such as `.dev.vars` and `.online-key/`
- `doc/_build/`
- `doc/_doxygen/`
- Python `__pycache__` and `*.pyc`
- .NET `bin/` and `obj/`

Track Wrangler example templates such as `wrangler.example.toml` and `wrangler.example.jsonc`; keep real deployment IDs and secrets local.

The current `main` branch now includes the C++ core plus service, SDK, database-backend, and portal slices. Changes to those areas should keep their local gates green and update docs when commands, workflows, public APIs, or support status change.

Use [`doc/architecture/change-guide.md`](doc/architecture/change-guide.md) to
route API, Worker, D1, policy, UI, SDK, and OpenAPI changes. Read
[`doc/architecture/ownership.md`](doc/architecture/ownership.md) before
crossing a deployable boundary. The documentation split is deliberate:
maintained project docs live under `doc/`, protected execution plans under
`docs/superpowers/plans/`, and evidence reports under `docs/implementation/`.

## Coding Guidelines

- Keep patches focused and avoid unrelated formatting churn.
- Use the repository `.clang-format` style for C++ changes.
- Add or update tests for behavior changes.
- Prefer source-tree-clean build behavior; generated license project files should live under the build tree by default.
- Do not change public API, license-file format, or generated token format without documenting compatibility impact.

## Pull Request Checklist

- The PR explains what changed and why.
- Related issues are linked.
- Local verification commands are listed.
- Generated output is not committed.
- New or changed behavior has tests.
- Documentation is updated when commands, workflows, public behavior, or support status changes.
