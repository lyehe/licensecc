# Signed Configuration Tokens — Design Spec

- **Status:** Approved (brainstorming) — pending granular implementation plan
- **Date:** 2026-06-14
- **Author:** Yehe Liu (with Claude Code)
- **Topic slug:** signed-config-token

## 1. Summary

Add a feature that lets a server cryptographically **authorize a specific
application configuration** so that the licensed software will only run with a
config the server has signed. The user authors a configuration (e.g. a JSON
file), submits it to the server, the server (optionally validates and) signs a
compact **manifest** that binds the config's SHA-256 plus identity claims, and
returns a **config token**. The application verifies the token offline using an
embedded public key, recomputes the config hash, and refuses to run a tampered
or unauthorized config.

This reuses licensecc's existing online-assertion crypto substrate almost
entirely; the new surface is a parallel verification module, a public C API, an
offline signer, and (optionally) a server endpoint.

## 2. Motivation

Consumers want the *configuration itself* gated by the server, not just a
yes/no entitlement. A user defines a config through a web or local interface;
the business needs assurance that the running software only honors configs the
server approved (e.g. a config can't enable features or raise limits the
license does not cover). A bare signature also gives tamper-evidence: a config
file edited on disk after issuance is rejected.

## 3. Goals / Non-goals

### Goals
- Server signs an arbitrary, **possibly large/unbounded** user-authored config.
- Client verifies **offline** with an embedded public key (no network needed at
  run time once the token is issued).
- Detect any tampering of the config bytes after issuance.
- Bind the authorization to the license (and optionally the device), with
  freshness (expiry) and rollback protection (monotonic sequence).
- Reuse existing, already-hardened crypto; add **no new crypto dependency** to
  the C++ client.

### Non-goals
- **Confidentiality.** The config is NOT hidden from the user. The user authors
  it; a public key ships in every client, so the payload is readable. Signing
  provides authenticity + integrity, never secrecy. (If a future use case needs
  secrecy, that is a separate encryption layer and out of scope here.)
- A general-purpose secrets-distribution channel.
- Replacing the license file or the online-assertion flow; this composes with
  them.

## 4. Threat model & security properties

Provided:
- **Authenticity:** the config token was issued by the holder of the
  server's config-signing private key.
- **Integrity:** the config bytes match the signed `config-hash`; a single
  flipped byte fails verification.
- **Binding:** the token is bound to `project`, `feature`,
  `license-fingerprint`, and optionally `device-hash`; it cannot be moved to a
  different product/license/device. With `device-hash` empty the token is
  portable across machines that hold the same license; set it to pin to one
  machine.
- **Freshness:** `issued-at` / `expires-at` bound the validity window
  (`expires-at=0` means never expires).
- **Rollback protection:** a `config-seq` floor scoped per `config-id` and
  persisted by the host prevents reinstating an older version of the same
  config. Independent configs use distinct `config-id`s and never block one
  another.
- **Fail-closed:** any parse/signature/binding/expiry/rollback failure → DENY.

Not provided (documented as such): confidentiality; protection against a fully
patched client binary (tamper-resistant, not tamper-proof — consistent with the
rest of licensecc).

## 5. Chosen approach (and alternatives)

**Chosen — extend the existing signed-assertion envelope.** Sign a small
manifest carrying the config's SHA-256 ("signed-manifest-over-hash"); the config
travels as raw bytes alongside the token. This is the established best practice
(apt repo signing, OPA signed bundles, Sigstore/cosign, in-toto), expressed in
the repo's own envelope format. Scales to arbitrary config size (we sign a
fixed-size hash) and keeps the config in its native, user-editable form.

- **Alt B — detached JWS / cosign** (new JOSE C++ dependency): more
  interoperable but adds a parallel crypto stack to a deliberately lean C++11
  library. Recorded as an interop option; not chosen.
- **Alt C — PASETO `v4.public`**: modern and misuse-resistant, but new
  dependency + new key type with thin C++ support. Not chosen.

Note on token format best practice: raw **JWT** is the most common but not the
best choice when you control both ends — its algorithm agility (`alg:none`,
RS256↔HS256 confusion, `kid` injection) is the source of its classic
vulnerabilities. The chosen envelope pins a single algorithm and has no
algorithm agility, which is the property that matters.

## 6. Reuse map (existing primitives)

| Need | Reused symbol | Location |
| --- | --- | --- |
| SHA-256 over arbitrary bytes | `signature_sha256_hex(bytes)` | `src/library/os/signature_verifier.hpp` |
| RSA-PKCS1-SHA256 verify, alg pinning, key-id allowlist, retired keys, min-bits | `os::verify_signature(...)` + `SignatureVerificationPolicy` | `src/library/os/signature_verifier.hpp`, `os/openssl`, `os/windows` |
| Embedded key-ring pattern | `online_assertion_public_key_ring()` / `LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` | `src/library/os/signature_verifier.hpp` |
| Module template (envelope build/verify, claims/expected structs, monotonic floor) | `online_verification/OnlineVerification.{hpp,cpp}` | `src/library/online_verification/` |
| Monotonic floor persistence pattern | revocation-floor load/store callbacks | `include/licensecc/datatypes.h`, `licensecc.cpp` |

