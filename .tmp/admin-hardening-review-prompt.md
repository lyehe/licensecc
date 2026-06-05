# licensecc Admin Hardening Review Prompt

You are an independent senior security and systems reviewer. Review the current
`licensecc` implementation changes in read-only mode. Do not edit files.

## Objective

Find correctness, security, operational, and test-coverage gaps in the
Cloudflare-based online licensing control plane, with special attention to the
latest admin hardening work:

- Cloudflare Access JWT validation and role enforcement.
- D1 mutation/audit atomicity using `env.DB.batch()`.
- Revocation sequence monotonicity and rollback resistance.
- Admin Worker separation from the public verifier and signing private key.
- Whether the remaining production gates are clearly documented and testable.

Prioritize release-blocking issues over style. Findings should be concrete,
file/line grounded, and actionable.

## Repository Context

Workspace root:

```text
C:\Users\HEQ\Projects\licensecc
```

The project now contains:

- C++ `licensecc` runtime with `acquire_license()` compatibility behavior.
- Extended `acquire_license_ex()` options for anti-tamper and online
  verification.
- A public Cloudflare verifier Worker under
  `services/cloudflare-online-verifier`.
- A private Cloudflare admin Worker and Vite + React UI under
  `services/cloudflare-license-admin`.
- D1 schema and migrations shared by verifier and admin services.

The intended security model is best-effort online revocation and auditability,
not tamper-proof protection on a fully controlled client machine.

## Primary Scope

Review these files first:

```text
services/cloudflare-license-admin/src/worker/index.ts
services/cloudflare-license-admin/test/admin-worker.test.mjs
services/cloudflare-license-admin/README.md
services/cloudflare-license-admin/package.json
services/cloudflare-license-admin/wrangler.example.jsonc
services/cloudflare-online-verifier/schema.sql
services/cloudflare-online-verifier/migrations/
services/cloudflare-online-verifier/scripts/entitlement.mjs
doc/analysis/license-admin-vite-react-execution-checklist.rst
.gitignore
.github/workflows/cloudflare-license-admin.yml
```

If needed, inspect related files:

```text
services/cloudflare-online-verifier/src/
services/cloudflare-online-verifier/test/
src/library/online_verification/
src/library/anti_tamper/
include/licensecc/
test/library/online_verification_test.cpp
test/library/anti_tamper_test.cpp
README.md
doc/analysis/security-model.rst
doc/usage/integration.rst
examples/online_callback/
```

## Latest Changes To Review Closely

The latest admin changes are intended to close two remaining gaps:

1. Access JWT coverage

   - Tests now generate real RS256 JWTs with `jose`.
   - Tests serve a local JWKS over `127.0.0.1`.
   - Tests cover:
     - valid admin Access JWT can read summary;
     - valid reader Access JWT can read but cannot mutate;
     - wrong audience is rejected;
     - expired token is rejected;
     - forged Access identity header without JWT is rejected.

2. D1 audit atomicity

   - Admin mutations now use `env.DB.batch()` when available.
   - Batch statement 1 writes the entitlement row and returns it.
   - Batch statement 2 inserts an audit event by selecting the just-written row
     from D1 and building `next_json` with SQLite `json_object(...)`.
   - Tests now simulate batch rollback and assert entitlement writes are rolled
     back if audit insertion fails.
   - A fallback path still exists if `env.DB.batch` is unavailable.

## Validation Evidence Already Collected

These commands were run locally after the latest admin hardening changes:

```text
cd services/cloudflare-license-admin
npm ci
npm test
npm run lint
npm run dry-run
npm run migrate:local
```

Observed evidence:

- `npm test` passed `14/14`.
- `npm run lint` passed.
- `npm run dry-run` passed with Wrangler `4.98.0`.
- `npm run migrate:local` passed.
- `python scripts/check_docs_links.py` passed from repo root.
- Generated `node_modules`, `dist`, `dist-worker`, and `.wrangler` were
  cleaned afterward.

Do not assume this evidence proves production correctness; treat it as input to
audit.

## Review Questions

Answer these directly.

### D1 Batch And Audit Atomicity

1. Does the Worker use `env.DB.batch()` correctly for Cloudflare D1?
2. Is it safe to rely on `RETURNING` rows being available in the first batch
   result?
3. Is `json_object(...)` in the audit insert compatible with D1/SQLite JSON
   support as used here?
4. Can any admin mutation update an entitlement without writing an audit event?
5. Does the fallback path without `env.DB.batch` create an unacceptable
   production risk, or is it only a defensive compatibility path?
