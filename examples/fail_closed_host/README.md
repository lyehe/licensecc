# Fail-closed host example

This example models a small host application with a base product entitlement
and two optional features, `REPORTS` and `EXPORT`.

All protected capabilities start unavailable. The application enables the base
product only after `acquire_license()` returns `LICENSE_OK`, then checks each
optional feature separately. Any non-`LICENSE_OK` result leaves that capability
unavailable and prints diagnostics with `lcc_strerror()` and `print_error()`.

## Build and run

This is a standalone consumer of an installed Licensecc package; it is not a
target in the repository-root build. First complete the
[offline-first tutorial](../../doc/tutorials/offline-first-license.rst), which
installs the `test` project under `build/dev-debug/install` and issues the
matching sample license. The commands below start in the Licensecc repository
root.

Starting directory: the Licensecc repository root. Shell: Bash on Linux or
PowerShell 7 on Windows/MSVC.

### Linux (Bash)

```bash
repo="$PWD"
cmake -S examples/fail_closed_host -B build/fail-closed-host \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_PREFIX_PATH="$repo/build/dev-debug/install" \
  -Dlicensecc_DIR="$repo/build/dev-debug/install/lib/cmake/licensecc" \
  -DLCC_PROJECT_NAME=test
cmake --build build/fail-closed-host
"$repo/build/fail-closed-host/fail_closed_host" \
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" 1.2.3
```

### Windows/MSVC (PowerShell 7)

```powershell
$repo = (Resolve-Path ".").Path
cmake -S examples/fail_closed_host -B build/fail-closed-host `
  -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_PREFIX_PATH=$repo/build/dev-debug/install" `
  "-Dlicensecc_DIR=$repo/build/dev-debug/install/cmake/licensecc" `
  -DLCC_PROJECT_NAME=test
cmake --build build/fail-closed-host --config Debug
& "$repo/build/fail-closed-host/Debug/fail_closed_host.exe" `
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" 1.2.3
```

The example uses `find_package(licensecc REQUIRED COMPONENTS test)` through
the `LCC_PROJECT_NAME=test` configure value, so the selected installed project
is explicit in the consumer CMake configure. With the sample license, the
process exits 0 and prints:

```text
application enabled
REPORTS unavailable
EXPORT unavailable
```

The optional feature lines become `enabled` only when those features are
licensed. A base-product denial leaves every capability unavailable, prints
`lcc_strerror()` and `print_error()` diagnostics on stderr, and exits 1.

The example populates `CallerInformations.version` and sets
`CallerInformations.magic = LCC_PROJECT_MAGIC_NUM` for every check. It reads
`LicenseInfo.proprietary_data` only after the base product check succeeds. The
optional `--print-id` flag prints a hardware identifier only for support or
license enrollment; it is not used as proof of entitlement.

At startup the example disables environment-sourced license lookup and enables
strict source-fatal handling. That means a malformed colocated license file
cannot be silently demoted by a later valid explicit license path.

For new hosts that need per-call tamper checks, prefer `acquire_license_ex()`
with `LicenseCheckOptions`. The initializer uses the secure defaults:
`LCC_TAMPER_ENFORCE` and `LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING`.
