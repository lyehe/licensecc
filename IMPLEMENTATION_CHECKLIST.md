# Licensecc Security Implementation Checklist

This checklist tracks the implementation work needed to make license parsing,
issuance, verification, and C++ integration secure by default.

Status legend:

- `[x]` implemented in the current working tree
- `[ ]` not implemented yet
- `P0` release blocker for safe v200 verification, packaging, or migration
- `P1` needed for a stronger compatible release
- `P2` defense-in-depth, operations, or documentation hardening

Evidence discipline:

- Every `[x]` item should name the files changed or inspected, focused test
  names, local commands, platform/configuration, and any CI job that enforces
  the behavior.
- If a review finds a residual requirement inside a completed item, move that
  residual into a new open checklist item instead of leaving the completed
  item ambiguous.

Five-agent review priority order:

- Freeze the hardened v200 compatibility contract: accepted date forms, exact
  `lic_ver` shape, duplicate and malformed section behavior, multi-source
  malformed-license policy, and no-throw public API boundaries.
- Finish issuance invariants: generator/runtime client-signature parity,
  ignored key options, private-key file safety, output-file atomicity, generator
  date/version/value canonicalization, and no key material in error text.
- Close existing C++ integration in layers: package config failure behavior,
  install-based external consumer smoke tests, fail-closed consumer cases, then
  Linux/Windows CI gates.
- Define release artifact profiles before customer packaging: separate runtime,
  developer SDK, and tools/support payloads; make `lccgen` and `lccinspector`
  opt-in for customer artifacts; scan names and file contents after extraction.
- Add the policy-aware signature verification boundary before v201 so legacy
  v200 verification, algorithm allowlists, key IDs, and rotation are testable
  without platform-specific branching.
- Remove Windows fixed RSA-1024 assumptions before raising key-size defaults:
  dynamic key import/export, DER length validation, and cross-platform
  1024/2048/3072/4096-bit vectors must pass on OpenSSL and Windows.
- Stage v201 only after package, artifact, policy, and Windows crypto gates are
  in place: v201 needs canonical payload bytes, explicit `sig-alg`/`key-id`,
  fail-closed downgrade behavior, and golden vectors.
- After the second five-agent review, prioritize these added gaps before v201:
  multi-project package identity, release artifact identity manifests, v200 raw
  grammar documentation and migration notes, CTest label auditing, canonical
  base64 policy, deterministic hardware collector tests, and an optional strict
  source-fatal runtime mode for hosts that do not want malformed high-priority
  license sources to be demoted by a later valid source.
- After the third five-agent review, keep these gaps ahead of v201 launch work:
  bounded C API string reads, fail-closed oversized license files, runtime
  `extra-data` shape/length policy, environment-source default alignment,
  project-scoped CMake package identity, public header/include hygiene,
  RSA-3072 or stronger default issuance, key-id/key-material separation,
  lccinspector hardware-data redaction, and CI gates that fail on zero tests,
  unlabeled tests, missing docs tools, malformed docs links, and platform
  coverage drift.
- After the fourth five-agent review, treat explicit v201 issuance as
  implemented but not broadly launched: default remains v200, target-runtime
  gating is implemented with `--target-license-format-max=201` and
  runtime/package format metadata, while migration docs, v201 golden signed
  vectors, Linux/Windows parity, modern signing/key-ring work, fuzzing, and
  sanitizer evidence are still required before a v201 default cutover.
- After the fifth review pass, the existing C++ host path has a documented
  production integration mode and a source-fatal fail-closed example. Keep the
  remaining integration work focused on public API convenience helpers,
  deterministic hardware-source fixtures, per-release migration guidance, and
  full release-gate evidence rather than broadening unsupported build modes.
- After the sixth five-agent review, keep the remaining plan evidence-driven:
  add first-class v201 negative matrices, runtime key-strength and key-pair
  consistency gates, public ABI/package-version smokes, hardware privacy log
  gates, fuzz/sanitizer CTest evidence, and release evidence capture before
  treating the security upgrade as release-complete.

Current implementation sequence:

1. Integrator lens: keep production support centered on the installed CMake
   package, `COMPONENTS <project>`, `licensecc::licensecc_static`, package
   identity metadata, and fail-closed host examples. Add helpers only where
   they reduce fixed-buffer misuse in real host code.
2. Security lens: do not default to v201 until golden signed vectors,
   Linux/Windows parity, modern signing defaults, key import validation, and
   key rotation/retirement rules are implemented and verified.
3. Verification lens: turn the remaining open parser, v201, algorithm/key-id,
   hardware-source, fuzz, sanitizer, and parity requirements into named tests
   or CI gates before marking them complete.
4. Release lens: keep runtime, tools, and source profiles separately scanned;
   require manifest identity, license-format range metadata, public-key
   metadata, and sanitized manifest summaries for release artifacts.
5. Migration lens: publish a v200-to-hardened-v200/v201 guide that lists every
   newly rejected legacy shape, expected error code, regeneration path, and the
   exact v201 compatibility gate.

## Scope and Threat Model

- [x] `P0` Define the supported attacker model in `doc/analysis` or `doc/usage`.
  Acceptance criteria:
  - Documents that an attacker can read and edit local license files.
  - Documents that an attacker can set process environment variables unless the host application disables that path.
  - Documents that the verifier must fail closed on malformed or tampered licenses.
  - Documents limitations of local machine binding, clock checks, and VM detection.

- [x] `P0` Define compatibility rules for existing `lic_ver=200` licenses.
  Acceptance criteria:
  - Existing valid v200 licenses still verify.
  - Ambiguous, duplicated, unknown, or malformed v200 fields are rejected.
  - New crypto metadata is not added to v200 licenses; v200 remains strict and
    legacy.
  - Any future license version has an explicit migration and deprecation policy.

- [x] `P1` Define a versioned security policy for algorithms and key sizes.
  Evidence:
  - `doc/analysis/security-notes.rst` now defines per-format signing policy:
    v200 is legacy `rsa-pkcs1-sha256`, RSA-1024 verification is
    compatibility-only, new project generation defaults to RSA-3072, v201 uses
    canonical signed `sig-alg`/`key-id` metadata, and any RSA-PSS or newer
    algorithm default requires a versioned policy/vector/test update.
  - Generator defaults create RSA-3072 keys, and explicit RSA-1024 generation
    requires `--legacy-rsa1024`.
  - Runtime verifier policies accept only the documented
    `rsa-pkcs1-sha256` algorithm for the current v200/v201 policies and reject
    alias/case variants or accidentally allowlisted unimplemented algorithms.
  - Release artifact guards verify public-key algorithm, bit length,
    fingerprint, and signature algorithm metadata and reject runtime/package
    artifacts below the configured RSA modulus minimum.
  - The documented removal path keeps v200 verification for deployed licenses,
    treats RSA-1024 generation as migration-only, and requires release notes
    plus golden vectors before any future default algorithm/format cutover.
  - This item defines and documents the current policy; runtime minimum key
    strength enforcement for new license versions and production key-ring
    rotation remain tracked by the open cryptographic key-management items.
  Acceptance criteria:
  - v200 verification policy is documented as legacy
    `rsa-pkcs1-sha256`.
  - New license issuance policy uses a minimum RSA modulus of 2048 bits, with
    RSA-3072 or stronger as the default if RSA remains the selected algorithm.
  - Legacy algorithms and key sizes have a removal timeline.
  - Generator defaults and verifier allowlists match the policy.

## P0: v200 Parser and Verification Hardening

- [x] Reject unknown, duplicate, and non-canonical v200 license keys in
  `src/library/LicenseReader.cpp`.
  Acceptance criteria:
  - A license signed over `valid-to` cannot be mutated into equivalent-looking
    split fields such as `valid=-to...`.
  - Duplicate keys such as two `valid-to` entries are rejected.
  - Unknown fields cannot be silently ignored before signature verification.
  - Rejection emits `LICENSE_MALFORMED`.

- [x] `P0` Close remaining v200 field-shape gaps before verification in
  `src/library/LicenseReader.cpp`.
  Acceptance criteria:
  - `sig` must be strict base64.
  - Raw `lic_ver` must be exactly canonical decimal `200`; `0200`, `+200`,
    whitespace-padded values, duplicate `lic_ver`, and signed non-canonical
    values are rejected.
  - `valid-from` and `valid-to` must use the documented v200 runtime format
    exactly; runtime and generator agree on accepted forms.
  - Impossible calendar dates, leap-day failures, zero month/day, trailing
    garbage, and parser-normalized dates are rejected before signature
    verification.
  - `start-version` and `end-version` must use the supported numeric version
    format.
  - Signed malformed-date and malformed-`lic_ver` fixtures fail with
    `LICENSE_MALFORMED`.
  - Invalid field shape does not throw out of the public API.

- [x] Harden base64 decoding in `src/library/base/base64.cpp`.
  Acceptance criteria:
  - Invalid characters are rejected.
  - Input length must be a multiple of four after line-ending normalization.
  - Padding is accepted only at the end and is limited to two characters.
  - Invalid input returns an empty vector and does not produce partial decoded
    bytes.

- [x] Stop malformed dates and versions from escaping as exceptions.
  Acceptance criteria:
  - `src/library/limits/license_verifier.cpp` converts malformed date/version
    values into `LICENSE_MALFORMED`.
  - `src/library/licensecc.cpp` catches unexpected per-license verification
    exceptions and continues evaluating other located licenses safely.
  - `LicenseInfo` conversion does not throw on malformed expiration data.

- [x] Enforce `start-version` and `end-version` limits in
  `src/library/limits/license_verifier.cpp`.
  Acceptance criteria:
  - Caller version inside `CallerInformations` is required when a license has a
    version bound.
  - Versions below `start-version` or above `end-version` fail with
    `PRODUCT_NOT_LICENSED`.
  - Malformed license bounds fail with `LICENSE_MALFORMED`.
  - Tests cover lower bound, upper bound, matching version, missing caller
    version, and malformed bounds.

- [x] `P0` Audit every license ingestion path for the same strict validation.
  Files to inspect:
  - `src/library/LicenseReader.cpp`
  - `src/library/locate/ExternalDefinition.cpp`
  - `src/library/locate/EnvironmentVarData.cpp`
  - `src/library/locate/FileLicenseLocator.cpp`
  - `src/library/licensecc.cpp`
  Acceptance criteria:
  - File, environment, and externally supplied licenses all pass through the
    same structural validation before signature verification.
  - Invalid encoded external/environment license data produces a deterministic
    `LICENSE_MALFORMED` result through `acquire_license`.
  - Invalid external `license_data_type`, file read races, non-NUL-terminated
    external data, embedded `NUL` bytes, and max-size buffers do not throw out
    of the public API.
  - Tests prove no path can bypass the strict v200 reader.

- [x] `P0` Define and implement multi-source malformed-license behavior.
  Files to inspect or update:
  - `src/library/licensecc.cpp`
  - `src/library/locate/EnvironmentVarData.cpp`
  - `src/library/locate/ExternalDefinition.cpp`
  - `doc/analysis/security-model.rst`
  Acceptance criteria:
  - The policy says whether malformed explicit, environment, or file licenses
    are fatal even when another candidate license is valid.
  - If fail-closed is selected, malformed high-priority sources cannot be
    demoted to warnings by a later valid license.
  - If compatibility requires trying later licenses, the policy is documented
    with source priority, diagnostics, and tests.
  - Tests cover valid+malformed source combinations for file, environment, and
    external license inputs.

- [x] `P0` Make public API boundaries no-throw before and during parsing.
  Files to inspect or update:
  - `src/library/licensecc.cpp`
  - `src/library/LicenseReader.cpp`
  - `src/library/base/file_utils.cpp`
  - `src/library/locate/ExternalDefinition.cpp`
  Acceptance criteria:
  - `acquire_license()` catches locator, reader, base64, and file I/O
    exceptions before the per-license verification loop.
  - Public APIs return deterministic `LICENSE_MALFORMED`,
    `LICENSE_FILE_NOT_FOUND`, or `PRODUCT_NOT_LICENSED` instead of allowing
    exceptions to escape.
  - Tests inject malformed external data, invalid source types, unreadable or
    racing files, and malformed INI content.

- [x] `P0` Add regression fixtures for all known tampering classes.
  Acceptance criteria:
  - Canonical key split tamper is rejected.
  - Duplicate key tamper is rejected.
  - Duplicate `sig`, missing `sig`, and empty `sig` are rejected.
  - Unknown key tamper is rejected.
  - Uppercase or mixed-case key tamper is rejected.
  - Malformed `lic_ver` is rejected.
  - Malformed date tamper is rejected without throwing.
  - Malformed version tamper is rejected without throwing.
  - Mutated product or feature sections do not grant access to the wrong
    feature.
  - Mutated `extra-data` cannot remain valid without a matching signature.
  - Invalid signature base64 is rejected before cryptographic verification.

- [x] `P1` Document the hardened v200 raw-format compatibility matrix.
  Files to inspect or update:
  - `doc/analysis/security-model.rst`
  - `doc/usage/issue-licenses.md`
  - `doc/usage/integration.rst`
  - `test/library/LicenseReader_test.cpp`
  Current verification:
  - `doc/analysis/security-model.rst` defines the raw v200 grammar: LF/CRLF,
    full-line comments, case-insensitive section lookup, duplicate requested
    section rejection, lowercase allowlisted keys, accepted delimiter spellings,
    value whitespace policy, canonical `lic_ver`, canonical base64 `sig`, and
    canonical dates.
  - `doc/usage/issue-licenses.md` documents strict v200 output and tells
    issuers to regenerate old ambiguous or hand-edited licenses instead of
    patching signed text.
  - `doc/usage/integration.rst` documents public outcomes:
    `LICENSE_MALFORMED` for malformed requested sections,
    `PRODUCT_NOT_LICENSED` for missing requested sections, and ignored
    unrelated malformed sections until requested.
  - `test_license_reader` now has
    `v200_raw_format_acceptance_matrix_matches_documentation`, covering CRLF,
    comment lines, section casing, and accepted delimiter forms `key=value`,
    `key= value`, `key =value`, and `key = value`.
  - Passed: `cmake --build build --config Debug --target test_license_reader`
    and `ctest --test-dir build -C Debug -R test_license_reader
    --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L parser --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L security --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug --output-on-failure` with `24/24`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  - Docs-build CI is still tracked separately by the open documentation
    validation item.
  Acceptance criteria:
  - Public docs state the exact accepted v200 raw grammar: section header
    casing policy, line endings, comment lines, `key=value` vs generated
    `key = value` spacing, value whitespace policy, empty values, duplicate
    keys, duplicate requested sections, and unrelated-section behavior.
  - The compatibility matrix states the public result for malformed cases,
    including `LICENSE_MALFORMED` vs `PRODUCT_NOT_LICENSED`.
  - Static or generated fixtures cover every accepted and rejected matrix row.
  - Migration notes warn that older tolerated-but-ambiguous files may now fail
    closed and tell issuers how to reissue canonical v200 licenses.
  - Documentation and tests agree on whether unrelated malformed sections are
    ignored until requested or fatal for all reads.

## P0: Issuance-Side Validation in `lccgen`

- [x] `P0` Validate `--client-signature` before adding it to a generated
  license.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/src/base_lib/base64.cpp`
  - `src/library/hw_identifier/hw_identifier.cpp`
  - `src/library/hw_identifier/hw_identifier.hpp`
  Acceptance criteria:
  - The accepted text form matches `HwIdentifier::print()`: three base64
    groups separated by `-`, for example `AEBC-Q0RF-Rkc=`.
  - Whitespace, raw newlines, extra separators, missing groups, and misplaced
    padding are rejected.
  - Decoded hardware identifier length is exactly 8 bytes.
  - Identification strategy bits `decoded[1] >> 5` must be one of
    `0=ETHERNET`, `1=IP_ADDRESS`, or `2=DISK`.
  - Strategy bit values `3..7` and unimplemented strategies are rejected.
  - Reserved/control bits in `decoded[0]` are rejected unless a documented
    compatibility policy explicitly permits them.
  - Generator and runtime agree on every accepted identifier byte pattern; the
    generator cannot issue a self-invalid hardware-bound license.
  - Tests cover `decoded[0] = 0x01`, `0x3f`, `0x80`, and `0xc0` through both
    `License::add_parameter()` and CLI no-write behavior.
  - Non-canonical strings are rejected by decoding, re-encoding, and requiring
    an exact string match.
  - Empty, truncated, overlong, or partially decoded identifiers are rejected.
  - `lccgen` exits non-zero and prints a specific error for invalid
    `--client-signature`.
  - Invalid input is rejected before any license file is written.

- [x] `P0` Mirror strict base64 rules in the generator.
  Acceptance criteria:
  - Generator and runtime base64 decoders agree on valid and invalid inputs.
  - Tests cover invalid characters, invalid padding, non-final padding, empty
    input, and line-ending normalization.

- [x] `P0` Reject unknown generator output parameters in `License::add_parameter`.
  Files updated:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/license_test.cpp`
  Acceptance criteria:
  - Only v200 license output fields accepted by the runtime reader can be
    serialized by the generator API.
  - `valid-from`, `valid-to`, `client-signature`, `start-version`,
    `end-version`, and `extra-data` are matched by exact name, not substring.
  - Fake fields such as `custom-date`, `custom-version`, and unknown keys are
    rejected instead of being normalized or serialized.
  - The generator cannot create self-invalid v200 licenses by adding fields the
    hardened runtime rejects.

- [x] `P1` Add an explicit policy for weak hardware binding modes.
  Acceptance criteria:
  - IP-address based binding is disabled by default or requires an explicit
    generator flag such as `--allow-ip-binding`.
  - Environment-variable-forced hardware identifiers are not accepted for
    production licenses unless explicitly enabled with a flag such as
    `--allow-env-selected-binding`.
  - A single policy flag such as `--binding-policy=secure|compat|weak` may be
    used if that is simpler than separate flags.
  - Documentation explains why these modes are weak and when they are suitable
    for test or support flows.
  - `lccgen` help text shows the actual three-group client-signature format
    produced by `identify_pc`.

- [x] `P0` Fail closed for unimplemented or ignored key options.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  - `extern/license-generator/src/license_generator/project.hpp`
  - `extern/license-generator/src/license_generator/project.cpp`
  Acceptance criteria:
  - `lccgen project initialize --primary-key` and `--public-key` are either
    wired into project initialization end to end or rejected with a non-zero
    exit status until implemented.
  - Operators cannot believe audited key material was imported while `lccgen`
    silently generates a new key.
  - Tests cover both CLI parsing and resulting project files.
  - Help text does not advertise unsupported key-import behavior.

