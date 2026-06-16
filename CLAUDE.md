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

### Repository layout

Top-level directories. "tracked" = under version control; "generated/output" = produced by a build or tool and git-ignored (so never hand-edit and never expect it in a clean clone). Note that some output dirs (`install/`, `doc/_build/`) only appear after the relevant build step — they are not present in a clean checkout.

| Path | Purpose | Kind |
|---|---|---|
| `include/licensecc/` | **Public C API** you integrate: `licensecc.h` (entry points) + `datatypes.h` (all ABI structs/enums). The only headers installed to consumers. | tracked (public headers) |
| `src/library/` | All compiled library code (the core). Built as CMake OBJECT libs linked into `licensecc::licensecc_static`. See the module graph below. | tracked (source) |
| `src/inspector/` | `lcc-inspector` / `lccinspector` CLI — computes the PC hash and diagnoses licensing problems on a customer machine. | tracked (source) |
| `src/templates/` | `licensecc_properties.h.in` / `..._test.h.in` — CMake-configured templates that generate per-project headers into `projects/`. | tracked (source) |
| `test/` | CTest suite: `library/` (unit, mirrors `src/library/`), `functional/` (integration: crack/date/signature/`generate-license`), `vectors/` (golden fixtures), and smoke `.cmake` scripts at the top level. | tracked (source) |
| `benchmark/` | Standalone micro-benchmark for `identify_pc()` throughput. | tracked (source) |
| `examples/` | **Current, maintained** integration patterns: `minimal/`, `fail_closed_host/`, `anti_tamper_host/`, `online_callback/`, `production_decision_host/`. Note the split: only `online_callback/`, `anti_tamper_host/`, and `production_decision_host/` are wired into the main build via `LCC_BUILD_EXAMPLES` (root `CMakeLists.txt`); `minimal/` and `fail_closed_host/` are **standalone** (their READMEs state they are "not compiled by the main licensecc build" and are built as a real consumer would, via `find_package`). | tracked (source) |
| `example/` | **Maintained** single-file `find_package(licensecc)` demo (3 files: `CMakeLists.txt`, `README.md`, `main.cpp`). Despite the singular name, it is **not** a stale artifact — it was last changed 2026-06-05 (commit `8991607`, "Add online verification and admin hardening") and its `main.cpp`/`README` describe a **current production-style host workflow**: online-verification-aware, fail-closed, with bounded public API setters. It is intentionally separate from the main build and built like a real consumer (from an installed package). The `examples/` (plural) progression is the richer set; this singular `example/` is the canonical minimal `find_package` consumer. | tracked (source) |
| `services/` | Cloudflare Workers backend (three Workers + shared tooling). See **Cloudflare services** below. | tracked (source + tooling) |
| `scripts/` | Repo-level release-gate automation (`validate_release_gates.mjs`, `assert_release_ready.mjs`, `secret_hygiene_scan.mjs`) and build helpers (`build_docs.py`, `windows_download_boost.bat`). | tracked (tooling) |
| `cmake/` | Project CMake modules: `Find*.cmake`, toolchains, release-manifest read/write, signing/scanning, packaging. | tracked (config) |
| `extern/` | Git submodule `license-generator` (the `lccgen` CLI). Built during CMake configure; clone with `--recursive`. | tracked (submodule) |
| `patches/` | `license-generator-ci.patch.gz` applied to the vendored `lccgen` in CI. | tracked (config) |
| `doc/` | **User-facing reference site** (Sphinx + Breathe + Doxygen): `conf.py`, `Doxyfile`, and `.rst` sources under `analysis/`, `api/`, `usage/`, `development/`, `other/`. Built by `make docs` / `make documentation`. Also contains `structure.dox` — currently only a **Doxygen stub** (placeholder `intro`/`advanced` pages with lorem-style text), **not** an authoritative structure document; do not treat it as canonical. | tracked (docs) -> output in `doc/_build/` (generated on demand, absent in a clean clone), `doc/_doxygen/` |
| `docs/` | **Internal development planning only** — `docs/superpowers/plans/`, `docs/superpowers/specs/`, and the feature status indexes under `docs/superpowers/features/` (dated design specs and implementation checklists). NOT part of the published site; no user-facing content. | tracked (internal planning) |
| `projects/` | Generated per-project keypairs + `licensecc_properties.h` (only `DEFAULT/` after a default build). Regenerated from `src/templates/` — never hand-edit. | generated/output (git-ignored except `.gitkeep`) |
| `build/`, `build-fuzz-probe/` | Out-of-source CMake build trees (in-source builds are disabled). `build-fuzz-probe/` is the fuzzing build tree. | output (git-ignored) |
| `install/`, `dist/`, `Testing/` | Install prefix, release artifact staging (a runtime `.zip`), and CTest log sink, respectively. `dist/` and `Testing/` exist after a packaging/test run; `install/` only after `make install` (not present in a clean checkout). | output (git-ignored) |

> `doc/` vs `docs/` and `example/` vs `examples/` are real, easy-to-confuse collisions: **`doc/` = published site, `docs/` = internal plans; `examples/` = the multi-pattern current set, `example/` = the maintained single-file `find_package` demo.** Both `example/` and `examples/` are current and maintained — neither is dead. When in doubt, edit the plural-for-examples / singular-for-the-site.

