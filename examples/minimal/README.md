# Minimal Licensecc example

This standalone consumer shows the usual native API surface:
`acquire_license()`, `lcc_strerror()`, and `print_error()`. The full sequence
below builds Licensecc for the sample project `test`, issues a matching local
license, builds this example from the installed package, and verifies it.

Prerequisites are Git, CMake 3.21+, a C++17 compiler, Boost development
libraries, and the platform dependencies listed in the repository README. The
copyable Windows sequence uses Visual Studio 2022 x64; other supported
toolchains produce different generator-specific executable paths. Node,
Python, Java, and Cloudflare credentials are not required.

The platform-specific commands below configure and build the `dev-debug`
preset. That preset selects `LCC_PROJECT_NAME=test`, installs under
`build/dev-debug/install`, and generates the project keys under
`build/dev-debug/projects/test`.

## Build, issue, and run on Windows

Starting directory: the Licensecc repository root. Shell: PowerShell.

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

## Build, issue, and run on Linux

Starting directory: the Licensecc repository root. Shell: Bash.

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

The issuer prints `License written`. The final command should print:

```text
license OK (days left: ...)
```

The explicit `licensecc_DIR` accounts for the different Windows and Linux
install layouts. `CMAKE_PREFIX_PATH` alone is not sufficient for every
supported generator and platform combination.

Keep `build/dev-debug/projects/test/private_key.rsa` out of applications,
installers, logs, and release artifacts. It can issue licenses accepted by the
matching runtime. For validity dates, features, version ranges, and machine
binding, continue with the repository's
[license-issuance guide](../../doc/usage/issue-licenses.md).
