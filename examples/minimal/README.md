# Minimal licensecc example

A ~20-line program showing the consumer-facing API: `acquire_license()` plus the
`lcc_strerror()` / `print_error()` helpers for reporting a failure to the user.

This example is **standalone** — it is not compiled by the main licensecc build,
so it stays out of the library's dependency graph. Build it against a licensecc
you have already built or installed.

## 1. Build & install licensecc for your project

From the licensecc repo (see the top-level README for prerequisites):

```console
cmake -S <licensecc> -B lcc-build -DLCC_PROJECT_NAME=myproject -DCMAKE_INSTALL_PREFIX=<prefix>
cmake --build lcc-build --target install
```

## 2. Build this example against it

```console
cmake -S . -B build -DCMAKE_PREFIX_PATH=<prefix> -DLCC_PROJECT_NAME=myproject
cmake --build build
```

`find_package(licensecc REQUIRED)` resolves `licensecc::licensecc_static`. If you
did not install, point `-DLICENSECC_LOCATION=<licensecc build or source dir>`
instead of `CMAKE_PREFIX_PATH`.

## 3. Run

```console
./build/minimal path/to/license.lic
```

With no argument it searches the default locations (next to the executable, or
the `LICENSE_LOCATION` environment variable, depending on how licensecc was
configured). Issue the license itself with the `lccgen` tool — see the
licensecc docs on *issuing licenses*.