> There is also a root `IMPLEMENTATION_CHECKLIST.md` (the security-by-default checklist) distinct from the dated checklists under `docs/superpowers/plans/`. The root one tracks v200 release-readiness; the dated ones track individual feature efforts.

#### C++ module dependency graph

Everything under `src/library/` compiles into `licensecc::licensecc_static`. Most concerns are CMake OBJECT libraries; `limits/license_verifier.cpp` and `ini/ConvertUTF.cpp` are listed as direct STATIC sources of `licensecc_static` (alongside `licensecc.cpp` and `LicenseReader.cpp`). `ini/SimpleIni.h` is a bundled **header-only** INI parser (not a separately compiled unit); `ini/ConvertUTF.cpp` is the only compiled `ini/` file.

**The arrows below are source-level compile/include dependencies (`#include` relationships), not CMake-declared target dependencies.** The per-module `CMakeLists.txt` files declare **no** inter-module `target_link_libraries` between the OBJECT libs (`base`, `os`, `hw_identifier`, `locate`, `anti_tamper`, `online_verification`, `config_attestation`): each is a plain OBJECT lib, all `$<TARGET_OBJECTS:...>` are linked into `licensecc_static`, and the only declared per-module dependency is a build-order `add_dependencies(<module> project_initialize)`. `base` and `os` are the only leaves; nothing in the token-verification modules depends on `hw_identifier` or `locate`.

```
                          licensecc_static  (STATIC)
                          |  licensecc.cpp                (C API facade; calls everything)
                          |  LicenseReader.cpp             (INI parse -> FullLicenseInfo)
                          |  limits/license_verifier.cpp   (RSA sig + expiry/version/hw/magic)
                          |  ini/ConvertUTF.cpp            (+ bundled header-only ini/SimpleIni.h)
                          |
   +-----------+----------+-----------+-------------+--------------------+--------------------+
   |           |          |           |             |                    |                    |
 base        os      hw_identifier  locate     anti_tamper       online_verification   config_attestation
 (leaf)    (leaf)        |  \          |  \          |                 |    \                 |    \
   ^          ^          |   \         |   \         |                 |     \                |     \
   |          |        os   base     base  os      base              base    os             base    os
   |          |
   |   uses base (indirectly)
   +-- EventRegistry, base64, string_utils, file/logger, v201_canonical_payload

Include (compile) deps, source-verified:
  anti_tamper          -> base only   (../base/EventRegistry.h, ../base/string_utils.h; NO os)
  online_verification  -> base + os   (../base/{EventRegistry,base64,string_utils}, ../os/{os.h,signature_verifier.hpp})
  config_attestation   -> base + os   (../base/base64.h, ../os/os.h, ../os/signature_verifier.hpp)
  locate               -> base + os   (../base/*, ../os/os.h)
  hw_identifier        -> base + os   (../base/*, ../os/*)

External link deps (declared on licensecc_static itself):
  Linux / OpenSSL build : OpenSSL::Crypto + libdl  (+ gcov when CODE_COVERAGE)
  Windows build         : bcrypt.lib  (or OpenSSL when os/openssl is selected)
```

