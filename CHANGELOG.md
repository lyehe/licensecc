# Changelog

Notable changes to this repository. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

**No namespaced release has been tagged yet.** The reachable bare tag (`v1.0.0`)
predates the current release streams and remains legacy history. Current
release streams are:

- **C++ library** (`CMakeLists.txt`): `2.1.0` — versioned independently.
- **Platform packages** (root/workspace Node packages, the four Cloudflare services, OpenAPI
  documents, and the Python, .NET, and Java SDKs): `0.1.0-rc.2` (Python `0.1.0rc2`) — versioned
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
- Linux protected device licensing: TPM2 (OpenSSL provider) device keys, loopback
  enrollment, private checkpoint storage and Linux SDK bridges for Python, .NET
  and Java (#25).
- Protected enrollment can request a specific feature; consent offers only
  matching entitlements (#25).
- Email-verified password registration and reset links in the customer portal (#27).
- `examples/device_bound`: protected application, feature-session and calculator
  examples, built and tested in CI on Windows and Linux (#27, remediation).
- CI: dedicated ASan/UBSan sanitizer job covering the Linux device-identity
  native code (remediation).
- The protected-device readiness script accepts `--env=<name>` to check
  environment-scoped Wrangler vars (remediation).

### Changed
- Advanced the unpublished platform candidate from `0.1.0-rc.1` to `0.1.0-rc.2`.
  The backend `OrderRequest` OpenAPI schema now matches the runtime's closed
  event contract; generated clients based on `rc.1` must regenerate before
  sending orders. The operation also documents its three required `X-LCC-*`
  HMAC headers and the `signer_scope_forbidden` and `seq_conflict` outcomes.
- Relicensed to AGPL-3.0-or-later; modernized to C++17, VS2022, CMake presets.
- Worker routing is table-driven from canonical route inventories (admin, backend, portal); the
  OpenAPI crosschecks compare compiled artifacts instead of grepping source text.
- Cross-worker primitives (constant-time compare, body caps, request ids), the policy-type
  enum/capacity invariant, and the idempotency store are shared through the backend package instead
  of per-worker copies; admin mutation handlers use uniform pathname-derived idempotency scopes;
  guarded status transitions share one helper, and webhook disable requires an audited reason.
- Customer portal and operator console flows simplified; portal proxies the
  backend through the `BACKEND` service binding (#27).
- `LCC_ENABLE_LINUX_DESKTOP` defaults ON only when the TPM2 or test provider is
  enabled (forcing it ON without one is a configure error); separately, the
  Linux desktop build now reports a clear configure-time error when libcurl is
  older than 7.85 (remediation).
- Protected-device global rate fuse counts only per-source-admitted requests;
  optional `BOUND_SESSION_RATE_LIMITER` and `BOUND_GLOBAL_RATE_LIMIT`; the
  per-customer verified budget now scales with the entitlement's device limit,
  and replaying an already-committed lease never consumes rate budget
  (remediation).
- IPv6 sources of protected-device traffic are rate-limited per /64 prefix
  (IPv4-mapped addresses count as their IPv4 address), at the edge and in D1
  (remediation).
- Portal API: `POST /portal/v1/auth/password/complete` may now return 200
  `password_updated` with `data.sign_in_required: true` (and no session cookie)
  when the password was saved but the follow-on sign-in could not be
  completed; clients must send the user to sign in. `registration_unavailable`
  is no longer part of the password OpenAPI contract (remediation).
- .NET SDK: the Linux protected-device native loader binds eagerly
  (`RTLD_NOW`), so a native library with missing symbols fails at load instead
  of at first call (remediation).
- Portal OTP and password-link email delivery failures, including provider
  timeouts, are reported as `portal.email_delivery_failed` with `error_type`
  `send_failed` (remediation).
- Admin action labels describe what they do, and the portal's browser-sessions
  panel reflects real session state instead of staying artificially open
  (remediation).
- Portal OpenAPI: `GET /portal/v1/auth/password` no longer documents
  400/409/413/429 responses (follow-up).

### Upgrade notes
- Existing Linux build trees that cached `LCC_ENABLE_LINUX_DESKTOP=ON` without
  a device-key provider now stop with a configure error: enable
  `LCC_ENABLE_TPM2_OPENSSL` (or, for tests,
  `LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER`) or set
  `LCC_ENABLE_LINUX_DESKTOP=OFF`.
- Checkpoint directories previously created with mode 0500 under a restrictive
  umask are not repaired automatically; fix their permissions (0700) manually.
- Protected-device readiness now fails (`checks.global_rate_limit: false`) when
  `BOUND_GLOBAL_RATE_LIMIT` is set but invalid (non-integer, outside
  100..1000000, or an empty string); leaving it unset is fine.

### Fixed
- C++ core: unstable disk-derived hardware ids on device-path fstab entries; `confirm_license`
  declared/defined signature mismatch (unresolvable symbol); undefined behavior decoding
  `LICENSE_ENCODED` content; env-var licensing diagnostics naming the wrong variable; `unbase64`
  short-input over-read and stdout pollution inside host applications; hardened Windows parsers,
  DER bounds checks, and license-verification paths.
- Documentation: license misstatements (BSD → AGPL), nonexistent CMake modules and CLI names,
  stale upstream links, SDK install stories, and contributor-gate portability (`pwsh`).
- Protected enrollment and license-validity wording in the portal (#23).
- Admin entitlement filter selection race (#24).
- D1 backup export compatibility and same-second checkpoint recovery (#26); longer
  export polling (up to 20 minutes), terminal provider failures that stop retrying
  immediately, and no orphan dumps left in R2 (remediation).
- Linux loopback callbacks are accepted only from the same local user; browser
  launcher hardening; checkpoint files and directories keep private permissions
  under restrictive umasks, and hard-linked TPM2 key references are rejected
  (remediation).
- Pre-verification password accounts can recover through reset without revealing
  account existence by response timing; password links are sent after responding
  and stay redeemable through provider timeouts; login accepts only addr-spec
  emails, rejecting display-name/list forms; a committed reset now reports
  success even when the follow-on sign-in fails (remediation).
- Java and .NET SDK native-loader error messages are accurate on Linux; .NET
  reports the real `dlopen`/`dlerror` diagnostic instead of a Windows-flavored
  message (remediation).
- Linux loopback callbacks match only ESTABLISHED/CLOSE_WAIT rows of the
  connecting socket; login and registration emails reject C1 control
  characters (U+0080–U+009F); the TPM2 provider removes the library's own
  leftover hard links from an interrupted publish or delete under the storage
  lock; keyboard focus lands on the seat after Start seat (follow-up).
