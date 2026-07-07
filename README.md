# Licensecc

*Copy protection, licensing library, and license generator integration for Windows and Linux.*

[![Standard](https://img.shields.io/badge/c%2B%2B-17-blue.svg)](https://en.wikipedia.org/wiki/C%2B%2B#Standardization)
[![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![Linux_CI](https://github.com/lyehe/licensecc/actions/workflows/linux.yml/badge.svg)](https://github.com/lyehe/licensecc/actions/workflows/linux.yml)
[![Github_CI](https://github.com/lyehe/licensecc/actions/workflows/windows.yml/badge.svg)](https://github.com/lyehe/licensecc/actions/workflows/windows.yml)

Licensecc helps applications verify local license files, bind licenses to machine identifiers, and enforce execution limits such as expiration dates and licensed features. The current `main` branch includes the C++ core library, inspector, examples, documentation, tests, service packages, SDKs, and build tooling.

The repository is licensed under the [GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0.html). See [LICENSE](LICENSE) for the full license text.

## Repository Map

- `src/`: C++ implementation.
- `include/`: public C API headers.
- `test/`: C++ unit and functional tests.
- `examples/`: minimal integration examples.
- `cmake/`: CMake find modules and build helpers.
- `extern/`: vendored license generator submodule used during configuration.
- `doc/`: documentation source and architecture notes.
- `scripts/`: local developer helper scripts.
- `patches/`: patches applied to vendored dependencies in CI and local checks.
- `package.json`: root orchestration scripts for service, SDK, schema, and E2E checks.
- `services/cloudflare-licensing-backend/`: licensing backend service, local SQLite adapter, D1 migrations, and fenced PostgreSQL/Supabase adapter.
- `services/cloudflare-license-admin/`: operator console Worker and React UI.
- `services/cloudflare-customer-portal/`: customer portal Worker and React UI.
- `services/cloudflare-d1-backup/`: D1 backup and restore-drill Worker.
- `sdks/python/`: Python SDK for token verification and backend HTTP calls.
- `sdks/dotnet/`: .NET SDK for token verification and backend HTTP calls.

Generated project material is written under the CMake build tree by default, not into the source checkout.

## Prerequisites

- CMake 3.16 or newer for manual builds.
- CMake 3.21 or newer for `CMakePresets.json`.
- A C++17 compiler.
- Git with submodule support.
- Linux: OpenSSL, Zlib where required by the OpenSSL version, and Boost development packages for the bundled generator/tests.
- Windows: Visual Studio 2022 or another supported C++ toolchain. Boost is required for tests and for building the bundled license generator during configuration. If Boost is not in a default CMake search path, set `BOOST_ROOT` to the Boost install directory.

Boost is not linked into the final `licensecc` runtime library.

## Clone

```console
git clone --recursive https://github.com/lyehe/licensecc.git
cd licensecc
```

If the repository was cloned without submodules:

```console
git submodule update --init --recursive
```

## Recommended Local Check

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1
```

That script applies the vendored generator patch temporarily if needed, configures the `dev-debug` preset, builds it, runs CTest, and warns if untracked service/SDK work is present.

The default check expects `extern/license-generator` to match the pinned submodule commit. If you are intentionally testing generator changes, preserve that work and run with `-AllowDirtyGeneratorSubmodule`.

Useful variants:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -Preset dev-release
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -Preset ci-windows-msvc
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -Preset ci-windows-msvc-release-static
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -Preset ci-linux-release
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipTests
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeServices -IncludeUi -IncludeSchemaParity
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -AllowDirtyGeneratorSubmodule
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeBackend
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeServices
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeUi
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeE2E
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeSchemaParity
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeDryRun
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -IncludeSdks
```

`-IncludeBackend` runs backend lint, the unit suite, SQL/migration suite, and fenced PostgreSQL adapter tests after the core C++ checks.
`-IncludeServices` runs lint and unit/API tests for the backend, admin portal, customer portal, and D1 backup service.
`-IncludeUi` adds Vite UI workflow tests for the admin and customer portals.
`-IncludeE2E` adds the backend flow tests and Playwright browser suites.
`-IncludeSchemaParity` runs D1 schema and PostgreSQL schema parity checks.
`-IncludeDryRun` runs each service deployment dry-run against tracked example Wrangler configs.
`-IncludeSdks` runs the Python and .NET SDK test suites after the core C++ checks.

Equivalent root npm shortcuts are available for common service runs:

```powershell
npm run check:core
npm run check:services
npm run check:e2e
npm run check:all
```

The checked-in GitHub Actions workflows are intentionally core-focused: Linux
and Windows CMake matrices plus pull-request C/C++ formatting. Service, SDK,
UI, E2E, schema-parity, and dry-run validation is reproducible through the
local commands above and the root npm shortcuts; add remote workflow coverage
only after the matching local command exists and is documented.

## Manual Build

Using presets:

```console
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --preset dev-debug
```

Manual fallback without presets:

```console
cmake -S . -B build/dev-debug -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=test -DCMAKE_INSTALL_PREFIX=install/dev-debug
cmake --build build/dev-debug
ctest --test-dir build/dev-debug --output-on-failure
```

Windows MSVC CI-style configure:

```console
cmake --preset ci-windows-msvc
cmake --build --preset ci-windows-msvc
ctest --preset ci-windows-msvc
```

The Windows workflow matrix also has explicit `ci-windows-msvc-debug-dynamic`, `ci-windows-msvc-debug-static`, `ci-windows-msvc-release-dynamic`, and `ci-windows-msvc-release-static` presets.

Linux CI-style configure:

```console
cmake --preset ci-linux-core
cmake --build --preset ci-linux-core
ctest --preset ci-linux-core
```

The Linux workflow matrix uses `ci-linux-debug` and `ci-linux-release`; `ci-linux-core` remains a debug compatibility alias.

## Generated License Project Files

By default, generated license project files are placed under:

```text
build/<preset>/projects/<project-name>
```

Override `LCC_PROJECTS_BASE_DIR` only when you intentionally need a stable external project directory:

```console
cmake -S . -B build/custom -DLCC_PROJECT_NAME=my-product -DLCC_PROJECTS_BASE_DIR=/path/to/projects
```

## Usage

A minimal, self-contained integration example lives in [`examples/minimal`](examples/minimal). It acquires a license and reports failures with `lcc_strerror` and `print_error`.

For issuing licenses, see [`doc/usage/issue-licenses.md`](doc/usage/issue-licenses.md). Local license files are issued with `lcc`; online node-locked, floating, trial, and tiered entitlements are configured through the backend/admin policy flow documented in [`services/cloudflare-license-admin/README.md`](services/cloudflare-license-admin/README.md).

## Contributing

Use the current active branch policy for this repository. For normal work on this public fork, open pull requests against `main` unless an issue or maintainer says otherwise.

Before opening a pull request:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1
```

Do not commit generated outputs such as `build/`, `install/`, `.wrangler/`, `dist/`, `node_modules/`, `doc/_doxygen/`, Python caches, or .NET `bin/obj` directories.
Do not commit local Wrangler configs or secrets such as `services/**/wrangler.toml`, `services/**/wrangler.jsonc`, `.dev.vars`, or `.online-key/`; track only the `wrangler.example.*` templates.

See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting and contribution guidelines.