New crypto code required: **none** — only a new policy factory
`config_attestation_signature_policy()` mirroring
`online_assertion_signature_policy()`.

## 7. Token format

Distinct envelope and `purpose` so a config token can never be confused with an
online assertion (cross-protocol separation):

```
lcccfg1.<base64(canonical_payload)>.<base64(signature)>
```

Both segments use standard base64 (matching the existing `lccoa1` envelope), so
the two formats share one decoder.

Canonical payload — `key=value\n`, fixed key order, signed with
RSA-PKCS1-SHA256:

```
purpose=licensecc-config-attestation
version=1
alg=rsa-pkcs1-sha256
key-id=<sha256:...>
project=<project>
feature=<feature>
license-fingerprint=<64-hex>
device-hash=<64-hex or empty>
config-id=<stable logical config identity; constant across versions>
config-seq=<uint64; monotonic version within this config-id>
config-hash=sha256:<64-hex of the raw config bytes>
issued-at=<unix seconds>
expires-at=<unix seconds; 0 = never expires>
```

**Hashing rule:** the client hashes the **exact raw bytes** it will consume —
no parsing, no normalization. Canonicalization (e.g. stable JSON serialization)
is the issuer's responsibility. This eliminates signed-vs-parsed mismatch bugs.
The application must ship and load the exact bytes that were signed (no
re-serialization, no added BOM or trailing whitespace) or the hash will not
match.

`config-id` is the stable logical identity of a config and does not change
between versions; `config-seq` is its monotonically increasing version. The
rollback floor is keyed by `(project, feature, license-fingerprint, config-id)`,
so independent configs each keep their own lineage.

Signature policy: algorithm fixed to `rsa-pkcs1-sha256`; min 3072-bit key;
key-id must be in the embedded config key ring; retired key-ids rejected;
sentinel `license_version = LCC_CONFIG_ATTESTATION_SIGNATURE_VERSION` (e.g.
`9002`, analogous to the online sentinel `9001`).

## 8. Client design (C++ library)

### 8.1 New module
`src/library/config_attestation/ConfigAttestation.{hpp,cpp}` (compiled as a
CMake OBJECT library, mirroring `online_verification`). Pipeline:

1. Parse the `lcccfg1.<payload>.<sig>` envelope; base64-decode both parts.
2. `os::verify_signature(...)` using `config_attestation_signature_policy()`.
3. Parse the canonical payload into claims (strict field order/syntax).
4. Recompute `signature_sha256_hex(config_bytes)` and compare to `config-hash`.
5. Validate binding: `project`, `feature`, `license-fingerprint`, and
   `device-hash` (when provided) must match the expected values.
6. Validate window: `issued-at <= now (+ small skew)`, `expires-at >= now`.
7. Validate `config-seq >= floor`; on success advance the floor.
8. Fail closed on any error.

### 8.2 Public API (`include/licensecc/datatypes.h` + `licensecc.h`)
Follows existing struct conventions (`size`/`version` ABI prefix, fixed-size
char buffers). Sizes follow existing macros where applicable
(`LCC_API_EXPIRY_DATE_SIZE`); new macro `LCC_API_CONFIG_ID_SIZE` (e.g. 64).

```c
typedef struct LccConfigInput {
  uint32_t size;
  uint32_t version;
  const char* token;            /* "lcccfg1...." */
  const uint8_t* config_bytes;  /* exact bytes the app will consume */
  size_t config_len;
  char device_hash[65];         /* optional; empty = not device-bound */
} LccConfigInput;

typedef struct LccConfigDecisionOptions {
  uint32_t size;
  uint32_t version;
  uint64_t now_override;                       /* 0 = use system clock */
  LCC_CONFIG_SEQ_FLOOR_LOAD  config_seq_load;  /* keyed by project+feature+fingerprint+config_id */
  LCC_CONFIG_SEQ_FLOOR_STORE config_seq_store; /* persist max seq per config_id */
  void* config_seq_user_data;
} LccConfigDecisionOptions;

typedef struct LccConfigDecision {
  uint32_t size;
  uint32_t version;
  LCC_LICENSE_DECISION decision;      /* ALLOW / DENY */
  LCC_EVENT_TYPE event_type;
  char config_id[LCC_API_CONFIG_ID_SIZE + 1];
  uint64_t config_seq;
  char expiry_date[LCC_API_EXPIRY_DATE_SIZE + 1];
  bool bound_to_license;
  bool bound_to_device;
} LccConfigDecision;

LCC_EVENT_TYPE lcc_verify_config(
    const CallerInformations* caller,
    const LicenseLocation* license_location,
    const LccConfigInput* input,
    LccConfigDecision* decision_out,
    const LccConfigDecisionOptions* options);
```