- [x] `P0` Protect private signing key material during project initialization.
  Files to inspect or update:
  - `CMakeLists.txt`
  - `extern/license-generator/src/base_lib/openssl/crypto_helper_ssl.cpp`
  - `extern/license-generator/src/license_generator/project.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Current verification:
  - `test_project` covers no-overwrite and force-replacement behavior.
  - `test_cryptohelper` covers invalid private-key load errors without echoing
    private key bytes.
  - `test_install_consumer_smoke` scans the staged runtime install for
    private-key files and private-key content markers.
  Acceptance criteria:
  - Private key bytes are never included in exception messages, logs, or
    command output.
  - `private_key.rsa` is created atomically and is not overwritten without an
    explicit operator choice.
  - Key files are written with owner-only permissions where the platform
    supports it.
  - Encrypted private keys or documented passphrase handling are supported, or
    the lack of encryption is documented as an issuer-environment requirement.
  - Source-tree key generation is disabled for release builds or requires an
    explicit opt-in.
  - Runtime/customer packages and install trees are scanned to ensure private
    keys and project-private folders are absent.

- [x] `P1` Harden generator output-file replacement.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Current verification:
  - `license.cpp` now validates output targets before loading or signing and
    rejects destinations named `private_key.rsa`, `public_key.h`, project
    metadata headers, and paths under generated project include metadata.
  - Existing output files must parse as canonical v200 license sections and
    must verify against the current private key before append; malformed
    sections, non-canonical keys, bad signatures, unreadable files, and
    directories fail before replacement.
  - License output is serialized in memory, written to a same-directory
    temporary file, and then atomically replaces the destination
    (`MoveFileExA` on Windows, `rename` on Unix); temp files are cleaned up on
    failure.
  - `test_command-line` covers valid appends, invalid-date preservation,
    directory output failure, protected private/public/metadata target
    preservation, corrupt existing files, bad signatures, and non-canonical
    existing fields.
  - Verification run:
    `ctest --test-dir build -C Debug -R "test_command-line|test_license" --output-on-failure`,
    `ctest --test-dir build -C Debug -L security --output-on-failure`,
    `ctest --test-dir build -C Debug --output-on-failure`, `git diff --check`,
    and `git -C extern/license-generator diff --check`.
  Acceptance criteria:
  - Generated licenses are serialized to a temporary file and atomically
    replace the destination only after validation succeeds.
  - Existing output files are preserved on parse, validation, signing, and
    write failures.
  - Output paths that resolve to `private_key.rsa`, `public_key.h`, or project
    metadata are rejected.
  - Existing v200-looking files with bad signatures or non-canonical fields are
    rejected instead of treated as safe append targets.
  - Tests simulate failed writes and prove the original file is unchanged.

- [x] `P1` Validate generator date ranges and canonical values.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/src/license_generator/project.cpp`
  - `extern/license-generator/test/license_test.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Current verification:
  - `license.cpp` normalizes `valid-from` and `valid-to` through one path and
    rejects `valid-from > valid-to` regardless of parameter order.
  - `license.cpp` validates comma-separated feature lists before signing:
    entries must be non-empty, unique case-insensitively, and contain only
    ASCII letters, digits, `_`, `-`, or `.`.
  - `project.cpp` validates project names as C-identifier-safe tokens before
    creating project folders or generated headers.
  - `extra-data` is rejected when empty, control-character-bearing, or
    whitespace-padded; public docs state the printable/interior-space policy.
  - `test_license`, `test_project`, and `test_command-line` cover invalid
    dates, inverted dates, invalid feature lists, invalid project names,
    invalid `extra-data`, and no-output-file creation for CLI failures.
  Acceptance criteria:
  - `valid-from > valid-to` is rejected like `start-version > end-version`.
  - Feature names, project names, and comma-separated feature lists use an
    explicit allowlist.
  - Empty feature entries, duplicate feature entries, controls, newlines, and
    ambiguous whitespace are rejected.
  - `extra-data` whitespace and control-character handling is documented and
    covered by signed mutation tests.
  - Invalid input returns non-zero and writes no license file.

- [x] `P1` Either implement or remove `lccgen --base64`.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/src/license_generator/license.hpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Current verification:
  - `license.cpp` uses the existing `m_base64` switch to emit no-linebreak
    base64 of the serialized license payload; plain output remains INI.
  - Existing encoded output files are decoded and validated before append, so
    `--base64` does not silently corrupt or treat encoded files as ordinary INI.
  - CLI stdout payloads are no longer followed by `License written`, so stdout
    can be used directly as license data when no `--output-file-name` is given.
  - `test_license` covers direct file and stdout base64 output decoding back to
    valid INI.
  - `test_command-line` covers `--base64` file output, append to an existing
    encoded output, and stdout-only encoded payloads.
  - `test_standard_license` re-enables the encoded-license functional test and
    proves the runtime accepts `lccgen -b` output via `LICENSE_ENCODED`.
  - `doc/usage/issue-licenses.md` documents `--base64` as encoded license data
    for external/environment loading.
  - Verification run:
    `ctest --test-dir build -C Debug -R "test_license|test_command-line|test_standard_license" --output-on-failure`,
    `ctest --test-dir build -C Debug -L security --output-on-failure`,
    `ctest --test-dir build -C Debug --output-on-failure`, `git diff --check`,
    and `git -C extern/license-generator diff --check`.
  Acceptance criteria:
  - If kept, `--base64` emits encoded license data that runtime environment or
    external loading accepts.
  - If removed or deferred, `--base64` fails non-zero and is removed from help
    text.
  - Tests prove the option cannot silently produce ordinary unencoded output.

- [x] `P0` Classify malformed runtime hardware identifiers as malformed
  licenses.
  Files to inspect or update:
  - `src/library/hw_identifier/hw_identifier.cpp`
  - `src/library/hw_identifier/hw_identifier_facade.cpp`
  - `src/library/limits/license_verifier.cpp`
  Acceptance criteria:
  - A signed license with a malformed `client-signature` fails with
    `LICENSE_MALFORMED`.
  - A well-formed client signature for a different machine still fails with
    `IDENTIFIERS_MISMATCH`.
  - Runtime tests cover malformed, unsupported-strategy, and mismatch cases.

## P0/P1: Hardware Identifier Reliability and Privacy

- [x] `P0` Fix Windows disk identifier collection before trusting disk binding.
  Files to inspect or update:
  - `src/library/os/windows/os_win.cpp`
  - `test/library/hw_identifier`
  Acceptance criteria:
  - Windows disk collection never indexes a vector before adding an element.
  - Volume label buffers use the destination buffer size, not an unrelated
    type size.
  - Volume label data is copied into the volume label field, not confused with
    filesystem-name data.
  - Drive root, device path, volume label, filesystem name, serial, and UUID
    are kept as distinct fields until a deliberate identifier is selected.
  - Multiple fixed drives are sorted deterministically, with system-drive
    preference used only as one stable score.
  - A Windows test or mock verifies multiple fixed-drive results without memory
    corruption.

- [x] `P0` Strictly parse `IDENTIFICATION_STRATEGY`.
  Files to inspect or update:
  - `src/library/hw_identifier/hw_identifier_facade.cpp`
  - `test/library/hw_identifier/hw_identifier_facade_test.cpp`
  Acceptance criteria:
  - Full-string parsing rejects junk such as `1abc`, empty values, negative
    values, and out-of-range strategy IDs.
  - Regression tests cover empty string, leading whitespace, plus sign, very
    large numeric input, and valid `0`, `1`, and `2` values.
  - Valid environment-selected `0`, `1`, and `2` identifiers carry the
    env-selected metadata bit.
  - Malformed environment selection does not silently choose IP binding.
  - Runtime returns a deterministic error instead of throwing through the
    public API.

- [x] `P0` Fix default hardware strategy fallback behavior.
  Files to inspect or update:
  - `src/templates/licensecc_properties.h.in`
  - `src/library/hw_identifier/identification_strategy.cpp`
  Acceptance criteria:
  - `STRATEGY_HOST_NAME` and `STRATEGY_NONE` entries are skipped or removed
    from the default sequence unless implemented.
  - `STRATEGY_DEFAULT` returns `FUNC_RET_NOT_AVAIL` when no supported
    identifier can be collected instead of throwing.
  - Docker, cloud, and none-only default sequences return false through
    `identify_pc(STRATEGY_DEFAULT, ...)` deterministically.
  - Tests cover a default sequence containing unsupported or sentinel
    strategies.

- [x] `P0` Enforce weak-binding policy at runtime as well as issuance time.
  Files to inspect or update:
  - `src/library/limits/license_verifier.cpp`
  - `src/library/hw_identifier/hw_identifier.cpp`
  - `src/library/hw_identifier/hw_identifier.hpp`
  - `src/templates/licensecc_properties.h.in`
  - `test/functional/hw_identifier_it_test.cpp`
  Acceptance criteria:
  - Runtime rejects signed IP-address and environment-selected hardware IDs by
    default before hardware matching.
  - `HwIdentifier` exposes strategy and environment-selected metadata so policy
    checks do not reparse text.
  - Policy defaults match the generator defaults.
  - Hosts can opt into weak binding intentionally for support or compatibility
    flows.
  - Tests cover signed IP and environment-selected licenses failing by default
    and passing only with explicit opt-in.

- [x] `P1` Make hardware source selection deterministic.
  Files to inspect or update:
  - `src/library/os/linux/network.cpp`
  - `src/library/os/linux/os_linux.cpp`
  - `src/library/os/windows/network.cpp`
  Current progress:
  - `src/library/os/network.hpp` now exposes bounded adapter identity helpers
    and a bounded IPv4 parser that rejects malformed, overlong, and
    out-of-range octets without mutating the destination bytes on failure.
  - `src/library/os/windows/network.cpp` now uses the bounded IPv4 parser
    instead of the previous hand-rolled unbounded translator.
  - `src/library/os/network.hpp` now exposes `sortAdapterInfos()` with a
    total adapter ordering: non-virtual adapters before virtual/weak
    adapters, stronger MAC/IP identities before weaker identities, known
    physical names before neutral names, then stable type, description,
    MAC-byte, IPv4-byte, and id tie-breakers.
  - `src/library/os/linux/network.cpp` now copies adapters out of the
    `unordered_map` into a temporary vector, filters adapters with neither MAC
    nor IPv4 identity, sorts through `sortAdapterInfos()`, and assigns stable
    ids.
  - `src/library/os/windows/network.cpp` now sorts through
    `sortAdapterInfos()` instead of score-only comparison, so equal-score
    adapters have deterministic tie-breakers.
  - `src/library/os/linux/os_linux.cpp` now applies `/etc/fstab` sources
    through `markLinuxPreferredDiskForFstabSource()`, which mutates
    `DiskInfo` entries by reference for `UUID=`, `LABEL=`, and `/dev/...`
    source forms.
  - `src/library/os/linux/os_linux.cpp` now sorts returned disks through
    `sortLinuxDiskInfos()` after fstab preference detection, ordering
    preferred disks first, strong non-zero serial/UUID metadata ahead of weak
    label-only entries, then stable device, UUID, label, serial bytes, and id
    tie-breakers.
  - `src/library/hw_identifier/ethernet.cpp` now uses the shared non-zero
    MAC/IP identity predicate before generating Ethernet or IP hardware IDs.
  - `src/templates/licensecc_properties.h.in` no longer includes
    `STRATEGY_HOST_NAME` in the generated bare-metal default strategy list.
  - `doc/usage/Hardware-identifiers.rst` and
    `doc/analysis/security-model.rst` document host names and OS machine IDs
    as support diagnostics or deferred v201 inputs, not supported v200 binding
    material.
  - `test/library/hw_identifier/hw_identifier_facade_test.cpp` covers direct
    `STRATEGY_HOST_NAME` requests failing closed through
    `IdentificationStrategy::get_strategy()`,
    `HwIdentifierFacade::generate_user_pc_signature()`, and public
    `identify_pc()`.
  Acceptance criteria:
  - Linux network adapters and disks are sorted by source strength,
    physical/virtual class, interface/device name, MAC/IP/UUID, and stable
    tie-breakers before a client signature is generated.
  - Virtual, tunnel, docker, and veth adapters are filtered or explicitly
    deprioritized by default.
  - Windows IPv4 parsing is bounds-checked or delegated to platform parsing
    APIs.
  - Windows network adapter ordering has explicit tie-breakers for equal
    scores.
  - Reversed-input fixtures produce the same first generated identifier.
  - Linux fstab parsing mutates the intended collection instead of a by-value
    copy.
  Validation evidence:
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_network
    test_hw_identifier test_hw_identifier_facade test_windows_disk_info`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_network|test_hw_identifier|test_hw_identifier_facade|test_windows_disk_info|test_ctest_label_audit"
    --output-on-failure --no-tests=error` with `5/5` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure
    --no-tests=error` with `8/8` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L platform --output-on-failure
    --no-tests=error` with `6/6` tests.
  - Linux runtime execution remains tracked by the separate deterministic
    fixture item below; local WSL currently has `g++ 13.3.0` but no CMake or
    Boost unit-test installation.

- [ ] `P1` Replace weak hardware collector tests with deterministic fixtures.
  Files to inspect or update:
  - `test/library/os/network_test.cpp`
  - `test/library/os/linux_disk_info_test.cpp`
  - `test/library/os/windows_disk_info_test.cpp`
  - `test/library/hw_identifier/hw_identifier_test.cpp`
  Current progress:
  - `test/library/os/network_test.cpp` now covers
    `network_helpers_detect_nonzero_identity`,
    `parse_ipv4_address_accepts_bounded_octets`, and
    `parse_ipv4_address_rejects_malformed_octets`.
  - `test/library/os/network_test.cpp` now covers deterministic adapter
    sorting through
    `sort_adapter_infos_deprioritizes_virtual_and_filters_empty_identity`,
    `sort_adapter_infos_uses_stable_name_and_byte_tie_breakers`, and
    `sort_adapter_infos_is_independent_of_input_order`.
  - `test/library/os_linux_test.cpp` now covers deterministic Linux disk
    source matching and ordering through
    `fstab_source_matching_updates_actual_disk_entries`,
    `fstab_source_matching_reports_missing_metadata`, and
    `sort_linux_disk_infos_is_stable_and_prefers_strong_metadata`.
  - `test_os_linux` is now labeled `security;platform;hardware`, and
    `test/ctest_label_audit.cmake` requires that label set on Linux builds.
  - `test/library/hw_identifier/hw_identifier_facade_test.cpp` now covers
    `host_name_strategy_is_reserved_and_fails_closed`, and strict
    `IDENTIFICATION_STRATEGY` parsing rejects the reserved host strategy value
    `4`.
  - The live adapter test no longer uses the always-true MAC assertion; it now
    requires every reported non-loopback adapter to have a non-zero MAC or
    IPv4 identity.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_network
    test_hw_identifier test_hw_identifier_facade`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_network|test_hw_identifier|test_hw_identifier_facade"
    --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L platform --output-on-failure`.
  - Passed on Windows Debug after key-strength/key-pair/manifest hardening:
    `cmake --build build --config Debug --target test_network
    test_hw_identifier test_hw_identifier_facade test_windows_disk_info`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_network|test_hw_identifier|test_hw_identifier_facade|test_windows_disk_info|test_ctest_label_audit"
    --output-on-failure --no-tests=error` with `5/5` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure
    --no-tests=error` with `8/8` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L platform --output-on-failure
    --no-tests=error` with `6/6` tests.
  - WSL still lacks CMake and Boost unit-test libraries, so `test_os_linux`
    cannot be executed locally without installing Linux build dependencies.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure` with
    `23/23` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure` with `24/24` tests.
  - Passed after the Linux include portability adjustment:
    `cmake --build build --config Debug --target test_network && ctest
    --test-dir build -C Debug -R test_network --output-on-failure`.
  - Passed on Windows Debug after the Linux disk label-audit change:
    `ctest --test-dir build -C Debug -R
    "test_hw_identifier|test_network|test_ctest_label_audit"
    --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L platform --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure` with
    `23/23` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure` with `24/24` tests.
  - Passed on Windows Debug after host/OS machine-ID policy updates:
    `cmake --build build --config Debug --target test_hw_identifier_facade`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R test_hw_identifier_facade
    --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L platform --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure` with
    `23/23` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure` with `24/24` tests.
  - Passed WSL syntax checks with Ubuntu `g++ 13.3.0`:
    `g++ -std=c++17 -DNDEBUG -Iprojects/DEFAULT/include/licensecc/DEFAULT
    -Iinclude -Isrc -c src/library/os/linux/os_linux.cpp -o
    build-wsl-syntax/os_linux.o`.
  - Passed WSL syntax-only test compile with Ubuntu `g++ 13.3.0` and the
    local Boost headers:
    `g++ -std=c++17 -DNDEBUG -Iprojects/DEFAULT/include/licensecc/DEFAULT
    -Iinclude -Isrc -Ibuild/include/Debug
    -I/mnt/c/Users/HEQ/boost_1_87_0_msvc143 -fsyntax-only
    test/library/os_linux_test.cpp`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  - WSL does not have CMake or Boost unit-test libraries installed, so
    `test_os_linux` was syntax-checked but not executed locally; full Linux CI
    execution is still required.
  - This item remains open until `test_os_linux` runs under a Linux CTest
    environment; local Windows validation and WSL syntax checks passed, but
    Linux execution evidence is still missing.
  Acceptance criteria:
  - Mocked Linux and Windows network fixtures cover reversed input order,
    equal-score adapters, virtual/tunnel/docker/veth adapters, malformed IPv4
    strings, missing MAC addresses, and stable tie-breakers.
  - Disk fixtures cover serial+label preferring serial or UUID data, label-only
    fallback requiring explicit weak-binding opt-in, reversed disk order, and
    missing `/etc/fstab` or platform metadata.
  - Stub tests that only assert non-empty output are replaced or removed.
  - Existing always-true assertions, including weak non-zero MAC checks, are
    converted into meaningful expected-value assertions.
  - A machine-name or OS-machine-ID policy is explicitly documented: either it
    is removed from binding, kept only as support diagnostics, or deferred to a
    salted/source-strength-tagged v201 format.

- [x] `P1` Treat disk-label fallback as weak binding.
  Files to inspect or update:
  - `src/library/hw_identifier/disk_strategy.cpp`
  - `src/library/hw_identifier/hw_identifier.cpp`
  - `src/library/os/windows/os_win.cpp`
  - `src/library/base/v201_canonical_payload.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `doc/usage/Hardware-identifiers.rst`
  Current progress:
  - `src/library/hw_identifier/disk_strategy.cpp` now treats non-zero
    serial/UUID-derived disk bytes as the strong disk identifier and does not
    emit a label identifier for disks that already have a strong identifier.
  - Label-only disk identifiers are disabled by default through
    `LCC_ALLOW_WEAK_DISK_LABEL_BINDING=false`; `src/templates/
    licensecc_properties.h.in` exposes the opt-in flag for projects that need
    weak compatibility behavior.
  - `collectDiskIdentifierData()` accepts label-only fallback only when the
    caller passes the explicit weak opt-in.
  - Hardware identifiers now encode weak disk source bits for disk-label
    fallback and mutable Windows volume-serial fallback, while preserving
    serial/UUID-derived disk identifiers as strong.
  - Windows disk collection now derives strong disk bytes from a volume GUID
    when available and treats volume serial data without a GUID as mutable
    weak fallback.
  - v201 licenses with `client-signature` now carry signed
    `client-signature-source-strength` metadata; runtime verification rejects
    missing or inconsistent metadata before hardware matching.
  - `lccgen license issue` derives the source-strength metadata automatically
    and requires `--allow-weak-disk-label-binding` for weak disk fallback
    signatures.
  - `test/library/hw_identifier/hw_identifier_test.cpp` covers
    `disk_identifier_prefers_serial_over_label`,
    `disk_identifier_rejects_label_only_without_weak_opt_in`,
    `disk_identifier_allows_label_only_with_weak_opt_in`,
    `disk_identifier_treats_zero_serial_as_missing_metadata`, and
    `disk_identifier_orders_preferred_strong_ids_first`.
  - `doc/usage/Hardware-identifiers.rst` documents label collision/privacy
    risks, mutable Windows volume-serial fallback, default rejection, the weak
    opt-in flag, and v201 source-strength metadata.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_hw_identifier
    test_hw_identifier_facade test_windows_disk_info`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_hw_identifier|test_hw_identifier_facade|test_windows_disk_info"
    --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L platform --output-on-failure`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure` with
    `23/23` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure` with `24/24` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  - Passed on Windows Debug after v201 source-strength metadata and Windows
    mutable-volume fallback hardening:
    `cmake --build build --config Debug --target test_hw_identifier
    test_windows_disk_info test_license test_command-line
    test_v201_canonical_payload test_generator_v201_canonical_payload
    test_signature_verifier test_standard_license`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_hw_identifier|test_windows_disk_info|test_license$|test_command-line|test_v201_canonical_payload|test_generator_v201_canonical_payload|test_signature_verifier|test_standard_license|test_license_reader"
    --output-on-failure --no-tests=error` with `10/10` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L hardware --output-on-failure
    --no-tests=error` with `8/8` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L v201 --output-on-failure
    --no-tests=error` with `2/2` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `33/33` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Disk binding prefers serial or UUID data over volume labels.
  - Label-derived identifiers are disabled by default or require an explicit
    weak-binding policy.
  - v200 generation either disables label-only disk IDs by default or marks
    them weak at issuance.
  - v201 carries source-strength metadata so runtime can distinguish disk
    serial/UUID binding from label-only fallback.
  - Windows policy distinguishes hardware serial, volume GUID/UUID-derived
    bytes, and mutable volume serial/label data, with fixtures documenting
    which source strengths are accepted by default.
  - Tests cover serial+label preferring serial and label-only requiring opt-in.
  - Documentation explains collision and privacy risks.

- [x] `P1` Document hardware identifier privacy before release.
  Files to inspect or update:
  - `doc/analysis/security-model.rst`
  - `doc/usage/Hardware-identifiers.rst`
  - `examples/minimal/README.md`
  - `src/inspector`
  Evidence:
  - `doc/analysis/security-model.rst`, `doc/analysis/security-notes.rst`, and
    `doc/usage/Hardware-identifiers.rst` state that hardware identifiers may
    contain device or personal data and should be treated as support secrets.
  - `examples/minimal/README.md` tells host applications not to print raw
    hardware identifiers in normal logs.
  - `lccinspector` now redacts generated hardware identifiers, IP addresses,
    and MAC addresses by default. Raw output requires the explicit
    `--raw-hardware-identifiers` diagnostic flag.
  - `test_lccinspector_redaction` covers the redaction helper behavior and is
    included in the `security`, `hardware`, and `platform` CTest labels when
    `LCC_BUILD_INSPECTOR=ON`.
  Acceptance criteria:
  - Public docs state that hardware identifiers may contain device or personal
    data and should be redacted in support artifacts.
  - Support examples avoid printing raw MAC, IP, disk, or host identifiers by
    default.
  - Raw diagnostic output requires an explicit opt-in.
  - `lccinspector` redacts raw hardware signatures, IP addresses, MAC
    addresses, disk labels, and serial-like fields by default or clearly gates
    raw output behind an explicit diagnostic flag.

- [x] `P1` Prevent raw hardware identifiers from leaking through logs and CI
  output.
  Files to inspect or update:
  - `src/library/hw_identifier/hw_identifier_facade.cpp`
  - `src/library/os/linux/os_linux.cpp`
  - `test/functional/hw_identifier_it_test.cpp`
  - `.github/workflows`
  Evidence:
  - `HwIdentifierFacade::validate_pc_signature()` no longer logs the supplied
    raw hardware signature or exception text that can include it; malformed
    identifier diagnostics are generic.
  - `test_it_hw_identifier` prints `Identifier:<redacted>` instead of the live
    generated host identifier.
  - `lccinspector` default output redacts generated hardware signatures, IP
    addresses, MAC addresses, adapter identifiers/descriptions, CPU fields,
    and DMI fields. Raw output requires `--raw-hardware-identifiers`.
  - `test_lccinspector_blackbox_redaction` runs the CLI with default and raw
    diagnostic modes and fails on generated-identifier, IP, MAC, adapter,
    CPU, or DMI patterns in default output.
  - Verified with
    `ctest --test-dir build -C Debug -R "test_lccinspector_redaction|test_lccinspector_blackbox_redaction|test_it_hw_identifier|test_ctest_label_audit" --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - Runtime warnings and errors do not log full raw MAC, IP, disk serial,
    disk label, UUID, host, or generated client-signature values by default.
  - Hardware tests do not print live host identifiers in normal successful CI
    output.
  - Any diagnostic mode that prints raw identifiers is explicitly named,
    disabled by default, and documented as support-sensitive.
  - CI includes a privacy/logging gate that fails on known raw identifier
    patterns emitted by hardware, inspector, or parity tests.

- [x] `P1` Add black-box `lccinspector` redaction coverage.
  Files to inspect or update:
  - `src/inspector/inspector.cpp`
  - `src/inspector/CMakeLists.txt`
  - `test/functional` or `test/library`
  - `.github/workflows`
  Evidence:
  - Added `test/lccinspector_redaction_blackbox.cmake`, which runs
    `lccinspector` with default options and with
    `--raw-hardware-identifiers`, verifies the default output contains
    redaction markers, fails on raw hardware/IP/MAC/adapter/CPU/DMI patterns,
    and verifies raw diagnostic mode changes output without redaction markers.
  - `src/inspector/CMakeLists.txt` registers
    `test_lccinspector_blackbox_redaction` under the `security`, `hardware`,
    and `platform` labels.
  - `test/ctest_label_audit.cmake` requires the black-box redaction test labels
    whenever `LCC_BUILD_INSPECTOR=ON`.
  - Linux and Windows primary CI builds use the default
    `LCC_BUILD_INSPECTOR=ON` for the main tested build; the release-artifact
    notes also state that support tooling packages are not CI-validated release
    artifacts unless a separate tooling-profile pipeline enables the inspector
    gate.
  - Verified with
    `ctest --test-dir build -C Debug -R "test_lccinspector_redaction|test_lccinspector_blackbox_redaction|test_ctest_label_audit" --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - A CLI-level test runs `lccinspector` with default options and verifies raw
    hardware identifiers, IP addresses, MAC addresses, disk labels, serial-like
    fields, adapter descriptions, and DMI/CPU fields are redacted or omitted.
  - A separate explicit raw diagnostic mode test verifies raw output is gated
    by an intentional option.
  - At least one Linux and one Windows CI job builds the inspector and runs the
    redaction gate, or release documentation states inspector packages are not
    CI-validated release artifacts.

- [x] `P2` Carry hardware privacy warnings into public API docs.
  Files to inspect or update:
  - `include/licensecc/licensecc.h`
  - `doc/usage/Hardware-identifiers.rst`
  - `doc/usage/integration.rst`
  Evidence:
  - `include/licensecc/licensecc.h` now documents that `identify_pc()` output
    may contain device, network, disk, host, tenant, or personal data and
    should be redacted from normal logs, support bundles, issue trackers, and
    telemetry by default.
  - `doc/usage/Hardware-identifiers.rst` already describes hardware
    identifiers as support-sensitive data and documents `lccinspector`
    redaction plus the explicit `--raw-hardware-identifiers` diagnostic opt-in.
  - `doc/usage/integration.rst` now distinguishes customer-facing license
    request display from normal application logging/telemetry and references
    the redacted-by-default inspector support workflow.
  - Passed: `python scripts/check_docs_links.py doc`.
  Acceptance criteria:
  - The `identify_pc()` public API comment states that returned identifiers may
    contain device or personal data and should be redacted in logs, support
    bundles, and issue trackers.
  - Public API docs distinguish customer-facing support display from normal
    application logging.
  - The docs describe any raw diagnostic opt-in consistently with
    `lccinspector` behavior.

- [ ] `P2` Add a privacy-preserving hardware identifier format for v201.
  Acceptance criteria:
  - Raw MAC, IP, disk, or host material is hashed with a project-specific salt
    before storage in licenses or support artifacts.
  - The identifier format carries strategy/source-strength metadata.
  - Support tooling can redact raw identifiers by default and require an
    explicit diagnostic mode for raw output.

## P1: Canonical License Format Upgrade

- [x] `P0` Lock current v200-default issuance and version dispatch guard.
  Files to inspect or update:
  - `src/library/base/base.h`
  - `src/library/LicenseReader.cpp`
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  Acceptance criteria:
  - Runtime defines named constants for current v200 and v201 license formats.
  - Runtime parses raw canonical `lic_ver` first, then dispatches to strict v200
    validation or v201 canonical-payload validation.
  - `lccgen license issue` defaults to `--license-version=200`.
  - Explicit `--license-version=200` emits `lic_ver = 200`.
  - Explicit `--license-version=201` emits `lic_ver = 201` with `canonical-v`,
    `sig-v`, `sig-alg`, and `key-id` metadata only when the caller also passes
    `--target-license-format-max=201`.
  - Unsupported or non-canonical values such as `199`, `0200`, `+200`, and
    `200x` fail non-zero.
  - v200 output never contains v201-only fields such as `canonical-v`, `sig-v`,
    `sig-alg`, or `key-id`.
  - v200 remains strict legacy verification; v201 verification never falls back
    to the legacy v200 signed-string path.
  Evidence:
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
    documents the explicit `--license-version` option.
  - `extern/license-generator/src/license_generator/license.cpp` keeps v200 as
    the default and emits v201 only when explicitly requested.
  - `extern/license-generator/test/command-line_test.cpp` covers explicit v200,
    ungated v201 refusal, gated explicit v201 metadata, v201-only field absence
    from v200, and unsupported version issuance.
  - `test/functional/standard-license_test.cpp` covers a generated
    `--license-version 201 --target-license-format-max 201` license verifying
    through `acquire_license()`.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_command-line
    test_license test_standard_license test_signature_verifier`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_command-line|test_license$|test_standard_license|test_signature_verifier|test_crack|test_v201_canonical_payload|test_generator_v201_canonical_payload"
    --output-on-failure --no-tests=error`.

- [x] `P1` Add target-runtime compatibility controls before defaulting or
  broadly recommending v201 issuance.
  Evidence:
  - Runtime now parses and verifies explicit `lic_ver=201` licenses through the
    v201 canonical payload contract.
  - Generator default issuance remains v200.
  - Explicit `--license-version=201` now requires
    `--target-license-format-max=201`; without that compatibility signal,
    issuance fails before writing the output file.
  - Docs now tell issuers to use v201 only for runtimes known to verify v201 and
    preserve v200 as the default migration format.
  - Generated `licensecc_properties.h` exposes
    `LCC_SUPPORTED_LICENSE_FORMAT_MIN=200` and
    `LCC_SUPPORTED_LICENSE_FORMAT_MAX=201`.
  - Release manifests record `LCC_RELEASE_LICENSE_FORMAT_MIN` and
    `LCC_RELEASE_LICENSE_FORMAT_MAX`.
  - Installed CMake packages expose `licensecc_LICENSE_FORMAT_MIN/MAX`,
    `LICENSECC_LICENSE_FORMAT_MIN/MAX`, and matching target properties on
    `licensecc::licensecc_static`.
  - Runtime artifact scanning validates that manifest supported-format metadata
    is numeric and matches installed generated properties.
  - `test_command-line` covers ungated v201 refusal and gated v201 success.
  - `test_install_consumer_smoke`, `test_package_consumer_smoke`,
    `test_artifact_scan_smoke`, and `test_manifest_summary_smoke` cover the
    package metadata and manifest validation path.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_command-line|test_license$|test_standard_license|test_install_consumer_smoke|test_package_consumer_smoke|test_artifact_scan_smoke|test_manifest_summary_smoke"
    --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - Runtime dual-support for v200 and v201 ships before `lccgen` emits v201 by
    default.
  - During the dual-support window, default issuance remains v200.
  - v201 issuance requires a documented minimum target runtime version, an
    explicit compatibility flag, or both.
  - The generator refuses v201 when target runtime support is unknown or below
    the first v201-capable release.
  - Runtime/package metadata exposes supported license format ranges for
    downstream checks.
  - Later default-to-v201 cutover keeps `--license-version=200` for legacy
    deployments.
  - Compatibility docs state that current releases default to v200, explicit
    v201 requires a v201-capable runtime, and old runtimes reject v201.

- [x] `P1` Design `lic_ver=201` with an unambiguous signed payload.
  Files to inspect or update:
  - `src/library/base/base.h`
  - `src/library/LicenseReader.cpp`
  - `src/library/limits/license_verifier.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  Current progress:
  - v201 signed bytes start with `licensecc:v201\n`.
  - v201 canonical payloads use explicit key/value length frames and a fixed
    field order shared by runtime and generator-side contract tests.
  - The v201 canonical payload includes `lic_ver`, `canonical-v`, `sig-v`,
    `sig-alg`, `key-id`, compiled project identifier, requested feature name,
    and optional validity/version/client-binding/extra-data fields.
  - Runtime v201 verification fails malformed when the canonical payload cannot
    be reconstructed and fails corrupted when canonical bytes or key metadata
    are tampered after signing.
  - The generator serializer emits v201 storage fields from this contract for
    explicit `--license-version=201 --target-license-format-max=201` issuance.
  Evidence:
  - `src/library/base/v201_canonical_payload.cpp` and
    `extern/license-generator/src/base_lib/v201_canonical_payload.cpp` define
    the runtime and generator canonical payload builders.
  - `src/library/limits/license_verifier.cpp` and
    `extern/license-generator/src/license_generator/license.cpp` use those
    builders for v201 verification and issuance.
  - `test_v201_canonical_payload`,
    `test_generator_v201_canonical_payload`, `test_signature_verifier`, and
    `test_standard_license` cover byte-exact payloads, generated v201
    verification, metadata tampering, and downgrade rejection.
  Acceptance criteria:
  - The signed bytes start with a fixed domain marker such as
    `licensecc:v201\n`.
  - Every signed field is length-framed, for example by explicit key and value
    byte lengths.
  - `sig` is never included in the signed payload.
  - A single canonical key order is used by generator and verifier, either fixed
    order or byte-stable lowercase key sorting.
  - The payload includes every security-critical field.
  - The payload includes `lic_ver`, `canonical-v`, `sig-v`, `sig-alg`,
    `key-id`, product/project identifier, feature name, validity bounds,
    version bounds, client binding, extra data, and every signed license field.
  - The canonical policy defines absent vs empty values, max key/value lengths,
    character encoding, and control-byte handling.
  - Field semantics are enumerated explicitly instead of using an open-ended
    "security-critical" definition.
  - Unknown critical fields cannot be ignored.
  - Control characters in signed values are rejected unless explicitly encoded
    by the canonical format.
  - Downgrading a v201 license into v200 syntax fails closed.
  - Verification does not fall back from v201 canonical verification to v200
    concatenation rules.
  - Calendar dates are validated strictly; impossible dates, trailing garbage,
    and ambiguous forms are rejected before signing or verification.
  - The verifier rejects non-canonical encodings.

