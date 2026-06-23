# Operations / back-office — locked architecture (v2, post eng-review + outside voice)

Date: 2026-06-23
Status: LOCKED-WITH-FIXES. Full scope (all slices) confirmed by the Step 0 gate;
the eng-review + Codex corrections below are folded in and are prerequisites of
the build. Re-sequenced: a **Slice 0 (foundation)** now precedes the keystone.
Branch note: NEW platform layer. Fresh feature branch off `develop`
(`feature/operations-back-office`). Push only to the `lyehe` fork.

Extends: `2026-06-21-lease-licensing-platform-architecture.md` (deferred "phase 2
— commerce back-office") and `2026-06-22-floating-concurrent-licensing.md`.

## Problem

We built the **enforcement** column of a FlexNet-competitive platform: signed
v201 leases, hardware/device binding, floating seats, online assertions, usage
analytics, relay-resistance. We have **no** answer for the **Operations** column —
FlexNet Operations is the back-office that turns a *commercial event* ("a customer
bought 5 seats of Feature X for a year") into a *technical artifact* (an
`entitlements` row the enforcement layer honours), and lets humans run that
machine at scale: provision, amend, renew, revoke, observe, self-serve.

Today every entitlement is born by an **operator** typing a CLI command or
clicking the admin UI. No order, no customer of record, no self-service, no "you
paid → you have access" pipeline. That is the gap this plan closes.

Governing principle (inherited): **the back-office is the source of truth for
*authorization* (who is entitled to what); the enforcement layer is the source of
truth for *liveness* (is this lease/seat valid right now).** The back-office never
signs leases or makes runtime allow/deny calls — it only writes `entitlements`
(and the new commerce/identity tables); the existing Workers do the rest. One
write-path, one audit log, fail-closed everywhere.

## What exists today (grounded inventory)

| Capability | State | Where |
|---|---|---|
| Entitlement CRUD + lifecycle | **DONE** | admin Worker `/api/admin/entitlements*` + `entitlement.mjs` CLI |
| Operator auth + RBAC | **DONE** | Cloudflare Access JWT; reader/admin via `ADMIN_ACCESS_*` |
| Operator console (web) | **DONE (entitlements only)** | React 19 + Vite SPA: Overview / Entitlements / Events |
| Atomic audited writes + idempotency | **DONE** | `env.DB.batch([entitlement, event, idempotency])`; `revocation_seq` monotonic |
| Audit log | **DONE (rich)** | `entitlement_events`: actor/source/prev+next JSON/reason/request_id/ip/idempotency_key |
| Usage analytics endpoint | **DONE (arbitrary-tuple, static bearer)** | `GET /v1/admin/report` — **NOT customer-scoped; not reusable for the portal as-is** |
| Backup / restore / time-travel | **DONE (old core tables only)** | `cloudflare-d1-backup` |
| `customers` / `licenses` tables | **EMPTY SCAFFOLDING** | schema exists; **no code writes them**; `customers.email` is **indexed, not unique** |
| `entitlements.customer_id` / `.license_id` | **Columns exist, denormalized, unenforced** | populated only by hand today |
| Commerce / order → entitlement | **MISSING (zero code)** | — |
| Customer identity / `account_token` | **PLACEHOLDER** | `LEASE_ISSUE_BEARER` static bearer; runtime entitlement lookups are **tuple-only**, no `customer_id` binding |
| Self-service portal | **MISSING** | — |

> **Write-path location correction (Codex):** the entitlement-mutation logic
> (`createEntitlement` / `writeEntitlementWithAudit` / `syncEntitlement`) lives in
> **`cloudflare-license-admin/src/worker/index.ts`**, NOT in the licensing-backend
> Worker where `/v1/orders` will land. "Reuse the existing atomic write-path" is
> therefore not free — it requires extracting a shared module first (Slice 0).
> The admin create-SQL also **omits the seat/device columns**
> (`max_active_devices`, `pool_size`, `lease_seconds`, `rebind_window_sec`,
> `heartbeat_grace_sec`, `max_borrow_sec`, `allow_overdraft`) that exist on
> `entitlements` (`schema.sql:17`) — so `quantity.changed` is not implementable
> through the current path until the write-path is extended.

## Scope

### In scope (full back-office — confirmed)
0. **Foundation** — single entitlements DB; extract a shared entitlement-mutation
   service both Workers import; extend `customers`; define the order↔entitlement
   identity contract. (NEW first step — surfaced by the review; everything depends on it.)
1. **Fulfillment** — signed order-ingest → entitlement create/bump/renew/disable, exactly-once.
2. **Customer identity & `account_token`** — real per-customer credential; hard cutover from the placeholder bearer; `customer_id` bound on every runtime path.
3. **Self-service portal** — Worker + React app; email-OTP (+ operator magic-link bootstrap); account-isolated.
4. **Operator console depth** — customer/license tabs, dashboards, fulfillment monitor.

### NOT in scope (considered, deferred — with rationale)
- **Taxes/invoicing/dunning/proration/multi-currency** — the operator's commerce system owns billing; we consume normalized order events only.
- **CPQ/quoting, reseller/channel hierarchies, operator multi-tenancy** — single vendor org; a separate, larger plan if ever resold to other vendors.
- **Marketing/transactional email infrastructure** — Slice 3 ships a single `sendEmail()` adapter seam + operator magic-link bootstrap; provider choice (Resend/SES/SMTP) and deliverability/DNS are the operator's to configure.
- **A Stripe (or any specific provider) adapter** — the `OrderEvent` seam keeps it a later 1-file drop-in; not built now.
- **Replacing the enforcement layer** — the back-office only writes authorization.

## Locked decisions

| # | Decision | Locked choice | Why |
|---|---|---|---|
| D1 | Commercial front door | **Generic signed order-ingest** (`POST /v1/orders`); no Stripe/money rails in-repo | Operator owns "they paid"; we own authorization only; provider-agnostic, PII-free |
| D2 | Ingest auth | **HMAC-SHA256** shared secret over the **raw body**, with `key_id` (multi-secret rotation), timestamp+skew, constant-time compare | Symmetric trust (operator CRM → operator Worker) = symmetric primitive; asymmetric `lcc*` envelopes stay reserved for untrusted-client verification |
| D3 | Source of truth | **One entitlements D1**, shared by **separate** Workers (public verifier edge vs operator admin — compute/auth isolation kept); forward-only admin→verifier sync **demoted to optional replica** | No split-brain; one audit log; enforcement reads one place |
| D4 | Write-path | **Extract a shared entitlement-mutation service** (module) imported by admin + licensing-backend + portal handlers; **extend it to cover seat/device columns** | The mutation code lives in the admin Worker today; order-ingest can't reuse what isn't there. DRY, one mutation path |
| D5 | Identity model | **One identity table = extend `customers`** (`status`, `external_ref`, **UNIQUE email**); `account_tokens` + `portal_otp` hang off `customers.id`. No `accounts` table | DRY; reuses existing FKs/indexes; unique email kills cross-account magic-link login |
| D6 | Entitlement identity contract | The order payload **supplies `license_fingerprint`**; if absent, back-office **derives a stable one** = `sha256(subscription_id:project:feature)`, persists it, and **returns it** in the ingest response for the customer to activate. Stable across renewals (keyed to subscription, not period) | The `entitlements` PK needs a fingerprint a CRM order doesn't have; make the join key explicit and stable |
| D7 | Order→state mapping | active/renewed → **active** (bump `valid_until`); past_due/paused/payment_failed/canceled-at-period-end → **disabled** (reversible); **only** explicit fraud/chargeback → **revoke** (terminal) | `revoked` is terminal in the schema; mapping a billing lapse to revoke makes reactivation impossible |
| D8 | Exactly-once | **Event-claim + ordering-guard + projection + mutation in ONE D1 transaction.** Dedup key = provider **`event_id`** (replay); ordering key = **`subscription_id` + monotonic `seq`** (`last_seq < incoming_seq`); same-seq/different-`payload_digest` → conflict-reject; **stale events never bump `revocation_seq`** | Crash-safe and replay-safe; the plan's prior "dedup then process" was a drop/double-mutate hazard |
| D9 | `account_token` | **Keyed HMAC** with `pepper_key_id` (not `sha256(token+pepper)`); scoped, revocable, rotation overlap window, forced expiry, throttled `last_used_at`, per-token audit, **emergency customer-wide revoke**. **Bound to `customer_id` on every runtime path** | A token store is a lifecycle, not a hash; rotation/pepper-rotation must be verifiable |
| D10 | Bearer cutover | **Hard cutover.** Any retained `LEASE_ISSUE_BEARER` moves to a **separate, off-by-default, explicitly-non-isolated emergency route/env** — never on the account-scoped paths | A live broad bearer lets any caller act on any entitlement tuple — it voids account isolation |
| D11 | Portal privilege | Portal Worker holds **no broad admin/sync credential**; it calls **narrow, customer-scoped handlers** exposed by the shared service (scope enforced server-side). "My usage" is a **new customer-scoped report** joining through `entitlements.customer_id` | The existing admin/sync context is a full control-plane credential; the portal must be least-privilege |
| D12 | "Download .lic" | The portal **calls the lease Worker `/v1/activate`** on the customer's behalf and streams the signed result; **portal never holds a signing key** | Keeps "back-office never signs" true; trust boundary unchanged |
| D13 | Revocation SLA | Access ends **within one lease-TTL / heartbeat-grace** of the back-office change. Mechanics: deny future leases (entitlement gate), clamp lease TTL + borrow window, heartbeat denies refresh when inactive/over-quota, **active seat reclaim on downgrade**, customer-facing wording | DB revocation alone doesn't kill signed leases / live seats; make the bound explicit |
| D14 | Email delivery | **In-scope thin `sendEmail()` adapter** (one provider, swappable) for Slice 3 + **operator-issued magic-link bootstrap** fallback | A portal whose login can't deliver isn't shippable; keep the seam thin |
| D15 | Backup scope | Extend `cloudflare-d1-backup` restore-drill required-tables + sensitive-handling to **`customers`(extended), `account_tokens`, `portal_otp`, `orders`, `order_events`** | New tables are authorization-critical; restore drills must cover them |

## System overview

```
 OPERATOR'S COMMERCE/CRM        CLOUDFLARE EDGE (back-office)                  ENFORCEMENT (existing)
 ┌──────────────┐  HMAC-signed   ┌──────────────────────────────────┐
 │ your order / │  raw body      │ Order-ingest  POST /v1/orders     │            ┌─────────────────────┐
 │ subscription ├───────────────▶│ • verify HMAC (key_id, skew)      │  shared    │ ONE entitlements D1 │
 │ system       │  (key_id, seq) │ • CLAIM event_id ┐ ATOMIC TXN     │  mutation  │ entitlements        │
 └──────────────┘                │ • seq>last_seq?  ├ (1 D1 batch)   │  service   │ + entitlement_events│
                                 │ • project+upsert ┘                │──────────▶ │ + customers(ext)    │
 OPERATOR        Access JWT      │ • cancel→disabled, fraud→revoke   │            │ + account_tokens    │
 ┌──────────────┐                └──────────────────────────────────┘            │ + orders/order_events│
 │ admin console├───────────────▶          ▲           ▲                          └──────────┬──────────┘
 │ (React SPA)  │  same shared              │ shared    │ account_token                       │ honoured by
 │ + cust/lic   │  mutation service         │ service   │ (customer_id-bound)      ┌──────────▼──────────┐
 │ + dashboards │                           │           │                          │ lease/seat/verify   │
 └──────────────┘                ┌──────────┴───────────┴──────────┐               │ Workers (lookups now│
 CUSTOMER         email-OTP /    │ customer portal Worker + SPA    │  download .lic │ JOIN customer_id)   │
 ┌──────────────┐ magic-link     │ • narrow customer-scoped calls  ├──calls───────▶└──────────┬──────────┘
 │ portal user  ├───────────────▶│ • my entitlements/devices/usage │  /v1/activate            │ signed lic /
 │ (browser)    │◀───────────────┤ • download .lic (via lease Wkr) │  (portal never signs)    ▼ assertion / seat
 └──────────────┘                └─────────────────────────────────┘                    LICENSED APP (C++)
```

## Data model (SQLite ground truth + Postgres parity; `check-schema-parity.py` green)

All migrations in `cloudflare-licensing-backend/migrations/`, mirrored into
`schema.sql` AND `supabase-postgres/schema.pg.sql` **in lockstep** (the parity
checker is SQLite-only — the PG port is hand-edited; this bit us before).

- **`customers` (extend)** — add `status` (`active`/`suspended`), `external_ref`
  (nullable, unique — caller's CRM customer id), and a **UNIQUE index on `email`**
  (today it's non-unique — `schema.sql:65`). One identity table.
- **`account_tokens`** — `id` PK, `customer_id` FK, `token_hmac` (keyed HMAC),
  `pepper_key_id`, `token_prefix` (display), `name`, `scopes` (JSON: projects/
  features/operations), `status`, `expires_at`, `last_used_at` (throttled),
  `created_by`, timestamps. No plaintext, ever.
- **`portal_otp`** — `id`, `customer_id`, `code_hmac`, `expires_at`, `consumed_at`,
  `attempts` (rate-limited, single-use, short TTL).
- **`orders`** — `id` PK, `provider` (caller label), `subscription_id`,
  `provider_object_id`, `customer_id`, `license_fingerprint`, `project`, `feature`,
  `status`, `current_period_end`, `quantity`, `raw_json`, `seq`, timestamps.
- **`order_events`** (exactly-once core) — PK `event_id`; `subscription_id`, `seq`,
  `payload_digest`, `status` (`processed`/`stale`/`conflict`), `result_json`,
  `received_at`, `processed_at`. Plus a per-subscription `last_seq` projection
  (column on `orders`/`subscriptions` or a tiny `subscription_state` table).

```
EXACTLY-ONCE INGEST  (one D1 batch = atomic; crash commits all-or-none)
  POST /v1/orders ──▶ verify HMAC(key_id, raw body, skew)
        │ fail → 401 (no side effect)
        ▼
  ┌───────────────────────────── ATOMIC ─────────────────────────────┐
  │ 1. INSERT order_events(event_id…)                                 │
  │      • exists, same payload_digest  → REPLAY: return result_json  │
  │      • exists, diff payload_digest  → CONFLICT 409 (no mutation)  │
  │ 2. ordering guard: incoming.seq > last_seq[subscription_id] ?     │
  │      • no  → mark STALE, NO entitlement write, NO revocation_seq  │
  │ 3. project OrderEvent → shared mutation service:                  │
  │      active/renew → active+valid_until ; lapse → disabled ;       │
  │      fraud → revoke ; quantity → pool_size/max_active_devices     │
  │ 4. advance last_seq ; write entitlement_events(source=order)      │
  │ 5. mark event processed, store result_json                        │
  └──────────────────────────────────────────────────────────────────┘
```

## Build slices (re-sequenced; each: migration + worker + tests + docs + adversarial pass)

### Slice 0 — Foundation (build FIRST; everything depends on it)
- Single-DB binding: point the admin Worker + licensing-backend Worker at the
  same entitlements D1 (D3); demote the forward-only sync to an optional replica.
- **Extract the shared entitlement-mutation service** (D4) from
  `cloudflare-license-admin/src/worker/index.ts` into a module both Workers import
  (mirrors the `signed_token` extraction). **Extend it to write the seat/device
  columns** the current create-SQL omits (`api.ts:34`, `index.ts:651`).
- Migration: extend `customers` (status, external_ref, UNIQUE email) (D5) + PG parity.
- Define + document the entitlement identity/fingerprint contract (D6).
- Tests: shared-service unit tests (every column, every event type), the
  unique-email migration (reject dupes), parity. Adversarial: write-path
  divergence (admin vs ingest must produce identical rows), column-omission regression.

### Slice 1 — Fulfillment keystone (signed order-ingest → entitlement)
- Migrations: `orders`, `order_events` (+ parity).
- `POST /v1/orders` on the licensing-backend: HMAC verify (D2), the **atomic
  event-claim + ordering-guard + projection + mutation** (D8) via the shared
  service, cancel→disabled mapping (D7), fingerprint contract (D6).
- `OrderEvent` seam (`src/fulfillment/order_event.mjs`) + an HMAC reference signer
  (`scripts/order-sign.mjs`) for tests/operator onboarding.
- Tests: unit (HMAC pass/fail/replay/skew, each intent, conflict, stale-no-mutate,
  cancel→disabled, fingerprint derive+return), SQL (atomic claim+mutation), and an
  **adversarial hardening workflow** (forged/wrong-key sig, replay, out-of-order
  cancel-then-renew, same-seq-different-payload, crash-mid-batch, quantity downgrade).

### Slice 2 — Customer identity & `account_token`
- Migrations: `account_tokens` (+ parity).
- Issue/rotate/revoke (keyed HMAC + `pepper_key_id`, scopes, overlap window,
  emergency customer-wide revoke) (D9). **Bind `customer_id` on every runtime
  lookup** — change the tuple-only selects at `index.ts:1204/1454/1800` to join by
  `customer_id` (D9). **Hard cutover** from `LEASE_ISSUE_BEARER` (D10).
- Tests: token hash/scope/expiry/rotation/emergency-revoke matrix; per-path
  customer-id binding; adversarial (scope escalation, revoked-token replay, timing,
  cross-account entitlement access, bearer-bypass attempt).

### Slice 3 — Self-service customer portal
- New `services/cloudflare-customer-portal/` Worker + small React app.
- Email-OTP session via the `sendEmail()` seam + operator magic-link bootstrap
  (D14); unique-email identity (D5). Screens: my entitlements, my devices/seats
  (activate/rebind/release), **download .lic via the lease Worker** (D12), my
  usage via a **new customer-scoped report** joining `entitlements.customer_id`
  (D11). All writes go through narrow customer-scoped shared-service handlers (D11).
- Tests: session lifecycle, OTP brute-force/replay, account-scope enforcement, e2e
  (Playwright), adversarial (cross-account IDOR on every read + write + report,
  session fixation, magic-link reuse).

### Slice 4 — Operator console depth
- Admin UI: customers/licenses tabs (CRUD over the populated tables), reporting
  dashboard (surface `/v1/admin/report` charts), fulfillment monitor (orders,
  ingest deliveries, replays/conflicts/stale, manual re-drive).
- Tests: extend admin-worker + admin-ui workflow + e2e; adversarial (reader RBAC
  on the new write surfaces).

### Cross-cutting (lands with the slices that touch it)
- **Revocation SLA mechanics** (D13): lease-TTL/borrow clamps, heartbeat deny on
  inactive/over-quota, seat reclaim on downgrade — implemented in Slices 1–3 where
  the relevant path lives; tested as one SLA suite.
- **Backup scope** (D15): extend restore-drill required-tables + sensitive handling.

## Test & verification plan

Per slice: Node unit (`node:test`), real-SQLite SQL tests for every atomic
co-write, a dedicated **adversarial hardening workflow** before "done" (caught a
real bug on every prior slice). CI extends `lease-platform.yml` (Node 22; portal +
admin e2e on push; parity per touched service).

```
COVERAGE TARGETS (planned paths → tests)                              STATUS
[0] shared mutation service
    ├─ every entitlement column written (incl. seat/device)          [PLAN ★★★] unit
    ├─ admin vs ingest produce identical rows                        [PLAN ★★★] adversarial
    └─ unique-email migration rejects dupes                          [PLAN ★★★] SQL
[1] /v1/orders
    ├─ HMAC ok / wrong-key / bad-skew / replay                       [PLAN ★★★] unit
    ├─ event-claim: new / replay(same digest) / conflict(diff)       [PLAN ★★★] SQL
    ├─ ordering: seq>last (apply) / seq≤last (stale, no rev_seq)     [PLAN ★★★] SQL
    ├─ map: active/renew/lapse→disabled/fraud→revoke/quantity        [PLAN ★★★] unit
    ├─ fingerprint supplied vs derived+returned                      [PLAN ★★★] unit
    └─ crash-mid-batch → no partial fulfillment                      [PLAN ★★→E2E] adversarial
[2] account_token
    ├─ hash(keyed)/scope/expiry/rotation-overlap/emergency-revoke    [PLAN ★★★] unit
    ├─ customer_id bound on activate/renew/checkout/hb/release/report[PLAN ★★★ →E2E] integration
    └─ bearer cutover: no cross-tuple access via legacy path         [PLAN ★★★] adversarial
[3] portal
    ├─ OTP single-use/expiry/brute-force; magic-link reuse           [PLAN ★★★] unit
    ├─ cross-account IDOR (read/write/report) — all denied           [PLAN ★★★ →E2E] adversarial
    └─ download .lic streams lease-Worker output, no portal key      [PLAN ★★★ →E2E] integration
[4] console: customer/license CRUD, reader RBAC on new writes        [PLAN ★★] e2e
[X] revocation SLA: lease/borrow clamp, hb-deny, downgrade reclaim   [PLAN ★★★ →E2E] SLA suite
```

### Failure modes (each new path: one realistic prod failure → covered?)
- **Crash between dedup-write and mutation** → fulfillment lost or doubled. *Covered* by the single-transaction design (D8) + crash-mid-batch adversarial test.
- **Reordered cancel-then-renew** → stale cancel disables a just-renewed sub. *Covered* by `seq`/`last_seq` guard + out-of-order adversarial test.
- **Billing lapse → revoke** → customer can never reactivate. *Covered* by cancel→disabled mapping (D7).
- **Portal IDOR** → customer sees another account's entitlements/usage. *Covered* by customer-id-bound handlers + per-path IDOR adversarial suite. **Critical if missed — silent data exposure.**
- **Live bearer during migration** → any caller acts on any tuple. *Covered* by hard cutover (D10) + bearer-bypass adversarial test. **Critical if missed.**
- **Revoke doesn't kill a signed lease** → access persists past entitlement end. *Bounded* by the lease-TTL SLA (D13) + SLA suite; customer-facing wording documents the window.
- **Over-quota seats after downgrade** → customer keeps more seats than they pay for. *Covered* by active reclaim on downgrade (D13/F2) + downgrade test.

## Security constraints
- **Order-ingest:** HMAC over the **raw body** (never parsed JSON), `key_id` for
  multi-secret rotation, timestamp+skew, constant-time compare, dedup-before-side-
  effect (D2/D8).
- **No key/secret committed** — HMAC secrets, the token pepper(s), `SYNC_API_TOKEN`,
  signing keys are env/secret only; `lint.mjs` forbid-list extended; redact fixtures.
- **`account_token`** keyed-HMAC at rest with `pepper_key_id`; shown once; scoped;
  revocable; emergency customer-wide revoke (D9).
- **Account isolation** — `customer_id` bound on every runtime path; no isolation-
  breaking bearer; portal least-privilege (D10/D11).
- **Fail-closed** on every gate; **audit everything** (`entitlement_events`,
  distinguishable `source`); **backup** the new authorization-critical tables (D15).
- Push only to `lyehe`; don't commit `extern/license-generator` or `.tmp/`; commit
  trailer `Co-Authored-By: Claude Opus 4.8 (1M context)`.

## Risks / open questions
- **D6 fingerprint contract** is the load-bearing new concept — validate that the
  operator's CRM can either supply a stable fingerprint or accept a derived one
  returned at ingest, and that the customer app receives it for activation.
- **Email uniqueness (D5)** assumes one login per billing entity; if a real
  customer needs multiple logins, that's a `customer_members` follow-up (out of scope).
- **Revocation SLA wording (D13)** is customer-facing — needs product sign-off on
  the acceptable "access ends within N" window per tier.

## Parallelization
Slice 0 is a hard prerequisite (shared service + single DB + identity contract) —
**sequential, no parallelism until it lands.** After Slice 0:
| Lane | Slices | Shared modules | Depends on |
|---|---|---|---|
| A | 1 (ingest) → 2 (token) | licensing-backend Worker, shared mutation service | Slice 0 |
| B | 4 (console) | admin Worker / React | Slice 0 (read-only on new tables) |
| C | 3 (portal) | new portal Worker | Slice 0 + Slice 2 (account_token) |
Execution: Slice 0 alone → then Lane A and Lane B in parallel worktrees → Lane C
after Slice 2. A and C both call the shared service (read-only import) — no write
conflict; B touches the admin Worker only.

## Implementation Tasks
Synthesized from the review. P1 blocks ship; P2 same-branch; P3 follow-up.

- [ ] **T1 (P1)** — foundation — Bind admin + licensing-backend Workers to one entitlements D1; demote forward sync to optional replica. Verify: both Workers read the same row by tuple.
- [ ] **T2 (P1)** — foundation — Extract shared entitlement-mutation service; extend it to write all seat/device columns. Verify: admin and a direct call produce byte-identical rows incl. `pool_size`/`max_active_devices`.
- [ ] **T3 (P1)** — schema — Extend `customers` (status, external_ref, UNIQUE email) + PG parity. Verify: dup-email insert rejected; `check-schema-parity.py` green.
- [ ] **T4 (P1)** — fulfillment — `POST /v1/orders`: HMAC verify + atomic event-claim/ordering/projection/mutation; cancel→disabled; fingerprint contract. Verify: adversarial workflow (replay/reorder/conflict/crash) green.
- [ ] **T5 (P1)** — identity — `account_tokens` (keyed HMAC + pepper_key_id) + bind `customer_id` on all runtime paths + hard bearer cutover. Verify: cross-account access denied; bearer cannot act cross-tuple.
- [ ] **T6 (P1)** — portal — customer-scoped handlers + new customer-scoped report + OTP/magic-link + download-.lic via lease Worker. Verify: IDOR suite denies every cross-account read/write/report.
- [ ] **T7 (P2)** — enforcement — Revocation SLA mechanics (lease/borrow clamp, heartbeat deny, downgrade reclaim). Verify: SLA suite bounds access end to one TTL/grace.
- [ ] **T8 (P2)** — console — customer/license tabs + reporting dashboard + fulfillment monitor. Verify: reader RBAC blocks the new writes.
- [ ] **T9 (P2)** — ops — Extend backup restore-drill required-tables + sensitive handling to the new tables. Verify: restore drill asserts all new tables present.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open→folded | 5 arch findings + Step 0 scope gate; all folded |
| Outside Voice | `/codex` | Independent 2nd opinion | 1 | issues_found→folded | 20 findings (Codex gpt-5.5); all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | portal UI (Slice 3) — run before building Slice 3 |
| DX Review | `/plan-devex-review` | DX gaps | 0 | — | not run |

- **CODEX:** 20 findings, all folded into D4–D15 + the new Slice 0 and the exactly-once/identity/SLA sections. Sharpest catches: write-path lives in the wrong Worker (D4), cancel→revoke terminal bug (D7), exactly-once transaction design (D8), bearer isolation bypass (D10), portal IDOR + non-unique email (D5/D11).
- **CROSS-MODEL:** one tension — sequencing. Eng review said "keystone first"; Codex showed the keystone depends on a shared-service extraction + identity contract. Resolved by inserting **Slice 0 (foundation)**; full scope retained.
- **VERDICT:** ENG + OUTSIDE VOICE CLEARED (all findings folded) — ready to implement, **Slice 0 first**. Recommend `/plan-design-review` before Slice 3 (portal UI).

**UNRESOLVED DECISIONS:**
- D13 revocation-window wording per tier needs product sign-off before Slice 3 ships customer-facing copy (does not block Slices 0–2).
