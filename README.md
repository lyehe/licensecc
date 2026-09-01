# Licensecc

*Copy protection, offline licensing, and online entitlement services for Windows and Linux.*

[![Standard](https://img.shields.io/badge/c%2B%2B-17-blue.svg)](https://en.wikipedia.org/wiki/C%2B%2B#Standardization)
[![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![Linux_CI](https://github.com/lyehe/licensecc/actions/workflows/linux.yml/badge.svg)](https://github.com/lyehe/licensecc/actions/workflows/linux.yml)
[![Github_CI](https://github.com/lyehe/licensecc/actions/workflows/windows.yml/badge.svg)](https://github.com/lyehe/licensecc/actions/workflows/windows.yml)

Licensecc lets a native application verify signed local license files, bind a
license to machine identifiers, and enforce expiration dates or licensed
features. The repository also includes an optional online verifier, operator
and customer services, and Python, .NET, and Java client SDKs.

The repository is licensed under the [GNU Affero General Public License v3.0
or later](LICENSE). Review the license, including its network-use obligations,
before integrating Licensecc into proprietary or closed-source software.

**Maintained documentation source:** [documentation home](doc/index.rst) ·
[capability status](doc/capabilities/index.rst) ·
[API reference](doc/api/index.rst)

## Choose your path

| You want to... | Start here | What you need |
| --- | --- | --- |
| Add offline licensing to a C/C++ application | [First successful license check](#first-successful-license-check) | CMake, a C++17 compiler, and Boost |
| Evaluate online verification without deploying | [Local online evaluation](doc/tutorials/local-online-evaluation.rst) | Node 22.5+ and the root npm workspace |
| Verify server tokens from Python, .NET, or Java | [SDK and support entry points](doc/tutorials/sdk-and-support.rst) | Only the selected language toolchain |
| Diagnose a customer machine or license | [SDK and support entry points](doc/tutorials/sdk-and-support.rst#support-with-lccinspector) | An installed native build |
| Operate the hosted platform | [Production readiness](doc/operations/production-readiness.md) | Cloudflare resources and explicit operator authority |
| Contribute code or documentation | [Repository workflows](doc/usage/repository-workflows.rst) | The contributor toolchain below |
| Give a coding agent a bounded task | [`$using-licensecc`](.agents/skills/using-licensecc/SKILL.md) and [repository workflows](doc/usage/repository-workflows.rst) | The checkout and its owning documentation |

The [examples catalog](doc/usage/examples.rst) routes native integrations from
the minimal host through fail-closed, online, anti-tamper, and device-identity
examples.

## First successful license check

This path builds the native runtime for the sample project name `test`, issues
a local license with that project's private key, builds the standalone minimal
consumer, and verifies the license. It does **not** require Node, Python, Java,
Cloudflare credentials, or a deployment.

Prerequisites for this path:

- Git, CMake 3.21 or newer, a C++17 compiler, and Boost development libraries.
- On Linux, OpenSSL development headers and Zlib where required by the installed
  OpenSSL version.
- On Windows, the copyable sequence below uses Visual Studio 2022 x64. Other
  supported C++ toolchains can build Licensecc, but their generator-specific
  executable paths differ. Set `BOOST_ROOT` when Boost is not in CMake's
  default search path.

From a terminal, clone the repository and make it the current directory:

```console
git clone https://github.com/lyehe/licensecc.git
cd licensecc
```

The clone already contains the reviewed license-generator source. Generated
keys and install artifacts stay under `build/dev-debug/`.

On Windows, continue in PowerShell from the repository root:

```powershell
$repo = (Resolve-Path ".").Path
$project = "$repo/build/dev-debug/projects/test"
$lccgen = "$repo/build/dev-debug/extern/license-generator/src/license_generator/Debug/lccgen.exe"

cmake --preset dev-debug -G "Visual Studio 17 2022" -A x64
cmake --build --preset dev-debug --target install
& $lccgen license issue -p $project -o "$project/licenses/quickstart.lic"
cmake -S examples/minimal -B build/minimal -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_PREFIX_PATH=$repo/build/dev-debug/install" `
  "-Dlicensecc_DIR=$repo/build/dev-debug/install/cmake/licensecc" `
  -DLCC_PROJECT_NAME=test
cmake --build build/minimal --config Debug
& "$repo/build/minimal/Debug/minimal.exe" "$project/licenses/quickstart.lic"
```

On Linux, continue in Bash from the repository root:

```bash
repo="$PWD"
project="$repo/build/dev-debug/projects/test"
lccgen="$repo/build/dev-debug/extern/license-generator/src/license_generator/lccgen"

cmake --preset dev-debug
cmake --build --preset dev-debug --target install
"$lccgen" license issue -p "$project" -o "$project/licenses/quickstart.lic"
cmake -S examples/minimal -B build/minimal \
  -DCMAKE_PREFIX_PATH="$repo/build/dev-debug/install" \
  -Dlicensecc_DIR="$repo/build/dev-debug/install/lib/cmake/licensecc" \
  -DLCC_PROJECT_NAME=test
cmake --build build/minimal
"$repo/build/minimal/minimal" "$project/licenses/quickstart.lic"
```

The final command should print:

```text
license OK (days left: ...)
```

The generated `private_key.rsa` can issue licenses accepted by this build.
Keep it out of applications and release artifacts. The
[offline tutorial](doc/tutorials/offline-first-license.rst) explains the files,
failure signals, and next integration steps.

## Product surfaces and maturity

| Surface | Purpose | Status source |
| --- | --- | --- |
| `licensecc` and `lccinspector` | Native enforcement, machine identity, and support diagnostics | [Capability registry](doc/capabilities/index.rst) |
| `lccgen` | Project initialization and signed local-license issuance | [License issuance](doc/usage/issue-licenses.md) |
| `services/` | Online verification, administration, customer self-service, and backup | [Operations](doc/operations/index.rst) |
| `sdks/` | Signed-token verification and selected backend HTTP calls | [SDK reference](doc/api/sdks.rst) |

**Versioning:** no namespaced release has been tagged yet. The C++ library
carries the upstream 2.x lineage (`2.1.0` in CMake); platform services, SDKs,
and Node packages are `0.1.0-rc.2` and versioned independently.
[`version.json`](version.json) is the platform version authority. Platform tags
use `platform-v*`, future independent C++ tags use `cpp-v*`, and new bare `v*`
tags are forbidden. See [CHANGELOG.md](CHANGELOG.md) and
[ADR 0005](doc/architecture/decisions/0005-platform-version-and-release-tags.md).

## Contributor setup and verification

The first-success path above does not require the full monorepo toolchain.
Contributors need only the tools used by the surface they change:

- PowerShell 7 (`pwsh`) for repository orchestration and purity checks.
- Node 22+ with npm `10.9.8` for the root workspace and service checks.
- Python 3.12 with uv 0.12.5 for repository and Python SDK checks.
- JDK 17.0.20 for the Java SDK and deterministic release-artifact checks.
- Doxygen for the strict documentation build.

Node dependencies have one owner: run `npm ci` at the repository root. Do not
run service-local installs or create service-local lockfiles.

```powershell
pwsh -NoProfile -File scripts/bootstrap.ps1 -CheckOnly
npm ci
npm run doctor
npm run check:pr
```

`npm run doctor` is read-only. The normal pull-request gate is deterministic;
add the gate for each changed surface:

| Changed surface | Additional gate |
| --- | --- |
| C/C++ core | `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` |
| SDKs | `npm run test:sdks` |
| Browser workflows | `npm run setup:browsers`, then `npm run test:e2e` |
| Worker packaging | `npm run check:dry-run` |
| Documentation | `npm run check:docs` |
| Native install, issuance, or `examples/minimal` documentation | `npm run test:docs-quickstart` |
| External links | `npm run check:docs:links` (scheduled/manual and network-sensitive) |

The [architecture change guide](doc/architecture/change-guide.md) identifies
the owning boundary and narrow checks. [`scripts/README.md`](scripts/README.md)
documents the stable script surface. A deployment, publication, tag, or remote
mutation always requires separate operator authority.

## Repository map

- `include/licensecc/`, `src/library/`, `cmake/`, and `test/`: native public
  API, implementation, packaging, and tests.
- `extern/license-generator/`: repository-owned vendored generator source;
  builds validate it without fetching or patching it.
- `examples/`: maintained standalone native integrations.
- `packages/`: shared licensing-domain and Cloudflare-runtime packages.
- `services/`: four independently deployable Workers and their local runbooks.
- `sdks/`: Python, .NET, and Java client packages.
- `doc/`: maintained project, API, operations, and architecture documentation.
- `.agents/skills/`: repository-local Agent Skills that route work through the
  same human-readable authorities.
- `docs/implementation/`: implementation evidence. Protected execution plans
  remain under `docs/superpowers/plans/`.

Generated builds, project keys, local databases, Wrangler configuration,
secrets, and documentation output are local artifacts and must not be
committed.

## Contributing

Open pull requests against `main` unless an issue or maintainer says otherwise.
Read [CONTRIBUTING.md](CONTRIBUTING.md), classify existing worktree changes,
keep changes inside the owning boundary, and report the exact checks run rather
than only saying that CI is green.