- [x] `P1` Add a shared v201 canonical payload API before serializer/verifier
  work.
  Files to inspect or update:
  - `src/library/base`
  - `src/library/LicenseReader.cpp`
  - `extern/license-generator/src/license_generator`
  - `test/functional`
  Current progress:
  - `src/library/base/v201_canonical_payload.hpp` and `.cpp` define a v201
    canonical payload builder that emits bytes beginning with
    `licensecc:v201\n`.
  - The builder uses fixed field order and explicit lowercase-hex length
    frames for each key and value; `sig` is refused as signed input.
  - The builder requires `lic_ver=201`, `canonical-v=1`, `sig-v=1`,
    `sig-alg=rsa-pkcs1-sha256`, `key-id=sha256:<64 lowercase hex>`,
    `project`, and canonical uppercase `feature`.
  - Optional `valid-from`, `valid-to`, `start-version`, `end-version`,
    `client-signature`, and `extra-data` are omitted when absent; empty values,
    control bytes, duplicate keys, unknown keys, malformed dates, malformed
    versions, and inverted date/version bounds fail before signature
    verification.
  - `test_v201_canonical_payload` covers the byte-exact minimal payload,
    shuffled input stability, full optional-field ordering, and fail-closed
    negative cases.
  - `extern/license-generator/src/base_lib/v201_canonical_payload.hpp` and
    `.cpp` mirror the same canonical payload contract for the generator side
    so v201 issuance builds signed bytes through a dedicated API
    instead of the legacy `print_for_sign()` path.
  - `test_generator_v201_canonical_payload` uses the same byte-exact minimal
    payload and ordering expectations as the runtime test, plus generator-side
    fail-closed metadata checks.
  - Runtime `LicenseReader` and `LicenseVerifier` now dispatch `lic_ver=201`
    sections to the v201 canonical payload builder before signature
    verification.
  - Generator `License::write_license()` now dispatches explicit gated
    `--license-version=201` issuance to the generator-side v201 canonical
    payload builder before signing.
  Remaining work:
  - Replace duplicated test-vector literals with a shared fixture file if the
    test surface grows beyond the current minimal/full vectors.
  - Add golden vectors for actual signed v201 licenses.
  Acceptance criteria:
  - Generator and runtime call the same canonicalization contract or share
    byte-for-byte test vectors that make drift impossible to miss.
  - The API returns canonical payload bytes and explicit parse/validation
    errors; it does not expose ad hoc signed-string concatenation.
  - Golden tests include hex payload bytes, decoded field maps, and expected
    storage form for minimal, full, feature-bound, hardware-bound, and
    extra-data licenses.
  - Unknown critical fields, duplicate fields, non-canonical encodings, and
    delimiter/ordering changes fail before signature verification.
  - The v201 implementation cannot call the v200 `printForSign()` or generator
    `print_for_sign()` paths.

- [x] `P1` Implement an explicit dedicated v201 serializer in the generator.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/license_test.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  - `test/functional/standard-license_test.cpp`
  Current verification:
  - `License::set_license_file_version("201")` selects the v201 path.
  - `License::write_license()` writes `canonical-v=1`, `sig-v=1`,
    `sig-alg=rsa-pkcs1-sha256`, and `key-id=sha256:<public-key-sha256>` from
    the generated public-key header.
  - v201 signing uses
    `extern/license-generator/src/base_lib/v201_canonical_payload.cpp`
    instead of the legacy `print_for_sign()` payload.
  - `test_command-line` verifies ungated v201 refusal plus gated explicit v201
    CLI emission and metadata.
  - `test_standard_license` verifies a generated explicit v201 license through
    the runtime `acquire_license()` path.
  - Default issuance still emits v200 during the compatibility window.
  Acceptance criteria:
  - `lccgen --license-version=201 --target-license-format-max=201` emits a
    v201 license with required metadata.
  - Default `lccgen license issue` continues to emit v200 until the documented
    cutover item is complete.
  - Runtime and generator canonical payload unit vectors produce identical
    bytes for the same logical license.
  - Reordering fields in the display/storage format does not change semantic
    parsing and does not change canonical signed bytes.
  - Unknown generator API parameters remain rejected instead of being
    serialized.
  - Generator date and version validation matches runtime validation.

- [ ] `P1` Plan and gate the future default-to-v201 cutover.
  Acceptance criteria:
  - `lccgen` emits v201 by default only after target-runtime compatibility
    controls, migration docs, release notes, and golden signed vectors exist.
  - `--license-version=200` remains supported and tested for legacy runtime
    deployments after the cutover.
  - CI has a default-issued-license test that changes from v200 to v201 in the
    same patch as the documented default change.
  - The cutover release notes state exact runtime versions that can verify
    v201 and warn that older runtimes reject v201.

- [x] `P1` Implement a dedicated v201 verifier in the runtime library.
  Files to inspect or update:
  - `src/library/LicenseReader.cpp`
  - `src/library/limits/license_verifier.cpp`
  - `src/library/os/signature_verifier.hpp`
  Evidence:
  - `src/library/LicenseReader.cpp` validates `lic_ver=201` sections with the
    v201 metadata allowlist and rejects missing `canonical-v`, `sig-v`,
    `sig-alg`, `key-id`, or `sig` fields before verification.
  - `src/library/limits/license_verifier.cpp` reconstructs v201 signed bytes
    through `license::v201::build_canonical_payload()` and returns
    `LICENSE_MALFORMED` if canonical reconstruction fails.
  - `src/library/os/signature_verifier.hpp` defines a separate
    `current_v201_signature_policy()` so v201 requests cannot pass through the
    v200 policy by version fallback.
  - `test_signature_verifier` covers valid v201 verification, reordered v201
    storage, v201 with a v200-style signature, v201 signature-algorithm
    tampering, v201 key-id tampering, and v200 rejection of v201-only fields.
  Acceptance criteria:
  - v201 verification does not reuse ad hoc INI concatenation rules.
  - Verification fails if the canonical payload cannot be reconstructed exactly.
  - `lic_ver=200` uses legacy payload construction plus strict v200 validation.
  - `lic_ver=201` uses only v201 canonical payload construction.
  - There is no fallback from v201 verification to v200 verification.

- [x] `P1` Add cross-version compatibility tests.
  Evidence:
  - Existing v200 generator/API tests continue to pass.
  - `test_signature_verifier` now covers valid v201 runtime verification,
    reordered v201 storage verification, v201 rejection with a v200-style
    signature, and v200 malformed rejection when v201-only fields are present.
  - `test_standard_license` now covers an explicit v201 license generated by
    `lccgen` and verified by the runtime `acquire_license()` path.
  - `test_license_reader` now covers v201 delimiter/whitespace acceptance and
    rejection cases for `key=value`, `key= value`, `key =value`,
    `key = value`, extra key spacing, tab spacing, uppercase keys, leading
    whitespace, and trailing value whitespace.
  - `doc/usage/migration-guide.rst` documents the installed runtime format
    range (`licensecc_LICENSE_FORMAT_MAX` and
    `LCC_SUPPORTED_LICENSE_FORMAT_MAX`) and states that v200-only runtimes
    reject `lic_ver = 201`.
  Acceptance criteria:
  - v200 valid license still passes during the compatibility window.
  - v201 valid license passes.
  - v201 license with a v200-style signature fails.
  - v200 license with v201-only fields fails unless those fields are explicitly
    allowed by the v200 policy.
  - Reordered v201 storage fields verify if the reconstructed canonical payload
    is unchanged.
  - Whitespace around storage delimiters is handled only according to the
    documented parser rules.

- [x] `P1` Add a first-class v201 reader negative matrix.
  Files to inspect or update:
  - `src/library/LicenseReader.cpp`
  - `test/library/LicenseReader_test.cpp`
  - `test/functional/crack_test.cpp`
  Evidence:
  - `test/library/LicenseReader_test.cpp` now covers missing required v201
    metadata (`canonical-v`, `sig-v`, `sig-alg`, `key-id`, and `sig`),
    duplicate v201 `lic_ver` and `sig`, duplicate requested sections, unknown
    keys, empty keys, noncanonical `lic_ver` forms, malformed delimiter/value
    spacing, malformed v201 signature base64, high-bit bytes, embedded NULs,
    and requested-vs-unrelated section behavior.
  - `src/library/LicenseReader.cpp` now rejects raw license content containing
    embedded NUL bytes before SimpleIni can truncate values into valid-looking
    shorter strings.
  - `src/library/base/string_utils.cpp` now casts bytes before `isspace()` and
    `toupper()` calls used by parser trimming and section normalization, so
    high-bit bytes fail closed instead of tripping debug CRT assertions.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_license_reader
    test_license_locator test_public_api`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_license_reader|test_license_locator|test_public_api|test_base64|test_v201_canonical_payload"
    --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - Tests cover missing required v201 metadata: `canonical-v`, `sig-v`,
    `sig-alg`, `key-id`, and `sig`.
  - Tests cover duplicate v201 keys, duplicate requested v201 sections,
    unknown v201 storage keys, uppercase keys, empty keys, key whitespace, and
    malformed delimiter spacing.
  - Tests cover bad v201 `sig` base64, including bad padding, non-zero pad
    bits, embedded NUL, high-bit bytes, and truncated data.
  - Tests cover noncanonical `lic_ver` variants such as `0201`, `+201`,
    whitespace-padded values, duplicate values, and `201x`.
  - Malformed requested v201 sections return `LICENSE_MALFORMED` before
    signature verification and do not grant access through unrelated valid
    sections.

- [x] `P1` Add full generated-v201 end-to-end verification tests.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/license_test.cpp`
  - `test/functional/standard-license_test.cpp`
  - `test/functional/signature_verifier_test.cpp`
  Current progress:
  - `test_standard_license` now generates a v201 license containing date
    bounds, version bounds, a host client signature, and `extra-data`, then
    verifies it through `acquire_license()`.
  - The same functional test mutates each generated optional signed field and
    asserts the runtime denies the license with a signature-mismatch
    diagnostic.
  - Malformed optional-field parity is covered by
    `verify_v201_optional_field_semantics_fail_closed_at_documented_stage`,
    runtime/generator canonical-payload negative matrices, and generator
    parameter validation tests.
  - Verified with
    `ctest --test-dir build -C Debug -R test_standard_license --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - `lccgen -> license file -> acquire_license()` succeeds for generated v201
    licenses containing date bounds, version bounds, client signatures, and
    `extra-data`.
  - Per-field tampering of generated v201 optional fields fails through the
    runtime API with deterministic diagnostics.
  - Runtime and generator agree on malformed optional-field behavior for
    `client-signature`, `extra-data`, date bounds, and version bounds.
  - Tests prove v201 optional fields are signed by mutating each field after
    issuance and observing a denial, not a truncated or partially accepted
    success.

- [ ] `P1` Define parser character-encoding and control-byte policy.
  Files to inspect or update:
  - `src/library/base/string_utils.cpp`
  - `src/library/LicenseReader.cpp`
  - `src/library/base/v201_canonical_payload.cpp`
  - `extern/license-generator/src/base_lib/v201_canonical_payload.cpp`
  - `test/library/LicenseReader_test.cpp`
  - `test/library/v201_canonical_payload_test.cpp`
  Current progress:
  - Runtime trimming and uppercase normalization now cast to `unsigned char`
    before calling `isspace()` or `toupper()`.
  - Raw license data containing embedded NUL bytes is rejected before INI
    parsing, preventing C-string truncation of signed fields.
  - `test_license_reader` covers high-bit and embedded-NUL v201 signature
    inputs through direct reader fixtures.
  - Runtime and generator v201 canonical payload builders now use explicit
    ASCII byte predicates instead of locale-sensitive `ctype` classification
    for canonical keys, project names, feature names, and generic value bytes.
  - v201 canonical values are restricted to printable ASCII bytes
    (`0x20` through `0x7e`); control bytes, DEL, and high-bit bytes fail before
    signing or verification.
  - `test_v201_canonical_payload` and
    `test_generator_v201_canonical_payload` cover high-bit keys, control-byte
    values, DEL values, and high-bit `extra-data` values.
  - `doc/analysis/security-model.rst`, `doc/usage/migration-guide.rst`, and
    `doc/usage/integration.rst` document that raw embedded NUL bytes are
    malformed and that v201 canonical fields are printable ASCII, not UTF-8 or
    arbitrary binary text.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_v201_canonical_payload
    test_generator_v201_canonical_payload test_license_reader
    test_standard_license`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_v201_canonical_payload|test_generator_v201_canonical_payload|test_license_reader|test_standard_license"
    --output-on-failure --no-tests=error`.
  - This item remains open until the same parser and v201 canonical-payload
    byte cases run under ASan/UBSan or equivalent sanitizer coverage.
  Acceptance criteria:
  - v200 and v201 docs state whether license files are ASCII-only, UTF-8, or a
    stricter byte grammar.
  - Parser helpers avoid undefined behavior from `ctype` calls on signed
    `char`; high-bit bytes are cast or rejected before classification.
  - Tests cover high-bit bytes, embedded NUL, CR/LF variants, tabs, and control
    characters in keys and values under sanitizer builds.
  - The generator rejects or encodes the same character classes that the
    runtime rejects before verification.

- [x] `P1` Decide and test v201 optional-field semantic parity.
  Files to inspect or update:
  - `src/library/base/v201_canonical_payload.cpp`
  - `src/library/limits/license_verifier.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `test/library/v201_canonical_payload_test.cpp`
  - `extern/license-generator/test/license_test.cpp`
  Current verification:
  - `doc/analysis/security-model.rst` states the v201 policy split:
    malformed date/version optional fields fail during canonical-payload
    reconstruction before crypto, while malformed or empty
    `client-signature` and empty/oversized `extra-data` fail during runtime
    limit validation after the payload verifies.
  - `test_signature_verifier` covers signed malformed `client-signature`,
    signed oversized `extra-data`, empty `client-signature`, empty date/version
    bounds, empty `extra-data`, and canonical date/version failures.
  - Runtime and generator canonical-payload tests now share the same negative
    matrix for noncanonical feature names, bad/inverted dates, bad/inverted
    version bounds, duplicate fields, missing required fields, unknown fields,
    and non-printable/non-ASCII values.
  - Generator `license_test` continues to reject malformed
    `client-signature`, `extra-data`, date, and version parameters before
    issuance.
  - Verified with
    `ctest --test-dir build -C Debug -R "test_signature_verifier|test_generator_v201_canonical_payload|test_v201_canonical_payload" --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - The policy states which malformed optional fields fail before crypto and
    which fail during runtime limit verification.
  - Generator and runtime tests cover the same accepted/rejected shapes for
    `client-signature`, `extra-data`, date bounds, version bounds, and absent
    vs empty values.
  - Runtime errors remain fail-closed and deterministic even when malformed
    optional fields are signed by an older or external issuer.

## P0/P1: Cryptographic Algorithm and Key Management

- [x] `P0` Add a policy-aware signature verification interface before v201.
  Files to inspect or update:
  - `src/library/os/signature_verifier.hpp`
  - `src/library/os/openssl/signature_verifier.cpp`
  - `src/library/os/windows/signature_verifier.cpp`
  - `src/library/limits/license_verifier.cpp`
  Current verification:
  - `SignatureVerificationRequest` carries payload bytes, signature bytes,
    declared algorithm, key ID, license version, and explicit policy.
  - The v200 runtime verifier uses the policy-aware path with exact
    `rsa-pkcs1-sha256` and the generated embedded public-key ID.
  - `test_signature_verifier` covers positive legacy v200 verification and
    fail-closed behavior for algorithm case aliases, unknown algorithms,
    unknown key IDs, and wrong license-version policy.
  - The security CTest label runs the same signature policy tests on the active
    platform; Linux and Windows workflows both run the security gate.
  Acceptance criteria:
  - Runtime verification accepts payload bytes, signature bytes, declared
    algorithm, key ID, and license-version policy.
  - Algorithm and key selection come from an explicit allowlist, not inference
    from key material.
  - Unknown algorithm, unknown key ID, algorithm alias/case variants, and
    algorithm/key mismatches fail closed.
  - v200 can continue using legacy `rsa-pkcs1-sha256` while v201 can enforce a
    stronger policy.
  - OpenSSL and Windows implementations agree on every positive and negative
    vector.

- [ ] `P1` Replace RSA-1024 defaults with a modern signing profile.
  Files to inspect or update:
  - `extern/license-generator/src/base_lib/openssl/crypto_helper_ssl.cpp`
  - `extern/license-generator/src/base_lib/openssl/crypto_helper_ssl.hpp`
  - `extern/license-generator/src/base_lib/win/CryptoHelperWindows.cpp`
  - `extern/license-generator/src/license_generator/project.cpp`
  - `extern/license-generator/src/license_generator/project.hpp`
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  - `src/library/os/openssl/signature_verifier.cpp`
  - `src/library/os/windows/signature_verifier.cpp`
  Current progress:
  - OpenSSL and Windows key-generation defaults now create RSA-3072 keys.
  - `Project` initialization defaults to RSA-3072 and passes the selected key
    size into the crypto backend.
  - `lccgen project init` exposes `--legacy-rsa1024` as the only CLI path for
    issuing a new RSA-1024 project key.
  - Explicit legacy RSA-1024 generation remains available for compatibility;
    invalid generated key sizes below 1024 bits, above 4096 bits, or not aligned
    to 1024-bit increments are rejected.
  - Generator tests assert default public keys are RSA-3072-sized and explicit
    legacy keys remain RSA-1024-sized.
  - Release install/package guards now require generated public-key headers to
    declare RSA algorithm, modulus bit length, and signature algorithm
    metadata. They reject headers below the configured RSA bit minimum and keep
    `PUBLIC_KEY_LEN` as additional DER-length consistency metadata.
  - The release manifest records generated public-key DER length, algorithm,
    modulus bit length, and signature algorithm for install/package scanner
    verification.
  Remaining work:
  - Add a named modern signing profile, preferably RSA-PSS-SHA256 with pinned
    salt/MGF1 parameters or a compact modern algorithm if platform support is
    selected.
  - Add license-version policy so new versions reject RSA-1024 at verification
    time while v200 remains legacy-compatible.
  - Add Linux/Windows cross-platform golden vectors for modern signatures and
    legacy RSA-1024 rejection in new license versions.
  Acceptance criteria:
  - Crypto policy constants define legacy `rsa-pkcs1-sha256` for v200
    verification only.
  - New default is `rsa-pss-sha256` with RSA-3072 or a modern compact signature
    scheme such as Ed25519, depending on platform support decisions.
  - RSA-1024 is not generated by default.
  - RSA-1024 issuance is available only through an explicit legacy option if it
    remains available at all.
  - Verifier can reject RSA-1024 for new license versions.
  - Existing v200 RSA-1024 support, if retained, is explicitly marked legacy.
  - Linux/OpenSSL and Windows-generated licenses verify on both platforms.

- [x] `P1` Enforce runtime key strength by license-version policy.
  Files to inspect or update:
  - `src/library/os/signature_verifier.hpp`
  - `src/library/os/openssl/signature_verifier.cpp`
  - `src/library/os/windows/signature_verifier.cpp`
  - `test/functional/signature_verifier_test.cpp`
  Current progress:
  - `SignatureVerificationPolicy` now carries `min_public_key_bits`; v201 sets
    the runtime floor to RSA-3072 while legacy v200 leaves the floor disabled
    for compatibility.
  - The shared policy gate derives embedded key strength from generated
    `LCC_PUBLIC_KEY_BITS` metadata and derives external test-vector strength by
    parsing PKCS#1 RSA public-key DER before either the OpenSSL or Windows
    verifier backend is called.
  - Malformed public-key DER cannot satisfy the v201 key-strength gate even if
    its key ID is recomputed and allowlisted.
  Evidence:
  - `test_signature_verifier` covers v200 acceptance for RSA-1024/2048/3072/4096,
    v201 rejection for RSA-1024 and RSA-2048, v201 acceptance for RSA-3072 and
    RSA-4096, embedded public-key metadata meeting the v201 floor, and malformed
    DER key-size metadata denial.
  - Validation command:
    `ctest --test-dir build -C Debug -R test_signature_verifier --output-on-failure --no-tests=error`
  Acceptance criteria:
  - `SignatureVerificationPolicy` can express a minimum public-key strength for
    formats that require it, without breaking legacy v200 verification.
  - v201 or the next default issuance format rejects RSA-1024 public keys at
    verification time even when the signature is otherwise valid.
  - OpenSSL and Windows verifier paths derive and compare public-key strength
    consistently for embedded keys and test vectors.
  - Tests cover legacy v200 RSA-1024 compatibility, new-version RSA-1024
    rejection, RSA-3072 success, and malformed key-size metadata denial.

- [x] `P1` Add issuer and release key-pair consistency checks.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/project.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `cmake/CheckReleaseProject.cmake`
  - `cmake/ScanReleaseArtifact.cmake`
  - `test/release_safety_smoke.cmake`
  Current progress:
  - `lccgen project validate-keypair` loads the issuer private key, exports its
    public key, and compares it against generated `public_key.h` bytes and
    metadata: DER length, RSA bit length, SHA-256, key ID, public-key algorithm,
    and signature algorithm.
  - v201 `license issue` performs the same public-key/header/private-key
    consistency check before signing, so a license is not written with a key ID
    from one project and a signature from another private key.
  - `release_project_guard` passes the built `lccgen` path into
    `CheckReleaseProject.cmake`, so Release/RelWithDebInfo build guards reject
    a private key that does not match the generated public key.
  - CPack gets the per-config `lccgen` path through generated
    `LicenseccLccgenPath-<config>.cmake`, so package-time project checks reject
    mismatched issuer keypairs while still honoring explicit CPack opt-outs for
    local default-project packaging.
  Evidence:
  - `test_command-line` covers successful `project validate-keypair`, failure
    for a swapped private key, and v201 issuance failure without creating an
    output license when the selected private key does not match the generated
    `public_key.h`.
  - `test_release_safety_smoke` now generates two real project keypairs, swaps
    only the private key for one staged project, and verifies both
    `release_project_guard` and CPack reject the mismatch with a class-level
    error that does not print key material.
  - Validation command:
    `ctest --test-dir build -C Debug -R "test_command-line|test_license" --output-on-failure --no-tests=error`
  - Validation command:
    `ctest --test-dir build -C Debug -R test_release_safety_smoke --output-on-failure --no-tests=error`
  Acceptance criteria:
  - Issuance fails if `private_key.rsa` does not match the generated
    `public_key.h` metadata used by the runtime.
  - Release install/package guards verify the selected project private key,
    public-key DER, public-key ID, algorithm, bit length, and signature policy
    are mutually consistent before packaging.
  - Mismatched public/private key fixtures fail before a customer runtime
    artifact can be produced.
  - Error output identifies the mismatch class without printing private key
    material or full public-key bytes.

- [x] `P0` Remove Windows fixed RSA-1024 assumptions before increasing key
  sizes.
  Files to inspect or update:
  - `src/library/os/windows/signature_verifier.cpp`
  - `extern/license-generator/src/base_lib/win/CryptoHelperWindows.cpp`
  Current verification:
  - Windows runtime verification imports dynamic PKCS#1 RSA public-key DER from
    `SignatureVerificationRequest::public_key_der` instead of a fixed
    1024-bit struct.
  - DER length parsing uses canonical big-endian DER lengths and rejects
    non-canonical multi-byte length encodings.
  - Windows generator key export parses CNG/CryptoAPI legacy private-key blobs
    from the declared key size instead of fixed RSA-1024 arrays.
  - `test_signature_verifier` generates 1024, 2048, 3072, and 4096-bit RSA
    keys, signs test payloads, verifies them through the runtime policy
    interface, rejects mutated signatures, and rejects malformed public-key DER.
  - The Windows security and full CTest suites pass locally.
  Acceptance criteria:
  - Windows verification imports public keys from dynamic DER/SPKI or CNG key
    formats without assuming a 1024-bit modulus.
  - DER length parsing and encoding handle multi-byte lengths in canonical
    byte order.
  - Windows signing/generation supports at least 2048, 3072, and 4096-bit RSA if
    RSA remains supported.
  - Tests cover Windows import and verification for each supported modulus size.
  - OpenSSL-generated licenses verify on Windows and Windows-generated licenses
    verify on OpenSSL for every supported key size.
  - DER length parsing rejects non-canonical or malformed multi-byte lengths.

- [ ] `P1` Add cross-platform key-size signature vectors and evidence.
  Files to inspect or update:
  - `test/functional/signature_verifier_test.cpp`
  - `test/vectors`
  - `.github/workflows/linux.yml`
  - `.github/workflows/windows.yml`
  Acceptance criteria:
  - Checked-in vectors include OpenSSL-generated and Windows-generated
    signatures for every supported RSA modulus size during the compatibility
    window.
  - Linux/OpenSSL verifies Windows-generated vectors and Windows/CryptoAPI
    verifies OpenSSL-generated vectors.
  - The parity report identifies backend, vector, key size, algorithm, and
    pass/fail without printing private keys or full license contents.
  - The checklist records exact green Linux and Windows CI runs before this is
    used as release evidence.

- [x] `P1` Add algorithm and key-id fields to generated public metadata and
  v201 licenses.
  Files to inspect or update:
  - `src/library/os/signature_verifier.hpp`
  - `src/templates/public_key.inja`
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  Current progress:
  - Generated `public_key.h` now includes `LCC_PUBLIC_KEY_ALGORITHM`,
    `LCC_PUBLIC_KEY_BITS`, `LCC_PUBLIC_KEY_SHA256`, `LCC_PUBLIC_KEY_ID`, and
    `LCC_SIGNATURE_ALGORITHM`. The key ID is `sha256:<hex>` over the generated
    PKCS#1 DER public-key bytes.
  - `Project::initialize()` regenerates stale public-key metadata from an
    existing private key when the existing public header lacks
    current key ID, algorithm, bit-length, or signature-algorithm fields.
  - v200 runtime verification now builds its policy from the generated embedded
    public-key ID instead of a hardcoded placeholder key ID.
  - Direct verifier requests that provide explicit `public_key_der` now require
    `key_id` to equal `sha256:<SHA-256(public-key DER)>` before signature
    verification, so tests and future key-ring code cannot pair one key ID with
    different key bytes.
  - Generator and CLI tests assert generated public-key headers carry `rsa`,
    exact `3072`/`1024` bit metadata for default/legacy keys, the legacy
    `rsa-pkcs1-sha256` signature algorithm, and a `sha256:` key ID.
  - Explicit `--license-version=201` output now includes signed `sig-alg` and
    `key-id` fields, populated from the generated `public_key.h` metadata.
  - `test_command-line` verifies v201 CLI output includes
    `sig-alg=rsa-pkcs1-sha256` and a `sha256:<64 hex>` key ID.
  - `test_standard_license` verifies generated v201 output through runtime
    `acquire_license()`.
  - `test_signature_verifier` covers the key-id/public-key mismatch path and
    still verifies malformed public-key DER with a matching derived key ID, so
    DER parser rejection remains covered separately from key-id policy
    rejection.
  - A direct verification check confirmed the generated `LCC_PUBLIC_KEY_SHA256`
    matches SHA-256 over the emitted public-key DER bytes in the build-tree
    `public_key.h`.
  Acceptance criteria:
  - `SignatureAlgorithm`, `KeyId`, and `PublicKeyRecord` concepts exist in the
    generator and runtime code.
  - `key-id` is derived from SHA-256 of one pinned canonical public-key
    representation, currently PKCS#1 public-key DER, and is stored as
    `sha256:<64 lowercase hex>`.
  - Generated `public_key.h` contains key ID, algorithm, bit length, signature
    algorithm, and public-key bytes.
  - v201 licenses carry signed `sig-alg` and `key-id` fields.
  - The verifier checks signed v201 `key-id` against the embedded public key
    policy.
  - The verifier checks the declared algorithm against an allowlist.
  - The verifier does not infer algorithm solely from key material.
  - Unknown `key-id` or algorithm fails closed.
  - Tampering `sig-alg`, `key-id`, or `lic_ver` fails verification.

- [ ] `P1` Make public-key customization explicit and repeatable.
  Files to inspect or update:
  - `CMakeLists.txt`
  - `src/templates/public_key.inja`
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  Current progress:
  - `lccgen project init` defaults to RSA-3072 and now exposes strict
    `--key-bits 2048|3072|4096` generation for explicit, repeatable project
    initialization.
  - RSA-1024 generation remains available only through the explicit
    `--legacy-rsa1024` migration path; `--key-bits 1024` and ambiguous
    `--legacy-rsa1024 --key-bits ...` combinations fail closed.
  - Unsupported project-initialization key import options remain rejected and
    unadvertised.
  - Issuer docs explain that generated `public_key.h` is compiled into the
    consumer application while `private_key.rsa` stays in the issuer-controlled
    project folder.
  Remaining work:
  - Add or explicitly reject `--key-alg` and `--active-key-id` in the public
    project-initialization workflow.
  - Implement supported existing-key import with deterministic key-id metadata
    or keep import permanently out of the public CLI and document the stance.
  - Add encrypted-key/passphrase or issuing-environment permission handling.
  - Add CI guards that test/demo private keys are not shipped as production
    keys.
  Acceptance criteria:
  - Build or generation docs explain how an application owner injects its public
    verification key.
  - `lccgen project initialize` supports explicit options such as `--key-alg`,
    `--key-bits`, `--legacy-rsa1024`, and `--active-key-id`.
  - Existing `--primary-key` and `--public-key` options are either wired through
    correctly or removed from the public CLI.
  - Importing an existing key produces repeatable public-key metadata and the
    same `key-id` across platforms.
  - Imported keys match the declared algorithm, minimum bit length, exponent,
    padding policy, and exportable public metadata.
  - Imported private keys are inspected before signing; weak modulus sizes,
    unsupported exponents, incompatible padding policy, or wrong algorithm
    fail unless an explicit legacy v200 path is selected.
  - Weak imported keys are rejected for v201 issuance.
  - Private signing keys are never required in the consumer application build.
  - Private keys are never printed to logs or command output.
  - Encrypted private keys or documented passphrase handling are supported; at
    minimum, key-file permissions are validated in the issuing environment.
  - CI has a guard that test/demo private keys are not shipped as production
    keys.

- [x] `P1` Add key rotation and retired-key enforcement.
  Current progress:
  - `SignatureVerificationPolicy` has a retired key-id denylist and rejects
    duplicate allowed or retired key IDs at verification time.
  - `test_signature_verifier` covers active test-key success, retired key
    denial, unknown key denial, duplicate key-id denial, key-id/public-key DER
    mismatch, and external public-key DER rejection unless explicitly gated for
    tests.
  - Runtime signature policies now carry embedded public-key records, select
    the verification key deterministically by signed `key-id`, and reject
    duplicate embedded key-ring IDs, key-ID/public-key DER mismatches, malformed
    public-key DER, and v201 keys below the configured minimum before backend
    verification.
  - Project public-key headers can add overlap-period keys with
    `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS` and retired IDs with
    `LCC_RETIRED_PUBLIC_KEY_IDS`.
  - `test_signature_verifier` covers multi-key active success, deterministic
    wrong-key failure, duplicate embedded key-ring rejection, retired key
    denial, unknown key denial, and duplicate allowlist/denylist rejection.
  - Operator docs explain the rotate, overlap, replace, retire workflow.
  Acceptance criteria:
  - Multiple active public keys can be supported during rotation.
  - Revoked or retired key IDs can be denied.
  - Duplicate key IDs are rejected at build or verifier initialization time.
  - Tests cover active key success, retired key denial, unknown key denial, and
    duplicate key-ring entries.
  - Documentation explains how to phase out old licenses.

## P1: Runtime Verification Semantics

- [x] `P0` Make unimplemented authorization APIs fail closed or impossible to
  misuse.
  Files updated:
  - `include/licensecc/licensecc.h`
  - `src/library/licensecc.cpp`
  - `test/library/public_api_test.cpp`
  Acceptance criteria:
  - `confirm_license()` and `release_license()` do not return unconditional
    `LICENSE_OK` unless they perform real authorization semantics.
  - Public docs state that only `acquire_license()` results should be used for
    entitlement decisions until those APIs are implemented.
  - Tests prove unimplemented APIs cannot be mistaken for successful
    authorization.

- [x] `P0` Make `acquire_license()` no-throw and fail-closed for locator and
  reader failures.
  Files to inspect or update:
  - `src/library/licensecc.cpp`
  - `src/library/locate/ExternalDefinition.cpp`
  - `src/library/locate/EnvironmentVarData.cpp`
  - `src/library/base/file_utils.cpp`
  - `test/library/public_api_test.cpp`
  Acceptance criteria:
  - Exceptions before the per-license verification loop are caught and mapped
    to deterministic failure statuses.
  - Invalid encoded external data, invalid external data type, unreadable
    files, malformed INI content, and unexpected parser errors never escape the
    C API.
  - Public API tests are labeled `security`.
  - The event registry records enough diagnostic detail for support without
    granting access.

- [x] `P1` Make caller-owned output structs deterministic on every failure.
  Files to inspect or update:
  - `include/licensecc/datatypes.h`
  - `src/library/licensecc.cpp`
  - `test/library/public_api_test.cpp`
  Current verification:
  - `acquire_license()` resets `LicenseInfo` at API entry before any locator,
    parser, verifier, or merge path can return.
  - `test_public_api` pre-fills stale success-looking `LicenseInfo` fields,
    calls failing `acquire_license()` paths, and verifies stale expiration,
    days-left, PC-link, proprietary-data, version, and status-reference data do
    not survive.
  - `identify_pc()` returns `false` instead of dereferencing a null `buf_size`
    pointer; tests cover null and too-short buffers.
  Acceptance criteria:
  - A prefilled `LicenseInfo` is fully reset or overwritten on every non-OK
    return.
  - `status`, `expiry_date`, `days_left`, `has_expiry`, `linked_to_pc`,
    `license_type`, `license_version`, and `proprietary_data` cannot retain
    stale success data.
  - Examples treat `LicenseInfo` fields as meaningful only when
    `acquire_license()` returns `LICENSE_OK`.

- [x] `P1` Make fail-closed behavior explicit in the public API docs and
  examples.
  Files inspected or updated:
  - `README.md`
  - `include/licensecc/datatypes.h`
  - `include/licensecc/licensecc.h`
  - `examples/minimal/README.md`
  - `examples/minimal/main.cpp`
  - `doc/usage/integration.rst`
  - `doc/usage/concepts.rst`
  - `doc/analysis/security-model.rst`
  Current verification:
  - Top-level and minimal-example docs now state that hosts grant access only
    on `LICENSE_OK`; all other results are not licensed, with
    `print_error()` and `lcc_strerror()` reserved for diagnostics.
  - `examples/minimal/main.cpp` rejects oversized path, feature, and caller
    version arguments instead of silently truncating them before calling the
    public API.
  - The minimal example accepts optional feature and version arguments, prints
    the checked feature on success, and returns a non-zero exit code for every
    non-`LICENSE_OK` result.
  - Public C API comments document that `CallerInformations.version` is
    implemented for `start-version` and `end-version`, and that missing or
    malformed caller versions fail closed with `PRODUCT_NOT_LICENSED`.
  - Integration docs include a fail-closed host code sample, feature-specific
    check guidance, version-bound behavior, and a warning that
    `confirm_license()` and `release_license()` are not authorization APIs.
  - Rebuilt on Windows Debug:
    `cmake --build build --config Debug --target test_public_api`; the public
    header no longer emits the prior MSVC C4819 non-ASCII warning.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R test_public_api --output-on-failure
    --no-tests=error`.
  - Installed the Debug package to `build/example-failclosed-install`, then
    configured and built `examples/minimal` against it in
    `build/example-failclosed-minimal`.
  - Ran `build/example-failclosed-minimal/Debug/minimal.exe` without a license;
    it returned exit code `1` and printed a `license file not found`
    diagnostic.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L public_api --output-on-failure
    --no-tests=error`.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Examples treat any non-success status as not licensed.
  - Examples log or expose diagnostic events without granting access.
  - Feature-specific checks are shown when a product has multiple licensed
    capabilities.
  - `CallerInformations.version` is documented as implemented for
    `start-version` and `end-version` checks, not "NOT IMPLEMENTED".
  - Missing or malformed caller version with a version-bound license is
    documented as a fail-closed `PRODUCT_NOT_LICENSED` result.
  - `confirm_license()` and `release_license()` are documented as unavailable
    for security decisions unless their implementations stop returning
    unconditional `LICENSE_OK`.

- [ ] `P0` Bound all public C-string reads at API boundaries.
  Files to inspect or update:
  - `src/library/base/string_utils.cpp`
  - `include/licensecc/datatypes.h`
  - `src/library/licensecc.cpp`
  - `src/library/limits/license_verifier.cpp`
  - `src/library/locate/ExternalDefinition.cpp`
  - `test/library/public_api_test.cpp`
  Current progress:
  - `mstrnlen_s()` now checks `count < maxsize` before dereferencing, so an
    unterminated fixed public buffer returns its capacity without reading one
    byte past the caller-owned array.
  - `acquire_license()` rejects unterminated `CallerInformations.feature_name`
    and `CallerInformations.version` before locator/parser work and exports a
    deterministic `LICENSE_MALFORMED` audit event while still resetting
    caller-owned `LicenseInfo`.
  - `LicenseVerifier::verify_limits()` also bounds `CallerInformations.version`
    before parsing version-bound licenses, preserving fail-closed behavior if
    the verifier is called outside the public API wrapper.
  - `ExternalDefinition` rejects unterminated `LicenseLocation.licenseData`
    instead of treating the full fixed buffer as a valid string source.
  - `test_public_api` covers the safe string-length helper, unterminated
    `feature_name`, unterminated `version`, embedded-NUL external data,
    non-terminated external data, and stale prefilled `LicenseInfo` reset.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_public_api
    test_license_locator test_standard_license`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_license_locator|test_standard_license"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L public_api --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`
    with `24/24` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  - Added a Linux `sanitizers` workflow job that builds the full direct test
    tree with `-fsanitize=address,undefined -fno-omit-frame-pointer`, then runs
    all direct executable tests and focused boundary/parser/signature facets
    under ASan/UBSan while excluding install/package/source-package smoke flows.
  - Local equivalent sanitizer capture was attempted but not completed: WSL
    Ubuntu lacks CMake and required development packages, `sudo -n` requires a
    password, and the local Visual Studio install lacks the x64 MSVC ASan
    `VCASAND.lib` runtime needed for an isolated Windows ASan build.
  - This item remains open until the sanitizer workflow has run green in CI or
    an equivalent Linux sanitizer run is captured locally.
  Acceptance criteria:
  - `CallerInformations.version`, `CallerInformations.feature_name`,
    `LicenseLocation.licenseData`, and any other public fixed-size character
    arrays are read with bounded length checks before conversion to C++
    strings.
  - Non-NUL-terminated caller fields fail closed with deterministic public
    statuses and do not read past their fixed public ABI buffer.
  - Tests cover unterminated max-size `version` and `feature_name`, embedded
    NULs where relevant, and stale prefilled `LicenseInfo` output.
  - ASan/UBSan or equivalent CI coverage exercises these boundary cases.

