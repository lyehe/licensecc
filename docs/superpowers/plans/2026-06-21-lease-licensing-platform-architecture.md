# Lease licensing platform — locked architecture (v2, post-hardening)

Date: 2026-06-21 (rev 2026-06-22 after adversarial hardening pass)
Status: LOCK-WITH-FIXES — architecture sound; the corrections below are folded in
and are prerequisites of the phase-1 build.
Branch note: NEW platform, not hardening — build on a fresh feature branch off
`develop`, not `improve/codebase-smells-fixes`.

## Problem

Sell subscription access to software that is **hardware-locked** and
**offline-tolerant**. The three pull against each other: a subscription wants a
kill-switch, offline-tolerance denies a reliable one, hardware-lock adds
activation friction. Reconciliation: a **sliding-window, short-lived,
hardware-bound signed lease** that auto-renews online and runs offline between
renews.

Governing principle: **the network is a liveness signal, never an authorization
signal.** The client decides "may I run?" entirely offline from a signed lease +
device proof + expiry. The server only decides whether to hand out a fresh,
later-dated lease. One enforcement check, one source of truth.

## Locked decisions (incl. hardening corrections)

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Scope | Lock full architecture; build lease keystone first; commerce = phase 2 | Prove the risky core before the boring glue |
| D2 | Where/how a lease is signed | Hybrid split: public Worker edge + isolated signer running lccgen; **hot lease key** on the signer, **cold root key** offline | Key off the public attack surface; one canonicalizer (lccgen), zero JS-parity drift |
| D3 | Clock-rollback floor | Persisted wall-clock high-water floor (host LOAD/STORE callbacks) + re-anchor to server time on renew | Best-effort offline anchor, self-healed by the authoritative server clock |
| **D4** | **Hardware identity** | **Bind the lease to a runtime device key (ECDSA, existing `entitlement_devices` subsystem); hw_id is a hint, not the lock** | Self-asserted hw_id is cloneable → makes hardware-lock theater. Device-key challenge-response is what actually binds. **(off-ramp: defer to self-asserted hw_id for phase 1)** |
| **D5** | **Time granularity** | **Epoch-seconds UTC end-to-end for lease validity; new UTC-seconds verifier path for hot-key leases** | Day-granularity-local-midnight (legacy path) can't represent a 30-day lease and expires per-timezone |
| **D6** | **Ring is a generated artifact** | **CMake-wired, manifest-driven 2-key project ring (mirrors the shipped `LCC_ONLINE_ASSERTION_*` / `LCC_CONFIG_ATTESTATION_*` wiring); NOT a hand-edited header** | The hot/cold split must survive `lccgen project initialize` + rebuild, or the keystone is non-reproducible |
| — | Lease format | v201 (carries `key-id` → ring selection) | Reuse the multi-key ring + golden-test discipline |
| — | DURATION (offline budget) | 30d default, per-entitlement; **decoupled from revocation latency knob** | Offline grace; clamped to subscription end (below) |
| — | `valid-from` | **Mandatory on every lease**, set to `server_time − SKEW_DAYS(2)` | Makes the pre-issuance-rollback bound real; absorbs day-granularity skew |
| — | Required-renew-by | Soft **anomaly signal** (server flags machines that never phone home), NOT a hard offline cap | Preserves offline-tolerance while making snapshot-replay detectable |
| — | KMS/HSM apex | Hard prerequisite for the "signer never holds raw key bytes" goal (needs an lccgen external-sign seam) | `CryptoHelper` exposes only `loadPrivateKey`/`signString` today |

## System overview

```
 CUSTOMER MACHINE                 CLOUDFLARE EDGE                 ISOLATED SIGNER            OFFLINE (operator)
 ┌────────────────┐              ┌──────────────────┐           ┌──────────────────┐       ┌──────────────┐
 │ licensed app   │  /activate   │ lease Worker     │  internal │ signer service   │       │ cold root    │
 │ device key ────┼──proof──────▶│ • authn          │  VETTED   │ • own lccgen     │       │ key project  │
 │  (non-export)  │  /renew      │ • entitlement?   │  payload  │   project (hot   │       │ (perpetual/  │
 │ identify_pc()  │◀─────────────┤ • CLAMP valid-to │──────────▶│   lease key +    │       │ base licenses│
 │ store .lic     │  {lic,       │   to valid_until │  v201 lic │   own public_key)│       │ NEVER online)│
 │ verify .lic    │   server_time│ • rate-limit     │◀──────────┤ • signs valid-   │       └──────┬───────┘
 │ clock floor    │   ,renew_by} │ • ATOMIC rebind  │           │   from..valid-to │              │ public record
 └────────────────┘              │ • device proof   │           └──────────────────┘              │ injected into
        │  offline run           └────────┬─────────┘                                              ▼ consumer ring
        ▼                                 │                                   ┌──────────────────────────────┐
  acquire_license(.lic)             D1: entitlements, entitlement_devices,    │ GENERATED project key ring:  │
  sig(ring,key-id) ∧ device-bound   lease_issuance, events, rate, idempotency │ public_key.h + ADDITIONAL_   │
  ∧ valid-from ∧ valid-to ∧ floor                                            │ PUBLIC_KEY_RECORDS (cold+hot)│
                                                                             └──────────────────────────────┘
```

