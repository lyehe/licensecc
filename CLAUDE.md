# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`licensecc` is a C++11 copy-protection / licensing library for Windows and Linux. It compiles to a static library (`licensecc::licensecc_static`) that you integrate into your own software to verify licenses, bind licenses to specific hardware, and detect virtualized/cloud environments. The library has minimal dependencies (OpenSSL on Linux only; system crypto libs on Windows).

This repo is one of four sub-components of the wider project:
- **this repo** — the library you integrate (`licensecc`) plus `lcc-inspector`, a license/hardware debugger.
- **`lccgen`** — the license generator CLI, vendored as a git submodule at `extern/license-generator` (GitHub: `lcc-license-generator`). CMake builds/finds it to initialize projects and generate keys.
- **examples** — separate repo demonstrating integration.

## Build & test

Builds are **out-of-source** (in-source builds are disabled). Always build from the `build/` directory. The project has submodules — clone with `--recursive` or run `git submodule update --init --recursive`.

A key concept: **every consumer defines a named "project"** (`LCC_PROJECT_NAME`). Project initialization generates an RSA keypair and a per-project `licensecc_properties.h` under `projects/<NAME>/`. If you don't pass `-DLCC_PROJECT_NAME`, a mock project named `DEFAULT` is created automatically.

### Linux
```console
cd build
cmake .. -DCMAKE_INSTALL_PREFIX=../install -DLCC_PROJECT_NAME=myproject
make
make install
make test          # runs the test suite (requires Boost)
```

### Windows (MSVC)
```console
cd build
cmake .. -A x64 -DCMAKE_BUILD_TYPE=Release -DLCC_PROJECT_NAME=myproject -DBOOST_ROOT="<boost dir>" -DCMAKE_INSTALL_PREFIX=../install
cmake --build . --target install --config Release
ctest -C Release   # set CTEST_OUTPUT_ON_FAILURE=1 to see failures
```

### Cross-compile Linux→Windows (MinGW)
```console
x86_64-w64-mingw32.static-cmake .. -DCMAKE_INSTALL_PREFIX=../install
make && make install
```
Tests run under `wine` automatically when cross-compiling without a binfmt emulator.

### Key CMake options
- `LCC_PROJECT_NAME` — name of the software being licensed; controls `projects/<NAME>/` paths. Required in practice.
- `LCC_PROJECT_MAGIC_NUM` — anti-tamper magic baked into the build; the calling app must pass the same value via `CallerInformations.magic` (see `LCC_VERIFY_MAGIC` in `licensecc_properties.h`). Defaults to 0.
- `STATIC_RUNTIME` — static-link the C++/CRT runtime (`/MT` on MSVC, `-static` on gcc/MinGW).
- `BUILD_TESTING` / Boost — tests and the inspector only build when Boost (`unit_test_framework system filesystem`, static libs) is found. No Boost → tests silently disabled.
- `CODE_COVERAGE` (Linux) — adds `--coverage`.

### Running a single test
Tests are Boost.Test executables registered with CTest. Use CTest filtering or run the test binary directly with Boost flags:
```console
ctest -R <test_name_regex> -C Release           # filter by CTest name
./test/library/<test_binary> --run_test=<suite>/<case>   # Boost.Test filter
```

### Docs
`make docs` (Doxygen) and `make documentation` (Sphinx+Breathe, sources in `doc/`) build the documentation, only when Doxygen+dot and Sphinx are found.

### Formatting
Use **clang-format** with the repo's `.clang-format` before committing. Do not reformat to personal preference — it creates merge noise. Work against the `develop` branch (GitFlow); `master` is for stable releases.

## Architecture

Public C API (the integration surface) lives in `include/licensecc/`:
- `licensecc.h` — the four entry points: `identify_pc()`, `acquire_license()`, and the not-yet-implemented `confirm_license()`/`release_license()`.
- `datatypes.h` — all API structs/enums: `LicenseLocation`, `CallerInformations`, `LicenseInfo`, `LCC_EVENT_TYPE` (status/error codes), `ExecutionEnvironmentInfo`.

`acquire_license()` (in `src/library/licensecc.cpp`) is the heart of the flow:
1. **`LicenseReader`** (`LicenseReader.cpp`) locates and parses license files. Licenses are **INI files** (parsed via the bundled `SimpleIni.h` in `src/library/ini/`); each `[section]` is a *feature*, and every project has a default feature equal to the project name. A parsed license becomes a `FullLicenseInfo`.
2. **`LicenseVerifier`** (`src/library/limits/license_verifier.cpp`) checks the RSA signature against the project's embedded public key, then verifies *limits* (expiry date, version range, hardware binding, magic number).
3. Results accumulate in an **`EventRegistry`** (`src/library/base/`) — a list of audit events (info/warn/error). On success, errors become warnings; on failure, warnings become errors and the last failure's `event_type` is returned. The events are exported into `LicenseInfo.status`.
4. When multiple valid licenses exist, `mergeLicenses()` picks the one that expires latest (or a non-expiring one).

Internal library code is organized by concern under `src/library/` (all compiled as CMake OBJECT libraries and linked into `licensecc_static`):
- **`os/`** — platform abstraction. `os.h` and the strategy headers (`cpu_info.hpp`, `dmi_info.hpp`, `network.hpp`, `execution_environment.hpp`, `signature_verifier.hpp`) declare interfaces; implementations live in `os/linux/`, `os/windows/`, and `os/openssl/`. This is where new platform support goes.
- **`hw_identifier/`** — hardware fingerprinting. `HwIdentifierFacade` is the entry point; concrete strategies (`disk_strategy`, `ethernet`, `default_strategy`) produce a PC signature. The strategy used is chosen by `LCC_API_HW_IDENTIFICATION_STRATEGY` (see the enum in `licensecc_properties.h`) and adapts to the detected execution environment (bare metal / VM / docker / cloud).
- **`locate/`** — finds where the license is. `LocatorFactory` builds a chain of `LocatorStrategy` implementations (near the module, environment variable, externally-defined, plain data). Which locators are active is controlled by `FIND_LICENSE_NEAR_MODULE` / `FIND_LICENSE_WITH_ENV_VAR` in `licensecc_properties.h`.
- **`base/`** — utilities: `EventRegistry`, base64, logging, file/string helpers.

`src/inspector/inspector.cpp` builds `lcc-inspector` / `lccinspector`, a standalone CLI that computes the PC hash and diagnoses licensing problems on a customer's machine.

### Per-project configuration is generated, not hand-edited

`src/templates/licensecc_properties.h.in` (and `..._test.h.in`) is a template. At configure time CMake runs `lccgen project initialize` to generate `projects/<NAME>/include/licensecc/<NAME>/licensecc_properties.h` plus the RSA keypair (`public_key.h`, `private_key.rsa`). This generated header defines API buffer sizes (`LCC_API_*`), license-location behavior, the magic-number check, and the hardware-identification strategy lists. **To change per-project behavior, edit the template or regenerate the project — don't edit the generated file in `projects/` (it's git-ignored and overwritten).**

## Tests

`test/library/` mirrors the `src/library/` structure (unit tests per module). `test/functional/` holds integration tests including `crack_test` (tamper resistance), `date_test`, signature verification, and `generate-license.cpp` (generates licenses for the other tests using the test project's private key). Tests use a separate `licensecc_properties_test.h` generated into the build dir.
