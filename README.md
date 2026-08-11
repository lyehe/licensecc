# Licensecc

*Copy protection, licensing library, and license generator integration for Windows and Linux.*

[![Standard](https://img.shields.io/badge/c%2B%2B-17-blue.svg)](https://en.wikipedia.org/wiki/C%2B%2B#Standardization)
[![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![Linux_CI](https://github.com/lyehe/licensecc/actions/workflows/linux.yml/badge.svg)](https://github.com/lyehe/licensecc/actions/workflows/linux.yml)
[![Github_CI](https://github.com/lyehe/licensecc/actions/workflows/windows.yml/badge.svg)](https://github.com/lyehe/licensecc/actions/workflows/windows.yml)

Licensecc helps applications verify local license files, bind licenses to machine identifiers, and enforce execution limits such as expiration dates and licensed features. The current `main` branch includes the C++ core library, inspector, examples, documentation, tests, service packages, SDKs, and build tooling.

The repository is licensed under the [GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0.html). See [LICENSE](LICENSE) for the full license text.

**Versioning:** no namespaced release has been tagged yet. The C++ library carries the upstream 2.x
lineage version (`2.1.0` in CMake); the platform packages (services, SDKs, and root/workspace Node
packages) are `0.1.0-rc.1` and versioned independently. [`version.json`](version.json) is the
machine-readable platform source, and `npm run check:versions` verifies every projection. Platform
tags use `platform-v*`; future independent C++ tags use `cpp-v*`; new bare `v*` tags are forbidden.
See [CHANGELOG.md](CHANGELOG.md) and
[ADR 0005](doc/architecture/decisions/0005-platform-version-and-release-tags.md).

## Repository Map

- `src/`: C++ implementation.
- `include/`: public C API headers.
- `test/`: C++ unit and functional tests.
- `examples/`: minimal integration examples.
- `cmake/`: CMake find modules and build helpers.
- `extern/`: repository-owned, vendored license-generator source; `scripts/bootstrap.ps1` validates that the source is present without fetching it.
- `doc/`: documentation source and architecture notes.
- `doc/architecture/`: system map, change guide, role ownership, and architecture decisions.
- `docs/implementation/`: implementation evidence reports; `docs/superpowers/plans/` contains protected execution plans.
- `scripts/`: local developer helper scripts.
- `patches/`: reviewed transition patches; build and check commands never apply them to vendored source.
- `package.json`: root orchestration scripts for service, SDK, schema, and E2E checks.
- `packages/licensing-domain/`: portable licensing values, policy transitions, contracts, and pure projections.
- `packages/cloudflare-runtime/`: shared Cloudflare/Web-platform mechanics used by multiple deployables.
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
- Git for clone and source history operations.
- PowerShell 7 (`pwsh`) on any platform for bootstrap, build-purity checks, `scripts/dev-check.ps1`, and the root npm shortcuts (CI uses the same binary; Windows PowerShell 5.1 is not targeted).
- Linux: OpenSSL, Zlib where required by the OpenSSL version, and Boost development packages for the bundled generator/tests.
- Windows: Visual Studio 2022 or another supported C++ toolchain. Boost is required for tests and for building the bundled license generator during configuration. If Boost is not in a default CMake search path, set `BOOST_ROOT` to the Boost install directory.

Boost is not linked into the final `licensecc` runtime library.

## Clone

```console
git clone https://github.com/lyehe/licensecc.git
cd licensecc
```

The generator source is already part of the clone. Validate that vendored
source before a native build:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
```

## Recommended local checks

With PowerShell 7 (`pwsh`) and the pinned npm `10.9.8`, inspect bootstrap state,
install the root workspace, and run the deterministic pull-request gate:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
npm ci
npm run check:pr
```

For C++ changes, also run the source-purity gate (it configures, builds, and
tests the selected preset without mutating source or the generator checkout):

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset dev-debug
```

The root command surface is intentionally explicit:

| Command | Scope |
| --- | --- |
| `npm run scan:secrets` | Committed-secret and token-guard scan. |
| `npm run lint` | Source lint for packages, services, and scripts. |
| `npm run typecheck` | Production TypeScript/JavaScript type-check coverage. |
| `npm run check:architecture` | Dependency direction, composition roots, and repository hygiene. |
| `npm run check:versions` | Platform/C++ version contract and release-projection consistency. |
| `npm run test:contracts` | Canonical route/OpenAPI contract checks. |
| `npm run test:services` | Package, Worker, SQL, UI workflow, and schema-parity tests. |
| `npm run test:sdks` | Python and .NET SDK tests. |
| `npm run setup:browsers` | One explicit setup command installing both retained Playwright Chromium revisions. |
| `npm run test:e2e` | Browser and cross-service smoke tests; no install side effect. |
| `npm run check:dry-run` | Credential-free Wrangler bundle/deploy dry-runs. |
| `npm run check:docs` | Strict Doxygen then Sphinx build under ignored `doc/_build/`. |
| `npm run check:docs:links` | Network-sensitive Sphinx link check for scheduled/manual use. |
| `npm run check:pr` | Deterministic scan, lint, type, architecture, contract, and service gate. |

SDK, browser, docs, dry-run, and native CMake matrix checks are dedicated
commands rather than hidden side effects of `check:pr`. See
[`doc/architecture/change-guide.md`](doc/architecture/change-guide.md) for
the smallest correct change surface and exact focused checks.

## Manual Build

Using presets:

```console
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --preset dev-debug
```

Manual fallback without presets:

```console
cmake -S . -B build/dev-debug -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=test -DCMAKE_INSTALL_PREFIX=build/dev-debug/install
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

Override `LCC_PROJECTS_BASE_DIR` only when you intentionally need a stable external project directory. It may be outside the checkout or inside the active binary tree; source-tree paths outside that binary tree are rejected.

```console
cmake -S . -B build/custom -DLCC_PROJECT_NAME=my-product -DLCC_PROJECTS_BASE_DIR=/path/to/projects
```

## Usage

A minimal, self-contained integration example lives in [`examples/minimal`](examples/minimal). It acquires a license and reports failures with `lcc_strerror` and `print_error`.

For issuing licenses, see [`doc/usage/issue-licenses.md`](doc/usage/issue-licenses.md). Local license files are issued with `lccgen`; online node-locked, floating, trial, and tiered entitlements are configured through the backend/admin policy flow documented in [`services/cloudflare-license-admin/README.md`](services/cloudflare-license-admin/README.md).

## Contributing

Use the current active branch policy for this repository. For normal work on this public fork, open pull requests against `main` unless an issue or maintainer says otherwise.

Before opening a pull request:

```powershell
npm run check:pr
```

Do not commit generated outputs such as `build/`, `install/`, `.wrangler/`, `dist/`, `node_modules/`, `doc/_doxygen/`, Python caches, or .NET `bin/obj` directories. Create local Python environments as `.venv/`; the legacy root `pyvenv.cfg` marker is ignored.
Do not commit local Wrangler configs or secrets such as `services/**/wrangler.toml`, `services/**/wrangler.jsonc`, `.dev.vars`, or `.online-key/`; track only the `wrangler.example.*` templates.

See [CONTRIBUTING.md](CONTRIBUTING.md) for reporting and contribution guidelines.
