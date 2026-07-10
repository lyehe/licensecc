# Changelog

Notable changes to this repository. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

**This fork has made no tagged release yet.** The newest reachable tag (`v1.0.0`) is inherited upstream
lineage, hundreds of commits behind `main`. Current versioning scheme until the first platform release:

- **C++ library** (`CMakeLists.txt`): `2.1.0` — continues the upstream `licensecc` 2.x lineage.
- **Platform packages** (root `package.json`, the four Cloudflare services, the Python and .NET SDKs):
  `0.1.0` — pre-release, versioned independently of the C++ core and not yet published to any registry.

## [Unreleased] — everything on `main`

### Added
- Cloudflare licensing platform: licensing backend (online verification with signed `lccoa1`
  assertions, node-locked/floating/trial/subscription entitlements, leases and seats, metering,
  order ingest with HMAC + exactly-once semantics, webhooks with a transactional outbox, emergency
  break-glass routes), operator console Worker + React UI, customer portal Worker + React UI
  (email-OTP auth, entitlement/device/usage views, license download and activation, self-serve
  device release, floating-seat persistence across reloads), and a D1 backup/restore-drill Worker.
- Python and .NET client SDKs: fail-closed verification of `lccoa1`/`lcccfg1` tokens with
  byte-for-byte C++ parity pinned by shared golden vectors, plus thin HTTP clients.
- Fenced PostgreSQL/Supabase adapter for the public verifier path, with D1↔PG schema-parity gates.
- CI: Linux/Windows C++ matrices, C/C++ formatting gate, and a services workflow covering
  per-service lint, unit/API tests, SQL suites, Vite UI workflow tests, and schema parity.
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