- [x] `P1` Audit environment-variable license loading.
  Files inspected or updated:
  - `include/licensecc/licensecc.h`
  - `src/library/licensecc.cpp`
  - `test/library/public_api_test.cpp`
  - `doc/usage/License-retrieval.md`
  - `doc/analysis/security-model.rst`
  Current verification:
  - Public API now exposes
    `lcc_set_environment_license_sources_enabled(false)` to disable
    `LICENSE_LOCATION` and `LICENSE_DATA` lookup while preserving the existing
    enabled-by-default compatibility behavior.
  - `test_public_api` covers disabled environment lookup returning
    `LICENSE_FILE_NOT_FOUND` instead of parsing attacker-controlled env data,
    and covers a valid environment license failing to rescue a malformed
    explicit `LicenseLocation` while environment sources are disabled.
  - Usage and security docs mark environment-sourced licenses as compatibility,
    support, or test oriented unless the process environment is trusted.
  - Verification run:
    `ctest --test-dir build -C Debug -R "test_public_api|test_license_locator|test_license_reader" --output-on-failure`,
    `ctest --test-dir build -C Debug -L security --output-on-failure`,
    `ctest --test-dir build -C Debug --output-on-failure`, `git diff --check`,
    and `git -C extern/license-generator diff --check`.
  Acceptance criteria:
  - Production integrations can disable environment-sourced licenses.
  - Documentation marks environment-sourced licenses as test/support oriented
    unless the host process environment is trusted.
  - Tests prove disabling environment sources cannot be bypassed by setting the
    existing environment variable.

- [x] `P1` Resolve environment-source default policy mismatch.
  Files inspected or updated:
  - `src/templates/licensecc_properties.h.in`
  - `src/library/locate/LocatorFactory.cpp`
  - `include/licensecc/licensecc.h`
  - `doc/usage/License-retrieval.md`
  - `doc/analysis/security-model.rst`
  - `test/library/public_api_test.cpp`
  - `test/library/LicenseReader_test.cpp`
  - `test/functional/crack_test.cpp`
  Current verification:
  - Generated projects default to `FIND_LICENSE_WITH_ENV_VAR=false`, and
    `LocatorFactory` initializes environment lookup from that generated macro.
  - The public API comment for
    `lcc_set_environment_license_sources_enabled()` now says hardened
    generated projects disable `LICENSE_LOCATION` and `LICENSE_DATA` lookup by
    default and that hosts should opt in only for trusted test, support, or
    compatibility workflows.
  - Usage and security docs now state the same default-off policy and identify
    it as a compatibility break for deployments that relied on ambient
    environment variables.
  - `test_public_api` now asserts the generated default is off, proves
    `LICENSE_LOCATION`/`LICENSE_DATA` are ignored by default, and separately
    proves explicit opt-in still parses malformed environment data as
    `LICENSE_MALFORMED`.
  - `test_license_reader`, `test_public_api`, and `test_crack` restore locator
    state to `FIND_LICENSE_NEAR_MODULE` and `FIND_LICENSE_WITH_ENV_VAR` after
    environment-specific cases instead of leaving environment lookup enabled.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_public_api
    test_license_reader test_crack`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_license_reader|test_crack" --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `cmake --build build --config Debug`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`
    with `24/24` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Generated project defaults, public API comments, usage docs, and security
    docs all state the same default for `LICENSE_LOCATION` and `LICENSE_DATA`.
  - Migration notes explain whether hardened builds default environment lookup
    off or preserve enabled-by-default compatibility.
  - Tests assert the generated default behavior and the explicit
    `lcc_set_environment_license_sources_enabled()` override.

- [x] `P1` Add an optional strict source-fatal runtime mode.
  Files inspected or updated:
  - `include/licensecc/licensecc.h`
  - `src/library/licensecc.cpp`
  - `src/library/base/EventRegistry.h`
  - `src/library/base/EventRegistry.cpp`
  - `test/library/public_api_test.cpp`
  - `doc/usage/License-retrieval.md`
  - `doc/analysis/security-model.rst`
  Current verification:
  - Added `lcc_set_strict_source_fatal_enabled(bool)` as a compatibility-off
    public runtime switch.
  - `acquire_license()` now preserves default fallback behavior when strict
    mode is off: one valid candidate still returns `LICENSE_OK`, and malformed
    candidates remain warning audit events.
  - Strict mode checks the event registry for source-level
    `LICENSE_MALFORMED` or `FILE_FORMAT_NOT_RECOGNIZED` after verification.
    If any valid candidate exists but a strict source-fatal event was recorded,
    the fatal event is re-appended before audit export, returned as the public
    result, and `LicenseInfo` remains reset instead of being merged from the
    valid fallback license.
  - `EventRegistry::getLastEventOfType()` provides deterministic lookup for
    the strict source-fatal decision.
  - `test_public_api` covers malformed environment data plus valid explicit
    file, malformed explicit data plus valid environment file, malformed path
    candidate before valid path, disabled environment sources, deterministic
    `LICENSE_MALFORMED` status export, and no stale `LicenseInfo` output on
    strict failure.
  - Usage and security-model docs describe the compatibility fallback policy,
    strict opt-in policy, source classes, and when hosts should enable strict
    source-fatal handling.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_public_api
    test_event_registry`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_event_registry" --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `cmake --build build --config Debug`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`
    with `24/24` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Hosts can opt into treating malformed explicit or environment-sourced
    license data as fatal even when a later file-based candidate would verify.
  - The explicit `LicenseLocation` path can be configured as authoritative so
    lower-trust ambient sources cannot mask malformed explicit input.
  - Public API exposes a clear mode switch or a distinct result such as
    `LICENSE_OK_WITH_WARNINGS` so consumers do not have to parse diagnostic
    events to notice masked failures.
  - The compatibility default remains documented and tested separately if it
    continues to demote earlier malformed file candidates to warnings after a
    later valid license.
  - Source priority, fatal/non-fatal source classes, and resulting event
    registry behavior are documented.
  - Tests cover explicit malformed plus valid file, malformed environment plus
    valid file, malformed low-priority file plus valid higher-priority file,
    and disabled environment source behavior.
  - Failures return deterministic public statuses and never leave stale
    `LicenseInfo` output.

- [x] `P1` Define a time-checking policy.
  Files inspected or updated:
  - `src/library/base/string_utils.cpp`
  - `src/library/base/string_utils.h`
  - `src/library/LicenseReader.cpp`
  - `src/library/limits/license_verifier.cpp`
  - `test/functional/date_test.cpp`
  - `test/library/LicenseReader_test.cpp`
  - `doc/usage/issue-licenses.md`
  - `doc/analysis/security-model.rst`
  Current verification:
  - Runtime date parsing now uses `is_canonical_v200_date()` as the shared
    v200 date-shape predicate for both `LicenseReader` and
    `seconds_from_epoch()`.
  - `seconds_from_epoch()` no longer accepts compact dates, slash dates,
    parser-normalized impossible dates, padded values, or trailing garbage.
  - `test_date` covers expired licenses, future `valid-from`, direct parser
    rejection, and verifier rejection of malformed `valid-from`/`valid-to`
    without `mktime()` normalization.
  - `test_license_reader` covers malformed signed v200 date shapes including
    compact, slash, impossible calendar dates, non-leap February 29, zero
    month/day, month 13, trailing garbage, and padded values.
  - Public usage docs document canonical `YYYY-MM-DD`, generator
    normalization, runtime rejection policy, and the wall-clock trust limit.
    The security model already states that local wall-clock checks are
    bypassable without an external time authority.
  - Verification run:
    `ctest --test-dir build -C Debug -R "test_date|test_license_reader|test_crack" --output-on-failure`,
    `ctest --test-dir build -C Debug -L security --output-on-failure`,
    `ctest --test-dir build -C Debug --output-on-failure`, `git diff --check`,
    and `git -C extern/license-generator diff --check`.
  Acceptance criteria:
  - Date validation uses a single parsing path.
  - Expired and not-yet-valid licenses fail closed.
  - Invalid calendar dates, leap-day failures, zero month/day, trailing
    garbage, and ambiguous slash formats are rejected consistently in generator
    and runtime code.
  - Documentation explains that local wall-clock checks are bypassable by a
    privileged local attacker unless paired with an external time authority.

- [x] `P2` Improve event observability.
  Evidence:
  - `print_error()` now includes the audit event detail field (`param2`) after
    the stable public `lcc_strerror()` text, so diagnostics retain structured
    context such as invalid fields, expiration dates, and version-bound
    failures.
  - Malformed caller versions now report `Caller version malformed`, while
    missing caller versions continue to report `Caller version not provided`.
  - `test_public_api` covers distinct public diagnostics for malformed
    licenses, invalid signatures, expired licenses, wrong hardware, and
    version mismatch classes.
  - `test_standard_license` verifies actual version-bound failures expose
    `Version before ...`, `Version after ...`, `Caller version not provided`,
    and `Caller version malformed` through `print_error()`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_standard_license" --output-on-failure
    --no-tests=error`.
  Acceptance criteria:
  - Malformed license, invalid signature, expired license, wrong hardware, and
    version mismatch are distinguishable in diagnostics.
  - Public error strings are stable enough for host applications to log and
    test.

- [x] `P1` Fail closed on oversized license sources.
  Files inspected or updated:
  - `src/library/base/file_utils.cpp`
  - `src/library/base/file_utils.hpp`
  - `src/library/locate/ApplicationFolder.cpp`
  - `src/library/locate/EnvironmentVarLocation.cpp`
  - `src/library/locate/EnvironmentVarData.cpp`
  - `src/library/locate/ExternalDefinition.cpp`
  - `test/library/LicenseLocator_test.cpp`
  - `test/library/public_api_test.cpp`
  - `test/functional/crack_test.cpp`
  Current verification:
  - File-based locators now check candidate file length before returning a
    candidate, so files larger than `LCC_API_MAX_LICENSE_DATA_LENGTH` report
    `LICENSE_MALFORMED` instead of allowing later truncated reads.
  - `ApplicationFolder`, `EnvironmentVarLocation`, and external
    `LICENSE_PATH` sources enforce the same file-size boundary.
  - `EnvironmentVarData` rejects raw environment license data larger than the
    limit, rejects decoded/base64 data larger than the limit, and keeps using
    `LICENSE_DATA` in audit events.
  - External `LICENSE_PLAIN_DATA` and `LICENSE_ENCODED` require a terminating
    NUL before the public ABI buffer limit. The largest representable explicit
    data payload is therefore `LCC_API_MAX_LICENSE_DATA_LENGTH - 1`; a full
    buffer is treated as malformed rather than truncated.
  - `test_license_locator` covers exact-limit file candidates, over-limit file
    candidates, exact-limit environment data, over-limit environment data,
    largest terminated explicit data, and full-buffer unterminated explicit
    data.
  - `test_public_api` covers an oversized explicit license path returning
    `LICENSE_MALFORMED` without stale output.
  - `test_crack` covers generated valid licenses with appended duplicate
    section or malformed-key data padded beyond the limit for file and
    environment sources, plus an explicit-data valid prefix with a full
    unterminated buffer.
  - Passed on Windows Debug:
    `cmake --build build --config Debug`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_license_locator|test_public_api|test_crack" --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L public_api --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`
    with `24/24` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - File and external license data larger than `LCC_API_MAX_LICENSE_DATA_LENGTH`
    fail with a deterministic public error instead of being silently
    truncated.
  - Appended duplicate sections, appended malformed keys, and appended garbage
    beyond the size limit cannot become invisible to the verifier.
  - Tests cover exact-limit, over-limit-by-one, and appended-malformation
    cases for file, environment, and explicit data sources.

- [x] `P1` Define runtime `extra-data` shape and length policy.
  Files inspected or updated:
  - `src/library/LicenseReader.cpp`
  - `src/library/limits/license_verifier.cpp`
  - `src/templates/licensecc_properties.h.in`
  - `extern/license-generator/src/base_lib/base.h`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/license_test.cpp`
  - `test/library/license_verifier_test.cpp`
  - `test/functional/crack_test.cpp`
  - `doc/analysis/security-model.rst`
  - `doc/usage/issue-licenses.md`
  Current verification:
  - Runtime verification now rejects `extra-data` when it is empty, longer
    than `LCC_API_PROPRIETARY_DATA_SIZE`, leading/trailing-whitespace padded,
    or contains control characters including embedded NUL.
  - `LicenseVerifier::toLicenseInfo()` copies `extra-data` only after the
    same validation succeeds, so failure paths do not expose truncated signed
    application data through `LicenseInfo.proprietary_data`.
  - The generator now enforces the same default
    `LCC_API_PROPRIETARY_DATA_SIZE` limit before issuing a license.
  - `test_license_verifier` covers exact-limit acceptance and rejection of
    empty, oversized, leading/trailing whitespace, newline, tab, and embedded
    NUL values.
  - `test_license` covers generator acceptance at the exact limit and
    rejection above the limit.
  - `test_crack` covers signed runtime fixtures: exact-limit `extra-data`
    returns `LICENSE_OK`, while signed empty and oversized `extra-data` return
    `LICENSE_MALFORMED` and do not populate `proprietary_data`.
  - Usage and security docs describe the printable, non-secret, 1-16 byte
    default policy and the `LICENSE_MALFORMED` result for malformed signed
    `extra-data`.
  - Passed on Windows Debug:
    `cmake --build build --config Debug`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_license|test_command-line|test_license_verifier|test_crack"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug --output-on-failure --no-tests=error`
    with `24/24` tests.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Runtime v200 verification either rejects signed `extra-data` that cannot
    fit in `LicenseInfo.proprietary_data`, or exposes truncation/overflow
    explicitly without silently changing signed application data.
  - Generator maximum length matches runtime public ABI limits.
  - Control characters, embedded NUL, leading/trailing whitespace, and
    oversized signed `extra-data` have documented accept/reject behavior.
  - Signed fixtures prove malformed or oversized runtime `extra-data` never
    returns `LICENSE_OK` unless legacy compatibility explicitly permits it.

