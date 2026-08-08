# Fail-closed host example

This example models a small host application with a base product entitlement
and two optional features, `REPORTS` and `EXPORT`.

All protected capabilities start unavailable. The application enables the base
product only after `acquire_license()` returns `LICENSE_OK`, then checks each
optional feature separately. Any non-`LICENSE_OK` result leaves that capability
unavailable and prints diagnostics with `lcc_strerror()` and `print_error()`.

Build it against an installed Licensecc package:

```console
cmake -S . -B build -DCMAKE_PREFIX_PATH=<prefix> -DLCC_PROJECT_NAME=<product>
cmake --build build
```

The example uses `find_package(licensecc REQUIRED COMPONENTS <product>)` so the
selected project is explicit in the consumer CMake configure.

Run it with an explicit license path and the running application version:

```console
./build/fail_closed_host path/to/license.lic 1.2.3
```

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
