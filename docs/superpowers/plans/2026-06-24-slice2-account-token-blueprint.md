# Slice 2 — account_token + account isolation — hardened blueprint

Date: 2026-06-24
Status: IMPLEMENTING. Source: design→attack→harden workflow (3 adversaries: lifecycle, isolation, cutover).
Parent: `2026-06-23-operations-back-office-architecture.md` (D9/D10). Scope: D1 runtime.
Ship-blockers (resolved): `entitlements.license_id` + `licenses.customer_id` exist (backfill OK);
`D1.withSession` unused → feature-detect the strong read, the per-customer revocation-seq floor is
the primary guard; mode mirrors `REQUEST_SIGNATURE_MODE`.

## Five structural decisions the adversaries forced
1. **Ownership predicate on the MUTATING statement, not the read.** The authoritative `customer_id`
   check is a SQL conjunct of the INSERT/UPDATE/DELETE (atomic, no TOCTOU). `NULL = ?` is never true →
   NULL-customer rows fail closed. Wrong-owner is indistinguishable from absent (no existence oracle).
   Read-side filters are defense-in-depth only.
2. **Per-customer `account_token_revocations.revocation_seq` floor** (process-local non-decreasing) +
   optional D1 strong read → emergency revoke is effective despite replica lag.
3. **`soft` mode splits:** NULL-owner → allow + log `isolation_mismatch`; **populated-mismatch → DENY even in soft**.
4. **`off`-mode shadow-eval** (`resolveAccountToken` logged, not enforced) gates the `off→soft` flip so a
   `LEASE_ISSUE_BEARER`-unset deployment can't mass-401.
5. **Pepper removal refused while live tokens reference it** (`repepper` = rotate-with-overlap, not force-expire).

## (a) Data model — migration `0015_create_account_tokens.sql`
Three tables (NO change to entitlements DDL — `customer_id TEXT NULL` is the binding column):
- **`account_tokens`** — `id` PK, `customer_id` FK→customers (CASCADE), `token_hmac` (UNIQUE; base64 keyed-HMAC),
  `pepper_key_id` (drain-targeting, NOT an auth selector), `token_prefix` (display only, NEVER a WHERE),
  `name`, `scopes_json` ('{}' = all-on-axis), `status` (active/revoked/disabled), `expires_at` NOT NULL,
  `last_used_at` NULL (throttled; never gates auth), `replaced_by` FK (rotation overlap), `created_by`, timestamps.
  Indexes: UNIQUE(token_hmac), (customer_id), (status).
- **`account_token_revocations`** — `customer_id` PK, `revocation_seq` NOT NULL DEFAULT 0, updated_at. Bumped on every revoke/revoke-customer.
- **`account_token_events`** — audit (id AUTOINCREMENT, account_token_id, customer_id, event_type CHECK(issue/rotate/revoke/revoke-customer/repepper/merge), actor, actor_type, source, reason, request_id, created_at). Separate table (no CHECK migration on entitlement_events).
- **Backfill (trivially-derivable only):** `UPDATE entitlements SET customer_id=(SELECT l.customer_id FROM licenses l WHERE l.id=entitlements.license_id), updated_at=unixepoch() WHERE customer_id IS NULL AND license_id IS NOT NULL AND (...) IS NOT NULL;` then emit an orphan count.
- Mirror byte-for-byte into `schema.sql`; hand-port to `schema.pg.sql` (AUTOINCREMENT→IDENTITY, unixepoch()→extract(epoch from now())::bigint).

## (b) Token crypto — `src/auth/account_token.mjs`
Reuse `loadSecretMap`/`lookupSecret`/`bytesFromBase64` (export from `order_hmac.mjs`). Env:
`ACCOUNT_TOKEN_PEPPERS` (JSON {id: base64>=32B}, fail-closed), `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID`,
`ACCOUNT_TOKEN_MODE` (off|soft|required), `ACCOUNT_TOKEN_LAST_USED_THROTTLE_SEC` (300), `EMERGENCY_OPERATOR_BEARER`.
- `generateAccountToken()` → `lcca_` + base64url(32 random bytes via crypto.getRandomValues); `token_prefix` = first 12 chars (display only).
- `hashToken(pepperBytes, rawBytes)` → base64(HMAC-SHA256). importKey `["sign"]`.
- `resolveAccountToken(env, rawToken, now)`: peppers null → `config_error` (503). Compute candidate HMAC under EACH live pepper; `SELECT ... WHERE token_hmac IN (?,...) LIMIT 1` JOIN customers (active) LEFT JOIN revocations. Use `env.DB.withSession?.("first-primary")` if available else plain prepare. Reject status!=active (`token_revoked`), expires_at<=now (`token_expired`), unknown (`unauthorized`). Seq floor: process-local Map per customer; if row.revocation_seq < seen → `token_revoked`; else advance.
- `tokenAllows(scopes_json, project, feature, operation)`: JSON parse (malformed→deny); each axis list empty/absent = allow-all else includes(v). Operations = activate/renew/checkout/heartbeat/release/report.
- `touchLastUsed`: throttled UPDATE (never gates auth, swallow errors) + one throttled `account_token.used` log; folds the lazy re-pepper (rewrite token_hmac to active pepper on touch when pepper_key_id != active).
- Guards: token_prefix NEVER in a WHERE (L1); raw token / Authorization NEVER to logEvent/console (L10).