Trust boundary: the public Worker never holds the signing key; it sends the
signer an already-vetted payload (entitlement + device + clamp + rebind all
checked). The signer's hot lease key is its **own** lccgen project (own
`public_key.h` + `private_key.rsa` + `key-id`); its public record is injected
into the consumer's project ring via `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS`. No
lccgen code change is needed for phase 1; the KMS apex does need one.

## D6 — Ring generation prerequisite (keystone task 0, build FIRST)

The hot/cold split is load-bearing but is **not** producible today: `lccgen
project initialize` emits exactly one key / one `key-id`; no init flag, CMake
cache var, or script populates `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS` /
`LCC_RETIRED_PUBLIC_KEY_IDS`. The verifier's selection logic
(`signature_select_public_key_der`, retired/duplicate/min-bits checks) is real
and unit-tested, but the *generation + custody* half is absent, and the only
documented path (hand-editing the git-ignored generated header) is clobbered by
rebuild and forbidden by CLAUDE.md.

Build, before the activate/renew endpoints:
1. **Ring manifest** — a checked-in `projects/<NAME>/ring.json` listing active
   (cold root + hot lease) and retired `key-id`s with DER. Survives regeneration.
2. **Generation wiring** — extend `lccgen` init + `public_key.inja` to emit
   `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS` (as `SignaturePublicKey(key_id, der,
   bits)`) and `LCC_RETIRED_PUBLIC_KEY_IDS` from the manifest; add the CMake
   cache var + `target_compile_definitions` on `licensecc_static`, mirroring the
   already-shipped `LCC_ONLINE_ASSERTION_*` / `LCC_CONFIG_ATTESTATION_*` rings
   (root `CMakeLists.txt:38-45`, `src/library/CMakeLists.txt:69-118`).
3. **End-to-end golden test** — build a real 2-key embedded ring through the
   production `embedded_public_key_ring()` / `acquire_license()` path (not an
   in-test hand-built policy): cold-key perpetual license AND hot-key lease both
   verify by `key-id`; a dropped/retired hot `key-id` fails closed.

Rotation = regenerate the ring from the manifest (drop the compromised `key-id`)
and ship the binary — a manifest-driven path, not the manual macro edit.

## Lease lifecycle (client state machine)

```
                first run                ┌────────────────────────────────────────────┐
   ┌────────────┐ online + device-key    │ ACTIVE  (offline OK until valid-to)          │
   │ UNLICENSED ├──POST /activate(proof)─▶│ valid .lic on disk; floor:=max(floor,srvT)  │
   └─────┬──────┘ ◀─{lic,server_time,     └───┬───────────────────────┬─────────────────┘
         │          renew_by}                 │ launch/24h/<7d-left:   │ now ≥ valid-to AND no renew
         │ activation denied                  ▼ POST /renew(proof)     ▼
         │ (no active entitlement /     ┌───────────────────┐    ┌──────────────┐
         │  device cap reached)         │ online attempt    │    │   EXPIRED    │ fail-closed
         │                              │ ok → new .lic,    │    │ (renew req'd)│
   ┌─────▼───────┐  first run OFFLINE   │      floor:=max() │    └──────┬───────┘
   │  COLD-ACTIVATED (operator-issued   │ 403 → subscription│           │ renew ok
   │  out-of-band perpetual/long lease, │      inactive/    │◀──────────┘
   │  phase-2 fulfillment delivers)     │      paused→disable│
   └────────────────────────────────────┘ 5xx/401/offline → │ keep current .lic, backoff
                                          └───────────────────┘
   now < floor (rollback) OR now < valid-from → REFUSE (tamper)
```

Single offline enforcement check (no network):

