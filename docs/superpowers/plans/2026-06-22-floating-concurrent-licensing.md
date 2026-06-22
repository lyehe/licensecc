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