`lcc_verify_config` composes with the license flow: it requires a valid license
(to obtain the `license-fingerprint` it binds against) and reports its outcome
through the same `LCC_EVENT_TYPE` channel.

### 8.3 New event codes
`LICENSE_CONFIG_TOKEN_INVALID`, `LICENSE_CONFIG_HASH_MISMATCH`,
`LICENSE_CONFIG_EXPIRED`, `LICENSE_CONFIG_ROLLBACK` (plus a success path mapping
to `LICENSE_OK`). Exact enum values assigned during implementation, preserving
ABI ordering.

## 9. Server design

### 9.1 Offline signer (MVP)
`services/cloudflare-online-verifier/scripts/config-sign.mjs` (mirrors
`device-key.mjs`): inputs a config file + claims + a PKCS#8 private key,
outputs the `lcccfg1...` token. Deterministic and unit-testable; also generates
the golden fixtures used by the C++ tests. Covers the "issued once / signed
out-of-band, shipped as a file" case.

### 9.2 Worker endpoint (later phase)
`POST /v1/config/attest` in `services/cloudflare-online-verifier/src/index.ts`:
accepts `{project, feature, license_fingerprint, device_hash?, config | config_hash}`,
runs the policy hook, signs on allow, returns `{token}` or a denial.

### 9.3 Policy hook (the integrity-vs-authorization fork)
The fork lives entirely server-side, with **no client or format difference**:
- *Integrity-only:* permissive hook — sign any well-formed config.
- *Authorization (default):* the hook validates the config against the
  license/entitlement before signing (e.g. requested features/limits must be
  within what the license covers).

The seam is a single validation function so either policy can be plugged in.
**Default: authorization**, since validating against the license is the reason
to involve a server at all.

## 10. Project key generation

Extend `lccgen project initialize` and `src/templates/licensecc_properties.h.in`
to generate a **separate** config-signing keypair and embed
`LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS` (mirroring the online-assertion key
records), gated by a new enable flag `LCC_API_CONFIG_ATTESTATION`. Separation of
duties: the config-signing key is distinct from the license-issuing key and the
online-assertion key. RSA-PKCS1-SHA256 / ≥3072-bit to match the existing scheme;
Ed25519 is a documented future upgrade for the signature primitive.

## 11. Examples & docs

- `examples/signed_config_host/` — loads a config file + token, calls
  `lcc_verify_config`, runs only on ALLOW; includes a README and mirrors the
  structure of `examples/production_decision_host/`.
- Docs: `doc/api/public_api.rst` (new API), `doc/usage/integration.rst`
  (issue + verify flow), `doc/analysis/security-notes.rst` (properties &
  non-goals, including the signed≠encrypted note).

## 12. Test plan

- `test/library/config_attestation_test.cpp` (Boost.Test):
  - golden token verifies end-to-end;
  - **flip one config byte → DENY** (hash mismatch);
  - wrong / untrusted key → DENY;
  - expired token → DENY;
  - each binding mismatch (project / feature / fingerprint / device) → DENY;
  - `config-seq` below floor (rollback) → DENY;
  - two independent `config-id`s do not block each other (per-lineage floor);
  - large config (~1 MB) verifies.
- Worker tests for `POST /v1/config/attest` (allow + each denial reason).
- Signer CLI test for `config-sign.mjs` (deterministic output; rejects malformed
  input).
- New CTest label `config_attestation` + a CI facet, mirroring the existing
  `online` / `anti_tamper` facets.

## 13. Build sequence (phases)

1. This spec + token format + golden fixtures.
2. Offline signer `config-sign.mjs` + its tests (produces fixtures).
3. Client `ConfigAttestation` module + unit tests (TDD), reusing
   `signature_sha256_hex` + `verify_signature` + new policy factory.
4. Public C API (`lcc_verify_config` + structs + event codes) wired into
   `licensecc.cpp` and CMake; extend the `public_api` test.
5. Project key generation (template + `lccgen` initialize) + the
   `LCC_API_CONFIG_ATTESTATION` flag.
6. `config-seq` floor persistence callbacks (rollback) mirroring the revocation
   floor.
7. Worker `POST /v1/config/attest` + policy hook + worker tests.
8. Example host + docs + CI label.

The offline signer (phases 1–6) is the shippable MVP; the worker endpoint
(phase 7) is optional and only needed for the interactive/online issuance flow.

