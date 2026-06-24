# Slice 1 — signed, exactly-once order-ingest (`POST /v1/orders`) — hardened blueprint

Date: 2026-06-24
Status: IMPLEMENTING. Stage 1 (data model, migration 0014) DONE + committed (`252cc2e`).
Source: design→attack→harden workflow (3 adversaries: data/crash, auth, semantics);
this is the folded-in final spec. Parent plan: `2026-06-23-operations-back-office-architecture.md` (Slice 1).
Scope: **D1 runtime first** (production); `schema.pg.sql` DDL is ported, but the PG
**runtime** apply path (`entitlement-pg.mjs`) for orders is a tracked follow-up.

## The two structural hardenings the adversaries forced
1. **Apply-time monotonic floor + atomic mark.** `entitlements.last_applied_order_{epoch,seq}`
   (added in 0014). The apply upsert's `ON CONFLICT DO UPDATE ... WHERE` rejects
   `(epoch,seq) <= (last_applied_order_epoch,last_applied_order_seq)`, and the
   `order_events` `status='processed'` mark commits in the **same** transaction as the
   mutation. Kills: accept-vs-apply race, revocation_seq double-bump, seat-reclaim RMW loss.
2. **Fingerprint ownership invariant.** `idx_orders_fp_unique` UNIQUE(project,feature,
   license_fingerprint) + a Step-2 ownership check → a fingerprint belongs to exactly one
   subscription. Kills cross-tenant hijack + derived/supplied collision.

## Architecture: B (accept-then-apply), reusing the shared mutators
Accept (claim event + advance cursor) is one atomic `env.DB.batch`; apply uses the shared
`createEntitlement`/`patchEntitlement`/`transitionEntitlement`/`setEntitlementCapacity` with
the floor guard + in-txn processed-mark. Crash-safety = durable accept cursor + the apply
floor (a crashed `accepted` row is re-driven; the floor makes re-apply safe/self-superseding).

## Exactly-once flow (branch by branch)
**Step 0 — auth + parse (no DB write):** mode gate (`ORDER_INGEST_MODE` default `required`;
`off` dev-only; `soft` observe-only never mutates); Content-Length precheck + pre-auth
rate-limit keyed on key_id/IP; `await request.text()` once (never `.json()`), enforce
`MAX_ORDER_BODY_BYTES=16384`; HMAC verify over raw bytes (§HMAC); normalize → `OrderEvent`;
`payload_digest = sha256(normalized body)` (NOT the ts-bearing signed bytes).

**Step 1 — replay dedup on `event_id`:** `SELECT status,result_json,payload_digest FROM order_events WHERE event_id=?`.
processed/superseded/rejected + digest match → return cached `result_json`; `accepted` + match
→ fall to Step 5 redrive; digest differs → `409 event_id_conflict`; no row → Step 2.

**Step 2 — identity + ownership:** derive fingerprint (supplied → `origin='supplied'`; else
`sha256(subscription_id:project:feature)` → `derived`, period-independent). Ownership gate:
`SELECT subscription_id FROM orders WHERE project=? AND feature=? AND license_fingerprint=?`;
if a different subscription owns it → `409 fingerprint_owned`. Upsert `orders` (fingerprint /
origin / epoch / last_seq immutable once set — `ON CONFLICT DO UPDATE SET updated_at` only);
upsert `customers` (email trim+lowercase per 0013) + `licenses` (validate `licenses.project===order.project`).

**Step 3 — atomic ACCEPT (one `env.DB.batch`, fail-closed 503 if no `batch()`):**
- 3a guarded cursor advance (lexicographic on `(order_epoch, seq)`):
  `UPDATE orders SET order_epoch=?,last_seq=?,updated_at=? WHERE subscription_id=? AND project=? AND feature=? AND (order_epoch < ? OR (order_epoch=? AND last_seq < ?)) RETURNING last_seq,order_epoch`.
- 3b guarded event claim (insert only if 3a won):
  `INSERT INTO order_events (...) SELECT ...,'accepted','',?,NULL WHERE EXISTS (SELECT 1 FROM orders WHERE ...sub/proj/feat AND order_epoch=? AND last_seq=?) RETURNING event_id`.
- Branches: both rows → accepted (Step 4). 3a no row → STALE: no mutation, no revocation bump;
  disambiguate via `SELECT payload_digest FROM order_events WHERE ...(epoch,seq)`: differs →
  `409 seq_conflict`; same/none → insert `status='superseded'` caching `200 stale_ignored`,
  **emit warn audit + `stale_ignored` metric** (observable wedge), return `200 stale_ignored`.