## P0/P1: Existing C++ Project Integration Checklist

- [x] `P0` Fix and verify the installed CMake package export contract.
  Files to inspect or update:
  - `src/cmake/licensecc-config.cmake`
  - `src/library/CMakeLists.txt`
  - `examples/minimal/CMakeLists.txt`
  - `.github/workflows`
  Current verification:
  - `licensecc-config.cmake` now fails at `find_package(licensecc REQUIRED)`
    when no project is selected or `LCC_PROJECT_NAME` is wrong.
  - The installed target is verified on Windows by
    `test_install_consumer_smoke` through `CMAKE_PREFIX_PATH`.
  - `test_package_consumer_smoke` verifies the exported target from an
    extracted package prefix and confirms generated headers are available
    through installed target include directories.
  - Linux and Windows workflows run the install/package smoke through the
    security label.
  Acceptance criteria:
  - `find_package(licensecc REQUIRED)` fails clearly when
    `LCC_PROJECT_NAME` is missing or does not match installed generated files.
  - Installed targets include `licensecc::licensecc_static` with correct
    include directories for `licensecc/licensecc.h` and generated
    `licensecc_properties.h`.
  - Transitive platform, OpenSSL, and system libraries resolve through
    imported targets or `find_dependency()`.
  - Package paths work on Linux and Windows through `CMAKE_PREFIX_PATH`.
  - Package configuration uses relocatable CMake package patterns instead of
    hard-coded relative paths.

- [x] `P0` Add install-based consumer smoke tests.
  Files to inspect or update:
  - `examples/minimal`
  - `.github/workflows/linux.yml`
  - `.github/workflows/windows.yml`
  Current verification:
  - `test/install_consumer_smoke.cmake` installs to a clean staging prefix,
    configures and builds `examples/minimal` as an external consumer using only
    `find_package(licensecc REQUIRED)`, checks the consumer resolves the
    installed package, runs a missing-license denial case, rejects wrong or
    missing project selection during configure, and verifies `private_key.rsa`
    is absent from the install prefix.
  - `test/package_consumer_smoke.cmake` creates a runtime package, extracts it,
    scans the extracted payload, configures and builds `examples/minimal` from
    the extracted package prefix, and verifies valid, missing, malformed,
    corrupted, expired, wrong-feature, wrong-version, wrong-magic, and
    hardware-mismatch cases.
  - Linux and Windows workflows run the security/install/package gate.
  Acceptance criteria:
  - CI installs `licensecc` into a staging prefix, configures an external
    consumer project, builds it, and runs it.
  - The smoke project uses only `find_package(licensecc REQUIRED)` and installed
    targets.
  - Tests cover valid, missing, malformed, corrupted, expired, wrong-feature,
    wrong-version, wrong-magic, and hardware-mismatch licenses.
  - Every failure path denies access.
  - The smoke test runs on both Linux and Windows.

- [x] `P1` Document secure integration flow for a host C++ application.
  Files inspected or updated:
  - `doc/usage/integration.rst`
  - `examples/minimal/CMakeLists.txt`
  - `examples/minimal/README.md`
  - `src/cmake/licensecc-config.cmake`
  - `src/library/CMakeLists.txt`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  Current verification:
  - The integration guide now tells hosts to build one non-`DEFAULT`
    `LCC_PROJECT_NAME` per release product or product family and keep
    `LCC_PROJECTS_BASE_DIR` in an issuer-controlled location outside the
    source tree.
  - The guide documents where `private_key.rsa` and generated `public_key.h`
    live, states that the public key is compiled into
    `licensecc::licensecc_static`, and states that the private key remains
    issuer-only.
  - The install flow shows configure, build, and install commands, then shows
    consumer CMake with `find_package(licensecc 2.1.0 REQUIRED COMPONENTS
    MY_PRODUCT)` and `target_link_libraries(... licensecc::licensecc_static)`.
  - The guide documents static-only installed consumption: the current package
    exports `licensecc::licensecc_static`, and no shared-library target is
    supported unless one is added and tested.
  - Project identity is tied across runtime and issuer workflows:
    `LCC_PROJECT_NAME`, `find_package(... COMPONENTS MY_PRODUCT)`,
    `lccgen license issue --project-folder .../MY_PRODUCT`, and
    `CallerInformations.feature_name` for optional features.
  - The guide no longer references the stale `Findlicensecc.cmake` or
    `LICENSECC_LOCATION` consumption flow.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  - Local Sphinx validation was not run because the active Python environment
    does not have Sphinx installed; the repository's docs CI job still installs
    `requirements.txt` and runs Sphinx with warnings as errors.
  Acceptance criteria:
  - Shows building one `licensecc` project per licensed product with a
    non-default `LCC_PROJECT_NAME`; builds using `DEFAULT` are not suitable for
    release.
  - Shows CMake build/install usage for supported static installed
    consumption, and either documents that a shared target is not currently
    provided or adds and tests a shared-library target.
  - Includes an install-based example:

    ```console
    cmake -S <licensecc> -B lcc-build -DLCC_PROJECT_NAME=<product> -DCMAKE_INSTALL_PREFIX=<prefix>
    cmake --build lcc-build --target install --config Release
    ```

  - Shows required include paths and library targets.
  - Shows consumer CMake usage:

    ```cmake
    find_package(licensecc REQUIRED)
    target_link_libraries(my_app PRIVATE licensecc::licensecc_static)
    ```

  - Shows how to set the project/application identifier consistently between
    `lccgen` and the runtime library.
  - Shows where the public verification key is configured.
  - Removes stale references to non-existent `Findlicensecc.cmake` or
    unsupported `LICENSECC_LOCATION` flows.
  - Either documents static-only consumption through
    `licensecc::licensecc_static` or adds and tests a shared-library target.

- [x] `P1` Add a fail-closed host application example.
  Files inspected or updated:
  - `examples/fail_closed_host/CMakeLists.txt`
  - `examples/fail_closed_host/main.cpp`
  - `examples/fail_closed_host/README.md`
  - `doc/usage/integration.rst`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  - `examples/minimal/main.cpp`
  - `examples/minimal/README.md`
  Current verification:
  - Added a standalone `examples/fail_closed_host` consumer that builds only
    through `find_package(licensecc REQUIRED)` and
    `licensecc::licensecc_static`.
  - The example zero-initializes `LicenseLocation`, `CallerInformations`,
    `LicenseInfo`, and its protected-feature state. The base product,
    `REPORTS`, and `EXPORT` all start unavailable.
  - Every entitlement check compares the result exactly with `LICENSE_OK`.
    Protected features are enabled only after the corresponding
    `acquire_license()` call succeeds.
  - The example checks the base product before optional features, checks
    `REPORTS` and `EXPORT` independently, populates
    `CallerInformations.feature_name`, `CallerInformations.version`, and
    `CallerInformations.magic = LCC_PROJECT_MAGIC_NUM`, and reports failures
    through `lcc_strerror()` and `print_error()`.
  - `LicenseInfo.proprietary_data` is read only after the base product check
    succeeds. `identify_pc(STRATEGY_DEFAULT, ...)` is available only behind a
    `--print-id` support/enrollment flag and is not used as entitlement proof.
  - The example has no unsigned trial, grace-period, or cached-success
    fallback.
  - `test_install_consumer_smoke` builds the example from an installed runtime
    package and verifies a missing license returns exit code `1` with
    application, `REPORTS`, and `EXPORT` all unavailable and no enabled
    features printed.
  - `test_package_consumer_smoke` builds the example from an extracted runtime
    package and verifies malformed-license denial, base-only success with
    optional features unavailable, all-feature success, and wrong-version
    denial without enabling any feature.
  - Refreshed `build/example-failclosed-install`, configured and built
    `examples/fail_closed_host` into `build/example-failclosed-host-check`, and
    ran it against a missing explicit license path; it returned exit code `1`
    with all features unavailable.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed: `python scripts/check_docs_links.py doc`.
  Acceptance criteria:
  - Public structs such as `CallerInformations`, `LicenseLocation`, and
    `LicenseInfo` are zero-initialized before use.
  - The code compares results exactly against `LICENSE_OK`.
  - Calls the license check before enabling protected features.
  - Starts with all protected features disabled.
  - Handles every failure as "feature unavailable".
  - Checks each optional feature separately when the product has multiple
    licensed features.
  - Populates `CallerInformations.feature_name` for feature-gated features.
  - Populates `CallerInformations.version` when issuing version-bound licenses.
  - Populates `CallerInformations.magic` when the build uses
    `LCC_PROJECT_MAGIC_NUM`.
  - Emits useful diagnostics through `lcc_strerror` or the event registry.
  - Treats `LicenseInfo.proprietary_data` as untrusted unless
    `acquire_license()` returned `LICENSE_OK`.
  - Uses `identify_pc(STRATEGY_DEFAULT, ...)` only as a support/enrollment path,
    not as proof of entitlement.
  - Does not continue with full functionality after malformed license input.
  - Does not implement a fallback trial, grace period, or cached success unless
    that fallback is separately signed, time-limited, and tested.

- [x] `P0` Define supported integration modes for existing C++ projects.
  Files to inspect or update:
  - `doc/usage/integration.rst`
  - `README.md`
  - `examples/minimal/README.md`
  - `examples/minimal/CMakeLists.txt`
  Current verification:
  - `doc/usage/integration.rst`, `README.md`, and
    `examples/minimal/README.md` state that the supported production
    integration mode is the installed CMake package with
    `find_package(licensecc REQUIRED COMPONENTS <project>)` and
    `licensecc::licensecc_static`.
  - The docs explicitly classify direct source-tree include paths, hand-written
    library paths, `add_subdirectory` embedding, MSBuild-only projects, Bazel,
    and raw Makefile consumption as unsupported production interfaces unless a
    dedicated smoke test is added for that mode.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` prove the
    supported installed-package mode, project-header selection, package
    identity metadata, relocation, and fail-closed host behavior.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32`.
  Acceptance criteria:
  - Public docs say whether installed-package CMake consumption is the only
    supported mode for production consumers.
  - If `add_subdirectory`, superbuild, raw compiler/link, MSBuild, Bazel, or
    Makefile consumption is supported, each mode has tested include paths,
    compile definitions, library dependencies, and project-header selection.
  - Unsupported modes fail with a precise message or are documented as
    unsupported instead of relying on accidental source-tree include behavior.
  - At least one smoke test proves the supported installed-package mode, and
    any additional supported mode has its own smoke.

- [x] `P0` Make the fail-closed host example source-fatal by default.
  Files to inspect or update:
  - `examples/fail_closed_host/main.cpp`
  - `doc/usage/integration.rst`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  Current verification:
  - `examples/fail_closed_host/main.cpp` disables environment-sourced license
    lookup and enables strict source-fatal handling before any entitlement
    check.
  - `examples/fail_closed_host/README.md` and `doc/usage/integration.rst`
    document that the example uses explicit license paths, disables environment
    license sources, and treats malformed higher-priority sources as fatal.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` stage a
    malformed colocated license next to the built `fail_closed_host`
    executable, pass a valid explicit license path, and assert the host still
    exits denied with all features unavailable.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32`.
  Acceptance criteria:
  - The fail-closed example disables environment-sourced license lookup with
    `lcc_set_environment_license_sources_enabled(false)` unless it is
    explicitly demonstrating a support workflow.
  - The example enables `lcc_set_strict_source_fatal_enabled(true)` before
    entitlement checks, or the docs state why compatibility fallback mode is
    intentionally used.
  - Install/package consumer smokes include malformed fallback source plus
    valid explicit license cases and prove the fail-closed host still denies.
  - The example keeps all protected features disabled when a source-fatal
    condition is observed.

- [x] `P0` Make runtime policy toggles thread-safe or per-call.
  Files to inspect or update:
  - `include/licensecc/licensecc.h`
  - `src/library/licensecc.cpp`
  - `test/library/public_api_test.cpp`
  Current verification:
  - `src/library/licensecc.cpp` stores strict source-fatal policy in an atomic
    process-global flag.
  - `src/library/locate/LocatorFactory.hpp` and `.cpp` store environment-source
    and near-module lookup toggles in atomic process-global flags.
  - `include/licensecc/licensecc.h` and `doc/usage/integration.rst` document
    that these toggles are atomic process-global startup policy and should be
    configured once before worker threads begin license checks.
  - `test_public_api` repeatedly changes the environment and strict
    source-fatal policy while parallel threads verify a valid explicit license,
    proving no torn policy state or unexpected denial is observed for that
    explicit-license path.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32`.
  Acceptance criteria:
  - Global runtime toggles such as environment-source enablement and
    strict-source-fatal mode are atomic and documented as startup-only, or a
    new `acquire_license_ex(..., options)` style API makes policy per-call.
  - Multi-threaded host applications cannot observe torn or inconsistent
    policy state while checking licenses.
  - Tests cover repeated policy changes and concurrent reads if global mutable
    state remains supported.

- [x] `P1` Add public API convenience helpers to reduce fixed-buffer misuse.
  Files to inspect or update:
  - `include/licensecc/licensecc.h`
  - `src/library/licensecc.cpp`
  - `test/library/public_api_test.cpp`
  - `examples/minimal/main.cpp`
  - `examples/fail_closed_host/main.cpp`
  Evidence:
  - Public API now exposes null-safe initializers for `CallerInformations`,
    `LicenseLocation`, and `LicenseInfo`. Caller initialization sets
    `LCC_PROJECT_MAGIC_NUM` by default.
  - Public bounded setters now populate `feature_name`, `version`, generic
    license data, and license paths. They reject null or oversized input and
    clear the destination field on failure so stale valid buffer contents do
    not survive a failed set.
  - `print_error()` now accepts `const LicenseInfo*`, removing the need for
    `const_cast` in examples.
  - `examples/minimal` and `examples/fail_closed_host` use the helper API
    instead of open-coded fixed-buffer copies.
  - `test_public_api` covers initializer defaults, null-safe initializers,
    exact-fit accepted setters, oversized rejected setters, destination
    clearing on failure, const-safe `print_error()`, and null-safe setter
    failures.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_install_consumer_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error` with `3/3` tests.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R test_package_consumer_smoke
    --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - Public helpers initialize `CallerInformations`, `LicenseLocation`, and
    `LicenseInfo` safely.
  - Setters for feature name, caller version, and license path fail closed when
    inputs exceed the fixed public ABI buffers.
  - Examples use the helpers instead of open-coded bounded copies where that
    improves clarity.
  - `print_error` accepts a `const LicenseInfo*` or a const-safe replacement is
    added so examples do not need `const_cast`.

- [x] `P1` Document license deployment locations.
  Files inspected or updated:
  - `doc/usage/License-retrieval.md`
  - `include/licensecc/licensecc.h`
  - `include/licensecc/datatypes.h`
  - `test/library/public_api_test.cpp`
  Current verification:
  - License retrieval docs now recommend colocated signed license files or an
    explicit `LicenseLocation` from trusted host configuration for production.
  - Docs list all explicit `LicenseLocation` source types:
    `LICENSE_PATH`, `LICENSE_PLAIN_DATA`, and `LICENSE_ENCODED`.
  - Docs state that process environment variables are support-only or
    test-only unless the deployment model proves they are trusted, because many
    desktop, service, shell, and launcher deployments allow users or parent
    processes to set them.
  - Docs show disabling environment sources with
    `lcc_set_environment_license_sources_enabled(false)`.
  - Docs show the stricter support-workflow mode:
    `lcc_set_environment_license_sources_enabled(true)` plus
    `lcc_set_strict_source_fatal_enabled(true)`.
  - Existing `test_public_api` coverage verifies environment sources are
    ignored by default, can be disabled explicitly, and cannot mask bad
    explicit input when disabled.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed: `git diff --check`; it reported only existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Explains file-based, environment, and external-definition license sources.
  - Recommends file-based or explicitly provided license data for production.
  - Explains how to disable weaker or support-only sources if supported.
  - Warns that process environment variables are attacker-controlled in many
    desktop and service deployments.

- [x] `P1` Document magic-number integration.
  Files inspected or updated:
  - `src/templates/licensecc_properties.h.in`
  - `include/licensecc/datatypes.h`
  - `doc/usage/integration.rst`
  - `examples/minimal/README.md`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  - `test/functional/crack_test.cpp`
  Current verification:
  - Generated project headers now expose `LCC_PROJECT_MAGIC_NUM`, and
    `LCC_VERIFY_MAGIC` compares against that generated constant instead of an
    unreferencable literal.
  - Public API comments direct host applications to the generated
    `LCC_PROJECT_MAGIC_NUM` and `LCC_VERIFY_MAGIC` macros.
  - Integration docs explain when to use a nonzero `LCC_PROJECT_MAGIC_NUM`,
    show the CMake option, show `caller.magic = LCC_PROJECT_MAGIC_NUM`, and
    document that mismatches fail closed with `LICENSE_CORRUPTED`.
  - Minimal-example docs describe the optional magic argument and the
    fail-closed behavior on mismatch.
  - `test_install_consumer_smoke` now verifies the installed generated
    `licensecc_properties.h` exposes `LCC_PROJECT_MAGIC_NUM`.
  - `test_package_consumer_smoke` now runs a valid packaged license with an
    explicit matching magic value and expects `LICENSE_OK`; it also keeps the
    existing wrong-magic denial case.
  - `test_crack` continues to cover wrong-magic denial in the direct public API
    path.
  - Rebuilt on Windows Debug:
    `cmake --build build --config Debug --target test_crack test_public_api`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke|test_crack|test_public_api"
    --output-on-failure --no-tests=error`.
  - Passed: `python scripts/check_docs_links.py doc`.
  Acceptance criteria:
  - Explains when to use nonzero `LCC_PROJECT_MAGIC_NUM`.
  - Shows how host code populates `CallerInformations.magic`.
  - Tests cover wrong-magic denial and matching-magic success.
  - Considers exposing a generated constant so host code cannot drift from the
    configured project magic.

- [x] `P1` Make generated project/key locations release-safe.
  Files to inspect or update:
  - `CMakeLists.txt`
  - `src/CMakeLists.txt`
  - `src/templates/public_key.inja`
  - `extern/license-generator/src/license_generator/project.cpp`
  Files inspected or updated:
  - `CMakeLists.txt`
  - `cmake/CheckReleaseProject.cmake`
  - `src/CMakeLists.txt`
  - `test/CMakeLists.txt`
  - `test/ctest_label_audit.cmake`
  - `test/release_safety_smoke.cmake`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  Current verification:
  - Clean builds default `LCC_PROJECTS_BASE_DIR` to
    `${CMAKE_BINARY_DIR}/projects`, so generated project metadata and keys are
    not written to the source tree by default.
  - Source-tree key generation outside the active build tree is refused unless
    `LCC_ALLOW_SOURCE_TREE_KEYGEN=ON` is set explicitly. Build-tree generated
    projects remain allowed even when the build directory is inside the
    checkout.
  - Release-like single-config configure flows (`Release`,
    `RelWithDebInfo`, and `MinSizeRel`) reject reserved local/test project
    names such as `DEFAULT`, `test`, and `demo` unless
    `LCC_ALLOW_DEFAULT_PROJECT_FOR_RELEASE=ON` is set explicitly.
  - Release-like configure, build, install, and package guards also require
    the selected `public_key.h` and `private_key.rsa` to exist before release
    artifact generation unless `LCC_ALLOW_RELEASE_PROJECT_KEYGEN=ON` is set
    explicitly for local development.
  - Multi-config builds run `release_project_guard` before
    `project_initialize`; Visual Studio `Release` and `RelWithDebInfo` builds
    using reserved local/test project names or missing project keys fail before
    key generation.
  - Install and package flows include the same reserved-project release guard
    before the release artifact scan.
  - Build logs identify the selected project and embedded public key path. The
    root `project_initialize` message no longer prints the private-key path.
  - Generated `licensecc_properties.h` is refreshed every configure, so
    `LCC_PROJECT_MAGIC_NUM` cannot silently remain stale when the CMake value
    changes. Install and package smokes assert the exact generated magic value
    in the staged/extracted headers.
  - `test_release_safety_smoke` verifies Release and RelWithDebInfo default
    project rejection, Release `test`/`demo` project rejection, Release
    missing-key rejection for a product-like project, multi-config Release
    guard failures for `DEFAULT`, `test`, and missing project keys, build-tree
    default project paths, no public/private key generation during configure,
    source-tree keygen refusal, a valid Release configure after an explicit
    Debug key-generation build has prepared a product-like key base, and no
    mutations under the source-tree `projects` directory.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` still scan
    staged and extracted runtime artifacts for forbidden private keys, project
    folders, private-key content markers, `lccgen`, and `lccinspector`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_release_safety_smoke|test_ctest_label_audit" --output-on-failure
    --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - Release builds require an explicit product-specific `LCC_PROJECT_NAME`
    that is not a reserved local/test/demo name.
  - Release artifacts require an issuer-controlled project/key base that
    already contains the selected public and private key before release
    generation starts.
  - Generated public headers and project metadata are written outside the
    source tree by default, or source-tree generation requires an explicit
    development opt-in.
  - Build logs identify which project/public key is embedded without printing
    private key material.
  - Install and package outputs are scanned for private keys, generated
    private project folders, and test/demo key material.

- [x] `P1` Align release-safe project/key guidance across public docs and
  examples.
  Files to inspect or update:
  - `README.md`
  - `doc/usage/issue-licenses.md`
  - `doc/usage/concepts.rst`
  - `doc/usage/integration.rst`
  - `examples/minimal/README.md`
  - `examples/fail_closed_host/README.md`
  Files inspected or updated:
  - `README.md`
  - `doc/usage/issue-licenses.md`
  - `doc/usage/concepts.rst`
  - `doc/usage/integration.rst`
  - `examples/minimal/CMakeLists.txt`
  - `examples/minimal/README.md`
  - `examples/minimal/main.cpp`
  - `examples/fail_closed_host/CMakeLists.txt`
  - `examples/fail_closed_host/README.md`
  Current verification:
  - README build commands for Linux, Windows/MSVC, and MinGW now show
    non-default `LCC_PROJECT_NAME` and issuer-controlled
    `LCC_PROJECTS_BASE_DIR` values.
  - Issuance docs now present `/secure/licensecc-projects/MY_PRODUCT` as the
    release project folder, use `--project-folder` in `lccgen license issue`
    examples, and state that `DEFAULT` plus `LCC_ALLOW_SOURCE_TREE_KEYGEN=ON`
    are local-development flows only.
  - Concepts and integration docs describe build-tree defaults, release use of
    issuer-controlled project folders, component-based package selection, and
    copy-paste snippets that initialize `CallerInformations.magic` from
    `LCC_PROJECT_MAGIC_NUM`.
  - `examples/minimal` and `examples/fail_closed_host` now use
    `find_package(licensecc REQUIRED COMPONENTS ${LCC_PROJECT_NAME})`, making
    project selection visible in the consumer CMake configure while the package
    still handles wrong or missing project names clearly.
  - Grep audit found no remaining `projects/DEFAULT`, `cd projects/DEFAULT`,
    `licensecc/projects`, `LICENSECC_LOCATION`, or overlong
    `MY_AWESOME_FEATURE` guidance in README, usage docs, or examples.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug nonzero magic build configured with
    `-DLCC_PROJECT_NAME=magic_smoke -DLCC_PROJECT_MAGIC_NUM=123456`:
    `ctest --test-dir build-magic -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - Release build and install commands always show a non-default
    `LCC_PROJECT_NAME` and an issuer-controlled `LCC_PROJECTS_BASE_DIR`.
  - `projects/DEFAULT` is documented as local/test-only legacy guidance, not a
    release flow.
  - `LCC_ALLOW_SOURCE_TREE_KEYGEN=ON` is documented only as a local
    development opt-in.
  - Existing C++ project guidance prefers
    `find_package(licensecc REQUIRED COMPONENTS <project>)`, or explicitly
    explains when the `-DLCC_PROJECT_NAME=<project>` fallback form is used.
  - Copy-paste snippets zero-initialize structs, set
    `CallerInformations.magic = LCC_PROJECT_MAGIC_NUM`, set feature/version
    fields per check, and grant access only on exact `LICENSE_OK`.

- [x] `P1` Add a nonzero project-magic install/package smoke axis.
  Files to inspect or update:
  - `.github/workflows/linux.yml`
  - `.github/workflows/windows.yml`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  - `examples/minimal`
  Files inspected or updated:
  - `.github/workflows/linux.yml`
  - `.github/workflows/windows.yml`
  - `examples/minimal/main.cpp`
  - `examples/minimal/README.md`
  - `examples/fail_closed_host/README.md`
  - `test/package_consumer_smoke.cmake`
  Current verification:
  - Linux CI now runs a dedicated Debug `magic_smoke` build with
    `-DLCC_PROJECT_MAGIC_NUM=123456`, builds `licensecc_static`, and runs
    `test_install_consumer_smoke` plus `test_package_consumer_smoke`.
  - Windows CI now runs the same dedicated Debug nonzero-magic smoke on the
    static-runtime matrix leg.
  - The minimal example initializes `CallerInformations.magic` from the
    generated `LCC_PROJECT_MAGIC_NUM` constant by default, while preserving the
    CLI override used by smoke tests to prove explicit mismatches fail.
  - Install and package smokes assert that generated installed/extracted
    headers expose exactly the configured `LCC_PROJECT_MAGIC_NUM`.
  - `test_package_consumer_smoke` verifies valid packaged licenses succeed
    with the matching generated magic. For nonzero builds it also verifies an
    explicit zero caller magic fails closed, and it keeps a distinct wrong
    magic denial case.
  - Passed on Windows Debug default magic build:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug nonzero magic build configured with
    `-DLCC_PROJECT_NAME=magic_smoke -DLCC_PROJECT_MAGIC_NUM=123456`:
    `ctest --test-dir build-magic -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  Acceptance criteria:
  - CI configures at least one install/package smoke with a nonzero
    `-DLCC_PROJECT_MAGIC_NUM`.
  - The installed and packaged generated headers expose the configured nonzero
    value.
  - Matching caller magic succeeds, zero/default caller magic fails, and a
    distinct wrong magic fails.
  - Minimal and fail-closed example docs show the generated constant rather
    than hard-coded `0`.