## 14. Open decisions (defaulted; override anytime)

| Decision | Default chosen |
| --- | --- |
| Integrity-only vs authorization policy | **Entitlement-checked authorization** (eng review 2026-06-14): the D1 entitlements table gains config-limit columns; the hook validates config fields against the license's limits and signs only within-limit. See §16. |
| Config-signing key | **Separate** key ring (separation of duties) |
| Issuance | **Incremental (eng review 2026-06-14): Plan 2 (offline-usable) ships before Plan 3 (online endpoint).** See §16. |
| Signature primitive | **RSA-PKCS1-SHA256** (reuse); Ed25519 noted as future |
| Envelope | New `lcccfg1` prefix + `purpose=licensecc-config-attestation` (distinct from `lccoa1`) |
| Rollback floor scope | Keyed per `config-id`; independent configs do not interfere |
| Device binding | Optional; empty `device-hash` makes the token portable across machines on the same license |
| Token expiry | `expires-at=0` means never expires |
| Encoding | Standard base64 for both envelope segments (shared decoder with `lccoa1`) |

## 15. Security must-haves (format-independent checklist)

- Pin one algorithm; reject `none` / downgrade.
- Sign over the exact raw config bytes; client hashes the same bytes it consumes.
- Bind to license (and optionally device); include `issued-at`/`expires-at`.
- Monotonic `config-seq` floor for rollback protection.
- Separate signing key; `key-id` + key rotation / retirement supported.
- Fail closed on every error path.

## 16. Engineering review outcomes (2026-06-14)

Locked by `/plan-eng-review`. These supersede the §14 defaults where they differ.

### Sequencing (D1): incremental
Plan 2 (offline-usable) ships and is proven before Plan 3 (the coupled online
endpoint). Plan 2 is itself sliced:
- **Plan 2a - callable + interop-proven:** public `lcc_verify_config` C API
  (structs, event codes, wired into `licensecc.cpp`), the Node `config-sign`
  signer, and the byte-identical Node-to-C++ golden fixture. Uses a dev/test
  key (the Plan 1 injection seam). After 2a an integrator can sign a config in
  Node and verify it through the public API.
- **Plan 2b - productionize:** project config-signing key generation (lccgen +
  template + `LCC_API_CONFIG_ATTESTATION` + key ring + the
  `config_attestation_signature_policy()` factory + restore `>=3072`),
  platform-crypto SHA-256, the right-sized DRY extraction, example host, docs.
- **Plan 3:** entitlement-checked endpoint + persistent per-config-id floor.

### Policy hook (D2): entitlement-checked
The hook is NOT permissive. The D1 entitlements table gains config-limit
columns; the hook validates specific config fields against the requesting
license's limits and signs only configs within them. Defining that entitlement
contract (which config fields map to which limits) is the gating task (T1) for
Plan 3, done before the endpoint exists.

### Accepted hardening (fold into Plan 2)
- **#3** `lcc_verify_config` is the combined license+config entry point (it
  performs the one license read and binds the config to that fingerprint); no
  hidden second acquire. Document "use it instead of `acquire_license` when you
  have a config to check."
- **#4** embed a config public-key RING + a dedicated Worker signing secret
  (`CONFIG_SIGNING_PRIVATE_KEY_PKCS8_PEM`) + `key-id` from day one, so rotation
  never needs a flag day.
- **#5** the endpoint lives in the existing Worker but with an isolated signing
  key and a separate D1 table, so a config-path bug cannot corrupt entitlement
  rows.
- **#7** extract only the pure, identical token helpers (`parse_uint64`,
  canonical base64 split, `append_claim_line`) into a shared `base` unit with
  their own tests; keep the two validators (`online_verification`,
  `config_attestation`) separate.
- **#8** map each `ConfigVerifyFailure` to a distinct `LCC_EVENT_TYPE` and into
  the EventRegistry/`LicenseInfo.status`, like the online path.
- **#12** hash the config with platform crypto (OpenSSL EVP / Windows BCrypt),
  not the software SHA-256, because the config path hashes large payloads.

### Non-negotiable spines
1. The entitlement contract (T1), defined before the Plan 3 endpoint exists.
2. The byte-identical Node-to-C++ golden fixture (T2), or the two sides drift
   silently and it surfaces only in production.

### New public event codes (append after `LICENSE_ONLINE_CACHE_EXPIRED = 14`,
before the `100` block, to preserve ABI ordering)
`LICENSE_CONFIG_TOKEN_INVALID = 15` (envelope / signature / metadata),
`LICENSE_CONFIG_BINDING_MISMATCH = 16`, `LICENSE_CONFIG_HASH_MISMATCH = 17`,
`LICENSE_CONFIG_EXPIRED = 18`, `LICENSE_CONFIG_ROLLBACK = 19`.
