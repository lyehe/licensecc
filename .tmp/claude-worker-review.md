I could not open the source directly — this subagent has no file-read/grep/bash tools, and there's no TypeScript language server configured (the C++ repo's LSP can't parse `.ts`). So the review below is derived from your cited evidence plus Workers/D1/security reasoning; I've flagged the handful of claims that still need a source check. The line references are concrete enough that the logic findings hold regardless.

## Findings (most to least severe)

### F1 — HIGH: Rate limiting is keyed entirely on caller-controlled input, so it bounds nothing
`rateLimitKey = project:feature:license_fingerprint` (175–177) feeds **both** limiters — the CF RateLimit binding (218–219) and the D1 fixed-window counter (191–208) — and all three components come straight from the request. Client IP is only logged (227/244/417), never keyed.

Consequences:
- **Bypass:** an attacker who rotates `license_fingerprint` (or `feature`) gets a fresh bucket every request → no throttle on enumeration, volumetric abuse, or per-request cost.
- **Weaponizable against victims:** conversely, anyone holding a legitimate fingerprint can exhaust *that* license's bucket and lock out the real owner (DoS-by-key).
- Running two limiters on the *same* bypassable key isn't defense-in-depth; the D1 one is pure added cost (see F2).

**Fix:** add a client/network dimension as a separate limiter tier — CF RateLimit binding keyed on `request.cf` IP (or hashed IP/ASN), plus a global tier — and keep the per-entitlement counter only to protect legitimate owners, not as the primary gate. Throttle *before* signing/writes (F2).
**Tests:** N requests with rotating fingerprints from one IP must trip an IP-tier limit; hammering a single fingerprint must not be able to deny a *different* fingerprint.

### F2 — HIGH: D1 limiter increments before validation + assertions are always signed → unauthenticated write/CPU amplification & signing oracle
The D1 counter increments (191–208) *before* the entitlement lookup (373–378), and the worker **always** signs and returns an assertion (466–495), including a signed *denied* for unknown entitlements (confirmed intentional by the test at 369–383). So a request with a completely fabricated `project:feature:fingerprint:device` still triggers: a **D1 write**, a D1 read, and an **asymmetric signature** — and with F1 there's no effective throttle. That's a cost/DoS amplifier and an oracle.

**Fix:**
- Gate expensive work behind a cheap, non-attacker-keyed limiter (CF binding on IP) *first*; only touch D1/sign after that passes.
- Increment the durable counter **after** validation (meter real usage, not abuse), or move counting entirely to the memory-based CF binding and use `ctx.waitUntil` for any durable write so it isn't cancelled post-response.
- Keep signed denials (good fail-closed design) but make the denial **constant-shape and constant-reason** so it isn't an existence oracle (see F6); consider an unsigned cheap 4xx for inputs that fail basic validation before any lookup.
**Tests:** unknown entitlement must not cause an unbounded/uncapped D1 write; assert the cheap gate rejects before any sign/D1 work.

### F3 — HIGH: No `valid_from` / `valid_until` enforcement — expired licenses verify as OK
The select (373–378) doesn't even fetch a validity window, and `activeRow` (439–444) gates only on `status == active` + device match. Unless some external job flips `status` to expired/revoked *exactly* at the boundary, an expired (or not-yet-valid) license is honored. The assertion/cache TTL (60s, etc.) is an assertion lifetime, **not** the license term, so this isn't compensated elsewhere.

