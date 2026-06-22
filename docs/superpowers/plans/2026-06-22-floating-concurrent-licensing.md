# Floating / concurrent licensing — design

Date: 2026-06-22
Status: building (end-to-end: verify · validate · test · document)
Branch: `feature/lease-platform` (extends the lease platform).

## Problem

Sell a **shared pool of N concurrent seats** per feature: at most N clients use the
software simultaneously, any device may take a seat, seats are returned on exit or
reclaimed on disconnect. This is FlexNet Publisher's classic floating model. It is the
**philosophical opposite** of the offline node-locked lease: the server is the live
source of truth for "who holds a seat right now," so floating is **online-required**.
The offline escape hatch is **borrowing** (check a seat out for a bounded offline
window, removing it from the pool until it expires).

```
 OFFLINE LEASE (node-locked subscription)     FLOATING (this doc)
 per-device, runs offline for a duration      shared pool, online-required, heartbeat
 max_active_devices = rebind ceiling          pool_size = simultaneous-use cap
 issue long lease, renew opportunistically    checkout -> heartbeat -> release
 revocation latency = lease duration          reclaim latency = heartbeat grace
```

## Reuse (≈60-70%)

| Existing | Role here |
|---|---|
| Atomic conditional insert (`LEASE_ISSUANCE_ATOMIC_SQL` pattern) | Checkout-iff-`live_seats < pool_size`, race-free, one statement |
| `lccoa1` online assertion (`signAssertion` + C++ `online_verification`) | **The seat token.** A held seat = a valid, unexpired `lccoa1`; the C++ verifier already validates it — no new verification code |
| `/v1/verify` claim-building (`AssertionClaims`) | Checkout/heartbeat mint the seat token the same way, `expires-at = heartbeat deadline` |
| Worker edge, D1, entitlement model, rate-limit, idempotency, audit, opportunistic sweep | Directly applicable |

## Data model (migration 0011)

```
ALTER entitlements ADD pool_size           INTEGER NOT NULL DEFAULT 0;   -- 0 = floating disabled
ALTER entitlements ADD heartbeat_grace_sec INTEGER NOT NULL DEFAULT 900; -- 15 min reclaim window
ALTER entitlements ADD max_borrow_sec      INTEGER NOT NULL DEFAULT 0;   -- 0 = borrowing disabled
ALTER entitlements ADD allow_overdraft     INTEGER NOT NULL DEFAULT 0;   -- 0 = hard cap

CREATE TABLE seat_checkouts (
  project, feature, license_fingerprint TEXT NOT NULL,   -- entitlement FK
  seat_id            TEXT NOT NULL,        -- opaque per-checkout id
  client_instance_id TEXT NOT NULL,        -- which running instance holds it
  mode               TEXT NOT NULL CHECK (mode IN ('live','borrowed')),
  checked_out_at     INTEGER NOT NULL,
  heartbeat_deadline INTEGER NOT NULL,     -- live: now+grace; borrowed: now+borrow window
  PRIMARY KEY (project, feature, license_fingerprint, seat_id)
);
-- live-seat count + reclamation sweep:
CREATE INDEX idx_seat_checkouts_live ON seat_checkouts(project,feature,license_fingerprint,heartbeat_deadline);
```

A **live seat** is a row with `heartbeat_deadline > now`. Expired rows are squatters
to be reclaimed (lazy sweep on checkout, mirroring `request_proof_nonces`).

## Endpoints

```
POST /v1/checkout   {project,feature,license_fingerprint,client_instance_id,[borrow]}
   entitlement active? -> ATOMIC acquire (live_seats < pool_size) -> sign lccoa1 (exp=deadline)
   200 {assertion, seat_id, server_time, heartbeat_in}   409 pool_exhausted   403 no_active_entitlement

POST /v1/heartbeat  {..., seat_id}
   refresh heartbeat_deadline (only if the seat still exists) -> re-sign lccoa1
   200 {assertion, heartbeat_in}   410 seat_reclaimed (must re-checkout)

POST /v1/release    {..., seat_id}
   delete the seat (explicit check-in). 200 {ok:true} (idempotent)
```