6. Does the rollback test accurately model D1 batch transactional behavior, or
   is it too optimistic?
7. Is idempotency stored safely enough, or can response replay drift from audit
   state?

### Revocation Sequence And State Transitions

1. Is `revocation_seq` always server-owned?
2. Can a recreated row regress below historical event sequence?
3. Can concurrent mutations produce duplicate or skipped sequences in a way that
   matters?
4. Are terminal revoked-state rules consistently enforced across create, patch,
   disable, reenable, revoke, and CLI paths?
5. Does the CLI still bypass any important admin/API safety gate, and is that
   properly documented as break-glass?

### Cloudflare Access And Authz

1. Does the Worker cryptographically validate `Cf-Access-Jwt-Assertion` before
   trusting identity?
2. Are issuer, audience, expiry, signature, and JWKS source handled correctly?
3. Are admin and reader roles enforced consistently?
4. Can local dev bearer auth run outside development?
5. Are there missing tests for:
   - unknown email/role denial;
   - malformed JWT;
   - missing issuer/audience config;
   - JWKS rotation/cache behavior;
   - admin JWT mutation success?
6. Are any identity headers trusted without JWT verification?

### Worker Security And Cloudflare Practices

1. Does the admin Worker bind or expose the online assertion signing private key?
2. Are secrets kept out of source, Wrangler examples, docs, tests, and bundles?
3. Are request bodies size-bounded before JSON parsing?
4. Are prepared statements used for user-controlled values?
5. Are any request-scoped values stored in module-level mutable globals?
6. Are errors fail-closed and minimally revealing?
7. Are generated/local config artifacts ignored and cleaned appropriately?

### Public Verifier Boundary

1. Does the public verifier remain limited to public verification routes?
2. Is there any accidental admin route, admin secret, or write capability in the
   public verifier Worker?
3. Do denial responses avoid signing by default where intended?
4. Are rate limits sufficient for unknown/rotating fingerprint abuse at the
   expected low-user scale?

### C++ Online Verification And Anti-Tamper Integration

1. Does the C++ online verifier reject assertion rollback using process-local
   revocation floors?
2. Does it avoid trusting the offline project license key for online assertions?
3. Are online device hashes validated before use?
4. Does `acquire_license()` preserve old behavior while `acquire_license_ex()`
   opts into online/tamper behavior?
5. Do ordinary license failures avoid being masked by tamper or online checks?

### Documentation And Release Gates

1. Do README and docs avoid overclaiming anti-tamper or online verification?
2. Are cache/revocation latency limitations explicit?
3. Is Cloudflare Access staging E2E still correctly listed as a production gate?
4. Are validation commands and cleanup steps sufficient for contributors?
5. Are known residual risks described clearly enough for production operators?

## Required Output Format

Start with findings. Do not begin with a summary.

For each finding, use this format:

```text
[Severity] Title
File/line: path:line
Issue: concise description of the bug or risk.
Impact: what can go wrong in production or tests.
Recommendation: concrete fix or test.
Confidence: high|medium|low
```

Severity definitions:

- `Critical`: exploitable control-plane bypass, private-key exposure, or
  mutation/auth failure that can revoke/enable customers incorrectly.
- `High`: release blocker for production safety, audit integrity, or Access
  auth correctness.
- `Medium`: important correctness/test/documentation gap that should be fixed
  before broad rollout.
- `Low`: cleanup, clarity, or non-blocking hardening.

After findings, include:

```text
Open questions:
- ...

Missing tests:
- ...

Validation suggestions:
- exact commands or Cloudflare checks to run

Positive notes:
- only mention points that reduce risk materially

Overall recommendation:
- ship / do not ship / ship only after listed blockers
```

If no findings exist, say:

```text
No release-blocking findings found.
Residual risks:
- ...
Recommended additional validation:
- ...
```

## Constraints

- Do not edit files.
- Do not run destructive commands.
- Do not deploy or mutate the real Cloudflare account.
- Prefer primary Cloudflare docs for D1/Workers/Access assumptions if browsing
  is available.
- Treat tests as evidence, not proof.
- Avoid broad rewrites unless a current design creates a concrete risk.

## Optional CLI Invocation

Example with Claude CLI:

```powershell
claude -p --effort max --permission-mode dontAsk --allowedTools Read,Grep,Glob `
  (Get-Content .tmp/admin-hardening-review-prompt.md -Raw)
```

If the CLI has trouble with command-line prompt length, pipe the file:

```powershell
Get-Content .tmp/admin-hardening-review-prompt.md -Raw | claude -p --effort max --permission-mode dontAsk --allowedTools Read,Grep,Glob
```