## (c) Per-endpoint isolation binding (the teeth)
Shared `accountAuth(request, env, operation, now)` replaces the 4 `LEASE_ISSUE_BEARER` gates
(index.ts:1296/1500/1681/1813). Codes: missing/unknown/revoked/expired→401; scope miss→403 forbidden_scope;
pepper unusable→503 config_error (terminal-deny, NEVER bearer-fallback in soft/required). The token's
`customerId` is bound into the MUTATING statement:

| Endpoint | Mutating-statement change | NULL/wrong-owner |
|---|---|---|
| /v1/activate + /renew (handleLeaseIssue) | `AND customer_id=?` in `LEASE_ISSUANCE_ATOMIC_SQL` guard subquery + entitlement-existence | guard matches no row → no_active_entitlement |
| /v1/checkout (handleSeatCheckout) | `AND customer_id=?` in `SEAT_CHECKOUT_ATOMIC_SQL` guard AND pool-count subquery (foreign seats neither match nor count) | guard no row → no_active_entitlement |
| /v1/heartbeat | UPDATE ... AND EXISTS(entitlements e ...tuple... AND e.customer_id=?) | EXISTS false → 0 rows |
| /v1/release | DELETE ... AND EXISTS(...e.customer_id=?) RETURNING | 0 rows freed; idempotent {ok:true} |
| /v1/admin/report | usage_events SELECT ... AND EXISTS(...e.customer_id=?); liveSeatsAt baseline same EXISTS | empty/403 |

EXCLUDED (verified sound): `/v1/verify` (anonymous device-proof data-plane), `/v1/orders` (separate HMAC domain), `/health`.

Modes: `off` = legacy bearer (constant-time compare via crypto.subtle, L9) + shadow-eval logging;
`soft` = token required (bearer not accepted), NULL-owner allow+log, populated-mismatch DENY;
`required` = full conjunct, NULL/mismatch denied, LEASE_ISSUE_BEARER removed.