```
   RUN  ⇔  sig_valid(.lic, embedded_ring)          # RSA-3072, key-id selects HOT lease key
        ∧  device_proof_binds(.lic, local_device_key)  # ECDSA, non-exportable; NOT just hw_id
        ∧  now_utc ≥ valid-from_utc                 # mandatory, signature-protected
        ∧  now_utc <  valid-to_utc                  # the expiry (UTC seconds)
        ∧  now_utc ≥ floor                          # floor := max(persisted, valid-from); best-effort
```

## Endpoints (phase 1)

```
POST /v1/activate
  body: { account_token, project, feature, hw_id(hint), device_proof /*ECDSA over server nonce*/ }
  Worker: authn → entitlement active? → ATOMIC rebind-cap insert (DISTINCT device_key_id)
          → valid_to = min(now+lease_seconds, valid_until) → vetted payload → signer
  200:  { lic, server_time, renew_by }
  403:  { reason: no_active_entitlement | device_limit_exceeded | expired_subscription }
  401:  bad/absent credential   503: signer/D1 down (client keeps current lease)

POST /v1/renew   (same vetting; same clamp; same atomic cap if hw_id/device-key is new)
```

`account_token` = the customer credential (phase-2 commerce issues it; phase-1
placeholder bearer for end-to-end testing). Idempotency:
`(scope="lease", request_id)` via `mutation_idempotency` → a retried renew
returns the **byte-identical** lease + exactly one `lease_issuance` row.
Rate-limit via `rate_limit_counters` (namespace `lease`).

## Data model deltas (reuse-first)

Reused: `entitlements` (status + `valid_from`/`valid_until` + `revocation_seq` +
`customer_id`), `entitlement_devices` (ECDSA device keys — now on the lease
path), `entitlement_events` (audit), `rate_limit_counters`,
`mutation_idempotency`, `request_proof_nonces` (replay defense for proofs).

```
ALTER entitlements ADD max_active_devices INTEGER NOT NULL DEFAULT 1;  -- NOT a seat cap; rebind ceiling
ALTER entitlements ADD lease_seconds      INTEGER NOT NULL DEFAULT 2592000; -- offline budget (30d)
ALTER entitlements ADD rebind_window_sec  INTEGER NOT NULL DEFAULT 7776000; -- 90d

CREATE TABLE lease_issuance (             -- append-only; backs rebind counting + audit; SWEPT (retention)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project, feature, license_fingerprint TEXT NOT NULL,
  device_key_id TEXT NOT NULL,            -- the bound device, NOT raw hw_id
  lease_key_id  TEXT NOT NULL,
  issued_at, valid_from, valid_to INTEGER NOT NULL,   -- epoch seconds, UTC
  request_id TEXT,
  FOREIGN KEY (project,feature,license_fingerprint)
    REFERENCES entitlements(project,feature,license_fingerprint) ON DELETE CASCADE
);
```

Rebind cap is **atomic** — a single capacity-checked conditional insert, modeled
on the repo's race-free `consumeRequestProofNonce` (`src/index.ts:708-748`) and
rate-limit upsert (`308-318`), NOT check-then-insert:

```sql
INSERT INTO lease_issuance (...)
SELECT ... WHERE (SELECT COUNT(DISTINCT device_key_id) FROM lease_issuance
                  WHERE <ent> AND issued_at >= :window_start) < :max_active_devices
RETURNING id;            -- 0 rows → 403 device_limit_exceeded
```

## Clock floor — first-class C++ subsystem (NOT a one-line verifier delta)

Does not exist today (`verify_limits` uses raw `time(nullptr)`,
`license_verifier.cpp:213`; the only existing "floors" are the `uint64`
`revocation_seq`/`config_seq` counters — not wall-clock anchors). Spec:

- Signed on-disk floor record `(project, feature, fingerprint, floor_epoch_utc)`.
- Host **LOAD/STORE callbacks** modeled on `LCC_REVOCATION_FLOOR_LOAD/STORE`,
  **fail-closed on read failure**.
- In-effect floor = `max(persisted_floor, lease.valid_from)`; reject downward moves.
- Wired into `acquire_license` with a `now_override` **test seam** (the verifier
  has none today).
- Renew sets `floor = max(floor, server_time)` (up only; `server_time < floor`
  leaves it unchanged).
- Name: "persisted clock high-water floor" (it is a wall-clock high-water mark,
  not an OS monotonic counter).

## Time semantics (D5)

