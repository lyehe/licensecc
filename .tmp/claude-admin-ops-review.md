Confirmed the layout: the script lives at `services/cloudflare-online-verifier/scripts/entitlement.mjs` (the evidence's `scripts/…` is service-relative). Two incidental observations from probing: there's **no `typescript-language-server` on PATH**, and I have no raw-file-read capability in this session — so line-level details (entitlement.mjs:69-83/95/104, the 0001 schema) rest on your evidence; I verified directory/layout and the absence of the admin service, not the bytes. Findings below.

---

## Blockers — must land before any admin *mutation* ships

**B1 · Admin authn/authz is undesigned, yet it gates a revoke/disable surface.**
The plan orders "auth/read API" before "mutations" (good), but there's no committed decision on *mechanism* (Cloudflare Access vs. mTLS vs. signed JWT vs. KV-stored API tokens) and no RBAC concept (who may read vs. who may revoke). This is the highest-risk component in the whole system: it controls who can turn off paying customers.
*Fix:* Pick a mechanism now and write it into the plan; default to Cloudflare Access in front of the Worker + a bearer/JWT the Worker validates, with at least two roles (reader, admin). Hard-gate every mutation handler behind authz, fail-closed.
*Tests:* unauthenticated and under-privileged requests to both read and mutation endpoints are rejected (401/403); authz matrix reader-vs-admin; expired/forged token rejected.

**B2 · Hand-interpolated SQL (entitlement.mjs:69-83) becomes an injection vector server-side.**
"Validated locally" is fine for a CLI you run yourself; it is not fine once the *same write kernel* (the plan reuses this logic) handles admin-supplied input in a Worker. D1 supports prepared statements.
*Fix:* Bound parameters only (`db.prepare(sql).bind(...)`); ban string interpolation of values in the write kernel. Add a lint rule / code-review gate.
*Tests:* injection-attempt cases (`'; DROP …`, unicode, quotes in identifiers/feature names) assert the value is stored literally and no second statement executes.

**B3 · Caller-supplied revocation-seq (lines 95/104) breaks revocation monotonicity.**
For an online verifier, revocation sequence is a security property — a caller that can set/rewind seq can replay or effectively *un-revoke*, or collide two revocations.
*Fix:* Server-assign seq, monotonic, inside a transaction (`MAX(seq)+1` or a dedicated counter), with a UNIQUE constraint; never accept it from the caller.
*Tests:* caller-supplied seq is ignored/rejected; concurrent revokes yield strictly increasing, unique seq; replay of an old seq is a no-op.

---

## High

**H1 · `entitlement_events` is not an audit table (no actor/source/request_id/ip/prev_json/next_json).**
This is the one table that should answer "who disabled customer X, when, from where, and what changed." Today it can't. It's also a *migration-safety* item because 0001 is presumably already applied.
*Fix:* Additive `0002` migration adding those columns **nullable**; backfill historical rows with `actor='migration'`/`source='cli'`; write kernel populates them on every mutation (actor from B1's identity, request_id propagated from the Worker). Note the `event_type` CHECK currently forbids future types (`enable`, `note`, `auth_failure`) and editing a CHECK in SQLite/D1 requires a full table rebuild — decide now between widening it via rebuild or moving event_type validation to the app layer.
*Tests:* every mutation writes an event with all audit fields non-null; prev_json/next_json round-trip the before/after state; 0002 applies cleanly over a DB already at 0001 with existing rows.

**H2 · No committed, reviewable environment config; staging↔prod isolation unproven.**
`wrangler.example.toml` is a template and live config is gitignored (correct for secrets) — but there's no committed `[env.staging]`/`[env.production]` describing D1 bindings, routes, and *which* secrets must exist. An admin Worker that mutates entitlements must guarantee staging never points at prod D1, and that guarantee isn't visible anywhere.
*Fix:* Commit a sanitized `wrangler.toml` with `[env.*]` blocks (IDs can be placeholders/CI-injected), document required `wrangler secret put` names, and pull this "env scaffolding" *before* the mutations phase. Add a startup assertion that refuses to run prod bindings under a non-prod env name.
*Tests:* a config-lint/CI check that staging and production D1 database IDs differ and that all referenced secrets are declared.

**H3 · CI does not exercise the services tree — zero gating.**
`package.json` has the scripts; GitHub Actions don't run them. A broken migration, failing test, or lint error in the verifier/admin Worker merges green. "Operational readiness" is not met without this, and the C++ side already has a clang-format gate to mirror.
*Fix:* Add a workflow: `npm ci` → test → lint → `dry-run` → `wrangler d1 migrations apply --local` (ephemeral D1) → build the Vite app → `tsc --noEmit` (when TS lands). Make it required on `develop`.
*Tests:* the migration-apply-on-fresh-DB step *is* the test; add a smoke assertion on resulting schema.

---

## Medium

**M1 · Migration testing & forward-fix story absent.** D1 migrations are forward-only; the safety net is "every migration is additive + applied on a clean DB in CI" (H3) plus a documented forward-fix procedure for prod. *Fix:* add a clean-DB apply test (0001..N) and a `0002` that proves additive changes don't break existing rows; write a one-paragraph rollback/forward-fix runbook.

**M2 · Vite+React readiness blocked on an undefined API contract.** Before building React you need the read/mutation API surface: typed request/response, error model, list **pagination/filtering**, and the audit-feed shape. Type drift between Worker and SPA is the predictable failure. *Fix:* define the contract with a shared schema (e.g., zod) and generate TS types consumed by both Worker and React; specify the SPA auth flow (how the React app obtains/sends the admin token under B1), and CSRF posture for mutations. *Tests:* contract tests for pagination, not-found, and error shapes; a generated-types check in CI.

**M3 · Mutations need idempotency + concurrency safety.** upsert/revoke/disable must be idempotent and safe under two admins acting at once (ties to B3). *Fix:* idempotency keys and/or compare-and-set on a version/seq column. *Tests:* repeated identical mutation is a no-op beyond the first; concurrent disable doesn't double-write or interleave badly; UI double-click can't double-act.

**M4 · Observability & abuse controls unaddressed.** No structured logging, request_id propagation (ties to H1), metrics (revocations/min, auth failures), rate limiting, or runbook. The public verify endpoint *and* admin endpoints need rate limiting. *Fix:* structured JSON logs with request_id, basic counters, rate limits on admin + verify, and an incident runbook ("how to revoke now," "how to roll a key").

**M5 · Key-rotation design is sequenced too late.** The library embeds a public key and verifies signatures; rotation (dual-key/overlap verification window) must be *designed* before go-live even if implementation stays in the late "env/key ops" phase. *Fix:* pull the rotation design forward into protocol-hardening; document the overlap window and dual-key verify path.

---

## Low / DX

**L1 · Extract a shared, tested write-kernel module.** Today the upsert/revoke/disable logic lives in a CLI script; the Worker will re-implement it and drift. *Fix:* factor pure functions (build bound statement, compute next seq, build event row) into one module imported by both CLI and Worker. *Tests:* unit-test those pure functions directly.

**L2 · Local dev loop / seeding is undocumented.** *Fix:* document `wrangler d1 migrations apply --local`, seed fixtures, and a `npm run dev` that runs Worker + Vite with a proxy so the SPA hits the local Worker; add it to the service README.

**L3 · JS/TS quality parity with C++.** No `typescript-language-server` is even installed, and ESLint/Prettier (or Biome) coverage of `services/**` + the React app is unverified. *Fix:* add lint/format config covering the services tree and SPA, wire into H3's CI, and adopt TS with `tsc --noEmit` (or `checkJs` + JSDoc if staying JS) so the admin surface gets the same rigor the C++ side already has.

---

## Cross-cutting closeouts

**Migration safety:** treat 0001 as immutable/applied; all new schema goes in additive, nullable `0002+`; backfill historical `actor`/`source` so audit queries don't choke on NULL; avoid silent CHECK edits (they need a deliberate, tested table rebuild); make seq server-assigned + UNIQUE in the same migration that adds the audit columns.

**Sequencing tweak (otherwise the plan order is sound):** move **env scaffolding (H2)** and **auth design (B1)** to sit alongside the foundations/CI phase, *before* "admin mutations," so mutations are never exercised without isolation + auth; pull **key-rotation design (M5)** into protocol-hardening.

**Bottom line:** the phased plan is well-ordered and the additive-data-model instinct is right. Three things genuinely block the mutation surface — auth (B1), bound-parameter SQL (B2), server-assigned revocation seq (B3) — and three more are required for operational readiness — audit schema (H1), committed env isolation (H2), and CI that actually runs the services tree (H3). Everything below that is readiness polish for the Vite+React build rather than a gate.