- [x] `P2` Add packaging guidance.
  Files inspected or updated:
  - `doc/analysis/release-artifacts.rst`
  - `README.md`
  - `doc/index.rst`
  - `doc/usage/integration.rst`
  - `cmake/ScanReleaseArtifact.cmake`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  Current verification:
  - Release artifact docs now list the runtime/customer package payload:
    public headers, generated project headers, `public_key.h`,
    `licensecc_static`, target exports, and package configuration files.
  - Docs state that customers consume the package with
    `find_package(licensecc REQUIRED COMPONENTS <project>)` or
    `-DLCC_PROJECT_NAME=<project>` and link `licensecc::licensecc_static`.
  - Docs state Boost is a build/test and issuer-tool dependency, not a runtime
    dependency of the final `licensecc` library.
  - Docs state Linux runtime builds require OpenSSL for signature verification,
    while Windows runtime builds use system cryptography libraries.
  - Docs warn not to ship `private_key.rsa`, generated private project
    folders, `lccgen`, `lccinspector`, test keys, or local staging
    directories in runtime/customer packages.
  - Docs state license files are integrity-protected but not confidential;
    secrets must not be placed in license fields or `extra-data`.
  - Docs state `LCC_PROJECT_MAGIC_NUM` is a product/build discriminator, not a
    secret or anti-tamper mechanism.
  - Docs recommend private signing keys stay only in the issuing environment
    with restricted access, backups, and audit logging.
  - Docs clarify local client-side licensing is tamper-resistant, not
    tamper-proof, and recommends server-side entitlement or layered controls
    for high-value enforcement.
  - Existing artifact scan rejects private-key-like names, private-key PEM
    markers, generated project folders, `lccgen`, `lccinspector`, and lccgen
    package configs from runtime artifacts.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed: `python scripts/check_docs_links.py doc`.
  Acceptance criteria:
  - Clarifies which artifacts are needed by the customer application.
  - Clarifies that Boost is a build/test dependency, not a runtime dependency
    for the final `licensecc` library.
  - Clarifies OpenSSL requirements on Linux.
  - Warns not to package `private_key.rsa`, generator project private folders,
    or `lccgen` in client installers.
  - Explains that license files are integrity-protected, not confidential.
  - Explains that `LCC_PROJECT_MAGIC_NUM` is a product/build discriminator, not
    a secret.
  - Recommends storing private signing keys only in the issuing environment with
    restricted access, backups, and audit logging.
  - Clarifies that local client-side licensing is tamper-resistant, not
    anti-tamper against attackers who can patch the binary.

- [x] `P1` Add broader consumer-project integration tests.
  Current verification:
  - `test_install_consumer_smoke` installs to a staging prefix, builds the
    external minimal consumer with `-DLCC_PROJECT_NAME=<project>`, builds a
    generated consumer with `find_package(licensecc REQUIRED COMPONENTS
    <project>)`, rejects missing, wrong, and multiple project selections, and
    builds the component consumer again after copying the install prefix to a
    relocated path with spaces.
  - `test_package_consumer_smoke` creates and extracts the runtime package,
    scans the extracted payload, builds the external minimal consumer from the
    extracted prefix, then builds a fresh consumer after copying that package
    prefix to a relocated path with spaces.
  - Local Windows Debug verification:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure` passed `2/2`.
  Acceptance criteria:
  - A minimal external C++ project builds against an installed `licensecc`
    package on Windows and Linux using only `find_package(licensecc)`.
  - One smoke configures with `find_package(licensecc REQUIRED COMPONENTS
    <project>)`; another configures with `-DLCC_PROJECT_NAME=<project>`.
  - Missing, wrong, and multiple component selections fail clearly.
  - A relocated install/package prefix still configures a fresh consumer.
  - Tests cover valid, missing, malformed, corrupted, expired, wrong-feature,
    wrong-version, wrong-magic, and hardware-mismatch licenses.
  - Tests assert every failure path denies access.
  - Packaging tests scan release artifacts and fail if private keys, project
    private folders, or `lccgen` are present.

- [ ] `P1` Define multi-project CMake package identity semantics.
  Files to inspect or update:
  - `src/cmake/licensecc-config.cmake`
  - `src/library/CMakeLists.txt`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  Current progress:
  - The installed `licensecc-config.cmake` is now produced with
    `configure_package_config_file()` and `@PACKAGE_INIT@`, then derives
    project exports and release manifests from `PACKAGE_PREFIX_DIR`.
  - Package configuration now uses the same strict project-token policy as
    `lccgen`: project names must start with an ASCII letter or `_` and contain
    only ASCII letters, digits, and `_`.
  - Package configuration validates selected project/component names before
    using them in manifest or export paths; unsafe names such as `../...` fail
    before filesystem lookup.
  - Package configuration loads
    `share/licensecc/<project>/release-manifest.cmake` before including the
    exported target and requires project name, project magic, package profile,
    build config, ABI tag, and public-key SHA256 metadata.
  - `licensecc::licensecc_static` is stamped with `LICENSECC_PROJECT_NAME`,
    `LICENSECC_PROJECT_MAGIC_NUM`, `LICENSECC_PACKAGE_PROFILE`,
    `LICENSECC_PUBLIC_KEY_SHA256`, `LICENSECC_ABI_TAG`,
    `LICENSECC_BUILD_CONFIG`, and `LICENSECC_MANIFEST_PATH`.
  - If `licensecc::licensecc_static` already exists, package configuration now
    compares those identity properties and fails before reusing a target with
    missing or mismatched project identity.
  - The package exposes the same identity through `licensecc_*` and
    `LICENSECC_*` variables for consumer-side validation.
  - `test_install_consumer_smoke` now verifies component metadata, same-project
    idempotent `find_package()` calls, relocated metadata consumption,
    pre-existing target without metadata failure, pre-existing target with
    wrong metadata failure, Debug/Release build-config mismatch failure,
    unsafe component failure, unsafe `LCC_PROJECT_NAME` failure, and a
    synthetic second project whose target reuse fails before it can bind to the
    wrong public key.
  - `test_package_consumer_smoke` verifies the extracted runtime package exposes
    matching package variables and target metadata.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` are now
    included in the `validation` CTest label, and `test_ctest_label_audit`
    asserts that coverage.
  - Local Windows Debug verification:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error` passed `3/3`.
  Acceptance criteria:
  - Package configuration uses `configure_package_config_file()` with
    `@PACKAGE_INIT@`, or an equivalent documented relocatable pattern with
    relocation tests, instead of unverified hand-built relative paths.
  - A CMake process that loads two installed `licensecc` packages for different
    projects either gets distinct imported targets or a precise fatal error
    before it can bind to the wrong embedded public key.
  - If `licensecc::licensecc_static` already exists, package configuration
    checks target metadata and fails before reusing a target for a different
    project, project magic, package profile, or public key fingerprint.
  - Component/project names are validated before being used in paths; empty
    names, `..`, path separators, shell metacharacters, and unsafe characters
    are rejected.
  - The package records and exposes the embedded project name, project magic,
    public-key fingerprint or key ID, and package profile.
  - A two-project smoke installs or extracts packages for `Foo` and `Bar`,
    consumes them from one CMake configure, and proves wrong-key or wrong-target
    selection cannot silently succeed.
  - `find_package(licensecc <version> REQUIRED COMPONENTS <project>)` has
    tested success and failure behavior.
  - Debug and Release package selections fail clearly if a consumer mixes
    incompatible configurations.

- [x] `P2` Clarify consumer language-standard expectations.
  Files to inspect or update:
  - `include/licensecc/licensecc.h`
  - `examples/minimal/CMakeLists.txt`
  - `examples/fail_closed_host/CMakeLists.txt`
  - `doc/usage/integration.rst`
  Evidence:
  - `examples/minimal` and `examples/fail_closed_host` now request C++11, not
    C++17.
  - `doc/usage/integration.rst` states that installed public headers and
    examples are tested with C++11, while pure C hosts need a C++ linker or
    project-owned wrapper plus their own smoke test.
  - `test_install_consumer_smoke` builds a tiny installed-prefix C++11
    consumer that includes `<licensecc/licensecc.h>`, links
    `licensecc::licensecc_static`, and validates project metadata macros and
    public ABI sizing.
  Acceptance criteria:
  - Docs state whether consumers need C++17 only for examples, or whether the
    installed public API supports C and older C++ callers.
  - If C or C++11 consumers are supported, at least one tiny installed-prefix
    smoke builds with that language mode.
  - If only modern C++ consumers are supported, examples and package metadata
    make the requirement explicit.

- [x] `P1` Remove public include-path and Windows-header footguns.
  Files to inspect or update:
  - `include/licensecc/datatypes.h`
  - `include/licensecc/licensecc.h`
  - `src/templates/licensecc_properties.h.in`
  - `src/library/CMakeLists.txt`
  - `test/install_consumer_smoke.cmake`
  Current progress:
  - `include/licensecc/datatypes.h` no longer includes `<windows.h>` for
    public API sizing and no longer exposes `MAX_PATH` through the public
    `AuditEvent` ABI. It defines and uses `LCC_API_PATH_SIZE` instead, with
    platform-specific values matching the previous Windows and Unix buffer
    sizes.
  - Public headers now require the project-scoped generated properties header
    through `LCC_PROJECT_CONFIG_HEADER`, which the build and installed CMake
    target provide as `licensecc/<project>/licensecc_properties.h`.
  - `licensecc_static` now exposes only the package include root publicly for
    installed consumers; the unqualified generated-header directory is no
    longer part of its installed public include interface.
  - The build still keeps the old generated-header directory private/internal
    for legacy implementation includes, while consumers receive the scoped
    include path and compile definition through `licensecc::licensecc_static`.
  - The generated properties include guard was changed from the generic
    `BUILD_PROPERTIES_H_` to `LCC_LICENSECC_PROPERTIES_H_`.
  - `test_install_consumer_smoke` now builds an external consumer with a fake
    conflicting `licensecc_properties.h` earlier on the include path and fails
    if the public package includes that shadow header. The same consumer checks
    that including only `<licensecc/licensecc.h>` does not define Windows
    `min` or `max` macros.
  - `test_public_api` now verifies the public path buffer uses
    `LCC_API_PATH_SIZE` and performs a preprocessor check that the public
    header does not define `min` or `max`.
  - Local Windows Debug verification:
    `ctest --test-dir build -C Debug -R
    "test_public_api|test_event_registry|test_install_consumer_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error` passed `4/4`.
  - Local Windows Debug package verification:
    `ctest --test-dir build -C Debug -R "test_package_consumer_smoke"
    --output-on-failure --no-tests=error` passed `1/1`.
  - `doc/usage/integration.rst`, `examples/minimal`, and
    `examples/fail_closed_host` use checked bounded-copy helpers before
    populating fixed-size feature/version/path buffers.
  Acceptance criteria:
  - Public headers no longer include `<windows.h>` just to obtain `MAX_PATH`;
    they use licensecc-owned fixed ABI constants and avoid `min`/`max` macro
    pollution in existing C++ projects.
  - Generated `licensecc_properties.h` is project-scoped or wrapped so two
    licensecc projects cannot collide through an unqualified
    `<licensecc_properties.h>` include.
  - Consumer smoke tests compile with a fake conflicting
    `licensecc_properties.h` earlier on the include path and fail only if the
    public package selects the wrong generated header.
  - Public docs and examples use feature names within
    `LCC_API_FEATURE_NAME_SIZE` or show checked bounded-copy helpers that
    fail closed instead of silently truncating requested feature names.
  - Public ABI compatibility impact is documented before changing struct
    layouts or constants.

- [x] `P1` Add public ABI and API-surface compatibility gates.
  Files to inspect or update:
  - `include/licensecc/datatypes.h`
  - `include/licensecc/licensecc.h`
  - `test/library/public_api_test.cpp`
  - `test/install_consumer_smoke.cmake`
  - `.github/workflows`
  Current progress:
  - `test_public_api` records the supported ABI profile: public buffer
    constants, supported format range macros, public enum values, struct sizes,
    and practical field offsets for `AuditEvent`, `LicenseLocation`,
    `CallerInformations`, `LicenseInfo`, and `ExecutionEnvironmentInfo`.
  - `test_public_api` also links every current public C API symbol by address
    so removed or renamed public functions fail the test build/link step.
  - `test_install_consumer_smoke` now builds an installed-package C++11
    consumer with static assertions for the same public ABI constants,
    selected struct sizes/offsets, selected enum values, and linked C API
    symbols.
  - `doc/usage/migration-guide.rst` documents that changes to public structs,
    constants, enum values, or exported C API symbols require a same-patch
    release-note or migration-guide entry naming the affected public surface and
    required consumer action.
  Evidence:
  - `cmake --build build --config Debug --target test_public_api`
  - `ctest --test-dir build -C Debug -R "test_public_api|test_install_consumer_smoke" --output-on-failure --no-tests=error`
  - `ctest --test-dir build -C Debug -L public_api --output-on-failure --no-tests=error`
  Acceptance criteria:
  - Tests record expected public struct sizes, field offsets where practical,
    enum values, buffer constants, and exported C symbols for the supported
    ABI profile.
  - Any ABI-affecting change requires a release-note or migration-guide entry
    naming the affected structs, constants, and consumer action.
  - The installed-package smoke validates the public ABI from a downstream
    C++11 consumer rather than only from in-tree tests.
  - CI fails when exported public API symbols disappear or public struct layout
    changes without an explicit compatibility update.

- [x] `P2` Define the pure-C support stance.
  Files to inspect or update:
  - `README.md`
  - `include/licensecc/licensecc.h`
  - `doc/usage/integration.rst`
  - `test/install_consumer_smoke.cmake`
  Current progress:
  - `doc/usage/integration.rst` states that installed public headers and
    examples are tested with C++11 and that pure C hosts should link through a
    C++ linker rule or use a project-owned C wrapper with its own smoke test.
  - `README.md` now describes the runtime as a C++ library with C-linkage
    public functions for C++ consumers or wrappers, not a self-contained
    pure-C package.
  - `include/licensecc/licensecc.h` repeats the same stance at the public API
    boundary.
  - `test_install_consumer_smoke` continues to build an installed-prefix C++11
    consumer and now also pins selected public ABI constants, offsets, enum
    values, and linked C API symbols.
  Evidence:
  - `ctest --test-dir build -C Debug -L public_api --output-on-failure --no-tests=error`
  Acceptance criteria:
  - Public docs consistently state whether Licensecc supports pure-C consumers
    directly, C-linkage from a C++ library, or only C++ host builds.
  - If pure C is supported, CI builds a tiny C consumer from the installed
    package and documents the required linker/runtime libraries.
  - If pure C is not supported, README/API wording avoids implying a
    self-contained C library and tells C hosts to use a project-owned wrapper
    with its own smoke test.

- [ ] `P1` Add versioned and layout-aware package consumer smokes.
  Files to inspect or update:
  - `src/cmake/licensecc-config.cmake`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  - `CMakeLists.txt`
  Acceptance criteria:
  - Consumer smokes cover `find_package(licensecc <version> REQUIRED
    COMPONENTS <project>)` success and version-mismatch failure.
  - Installed and packaged consumers work with a non-default install library
    directory when `GNUInstallDirs` or an equivalent documented convention is
    selected.
  - Package docs and release artifact docs avoid hard-coded `lib/...` paths
    unless the package intentionally fixes that layout and tests it.
  - Transitive OpenSSL/platform dependencies resolve from a clean downstream
    Linux/OpenSSL consumer, not only from the build tree.

- [x] `P1` Add release manifest key identity checks.
  Files to inspect or update:
  - `cmake/WriteReleaseManifest.cmake`
  - `cmake/ReadReleaseManifest.cmake`
  - `cmake/ScanReleaseArtifact.cmake`
  - `src/cmake/licensecc-config.cmake`
  - `test/artifact_scan_smoke.cmake`
  - `test/manifest_summary_smoke.cmake`
  Current progress:
  - Release manifests now record wrapper-file identity separately from signing
    key identity: `LCC_RELEASE_PUBLIC_KEY_SHA256` remains the generated
    `public_key.h` file hash, while `LCC_RELEASE_PUBLIC_KEY_DER_SHA256` and
    `LCC_RELEASE_PUBLIC_KEY_ID` identify the DER public key embedded in that
    header.
  - Manifest writing fails if generated `public_key.h` lacks DER SHA/key-id
    metadata or if `LCC_PUBLIC_KEY_ID` is not `sha256:<LCC_PUBLIC_KEY_SHA256>`.
  - Artifact scanning requires the new manifest keys and verifies they agree
    with `LCC_PUBLIC_KEY_SHA256` and `LCC_PUBLIC_KEY_ID` in `public_key.h`,
    alongside the existing wrapper hash, DER length, algorithm, bit length, and
    signature algorithm checks.
  - Installed package config exports the new key identity as
    `licensecc_PUBLIC_KEY_DER_SHA256`, `licensecc_PUBLIC_KEY_ID`,
    `LICENSECC_PUBLIC_KEY_DER_SHA256`, and `LICENSECC_PUBLIC_KEY_ID`, and
    stamps matching target properties on `licensecc::licensecc_static`.
  Evidence:
  - `test_artifact_scan_smoke` now rejects manifest DER-SHA and key-ID
    mismatches.
  - `test_manifest_summary_smoke` covers the new summary fields.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` verify the
    new package metadata from installed/extracted consumers.
  - Validation commands:
    `ctest --test-dir build -C Debug -R "test_artifact_scan_smoke|test_manifest_summary_smoke" --output-on-failure --no-tests=error`
    `ctest --test-dir build -C Debug -R "test_install_consumer_smoke|test_package_consumer_smoke" --output-on-failure --no-tests=error`
  Acceptance criteria:
  - Release manifests record the DER key fingerprint/key ID separately from
    the hash of the generated `public_key.h` wrapper file.
  - Package config exports both file identity and key identity for downstream
    validation.
  - Artifact scans verify manifest key ID, `LCC_PUBLIC_KEY_ID`,
    `LCC_PUBLIC_KEY_SHA256`, DER bytes, algorithm, and bit length agree.
  - Mismatched manifest key identity fails before install/package artifacts are
    accepted.

- [ ] `P1` Add release artifact identity manifests and profile-aware package
  names.
  Files to inspect or update:
  - `CMakeLists.txt`
  - `cmake/ScanReleaseArtifact.cmake`
  - `test/package_consumer_smoke.cmake`
  - `.github/workflows`
  Current progress:
  - `test_artifact_scan_smoke` stages a valid runtime skeleton and verifies
    `cmake/ScanReleaseArtifact.cmake` accepts it.
  - The same smoke stages representative forbidden runtime payloads and
    verifies the scanner rejects each one: `private_key.rsa`, `signing.key`,
    PEM private-key text inside a non-key `.txt` file, `projects/...`,
    `lccgen`, `lccinspector`, and `lib/cmake/lccgen/...`.
  - The smoke also proves `LCC_ARTIFACT_ALLOW_TOOLS=ON` permits tool
    executables only when the caller explicitly selects a tools/support
    profile.
  - `test_artifact_scan_smoke` is wired into CTest with
    `security;validation;package` labels and is covered by
    `test_ctest_label_audit`.
  - Runtime and tools package filenames now include package name, version,
    profile, project name, build configuration, compiler/runtime ABI tag, and
    platform through `CPACK_PACKAGE_FILE_NAME` plus
    `cmake/LicenseccCPackOptions.cmake.in` so multi-config `cpack -C <config>`
    uses the actual packaged configuration.
  - Source package filenames now use the explicit `source` profile through the
    same CPack options file instead of inheriting the current runtime/tools
    binary profile.
  - Install and package flows write
    `share/licensecc/<project>/release-manifest.cmake` with manifest version,
    package name/version/profile, project name, project magic, build config,
    platform, system processor, generator, compiler ID/version/architecture,
    runtime linkage, ABI tag, public-key relative path, SHA256, generated DER
    length, public-key algorithm, public-key bit length, signature algorithm,
    and generated-properties relative path and SHA256.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` verify that
    the release manifest exists, identifies the expected project/profile/magic,
    records the expected build configuration, platform, and ABI tag, and that
    the manifest hashes match the installed or extracted `public_key.h` and
    `licensecc_properties.h`.
  - `test_package_consumer_smoke` also verifies the runtime package filename
    identifies the `runtime` profile, selected project, build configuration,
    and ABI tag.
  - Runtime artifact scanning now has an opt-in allowlist mode enabled with
    `LCC_ARTIFACT_EXPECTED_PROFILE=runtime` and
    `LCC_ARTIFACT_EXPECTED_PROJECT_NAME=<project>`. In this mode only the
    expected public headers, generated project headers, library/export files,
    package config files, and release manifest paths are accepted.
  - Runtime allowlist scanning is now manifest-aware: it requires exactly one
    `share/licensecc/<project>/release-manifest.cmake`, verifies required
    manifest identity fields, checks the manifest profile and project against
    the expected scan inputs, rejects unsafe or wrong manifest paths, and
    verifies the manifest SHA256 values for `public_key.h` and
    `licensecc_properties.h`.
  - Runtime allowlist scanning also verifies the manifest public-key DER length
    against `PUBLIC_KEY_LEN`, compares manifest algorithm/bit/signature
    metadata against `public_key.h`, and rejects release artifacts below the
    configured RSA bit minimum, which catches legacy RSA-1024 public keys even
    when the manifest hash is internally consistent.
  - `cmake/ReadReleaseManifest.cmake` now parses release manifests as a strict
    data format instead of executing them with `include()`. The reader accepts
    only known `set(KEY "VALUE")` records and rejects unsupported syntax,
    unexpected keys, duplicate keys, and list separators.
  - `cmake/ValidateLicenseccIdentity.cmake` centralizes CMake validation for
    project names, project magic numbers, and package profiles. Root configure,
    release guards, manifest writing, and expected-profile artifact scans now
    validate identity values before using them in paths, manifests, or package
    metadata.
  - Install-time release scans and install/package consumer smokes run the
    runtime allowlist scan against the actual install prefix or extracted
    package prefix.
  - `test_artifact_scan_smoke` verifies the allowlist accepts a valid runtime
    skeleton and rejects unexpected runtime files plus wrong-project artifacts
    such as `include/licensecc/DEFAULT/public_key.h` when the expected project
    is `MY_PRODUCT`.
  - `test_artifact_scan_smoke` also verifies runtime allowlist scans reject
    missing release manifests, duplicate release manifests, wrong manifest
    project, wrong manifest profile, public-key hash mismatch, generated
    properties hash mismatch, and unsafe manifest paths.
  - `test_tools_profile_smoke` configures a nested Debug build with
    `-DLCC_INSTALL_TOOLS=ON`, `-DLCC_PROJECT_NAME=tools_smoke`, and a nonzero
    project magic, then builds, installs, packages, and extracts the tools
    profile.
  - The tools-profile smoke verifies the package filename identifies the
    `tools` profile, project, build configuration, and manifest ABI tag; the
    installed and extracted manifests report profile `tools`, and the package
    contains both `lccgen` and `lccinspector`.
  - The tools-profile smoke proves the extracted tools package fails the
    runtime/tool-free scanner, then passes only when
    `LCC_ARTIFACT_ALLOW_TOOLS=ON`.
  - `cmake/ScanReleaseArtifact.cmake` still scans private-key marker content in
    normal runtime artifacts; it skips that content-marker check only for known
    tool executables when the caller explicitly enables
    `LCC_ARTIFACT_ALLOW_TOOLS=ON`, because the issuer tool binary contains key
    marker strings as parser/export code.
  - `cmake/ScanSourceArtifact.cmake` now scans extracted source package roots
    for VCS metadata, local build/staging output directories, generated
    `projects/` directories, key-like filenames/extensions, symlinks, paths
    escaping the extracted root, and private-key PEM markers in file contents.
  - Source scanning now rejects common SSH key names (`id_rsa`, `id_dsa`,
    `id_ecdsa`, `id_ed25519`), PKCS/DER/JWK/secret key-like extensions
    (`*.der`, `*.p8`, `*.pk8`, `*.pkcs8`, `*.jwk`, `*.secret`), files with
    `signing` in the name, and encrypted private-key PEM markers.
  - `CPACK_SOURCE_IGNORE_FILES` now excludes submodule `.git` pointer files,
    top-level `Testing/` output, `_CPack_Packages/`, generated CMake/CPack
    files, local `pyvenv.cfg`, planning/agent local files, SSH private-key
    names, `signing` file names, and the expanded private-key/archive key
    extensions.
  - `test_source_package_smoke` proves the source scanner rejects synthetic
    `private_key.rsa`, `signing.key`, `id_rsa`, `*.der`, `*.jwk`, files with
    `signing` in the name, plaintext and encrypted PEM private-key markers,
    symlinks where the platform supports creating them, `projects/...`,
    `Testing/...`, and submodule `.git` fixtures, then creates a real CPack
    source ZIP, verifies the filename identifies the `source` profile and not
    `runtime` or `tools`, extracts it, verifies top-level `Testing/`,
    submodule `.git`, and the private-key test fixture are absent, and scans
    the extracted source root.
  - Source and test code no longer embed contiguous PEM private-key headers
    except in the key fixture that source packaging excludes; parser/test
    strings are split so source-content scanning can remain strict.
  - `cmake/PrintReleaseManifestSummary.cmake` prints a sanitized release
    manifest summary containing package/profile/project/build/platform,
    compiler/runtime ABI, public-key path/hash/algorithm/bit length, signature
    algorithm, and generated-properties path/hash, and refuses to print
    private-key-like paths or PEM private-key material.
  - Linux and Windows CI now print the sanitized manifest summary after normal
    runtime installs and after the Debug nonzero-magic install smoke.
  - Release-like configure, build, install, and package guards now reject
    reserved local placeholder project names through
    `LCC_FORBIDDEN_RELEASE_PROJECT_NAMES` (`DEFAULT`, `test`, `demo`,
    `example`, `sample`, `magic_smoke`, and `tools_smoke` by default) unless a
    maintainer explicitly opts out for local development.
  - The same release-like guards now require the selected project public and
    private keys to exist before release artifact generation unless
    `LCC_ALLOW_RELEASE_PROJECT_KEYGEN=ON` is set explicitly for local
    development.
  - Release-like guards now parse `PUBLIC_KEY_LEN`, `LCC_PUBLIC_KEY_ALGORITHM`,
    `LCC_PUBLIC_KEY_BITS`, and `LCC_SIGNATURE_ALGORITHM` from the selected
    generated `public_key.h`. They reject release install/package artifacts
    when the explicit public-key bit length is below
    `LCC_MIN_RELEASE_PUBLIC_KEY_BITS` (3072 by default) and retain
    `LCC_MIN_RELEASE_PUBLIC_KEY_DER_LEN` as a compatibility consistency check,
    so stale legacy RSA-1024 project keys cannot be packaged as product
    artifacts.
  - Binary CPack packaging now enforces the same release-artifact project-name
    and pre-existing-key policy regardless of build configuration through
    `cmake/LicenseccCPackOptions.cmake.in` and
    `LCC_ENFORCE_RELEASE_ARTIFACT_POLICY=ON`. Source packaging is excluded
    from that binary-runtime guard.
  - Local package smokes that intentionally package reserved local projects
    now pass explicit CPack-time development opt-outs instead of weakening the
    default binary package policy.
  - Linux and Windows CI use `LCC_PROJECT_NAME=licensecc_ci` instead of the
    reserved `test` project name, so Release CI artifacts exercise the same
    product-specific project-name guard as real product builds.
  - Linux and Windows Release CI prepare the `licensecc_ci` key base in an
    explicit Debug key-generation build before configuring and packaging the
    Release artifact, so CI does not depend on release-time key generation.
  - `test_release_safety_smoke` proves Release/RelWithDebInfo `DEFAULT`
    configure attempts fail, Release `test` and `demo` configure attempts
    fail, Release product-like projects with missing keys fail, and
    multi-config Release `release_project_guard` rejects `DEFAULT`, `test`,
    and product-like projects with missing keys. The same smoke proves a
    Release configure succeeds after an explicit Debug key-generation build
    prepares the product-like key base.
  - `test_release_safety_smoke` now stages weak RSA-1024-sized public-key
    fixtures and proves they fail both Release configure and Debug CPack
    package creation under the release-artifact policy.
  - `test_release_safety_smoke` now proves invalid root configure identities
    fail early for path traversal project names, hyphenated project names,
    leading-digit project names, and nonnumeric `LCC_PROJECT_MAGIC_NUM`.
  - `test_release_safety_smoke` also proves a Debug binary package for
    `DEFAULT` fails by default, the same local Debug package succeeds only
    with explicit CPack-time development opt-outs, and a Debug binary package
    for a product-like project with missing keys fails before packaging.
  - `test_manifest_summary_smoke` verifies prefix-based and explicit-manifest
    summary modes, checks expected safe summary fields, and proves a manifest
    pointing at `private_key.rsa` fails before printing.
  - `test_manifest_summary_smoke` also proves unsupported manifest commands are
    rejected without executing, unexpected keys fail, and duplicate keys fail.
    `test_artifact_scan_smoke` covers the same unsupported-syntax and
    unexpected-key failures through runtime artifact scanning.
  - `test_artifact_scan_smoke` now proves invalid expected scan profiles and
    invalid expected project names fail before allowlist matching.
  - `test_install_consumer_smoke` and `test_package_consumer_smoke` run the
    summary script against real installed and packaged runtime manifests.
  - `doc/analysis/release-artifacts.rst` documents profile-aware package
    names, build config and compiler/runtime ABI identity, the release
    manifest identity/checksum fields, the runtime allowlist scan, the
    explicit tools/support scan opt-in, explicit source-package profile names,
    strict data-only manifest reading, and extracted source-package plus CI
    manifest-summary scanning.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_source_package_smoke|test_manifest_summary_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_package_consumer_smoke|test_manifest_summary_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_tools_profile_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error`.
  - Passed earlier on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_release_safety_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error`.
  - Passed earlier on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_artifact_scan_smoke|test_ctest_label_audit" --output-on-failure
    --no-tests=error`.
  - Passed earlier on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_tools_profile_smoke|test_ctest_label_audit" --output-on-failure
    --no-tests=error`.
  - Passed earlier on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_cryptohelper|test_source_package_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_source_package_smoke|test_artifact_scan_smoke"
    --output-on-failure --no-tests=error`.
  - Passed earlier on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_source_package_smoke|test_manifest_summary_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error`.
  - Passed earlier on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_artifact_scan_smoke|test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_release_safety_smoke|test_package_consumer_smoke|test_tools_profile_smoke|test_source_package_smoke|test_ctest_label_audit"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_release_safety_smoke|test_artifact_scan_smoke|test_manifest_summary_smoke|test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_manifest_summary_smoke|test_artifact_scan_smoke|test_install_consumer_smoke|test_package_consumer_smoke|test_tools_profile_smoke"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug nonzero magic build configured with
    `-DLCC_PROJECT_NAME=magic_smoke -DLCC_PROJECT_MAGIC_NUM=123456`:
    `ctest --test-dir build-magic -C Debug -R
    "test_install_consumer_smoke|test_package_consumer_smoke"
    --output-on-failure --no-tests=error`.
  Five-agent review findings to close here:
  - Root CPack currently produces normal-looking `licensecc-<version>`
    packages even when tooling install rules are enabled; tools/support
    artifacts need distinct package names and profiles.
  - Runtime artifact scans catch private-key names, private-key content,
    project folders, tooling executables, and now validate an allowlisted
    manifest with expected runtime paths and SHA256 hashes. Binary package
    creation is now release-sensitive by default even outside release-like
    build configs.
  - Source-package ignore rules are weaker than the runtime scanner and should
    be aligned or replaced by an extracted source-package scan.
  Acceptance criteria:
  - Runtime, developer SDK, tools/support, and test packages have distinct
    profiles and names.
  - Root CPack defaults to a customer/runtime payload when
    `LCC_INSTALL_TOOLS=OFF`, and enabling tools creates a clearly named
    tools/support artifact rather than silently expanding the runtime package.
  - Package filename or manifest includes project name, package profile, build
    type, compiler/runtime ABI where relevant, platform, and public-key
    fingerprint or key ID.
  - Extracted artifact scanning verifies the manifest, checksums, absence of
    private signing keys, absence of source-tree project private folders, and
    absence of `lccgen` from customer runtime packages.
  - Runtime package scans compare extracted paths against an allowlist, so
    unexpected issuer directories, source-tree project directories, `DEFAULT`
    project artifacts, and known test/demo project names fail release
    validation.
  - Scanner fixtures deliberately stage `private_key.rsa`, `signing.key`, PEM
    private-key text in a non-key file, `projects/...`, `lccgen`,
    `lccinspector`, and `lib/cmake/lccgen/...`, and prove every case fails.
  - Source archives are either not produced as release artifacts or are scanned
    with rules at least as strict as runtime artifacts for private-key names,
    key-like extensions, local staging directories, and private-key content
    markers.
  - Release packaging fails for `DEFAULT`, known test project names, or missing
    issuer-controlled project/key base directories.
  - CI archives or prints the manifest summary without exposing private key
    material.

