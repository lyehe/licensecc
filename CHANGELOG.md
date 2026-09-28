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
- Protected activation says when a license is full: the result stays
  `LCC_BOUND_CONFLICT` and the new `LccDeviceBoundOutcome.denial_detail` is
  `LCC_BOUND_DETAIL_DEVICE_LIMIT`. The .NET (`Outcome.Detail`), Java
  (`Outcome.detail()`) and Python (`Outcome.detail`) SDKs expose it, and the
  protected example tells the user to disconnect a device in the customer portal.
- Customer portal: `POST /portal/v1/auth/identities/unlink` lets a signed-in
  customer disconnect a linked Google or GitHub identity while another sign-in
  method (password, the other provider, or email codes) remains usable now;
  it revokes the customer's other OAuth sessions and answers `409
  last_sign_in_method` otherwise (remediation).
- Customer portal: the optional `PORTAL_SUPPORT_CONTACT` var and the
  providers envelope's `support` field publish an operator support contact —
  a credential-free `https:` URL or a single `mailto:` address; anything else
  is treated as unset (remediation).
- Admin: `POST /api/admin/customers/{id}/licenses` creates a license record
  for a customer (idempotent, administrator role required); protected-create
  refusals now name the rule in `data.reason` (`protected_creation_conflict`)
  instead of a bare conflict (remediation).
- Admin: `POST /api/admin/webhooks/{id}/test` sends a signed test event to a
  webhook endpoint through the backend's new `WebhookOperator` entrypoint,
  reachable only through the admin Worker's optional `WEBHOOK_OPERATOR`
  service binding; without the binding the route answers 503
  `webhook_operator_not_configured` (remediation).
- Admin: `max_active_devices` (a protected grant's device limit, 1 to
  1,000,000) can be set on `POST /api/admin/entitlements` (without a policy)
  and alone via `PATCH /api/admin/entitlements/{id}`; a protected grant
  refuses a limit below its currently connected devices with `409
  capacity_in_use` (`data.devices_in_use`) on PATCH, or
  `protected_creation_conflict` (`data.reason`) on create (remediation).
- Admin: `GET /api/admin/customers/{id}/bindings` also reports each
  `device_bound_v1` entitlement's device-limit `capacity` and the customer's 5
  most recent denied connection attempts, backed by new `usage_events`
  `'denied'` rows with `reason='device_limit_reached'` (remediation).
- Admin: `GET /api/admin/events` accepts `project`/`feature`/
  `entitlement_id`/`event_type`/`actor`/`since`/`until` filters and keyset
  `cursor` paging, instead of returning every event unfiltered (remediation).
- Admin: Customers → Add user defaults to Invite — a random, never-disclosed
  credential the customer replaces through the portal's password recovery —
  instead of requiring the operator to set and share an initial password
  (remediation).
- Admin: each webhook test send the backend attempted leaves a
  `webhook_events` audit row (`event_type` `test_send`) with the operator, the
  request id and the receiver's status class as the reason; a refused send
  leaves none. Migration `0043_allow_webhook_test_send_event.sql` rebuilds
  `webhook_events` to allow the new type and must be applied before the admin
  Worker is deployed; until then the audit write fails and is logged as
  `webhook.test_send_audit_failed`, and test sends still work.

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
- Customer portal: password sign-in on a disabled account now answers `403
  account_suspended` (instead of the same "invalid credentials" as a wrong
  password), and the OAuth callback reports the same case with
  `?auth_error=account_suspended`; every other login attempt is unaffected
  (remediation).
- Customer portal: `GET /api/portal/me` now includes the signed-in customer's
  `email` (remediation).
- Customer portal: `GET /api/portal/entitlements` rows now include
  `trial_ends_at` and `trial_starts_on_activation` (remediation).
- Customer portal: seven auth `429` responses (OTP request and verify, the
  JSON magic-link redeem, and password login/register/reset/complete) now
  carry a `retry-after` header with the exact remaining wait, instead of
  leaving the client to guess; the signed-in password-change action is
  unchanged (remediation).
- Customer portal: the device-authorizations inspect envelope's entitlement
  rows also report `devices_in_use`, `slot_free_at` and `device_connected`, so
  the consent screen can show remaining capacity before an approval is
  attempted (remediation).
- Admin: webhook create/edit rejects an `event_types` entry outside the known
  entitlement/customer/order set with `400 invalid_event_types`
  (`data.allowed` lists the grouped allow-list), instead of accepting a
  placeholder value that never matches a delivery (remediation).
- The backend Worker must now deploy with `compatibility_flags =
  ["global_fetch_strictly_public"]`, so an outbound webhook `fetch` to a URL on
  the deployment's own zone always goes through Cloudflare's front door instead
  of reaching the zone's origin server directly; the deploy-config materializer
  refuses a backend config that omits the flag. Operators must update the
  base64 backend config secret before the next deploy.
- Webhook endpoint URLs may no longer carry a username or password, an
  IP-literal host (IPv4 or IPv6), a single-label host, a host ending in a
  dot, or a host that is or ends in `localhost`, `.local`, `.internal`, or
  `.home.arpa`; the admin Worker rejects such a URL on create and edit with
  `400 invalid_url`. The backend also re-applies this check immediately
  before every scheduled delivery attempt, so a stored endpoint whose URL no
  longer passes it fails every delivery terminally with `invalid_url` until
  an operator edits the endpoint to a safe URL.

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
- The customer portal and licensing backend now validate the device-authorizations
  inspect payload against one exact, closed entitlement field set
  (`additionalProperties: false` on both sides): deploy and roll back the
  backend and portal together for this path, or consent inspection returns
  `temporarily_unavailable` (503).
- Public C ABI compatibility: `LccDeviceBoundOutcome.denial_detail` takes the
  place of the outcome's former `reserved` member. The change is additive: the
  structure's size and offsets, `LCC_DEVICE_BOUND_VERSION` and every existing
  enum value are unchanged, and `lcc_init_device_bound_outcome` still sets it to
  zero; source that named `reserved` must use `denial_detail`. .NET and Python
  SDK releases before this change treat a non-zero value there as an invalid
  outcome and throw on a device-limit refusal instead of returning a conflict, so
  upgrade the SDK together with the native bridge library. The Java JNI adapter
  now uses protocol 2 (its outcome arrays carry the detail): build the JNI library
  from the same SDK version as the JAR, because a mismatched pair fails at load.
  Java's `DeviceBoundClient.Outcome` record gains a sixth component, `detail`; the
  five-argument constructor remains, but Java 21 record patterns that name five
  components must add it.
- Webhook hardening deploy order:
  1. Before the next backend deploy, add `compatibility_flags =
     ["global_fetch_strictly_public"]` to the backend Wrangler config secret.
     That same secret also feeds the rollback, recovery-drill and capacity
     workflows, so update it before running any of those too, not just the
     next deploy.
  2. Apply migration `0043_allow_webhook_test_send_event.sql` before
     deploying the admin Worker.
  3. After deploying, audit stored webhook endpoints. Any whose URL the
     stricter rule now refuses (credentials, an IP-literal host, a
     single-label or internal host name, or a trailing dot) will fail every
     delivery with `invalid_url` until you edit or disable it.

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
- Admin: a suspended customer is labelled "Suspended" (Overview) and counted
  as "Customers suspended" (Reports), matching the customer-facing status
  instead of "Disabled"; the Events Since/Until filters, which are UTC days,
  now say so ("Since (UTC)"/"Until (UTC)"); while a dismissible failure
  notice awaits acknowledgement, other console actions are now visibly
  disabled instead of silently blocked; saving a webhook edit that changes
  nothing shows "No changes to save." and sends no request (remediation).
- Customer portal: a seat or device release result is now always reported
  somewhere on screen, including on the page left showing after a browser
  Back/Forward navigation moves its own seat or device row off screen,
  instead of silently disappearing or freezing the page (remediation).
