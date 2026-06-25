# Slice 3 — self-serve customer portal — hardened blueprint

Date: 2026-06-24
Status: IMPLEMENTING. Source: design→attack→harden (login/session + isolation adversaries).
Parent: `2026-06-23-operations-back-office-architecture.md` (D11/D12/D14). Scope: D1 runtime.
New package `services/cloudflare-customer-portal/` (Worker + small React SPA) bound to the SAME
entitlements D1. Reuses the Slice-2 account_token isolation; the portal never signs and holds no
broad credential.

## 10 non-negotiable invariants
1. In-portal reads are read-only + customer-scoped; never import the entitlement MUTATORS (only types, the account-token resolver, and `buildIssue`/`insertTokenSqlGuarded`).
2. `customer_id` is ALWAYS server-derived from the verified session — never a client tuple/customer_id. The mint chokepoint `mintSessionToken(env, session)` takes the session object ONLY.
3. The browser never holds, and the DB never persists, the backend `lcca_` — `HttpOnly` cookie only; per-action ephemeral mint (120s), discarded after use.
4. Action handlers RESOLVE the target tuple server-side (`SELECT license_fingerprint FROM entitlements WHERE customer_id=? AND project=? AND feature=? AND status='active'`), then proxy the resolved fingerprint; wrong-owner = the SAME generic `not_found` (no existence oracle).
5. Auth throttling is ALWAYS-ON (dedicated `portalRateLimit`, never behind `D1_RATE_LIMIT_ENABLED`).
6. Magic-link secret never rides a mutating GET — bare GET is a POST-interstitial; secret never in logs/referer/redirect; origin from `PORTAL_PUBLIC_ORIGIN`, never request Host.
7. Backend `ACCOUNT_TOKEN_MODE=required`, asserted by portal `/health`.
8. No JWT for the customer session — opaque DB-backed (revocation needs a server row).
9. Logout bumps `account_token_revocations.revocation_seq` (kills the in-flight 120s token via the resolver floor), not just `status`.
10. Operator bootstrap is break-glass: bearer + network gated, always-on rate-limited, append-only audited, 120s TTL, unset in steady state.

## (a) Auth / session
**Two-secret OTP** (one row backs code + link): `secret = base64url(32 random)` (magic-link body); `code = (first 4 bytes as uint32) % 1e8` zero-padded to **8 digits**; stored as keyed HMAC (`secret_hmac`, `code_hmac = HMAC(pepper, email_lower+":"+code)` — email-bound) under `PORTAL_OTP_PEPPERS` (shared fail-closed `loadSecretMap`).
- **request** `POST /portal/v1/auth/request {email}`: always-on rate-limit (per email + per IP, ignores D1_RATE_LIMIT_ENABLED) BEFORE any write; resolve customer by `lower(email)` active; **no row → {ok:true}, send nothing + equal-cost dummy HMAC** (no enumeration); invalidate prior unconsumed; INSERT portal_otp (expires now+600); `ctx.waitUntil(sendEmail(...))` on BOTH branches; magic-link base from `PORTAL_PUBLIC_ORIGIN`; NEVER return the secret.
- **redeem** (`verify` code / `magic-redeem` secret): candidate HMAC under every live pepper; always-on per-(customer,IP) verify counter; ATOMIC single-use claim `UPDATE portal_otp SET consumed_at=? WHERE (secret_hmac IN(..) OR code_hmac IN(..)) AND consumed_at IS NULL AND expires_at>? AND attempt_count<5 RETURNING id, customer_id`; null=deny (no oracle); bump attempt_count ONLY when a live row matched; wrong-code vs no-OTP byte-identical. Success → mint session.
**Session**: opaque `lccp_<base64url(32)>`; `session_hmac` HMAC-at-rest; cookie `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`. `resolveSession` uses `env.DB.withSession?.("first-primary")` strong read + JOIN customers active; status+expiry checked. Logout = revoke row + bump revocation_seq + clear cookie. Log-out-everywhere = `UPDATE portal_sessions SET status='revoked' WHERE customer_id=? AND status='active'`.
**Portal→backend** = per-action ephemeral mint: `mintSessionToken(env, session)` (session only) → `buildIssue` an `account_token` for `session.customer_id`, scopes pinned to `SELECT DISTINCT project,feature FROM entitlements WHERE customer_id=?` + the operation (read paths `["report"]`; action paths `["activate","checkout","heartbeat","release","renew"]`; never `*`/allow_all), TTL now+120, plaintext never persisted/sent to browser; `proxyBackend` sends `Authorization: Bearer lcca_` to `${BACKEND_ORIGIN}/v1/*`, strips upstream Authorization on error passthrough. Backend `accountAuth` is the authoritative boundary.

