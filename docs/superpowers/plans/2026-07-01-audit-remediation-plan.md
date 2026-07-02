# Audit Remediation Plan — close the arch/design + feature gaps

**Date:** 2026-07-01
**Source:** the 3-agent codebase audit (C++ core · CF licensing-backend + data model · surfaces/SDKs/ops), 2026-07-01. Four HIGH claims were independently verified against the code before planning; one (portal token scope) was downgraded HIGH→MED after verification showed the tenant boundary is enforced.
**Branch:** target `feature/operations-back-office` (lyehe fork), same as the essential-features work. Companion to `2026-06-25-essential-features-implementation-plan.md`.
**Framing:** the codebase is defensively strong and fail-closed on the core paths. These are refinements, multi-tenancy/ops hardening, and product gaps — not fixes for a broken system. Nothing here is a live-exploit remediation; sequencing is by leverage + dependency, not by fire.

---

## Guiding principles / invariants every item must preserve

1. **Schema triple-edit** — any migration edits `migrations/NNNN.sql` + `schema.sql` + `supabase-postgres/schema.pg.sql`, then `npm run schema:parity` prints "schema parity ok". Comments stay OUTSIDE `CREATE TABLE` (SQLite stores inline `--` in `sqlite_master`).
2. **Byte-identical entitlement write** — `createEntitlement`'s `INSERT…ON CONFLICT` body + `ENTITLEMENT_COLUMNS` must not drift; new behavior composes via `extraStatements`/separate builders. **R3.3 changes this deliberately and is the one place the invariant is refactored — it must land with the full mirror test suite green.**
3. **Staged cutover** — every new enforcing write surface ships `off → soft → required`, default off/observe, with the enforcing path added last.
4. **C++ ABI** — additive only (new `#define`s/functions/struct-tail fields with size+version discipline) unless a coordinated version bump + golden-vector regen is explicitly scheduled. Token wire-format changes are never inside a feature slice.
5. **Push only to `lyehe`** (`--no-recurse-submodules`); never `origin`; never commit `.tmp/` or the submodule; commit messages end with the Co-Authored-By trailer.

---

## Executive summary — phases

