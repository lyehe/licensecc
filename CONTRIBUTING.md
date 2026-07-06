# Contributing to Licensecc

## Getting Help

Use [GitHub Discussions](https://github.com/open-license-manager/licensecc/discussions) for questions, integration help, and documentation gaps. Use GitHub issues for reproducible bugs and actionable feature requests.

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

Before reporting a build issue, update your checkout and submodules:

```console
git pull
git submodule update --init --recursive
```

## Suggesting Enhancements

Open an enhancement issue for feature requests that affect public APIs, license formats, build behavior, SDKs, services, or documented workflows. Larger design changes should include the problem being solved, expected users, compatibility impact, and validation approach.

## Code Contributions

For normal work on this public fork, target `main` unless an issue or maintainer says otherwise.

Before opening a pull request:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1
```

For service, SDK, database-backend, and portal changes, run the relevant local gates as well:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeServices -IncludeUi -IncludeSchemaParity
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeE2E
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeSdks
```

The root `package.json` exposes the same service-oriented entry points:

```powershell
npm run check:services
npm run check:e2e
npm run lint:services
```

If you cannot run that script on your platform, run the equivalent commands:

```console
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --preset dev-debug
```

Manual fallback without presets:

```console
cmake -S . -B build/dev-debug -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=test
cmake --build build/dev-debug
ctest --test-dir build/dev-debug --output-on-failure
```

## Repository Hygiene

Do not commit generated files or local-only state:

- `build/`
- `install/`
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