## P1: Test and Verification Gates

- [x] Add functional regression tests for canonicalization tampering.
  Existing coverage:
  - `test/functional/crack_test.cpp`
  - `test/library/LicenseLocator_test.cpp`
  - `test/functional/standard-license_test.cpp`

- [x] Add regression tests for version bound enforcement.
  Acceptance criteria:
  - Matching, below-range, above-range, missing caller version, and malformed
    bound cases are covered.

- [x] Add strict base64 regression tests for external license data.
  Acceptance criteria:
  - Valid encoded license data decodes correctly.
  - Invalid encoded license data is rejected without undefined behavior.

- [x] `P1` Expand the focused security CTest gate.
  Fixtures:
  - `extern/license-generator/test/license_test.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  - `extern/license-generator/test/project_test.cpp`
  - `extern/license-generator/test/cryptohelper_test.cpp`
  - `extern/license-generator/test/v201_canonical_payload_test.cpp`
  - `test/install_consumer_smoke.cmake`
  - `test/package_consumer_smoke.cmake`
  - `test/functional/crack_test.cpp`
  - `test/functional/standard-license_test.cpp`
  - `test/functional/signature_verifier_test.cpp`
  - `test/functional/date_test.cpp`
  - `test/functional/hw_identifier_it_test.cpp`
  - `test/library/LicenseReader_test.cpp`
  - `test/library/LicenseLocator_test.cpp`
  - `test/library/base64_test.cpp`
  - `test/library/v201_canonical_payload_test.cpp`
  - `test/library/license_verifier_test.cpp`
  - `test/library/public_api_test.cpp`
  - `test/library/hw_identifier/hw_identifier_facade_test.cpp`
  - `test/library/hw_identifier/hw_identifier_test.cpp`
  - `test/library/os/network_test.cpp`
  - `test/library/os/windows_disk_info_test.cpp`
  Commands:

    ```console
    ctest --test-dir build -C Debug -L security --output-on-failure
    ```

  Current verification:
  - `ctest --test-dir build -C Debug -N -L security` lists 32 tests covering
    generator validation, install/package smoke, parser/base64 behavior, public
    API fail-closed behavior, OS collectors, hardware IDs, license tampering,
    date/version handling, v201 canonical payloads, and signature policy.
  - Local Windows Debug verification:
    `ctest --test-dir build -C Debug -L security --output-on-failure` passed
    `32/32`.
  Acceptance criteria:
  - Parser, decoder, signature, version-limit, public API, OS collector, and
    hardware-ID regressions run in one security gate.
  - The gate fails on any unexpected `LICENSE_OK` from tampered or malformed
    input.
  - Residual OS collector fixture quality is tracked by the open deterministic
    hardware collector test item.

- [x] `P1` Make the security CTest label a required CI gate.
  Files to inspect or update:
  - `.github/workflows/linux.yml`
  - `.github/workflows/windows.yml`
  Current verification:
  - Linux workflow has a named `Security facet gates` step running
    `ctest -L security --output-on-failure` and the parser, signature, base64,
    public-api, generator, package, validation, verifier, and v201 facet gates
    after the full suite.
  - Windows workflow has a named `Security facet gates` step running
    `ctest -C <config> -L security --output-on-failure` and the same facet
    gates after the full suite, including v201.
  Acceptance criteria:
  - Linux and Windows workflows run
    `ctest -L security --output-on-failure` in addition to the full suite.
  - Security-labeled tests are required before release.
  - CI output makes security-gate failures easy to distinguish from unrelated
    test failures.

- [x] `P1` Add CTest label taxonomy and label-audit gate.
  Files to inspect or update:
  - `test/CMakeLists.txt`
  - `test/library/CMakeLists.txt`
  - `test/library/os/CMakeLists.txt`
  - `test/library/hw_identifier/CMakeLists.txt`
  - `test/functional/CMakeLists.txt`
  - `extern/license-generator/test/CMakeLists.txt`
  - `.github/workflows`
  Current verification:
  - Added `test/ctest_label_audit.cmake` and `test_ctest_label_audit`, labeled
    `security;validation`.
  - Facet labels now cover parser, base64, signature, public API, generator,
    package/install, platform, hardware, verifier, validation, and v201 gates.
  - Linux and Windows workflows run named gates for `security`, `parser`,
    `signature`, `base64`, `public_api`, `generator`, `package`, `install`,
    `platform`, `hardware`, `validation`, `verifier`, and `v201`, all with
    `--no-tests=error`.
  - `test_event_registry` is labeled `security;validation`.
  - The label audit now compares every discovered CTest test with the expected
    label matrix, so newly added unlabeled tests fail the validation gate.
  - Passed: `ctest --test-dir build -C Debug -R
    "test_ctest_label_audit|test_v201_canonical_payload|test_generator_v201_canonical_payload"
    --output-on-failure --no-tests=error`.
  - Passed: `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32`.
  - `test_ctest_label_audit` queries every required facet label, including
    `v201`, and fails if any facet has zero tests.
  - Optional docs, fuzz, and sanitizer label coverage is tracked by the open
    docs/fuzz/sanitizer evidence items instead of being required in a default
    non-fuzzer build.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Tests carry facet labels such as `parser`, `base64`, `signature`,
    `public_api`, `generator`, `package`, `install`, `platform`, `hardware`,
    `validation`, `verifier`, and `v201` in addition to the umbrella
    `security` label where appropriate.
  - Optional docs, fuzz, and sanitizer targets carry their own labels when the
    corresponding build mode is enabled.
  - A CMake audit test queries CTest label selections and fails if required
    tests lose expected labels.
  - CI runs named gates for at least `security`, `parser`, `signature`,
    `base64`, `public_api`, `generator`, `package`, `install`, `platform`,
    `hardware`, `validation`, `verifier`, and `v201`.
  - The checklist records the gate names for completed security-sensitive
    items.
  - Label audit failures are distinct from normal unit-test failures in CI
    output.

- [x] `P1` Expand v200 malformed-license regression coverage.
  Fixtures:
  - `test/library/test_reader.ini`
  - `test/library/test_reader_wrong_version.ini`
  - Generated licenses under `build/Testing/Temporary/<project>/licenses`
  Current verification:
  - `src/library/LicenseReader.cpp` now rejects duplicate requested sections,
    empty keys, uppercase keys, non-canonical key spacing, duplicate parsed
    values, non-canonical `lic_ver`, invalid base64 `sig`, and non-canonical
    date shapes before verification.
  - `test/library/LicenseReader_test.cpp` covers exact `lic_ver = 200`,
    comments around canonical keys, non-canonical license versions, duplicate
    `lic_ver`, duplicate `sig`, conflicting duplicate date keys, malformed
    dates, duplicate sections, empty keys, leading/extra/tab key spacing,
    unknown keys, split-key attacks, inline-comment values, and requested vs
    unrelated section behavior.
  - `test/functional/crack_test.cpp` covers malformed v200 licenses through
    `acquire_license` and proves they return `LICENSE_MALFORMED` without
    throwing.
  - Passed: `cmake --build build --config Debug --target test_license_reader
    test_crack`.
  - Passed: `ctest --test-dir build -C Debug -R "test_license_reader|test_crack"
    --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L security --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug --output-on-failure`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Unknown key, uppercase key, duplicate `sig`, missing `sig`, empty `sig`,
    invalid base64 `sig`, bad `lic_ver`, and split-key canonicalization attacks
    are covered.
  - `lic_ver` fixtures cover exact `200`, `0200`, `+200`, whitespace-padded
    values, duplicate values, and signed non-canonical values.
  - Date fixtures cover accepted runtime forms, impossible dates,
    normalization attempts, leap-day failures, zero month/day, and trailing
    garbage.
  - Duplicate sections, duplicate `lic_ver`, duplicate non-signature keys with
    conflicting values, empty keys, whitespace-padded keys, comments around
    keys, and unknown sections are covered.
  - A malformed requested section with a valid unrelated section fails only for
    the requested feature; a malformed unrelated section does not grant access
    to the requested feature.
  - All malformed variants return `LICENSE_MALFORMED`.
  - No malformed license throws through `acquire_license`.
  - Duplicate keys are rejected even when SimpleIni would otherwise keep one
    value.
  - A valid license in another section still succeeds only for its intended
    feature.

- [x] `P1` Add direct base64 decoder unit tests.
  Fixtures:
  - Valid encoded license content from `test/library/test_reader.ini`
  - Valid binary content containing embedded `NUL`
  - Invalid inputs: `""`, `"A"`, `"AA"`, `"AAA"`, `"!!!!"`, `"AA=A"`,
    `"AAAA===="`, `"AAAA-"`, whitespace, tabs, high-bit bytes, embedded
    `NUL`, and non-zero pad bits such as `"QR=="` and `"QUF="`
  Command:

    ```console
    ctest --test-dir build -C Debug -R "test_license_locator|test_base64" --output-on-failure
    ```

  Acceptance criteria:
  - Invalid base64 returns an empty vector/string and never arbitrary decoded
    bytes.
  - Valid decoded data preserves exact byte length, including embedded `NUL`.
  - `LICENSE_ENCODED` invalid data cannot produce `LICENSE_OK`.

- [x] `P1` Add base64 encoder short-input regression tests.
  Files updated:
  - `src/library/base/base64.cpp`
  - `extern/license-generator/src/base_lib/base64.cpp`
  - `test/library/base64_test.cpp`
  - `extern/license-generator/test/cryptohelper_test.cpp`
  Acceptance criteria:
  - Runtime and generator encoders cover input lengths `0`, `1`, and `2`.
  - Sanitizers report no unsigned-underflow or out-of-bounds behavior in the
    encoder loops.
  - Encoder and decoder round trips agree for short binary payloads.

- [x] `P1` Define and enforce base64 canonicalization policy.
  Files to inspect or update:
  - `src/library/base/base64.cpp`
  - `src/library/base/base64.h`
  - `src/library/LicenseReader.cpp`
  - `extern/license-generator/src/base_lib/base64.cpp`
  - `extern/license-generator/src/base_lib/base64.h`
  - `test/library/base64_test.cpp`
  - `test/library/LicenseReader_test.cpp`
  - `test/functional/signature_verifier_test.cpp`
  - `extern/license-generator/test/cryptohelper_test.cpp`
  Current verification:
  - Runtime and generator decoders now reject non-ASCII alphabet bytes,
    misplaced padding, invalid lengths, and non-zero pad bits. CR/LF remains
    allowed as transport wrapping and is normalized before canonical comparison.
  - Added `is_canonical_base64()` to runtime and generator base64 helpers.
    Current non-empty license fields require canonical spelling after optional
    CR/LF normalization; v200 `sig` uses the no-line-break policy.
  - Hardware identifiers and generator `--client-signature` already decode and
    reprint canonical `XXXX-XXXX-XXXX` form before acceptance; the stricter
    decoder now rejects noncanonical pad-bit aliases before that comparison.
  - Tests cover non-zero pad bits (`QR==`, `QUF=`), leading/trailing and
    internal CR/LF handling, spaces, tabs, high-bit bytes, embedded `NUL`,
    1 MiB binary round trip, and every invalid length modulo four.
  - `test_license_reader` covers noncanonical v200 signature pad bits returning
    `LICENSE_MALFORMED`; `test_signature_verifier` covers direct signature
    verification rejecting the same malformed base64.
  - Passed: `cmake --build build --config Debug --target test_base64
    test_license_reader test_signature_verifier test_cryptohelper`.
  - Passed: `ctest --test-dir build -C Debug -R
    "test_base64|test_license_reader|test_signature_verifier|test_cryptohelper"
    --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L base64 --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L parser --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L security --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug --output-on-failure` with `24/24`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - The project explicitly decides whether canonical base64 is required for
    v200 signatures, v201 signatures, environment license data, and hardware
    identifiers.
  - Fields that require canonical base64 are decoded, re-encoded, and compared
    to the original normalized spelling before use.
  - Tests cover non-zero pad bits, misplaced CR/LF, leading/trailing CR/LF,
    spaces, tabs, high-bit bytes, embedded `NUL`, very large input, and every
    invalid length modulo four.
  - The shared decoder policy that v201 signature and key-id fields must use
    rejects non-zero pad bits and non-canonical padding before signature
    verification or key selection; v201 field-specific wiring remains tracked
    by the open v201 canonical format and algorithm/key-id items.
  - Legacy CR/LF-tolerant transport decoding is isolated to base64
    normalization and does not allow noncanonical padding or alphabet aliases.
  - Runtime and generator decoders produce the same accept/reject decisions.

- [x] `P1` Add generator tests for malformed `--client-signature`.
  Files to inspect or update:
  - `extern/license-generator/test/license_test.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Acceptance criteria:
  - Valid fixed disk identifier generated from known 8-byte `HwIdentifier` data
    is accepted.
  - Malformed strings, wrong decoded size, unsupported strategy, invalid
    alphabet, bad padding, and empty string are rejected.
  - Reserved/control-bit variants with `decoded[0] = 0x01`, `0x3f`, `0x80`,
    and `0xc0` are rejected or explicitly accepted by a documented policy.
  - Invalid `--client-signature` returns non-zero and writes no license file.
  - Valid hardware identifiers still produce a license containing the exact
    `client-signature`.
  - IP/env-selected binding is rejected by default or accepted only behind an
    explicit weak-binding option.

- [x] `P1` Validate generator version bounds before writing licenses.
  Files to inspect or update:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/src/license_generator/license.hpp`
  - `extern/license-generator/test/license_test.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Acceptance criteria:
  - `--start-version` and `--end-version` reject empty components, too many
    components, non-digits, overlong components, and leading/trailing dots.
  - `start-version > end-version` is rejected if both bounds are present.
  - Generator validation matches runtime validation exactly.
  - Invalid version input returns non-zero and writes no license file.

- [x] `P1` Validate generator date bounds before writing licenses.
  Files updated:
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/license_test.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Acceptance criteria:
  - `--valid-from` and `--valid-to` accept only exact `YYYYMMDD`,
    `YYYY-MM-DD`, or `YYYY/MM/DD` input.
  - Impossible calendar dates, leap-day failures, zero month/day,
    out-of-range month/day, trailing garbage, and ambiguous slash formats are
    rejected before signing.
  - Invalid date input returns non-zero and writes no license file.

- [x] `P1` Make invalid `lccgen` automation inputs fail non-zero.
  Files updated:
  - `extern/license-generator/src/license_generator/command_line-parser.cpp`
  - `extern/license-generator/src/license_generator/license.cpp`
  - `extern/license-generator/test/command-line_test.cpp`
  Acceptance criteria:
  - Unknown CLI options, invalid dates, invalid versions, invalid primary keys,
    corrupt existing output files, and unwritable output paths return non-zero.
  - Invalid issuance inputs write no license file and do not truncate an
    existing valid license.
  - `write_license()` failures are propagated to `parseCommandLine()` instead
    of only printing diagnostics.
  - Existing corrupt output files are rejected as non-license files and their
    contents are preserved.
  - Existing valid license files are preserved when a later issuance command
    fails validation before writing.

- [x] `P1` Add runtime hardware identifier classification tests.
  Files to inspect or update:
  - `test/library/hw_identifier/hw_identifier_facade_test.cpp`
  - `test/functional/hw_identifier_it_test.cpp`
  Acceptance criteria:
  - Malformed client signature returns `LICENSE_MALFORMED`.
  - Well-formed mismatch returns `IDENTIFIERS_MISMATCH`.
  - Generated valid hardware-bound license still verifies.
  - License with signed malformed `client-signature` fails cleanly.

- [x] `P1` Add golden tests for v201 canonical payloads.
  Files inspected or updated:
  - `test/vectors/v201/`
  - `test/library/v201_canonical_payload_test.cpp`
  - `extern/license-generator/test/v201_canonical_payload_test.cpp`
  - `test/functional/signature_verifier_test.cpp`
  Current verification:
  - `test/vectors/v201/` contains minimal and full v201 golden fixtures:
    storage form, canonical payload hex, signature, expected verification
    result, public-key fingerprint, and PKCS#1 DER public-key hex.
  - The full vector covers feature-bound, hardware-bound, date-bound,
    version-bound, and `extra-data` fields in one signed payload.
  - Runtime and generator canonical-payload tests read the same fixture files
    and fail if generated canonical bytes drift from the checked-in hex.
  - `test_signature_verifier` verifies both golden signatures with the fixture
    public-key DER and a v201 policy, then proves payload and signature
    mutations fail closed.
  - The same test regenerates signatures from the fixed fixture private key and
    compares them with checked-in signature bytes, catching signing drift.
  - Existing v201 negative tests still cover field ordering, duplicate fields,
    unknown fields, bad `canonical-v`, bad `sig-v`, bad `sig-alg`,
    bad `key-id`, and v200-signature downgrade cases.
  - Passed on Windows Debug:
    `cmake --build build --config Debug --target test_v201_canonical_payload
    test_generator_v201_canonical_payload test_signature_verifier`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R
    "test_v201_canonical_payload|test_generator_v201_canonical_payload|test_signature_verifier"
    --output-on-failure --no-tests=error`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32`.
  - Linux/OpenSSL execution of these vectors is wired through the existing
    `security`, `signature`, and `v201` labels; compact cross-platform parity
    reporting remains tracked by the open Linux/Windows negative-vector parity
    item.
  Acceptance criteria:
  - Golden files under `test/vectors/v201/` capture exact canonical payload
    bytes in hex.
  - Golden files include storage form, key record or public-key fingerprint,
    `sig-alg`, `key-id`, signature, and expected verification result.
  - Runtime and generator fixtures produce the same canonical payload bytes.
  - Minimal, full, feature-bound, hardware-bound, date-bound, version-bound,
    and `extra-data` licenses are covered.
  - Field ordering, whitespace, duplicate field, unknown field,
    bad `canonical-v`, bad `sig-v`, bad `sig-alg`, bad `key-id`, and
    v200-signature downgrade cases are tested.
  - Tests fail if canonicalization changes unintentionally.

- [x] `P1` Add version/date boundary tests.
  Fixtures:
  - Generated licenses with `--start-version`, `--end-version`,
    `--valid-from`, and `--valid-to`
  Acceptance criteria:
  - Version bounds are inclusive at exact start/end.
  - Missing or malformed caller version returns `PRODUCT_NOT_LICENSED` when
    bounds exist.
  - Caller versions with trailing-dot syntax such as `1.` are rejected instead
    of being normalized to `1`.
  - Malformed license version/date fields return `LICENSE_MALFORMED`.
  - Clearly past/future date fixtures avoid time-sensitive flakes.

- [x] `P1` Add signature mutation regression matrix.
  Fixtures:
  - One valid generated license per signed field set
  - Mutations for `lic_ver`, `valid-from`, `valid-to`, `start-version`,
    `end-version`, `client-signature`, `extra-data`, feature name, and `sig`
  Acceptance criteria:
  - Mutating any signed field returns `LICENSE_CORRUPTED` or
    `LICENSE_MALFORMED`, never `LICENSE_OK`.
  - Mutating unsigned metadata cannot change licensing decisions.
  - Truncated, empty, and garbage signatures fail closed on Linux OpenSSL and
    Windows CryptoAPI.

- [x] `P1` Add direct signature verifier negative tests.
  Files updated:
  - `test/functional/signature_verifier_test.cpp`
  Acceptance criteria:
  - Empty, non-base64, bad-padding, truncated, oversized, and random signature
    blobs are rejected.
  - Valid data with one-byte signature mutation still fails.
  - Linux OpenSSL and Windows CryptoAPI paths agree on every negative vector.

