# Anti-tamper host example

This example shows how a host application supplies a best-effort
`LCC_HOST_INTEGRITY_CHECK` callback through `acquire_license_ex()`.

The callback `host_integrity_check` runs only after the base license verifies as
`LICENSE_OK`. It is the place where a product implements its own best-effort
runtime probes (a debugger check, a self-measurement, a parent-process check).
Returning `true` lets the license stand; returning `false` signals a tamper
suspicion and writes a short reason into the supplied detail buffer.

The check options initializer sets the secure defaults, so `tamper_policy` is
`LCC_TAMPER_ENFORCE`. Under that policy, returning `false` denies the license:
`acquire_license_ex()` clears the result and returns `LICENSE_TAMPER_DETECTED`.

## Best-effort, NOT tamper-proof

A `host_integrity_check` runs on a machine the attacker may fully control. It can
be patched out, hooked, or stubbed to always return `true`. Do not treat it as a
guarantee. Use it as one input to a layered defense: combine it with server-side
entitlement checks and online verification (see the `online_callback` example),
plus telemetry. On its own it stops nothing.

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
cmake -S examples/anti_tamper_host -B build/anti-tamper-host \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_PREFIX_PATH="$repo/build/dev-debug/install" \
  -Dlicensecc_DIR="$repo/build/dev-debug/install/lib/cmake/licensecc" \
  -DLCC_PROJECT_NAME=test
cmake --build build/anti-tamper-host
"$repo/build/anti-tamper-host/anti_tamper_host" \
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic"
```

### Windows/MSVC (PowerShell 7)

```powershell
$repo = (Resolve-Path ".").Path
cmake -S examples/anti_tamper_host -B build/anti-tamper-host `
  -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_PREFIX_PATH=$repo/build/dev-debug/install" `
  "-Dlicensecc_DIR=$repo/build/dev-debug/install/cmake/licensecc" `
  -DLCC_PROJECT_NAME=test
cmake --build build/anti-tamper-host --config Debug
& "$repo/build/anti-tamper-host/Debug/anti_tamper_host.exe" `
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic"
```

The example disables environment-sourced license lookup, then acquires the
license with the integrity callback wired in. On success it prints that the
runtime integrity check passed and exits with status 0:
`license OK (runtime integrity check passed)`. On denial it prints
`lcc_strerror()` and the detail from `print_error()`, then exits with status 1.
