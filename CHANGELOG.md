# Changelog

Notable changes to this repository. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

**No namespaced release has been tagged yet.** Current release streams are:

- **C++ library** (`CMakeLists.txt`): `2.1.0` — versioned independently.
- **Platform packages** (root/workspace Node packages, the four Cloudflare services, OpenAPI
  documents, and the Python, .NET, and Java SDKs): `0.1.0-rc.3` (Python `0.1.0rc3`) — versioned
  independently of the C++ core and not yet published to any registry.

Platform release tags use `platform-v<version>`; future independent C++ release tags use
`cpp-v<version>`. New bare `v*` tags are forbidden. The version contract and compatibility rules
are recorded in [ADR 0005](doc/architecture/decisions/0005-platform-version-and-release-tags.md).

## [Unreleased] — initial release

### Platform rc.3 compatibility and security

- The Python SDK requires Python 3.9.2 or newer and cryptography 50.0.2 or newer.
  Python 3.9.0 and 3.9.1 cannot resolve the patched dependency. SDK tests use
  pytest 9.0.3 or newer and require Python 3.10 or newer; Python 3.9 runtime use
  remains supported from 3.9.2 onward.
- Documentation dependencies require urllib3 2.8.0 or newer. The repository
  and release uv toolchain is pinned to 0.12.18 for Dependabot compatibility.
- Hatchling version updates are maintained with the release backend's verified
  hash constraints; the uv Dependabot job excludes this build-only pin, whose
  absent lockfile entry otherwise makes the updater fail.
- Backend and native device-label validation preserve fullwidth separator
  skeletons when refusing labels that imitate the enrollment comparison code.
- Playwright is updated to 1.64.0. Portal consent tests record and cancel their
  external callback navigation while preserving all UI assertions and checking
  the exact handoff URL, instead of holding the document with an HTTP 204 mock.
- The C++ library retains its independent 2.1.0 version; no release is published
  or tagged by this source update.

### Included
- Offline v201 `.lic` licensing: the C++ runtime accepts only v201 license files, and `lccgen`
  issues them with RSA keys of at least 3072 bits.
- `lcccfg1` signed configuration tokens, verified by the C++ runtime and the SDKs.
- Protected device-bound licensing and feature sessions on Windows and Linux with a TPM: TPM-held
  device keys, browser consent, signed `lccdl1` leases of at most 24 hours, and fresh online
  permission after every process restart.
- Licensing backend: signed, exactly-once order ingest (`POST /v1/orders`) and the four `/v2`
  device routes (`/v2/device-authorizations`, `/v2/device-challenges`,
  `/v2/device-authorizations/exchange`, `/v2/device-leases/renew`).
- Admin console: an Access-protected operator Worker and React UI for customers, protected grants,
  policies, catalog plans, connected devices, orders, webhooks, and audit.
- Customer portal: customer sign-in, device consent, and connected-device management.
- Webhooks with a signed, cron-drained transactional outbox, and a hash-chained audit digest.
- D1 backup to R2 and a scratch-database restore drill that accepts only the exact schema
  baseline.
- Python, .NET, and Java SDKs: `lcccfg1` config-token verification and the optional protected
  native adapters.

### Not included
- Floating or concurrent seats.
- Metering and quotas.
- Usage reports.
- Online revocation for `.lic` applications.
- Server-issued 30-day offline leases: protected authority lasts at most 24 hours and never
  survives a process restart.
- Online licensing without a TPM and a desktop browser (headless hosts, CI runners, containers,
  and Windows Server 2022).
- SDK-only online licensing.
- Customer account tokens.
- The `/v1/emergency` break-glass routes.
- The local SQLite online demo.
- A D1 schema upgrade path: the schema is one baseline edited in place, so every D1 database
  (staging, production, and restore scratch databases) must be recreated from the baseline when
  it changes.
- Release qualification of the live TPM, browser, and backend journeys: they remain release
  gates on each supported platform.
- A flood limit that spares legitimate clients: the protected global fuse
  (`BOUND_GLOBAL_RATE_LIMIT`) can deny all online licensing when a few sources flood the
  protected routes, so operators must size it to the expected peak and add a WAF rate rule.
