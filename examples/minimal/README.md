# Minimal licensecc example

A small program showing the consumer-facing API: `acquire_license_ex()` plus
the `lcc_strerror()` / `print_error()` helpers for reporting a failure to the
user. It grants access only when the license check returns `LICENSE_OK`; every
other status is treated as not licensed.

This example is **standalone** - it is not compiled by the main licensecc build,
so it stays out of the library's dependency graph. Build it against a licensecc
you have already built or installed. The supported production integration mode
is the installed CMake package plus the `licensecc::licensecc_static` imported
target. Source-tree include paths, hand-written library paths, `add_subdirectory`
embedding, MSBuild-only, Bazel, and raw Makefile consumption are not production
interfaces unless you add matching smoke tests for those modes.

## 1. Build & install licensecc for your project

From the licensecc repo (see the top-level README for prerequisites):

```console
cmake -S <licensecc> -B lcc-build -DLCC_PROJECT_NAME=myproject -DLCC_PROJECTS_BASE_DIR=<issuer-projects-dir> -DCMAKE_INSTALL_PREFIX=<prefix>
cmake --build lcc-build --target install
```

## 2. Build this example against it

```console
cmake -S . -B build -DCMAKE_PREFIX_PATH=<prefix> -DLCC_PROJECT_NAME=myproject
cmake --build build
```

The example uses `find_package(licensecc REQUIRED COMPONENTS <project>)` to make
the selected project visible at the call site. If you use a non-default install
location, point `CMAKE_PREFIX_PATH` at the install prefix.

## 3. Run

```console
./build/minimal path/to/license.lic
```

With no argument it searches the default locations (next to the executable, or
the `LICENSE_LOCATION` environment variable, depending on how licensecc was
configured). Issue the license itself with the `lccgen` tool - see the
licensecc docs on *issuing licenses*.

Optional arguments let smoke tests and host applications pass caller metadata:

```console
./build/minimal path/to/license.lic FEATURE 1.2.3 <LCC_PROJECT_MAGIC_NUM>
```

The optional `FEATURE` argument demonstrates feature-specific checks for
products that license separate capabilities. The optional version argument is
used when a license contains `start-version` or `end-version`; missing,
malformed, or out-of-range caller versions fail closed with
`PRODUCT_NOT_LICENSED`.

The example initializes `CallerInformations.magic` with the generated
`LCC_PROJECT_MAGIC_NUM` constant. The final optional argument overrides that
value only for tests or diagnostics; a zero or mismatched magic value fails
closed when the runtime was built with a nonzero project magic.

The example prints diagnostic events with `print_error()` after a failure, but
those diagnostics are informational only. Do not grant access because a message
looks recoverable; check only for `LICENSE_OK`.

The example initializes `LicenseCheckOptions` with
`lcc_init_license_check_options()`, which uses `LCC_TAMPER_AUDIT`. In audit
mode, a valid license still returns `LICENSE_OK` while tamper signals appear as
warning audit events. To fail closed on a host-specific integrity signal, set a
callback and switch to enforcement after testing:

```c
LicenseCheckOptions options;
lcc_init_license_check_options(&options);
options.host_integrity_check = my_integrity_check;
options.host_integrity_user_data = my_state;
options.tamper_policy = LCC_TAMPER_ENFORCE;
```

Do not print raw hardware identifiers from normal application logs. If support
needs identifier diagnostics, use the tools/support package and keep
`lccinspector` in its default redacted mode unless the user explicitly agrees
to provide raw hardware values through a trusted channel.