- seq reset → operator bumps `order_epoch`; post-reset low seq is `stale_ignored` *observably*.

**Step 4 — APPLY (shared mutators, monotone-guarded, mark in same txn):** map intent→mutation
(below), reading `prev` first. Mutation upsert carries the floor in `ON CONFLICT DO UPDATE ...
SET ..., last_applied_order_epoch=excluded.*, last_applied_order_seq=excluded.* WHERE
(entitlements.last_applied_order_epoch, entitlements.last_applied_order_seq) < (excluded.*, excluded.*)`.
Same batch: `UPDATE order_events SET status='processed',result_json=?,processed_at=? WHERE event_id=? AND status='accepted'`.
If the floor no-ops the upsert (newer already applied) → still mark processed, `code='superseded'`,
no revocation bump. Return `200 applied` + entitlement snapshot + `license_fingerprint`.

**Step 5 — crash redrive:** a crash leaves an `accepted` row whose mutation+mark never committed
(atomic ⇒ entitlement untouched). Re-run Step 4; the floor decides apply-or-supersede. A
background sweep (or the next order) re-drives any lingering `accepted`. `raw_payload` is durable
⇒ fulfillment never lost. Seat-reclaim diff is computed from the **prior applied event's
`raw_payload`**, not live state, so re-drive can't lose it.

## HMAC scheme
Headers: `X-LCC-Key-Id`, `X-LCC-Timestamp` (unix s int), `X-LCC-Signature` (b64 HMAC-SHA256).
`signedBytes = "POST\n/v1/orders\n<ORDER_INGEST_AUDIENCE>\n<canonical-int-ts>\n<raw body bytes>"`.
- Audience (`prod`/`staging`) blocks cross-env replay; asserted non-empty at boot in `required`.
- Header ts must equal its canonical integer form (no `"123.0"`/`" 123"`).
- Key map `ORDER_HMAC_SECRETS` = JSON `{key_id: base64-secret}` into `Object.create(null)`;
  lookup via `hasOwnProperty` + `typeof==='string'`; reject empty map / empty / <32-byte secret
  at load (fail-closed). Unknown key_id → `401 unknown_key_id`. Persist accepting `key_id` on the event.
- Verify via `crypto.subtle.verify` (constant-time); never manual `===`.
- Skew: `|now-ts| > maxSkew` → `401 stale_timestamp`; `maxSkew = ORDER_MAX_SKEW_SECONDS` (default 300, cap 3600).
- Replay order: verify → skew → spend nonce LAST: `INSERT INTO order_ingest_nonces (...) ON CONFLICT DO NOTHING RETURNING` keyed (key_id,event_id); null → `401 replayed`; DB error → 503. TTL `2*maxSkew`.

New `Env`: `ORDER_HMAC_SECRETS`, `ORDER_INGEST_MODE` (default `required`), `ORDER_MAX_SKEW_SECONDS`, `ORDER_INGEST_AUDIENCE`.

## OrderEvent shape + intent→mutation
```
OrderEvent { event_id, subscription_id, order_epoch?=0, seq, intent, project, feature?,
  license_fingerprint?, current_period_end?, quantity?{pool_size?,max_active_devices?},
  customer?{id?,external_ref?,name?,email?}, license_id?, occurred_at? }
```
Validate: safeString ids, safeUnixSeconds times, non-neg ints for seq/epoch/quantities.
Unknown intent / `current_period_end <= now-GRACE` (without explicit cancel-now) → `400 invalid_order`.
`createEntitlement` is reserved STRICTLY for `subscription.active`; all modify-intents use
transition/patch/capacity (return null on missing → never materialize access).

| intent | mutation | notes |
|---|---|---|
| subscription.active | createEntitlement → active, valid_until=clamp | only creator; floor-guarded |
| subscription.renewed | patchEntitlement (missing→null) → active, valid_until=max(period_end,prev) | carry-forward customer_id/license_id when omitted |
| subscription.past_due / paused / payment_failed | transitionEntitlement → 'disabled' (REVERSIBLE) | missing → no_entitlement |
| subscription.canceled_at_period_end | patchEntitlement (missing → no_entitlement, NO create) | keep active, valid_until=clamp |
| subscription.resumed | transitionEntitlement → 'active' (reenable) | missing → no_entitlement |
| quantity.changed | setEntitlementCapacity + synchronous seat reclaim | downgrade diff from prior event's raw_payload |
| fraud.confirmed / chargeback | transitionEntitlement → 'revoked' (terminal) | ONLY revoke path |