Lease validity is **epoch-seconds UTC** end-to-end (signer, payload, verifier,
D1). The legacy verifier compares day-granularity at **local midnight**
(`string_utils.cpp:77-96`), which can't represent a 30-day lease and expires per
timezone — so hot-key leases get a UTC-seconds comparison path. `now < valid-to`
is strict; boundary tests at `valid-to ± ε` and symmetric `valid-from`; a
cross-language assertion that signer seconds and verifier interpretation agree at
the boundary instant.

## Durable persistence (client renew/persist loop — in scope here)

The library is read-only w.r.t. `.lic`, but this doc owns the new client loop:
- Atomic temp-file + fsync + rename (`MoveFileEx` `WRITE_THROUGH` on Windows) for
  both `.lic` and the floor file.
- A/B last-known-good slot; **no-clobber + monotonic-valid-to** write (only
  overwrite with a signature-verified lease whose `valid-to ≥` current).
- Single-writer / advisory-lock for concurrent renews.
- A torn write / malformed-or-older 200 body never drops a paying user to
  UNLICENSED or downgrades a newer lease.

## Failure modes & edge cases (honest)

| Situation | Behavior |
|---|---|
| Signer / D1 down, or 401 credential failure | 503/401; client keeps current lease, backoff; fail-closed only at `valid-to`. A vendor/credential outage is indistinguishable from subscription-end → backoff + warn, don't hard-fail early. |
| Offline through a renew | Keeps lease until `valid-to`; persistent, actionable warn surface < 7d. |
| Subscription cancelled (natural expiry) | Clamp makes `valid-to ≤ valid_until`; access ends at paid-through, **not** +DURATION. |
| Subscription paused | `paused → disabled`; next renew 403; current lease runs to (clamped) `valid-to`. |
| Clock rollback within window | `now < floor` → REFUSE (best-effort). |
| Clock rollback before issuance | `now < valid-from` → REFUSE (mandatory, signed). |
| Clock roll-FORWARD past expiry | `now ≥ valid-to` trips first → fail-CLOSED. |
| **Snapshot restore / re-image / container recreate** | **NOT stopped offline** — floor resets to 0; a never-renewing attacker re-restoring before `valid-to` has UNBOUNDED offline payoff. Bounded only by the soft `renew_by` anomaly signal + device-proof velocity. Stated, not pretended away. |
| **Clone the same device key/hw_id to N machines** | Device proof requires a **non-exportable** key; cloning is as hard as extracting that key. If the key is exportable (no TPM), cloning passes both the offline check and the DISTINCT-device cap — documented residual; TPM/OS-keystore binding is the hardening apex. |
| First launch OFFLINE | No `/activate` path → no lease. Recovery = operator-issued out-of-band perpetual/long license (cold root); first-activation delivery is phase-2 fulfillment. |
| Long offline past DURATION (good subscriber) | Would hard-brick → mitigated by decoupling offline-budget (`lease_seconds`) from revocation latency, an onboarding-chosen budget, and an optional grace state. |
| Retried renew (network flap) | Idempotency → same lease bytes, one issuance row. |
| Hot lease key compromised | Regenerate ring from manifest dropping the `key-id`; ship binary. Cold root + perpetual licenses safe. |
| A valid lease | = **unbounded offline concurrency for DURATION** on the bound device — `max_active_devices` is a rebind ceiling, not a concurrent-seat limit. |

## Threat-model honesty (what offline does NOT stop)

Offline copy-protection with a host-owned floor cannot stop a determined local
attacker. NOT stopped: snapshot/restore replay, fresh-OS re-image with a copied
lease, container recreation, and (without a non-exportable device key) device
cloning. The short HW-bound lease + clamp + server-side renew-velocity anomaly
detection **bound and surface** abuse; they do not make it impossible. Online
(D2 verify path) remains the only authoritative kill-switch; the lease model
trades instant revocation for offline-tolerance, latency ≤ clamped `valid-to`.

## Test plan (boil the ocean)

- **Cross-language golden vector** through the LIVE verifier
  (`license::os::verify_signature` / `acquire_license`), with a flipped-byte
  negative — NOT the payload-bytes-only canonical test. Needs the `now` seam.
- **2-key ring golden** (D6.3): in-ring verify / dropped-id fails / rotated-in
  verify / not-yet-added fails — four assertions, real signatures, through the
  generated ring.
- **Clamp**: `valid_until=now+5d ⇒ valid_to==now+5d`; `valid_until` past ⇒ 403;
  `valid_until` NULL ⇒ full window.