- [x] `P1` Expand direct signature verifier edge tests.
  Files to inspect or update:
  - `test/functional/signature_verifier_test.cpp`
  Current verification:
  - `test_signature_verifier` now rejects exact-size all-zero and all-`0xff`
    RSA signature blobs against generated 1024-bit and 2048-bit public keys.
  - Empty payloads, embedded-`NUL` payloads, and 1 MiB payloads are signed and
    verified through the policy-aware request path, then rejected after payload
    mutation.
  - A signature over one payload spelling fails against a noncanonical
    alternate spelling, proving byte-exact payload verification.
  - v201 metadata tampering for the current single-key policy is covered by
    `test_signature_verifier`; key-ring and rotation-specific negatives remain
    tracked by the open algorithm/key-id/rotation item.
  - Passed: `cmake --build build --config Debug --target
    test_signature_verifier`.
  - Passed: `ctest --test-dir build -C Debug -R test_signature_verifier
    --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L signature
    --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L security
    --output-on-failure`.
  - Passed: `ctest --test-dir build -C Debug -L security
    --output-on-failure --no-tests=error` with `32/32`.
  - Passed: `git diff --check` and
    `git -C extern/license-generator diff --check`; both reported only
    existing LF-to-CRLF warnings.
  Acceptance criteria:
  - Exact-size all-zero and all-`0xff` signatures fail closed.
  - Empty payloads, embedded-`NUL` payloads, very large payloads, and valid
    signatures over noncanonical alternate payloads are covered.
  - v201 metadata tampering for `sig-alg`, `key-id`, `canonical-v`, and
    `sig-v` is covered for the current single-key policy; key-ring and
    rotation-specific tampering remains open.

- [x] `P1` Add algorithm and key-id negative tests for the current single-key
  policy.
  Evidence:
  - `signature_request_allowed()` rejects unknown algorithms, alias/case
    variants, duplicate allowlist entries, retired key IDs, duplicate retired
    entries, unknown key IDs, wrong license-version policy, and key-id/public
    key DER mismatches.
  - `SignatureVerificationPolicy::allow_external_public_key_der` defaults to
    false; production v200/v201 policies leave it false, while tests must opt
    in before passing generated or fixture public-key DER bytes.
  - `test_signature_verifier` covers unimplemented `rsa-pss-sha256` rejection
    even if a caller accidentally allowlists it, duplicate key-id denial,
    retired key-id denial, ungated external DER denial, wrong-key valid
    signatures, and v201 `lic_ver`, `canonical-v`, `sig-v`, `sig-alg`, and
    `key-id` tampering with no legacy fallback.
  - RSA-PSS salt-length and MGF1 mismatch tests remain conditional on a future
    RSA-PSS verifier implementation; RSA-PSS is not enabled in the current
    policy.
  - Production multi-key-ring selection and operator key rotation remain
    tracked by the open `Add key rotation and retired-key enforcement` item.
  Acceptance criteria:
  - Unknown `sig-alg`, alias/case variants, and mismatched declared algorithm
    vs actual signature fail closed.
  - Unknown `key-id`, duplicate key IDs, retired key IDs, and wrong-key valid
    signatures fail closed.
  - RSA-PSS salt length and MGF1 mismatches fail when RSA-PSS is enabled.
  - Tampering `lic_ver`, `canonical-v`, `sig-v`, `sig-alg`, or `key-id` never
    falls back to a legacy verification path.
  - Production verification uses only embedded project key material for the
    current single-key policy; caller-provided `public_key_der` is test-only or
    otherwise gated so a license cannot choose arbitrary trust material.
  - Negative tests cover mismatched `key-id` and public-key bytes.

- [x] `P1` Add Linux/Windows negative-vector parity reporting.
  Files to inspect or update:
  - `test/functional/signature_verifier_test.cpp`
  - `test/functional/crack_test.cpp`
  - `.github/workflows/linux.yml`
  - `.github/workflows/windows.yml`
  - `README.md`
  - `doc/index.rst`
  - `doc/development/Build-the-library.md`
  - `doc/development/Build-the-library-windows.rst`
  - `doc/development/Dependencies.md`
  Current verification:
  - `test_signature_verifier` now runs the checked-in v201 golden signed
    vectors through the platform signature verifier and mutates each vector to
    prove fail-closed behavior.
  - `signature_negative_vector_parity_report` prints compact
    `licensecc-parity backend=<backend> vector=<name> expected=<...>
    actual=<...> result=<pass|fail>` lines without private keys, raw hardware
    identifiers, or full license contents.
  - The report covers valid legacy signatures, malformed/empty/truncated
    signatures, algorithm aliases, unknown key IDs, v201 golden signed
    vectors, v201 payload/signature mutations, v201-with-v200-signature
    downgrade rejection, v201 metadata tampering, and v200 rejection of
    v201-only fields.
  - Linux and Windows workflows now include a `Signature parity report` step
    that runs `test_signature_verifier` with verbose CTest output after the
    normal security facet gates, so OpenSSL and Windows/CryptoAPI jobs print
    the same vector/result summary.
  - Public docs now state that MinGW and Linux-to-Windows cross-compilation are
    legacy/development flows, not release-validated paths, until a dedicated
    CI gate is added.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -R test_signature_verifier --verbose
    --output-on-failure --no-tests=error`; the output printed
    `backend=windows-cryptoapi` and all parity vectors as `result=pass`.
  - Passed on Windows Debug:
    `ctest --test-dir build -C Debug -L security --output-on-failure
    --no-tests=error` with `32/32`.
  - Passed: `python scripts/check_docs_links.py doc`.
  Acceptance criteria:
  - The same malformed-license, signature, algorithm, key-id, and downgrade
    vectors run on Linux/OpenSSL and Windows/CryptoAPI.
  - CI publishes or prints a compact vector/result summary for each platform.
  - Any vector accepted on one platform and rejected on another fails the build.
  - The summary avoids printing private key material, raw hardware identifiers,
    or full customer-like licenses.
  - Completed checklist items that depend on parity reference this report or
    the exact CI gate.
  - CI includes MinGW or Linux-to-Windows cross-compile coverage if public docs
    continue to claim that flow as supported.

- [x] `P1` Add locator and public API boundary tests.
  Files to inspect or update:
  - `src/library/locate/ExternalDefinition.cpp`
  - `src/library/locate/EnvironmentVarData.cpp`
  - `test/library/LicenseLocator_test.cpp`
  Current verification:
  - `test_public_api` covers invalid external data type, invalid encoded data,
    encoded non-INI data, plain non-INI data, embedded-NUL plain data,
    non-NUL-terminated max-size plain data, null `LicenseInfo`, prefilled
    `LicenseInfo`, invalid environment data, and null/short `identify_pc`
    buffers.
  - `test_license_locator` covers encoded external data, invalid encoded
    external data, and environment base64 with CR/LF line breaks.
  - `test_base64` covers CR/LF-tolerant decoding and malformed base64
    rejection.
  Acceptance criteria:
  - Non-NUL-terminated external `licenseData`, embedded NUL bytes, max-size
    buffers, invalid encoded data through `acquire_license`, and environment
    base64 with line breaks are covered.
  - Malformed external or environment data never produces `LICENSE_OK`.
  - Prefilled caller-owned `LicenseInfo` is fully reset on every non-OK result.
  - Public API tests are included in the `security` label.

- [ ] `P1` Add fuzz tests for parser and decoder surfaces.
  Current progress:
  - Added opt-in `BUILD_FUZZERS` support in top-level CMake and
    `test/fuzz/CMakeLists.txt`.
  - Added libFuzzer targets `fuzz_license_reader`, `fuzz_base64`,
    `fuzz_hw_identifier`, and `fuzz_v201_canonical_payload`.
  - Added seed corpora under `test/fuzz/corpus/license_reader/`,
    `test/fuzz/corpus/base64/`, `test/fuzz/corpus/hw_identifier/`, and
    `test/fuzz/corpus/v201_canonical_payload/`.
  - Added a Linux `fuzz-smoke` CI job that configures Clang/Ninja with
    ASan/UBSan, builds the fuzz targets, runs 60-second corpus fuzzing on
    push/pull_request, and extends runtime on the scheduled nightly workflow.
  - Added a build-time license-reader corpus generator that uses the configured
    `lccgen` and project keys to create valid v200/v201 licenses plus signed
    tamper variants for the fuzz run.
  - `fuzz_license_reader` now exercises both direct `LicenseReader` parsing and
    public `acquire_license` calls so parsed candidates continue into signature
    verification before any success result; valid generated corpus licenses are
    also checked with a deliberately bad caller magic value. The same fuzzer now
    covers explicit plain data, encoded data, path lists, environment license
    data, and environment license locations.
  - Extended the CTest label audit to recognize optional fuzz seed tests when
    `BUILD_FUZZERS=ON`.
  - Normal Windows Debug CTest discovery and focused parser/base64/v201 tests
    still pass with `BUILD_FUZZERS` off.
  - The new fuzz harness translation units compile with the local MSVC headers
    in a syntax-only/object compile check, but local libFuzzer linking was not
    available because the installed Clang toolchain could not configure the
    repo's Boost stack on Windows.
  - Local validation generated the build-time license-reader corpus with the
    Debug `lccgen`, producing 53 files: valid v200/v201 fixtures, encoded
    fixtures, path-list fixtures, signed extra-data/client-signature fixtures,
    oversized file/env fixtures, and mapped tamper variants from
    `test/functional/crack_test.cpp`.
  - Local Windows Debug validation passed the focused parser/base64/v201 CTest
    set and the full `security` label (`32/32`) with `BUILD_FUZZERS` off.
  - This item remains open until the Linux fuzz job has run green under
    ASan/UBSan/libFuzzer.
  Targets:
  - v200/v201 license reader
  - base64 decoder
  - license locator decoded external data
  - generator client-signature parser
  - hardware identifier parser
  - v201 canonical payload builder
  Corpora:
  - `test/fuzz/corpus/license_reader/`
  - `test/fuzz/corpus/base64/`
  - `test/fuzz/corpus/hw_identifier/`
  - `test/fuzz/corpus/v201_canonical_payload/`
  - Build-generated corpus under `build-fuzz/test/fuzz/corpus/license_reader_generated/`
    includes current-key valid v200/v201 licenses, encoded licenses, path-list
    inputs, oversized inputs, signed malformed extra-data/client-signature
    licenses, bad caller magic and environment-source coverage through the
    harness, and mapped tamper variants from `test/functional/crack_test.cpp`.
  - Initial source seed corpus includes malformed license shapes, strict base64
    vectors, hardware identifier examples, and v201 canonical-payload cases.
  Commands:

    ```console
    cmake -S . -B build-fuzz -G Ninja -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_BUILD_TYPE=RelWithDebInfo -DBUILD_FUZZERS=ON -DLCC_PROJECT_NAME=licensecc_ci -DLCC_PROJECTS_BASE_DIR=/tmp/licensecc-fuzz-projects -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer" -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address,undefined"
    cmake --build build-fuzz --target fuzz_license_reader fuzz_base64 fuzz_hw_identifier fuzz_v201_canonical_payload
    ./build-fuzz/test/fuzz/fuzz_license_reader -max_total_time=60 test/fuzz/corpus/license_reader build-fuzz/test/fuzz/corpus/license_reader_generated
    ```

  Acceptance criteria:
  - A `BUILD_FUZZERS` option exists and creates the listed fuzz targets.
  - Fuzz targets can be built without changing normal library or test builds.
  - Fuzz targets never crash on arbitrary input.
  - Sanitizers report no memory errors.
  - No malformed input throws through `acquire_license`.
  - Any parsed license still goes through signature verification before success.
  - Any malformed input that reaches public API boundaries fails closed instead
    of returning `LICENSE_OK`.
  - CI runs 60-second smoke fuzzing on pull requests and longer fuzzing nightly.

- [ ] `P1` Run fuzz targets through CTest and label audit.
  Files to inspect or update:
  - `test/fuzz/CMakeLists.txt`
  - `test/ctest_label_audit.cmake`
  - `.github/workflows/linux.yml`
  Acceptance criteria:
  - A `BUILD_FUZZERS=ON` CI job runs `ctest -L fuzz --no-tests=error` in
    addition to direct libFuzzer invocations.
  - `test_ctest_label_audit` runs in the fuzz build and proves every fuzz smoke
    target carries the expected `fuzz` label plus relevant parser/base64/
    hardware/v201 facets.
  - Fuzz CTest failures are distinct from normal unit-test failures in CI
    output.
  - The checklist records the exact green CI run or local equivalent before
    closing the fuzz item.

- [ ] `P1` Add sanitizer and platform CI jobs.
  Current progress:
  - `.github/workflows/linux.yml` now includes a `sanitizers` job on
    `ubuntu-22.04`.
  - The job configures a Debug ASan/UBSan build with an issuer-controlled
    temporary `LCC_PROJECTS_BASE_DIR`.
  - The job now builds the full sanitizer-instrumented test tree with
    `LCC_BUILD_INSPECTOR=OFF` and runs all direct executable tests under
    sanitizers, excluding install/package/source-package smoke tests whose
    consumer/package flows are not meaningful with sanitizer-instrumented static
    libraries.
  - The job also runs sanitizer facet gates for `public_api`, `parser`,
    `base64`, `signature`, `verifier`, `v201`, `generator`, `hardware`,
    `platform`, and `validation`, excluding the same package/install smoke
    tests.
  - `.github/workflows/linux.yml` now includes a Clang/libFuzzer
    `fuzz-smoke` job for parser, base64, hardware identifier, generator
    client-signature, and v201 canonical-payload surfaces.
  - The normal Linux build/security job now runs the Debug/Release matrix on
    both `ubuntu-22.04` and `ubuntu-24.04`, broadening the OpenSSL-backed
    platform coverage before release.
  - This item remains open because the sanitizer and fuzz jobs have not been
    observed green in CI.
  Commands:

    ```console
    cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer" -DCMAKE_EXE_LINKER_FLAGS="-fsanitize=address,undefined" -DLCC_PROJECT_NAME=test
    cmake --build build-asan -j2
    ASAN_OPTIONS=detect_leaks=1 UBSAN_OPTIONS=halt_on_error=1 ctest --test-dir build-asan --output-on-failure
    ```

  Acceptance criteria:
  - Linux ASan/UBSan job passes.
  - Windows Debug and Release jobs pass.
  - Linux OpenSSL-backed verification path is exercised.
  - Windows CryptoAPI verification path is exercised.
  - Generator submodule tests are part of the top-level CTest run.
  - Security-labeled tests, sanitizer smoke, and fuzz smoke are release
    blockers.

- [ ] `P1` Define sanitizer evidence and leak-detection policy.
  Files to inspect or update:
  - `.github/workflows/linux.yml`
  - `test/CMakeLists.txt`
  - `IMPLEMENTATION_CHECKLIST.md`
  Acceptance criteria:
  - CI either enables leak detection for sanitizer jobs or documents why leak
    detection is disabled for this dependency/test stack.
  - Sanitizer tests have an auditable CTest label or an equivalent named CI
    gate, and `--no-tests=error` prevents silent zero-test passes.
  - The public C-string boundary item references a green sanitizer run that
    exercised the boundary tests.
  - Sanitizer command examples in the checklist match the actual workflow
    environment variables and exclusions.

## P2: Documentation and Release Work

- [x] `P1` Add documentation validation to CI.
  Files to inspect or update:
  - `.github/workflows`
  - `requirements.txt`
  - `doc/conf.py`
  - `doc/index.rst`
  - `.readthedocs.yaml`
  - `doc/Doxyfile`
  - `scripts/check_docs_links.py`
  Current verification:
  - Linux workflow has a dedicated `docs` job on `ubuntu-22.04` that installs
    Doxygen, Graphviz, and pinned Python docs requirements, runs
    `doxygen doc/Doxyfile`, runs `python3 scripts/check_docs_links.py doc`,
    and builds Sphinx with `python3 -m sphinx -b html -W --keep-going -n`.
  - `.readthedocs.yaml` uses the same `requirements.txt`, installs Doxygen and
    Graphviz, runs Doxygen and the malformed-link checker in `pre_build`, and
    enables `sphinx.fail_on_warning`.
  - `requirements.txt` is pinned and installs successfully in an isolated
    Python 3.12 venv on Windows.
  - `doc/conf.py` provides a default Breathe XML path matching
    `doc/Doxyfile`, excludes generated doc output, and avoids the deprecated
    `canonical_url` theme option.
  - Fixed malformed `ttps://` license link, stale `lcc` issuer-tool commands,
    malformed RST code blocks, unresolved role usage in user docs, and the
    empty Markdown examples link.
  - Local Windows host lacks Doxygen/Sphinx on PATH by default; after installing
    docs Python requirements into `build/docs-venv`, a strict Sphinx run fails
    only because Doxygen XML is not locally present. The new CI/RTD jobs run
    Doxygen before Sphinx.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed: `python -m py_compile scripts/check_docs_links.py`.
  - Passed: docs dependency import smoke in `build/docs-venv`.
  Acceptance criteria:
  - CI installs Doxygen, Graphviz, and Python documentation requirements.
  - Sphinx builds with `sphinx-build -W --keep-going -n`.
  - Doxygen XML generation is enabled and fails CI on errors when API docs are
    part of the docs build.
  - Broken links such as malformed URLs are caught before release.
  - Missing docs tools fail CI instead of silently skipping docs.
  - Public docs do not ship stale "NOT IMPLEMENTED" claims for implemented
    security behavior.
  - Integration docs match the verified install path and do not reference
    missing files or unsupported variables.

- [x] `P0` Wire install/package smoke tests into release validation.
  Files to inspect or update:
  - `src/cmake/licensecc-config.cmake`
  - `src/library/CMakeLists.txt`
  - `examples/minimal`
  Current verification:
  - The package smoke is wired into CTest with labels `security;install`.
  - The package smoke creates and extracts the runtime package, scans the
    extracted package payload, and builds/runs the external consumer from the
    extracted package prefix.
  - Linux and Windows GitHub Actions install to a staging prefix, scan the
    runtime install, run the full test suite, and run
    `ctest -L security --output-on-failure`.
  Acceptance criteria:
  - CI installs to a staging prefix, then builds an external consumer project
    using only `find_package(licensecc REQUIRED)`.
  - Linux and Windows package-config paths work with `CMAKE_PREFIX_PATH`.
  - Wrong or missing project names fail at configure time with a clear package
    error.
  - Installed artifacts expose generated properties and public headers through
    target include directories.
  - Consumer tests verify valid, missing, malformed, corrupted, expired,
    wrong-feature, wrong-version, wrong-magic, and hardware-mismatch licenses.

- [x] `P0` Define release artifact profiles and artifact scans.
  Files to inspect or update:
  - `CMakeLists.txt`
  - `src/library/CMakeLists.txt`
  - `src/inspector/CMakeLists.txt`
  - `extern/license-generator/src/license_generator/CMakeLists.txt`
  - `extern/license-generator/CMakeLists.txt`
  - `.github/workflows`
  - `doc/analysis`
  Current verification:
  - Runtime install files use the `licensecc_runtime` component.
  - Tooling install files use `licensecc_tools`, and root installs leave
    `lccgen` and `lccinspector` out by default unless `LCC_INSTALL_TOOLS=ON`.
  - The vendored generator only owns CPack when built standalone.
  - `cmake/ScanReleaseArtifact.cmake` scans runtime artifacts for private-key
    names, private-key content markers, generated project folders, `lccgen`,
    and `lccinspector`.
  - Root CPack source excludes now cover generated project folders and local
    staging directories.
  - `doc/analysis/release-artifacts.rst` defines runtime/customer and
    developer/tooling profiles.
  - `test_package_consumer_smoke` extracts and scans produced runtime packages.
  - Linux and Windows workflows run the install/package gate through the
    security label.
  Acceptance criteria:
  - A developer SDK/tooling package and a customer runtime package have explicit
    contents.
  - Install rules use named components such as runtime, development, and tools;
    release-relevant files are not left in the implicit `Unspecified`
    component.
  - `lccgen` installation is opt-in from the root/customer runtime build.
  - `lccinspector` is either excluded from customer runtime artifacts or
    included only as an explicit support-tooling profile.
  - Customer/runtime artifacts do not contain `private_key.rsa`, generator
    project private folders, test keys, or `lccgen`.
  - Customer/runtime artifacts do not include `lccinspector` unless that is an
    explicit supported product decision.
  - Source-tree generated project folders are not packaged accidentally.
  - CPack/source-package excludes cover `projects/`, `build/`, `install/`,
    generated private-key names, and other local staging directories.
  - Artifact scans check file names and contents for private-key markers such
    as PEM private-key headers, `*.pem`, `*.key`, `*.p12`, and `*.pfx`.
  - CI extracts produced packages and fails if forbidden issuing artifacts are
    present in customer packages.

- [x] `P1` Write a migration guide from current v200 behavior to hardened v200
  and v201.
  Files updated:
  - `doc/usage/migration-guide.rst`
  - `doc/usage/issue-licenses.md`
  - `doc/analysis/security-model.rst`
  Current verification:
  - Added `doc/usage/migration-guide.rst`, included by the existing
    `usage/*` Sphinx toctree, covering hardened v200 rejects, expected public
    result codes, regeneration with current `lccgen`, valid v200 compatibility
    boundaries, explicit v201 issuance, weak hardware-binding opt-ins, and
    fail-closed host-application startup policy.
  - Existing `doc/usage/issue-licenses.md` documents strict v200 issuance,
    v201 opt-in, date/extra-data constraints, and weak hardware binding flags.
  - Existing `doc/analysis/security-model.rst` documents the threat model,
    v200 compatibility grammar, version limits, hardware binding policy, and
    multi-source behavior.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed: `python -m py_compile scripts/check_docs_links.py`.
  - Local strict Sphinx run with `build/docs-venv/Scripts/python.exe -m sphinx
    -b html -W --keep-going -n doc build/docs/sphinx-local` read
    `usage/migration-guide` successfully and failed only on the existing
    missing Doxygen XML warnings because `doxygen` is not installed locally.
  Acceptance criteria:
  - Lists behavior that is now rejected, including non-canonical key/value
    spacing, duplicate keys, duplicate requested sections, bad `lic_ver`, bad
    dates, unknown keys, and invalid signatures.
  - Explains how to regenerate affected licenses.
  - Explains how long legacy licenses remain accepted.
  - Lists weak hardware-binding policy changes and expected error codes.
  - States that current generator defaults emit strict v200, explicit
    `--license-version=201 --target-license-format-max=201` requires a
    v201-capable runtime, and supported-format package/runtime metadata is
    still required before making v201 the default.

- [x] `P2` Add security notes to public docs.
  Files updated:
  - `doc/analysis/security-notes.rst`
  - `doc/analysis/security-model.rst`
  Current verification:
  - Added `doc/analysis/security-notes.rst`, included by the existing
    `analysis/*` Sphinx toctree, stating that Licensecc is tamper-resistant but
    not tamper-proof, recommending server-side entitlement checks for high-value
    enforcement, describing signing-key handling and v200/v201 algorithm
    metadata, and documenting hardware identifiers as device/personal support
    data rather than secrets.
  - The security notes document collection, retention, IP-binding, environment
    source, extra-data, and release-gate expectations.
  - `doc/analysis/security-model.rst` remains the detailed threat model and
    compatibility reference linked from the new page.
  - Passed: `python scripts/check_docs_links.py doc`.
  - Passed: `python -m py_compile scripts/check_docs_links.py`.
  - Local strict Sphinx run with `build/docs-venv/Scripts/python.exe -m sphinx
    -b html -W --keep-going -n doc build/docs/sphinx-local` read
    `analysis/security-notes` successfully and failed only on the existing
    missing Doxygen XML warnings because `doxygen` is not installed locally.
  Acceptance criteria:
  - Makes clear that local licensing is tamper-resistant, not tamper-proof.
  - Recommends server-side entitlement checks for high-value enforcement.
  - Describes supported signing algorithms and minimum key sizes.
  - Documents hardware identifiers as device/personal data, not secrets.
  - Explains support handling, retention expectations, and when IP identifiers
    should not be collected.

- [x] `P2` Add reproducible hosted-docs configuration if docs are published.
  Acceptance criteria:
  - `.readthedocs.yaml` or an equivalent source-controlled config pins the docs
    build path, Python version, and dependencies.
  - Local docs, CI docs, and hosted docs use the same dependency list.

- [ ] `P1` Add release evidence capture and artifact retention.
  Files to inspect or update:
  - `.github/workflows`
  - `cmake/PrintReleaseManifestSummary.cmake`
  - `doc/usage/migration-guide.rst`
  - Release notes or changelog files
  Acceptance criteria:
  - A tag/manual release workflow or documented release procedure lists the
    required GitHub status checks by exact job/step name.
  - Release jobs upload or retain runtime/tools/source packages, extracted
    artifact scan logs, sanitized manifest summaries, parity reports, docs
    build output, and release notes.
  - Release notes or changelog entries identify compatibility-breaking parser,
    hardware, package, ABI, and license-format behavior for the release.
  - The release checklist records the CI run, commit SHA, package profile,
    project identity, platform, build configuration, ABI tag, and public-key
    ID used for each published artifact.

- [ ] `P2` Add release gates.
  Acceptance criteria:
  - Full test suite passes with `ctest -C Debug --output-on-failure`.
  - Security gate passes with `ctest -C Debug -L security --output-on-failure`.
  - Facet label audit passes and named parser, signature, base64, public-api,
    generator, package, install, platform, hardware, validation, verifier, and
    v201 gates run with `--no-tests=error`.
  - Release build passes.
  - Linux ASan/UBSan and Windows Debug/Release jobs pass.
  - Fuzz smoke passes for parser, base64, and hardware identifier targets.
  - Docs build with warnings as errors.
  - Install/package smoke tests pass.
  - Multi-project package identity smoke passes.
  - Artifact scans pass for customer runtime packages.
  - Artifact manifest checks pass and identify project, package profile,
    platform, build type, ABI where relevant, and public-key fingerprint.
  - Linux/Windows negative-vector parity report passes.
  - `git diff --check` has no whitespace errors.
  - Submodule status is reviewed explicitly before release.
  - Release notes and migration docs are present.
  - New docs describe any compatibility-breaking validation behavior.

## Done Criteria for the Security Upgrade

- [ ] All `P0` items have required validation evidence; the public C-string
  boundary item is implemented locally but still awaits ASan/UBSan evidence.
- [ ] Default new licenses are generated with an unambiguous canonical payload
  after the v201 cutover; explicit `--license-version=201` already uses the
  canonical payload path.
- [ ] New licenses use a modern signing algorithm and key size.
- [x] Legacy v200 behavior is fully documented and constrained.
- [x] `lccgen` refuses malformed or weak client signatures by default.
- [x] `lccgen` refuses unknown output fields that the runtime reader rejects.
- [x] Host C++ integration docs show fail-closed usage.
- [x] Unimplemented authorization APIs cannot return unconditional success.
- [ ] Hardware identifier collection and policy are deterministic and
  fail-closed.
- [ ] Windows and Linux verification paths pass the same negative test suite.
- [ ] Parser and decoder fuzz targets run clean under sanitizers.