- `valid_until = max(current_period_end, prev?.valid_until ?? 0)` (monotone forward); enforce `valid_from < valid_until`; backdated period_end can't expire an active customer.
- quantity downgrade: if new `pool_size < live_seats`, in the same batch `DELETE FROM seat_checkouts ... ORDER BY heartbeat_deadline DESC LIMIT (live_seats-pool_size)` + `usage_events('reclaim')`.
- missing → mark processed `code='no_entitlement'` (terminal); revoked target → catch `revoked_terminal`, mark `rejected`, `409 entitlement_revoked` (terminal). Never 5xx (don't poison the inbox).

## D6 fingerprint
Supplied (ownership-checked) or derived `sha256(subscription_id:project:feature)`; persisted
immutable in `orders`; always echoed in the (cached) response + `fingerprint_origin`.

## Files to create / change (remaining stages)
- CREATE `src/fulfillment/order_event.mjs` — pure: `normalizeOrderEvent`, `mapIntentToMutation`, `deriveFingerprint`, `clampValidUntil`, `buildAcceptBatch`, `applyOrderEvent`, `handleOrderIngest`.
- CREATE `src/fulfillment/order_hmac.mjs` — `verifyOrderHmac(request, env, bodyText)`.
- EDIT `src/entitlements/entitlement_mutation.mjs` — backward-compatible floor + in-txn mark
  (admin callers pass no order info → no floor, behavior identical; gate admin 43). Prefer
  extending `writeEntitlementWithAudit` to accept an optional order floor + extra batch statement,
  reusing `ENTITLEMENT_COLUMNS`/`REVOCATION_SEQ_BUMP`, rather than coupling `createEntitlement`.
- EDIT `src/index.ts` — Env fields, `MAX_ORDER_BODY_BYTES`, router arm `POST /v1/orders`, export `bytesFromBase64`/`parsePositiveInt`/`safeUnixSeconds`.
- CREATE `scripts/order-sign.mjs` — HMAC signer CLI (canonical bytes incl. audience + int ts).
- EDIT `wrangler.example.toml` + `README.md` — vars/secrets + the `/v1/orders` contract.
- (DEFERRED, tracked) `supabase-postgres/entitlement-pg.mjs` order apply path.

## Test plan (node --test, mirrors test/)
- `test/fulfillment/order_event.test.mjs` — normalize accept/reject, fingerprint stability, every intent map row, clamp monotone-forward.
- `test/fulfillment/order_hmac.test.mjs` — valid/tamper/wrong-key/expired/unknown-key/short-secret fail-closed; `__proto__` key_id; canonical-ts; audience mismatch; raw-bytes identity; nonce replay; mode gating.
- `test/fulfillment/order_ingest_exactly_once.test.mjs` — the 16-case adversarial matrix: fresh apply; processed replay (no 2nd bump); stale seq (stale_ignored + warn/metric); seq_conflict; event_id_conflict; crash redrive (no regression); double-bump guard; concurrent N/N+1; orthogonal-axis; seq reset+epoch; fingerprint ownership 409; valid_until clamp; seat reclaim; missing/revoked disposition; renew carry-forward; intent coverage.
- CI: `check-schema-parity.py` (done, green) + `lint.mjs`.

## Attack dispositions (all accounted for)
DATA: #1 cached replay (kept); #2 double-bump+reclaim-loss FIXED (atomic mark + prior-payload diff); #3 stale cancel (kept, cursor); #4 seq rollback FIXED (epoch + warn/metric); #5 concurrent FIXED (disjoint axes + floor); #6 crash+higher-seq FIXED (disjoint-axis floor); #7 partial visibility FIXED on PG (BEGIN/COMMIT), D1 atomic.
AUTH: #2 key map hardened; #3 raw-bytes; #4 digest over normalized body; #7 audience; #8 default required + reject empty/short (top finding); #10 soft observe-only; #11 size+rate precheck. #6 symmetric skew NOTED (bounded by dedup), #1/#5/#9 kept.
SEMANTICS: #2 synchronous reclaim; #3/#4 ownership invariant; #5 carry-forward + project validate (DB FK REJECTED, separate migration); #6 terminal no_entitlement/revoked dispositions; #7 monotone clamp; #8 cancel never creates.