- **Rebind race**: fire `>max_active_devices` concurrent activations with
  distinct device keys; assert exactly `max_active_devices` succeed.
- **Floor**: tamper + persistence-across-restart + downgrade-rejected; renew
  re-anchor moves floor UP only (`server_time<floor` ⇒ unchanged); modeled on the
  durable config-seq-floor precedent, not the in-memory revocation floor.
- **valid-from / time boundary**: missing begin-date on a hot-key lease REFUSES;
  `valid-to ± ε`; UTC-seconds cross-language boundary agreement.
- **Revocation latency = exactly DURATION**: revoke ⇒ next `/renew` 403, but the
  previously-issued lease verifies offline until (clamped) `valid-to`.
- **Idempotent renew**: byte-identical lease + exactly one issuance/audit row.
- **Durable persistence**: torn-write recovery; older/malformed body never
  downgrades; concurrent-renew single-writer.
- **Device proof**: valid proof binds; replayed nonce rejected
  (`request_proof_nonces`); weak source-strength rejected for leases.

## Phasing

- **Phase 1 (keystone, build now):** D6 ring generation (FIRST) → signer service
  (own lccgen project + hot key) → lease Worker `/activate` `/renew` (clamp +
  atomic rebind + device proof) → data-model deltas → client integration (verify
  + device key + renew loop + persisted clock floor + durable writes) → the full
  test plan.
- **Phase 2 (NOT in scope now):** Stripe checkout + fulfillment webhook
  (subscription → entitlement create/bump/revoke, first-activation delivery) →
  `account_token` issuance → customer portal.

## Open risks (post-hardening)

1. Hybrid adds a second deployable (signer) — phase-1 ops surface.
2. Device-key non-exportability needs TPM/OS-keystore to be real; phase-1 may
   start with an OS-protected key file (cloneable by root), TPM as apex. The
   offline model's security ceiling is the device key's extractability.
3. Snapshot-replay has unbounded offline payoff; only the soft `renew_by`
   anomaly signal + online verify bound it. Acceptable for offline-tolerant by
   construction; flagged for high-value seats.
4. KMS apex needs an lccgen external-sign seam (`CryptoHelper` has none today).
5. D5 adds a UTC-seconds verifier path beside the legacy day-granularity one —
   confirm no regression to classic licenses.

---

## GSTACK REVIEW REPORT

| Run | Engine | Status | Findings |
|---|---|---|---|
| 1 | Adversarial workflow `w5w4pdgp9` — 6 lenses (crypto/key-custody, offline-bypass, state-machine, data-model, test-completeness, repo-feasibility), 58 agents, independent verify pass | COMPLETE | 51 raised → 51 unique → **43 confirmed** (0 critical / 15 high / 19 medium / 9 low); 8 refuted/downgraded by verify |

Coverage: Architecture (signing, key custody, ring generation, state machine),
Code Quality / DRY (reuse of clamp + race-free upsert + floor-callback
precedents), Tests (live-verifier vectors, races, rotation, floor persistence),
Performance/correctness (atomic D1 writes, UTC time semantics).

MUST-FIX (folded into v2 before build): (1) ring is a generated,
regeneration-durable artifact + 2-key golden — D6; (2) clamp `valid-to` to
`valid_until` on activate+renew; (3) atomic rebind cap (kill TOCTOU); (4)
mandatory signed `valid-from` + UTC-seconds time semantics — D5.

SHOULD-FIX (folded): threat-model honesty rows (snapshot/re-image/clone NOT
stopped), device-key binding (D4), floor re-budgeted as a first-class subsystem,
`revocation_seq` is online-only (offline latency = DURATION), durable
persistence, expanded test plan, first-launch-offline + pause/resume + long-
offline + 401 + warn-window UX, `lease_issuance` retention, `max_devices` →
`max_active_devices`.

VERDICT: **LOCK-WITH-FIXES** — architecture is sound; the corrections above are
folded in and gate the phase-1 build. Keystone task order: **D6 ring generation
first**, then signer, then endpoints.

**UNRESOLVED DECISIONS:**
- D4 (device-key binding in phase 1) — decided INCLUDE on principle; off-ramp open: defer to self-asserted hw_id + device-key as fast-follow.
- D5 (UTC-seconds verifier path) — decided ADD on principle; off-ramp open: keep legacy day-granularity and accept per-timezone expiry.
- Soft `renew_by` anomaly signal vs hard `max_offline_seconds` cap — decided SOFT on principle (preserves offline-tolerance); off-ramp open: hard cap for high-value seats.
