# Signed Config Token — Feature Status Index

> Single entry point for the signed-config-token feature. It ties together the design spec, the plans (1, 2a, and the still-unwritten 2b/3), what is shipped vs pending, the locked decisions, and the open hardening items. Start here before touching `config_attestation`, `lcc_verify_config`, or `config-sign.mjs`.

**What the feature is:** a server-signed configuration token (`lcccfg1.<b64-payload>.<b64-sig>`) that binds an exact configuration blob to a valid local license (project / feature / license-fingerprint, optionally device), with a config-hash check, an issued/expires window, and a monotonic rollback floor. The client honors the config only when the local license is valid **and** the token verifies. It deliberately reuses the online-assertion crypto substrate (same RSA-PKCS1-SHA256, same envelope/canonical-payload shape).

## Documents

| Doc | Role | Path |
|---|---|---|
| Design spec (source of truth) | Goals, architecture, token format, phases 0-3, §16 scope | `docs/superpowers/specs/2026-06-14-signed-config-token-design.md` |
| Plan 1 — core verification | `config_attestation` OBJECT lib + tests | `docs/superpowers/plans/2026-06-14-signed-config-token-core-verification.md` |
| Plan 2a — public API + signer + golden fixture | `lcc_verify_config`, Node `config-sign.mjs`, Node↔C++ golden interop | `docs/superpowers/plans/2026-06-14-signed-config-token-plan-2a-public-api-signer.md` |
| Plan 2b — *not yet written* | Project config-key gen, embedded key ring, factory, key floor, platform SHA-256, shared-helper DRY, example host, docs | (to be created) |
| Plan 3 — *not yet written* | Entitlement-checked Cloudflare endpoint + persistent per-config-id floor | (to be created) |

## Status

### Shipped (committed on `improve/codebase-smells-fixes`)
- **Plan 1 — DONE.** `src/library/config_attestation/` (`ConfigAttestation.{hpp,cpp}` + CMake) with the verify core and tests. Trusted-key test seam (`set_trusted_public_keys_for_tests`) in place.
- **Plan 2a — DONE.** Commits `1cc4c2a`, `8f97342`, `68c093f`, `734c024`, `2bfd848`:
  - Public ABI in `include/licensecc/`: `LccConfigInput` / `LccConfigVerifyOptions` / `LccConfigDecision`, event codes `LICENSE_CONFIG_TOKEN_INVALID..LICENSE_CONFIG_ROLLBACK` (15-19), `lcc_init_config_*` / `lcc_set_config_device_hash`.
  - `lcc_verify_config` in `src/library/licensecc.cpp` — one license read via `acquire_license_internal`, binds to the license fingerprint, calls `config_attestation::verify_config_envelope`, maps `ConfigVerifyFailure` -> `LICENSE_CONFIG_*`.
  - Node `services/cloudflare-licensing-backend/scripts/config-sign.mjs` — offline `lcccfg1.` signer using `rsa-pkcs1-sha256` (`RSASSA-PKCS1-v1_5` + `SHA-256`), `key-id` `sha256:<64-hex>`, `config-hash` `sha256:<hex>`; options `--private-key/--key-id/--fingerprint/--config/--config-id/--config-seq` plus optional `--project/--feature/--device-hash/--issued-at/--expires-at`.
  - Golden fixture under `test/vectors/config_attestation/` proving a Node-signed token verifies byte-identically in C++ (`test_config_public_api` + `test_config_attestation`).

### Pending (not started)
- **Plan 2b** — project config-key generation; `LCC_API_CONFIG_ATTESTATION`; `config_attestation_signature_policy()` factory; `>=3072`-bit key floor; platform-crypto SHA-256 (replace test-injected keys with an embedded production key ring); shared-helper DRY extraction with `online_verification`; an example host; user-facing docs.
- **Plan 3** — entitlement-checked Cloudflare endpoint (e.g. `POST /v1/config/attest`, which **does not exist yet** — config tokens are currently tooling-signed only) and persistent per-config-id rollback-floor load/store callbacks.

## Locked decisions
- **Incremental sequencing is mandatory.** Plan 1 -> 2a -> 2b -> 3, each fully tested before the next. The verify core landed before the public API; the public API landed before the server endpoint. Do not jump ahead to a Cloudflare endpoint (Plan 3) before 2b's key ring and DRY extraction.
- **`lcc_verify_config` is the single combined entry point** and mirrors `acquire_license_with_runtime_checks`: exactly one `acquire_license_internal` read, then config verification — no hidden second acquire. Any refactor of the acquisition hub MUST keep these two parallel (this intersects codebase-smells Task 3.2/3.3).
- **The server is authoritative; the entitlement check gates issuance.** Config honoring is fail-closed: `LICENSE_OK` only when the local license is valid AND signature/binding/config-hash/window/rollback all pass; otherwise deny and clear outputs.
- **Reuse, don't fork, the online-assertion substrate** — same algorithm, envelope shape, and canonical-payload discipline. The shared signed-token core (Plan 2b DRY task) is the intended home for the duplicated plumbing, not a third copy.

## Open hardening items (carry into 2b/3)
- Replace the test-injected trusted key with an **embedded production config key ring** + a `>=3072`-bit floor (currently tests inject keys via the seam; there is no embedded config key ring yet).
- Use **platform-crypto SHA-256** for the config-hash rather than any bundled/ad-hoc path.
- **DRY extraction:** factor the ~120-140 lines duplicated between `OnlineVerification.cpp` and `ConfigAttestation.cpp` into a shared signed-token core (see the repo `needs_clean_tree` plan — this requires a clean tree).
- **Persistent rollback floor:** today `min_config_seq` is caller-supplied only; add persistent per-config-id floor load/store (Plan 3), paralleling the online revocation floor.
- **Server endpoint + naming:** a Plan 3 `config/attest` endpoint belongs on the Cloudflare backend. The backend directory was renamed to its multi-role name `services/cloudflare-licensing-backend/` (2026-06-15; the deployed Worker `name` / D1 `database_name` stay `licensecc-online-verifier`). The same backend already carries the adjacent device/relay-resistance subsystem (`entitlement_devices` PK `project, feature, license_fingerprint, device_key_id`; ECDSA-P256 request-proof, purpose `licensecc-online-request`).
- **Migration hygiene:** `migrations/0008_create_entitlement_devices.sql` and `scripts/device-key.mjs` are currently **untracked**; `schema.sql` already references `entitlement_devices`, so `check-schema-parity.py` will fail against committed migrations alone. Stage these before the branch merges (relay-resistance, adjacent to this feature).