**Fix:** fetch `valid_from`/`valid_until`, require `now ∈ [valid_from, valid_until)` in `activeRow`, and embed the effective license `exp` in the **signed claims** so the client enforces it too (don't rely on cache TTL).
**Tests:** `valid_until` in the past with `status=active` → denied; `valid_from` in the future → denied; boundary (now == valid_until) behaves per spec.
*(Caveat: if those columns aren't in the schema / status is authoritative by design, this drops to Medium — confirm the schema intent.)*

### F4 — MEDIUM: Denied assertions carry `revocation_seq ?? 0`; revocation is advisory
Denials send `revocationSeq = row?.revocation_seq ?? 0` (≈459). If a client uses revocationSeq as a monotonic high-water mark, a denial advertising `0` can **roll back** the client's known revocation state. Also, since `activeRow` only checks `status` (439–444), whether a revoked-but-still-`active` row can vend `ok` depends on how revocation is modeled — confirm status is flipped atomically on revocation.

**Fix:** never emit a revocationSeq lower than known; omit it (or use an explicit "unknown" sentinel) on denials; define and document the status↔revocation_seq relationship and enforce it server-side.
**Tests:** revoked entitlement → denied; denial never regresses revocationSeq below a previously issued value.

### F5 — MEDIUM: Fixed-window limiter allows ~2× boundary burst, and its failure mode is unspecified
Fixed windows (191–208) permit a full budget at the end of window *N* and another at the start of *N+1*. Also undefined: if the D1 query throws (D1 outage), does it fail-open (allow → limiter defeated) or fail-closed (deny → self-DoS)?

**Fix:** prefer the CF RateLimit binding (sliding) as authoritative; if D1 durability is required, pick and document the fail mode explicitly.
**Tests:** window-boundary burst test; simulate D1 throw and assert the chosen fail behavior.

### F6 — MEDIUM: Entitlement existence/state oracle
Always-signed, reason-varying denials (445–463) let a caller distinguish unknown vs device-mismatch vs (post-F3/F4) expired/revoked for any `(project,feature,fingerprint,device)`. Combined with F1's missing IP throttle, this enables enumeration.

**Fix:** externally return a constant-shape, generic denial; keep the detailed reason in server logs only; pair with the IP-tier rate limit from F1. Also watch the 60s cached denial (445–463): under D1 read-after-write/replication lag a momentarily-unknown *legitimate* license could be cached as denied for 60s — consider a shorter negative TTL.

### F7 — MEDIUM: No CI for the worker
`.github/workflows` has only C++/docs jobs; there's no npm/wrangler job for `services/cloudflare-online-verifier`. Local `npm test/lint/dry-run` passing isn't gated, so the worker (and its D1 migrations) can regress or ship broken silently.

**Fix:** add a PR workflow scoped to `services/cloudflare-online-verifier/**`: `npm ci` → `npm run lint` → `npm test` → `tsc --noEmit` → `wrangler deploy --dry-run` → apply migrations against an ephemeral D1.

### F8 — LOW / confirm in source: Cloudflare hygiene
- **Signing key** must come from a Worker **secret** (`env`), not bundled in the build — confirm.
- **Floating promises:** ensure the D1 increment and the structured logs (227/244/417) are `await`ed or wrapped in `ctx.waitUntil`; otherwise they may be cancelled after the response returns, which *also* undercounts the limiter (worsens F2).
- **Typed bindings:** generate `Env` via `wrangler types`; avoid `any` on `env`.
- **Input validation / injection:** confirm all D1 queries use parameterized `.bind()` (not string interpolation) and that `project/feature/fingerprint/device` are length- and charset-bounded *before* they're used in the rate key and logs (log-injection / unbounded-key risk).
- **Assertion claims** should include `iat`/`exp`/`nonce` and a `kid` for key rotation; confirm replay protection is via embedded `exp`, not just transport/cache TTL.

## Needs source confirmation (couldn't open the file)
- F3: whether `valid_from/valid_until` exist in schema and are meant to be authoritative.
- F4: whether `status` is flipped atomically on revocation.
- F5: D1-limiter failure mode (open vs closed).
- F8: secret-sourced signing key, parameterized queries, `ctx.waitUntil`/awaited writes, claim contents.

## Highest-value missing tests (roundup)
1. Expired / not-yet-valid entitlement → denied (F3).
2. Rotating-fingerprint flood from one IP is throttled (F1); single-fingerprint flood can't deny a different fingerprint (F1).
3. Unknown entitlement causes no uncapped D1 write and no sign before the cheap gate (F2).
4. D1-limiter throw → asserted fail-closed/open behavior (F5); window-boundary burst (F5).
5. Revoked → denied; denial never regresses revocationSeq, never emits `0` over a known value (F4).
6. Device-mismatch and unknown produce byte-identical denial shape/reason (F6).
7. Assertion carries `exp`/`kid`; client rejects expired/replayed (F8).

**Net:** the core design (signed, fail-closed assertions) is sound, but F1+F2+F3 combine into an unauthenticated, unthrottled primitive that both amplifies cost and honors expired licenses — those three should block merge until fixed, and F7 (CI) should land alongside so the fixes stay enforced.