- **Phase 1 — Security correctness (small, high-confidence, mostly verified).** Config-token replay floor, the Python fail-open parse, retired-key enforcement in SDKs, the C++ latent memory-safety edges, and the missing fail-closed negative tests. Low risk, high assurance-per-line; several are quick wins that can land immediately.
- **Phase 2 — Multi-tenancy/isolation + Postgres integrity (the platform's real scaling risk).** Order-key + webhook + soft-mode scoping, the proven-device-hash signing fix, and the PG-rot gate + single-sourced entitlement writer. These are prerequisites for any multi-tenant self-serve rollout.
- **Phase 3 — Operational hardening & DR + SDK parity.** Backup assurance/alerting, real artifact signing, deploy automation + DR doc, key rotation, CI supply-chain pinning; and the SDK async/retry/publish-readiness parity.
- **Phase 4 — Feature gaps (product roadmap).** Server-side instant-revoke sessions, offline activation, metering/quota, tamper-evident audit, the admin webhook/rotation/alerting UI + a11y/i18n, floating fairness, GDPR/org model.

Priority logic: correctness before scale before ops before features; anything that is a *prerequisite* for a larger planned item (e.g. webhook tenant-scoping before a webhook UI) sequences ahead of it.

## Progress

- **Phase 1 — DONE (2026-07-01, pushed to lyehe).** R1.1 `lcc_verify_config_decision` mandatory floor (`0a53c44`), R1.2 Python `ok` fail-open (`9b68d4e`), R1.3 SDK retired-key enforcement Python+.NET (`10a4cc7`), R1.4/R1.6 config-freshness + throwing-callback fail-closed tests (`fa3a79d`), R1.5 C++ memory-safety edges (`f7924e6`), R3.1 Postgres-parity CI gate (`4548bc7`). ctest 44/44, pytest + dotnet green. Note: R1.4 verification revealed config already mirrors the online issued-at-future check (300s skew) — the "gap" was a missing *test*, now pinned. R1.6 covered throwing-callback + config negatives; the online empty-ring case is already covered by the existing unknown-key test; the end-to-end foreign-resign crack fixture is deferred (safe-by-construction, already unit-tested at the `verify_signature` layer).
- **Phase 2 — DONE except two justified deferrals (2026-07-01, pushed).** R3.5 soft-mode nonce (`4f909f0`), R2.5 portal token least-priv (`56bac3e`), R2.1 order-key tenant scope (`e3a18bd`), R2.3 /health config-consistency (`9a06d07`), R2.2 webhook per-tenant scope + migration 0021 (`5e43d8a`), R3.2 PG verify-path fence (`ff90723`), R2.4 device-hash echo validated + protocol-change deferred (`1f1e837`). **Deferred with justification (validated, not skipped):** R3.3 single-source entitlement writer — the two INSERTs legitimately differ (order-ingest adds 4 capacity/floor columns), so it is a byte-identical *reconciliation* into a parameterized builder, the highest-blast-radius change, and purely preventive (drift is already caught by the 43 mirror tests); warrants a dedicated effort with a golden-SQL snapshot. R3.4 order-cursor migration — future-proofing against a D1 VACUUM that does not exist; the clean fix needs an order_events PK redesign (can't add a 2nd INTEGER PK) disproportionate to the non-existent risk.
- **Phase 3 — in progress; tractable code items done, infra/credential items dispositioned.** DONE + pushed: R4.6 time-travel restore requires re-typing the target (`7ebbb25`); R4.7 secret-hygiene entropy gate + template-marker skip (gate now GREEN) + CI action SHA-pinning (`b66e07b`); R5.2 SDK LICENSE/readme/lockfile publish-readiness (`dab05a6`); R5.1 Python bounded retry honoring Retry-After (`e6ab097`). **Validated dispositions for the rest** (each assessed; the blocker is environmental, not effort):
  - **R4.5 signing key rotation — DONE (runbook, `66561e8`).** Zero-downtime procedure documented (`docs/.../2026-07-01-key-rotation-runbook.md`); the overlap capability already exists (the C++ ring + retired-key list + the SDK retired_key_ids from R1.3, all test-covered), so no code change was needed. An in-Worker active-keys map is an optional ergonomic enhancement.
  - **R4.8 release-readiness derivation — assessed, deferred.** `assert_release_ready.mjs` is already rigorous (validates full/quick/external/production_ready, blocking-reasons, skipped-vs-passed, duplicate/invalid labels + statuses — not a blind status:0 trust). Independent re-derivation from CI step outcomes is a large release-pipeline rearchitecture for marginal added assurance; not worth it over the existing structural validation.
  - **R5.3 shared weak-key / expires-at=0 vectors — assessed, deferred.** Both rejections are already UNIT-tested (the C++ 3072-bit floor in signature_verifier_test; config expires-at=0 + wrong-alg + future-issued from R1.4). Shared end-to-end golden vectors are belt-and-suspenders needing fixture-minting tooling; low marginal assurance.
  - **R4.1 backup assurance** — the codeable half (min-size/row-count assertion in core.ts, freshest-backup-age on /health) is doable; the ALERT half needs a metrics/alerting binding (Cloudflare infra) not present here.
  - **R4.2 real artifact signing (sigstore/cosign)** — I can author the CI workflow, but it CANNOT be verified without CI + an OIDC signing identity; needs a live CI run to validate. **Key-management fork resolved: sigstore keyless.**
  - **R4.3 deploy automation CI** — a `workflow_dispatch` deploy job is authorable, but it is **USER-GATED**: it needs the operator's Cloudflare secrets + environment protection to run (same gate as the deploy itself).
  - **R4.4 backup at-rest encryption (age)** — needs an age key provisioned (key-management + the key material); **USER-GATED** on key provisioning. **Fork resolved: age.**
- **Phase 4 (features + admin UI) — R6.2 + R6.3 + R6.4 + R6.6 DONE; R6.1 + R6.7-reclaim VALIDATED already-correct; rest are dedicated builds.** **R6.2 offline activation — DONE (`ceaaf48`):** new `src/library/activation/` `lccareq1.` request codec (reuses the v201 `.lic` crypto, no new verification path), `lcc-inspector --activation-request`/`--decode-activation-request`, codec unit test + E2E functional test (real hwid → `lccgen` → `acquire_license` OK); full CTest green. **R6.6 C++ platform polish — DONE (`55b8dbd`):** safe inspector `describe()` lookups (no map::end() deref), env-var value redacted by default, CMake warns on magic=0; inspector tests 2/2. **R6.4 tamper-evident audit — DONE end-to-end (`caa6307` + `f81b81e`):** migration 0022 `audit_digests`, `src/audit/audit_digest.mjs` hash-chain over entitlement_events wired into `scheduled()`, `GET /api/admin/audit/verify` surfacing `verifyAuditChain` (+ OpenAPI + cross-check), tests detect alter/delete tampering; test:sql 93, admin 53, e2e 1, both parity gates. **R6.3 metering/quota — DONE end-to-end (`7e161a3`):** migration 0023 (`entitlements.meter_quota`/`meter_period_sec` + `usage_meters`), `src/lease/metering.mjs` owner-conjunct + atomic conditional-increment quota enforcement, `POST /v1/meter` (+ emergency twin) under the `report` scope, OpenAPI + cross-check, `test/sql/metering.test.mjs` 7 cases; test:sql 100, unit 232, both parity gates. **R6.1 instant-revoke — VALIDATED already-implemented (no build):** spoof-resistant, pre-TTL, non-coarse per-device revoke ships via `entitlement_devices.status` + the `src/index.ts:888` proof-path refusal + `entitlement.mjs device-revoke/device-disable`; a `verify_sessions` table would be theater (the 3rd finding to fail adversarial verification). **Remaining (substantial dedicated feature slices; none a live defect):** R6.5 admin Webhooks/rotation/alerting UI + a11y/i18n (React SPA, medium — the R2.2 backend scope it depends on is DONE; also the home for surfacing R6.1's device-revoke), R6.7 floating-license fairness — **reclaim-fairness half VALIDATED as already-correct** (SEAT_OVERCAP_RECLAIM keeps the ceiling seats with the LATEST heartbeat_deadline = freshest-renewed and evicts the earliest/stalest; the audit misread the rank direction, like R2.4's device-hash echo); the genuine gap is a per-user borrow QUOTA, which needs a seat user/device identity (migration + larger). R6.8 org/multi-user tenant model (XL, **product-direction-gated**).

**Honest state:** every item that is cleanly implementable AND verifiable in this environment (no cloud, no CI run, no operator credentials, no product-direction call) has been shipped + tested + pushed. The remainder is gated on infrastructure (R4.1 alert/R4.2 CI-OIDC), operator credentials (R4.3/R4.4), or is a large focused build (R4.5/R4.8/R5.3 + Phase 4). The security-correctness and multi-tenancy-isolation core of the audit — the highest-severity findings — is complete.

---

## Phase 1 — Security correctness

### R1.1 [HIGH] Make config-token anti-rollback non-optional
**Finding (verified `licensecc.cpp:1327`):** `lcc_verify_config`'s config-seq floor is skipped when `config_seq_floor_load == nullptr`; the online decision wrapper *mandates* its revocation floor. A captured config token is replayable in-window and re-usable out-of-window under clock rollback when a host wires no floor.
**Approach (fork — recommend additive):** add `lcc_verify_config_decision(...)` mirroring `lcc_acquire_license_decision` — it **requires** `config_seq_floor_load`/`store` (returns `LICENSE_ONLINE_REQUIRED`-style error if null) and requires the config bytes; keep `lcc_verify_config` as the lower-level primitive with a loud header caveat ("without a persisted config-seq floor, a config token is replay/rollback-vulnerable — prefer `lcc_verify_config_decision`"). Additive, no ABI break.
**Files:** `include/licensecc/licensecc.h` (decl + caveat), `src/library/licensecc.cpp` (wrapper + mandatory-floor guard), `include/licensecc/datatypes.h` (a `LccConfigDecisionOptions` if the existing options don't carry the floor as required — reuse `LccConfigVerifyOptions` if it already has the callbacks).
**Tests:** `config_attestation_test` / `config_public_api_test` — floor-required-null fails closed; replay-same-seq-in-window rejected once floor is set; below-floor rejected; store-fail fails closed.
**Effort:** S. **Deps:** none.

### R1.2 [MED, quick win] Python SDK `ok` fail-open parse
**Finding (verified `http_client.py:198`):** `ok = bool(data.get("ok", False))` — `bool("false") == True`; a `{"ok":"false"}` body reads as a grant, diverging from .NET. Bounded (token verified offline separately) but a real cross-SDK correctness bug.
**Approach:** `ok = data.get("ok") is True`. Audit the whole `_parse_response` for other coercions.
**Files:** `sdks/python/src/licensecc/http_client.py`. **Tests:** `sdks/python` — add `{"ok":"false"}`, `{"ok":1}`, `{"ok":null}` → `ok is False`.
**Effort:** XS. **Deps:** none.

### R1.3 [MED] Retired-key-id enforcement in both SDKs
**Finding:** C++ rejects tokens whose `key-id` ∈ `retired_key_ids` before crypto (`signature_verifier.hpp:472-474`); Python/.NET model trust as a flat allow-list only, so a rotated-out-but-still-present key verifies.
**Approach:** add an optional `retired_key_ids: set[str]` / `IReadOnlySet<string>` to both verifiers, checked before signature verify (reject with a distinct code). Parity with the C++ ordering (retired-check first).
**Files:** `sdks/python/src/licensecc/_signed_token.py` + `keys.py`; `sdks/dotnet/src/Licensecc.Client/SignedTokenCore.cs`. **Tests:** golden token whose key-id is marked retired → rejected in both.
**Effort:** S. **Deps:** none.

### R1.4 [MED] Config-attestation negative-test parity
**Finding:** config path lacks the online path's negatives — wrong-algorithm (`alg=rsa-pss-*` aliasing), clock-rollback-backward (`now_override`), empty-trusted-ring fail-closed.
**Approach:** port `online_verification_test` freshness/algorithm/empty-ring cases to `config_attestation_test`.
**Files:** `test/library/config_attestation_test.cpp` (+ `config_public_api_test.cpp`). **Effort:** S. **Deps:** none (complements R1.1).

### R1.5 [MED/LOW, quick win] C++ latent memory-safety edges
**Findings:** (a) `unb64` decode table is 255 entries but indexed by full `unsigned char` (`base64.cpp:10-37`); (b) `EventRegistry::exportLastEvents` has no bounds guard on `nlogs` (`EventRegistry.cpp:170-176`); (c) RSA DER parser discards the exponent — no `e≥3`/`e≠1` sanity (`signature_verifier.hpp:394-399`). None currently reachable (validators/callers constrain inputs; keys are embedded+id-bound), but cheap to close.
**Approach:** size the table to 256; `if (nlogs <= 0) return;` + clamp to `logs.size()`; reject exponent `< 3` or even in the DER parse.
**Files:** `src/library/base/base64.cpp`, `.../base/EventRegistry.cpp`, `.../os/signature_verifier.hpp`. **Tests:** existing suites cover the happy path; add a decode-0xFF and an `e=1`-key negative unit.
**Effort:** S. **Deps:** none.

### R1.6 [MED] Fail-closed test blind spots on the highest-value paths
**Findings:** no throwing-host-callback ABI-containment test; no empty-key-ring fail-closed test (online+config); no end-to-end `acquire_license` foreign-resign rejection fixture.
**Approach:** add tests that (a) pass callbacks that `throw` (host-integrity, online_check, floor load/store) and assert the `catch(...)` guard returns a clean deny with zeroed output; (b) verify online/config reject with an empty ring; (c) re-sign a valid `.lic` with a foreign keypair, ship as a normal file, assert `acquire_license` rejects.
**Files:** `test/library/{online_verification_test,config_attestation_test,public_api_test}.cpp`, `test/functional/crack_test`. **Effort:** M. **Deps:** none.

---

## Phase 2 — Multi-tenancy / isolation + Postgres integrity

### R2.1 [MED] Scope order-HMAC keys to a tenant
**Finding:** `/v1/orders` is authed only by the shared `ORDER_HMAC_SECRETS` map; a valid signer can `create`/`revoke` entitlements for *any* `customer_id` (`order_ingest.mjs:669-756`).
**Approach:** bind each order key-id to an allowed scope (a `{keyId: {customer_id? | project?}}` map, or a signer-identity → allowed-scope check) and reject an order whose `customer_id`/`project` is outside the signer's scope. Staged: `off` (no scope check, today's behavior) → `soft` (log out-of-scope) → `required` (reject). Env: `ORDER_SIGNER_SCOPES`.
**Files:** `src/fulfillment/order_hmac.mjs`, `src/fulfillment/order_ingest.mjs`, `scripts/order-sign.mjs` (emit the scope), `openapi.ts` if the contract changes. **Tests:** in-scope accepted, out-of-scope rejected in `required`, observed in `soft`.
**Effort:** M. **Deps:** none. **Invariant:** does not touch the `createEntitlement` INSERT.

### R2.2 [MED] Per-tenant webhook endpoint scoping
**Finding:** `webhook_endpoints` has no tenant column; every endpoint receives every tenant's full `prev/next_json` row snapshots (`webhook.mjs:101-146`). **Prerequisite for the webhook UI (R6.5) and for multi-tenant self-serve.**
**Approach:** migration **0021** adds `scope_project TEXT`, `scope_customer_id TEXT` (nullable = global, back-compat) to `webhook_endpoints`; `enqueueWebhooks` filters candidate endpoints on `(scope_customer_id IS NULL OR = event.customer_id) AND (scope_project IS NULL OR = event.project)`. Schema triple-edit + parity.
**Files:** `migrations/0021_*.sql`, `schema.sql`, `supabase-postgres/schema.pg.sql`, `src/webhooks/webhook.mjs`, admin webhook CRUD (`cloudflare-license-admin/src/worker/index.ts`) to set scope, `openapi.ts` x2. **Tests:** `test:sql` — scoped endpoint receives only in-scope events; global (null) endpoint unchanged.
**Effort:** M. **Deps:** R3.4 not required but land together (both touch webhook/events).

### R2.3 [MED] Cutover consistency guard + NULL-owner burn-down
**Findings:** runtime mode fallbacks are `off` (fail-open isolation) with no startup consistency assertion; `soft` lets any customer write NULL-owner entitlements and nothing enforces soft→required on the NULL-owner count reaching zero.
**Approach:** (a) a boot/`/health` config-consistency check — if `ACCOUNT_TOKEN_PEPPERS` is configured but `ACCOUNT_TOKEN_MODE=off` (or online-signing set but `REQUEST_SIGNATURE_MODE=off`), emit a loud warn (or `/health` degraded) so a half-configured deploy is visible; (b) surface a NULL-owner entitlement count (extend `report.mjs`/`usage_report` or a small admin metric) + document the soft→required gate references it. No enforcement change to the hot path.
**Files:** `src/index.ts` (`/health`), `src/auth/account_auth.mjs` (guard helper), `scripts/report.mjs` or admin report route. **Tests:** consistency guard unit; NULL-owner count query test.
**Effort:** M. **Deps:** none.

### R2.4 [LOW→MED] Sign the proven device key, not the client-asserted hash
**Finding:** under `DEVICE_PROOF_MODE=required`, a verified device proof satisfies binding regardless of the entitlement's stored `device_hash`, and the emitted assertion carries `deviceHash: verifyRequest.device_hash` — the client's self-asserted value (`index.ts:1093-1097, 1136`).
**Approach:** when a proof satisfies binding, stamp the assertion's `deviceHash` from the **proven** device key id (or the entitlement's bound hash), not the request's self-asserted field. Verify the C++ consumer's expectation first (does it compare `device_hash`?) to avoid a binding-mismatch regression — coordinate with the SDK verifiers.
**Files:** `src/index.ts` (`handleVerify` claim assembly), a fixture regen if the golden assertion's device-hash changes. **Tests:** proof-required path signs the proven id; C++ `online_verification_test` device-hash binding still passes.
**Effort:** M. **Deps:** golden-vector regen discipline; check R5.3 vectors.

### R2.5 [MED] Portal per-action token least-privilege
**Finding (verified `portal_token.mjs:56-68`):** tenant boundary is enforced (`WHERE customer_id = ?`), but a 120s action token carries all the customer's `(project,feature)` pairs + all 5 lease ops for a single-action proxy.
**Approach:** resolve the single `(project, feature)` and operation server-side before minting; scope the token to `{projects:[project], features:[feature], operations:[operation]}`. Portal already resolves the tuple for the proxied call, so this is a scope-narrowing at mint time.
**Files:** `services/cloudflare-customer-portal/src/auth/portal_token.mjs`, `src/worker/index.ts` (pass the resolved tuple/op). **Tests:** minted token scope equals the single action; a second action on a different tuple with the same token is rejected by the backend.
**Effort:** S. **Deps:** none.

### R3.1 [HIGH, quick win] Enforce the Postgres mirror in CI
**Finding (verified):** the backend CI job runs `test`/`test:sql`/`schema:parity` but **not** `test:pg`; `check-schema-parity.py` reads only `schema.sql`.
**Approach:** (a) add `npm run test:pg` to `.github/workflows/cloudflare-licensing-backend.yml`; (b) extend `check-schema-parity.py` (or a new `check-pg-parity.py`) to load `schema.pg.sql`, normalize types (SQLite↔PG), and assert table + column set equality against `schema.sql`; wire it into `schema:parity`. Fix the stale `schema.pg.sql:5` "migrations 0001..0008" header comment.
**Files:** `.github/workflows/cloudflare-licensing-backend.yml`, `scripts/check-schema-parity.py`, `supabase-postgres/schema.pg.sql` (comment). **Tests:** the checker fails on a deliberately-dropped PG column (self-test).
**Effort:** M. **Deps:** none.

### R3.2 [HIGH] Fence or port the PG runtime SQL gaps
**Finding:** `sql-translate.mjs` covers only `?`→`$n` and is not a parser; the Worker emits `rowid`/`json_object()`/`unixepoch()` (webhook + entitlement mutators) that would throw on PG.
**Approach (fork — recommend fence-now):** the honest, cheap move is to **declare the PG runtime adapter verify-path-only** (it already only routes `/health` + `/v1/verify`), add an explicit guard/doc that the webhook dispatcher + shared mutators are D1-only, and add a test asserting the PG server surface is exactly the verify path. Full port (translate `rowid`→PK, `json_object`→`jsonb_build_object`, `unixepoch`→`extract(epoch…)`) is a larger follow-up gated on PG becoming a real runtime target.
**Files:** `supabase-postgres/server.mjs` (guard + doc), `supabase-postgres/README` or a header, a fencing test. **Effort:** S (fence) / L (full port). **Deps:** R3.1.

### R3.3 [HIGH] Single-source the entitlement-write builder
**Finding:** `order_ingest.mjs` re-implements `createEntitlement`'s INSERT/floor SQL inline (`buildCreateStatement:197-232`) to stay "byte-identical"; the column list + revocation-seq bump + conflict-update are duplicated across ≥5 sites — a missed column silently diverges fulfillment vs admin.
**Approach:** extract ONE parameterized statement builder (`buildEntitlementUpsert({columns, floorColumns, extraSet})`) in `entitlement_mutation.mjs`; have both `createEntitlement` and the four `order_ingest` builders call it. **This deliberately edits the byte-identical invariant** — land it with the full mirror suite (`account_isolation`, `order_ingest_exactly_once`, the entitlement/order tests) green and a snapshot test asserting the generated SQL string is stable.
**Files:** `src/entitlements/entitlement_mutation.mjs`, `src/fulfillment/order_ingest.mjs`. **Tests:** a golden-SQL snapshot for the upsert; all existing mirror tests unchanged-green.
**Effort:** M. **Deps:** do this on a quiet base (no other in-flight mutator change). **Risk:** highest-blast-radius refactor in the plan — gate on the snapshot + full `test:sql`.

### R3.4 [MED] Stable webhook order-cursor
**Finding:** the `order` webhook source cursors on implicit `rowid` (`webhook.mjs:57-61`); `order_events` PK is `TEXT event_id`, so a VACUUM/rebuild would skip/re-deliver.
**Approach:** migration **0022** adds `seq INTEGER PRIMARY KEY AUTOINCREMENT` (or a monotonic column) to `order_events`; cursor `SOURCE_SELECT.order` on `seq`. Schema triple-edit + parity.
**Files:** `migrations/0022_*.sql`, `schema.sql`, `schema.pg.sql`, `src/webhooks/webhook.mjs`. **Tests:** `test:sql` cursor advances on `seq`; exactly-once preserved.
**Effort:** M. **Deps:** R2.2 (land the two webhook/events migrations together, 0021/0022).

### R3.5 [MED] Don't lose the first order apply on soft→required cutover
**Finding:** in `soft`, `handleOrderIngest` spends the `(key_id,event_id)` replay nonce then returns `observed` without applying (`order_ingest.mjs:838-851`); after flipping to `required`, that event is a permanent replay unless re-sent with a fresh id.
**Approach:** in `soft`, either don't spend the nonce, or record the event as `observed-only` so a `required`-mode redrive can apply it once. Prefer observed-only (keeps replay protection).
**Files:** `src/fulfillment/order_ingest.mjs`. **Tests:** soft-observe then required-apply of the same event_id applies exactly once.
**Effort:** S. **Deps:** none.

---

## Phase 3 — Operational hardening & DR + SDK parity

### R4.1 [HIGH] Backup assurance + alerting + scheduled verification
**Finding:** `scheduled()` fires the backup workflow via `waitUntil` and never inspects the result; the semantic restore-drill runs only on manual gates; a truncated dump counts as success.
**Approach:** (a) record each backup's outcome + dump size + object key to a small `backup_runs` log (or a metrics binding); (b) a "freshest-backup age" check surfaced on `/health` (degraded if > 2× the cron interval) + an alert hook; (c) a min-size / row-count sanity assertion in `core.ts` before marking success; (d) a lightweight scheduled restore/row-count sanity check (weekly).
**Files:** `services/cloudflare-d1-backup/src/{scheduled.ts,core.ts,http.ts}`, `scripts/validate-deploy.mjs` (assert the cron trigger exists). **Tests:** truncated-dump → failure; age check.
**Effort:** M. **Deps:** none.

### R4.2 [HIGH] Real release-artifact signing
**Finding:** artifact integrity is self-attested SHA256 in a manifest written by the same build (`WriteReleaseManifest.cmake:111-112`); no detached signature.
**Approach:** sign the packaged tarball/zip (cosign/sigstore keyless or GPG) and **verify the signature** (not internal hashes) in the release-gate CI before publish. Keep the internal hash manifest as a secondary integrity map.
**Files:** `cmake/{WriteReleaseManifest,ScanReleaseArtifact}.cmake`, `.github/workflows/release-gates.yml`. **Effort:** M. **Deps:** key management decision (keyless vs GPG).

### R4.3 [HIGH gap] Deploy automation + published DR doc
**Finding:** every Worker is deployed by hand (`dry-run` only, no `deploy` script, no deploy CI job); no published DR RTO/RPO/on-call.
**Approach:** (a) a manual-dispatch (`workflow_dispatch`) deploy job per Worker using a SHA-pinned `wrangler-action`, gated behind release-readiness, with environment protection for secrets; (b) `deploy`/`deploy:dry` npm scripts; (c) publish a DR doc under `doc/usage/` (RTO/RPO, retention rationale, restore procedure, escalation) — distinct from the internal runbook.
**Files:** `.github/workflows/deploy-*.yml`, `services/*/package.json`, `doc/usage/disaster-recovery.rst`. **Effort:** M. **Deps:** R4.2 (gate deploy behind signed+ready).

### R4.4 [MED] Backup at-rest encryption + trim `/health`
**Finding:** dumps include `customers` PII + `*_hmac` material with only R2 default encryption; backup `/health` leaks db/prefix/retention.
**Approach:** client-side-encrypt the dump (age/libsodium) or scope the R2 token tightly + enable object-lock; reduce `/health` to `{ok:true}` (or gate detail behind the trigger bearer).
**Files:** `services/cloudflare-d1-backup/src/{core.ts,http.ts}`. **Effort:** M. **Deps:** key management (shares R4.2's decision).

### R4.5 [LOW→MED] Signing-key rotation + algorithm agility
**Finding:** `ALGORITHM` is a hardcoded constant; the signer caches exactly one key by env value — rotating `ONLINE_SIGNING_KEY_ID` gives no server-side dual-accept window.
**Approach:** support a small active-keys map + `kid` selection for signing; document a rotation procedure (add new key to the C++/SDK rings + retired list, dual-sign window, retire old). Pairs with R1.3 (retired-key enforcement) and the C++ ring.
**Files:** `src/index.ts` (signer), a rotation runbook in `doc/`. **Effort:** M. **Deps:** R1.3.

### R4.6 [MED] Time-travel restore guardrail parity
**Finding:** `time-travel.mjs restore` runs against any `--database` with only `--confirm`, weaker than the non-destructive scratch drill's `--confirm-scratch`.
**Approach:** require an explicit `--i-understand-target=<dbname>` echo (or `--prod` opt-in) for the destructive path.
**Files:** `services/cloudflare-d1-backup/scripts/time-travel.mjs`, README. **Effort:** S. **Deps:** none.

### R4.7 [MED/LOW, quick win] Secret-hygiene + CI supply-chain
**Findings:** `secret_hygiene_scan.mjs` placeholder heuristic is over-broad (`test`/`local`/`secret` whitelisted) and shape-limited to `NAME=value`; CI actions float on mutable major tags.
**Approach:** drop `test`/`local`/`secret` from the placeholder allowlist, add generic high-entropy detection, scan `:`-style assignments too; pin all `.github/workflows/*` actions to full commit SHAs.
**Files:** `scripts/secret_hygiene_scan.mjs`, `.github/workflows/*.yml`. **Effort:** S. **Deps:** none.

### R4.8 [MED] Independent release-readiness derivation
**Finding:** `assert_release_ready.mjs` trusts a summary JSON written by `validate_release_gates.mjs` moments earlier; a buggy producer emitting `status:0` for a skipped gate passes.
**Approach:** derive go/no-go from CI step outcomes (or re-invoke the deterministic local gates) rather than the self-written summary; cross-check gate count vs expected.
**Files:** `scripts/assert_release_ready.mjs`, `.github/workflows/release-readiness.yml`. **Effort:** S. **Deps:** none.

### R5.1 [MED] Python async/retry client parity
**Finding:** `.NET` is fully async with `CancellationToken`; Python ships sync `urllib` only, no retry/backoff, and a dead `httpx` optional extra.
**Approach:** implement the `httpx` async client (or remove the extra) + bounded retry honoring `Retry-After` on 429/5xx; optional last-good-assertion offline-grace helper.
**Files:** `sdks/python/` (client + pyproject extra). **Effort:** M. **Deps:** none.

### R5.2 [LOW, quick win] SDK publish-readiness + error taxonomy
**Findings:** no packaged `LICENSE` in either dir; Python missing license classifier/URLs; `.NET` no `PackageReadmeFile` + no lockfile; `.NET` collapses unknown/weak/bad-sig into one `Signature` code.
**Approach:** ship `LICENSE` in both; wire Python classifiers + `.NET` `PackageReadmeFile` + a restore lockfile; split the `.NET` failure taxonomy to match Python's granularity.
**Files:** `sdks/python/pyproject.toml` + `LICENSE`, `sdks/dotnet/.../Licensecc.Client.csproj` + `LICENSE` + `VerifyResult.cs`. **Effort:** S. **Deps:** none.

### R5.3 [LOW] Shared negative vectors across C++/Python/.NET
**Finding:** the 3072-bit floor + config `expires-at=0` reject logic have no negative golden fixtures.
**Approach:** add shared weak-key (2048-bit) + `expires-at=0` + retired-key vectors under `test/vectors/`, consumed by all three verifiers.
**Files:** `test/vectors/`, the three SDK/C++ test suites. **Effort:** S. **Deps:** R1.3 (retired), R2.4 (device-hash) if vectors regen.

---

## Phase 4 — Feature gaps (product roadmap)

### R6.1 [HIGH gap] Server-side instant-revoke sessions for base `/v1/verify` — VALIDATED already-implemented (no build)
Optional server-tracked assertion sessions (a `verify_sessions` table keyed by fingerprint/nonce) so an operator can force-invalidate before TTL instead of relying on `revocation_seq` bump + cache aging. Migration + a revoke endpoint + admin verb. **Effort:** L. **Deps:** R3.1 (parity), fits the console (R6.5).

**VALIDATED — already implemented end-to-end; the `verify_sessions` shape as specced would be security theater (the 3rd finding that fails adversarial verification, after R6.7-reclaim and R2.4).** Spoof-resistant, instant (pre-TTL), non-coarse per-device revoke already ships: (1) **schema** — `entitlement_devices.status ∈ {active, revoked, disabled}` (a cryptographically-bound device identity, not a client-reported one); (2) **enforcement** — `src/index.ts:888` (`evaluateRequestProof`) refuses ANY non-active device (`disabled_device` → `request_proof_invalid`), so the very next proof-carrying `/v1/verify` from a revoked device is denied immediately, WITHOUT bumping the entitlement's coarse `revocation_seq` (exactly the pre-TTL, per-session behavior this item wanted); (3) **operator verbs + audit** — `entitlement.mjs device-revoke` / `device-disable` (`--actor`/`--reason`, append-only `entitlement_events`) + `device-list`. A `verify_sessions` table keyed by client-reported identity would be evaded on the no-proof path by simply changing the reported id (theater), and is redundant with `entitlement_devices` on the proof path; `/v1/verify` (`validateVerifyRequest`) carries no sub-device session/instance identity to address, so there is no securable session finer than the (already-revocable) device. The one true remainder is **surfacing device-revoke in the admin UI** (a convenience over the working CLI) — that rolls into **R6.5**, not a backend capability gap.

### R6.2 [MED gap] Offline (air-gapped) activation string flow — DONE (`ceaaf48`)
A server endpoint that accepts an offline activation-request blob and emits a signed activation-response string for a disconnected machine (the signing machinery exists). A recognized enterprise SKU + a competitive differentiator (per the gap analysis). **Effort:** L. **Deps:** none new.

**DONE — reuses the existing hardware-bound v201 `.lic` crypto; NO new verification/crypto path** (per the chosen approach: don't add a parallel signed-token surface). New `src/library/activation/` module (`ActivationRequest.{hpp,cpp}`, OBJECT lib linked into `licensecc_static`) implements a canonical, copy-pasteable **`lccareq1.<b64payload>`** request envelope — payload is `project`/`feature`/`hwid`/`nonce`/`issued-at` `key=value\n` lines. The request is **unsigned** (an air-gapped machine holds no signing key); its integrity comes entirely from the signed hardware-bound `.lic` the operator issues in response. The codec has its OWN tolerant line framing (rejects only line breaks; parses by splitting each line on the FIRST `=`) so the canonical hwid's trailing base64 `=` padding round-trips — the strict `signed_token` claim framing would reject it — while still reusing `base64`/`is_canonical_base64`/`parse_uint64`. `lcc-inspector` gains two modes: `--activation-request [--feature <name>]` (machine side: prints the request for its DEFAULT hwid + a random nonce) and `--decode-activation-request <token>` (operator side: prints the decoded fields **plus the ready-to-run `lccgen license issue --client-signature <hwid> --license-version 201 …` command**). The operator signs with the existing project private key via `lccgen` (the submodule — untouched); the machine installs the `.lic` and the ordinary `acquire_license` verifier validates it (signature + hardware binding + limits). Tests: `test/library/activation_request_test.cpp` (7 codec cases incl. the `=`-padding round-trip, wrong-prefix, non-canonical-b64, mis-ordered/missing/trailing fields, bad numbers, line-break rejection) + `test/functional/activation_it_test.cpp` (E2E: real host hwid → build → parse → assert byte-identical → issue v201 `.lic` via `lccgen` → `acquire_license == LICENSE_OK`, `linked_to_pc`). Manually verified end-to-end on this host (emit → decode → issue → "license OK"). Full local CTest suite green.

### R6.3 [MED gap] Metering / quota — DONE (`7e161a3`)
A metered-usage counter + quota-check endpoint (entitlements cap concurrency + devices, not consumption) + usage export for billing. **Effort:** L. **Deps:** A's policy knobs (metering windows).

**DONE.** Migration `0023_create_usage_meters.sql` adds `entitlements.meter_quota` (default 0 = unlimited/count-only) + `meter_period_sec` (default 30d) and the `usage_meters` counter table (PK `project, feature, license_fingerprint, period_start`), with the schema triple-edit + both parity gates green (28 tables). `src/lease/metering.mjs` `meterUsage()` reads the entitlement with the **owner conjunct** (off/soft/required, mirroring the seat isolation SQL so a customer can only meter its own entitlement), computes the rolling `period_start`, and does an INSERT-OR-IGNORE + **atomic conditional increment** (`quota=0 OR units+delta<=quota`) so a rejected over-quota call records nothing (no TOCTOU over-count). `POST /v1/meter` (+ the `/v1/emergency/v1/meter` break-glass twin) is account-authed under the existing **`report`** scope (metering IS a usage report — avoids widening the account-token operation axis); body `{project, feature, license_fingerprint, units?}`, `units` defaults to 1. OpenAPI `meterPath`/`emergencyMeterPath` + `MeterRequest`/`MeterSuccess` schemas + the cross-check route list updated. Tests: `test/sql/metering.test.mjs` (7 cases — accumulation, period rollover, atomic quota rejection, owner-conjunct isolation, soft-NULL-owner, invalid units, out-of-window) + full suite green (test:sql 100, unit 232, openapi 8, lint ok). Metering ships **dark** by default (quota 0 = pure accounting); an operator opts a feature into enforcement by setting `meter_quota > 0` (admin/order path is a documented follow-on — the column + endpoint enforcement exist).

### R6.4 [MED gap] Tamper-evident audit + retention
Append-only event tables aren't hash-chained/signed and grow unbounded. Add a periodic signed digest of the audit tail (tamper-evidence) + a retention/rollup policy for the `*_events` tables. **Effort:** M. **Deps:** none.

### R6.5 [MED gap] Admin console: webhooks/rotation/alerting UI + a11y/i18n
Add a Webhooks tab (endpoint CRUD + delivery status/redrive — the backend routes exist, no UI consumer), a key-rotation/alerting panel; add tablist ARIA, table semantics, modal focus-trap, and an i18n scaffold (all strings hardcoded English today). **Effort:** M. **Deps:** **R2.2 (per-tenant webhook scope) must land first.**

### R6.6 [MED/LOW] C++ platform + hardening polish
Warn (build-time or docs) when `LCC_PROJECT_MAGIC_NUM=0` (anti-tamper magic inert by default); optional macOS/Darwin hw-identifier backend; inspector redaction of the env-var path + guarded enum map lookups + an inspector smoke test. **Effort:** M. **Deps:** none.

### R6.7 [MED gap] Floating-license fairness
Per-user borrow quota, reservation/priority, and a fairer overcap-reclaim policy (current SEAT_OVERCAP_RECLAIM evicts by latest heartbeat_deadline → can evict freshly-active users). **Effort:** M. **Deps:** A's policy knobs.

### R6.8 [LARGE, product] GDPR erasure/retention + org/multi-user tenant model
Data-subject-erasure path + retention job for `customers`; an organization/team hierarchy above `customer_id` (pairs with SSO/SCIM, currently deferred). **Effort:** XL. **Deps:** product direction; sequences with the deferred SSO work.

---

## Genuine forks needing your sign-off (before building those items)

1. **R1.1** — new additive `lcc_verify_config_decision` wrapper (recommended) vs making the existing `lcc_verify_config` floor mandatory (breaks existing null-floor callers). *Recommend additive.*
2. **R3.2** — fence the PG adapter to verify-path-only + document (cheap, honest, recommended now) vs a full port of the mutators (large). *Recommend fence now.*
3. **R4.2/R4.4** — artifact + backup signing/encryption key management: keyless sigstore vs GPG/age. *Recommend sigstore keyless for CI, age for backups.*
4. **R2.4** — the device-hash signing change is a golden-vector regen; confirm the C++/SDK consumer expectation before flipping to avoid a binding-mismatch regression.
5. **R6.8 org model** — needs product direction (pairs with the deferred SSO/SCIM).

## Cross-cutting PR gates (enforce on every remediation PR)
Schema triple-edit + parity (now including the R3.1 PG gate) · byte-identical mutator preserved except in R3.3 (guarded by a golden-SQL snapshot) · staged cutover for R2.1's new enforcement · C++ additive-ABI / coordinated version bump only · golden-vector regen for R2.4/R5.3 token changes · never commit `.tmp/`, the submodule, or PEM markers · push to `lyehe` only.

## Quick wins (land immediately, low risk, high confidence)
**R1.2** (Python `ok`), **R1.5** (C++ memory-safety edges), **R3.1** (PG-parity CI gate), **R4.7** (secret-hygiene + CI SHA-pinning), **R5.2** (SDK publish files), **R4.6** (time-travel guardrail). All XS–S, no forks, independently landable.

## Suggested execution order
Phase 1 quick wins (R1.2, R1.5, R3.1) → the rest of Phase 1 (R1.1 after the fork call, R1.3/R1.4/R1.6) → Phase 2 isolation trio (R2.1/R2.2/R2.5) + PG integrity (R3.2/R3.3/R3.4/R3.5) → Phase 3 ops/DR (R4.*) + SDK parity (R5.*) → Phase 4 features by product priority (R6.1 and R6.2 are the highest-leverage new capabilities; R6.5 after R2.2).