Atomic checkout (race-free; counts only LIVE seats), the rebind-cap pattern with a time
predicate instead of DISTINCT:

```sql
INSERT INTO seat_checkouts (...) SELECT ...
WHERE (SELECT COUNT(*) FROM seat_checkouts
       WHERE <entitlement> AND heartbeat_deadline > :now) < :pool_size
RETURNING seat_id;        -- 0 rows => 409 pool_exhausted
```

Overdraft (optional) raises the comparison ceiling by a configured margin. Borrowing
sets `mode='borrowed'` and `heartbeat_deadline = now + min(max_borrow_sec, requested)`,
holding the seat offline until then (no heartbeat needed; counts against the pool until
it expires).

## Seat lifecycle

```
  checkout ──▶ HELD ──heartbeat(<grace)──▶ HELD ... ──release──▶ freed
                │                                    └─ deadline lapsed ─▶ reclaimed (swept)
                └─ borrow ──▶ HELD-OFFLINE (counts against pool until borrow_expires)
  heartbeat after reclaim ─▶ 410 ─▶ client re-checkout (or stop if pool_exhausted)
```

## Client model (online-required; distinct from the offline lease client)

```
 start ─▶ checkout ─▶ got seat lccoa1 ─▶ RUN
              409 ─▶ RefusePoolExhausted (retry/queue)
   every heartbeat_in while running ─▶ heartbeat ─▶ refresh   (410 ─▶ re-checkout)
   exit ─▶ release
   offline > grace ─▶ seat lost; token expires; must re-checkout or stop
```

`seat_client.hpp` provides the decision logic (HELD / heartbeat-now / lost-seat /
pool-exhausted), separate from `lease_client.hpp` (offline). The seat token itself is
verified by the existing C++ `online_verification` (`lccoa1`).

## Decisions

- **Heartbeat grace = 15 min default** (heartbeat ~⅓ of grace). Shorter = tighter count,
  more traffic; longer = a crashed client squats a seat longer. (FlexNet `TIMEOUT`.)
- **Reclamation = lazy** (sweep expired on checkout), reusing the proven opportunistic
  sweep; no cron.
- **Overdraft = hard-cap by default**, optional margin.
- **Borrowing = opt-in** per entitlement (`max_borrow_sec > 0`); the only offline path.

## Test plan

- SQLite: atomic seat cap counts only LIVE seats; expired not counted/reclaimed;
  sequential checkouts cannot exceed pool (no TOCTOU); release frees; borrow accounting.
- Worker HTTP: checkout returns a verifiable `lccoa1`; 409 at cap; heartbeat refresh +
  410 after reclaim; release frees; borrow reduces pool; auth/availability.
- Client: `seat_client` state machine (run/heartbeat/re-checkout/refuse) cases.
- Reuse: the `lccoa1` seat token rides the existing C++ assertion verification + fixtures.

## Scope

Phase: the floating slice (pool + checkout/heartbeat/release + client logic + tests).
NOT in scope: reservations/options-file policy, named-user pools, metering, the commerce
back-office (shared phase 2 with the lease platform).

## Build status (2026-06-22) — built end to end, tested green

| Piece | Tests |
|---|---|
| Migration 0011 (seat pool cols + `seat_checkouts`); D1 + Postgres port; also fixed the 0010 Postgres-port gap | schema parity green |
| `SEAT_CHECKOUT_ATOMIC_SQL` (race-free, counts live seats) — shared by worker + SQL test | — |
| Worker `/v1/checkout`·`/v1/heartbeat`·`/v1/release`: atomic acquire, seat `lccoa1`, lazy reclaim, borrow, overdraft, fail-closed | `seat-worker` 8/8 (verifiable token) |
| SQLite seat-pool cap | `seat-pool` 6/6 (live cap, no-TOCTOU, expired-not-counted, release, heartbeat, borrow) |
| `seat_client.hpp` state machine (online-required, distinct from the offline lease client) | `test_seat_client` 5/5 |
| CI: SQL suites + parity + lint on Node 22; C++ Debug + lease ring + Node cross-language | label audit green |

