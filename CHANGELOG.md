# Changelog

Notable changes to this repository. The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

**No namespaced release has been tagged yet.** Current release streams are:

- **C++ library** (`CMakeLists.txt`): `2.1.0` — versioned independently.
- **Platform packages** (root/workspace Node packages, the four Cloudflare services, OpenAPI
  documents, and the Python, .NET, and Java SDKs): `0.1.0-rc.2` (Python `0.1.0rc2`) — versioned
  independently of the C++ core and not yet published to any registry.

Platform release tags use `platform-v<version>`; future independent C++ release tags use
`cpp-v<version>`. New bare `v*` tags are forbidden. The version contract and compatibility rules
are recorded in [ADR 0005](doc/architecture/decisions/0005-platform-version-and-release-tags.md).

## [Unreleased] — initial release

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
