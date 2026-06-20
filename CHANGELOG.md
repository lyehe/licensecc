# Changelog

All notable changes to `licensecc` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The license format version (`lic_ver`) is independent of the library version:
the shippable default remains hardened `v200`; `v201` is gated behind golden
vectors and is not the default.

## [Unreleased]

The 2.x line is a security-by-default hardening of the 2.0 baseline. Highlights:

### Added
- Online license verification: `acquire_license_ex` / `lcc_acquire_license_decision`
  with an `LCC_ONLINE_CHECK` callback, fail-closed online assertion verification,
  server-side revocation, and a durable revocation floor.
- Signed configuration tokens: `lcc_verify_config` verifies a server-signed
  `lcccfg1.` token against the exact config bytes and binds it to a valid local
  license, with a durable per-config-id rollback floor. See
  `doc/usage/config-attestation.rst`.
- Anti-tamper signal evaluation surfaced through the decision entry point.
- Compile-time version macros (`LCC_VERSION_MAJOR/MINOR/PATCH/STRING/NUMBER`) in
  the public header.
- Public setters that bound fixed-size ABI buffers (`lcc_set_caller_*`,
  `lcc_set_license_*`, `lcc_set_config_device_hash`).

### Changed
- New project keys default to RSA-3072; the runtime and the install-tree artifact
  scanner enforce a 3072-bit floor. Weaker keys require an explicit opt-in.
- `v200` parsing is strict and fail-closed: unknown/duplicate/non-canonical
  fields, malformed dates/versions, and non-canonical base64 are rejected as
  `LICENSE_MALFORMED` before signature verification.
- Public C-string reads at the API boundary are length-bounded; non-terminated
  caller fields fail closed without reading past their fixed buffer.
- Public C entry points are now wrapped in a top-level no-throw guard so no C++
  exception can cross the C ABI.
- Hardware identifiers are treated as support-sensitive: `lccinspector` redacts
  them by default; raw output requires an explicit diagnostic flag.
- Environment-sourced licenses can be disabled
  (`lcc_set_environment_license_sources_enabled`); hardened projects disable them
  by default.

### Security
- Documented attacker model, v200 compatibility rules, and a versioned signing
  policy (see `doc/analysis/security-model.rst` and `security-notes.rst`).
- `lccgen` refuses malformed or weak client signatures and unknown output fields
  by default; private signing-key material is protected during project
  initialization and never echoed in logs or errors.

### Unimplemented (fail closed)
- `confirm_license` / `release_license` remain stubs that fail closed and must
  not be used as an entitlement decision. Use `acquire_license` for
  authorization.

## [2.0.0]

Stable baseline on `master`: offline license verification, hardware binding,
license retrieval strategies, and per-feature licensing.

[Unreleased]: https://github.com/open-license-manager/licensecc/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/open-license-manager/licensecc/releases/tag/v2.0.0