## (d) Lifecycle + issuance — `scripts/account-token.mjs` (CLI, mirrors entitlement.mjs)
Subcommands: `issue` (--customer-id --name (--scopes <json>|--scopes-all) --expires-at; mandatory scopes, no implicit {} master; print plaintext ONCE to tty or --out 0600),
`rotate` (--id [--overlap-sec] [--compromised→zero-overlap revoke]; "rotate is hygiene not revocation" banner; sets replaced_by),
`revoke` (--id; status=revoked + bump revocation_seq; exit 3 on no-op),
`revoke-customer` (EMERGENCY; revoke all of a customer's tokens + bump seq; immediate, no deploy),
`repepper` (--from --to; rotate-with-overlap; refuses while active rows reference the old pepper),
`link` (--project --feature --fingerprint --customer-id; backfill NULL customer_id) + `link --list-orphans` (the cutover worklist + exit gate),
`merge-customer` (--from --into; one txn updates entitlements + account_tokens, bump seq),
`list` (--customer-id). C6: CLI asserts --pepper-key-id == Worker ACTIVE_PEPPER_ID. Secondary surface = admin Worker endpoints (after CLI).

## (e) Safe cutover (no cross-account window, no mass outage)
1. Deploy in `off`: ship everything, set peppers, run 0015 backfill, `link` orphans, issue tokens. Shadow-eval logs `account.shadow_nomatch`. **Gate off→soft:** flip only when shadow-nomatch for active callers = 0 over a full cycle (token-presence coverage).
2. `soft`: token required, bearer dropped; NULL-owner allow+log, populated-mismatch deny. **Gate soft→required:** refuse while any touched entitlement has NULL customer_id.
3. `required`: full isolation; remove LEASE_ISSUE_BEARER; delete raw `!==`.
Break-glass: `EMERGENCY_OPERATOR_BEARER` on a SEPARATE `/v1/emergency/*` route only (never the 6 scoped paths), off by default, constant-time, loud audit.

## (f) Files
CREATE: migration 0015; `src/auth/account_token.mjs`; `scripts/account-token.mjs`; `test/auth/account_token.test.mjs`; `test/integration/account_isolation.test.mjs`.
CHANGE: schema.sql + schema.pg.sql (3 tables); `order_hmac.mjs` (export the 3 helpers); `issuance_sql.mjs` (customer_id in both ATOMIC_SQL guards); `index.ts` (Env, accountAuth, the 6 gate rewrites + write-side bindings, modes/shadow-eval, /v1/emergency route, no-raw-token-in-logs); package.json (account-token script); wrangler.example.toml (vars); lint.mjs (L1/L10 assertions).

## Round-2 review corrections (mine + Codex cross-model) — FOLD INTO IMPLEMENTATION

These supersede the relevant parts above; the 3-attacker pass missed F1/F3/F6.

- **F1 [HIGH] — idempotency bypasses isolation (fix FIRST).** `getLeaseIdempotent()`/`mutation_idempotency` is keyed on `("lease", request_id)` and returns the cached lease BEFORE the ownership path (`index.ts:1261`), so replaying a captured `request_id` returns another customer's signed lease. **Fix:** scope every idempotency key/lookup by `customer_id` (token's customer) so a replay under a different token misses the cache and falls through to the ownership guard. Same for any seat idempotency. Re-validate ownership on a cache hit if the cache is ever cross-customer.
- **F2 [HIGH] — ownership predicate placement.** `lease_issuance`/`seat_checkouts` have NO `customer_id`. Ownership is `AND EXISTS (SELECT 1 FROM entitlements e WHERE e.project=? AND e.feature=? AND e.license_fingerprint=? AND e.customer_id=?)` on the mutating INSERT/UPDATE/DELETE; the device/seat count subqueries STAY tuple-scoped (do NOT add customer_id to them).
- **F3 [HIGH] — fold the full entitlement gate into the mutation; sign post-guard.** Pre-read status/validity is advisory only. Put `status='active'` + validity (`valid_from`/`valid_until` window) + `customer_id` into the guarded INSERT EXISTS so a revoke/expiry between read and write cannot mint a lease/assertion. The signed lease must derive from the guard-confirmed row (RETURNING / re-read after the guarded mutation), not the pre-read.
- **F4 [HIGH] — emergency revoke needs the strong read.** Implement the feature-detected `env.DB.withSession?.("first-primary")` for the auth SELECT; the process-local `revocation_seq` floor is a within-isolate optimization only (cold isolates / stale-replica reads are NOT covered by it). If neither strong-read nor a fresh floor is available, the resolver must fail closed while a customer's revocation is recent.
- **F5 [MED] — scope fail-CLOSED.** `tokenAllows`: grant only on explicit `allow_all:true` OR a non-empty allow-list that includes the value; absent/empty axis = DENY. No `{}`-means-master.
- **F6 [HIGH] — soft gate = zero active NULL-owner entitlements.** Do not enter `soft` while ANY active entitlement has NULL `customer_id` (a broad-scope token would reach all orphans). Either gate on the global NULL-owner count = 0, or route NULL-owner access through a migration-only legacy flag, not a general per-row relaxation.
- **F7 [MED] — merge-customer completeness.** One transaction over `entitlements`, `account_tokens`, `account_token_revocations`, `licenses.customer_id`, AND `orders.customer_id` (Slice 1 identity home); bump `revocation_seq` for BOTH source and destination customers.
- **F8 [MED — optimization] — heartbeat hot path.** Cache the imported HMAC `CryptoKey`s per env-config (not per request); cap the live-pepper count; move `last_used_at` write + lazy re-pepper into `ctx.waitUntil` (off the response path); skip or sample the `last_used_at` touch on `/v1/heartbeat`.
- **F9 [LOW] — export helpers.** `order_hmac.mjs` must export `loadSecretMap`/`lookupSecret`/`bytesFromBase64` (currently un-exported) for the token module to reuse.

## (g) Test plan
- Unit (`test/auth/account_token.test.mjs`): hashToken determinism/per-pepper/ref-vector; generate entropy/prefix; pepper fail-closed (missing/bad/empty/short/__proto__); resolve (active/revoked/expired/unknown/disabled-customer); seq floor rejects replica-stale; tokenAllows ({} all, hits/misses, malformed deny); touchLastUsed throttle; rotation overlap + --compromised; lazy re-pepper; L1 selector guard; L10 log guard.
- Integration (`test/integration/account_isolation.test.mjs`, REAL SQLite + D1 adapter): the 6 endpoints × matrix (A-token/A allow; A-token/B deny no-oracle; NULL under required deny; NULL under soft allow+log; populated-mismatch under soft DENY; no/revoked/expired/out-of-scope token; pepper-unset 503; disabled-customer denied). Write-atomicity (I1): A's seats don't count against B's pool; A can't heartbeat/release/lease/report B; TOCTOU merge probe. Lifecycle: emergency revoke-customer effective vs replica-stale (seq floor); pepper-removal refusal; emergency bearer only on /v1/emergency; shadow-eval; /verify+/orders unaffected.
Round-2 regressions (the missed flaws — MUST have explicit tests): **F1** replay of customer B's `request_id` under customer A's token does NOT return B's cached lease (idempotency scoped by customer → cache miss → ownership-denied); **F3** an entitlement revoked/expired AFTER the pre-read but before issuance does NOT mint a lease (guarded INSERT EXISTS includes status+validity; nothing signed from stale pre-read); **F5** a token with `scopes_json='{}'` is DENIED (fail-closed), only `allow_all:true`/explicit lists grant; **F6** `soft` mode is refused while any active NULL-owner entitlement exists; **F7** merge-customer moves orders.customer_id + licenses.customer_id too (a post-merge order-ingest renewal links to the new customer).
Gates: parity, lint (incl. L1/L10), tsc, admin 43 (no admin change so unaffected).
