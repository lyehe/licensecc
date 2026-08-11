# TPM Core Baseline Reconciliation

## Accepted source baseline

- Main parent: `ee46011efbeaf53c9cf98c0b042dc9b840405ecb`
- Imported authoritative C++ source snapshot: `887e41cbd2da35d8eb25beab78cfce12ec3594ca`
- Verified merge base: `f9656c95934b260451fd9a04a18efb56a24148a3`
- Reconciliation branch: `tpm/00-core-baseline`

The accepted implementation baseline is the resulting merge commit on
`tpm/00-core-baseline`, with the source snapshot above as the authority for
the owned C++ surface and `main` as the authority everywhere else.

## Scope invariant

Only the Task 0 allowlist is brought forward: root and source CMake support,
`cmake/LeaseRing.cmake`, the public C/C++ headers, C++ library and tests,
approved vectors, examples, and this manifest. All other tracked paths are
restored to the main parent byte-for-byte. In particular, this reconciliation
does not advance services, SDKs, workflow files, package metadata, presets,
or the then-pinned `extern/license-generator` gitlink.

The then-user-owned `extern/license-generator` worktree, its generated `.lic`
files, and the untracked planning documents under `docs/superpowers/plans/`
were deliberately left untouched. The generator is now vendored repository
source; this report preserves the historical topology of that reconciliation.

## Merge conflicts and resolutions

The pinned `--no-commit --no-ff` merge had these twelve conflicts:

1. `CMakeLists.txt`
2. `src/library/base/base64.cpp`
3. `src/library/base/logger.cpp`
4. `src/library/licensecc.cpp`
5. `src/library/locate/EnvironmentVarData.cpp`
6. `src/library/locate/ExternalDefinition.cpp`
7. `src/library/os/linux/os_linux.cpp`
8. `test/library/CMakeLists.txt`
9. `test/library/LicenseLocator_test.cpp`
10. `test/library/base64_test.cpp`
11. `test/library/hw_identifier/hw_identifier_test.cpp`
12. `test/library/public_api_test.cpp`

Resolution policy was source-authoritative implementation plus retained main
correctness behavior. The root CMake reconciliation keeps main's source-tree
safety and early MSVC runtime configuration while wiring all source snapshot
online, signed-token, v201, config-attestation, activation, and lease targets.
It also fails configure if the core public declaration or any required
implementation source disappears.

`base64.cpp`, the locator sources, Linux disk preference handling, logger, and
the public API tests retain the source implementation with the main safety
fixes. `licensecc.cpp` restores the real decision/online/config APIs and keeps
the obsolete authorization entry points fail-closed rather than returning a
placeholder success. The CMake test graph restores each real source snapshot
test target.

The hardware-ID golden test preserves the valid exact wire strings for
Ethernet, IP, disk, and environment-selected Ethernet. CPU-size and host-name
remain declared-but-unsupported strategies in the source implementation, so
the reconciliation explicitly tests their rejection instead of broadening the
runtime's accepted identifier surface.

## Compatibility decisions

Main's checked-in `public_key.inja` remains unchanged and byte-compatible with
older generated projects. The imported v201 issuer requires public-key ID,
SHA-256, algorithm, and bit-count metadata. Root CMake therefore creates a
build-tree-only lccgen template overlay that appends those metadata definitions
when a project is initialized. No source template or existing generated header
is overwritten. For a pre-existing metadata-less header, the C++ verifier
derives the key ID from the embedded DER bytes so its policy remains
key-ID-to-DER bound instead of accepting the obsolete legacy label.

`licensecc_properties_test.h.in` uses an isolated test project below
`Testing/Temporary`; it must not alias the project's generated public-key
directory, because functional issuance copies metadata into that test project.

## Retained main-only fixes

- `217bb607580286a9b79488e40d86dcc486b2722b`: MSVC runtime policy remains
  configured before lccgen setup.
- `2ca86ae9ef484150c3f604a073cdfe5b16b559c2`: main-owned platform/service
  layout and build presets remain untouched; generated project files stay in
  the build tree for this reconciliation.
- `60b2c11b267ebc5610d69dd7bf2f51acc3c8fc17`: bounded base64 decoding,
  correct environment-source diagnostics, ABI-matching legacy API symbols,
  and reference-based Linux disk preference behavior are retained.
- `bc11ab1bd83b9dfd8fbb57290caa27106b1bc7cb`: named hardware-ID bit layout
  and supported-strategy golden wire-format coverage are retained.
- `aedad61267e9c43127c5e15b66eb7c929164e890`: dead logger shutdown code and
  empty-test-stub behavior are not reintroduced.
- `ec86e5e35ed06b51121565a6f5ed5eb100002ece`: the reconciled base64 decoder
  retains quiet rejection of incomplete quanta and its short/padded-input
  regression coverage.

## Deliberately deferred snapshot pieces

`test/library/inspector_section_test.cpp` was restored to main and its source
target was not registered. It depends on `src/inspector/inspector_section.hpp`,
which is outside Task 0 ownership and must remain the main version.

Lease-ring generation remains opt-in. `cmake/LeaseRing.cmake` is present and
the existing lease-client tests run, but its manifest-generation helper depends
on an excluded non-owned script. `LCC_BUILD_LEASE_RING_TEST` remains off and no
lease-ring manifest is applied by default.

## Validation record

Windows validation used an isolated ignored build directory and the historical
`-DGIT_SUBMODULE=OFF` cache variable; this avoided mutating the then-protected
dirty submodule or a pre-existing `dev-debug` directory while exercising the
same CMake/C++ graph. The current repository vendors that source and has no
submodule build path.
MSVC configured without OpenSSL, built successfully, and the following passed:

```text
cmake -S . -B build/task0-core-baseline -G "Visual Studio 17 2022" -A x64 \
  -DCMAKE_BUILD_TYPE=Debug -DLCC_PROJECT_NAME=test -DGIT_SUBMODULE=OFF
cmake --build build/task0-core-baseline --config Debug -- /m
ctest --test-dir build/task0-core-baseline -C Debug --no-tests=error \
  -R "online|signed|v201|lease|activation|config" --output-on-failure
# 9 / 9 passed
ctest --test-dir build/task0-core-baseline -C Debug --no-tests=error --output-on-failure
# 34 / 34 passed
```

Additional available repository gates passed: the current backend suite (235
tests), `uv run --directory sdks/python pytest` (70 tests), and
`dotnet test sdks/dotnet/Licensecc.Client.sln --no-restore` (43 tests).

The task-plan paths `services/lease-api`, `services/online-worker/test`, and
`sdk/dotnet/Licensecc.Tests` do not exist in the preserved main-owned layout,
so their literal commands were not runnable. Ubuntu WSL has GCC and OpenSSL,
but no `cmake` executable; no Ubuntu build was attempted or installed.

`git diff --check` and `git diff --cached --check` pass. Git reported only
local `core.autocrlf=true` checkout warnings for modified C++ files; the
repository's `.gitattributes` continues to enforce LF for CMake, templates,
Markdown, and byte-sensitive test vectors.