Module responsibilities (the ones CLAUDE.md's Architecture section does not already name):
- **`anti_tamper/`** — runtime tamper-signal evaluation: `evaluate(AntiTamperRequest)` aggregates host-integrity-callback and source-shadowing signals; `normalize_options` validates `LicenseCheckOptions`. (Depends only on `base` at the source level — no `os` include.)
- **`online_verification/`** — online assertion protocol. Envelope `lccoa1.<b64-payload>.<b64-sig>`, canonical-payload parse, RSA verify, claims validation (purpose/binding/time-window/revocation-seq/cache), drives the `LCC_ONLINE_CHECK` callback, process-local revocation floor.
- **`config_attestation/`** — signed-config-token protocol. Envelope `lcccfg1.<b64-payload>.<b64-sig>`, parse, RSA verify, claims validation (purpose/binding/config-hash/time-window/rollback floor). Backs `lcc_verify_config`.

> **Known duplication (planned dedupe, not yet done):** `online_verification/OnlineVerification.cpp` and `config_attestation/ConfigAttestation.cpp` share ~120-140 lines of byte-identical token plumbing (`split_envelope`, `build_*_envelope`, `verify_payload_signature`, `append_claim_line`, `parse_uint64`, the canonical-payload field loop, the trusted-key override singleton, and the `PublicKey`/`Expected`/`Claims` struct shapes). The intended fix is a shared signed-token core (see `needs_clean_tree`), not in-place edits to either file.

#### Licensing + token verification flow (where each piece runs)

1. **License check (offline, in `licensecc_static`):** `acquire_license*` -> `LicenseReader` locates+parses the INI `.lic` -> `LicenseVerifier` checks the RSA signature against the project's embedded public key and all limits -> `EventRegistry` accumulates audit events -> `LicenseInfo.status`.
2. **Online assertion (optional, hardening):** the host's `LCC_ONLINE_CHECK` callback fetches `POST /v1/verify` from the Cloudflare verifier; the returned `lccoa1.` token is verified locally by `online_verification`. Server is authoritative; the client check is fail-closed, never security theater.
3. **Signed config token (optional):** a server-signed `lcccfg1.` token is produced **offline** by `services/.../scripts/config-sign.mjs` and verified **in C++** by `config_attestation` via `lcc_verify_config`, binding the config bytes to a valid local license. Note the asymmetry: the Worker issues `lccoa1.` assertion tokens; config `lcccfg1.` tokens are signed by tooling and consumed in C++, not by the Worker (a Plan 3 endpoint is planned).

### Cloudflare services

`services/` holds three independent Cloudflare Workers plus their CLIs and tests. Each has its own `package.json`, `wrangler.example.toml`, `migrations/`, `scripts/` (including a per-service `lint.mjs`), and `test/`.

| Directory | Role | Key surface |
|---|---|---|
| `cloudflare-licensing-backend/` | The online assertion issuer **and** the de-facto home for entitlement/device admin tooling and the offline config signer. (Renamed from `cloudflare-online-verifier/`; the deployed Worker `name` and D1 `database_name` remain `licensecc-online-verifier`.) | Worker `POST /v1/verify` (signs `lccoa1.` assertions after a D1 entitlement check, with tiered rate limiting and optional ECDSA request-proof / device binding) + `GET /health`. Scripts: `entitlement.mjs` (entitlement + device CLI), `device-key.mjs` (ECDSA device keys), `config-sign.mjs` (offline `lcccfg1.` signer), `generate-online-key.mjs` / `generate-online-assertion-fixture.mjs` (key/fixture generators), `remote-cpp-verify.mjs` (end-to-end harness), `public-verifier-drill.mjs` (public-endpoint drill), `check-schema-parity.py`, and `lint.mjs`. |
| `cloudflare-license-admin/` | Admin Worker + Vite/React admin UI for managing entitlements; syncs to the verifier. | `src/worker/index.ts`, `src/ui/`, sync + access-drill scripts, `lint.mjs`. |
| `cloudflare-d1-backup/` | D1 backup / time-travel / restore tooling for the verifier database. | `src/core.ts`, `src/http.ts`, restore/time-travel scripts, `lint.mjs`. |

**Offline config signer (`config-sign.mjs`).** Produces `lcccfg1.<b64-payload>.<b64-sig>` tokens signed with `rsa-pkcs1-sha256` (`RSASSA-PKCS1-v1_5` + `SHA-256`), `key-id` of the form `sha256:<64-hex>`, and a `config-hash` of `sha256:<hex>` over the config bytes. CLI options: `--private-key <pkcs8-pem> --key-id sha256:<64-hex> --fingerprint <64-hex> --config <file> --config-id <id> --config-seq <uint>` plus optional `--project`, `--feature`, `--device-hash <64-hex>`, `--issued-at <epoch>`, `--expires-at <epoch>`. This corroborates the config-attestation feature's claims: same envelope/canonical-payload discipline as the online assertion, consumed in C++ by `config_attestation` (not by the Worker).

**Data model** (final state in `cloudflare-licensing-backend/schema.sql`, built up by `migrations/0001..0008`): `entitlements` (PK `project, feature, license_fingerprint`; status/window/`revocation_seq`; device binding via an **optional `device_hash TEXT NOT NULL DEFAULT ''` column**), `entitlement_devices` (per-entitlement ECDSA device keys for relay-resistance, added by migration `0008`; PK `project, feature, license_fingerprint, device_key_id`, FK to `entitlements`), `entitlement_events` (append-only audit log), `customers`, `licenses`, `mutation_idempotency`, `rate_limit_counters`. The Worker's optional `RequestProof` uses algorithm `ecdsa-p256-sha256` (ECDSA P-256 + SHA-256, SPKI keys) over a canonical payload with `REQUEST_PROOF_PURPOSE = "licensecc-online-request"`. `scripts/check-schema-parity.py` enforces that `schema.sql` equals the applied migrations.

> **Naming note (rename DONE 2026-06-15):** the directory was renamed `cloudflare-online-verifier/` → `cloudflare-licensing-backend/` because it carries more than the verifier: config-attestation signing (`config-sign.mjs`, a different `lcccfg1.` protocol consumed in C++) and the device/relay-resistance subsystem (`device-key.mjs`, `entitlement_devices`). **Only the directory and the npm package name (`@licensecc/cloudflare-licensing-backend`) changed.** The deployed Worker `name`, the D1 `database_name`, the `/health` `service:` string, and hardcoded deployed URLs intentionally remain `licensecc-online-verifier` so live infra and client URLs are not orphaned.

> **For the signed-config-token feature specifically, start at the feature status index:** `docs/superpowers/features/signed-config-token-status.md`.

## Tests

`test/library/` mirrors the `src/library/` structure (unit tests per module). `test/functional/` holds integration tests including `crack_test` (tamper resistance), `date_test`, signature verification, and `generate-license.cpp` (generates licenses for the other tests using the test project's private key). Tests use a separate `licensecc_properties_test.h` generated into the build dir.