## (b) Data model — migration 0016 (backend migrations dir; schema.sql + PG mirror; parity)
- `portal_otp` (id, customer_id FK, email_lower, secret_hmac, code_hmac, pepper_key_id, attempt_count, consumed_at, expires_at, created_at; UNIQUE secret_hmac, UNIQUE code_hmac, idx expires_at).
- `portal_sessions` (id, customer_id FK, session_hmac, pepper_key_id, account_token_id FK→account_tokens SET NULL [row id only, NO plaintext], status active/revoked, user_agent, created_at, last_used_at, expires_at; UNIQUE session_hmac, idx customer, idx expires_at).
- `portal_bootstrap_events` (id, customer_id FK, email_lower, actor, created_at; idx customer).
- Sweep in backend `scheduled()`: DELETE expired portal_otp + revoked/expired portal_sessions.

## (c) Worker routes (session→customer_id on EVERY one; trust = session, never client tuple)
- `/portal/v1/auth/request|verify|magic(GET interstitial)|magic-redeem|logout`, `/portal/v1/admin/bootstrap-otp` (bearer+network gated), `/api/portal/me|entitlements|devices|usage|checkout|heartbeat|release|download`, `/health` (asserts required mode), SPA fallback via env.ASSETS.
- POST routes reject cross-site (Origin/Sec-Fetch-Site). Reads use `WHERE customer_id=?` (Slice-2 teeth); usage uses the ownership EXISTS. Action/download: server-resolve the fingerprint, mint per-action token, proxy; download streams the signed `.lic` (Content-Disposition attachment), portal never parses/signs.

## (d) React app (clone admin SPA): login (email→8-digit code→me) + magic interstitial; my-entitlements (read-only); my-devices/seats (checkout/heartbeat/release); usage; download. No bearer in browser (cookie only, `credentials:"same-origin"`). Pure `portalWorkflow.ts` (paths + shortHash + formatters).

## (e) sendEmail seam (`portal_email.mjs`, fetch-only Resend adapter; email_unconfigured does NOT 503 — falls back to bootstrap). Operator bootstrap (the ONLY path that returns a secret): bearer (constant-time, unset→404) + network gate (Access/IP) + always-on RL + 120s TTL + append-only audit; never logs the secret.

## (f) Files
NEW package `services/cloudflare-customer-portal/`: package.json (file:../cloudflare-licensing-backend dep), tsconfig{,.worker}.json, vite.config.ts, wrangler.example.jsonc + wrangler.toml (SAME D1 + migrations_dir ../cloudflare-licensing-backend/migrations + ACCOUNT_TOKEN_MODE=required + PORTAL_*), index.html, playwright.config.mjs, scripts/lint.mjs, src/shared/api.ts (re-export backend types), src/worker/index.ts, src/auth/portal_{otp,session,token,email,ratelimit}.mjs, src/ui/{main.tsx,portalWorkflow.ts,styles.css}, test/portal-{otp,session,ratelimit,worker,ui-workflow}.test.mjs + test/portal-ui.e2e.mjs.
BACKEND edits: migration 0016 + schema.sql + schema.pg.sql; package.json exports add Worker-safe `./auth/account_token_issue` (re-export buildIssue/insertTokenSqlGuarded from a .mjs, NOT the Node CLI) + `./auth/account_token` + `./auth/account_auth` + `./lease/usage_report`; src/index.ts scheduled() sweep.

## (g) Test plan
- portal-otp unit: 8-digit derivation; HMAC-at-rest (no plaintext); single-use; TTL; attempt-cap; re-issue invalidation; multi-pepper; no-customer ok+dummy-work; A's code+B's email no-match; attempt-bump only on matched row; requestOtp returns no secret; RL generic ok.
- portal-session unit: mint→resolve; revoked/expired/disabled deny; first-primary strong read used; revokeAllForCustomer; cookie shape.
- portal-ratelimit unit: throttles with D1_RATE_LIMIT_ENABLED unset; per-(customer,IP) verify counter independent of per-row cap.
- portal-worker IDOR matrix (MockD1, port account_isolation): A sees only A; A→B referencing B's tuple → generic not_found (no oracle); forged body customer_id/tuple ignored (hard test: mint call has no body field); server-resolve fingerprint; 401 on missing/invalid/revoked session; 403 cross-site; disabled 401; minted-token scope (report-only can't activate; pinned never *); 120s TTL not persisted; logout bumps revocation_seq; pepper-unset → 503; mode!=required → /health unhealthy; download streams unchanged + strips upstream auth; bootstrap 404 unset / 403 no-Access / audited+120s.
- Playwright e2e: login (request→code→me)→screens + magic interstitial; leak guard (page text never has PRIVATE KEY/BEGIN/Bearer /lcca_/lccp_/magic token/another customer's ids).
- Gates: parity, lint (forbidden-secret scan), tsc, admin 43 (no admin change), backend.