Backend: 76/76 unit, 18/18 SQL, lint ok. Reuse delivered as designed: the seat token is the
existing `lccoa1` (verified by the shipped C++ `online_verification` — no new verification
code), and the atomic cap is the rebind-cap pattern counting live rows.

### Deviations / deferred (documented)

1. **Online-required by design** — a held seat is offline-tolerant only within its grace
   window; the bounded **borrow** path is the deliberate offline escape (built).
2. **Overdraft** is an integer margin column (`allow_overdraft` = extra seats; 0 = hard cap),
   not a percentage.
3. **Reservations / options-file policy, named-user pools, metering** — out of scope (FlexNet
   parity items deferred); commerce back-office is shared phase 2.

## Usage reporting / analytics (built 2026-06-22) — what makes floating sellable

FlexNet's reporting *is* a sales tool: peak concurrent usage right-sizes the pool, denial
rate is the upsell signal. Built on top of the floating slice:

- **Migration 0012 `usage_events`** — append-only log (the FlexNet "report log"). Seat state
  is mutated/deleted, so it cannot answer "peak last month"; this can. D1 + Postgres + parity.
- **Capture** (best-effort; never fails a license op): `/v1/checkout` emits `checkout` /
  `denied`(pool_exhausted), `/v1/release` emits `release`, the reclaim sweep emits `reclaim`
  at the seat's **actual** heartbeat deadline (when concurrency dropped), each under its own
  entitlement. Leases are already in `lease_issuance`.
- **Aggregation** (`src/lease/usage_report.mjs`, pure, Worker-safe): `computePeakConcurrent`
  is a sweep line with a release-before-checkout tie rule + a baseline for windowed reports;
  `summarizeUsage` → `{peak_concurrent, checkouts, releases, denials, denial_rate,
  unique_devices}`.
- **Surfaces**: `GET /v1/admin/report` (bearer-gated) + `scripts/report.mjs` CLI.
- **Tests**: 9 pure sweep-line (ties, baseline, still-open, unbalanced, order-independence),
  3 SQLite end-to-end (events → query → aggregate; genuine concurrency vs totals; windowed
  baseline), 3 worker HTTP (summary, validation, auth).

Storage decision: D1 `usage_events` (queryable + testable) now; Cloudflare Analytics Engine
is the scale upgrade when event volume outgrows D1. Daily rollups deferred.

### Adversarial hardening pass (workflow `w0083g5r6`: 24 raised, 19 confirmed)

Verdict SHIP-WITH-FIXES. One HIGH + the highest-value mediums folded in:

- **HIGH — double-end undercount (the billable metric).** A seat that lapses (`reclaim` at its
  deadline) and is then released late on shutdown emitted TWO ends for one seat; the seat-blind
  sweep applied a phantom −1 that undercounted an unrelated concurrent seat → peak (and the
  windowed baseline) biased **downward**, i.e. under-billing. Fixed at the root (`/v1/release`
  only logs a release that actually freed a row — `DELETE … RETURNING`) AND as defense-in-depth
  (the sweep-line is now **seat-aware**: it drops a second end for an already-closed seat; the
  baseline uses `EXCEPT` so a double-ended seat is subtracted once). Regression-tested at the
  pure, SQL, and worker levels.
- **Idle-entitlement never-swept inflation** → a **`scheduled()` Cron Trigger** (every 5 min)
  reclaims lapsed seats even with no further checkouts, keeping peak accurate; the factored
  `sweepLapsedSeats` is shared with the lazy checkout-path sweep.
- **Retention**: `usage_events` (90d) and `lease_issuance` (180d > max rebind window) are now
  swept in `scheduled()` — closing the migration-0010 gap where `lease_issuance` had none.
- **Observability**: dropped analytics writes now emit `usage.record_dropped` (warn) instead of
  silently undercounting; large windows return `truncated: true`.

Deferred lows (documented, not blocking): a partial UNIQUE index on terminal seat events as a
storage-level double-end guard; half-open `[from,to)` report windows; clamp-underflow metadata;
proactive seat reclaim on entitlement revoke. None affect the corrected peak/billing metric.
