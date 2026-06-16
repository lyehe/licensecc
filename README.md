# Licensecc

*Copy protection, licensing library and license generator for Windows and Linux.*

[![Standard](https://img.shields.io/badge/c%2B%2B-17-blue.svg)](https://en.wikipedia.org/wiki/C%2B%2B#Standardization)
[![unstable](http://badges.github.io/stability-badges/dist/unstable.svg)](http://github.com/badges/stability-badges)
[![License](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![travis](https://travis-ci.org/open-license-manager/licensecc.svg?branch=develop)](https://travis-ci.org/open-license-manager/licensecc)
[![Github_CI](https://github.com/open-license-manager/licensecc/workflows/Github_CI/badge.svg)](https://github.com/open-license-manager/licensecc/actions)
[![Codacy Badge](https://app.codacy.com/project/badge/Grade/81a1f6bc15014618934fc5fab4d3c206)](https://www.codacy.com/gh/open-license-manager/licensecc/dashboard?utm_source=github.com&amp;utm_medium=referral&amp;utm_content=open-license-manager/licensecc&amp;utm_campaign=Badge_Grade)
[![codecov](https://codecov.io/gh/open-license-manager/licensecc/branch/develop/graph/badge.svg?token=vdrBBzX6Rl)](https://codecov.io/gh/open-license-manager/licensecc)
[![Github Issues](https://img.shields.io/github/issues/open-license-manager/licensecc)](http://github.com/open-license-manager/licensecc/issues)

Licensecc verifies signed local license files, supports time and hardware
limits, and reports deterministic diagnostics when license data, project
metadata, or hardware bindings do not match. It is an offline licensing library,
not a tamper-proof enforcement system; a customer-controlled machine can still
patch binaries, replace libraries, or hook local API results.

A comprehensive [list of features](http://open-license-manager.github.io/licensecc/analysis/features.html), and their status is available in the project site. 

If you're experiencing problems, or you just need informations you can't find in the [documentation](http://open-license-manager.github.io/licensecc)  please contact us on [github discussions](https://github.com/open-license-manager/licensecc/discussions), we'll be happy to help. 

Remember to show your appreciation giving us a <a class="github-button" href="https://github.com/open-license-manager/licensecc" data-icon="octicon-star" aria-label="Star open-license-manager/licensecc on GitHub">star</a> here on GitHub.

## License
The project is donated to the community. It comes with freedom of use for everyone, and it always will be. 
It has a [BSD 3 clauses](https://opensource.org/licenses/BSD-3-Clause) licensing schema, that allows free modification and use in commercial software. 

## Project Structure
The software is made by 4 main sub-components:
-   a C++ library, `licensecc`, with C-linkage public functions for C++ consumers or project-owned wrappers and minimal (or no) external runtime dependencies. This is the part you integrate in your software.
-   a license debugger `lcc-inspector` to be sent to the final customer when there are licensing problems or for calculating the pc hash before issuing the license.
-   a license generator (github project [lcc-license-generator](https://github.com/open-license-manager/lcc-license-generator)) `lccgen` for customizing the library and generate the licenses.
-   Usage [examples](https://github.com/open-license-manager/examples) to simplify the integration in your project.
 
## How to build
Below an overview of the basic build procedure, you can find detailed instructions for [Linux](http://open-license-manager.github.io/licensecc/development/Build-the-library.html) 
or [Windows](http://open-license-manager.github.io/licensecc/development/Build-the-library-windows.html) in the project web site. 

### Prerequisites
-   Operating system: Linux(Ubuntu, CentOS), Windows
-   compilers       : GCC (Linux), MSVC (Windows). MinGW and Linux-to-Windows cross-compilation are legacy/development flows and are not release-validated until a dedicated CI gate is added.
-   tools           : cmake(>=3.16), git, make/ninja(linux)
-   libs            : Linux requires OpenSSL; Windows depends only on system libraries. Boost is required to **build** the project (it is used by the bundled license generator, which is built during configuration, and by the tests). It is **not linked** into the final `licensecc` library, so your application does not need Boost at runtime.

For a complete list of dependencies and supported environments see [the project website](http://open-license-manager.github.io/licensecc/development/Dependencies.html)

Clone the project. It has submodules, don't forget the `--recursive` option.

```console
git clone --recursive https://github.com/open-license-manager/licensecc.git
cd licensecc
```

Release builds should use a project name for your product and an
issuer-controlled project directory. The automatically created `DEFAULT`
project is for local tests only.

### build on Linux

```console
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DLCC_PROJECT_NAME=MY_PRODUCT -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects -DCMAKE_INSTALL_PREFIX=$PWD/install
cmake --build build --target install -j$(nproc)
```

### build on Windows (with MSVC 2022)

```console
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 -DBOOST_ROOT="{Folder where boost is}" -DLCC_PROJECT_NAME=MY_PRODUCT -DLCC_PROJECTS_BASE_DIR=C:/secure/licensecc-projects -DCMAKE_INSTALL_PREFIX=C:/licensecc/MY_PRODUCT
cmake --build build --target install --config Release
```

### cross compile with MINGW on Linux

This is legacy development guidance, not a release-validated packaging path in
the current CI matrix. Use the native Linux and MSVC Windows gates for release
validation until a MinGW gate is added.

```console
x86_64-w64-mingw32.static-cmake -S . -B build-mingw -DLCC_PROJECT_NAME=MY_PRODUCT -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects -DCMAKE_INSTALL_PREFIX=$PWD/install-mingw
cmake --build build-mingw --target install
```

## How to test

### on Linux

```console
make test
```

### on Windows (MSVC)

```console
ctest -C Release
```

### documentation

Local documentation builds use `uv`/`uvx` for Python tooling and require
Doxygen for C++ API XML. `scripts/build_docs.py` finds Doxygen on `PATH`,
from the `DOXYGEN` environment variable, or under `build/tools/doxygen*/`:

```console
uv run --no-project python scripts/check_docs_links.py doc
uv run --no-project python scripts/build_docs.py
```

The helper runs Doxygen first, then runs Sphinx through `uvx` using the pinned
packages in `requirements.txt`.

## How to use

A minimal, self-contained integration example lives in [`examples/minimal`](examples/minimal): acquire a license and report failures with `lcc_strerror`/`print_error`.
The [examples](https://github.com/open-license-manager/examples) repository shows more ways to integrate `licensecc` into your project.

For production C++ applications, the supported integration mode is to build and
install Licensecc for one named project, then consume that install with CMake
`find_package(licensecc REQUIRED COMPONENTS <project>)` and link
`licensecc::licensecc_static`. Do not rely on source-tree include directories,
hand-copied static-library paths, or generated headers from another project;
those modes are unsupported unless they have their own smoke tests.

The public functions use C linkage, but the distributed runtime target is a C++
static library and the installed package is validated with C++ consumers. Pure
C hosts should use a build rule that links through the C++ linker or a
project-owned wrapper with its own installed-prefix smoke test.

Host applications should fail closed: grant access only when `acquire_license()`,
`acquire_license_ex()`, or `lcc_acquire_license_decision()` returns
`LICENSE_OK`. Treat every other return value as not licensed, then use
`print_error()` or `lcc_strerror()` only to report diagnostics. For products
with multiple licensed capabilities, pass the feature name in
`CallerInformations.feature_name`; for licenses with `start-version` or
`end-version`, pass the running application version in
`CallerInformations.version`. If your build uses a nonzero
`LCC_PROJECT_MAGIC_NUM`, initialize `CallerInformations.magic` from the
generated constant before checking a license.

Use `acquire_license_ex()` when you want per-call runtime tamper diagnostics.
`lcc_init_license_check_options()` defaults to enforcement and strict
source-shadowing: tamper signals deny an otherwise valid license instead of
quietly allowing access. Set `LCC_TAMPER_DISABLED` only for compatibility tests.

`acquire_license_ex()` also supports opt-in online verification through a host
callback. Licensecc core stays HTTP-free: your application sends the generated
`LccOnlineRequest` to your service and returns the signed assertion to the
library. A reference low-volume Cloudflare Worker lives in
[`services/cloudflare-licensing-backend`](services/cloudflare-licensing-backend).
When `online_check` is supplied, online verification is required and failures
deny the check. Production online builds should configure
`LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` with a dedicated online assertion
public key; otherwise online assertion verification fails closed.

For production online integrations, prefer `lcc_acquire_license_decision()`.
It keeps the policy surface small: tamper enforcement and strict source
shadowing are always enabled, online verification is required, and the host must
provide callbacks that load and store the strongest accepted `revocation_seq`
for each project/feature/license fingerprint. Those callbacks let a restarted
process reject rollback to an older signed online assertion.

For deployments with an existing user database or billing system, keep that
system as the source of truth and sync a small entitlement projection into D1
through the admin Worker's `/api/sync/entitlements` endpoint. The public verifier
then reads that projection on the hot path.

The Cloudflare deployment also includes optional D1 backup infrastructure under
`services/cloudflare-d1-backup`: a scheduled Workflow exports the verifier D1
database to R2, while D1 Time Travel remains the short-window point-in-time
restore path.

For local release evidence, run `node scripts/validate_release_gates.mjs
--full --external --json-out build/release-gates/full-latest.json`. The command runs
deterministic local gates and reports explicit skip reasons for staging-only
Access, R2 restore, backup deployment, and public verifier abuse drills when
their operator credentials or staging identifiers are not present.
The first local gate is a workspace hygiene scan: it runs tracked diff checks
and scans untracked, non-ignored text files for trailing whitespace before
service tests run.
For production sign-off, use `--require-external` with the staging credentials
present so the runner first performs a secret-redacted external input preflight,
then fails if Access, R2 restore, or backup deployment drills are missing or
skipped instead of producing only a partial evidence packet. It also requires
the public verifier abuse drill to run successfully against the staging
verifier URL. Full and strict runs also require
`build/CTestTestfile.cmake`, so C++ security/API tests cannot be skipped by
running from an unconfigured build tree. The production JSON must show
`production_ready=true` and an empty `blocking_reasons` list. It must also have
nonempty trimmed unique result labels and integer exit statuses, or the
runner/assertion will treat the evidence as malformed. In strict mode, the
runner also blocks `production_ready=true` when required deterministic local or
external result labels are missing. Each result records the command/action and
duration evidence used for sign-off. Required local result commands must match
the shared release-gate contract, so a fabricated label/status row is rejected.
External drill command strings must match redacted templates for staging URLs,
Worker names, R2 object keys, bucket names, and D1 database names; extra
literal staging arguments are rejected. Skipped external drill rows use only
`not run: <drill label>`, without staging details. You can assert that contract
directly; the assertion also checks required deterministic local gate results,
including C++ tests, the admin UI build, UI workflow tests, and browser e2e,
are present with status `0`:

```console
node scripts/external_gate_preflight.mjs
node scripts/validate_release_gates.mjs --full --require-external --json-out build/release-gates/production-latest.json
node scripts/assert_release_ready.mjs build/release-gates/production-latest.json
```

Use the detailed production worksheet in
[`doc/analysis/remaining-gap-closure-checklist.rst`](doc/analysis/remaining-gap-closure-checklist.rst)
to record verification logs, staging validation evidence, hard blockers, and
final sign-off. A runner summary with `ok=true` and `complete=false` is useful
local evidence, but it is not a production release sign-off.

## How to contribute

The easiest way you can solve your problems or ask help is through the [discussions tab](https://github.com/open-license-manager/licensecc/discussions) above, otherwise if you think there is a problem you can open an issue in the [issue system](https://github.com/open-license-manager/licensecc/issues). 
Have a look to the [contribution guidelines](CONTRIBUTING.md) before reporting.
We use [GitFlow](https://datasift.github.io/gitflow/IntroducingGitFlow.html) (or at least a subset of it). 
Remember to install the gitflow git plugin and use `develop` as default branch for your pull requests. 
