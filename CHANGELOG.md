# Changelog

Notable changes to this repository. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

**This fork has made no namespaced release yet.** The newest reachable bare tag (`v1.0.0`) is
inherited upstream lineage, hundreds of commits behind `main`, and remains legacy history. Current
release streams are:

- **C++ library** (`CMakeLists.txt`): `2.1.0` — continues the upstream `licensecc` 2.x lineage.
- **Platform packages** (root/workspace Node packages, the four Cloudflare services, OpenAPI
  documents, and the Python, .NET, and Java SDKs): `0.1.0-rc.1` (Python `0.1.0rc1`) — versioned
  independently of the C++ core and not yet published to any registry.

Platform release tags use `platform-v<version>`; future independent C++ release tags use
`cpp-v<version>`. New bare `v*` tags are forbidden. The version contract and compatibility rules
are recorded in [ADR 0005](doc/architecture/decisions/0005-platform-version-and-release-tags.md).

## [Unreleased] — everything on `main`

### Added
- Machine-readable platform version contract, deterministic projection checker, and disjoint
  platform/C++ release tag namespaces.
- Cloudflare licensing platform: licensing backend (online verification with signed `lccoa1`
  assertions, node-locked/floating/trial/subscription entitlements, leases and seats, metering,
  order ingest with HMAC + exactly-once semantics, webhooks with a transactional outbox, emergency
  break-glass routes), operator console Worker + React UI, customer portal Worker + React UI
  (email-OTP auth, entitlement/device/usage views, license download and activation, self-serve
  device release, floating-seat persistence across reloads), and a D1 backup/restore-drill Worker.
- Python, .NET, and dependency-free Java client SDKs: fail-closed verification of `lccoa1`/`lcccfg1` tokens with
  byte-for-byte C++ parity pinned by shared golden vectors, plus thin HTTP clients.
- Native Linux ARM64 CI/purity coverage, Azure-aware environment classification, and signed
  host-defined v201 `custom-limit` policies with fail-closed runtime evaluators.
- Fenced PostgreSQL/Supabase adapter for the public verifier path, with D1↔PG schema-parity gates.
- CI: Linux/Windows C++ matrices, C/C++ formatting gate, and a services workflow covering
  per-service lint, unit/API tests, SQL suites, Vite UI workflow tests, and schema parity.
- Protected platform publication and manual production-deployment workflows with exact tag,
  trusted-publisher, production-config, migration-order, and post-deploy drill contracts.
- Repository-wide secret-scan lint with a unified needle set; `schema.sql` generated from
  migrations (`npm run schema:write`); ordered zero-to-first-online-license operator runbook;
  per-worker OpenAPI documents with artifact-based drift guards.

### Changed
- Relicensed to AGPL-3.0-or-later; modernized to C++17, VS2022, CMake presets.
- Worker routing is table-driven from canonical route inventories (admin, backend, portal); the
  OpenAPI crosschecks compare compiled artifacts instead of grepping source text.
- Cross-worker primitives (constant-time compare, body caps, request ids), the policy-type
  enum/capacity invariant, and the idempotency store are shared through the backend package instead
  of per-worker copies; admin mutation handlers use uniform pathname-derived idempotency scopes;
  guarded status transitions share one helper, and webhook disable requires an audited reason.

### Fixed
- C++ core: unstable disk-derived hardware ids on device-path fstab entries; `confirm_license`
  declared/defined signature mismatch (unresolvable symbol); undefined behavior decoding
  `LICENSE_ENCODED` content; env-var licensing diagnostics naming the wrong variable; `unbase64`
  short-input over-read and stdout pollution inside host applications; hardened Windows parsers,
  DER bounds checks, and license-verification paths.
- Documentation: license misstatements (BSD → AGPL), nonexistent CMake modules and CLI names,
  stale upstream links, SDK install stories, and contributor-gate portability (`pwsh`).
