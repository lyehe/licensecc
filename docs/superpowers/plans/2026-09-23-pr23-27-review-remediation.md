# PR #23–#27 review remediation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Status: proposed; not executed.

**Goal:** Close every verified finding from the 2026-09-23 review of PRs #23–#27 (`6aecdec`..`6480049`) without widening scope.

**Architecture:** Five independent workstreams, each shippable as its own PR from `main`: (A) backend protected-device rate limiting, (B) portal password/email flow, (C) native Linux protected licensing, (D) backup, ops scripts and SDK loaders, (E) docs, example CI, UI cleanup and CHANGELOG. Each task stays inside the owning boundary named in `doc/architecture/change-guide.md` and `doc/architecture/ownership.md`. E's CHANGELOG task runs last because it records A–D.

**Tech Stack:** Cloudflare Workers + D1 (JS/TS, `node:test`, `node:sqlite`), React portal/admin UIs (Playwright), C++17 with CMake/CTest/Boost.Test, libcurl, OpenSSL TPM2 provider, .NET/Java/Python SDK bridges, GitHub Actions.

**Spec:** The review findings recorded in this session (four review lanes: native C++, portal auth, backend/SDK/backup, UI/examples/docs). The finding → task map below is the authoritative scope.

## Global Constraints

- Python work uses `uv run`; the PR gate needs Python 3.12 and uv 0.12.5 (`uv.toml`).
- PR gate from a clean or classified worktree: `npm ci` then `npm run check:pr`.
- Core C++ changes also require `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`.
- Linux-only native steps run on a Linux host (Ubuntu 24.04 via WSL2 or CI). The Windows dev host's clang LSP errors on these files are false positives; CTest is ground truth.
- Do not touch `extern/` submodules, local Wrangler configs, secrets or generated trees. Commit only `wrangler.example.*`.
- Keep this plan fixed while executing it. Record progress, commands and outcomes in `docs/implementation/2026-09-23-pr23-27-review-remediation.md`, following the task-packet convention in `CONTRIBUTING.md` (verified commit, exact commands, surfaces not run).
- Commit messages end with the session's attribution trailer. One branch per workstream: `fix/review-a-device-rate`, `fix/review-b-portal-password`, `fix/review-c-linux-native`, `fix/review-d-backup-ops-sdk`, `fix/review-e-docs-ui`.
- Contract baselines change only through `npm run write:contract-baselines`. Commit the regenerated `test/contracts/*.json` together with the code change that caused them.

## Review Focus

1. A customer row with `email = ''` whose address is now another customer's contact email: reset must stay generic (no mail, no takeover). Pinned in Task B1.
2. A host application that sets `SIGCHLD` to `SIG_IGN`: the browser launch must report `opened`, not `BROWSER_UNAVAILABLE`. Pinned in Task C2.
3. 700 session requests from one IP in a minute must not starve a second IP. Pinned in Task A1.
4. The email provider accepts the message but answers after the 2 s deadline: the emailed link must still redeem. Pinned in Task B2.
5. A consumer on Ubuntu 22.04 enabling device identity without TPM2 must configure without libcurl 7.85. Pinned in Task C4.

## Finding → task map

| # | Finding (review severity) | Task |
|---|---|---|
| 1 | One client exhausts global `/v2` budget (High) | A1 |
| 2 | Linux consent URL exposed via `/proc/*/cmdline` → cross-user binding (High) | C1 |
| 3 | `LCC_ENABLE_LINUX_DESKTOP` default ON breaks older-curl distros; ON without TPM2 fails at runtime (High) | C4 |
| 4 | Setup guide/portal README contradict #27 (High) | E1 |
| 5 | Legacy empty-email password accounts unrecoverable (High) | B1 |
| 6 | Account-existence timing oracle (Medium) | B2 |
| 7 | Verified limiter blocks idempotent recovery; flat customer cap (Medium) | A2 |
| 8 | Portal shows email actions when email is off (Medium) | B5 |
| 9 | Password `maxLength` 256 vs server 128; wrong error copy (Medium) | B5 |
| 10 | `examples/device_bound` not in CI; Linux docs incomplete (Medium) | E2 |
| 11 | Linux HTTPS parser untested; sanitizers skip device identity (Medium) | C5 |
| 12 | CHANGELOG lacks #23–#27 (Medium) | E4 |
| 13 | Browser launcher ECHILD/timeout false failure (Low) | C2 |
| 14 | Host fds leak into browser (Low) | C2 |
| 15 | Hard-coded `/usr/bin/xdg-open` (Low) | C2 |
| 16 | umask can break checkpoint files (Low) | C3 |
| 17 | Hard-link doc claim vs key-reference files (Low) | C3 |
| 18 | Backup poll budget, permanent-error retries, orphan dumps (Low) | D1 |
| 19 | Readiness script ignores env-scoped vars (Low) | D2 |
| 20 | .NET/Java Linux load errors (Low) | D3 |
| 21 | OpenAPI/contract drift for password routes (Low) | B4 |
| 22 | Email syntax accepts display-name/list forms (Low) | B3 |
| 23 | Timed-out send deletes a delivered link (Low) | B2 |
| 24 | Successful reset can end in 401 (Low) | B4 |
| 25 | Admin "Assign existing license" mislabel; forced-open `<details>`; dead code; stale copy; vacuous e2e (Low) | E3 |

**Decided: no change** (record in the implementation report):
- *Minute-boundary 503 in `bound_rate.mjs`.* The fail-closed behaviour is deliberate and pinned by the test "HTTP limiter fails closed if its batch straddles the minute boundary". It affects only requests that straddle a boundary, and clients treat 503 as retryable.
- *`portal_password_actions(email_lower)` index.* The table is pruned on every link request and stays small. The index would change the backup schema signature, the index map and PG parity for no measurable gain.
- *Both `BOUND_*` secrets in the inventory for every profile.* This is intentional and documented in #25.
- *Email flood tuning.* It matches the documented limits (1/60 s and 10/900 s per address). Revisit only with abuse evidence.
- *Worktree-reconciliation plan status line.* Protected plans are fixed during execution by convention.

---

## Workstream A — Backend protected-device rate limiting

Owner: `services/cloudflare-licensing-backend`. Tests: `npm --prefix services/cloudflare-licensing-backend run test:sql`.

### Task A1: Global budget counts only per-client-admitted traffic, plus an edge limiter for session routes

**Files:**
- Modify: `services/cloudflare-licensing-backend/src/device/bound_rate.mjs:1-41`
- Modify: `services/cloudflare-licensing-backend/wrangler.example.toml` (after the `VERIFY_RATE_LIMITER` block, line ~89)
- Modify: `services/cloudflare-licensing-backend/README.md` (protected-device rate-limit section)
- Test: `services/cloudflare-licensing-backend/test/sql/bound-device-http.test.mjs`

**Interfaces:**
- Produces: `limitBoundRequest(request, env, db)`. The signature is unchanged. New optional env: `BOUND_GLOBAL_RATE_LIMIT` (integer 100..1000000, default 1000). New optional binding: `BOUND_SESSION_RATE_LIMITER` (Cloudflare rate limiter).

- [ ] **Step 1: Write the failing tests** (append after the existing "HTTP limiter fails closed…" test)

```js
test("one source over its budget cannot consume the global protected budget", async t => {
  const f = fixture(t);
  const flood = new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":"192.0.2.50"}});
  let limited = 0;
  for (let i = 0; i < 700; i++) {
    try { await limitBoundRequest(flood, f.env, f.db); } catch (error) { if (/rate_limited/.test(String(error.code ?? error.message))) limited++; else throw error; }
  }
  assert.equal(limited, 100);
  assert.equal(f.sql.prepare("SELECT request_count n FROM rate_limit_counters WHERE namespace='device-v2-global'").get().n, 600);
  const other = new Request("https://backend.test/v2/device-leases/renew", {headers:{"cf-connecting-ip":"192.0.2.51"}});
  await limitBoundRequest(other, f.env, f.db);
});

test("global protected budget is configurable and still denies once exhausted", async t => {
  const f = fixture(t);
  f.env.BOUND_GLOBAL_RATE_LIMIT = "150";
  for (let i = 0; i < 150; i++) await limitBoundRequest(new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":`198.51.100.${i % 200}`}}), f.env, f.db);
  await assert.rejects(limitBoundRequest(new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":"203.0.113.9"}}), f.env, f.db), /rate_limited/);
  f.env.BOUND_GLOBAL_RATE_LIMIT = "7";
  await assert.rejects(limitBoundRequest(new Request("https://backend.test/v2/device-challenges", {headers:{"cf-connecting-ip":"203.0.113.10"}}), f.env, f.db), /rate_limited/);
});

test("session routes consult the edge limiter before any D1 write", async t => {
  const f = fixture(t);
  const keys = [];
  f.env.BOUND_SESSION_RATE_LIMITER = { async limit({ key }) { keys.push(key); return { success: false }; } };
  await assert.rejects(limitBoundRequest(new Request("https://backend.test/v2/device-leases/renew", {headers:{"cf-connecting-ip":"192.0.2.60"}}), f.env, f.db), /rate_limited/);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^device-v2-session:/);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters").get().n, 0);
});
```

Check how `BoundRequestError` exposes the code (`error.code` or message). Adjust the regex target in the first test to match, in the same style as the existing `assert.rejects(..., /rate_limited/)` calls.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm --prefix services/cloudflare-licensing-backend run test:sql -- --test-name-pattern "global protected budget|one source over|edge limiter"`
Expected: FAIL. The global count is 700, not 600. `BOUND_GLOBAL_RATE_LIMIT` is ignored. The edge limiter is never called.

- [ ] **Step 3: Rewrite `limitBoundRequest`**

Replace lines 4–41 of `bound_rate.mjs` (keep the imports and `limitBoundVerified`) with:

```js
const window = `(unixepoch()/60)*60`;
const values = `SELECT ?,?,${window},1,${window}+120,unixepoch()`;
const insert = `INSERT INTO rate_limit_counters(namespace,rate_key,window_start,request_count,expires_at,updated_at) `;
const conflict = `
  ON CONFLICT(namespace,rate_key,window_start) DO UPDATE SET request_count=min(request_count+1,10001),updated_at=unixepoch()
  RETURNING request_count,window_start`;
// A client row grows only while the global window is open, so rotating source
// identities cannot create rows once the fuse trips.
const globalOpen = ` WHERE NOT EXISTS(SELECT 1 FROM rate_limit_counters
  WHERE namespace='device-v2-global' AND rate_key='global' AND window_start=${window} AND request_count>=?)`;
// The global fuse counts only requests their own source budget admitted, so a
// single source cannot spend the whole protected budget.
const clientAdmitted = ` WHERE EXISTS(SELECT 1 FROM rate_limit_counters
  WHERE namespace=? AND rate_key=? AND window_start=${window} AND request_count<=?)`;
const observed = `SELECT ${window} AS window_start,
  (SELECT request_count FROM rate_limit_counters WHERE namespace='device-v2-global' AND rate_key='global' AND window_start=${window}) AS global_count`;

function globalLimit(env) {
  const value = Number(env.BOUND_GLOBAL_RATE_LIMIT ?? 1000);
  return Number.isSafeInteger(value) && value >= 100 && value <= 1000000 ? value : 1000;
}

// Fixed protected-protocol namespaces. Legacy rate/proof/account-token "off"
// switches never disable this gate. Registration has a tighter IP budget;
// challenge/issuance traffic shares a coarse NAT-tolerant abuse budget.
export async function limitBoundRequest(request, env, db) {
  const client = await boundSecretHash(request.headers.get("cf-connecting-ip") || "unknown-client");
  const registration = new URL(request.url).pathname === "/v2/device-authorizations";
  const edge = registration ? env.VERIFY_RATE_LIMITER : env.BOUND_SESSION_RATE_LIMITER;
  if (edge) {
    const decision = await edge.limit({ key: `${registration ? "device-v2" : "device-v2-session"}:${client}` });
    if (decision.success !== true) throw new BoundRequestError("rate_limited", 429);
  }
  if (!db.batch) throw new BoundRequestError("temporarily_unavailable", 503);
  const namespace = registration ? "device-v2-registration" : "device-v2-client";
  const clientLimit = registration ? 20 : 600, fuse = globalLimit(env);
  const result = await db.batch([
    db.prepare(insert + values + globalOpen + conflict).bind(namespace, client, fuse),
    db.prepare(insert + values + clientAdmitted + conflict).bind("device-v2-global", "global", namespace, client, clientLimit),
    db.prepare(observed),
  ]);
  const own = result[0]?.results?.[0], view = result[2]?.results?.[0];
  if (!view || !Number.isSafeInteger(view.window_start)) throw new BoundRequestError("temporarily_unavailable", 503);
  if (!own) throw new BoundRequestError("rate_limited", 429);
  if (!Number.isSafeInteger(own.request_count) || own.window_start !== view.window_start) {
    throw new BoundRequestError("temporarily_unavailable", 503);
  }
  if (own.request_count > clientLimit) throw new BoundRequestError("rate_limited", 429);
  if (!Number.isSafeInteger(view.global_count) || view.global_count > fuse) throw new BoundRequestError("rate_limited", 429);
  if (view.global_count === 1) {
    await db.prepare(`DELETE FROM rate_limit_counters WHERE rowid IN
      (SELECT rowid FROM rate_limit_counters WHERE namespace IN ('device-v2-global','device-v2-client','device-v2-registration','device-v2-device','device-v2-customer')
        AND expires_at<=unixepoch() ORDER BY expires_at LIMIT 6002)`).run();
  }
}
```

Keep `limitBoundVerified` using `values`, `insert` and `conflict` as before (its `" WHERE 1"` form still works).

- [ ] **Step 4: Update the straddle test to the new statement order**

In "HTTP limiter fails closed if its batch straddles the minute boundary", the injected batch executes `statements[0]` (now the client row) before advancing the clock. Change its mock to run all three statements: run `statements[0]`, advance the clock to 1020, then run `statements[1]` and `statements[2]`, and return all three results. Replace the client-row count assertion with:

```js
  assert.ok(f.sql.prepare("SELECT count(*) n FROM rate_limit_counters WHERE namespace IN ('device-v2-client','device-v2-registration')").get().n <= 1);
```

Keep the `503` and the following `400` assertions. The fail-closed property (a straddled batch is never admitted) is unchanged.

- [ ] **Step 5: Add the edge limiter to the example config**

Append after the `VERIFY_RATE_LIMITER` block in `wrangler.example.toml`:

```toml
# Per-source edge limit for /v2 challenge, exchange and renew traffic. Rejects
# floods before any D1 write. Keep >= the D1 per-client budget (600/min).
[[ratelimits]]
name = "BOUND_SESSION_RATE_LIMITER"
namespace_id = "1002"
simple = { limit = 600, period = 60 }
```

Add `# BOUND_GLOBAL_RATE_LIMIT = "1000"` with a one-line comment next to the other commented D1 limiter overrides (lines 61–68).

- [ ] **Step 6: Run the full SQL suite and typecheck**

Run: `npm --prefix services/cloudflare-licensing-backend run test:sql && npm --prefix services/cloudflare-licensing-backend run typecheck`
Expected: PASS. This covers "HTTP global denial cannot grow per-client rows…" (the first statement is skipped while the fuse is closed) and "session traffic behind one NAT…".

- [ ] **Step 7: Document and commit**

In the backend README's protected-device limits paragraph, state that:
- the global fuse (default 1000/min, `BOUND_GLOBAL_RATE_LIMIT`) counts only requests admitted by their per-source budget;
- `BOUND_SESSION_RATE_LIMITER` rejects floods at the edge;
- operators should add a WAF rate rule for distributed floods.

```bash
git add services/cloudflare-licensing-backend/src/device/bound_rate.mjs services/cloudflare-licensing-backend/test/sql/bound-device-http.test.mjs services/cloudflare-licensing-backend/wrangler.example.toml services/cloudflare-licensing-backend/README.md
git commit -m "fix(backend): stop one source from exhausting the protected-device budget"
```

### Task A2: Idempotent recovery bypasses the verified limiter; customer cap scales with the entitlement

**Files:**
- Modify: `services/cloudflare-licensing-backend/src/device/bound_issue.mjs:125,138`
- Modify: `services/cloudflare-licensing-backend/src/device/bound_rate.mjs` (`limitBoundVerified`)
- Test: `services/cloudflare-licensing-backend/test/sql/bound-device-http.test.mjs`

**Interfaces:**
- Produces: `limitBoundVerified(db, keyId, customerId, customerLimit = 240)`.

- [ ] **Step 1: Write the failing tests**

```js
test("recovering a committed exchange is not blocked by an exhausted device budget", async t => {
  const f = fixture(t), d = await enrollment(f);
  const activated = await f.call("/v2/device-authorizations/exchange", await signed(f, d, "exchange"));
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  f.sql.prepare("INSERT INTO rate_limit_counters VALUES('device-v2-device',?,960,61,1080,1000) ON CONFLICT(namespace,rate_key,window_start) DO UPDATE SET request_count=61").run(d.keyId);
  const recovered = await f.call("/v2/device-authorizations/exchange", await signed(f, d, "exchange"));
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.deepEqual(recovered.body, activated.body);
});

test("customer verified budget scales with the entitlement device limit", async t => {
  const f = fixture(t);
  const key = i => "sha256:" + i.toString(16).padStart(64, "0");
  for (let i = 0; i < 250; i++) await limitBoundVerified(f.db, key(i), "fleet", 500);
  for (let i = 0; i < 240; i++) await limitBoundVerified(f.db, key(1000 + i), "small");
  await assert.rejects(limitBoundVerified(f.db, key(2000), "small"), /rate_limited/);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm --prefix services/cloudflare-licensing-backend run test:sql -- --test-name-pattern "recovering a committed|scales with the entitlement"`
Expected: the recovery test FAILS with 429. The scaling test FAILS at call 241 for "fleet".

- [ ] **Step 3: Implement**

In `bound_rate.mjs`, change the signature and the cap:

```js
export async function limitBoundVerified(db, keyId, customerId, customerLimit = 240) {
```

In the final check, replace `account.request_count > 240` with `account.request_count > customerLimit`.

In `bound_issue.mjs`, delete line 125 (`await limitBoundVerified(db, a.key_id, e.customer_id);`). Insert it directly after the `if (operation) return (await recoverBoundDeviceLease(db, candidate)).response;` line:

```js
  // Replaying a committed operation returns the stored lease; never rate-limit reconciliation.
  await limitBoundVerified(db, a.key_id, e.customer_id, Math.max(240, 2 * (e.max_active_devices ?? 0)));
```

Confirm `e.max_active_devices` is present on the snapshot entitlement (it is read as `entitlement.max_active_devices` at `bound_issue.mjs:78`). If the snapshot SELECT omits it, add the column to that SELECT.

- [ ] **Step 4: Run the full suite**

Run: `npm --prefix services/cloudflare-licensing-backend run test:sql`
Expected: PASS, including "invalid possession proofs cannot consume verified customer budgets".

- [ ] **Step 5: Update the README limits paragraph and commit**

The customer cap is now max(240, 2 × `max_active_devices`)/min, and reconciling a committed operation is not rate-limited.

```bash
git add services/cloudflare-licensing-backend/src/device/bound_issue.mjs services/cloudflare-licensing-backend/src/device/bound_rate.mjs services/cloudflare-licensing-backend/test/sql/bound-device-http.test.mjs services/cloudflare-licensing-backend/README.md
git commit -m "fix(backend): never rate-limit protected-lease recovery; scale customer budget"
```

- [ ] **Step 6: Workstream A gate**

Run: `npm run check:pr`. Open PR A. Name the verified commit and the commands in the implementation report.

---

## Workstream B — Portal password and email flow

Owner: `services/cloudflare-customer-portal` (Worker + UI) and `packages/cloudflare-runtime` (shared `loginEmail`). Tests: `npm --prefix services/cloudflare-customer-portal test`, `test:ui`, `test:openapi` and `test:e2e`.

### Task B1: Legacy empty-email password accounts recover through a verified reset

**Files:**
- Modify: `services/cloudflare-customer-portal/src/worker/routes/password-email.ts:26` (credential lookup) and `:64-71` (reset completion)
- Test: `services/cloudflare-customer-portal/test/portal-worker-password-email.test.mjs`

**Interfaces:** none. The route contract is unchanged.

- [ ] **Step 1: Write the failing tests**

```js
async function legacy(env, email) {
  env.DB.prepare("INSERT INTO customers (id,name,email,created_at,updated_at) VALUES ('L','Personal account','',?,?)").bind(NOW, NOW).run();
  await env.DB.prepare("INSERT INTO portal_passwords (customer_id,email_lower,password_hash,created_at,updated_at) VALUES ('L',?,?,?,?)").bind(email, await hashPassword(PASSWORD), NOW, NOW).run();
}

test("pre-verification password accounts recover and adopt the proven email", async t => {
  const f = fixture(t);
  await legacy(f.env, "legacy@example.com");
  assert.equal((await f.request("reset", "legacy@example.com")).status, 202);
  assert.equal(f.mail.length, 1);
  const result = await f.complete(undefined, NEXT);
  assert.equal(result.status, 200);
  assert.equal(result.body.data.customer_id, "L");
  assert.equal(f.db.prepare("SELECT email FROM customers WHERE id = 'L'").get().email, "legacy@example.com");
  assert.equal((await call(f.env, "POST", `${PATH}/login`, { body: { email: "legacy@example.com", password: NEXT } })).status, 200);
});

test("legacy reset stays generic when another customer owns the address", async t => {
  const f = fixture(t);
  await legacy(f.env, "a@x.com");
  assert.equal((await f.request("reset", "a@x.com")).status, 202);
  assert.equal(f.mail.length, 0);
  assert.equal(f.db.prepare("SELECT email FROM customers WHERE id = 'L'").get().email, "");
});
```

`a@x.com` is customer `A`'s contact email in `baseFixture` (the existing "existing, missing, disabled…" test relies on it).

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm --prefix services/cloudflare-customer-portal test -- --test-name-pattern "pre-verification|legacy reset"`
Expected: the first test FAILS because `mail.length` is 0. The second passes already; it guards the fix.

- [ ] **Step 3: Implement**

Replace the credential query at line 26 with:

```ts
  // Verified contact addresses recover credentials. Accounts created before email
  // verification (empty contact) may recover once, if no other customer owns it.
  const credential = await db.prepare(`SELECT p.customer_id, p.password_hash FROM portal_passwords p JOIN customers c ON c.id = p.customer_id
    WHERE p.email_lower = ? AND c.status = 'active'
      AND (lower(c.email) = p.email_lower OR (c.email = '' AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = p.email_lower)))`)
    .bind(email).first<{ customer_id: string; password_hash: string }>();
```

In `complete()`, replace the reset `UPDATE portal_passwords …` statement and the `writeIndex` line with:

```ts
    statements.push(env.DB.prepare(`UPDATE portal_passwords SET password_hash = ?, updated_at = ? WHERE customer_id = ? AND email_lower = ? AND password_hash = ? AND ${claimed} AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND status = 'active' AND (lower(email) = ? OR (email = '' AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = ?)))) RETURNING customer_id`)
      .bind(passwordHash, now, id, email, action.credential_hash, tokenHash, claim, id, email, email));
  }
  const writeIndex = statements.length - 1;
  if (action.purpose === "reset") {
    // Redeeming the emailed link proves the mailbox; record it as the contact address.
    statements.push(env.DB.prepare(`UPDATE customers SET email = ?, updated_at = ? WHERE id = ? AND email = '' AND EXISTS (SELECT 1 FROM portal_passwords WHERE customer_id = ? AND password_hash = ?) AND NOT EXISTS (SELECT 1 FROM customers o WHERE lower(o.email) = ?)`)
      .bind(email, now, id, id, passwordHash, email));
  }
```

Remove the now-duplicated closing brace and `const writeIndex` line that followed the old `else` block. `writeIndex` must still point at the credential write.

- [ ] **Step 4: Run the password suites**

Run: `npm --prefix services/cloudflare-customer-portal test`
Expected: PASS, including "expiry, password change, disabling and account creation invalidate outstanding proofs".

- [ ] **Step 5: Commit**

```bash
git add services/cloudflare-customer-portal/src/worker/routes/password-email.ts services/cloudflare-customer-portal/test/portal-worker-password-email.test.mjs
git commit -m "fix(portal): let pre-verification password accounts recover via verified reset"
```

### Task B2: Uniform link-request timing; indeterminate sends keep the link

**Files:**
- Modify: `services/cloudflare-customer-portal/src/worker/routes/password-email.ts` (`requestLink`, dispatch)
- Modify: `services/cloudflare-customer-portal/src/auth/portal_email.mjs` (catch branch, doc comment)
- Modify: `services/cloudflare-customer-portal/test/portal-worker-fixtures.mjs:77` (`call` accepts `ctx`)
- Modify: `services/cloudflare-customer-portal/test/portal-worker-public.test.mjs:402`
- Test: `services/cloudflare-customer-portal/test/portal-worker-password-email.test.mjs`

**Interfaces:**
- Produces: `sendEmail(...)` may now return `{ ok:false, code:"email_send_indeterminate" }` for an abort or network throw. OTP callers check only `ok` and are unaffected.
- Produces: the test helper `call(env, method, path, { cookie, body, headers, ctx })`.

- [ ] **Step 1: Let tests supply a context**

In `portal-worker-fixtures.mjs`, change the `call` signature to `{ cookie, body, headers, ctx = CTX } = {}` and pass `ctx` to `worker.fetch(req, env, ctx)`.

In the password-email test `fixture(t)`, add a collecting context and make `request` settle it:

```js
  const pending = [];
  const ctx = { waitUntil: p => { pending.push(Promise.resolve(p)); } };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const request = async (purpose, email = "new@example.com", env = data.env) => {
    const result = await call(env, "POST", `${PATH}/${purpose}`, { body: { email }, ctx });
    await settle();
    return result;
  };
```

Return `ctx` and `settle` from the fixture as well.

- [ ] **Step 2: Write the failing tests**

```js
test("link requests answer before any account lookup or delivery", async t => {
  const f = fixture(t);
  await credential(f.env);
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => { await gate; f.mail.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); });
  const response = await call(f.env, "POST", `${PATH}/reset`, { body: { email: "a@x.com" }, ctx: f.ctx });
  assert.equal(response.status, 202);
  assert.equal(f.mail.length, 0);
  release(); await f.settle();
  assert.equal(f.mail.length, 1);
});

test("a provider timeout keeps the emailed link redeemable", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async (_url, init) => { f.mail.push(JSON.parse(init.body)); throw new DOMException("aborted", "AbortError"); });
  assert.equal((await f.request("register", "slow@example.com")).status, 202);
  assert.equal(f.db.prepare("SELECT count(*) n FROM portal_password_actions WHERE email_lower = 'slow@example.com'").get().n, 1);
  assert.equal((await f.complete()).status, 200);
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `npm --prefix services/cloudflare-customer-portal test -- --test-name-pattern "answer before|provider timeout"`
Expected: FAIL. The response waits for mail, and the action row is deleted after the abort.

- [ ] **Step 4: Implement**

In `portal_email.mjs`, change the `catch` branch to `return { ok: false, code: "email_send_indeterminate" };`. Add to the JSDoc list: `{ ok:false, code:"email_send_indeterminate" } on timeout or network throw (the provider may have accepted it)`. Update `portal-worker-public.test.mjs:402` to expect `{ ok: false, code: "email_send_indeterminate" }`.

In `password-email.ts`, split `requestLink`:

```ts
async function requestLink(request: Request, env: Env, ctx: ExecutionContext, reqId: string, now: number, purpose: Action["purpose"]): Promise<Response> {
  const denied = gate(request, env, reqId);
  if (denied) return denied;
  const body = await readJson(request, reqId);
  if (body instanceof Response) return body;
  const email = loginEmail(body.email);
  if (!email) return envelope(reqId, "invalid_email", undefined, 400, HEADERS);
  if (!env.PORTAL_EMAIL_API_KEY || !env.PORTAL_EMAIL_FROM || !emailApiOrigin(env)) return envelope(reqId, "email_unconfigured", undefined, 503, HEADERS);
  if (await throttle(request, env, email, purpose, now) || (await portalRateLimit(env, `password:mail:${await digest(email)}`, 1, 60, now)).limited) {
    return envelope(reqId, "rate_limited", undefined, 429, HEADERS);
  }
  // Eligibility, proof storage and delivery run after the response so every
  // address gets the same 202 with the same latency.
  ctx.waitUntil(issueLink(env, email, now, purpose));
  return envelope(reqId, "verification_requested", undefined, 202, HEADERS);
}

async function issueLink(env: Env, email: string, now: number, purpose: Action["purpose"]): Promise<void> {
  try {
    const db = primary(env);
    // (move the credential/existing lookups, eligibility check, token creation,
    // DELETE of expired rows, INSERT, link and sendEmail call here unchanged,
    // replacing each `return accepted();` with `return;`)
    if (!sent.ok && sent.code !== "email_send_indeterminate") {
      await db.prepare("DELETE FROM portal_password_actions WHERE token_hash = ? AND consumed_at IS NULL").bind(tokenHash).run();
    }
  } catch {
    // Background delivery never surfaces account state; the proof simply expires.
  }
}
```

The parenthetical is a move instruction, not new code. Cut lines 23–39 of the current file into `issueLink` verbatim (after applying B1's query), then apply only the two stated edits. Use the `ExecutionContext` type that `TopRoute` already uses in `../env.js`. Update the dispatch entries to pass `ctx`:

```ts
  "POST /portal/v1/auth/password/register": (request, env, ctx, reqId, now) => requestLink(request, env, ctx, reqId, now, "register"),
  "POST /portal/v1/auth/password/reset": (request, env, ctx, reqId, now) => requestLink(request, env, ctx, reqId, now, "reset"),
```

Update the file header comment in `portal_email.mjs` ("password verification waits for this result…") to say that password links also send in `ctx.waitUntil()` and remove the proof only on a definite rejection.

- [ ] **Step 5: Run the suites**

Run: `npm --prefix services/cloudflare-customer-portal test`
Expected: PASS. The existing "mail cooldown…delivery failure" test still sees the 503-provider row deleted, because that is a definite failure.

- [ ] **Step 6: Commit**

```bash
git add services/cloudflare-customer-portal/src services/cloudflare-customer-portal/test
git commit -m "fix(portal): send password links after responding; keep links on indeterminate sends"
```

### Task B3: Reject display-name, list and quoted email forms

**Files:**
- Modify: `packages/cloudflare-runtime/src/auth/password.mjs:9-14`
- Test: the `packages/cloudflare-runtime` test file that covers `loginEmail`. Find it with `rg -n "loginEmail" packages/cloudflare-runtime/test`; if there is none, create `packages/cloudflare-runtime/test/login-email.test.mjs`.

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loginEmail } from "../src/auth/password.mjs";

test("login emails accept plain addresses and reject header/list syntax", () => {
  assert.equal(loginEmail(" Alice.B+tag@Example.co.uk "), "alice.b+tag@example.co.uk");
  for (const value of ['"x"<attacker@evil.com>', "a,b@x.com", "a;b@x.com", "a@x.com>", "<a@x.com", "a(b)@x.com", "a:b@x.com", "a\\b@x.com", "a[b]@x.com", "a\u0000b@x.com", "a@x\u007f.com"]) {
    assert.equal(loginEmail(value), null, value);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test packages/cloudflare-runtime/test/login-email.test.mjs`
Expected: FAIL on the display-name and list forms.

- [ ] **Step 3: Implement**

```js
// addr-spec only: header/list/quoting punctuation and controls never reach the mail API.
const EMAIL = /^[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+@[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+\.[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+$/;
export function loginEmail(value) {
    if (typeof value !== "string")
        return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && EMAIL.test(email) ? email : null;
}
```

- [ ] **Step 4: Run the runtime and portal suites**

Run: `node --test packages/cloudflare-runtime/test/login-email.test.mjs && npm --prefix services/cloudflare-customer-portal test`
Expected: PASS.

- [ ] **Step 5: Check stored data**

In the implementation report, record the result of running `SELECT count(*) FROM portal_passwords WHERE email_lower GLOB '*[<>(),;:"\\[]*'` against staging D1 (read-only). A non-zero count means those accounts can no longer sign in by password. Report it; do not migrate.

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-runtime/src/auth/password.mjs packages/cloudflare-runtime/test/login-email.test.mjs
git commit -m "fix(runtime): accept only addr-spec login emails"
```

### Task B4: A completed reset never answers 401; password OpenAPI matches the routes

**Files:**
- Modify: `services/cloudflare-customer-portal/src/worker/routes/password-email.ts` (end of `complete`)
- Modify: `services/cloudflare-customer-portal/src/worker/openapi/paths/password.ts`
- Modify: `services/cloudflare-customer-portal/src/ui/features/auth/passwordMessages.ts:8` (drop `registration_unavailable`)
- Regenerate: `test/contracts/portal.json`
- Test: `services/cloudflare-customer-portal/test/portal-worker-password-email.test.mjs`

**Interfaces:**
- Produces: new success envelope `password_updated` with data `{ sign_in_required: true }` and status 200 from `/complete`. B5 consumes it.

- [ ] **Step 1: Write the failing test**

```js
test("a committed reset reports success even when the new session cannot be minted", async t => {
  const f = fixture(t);
  await credential(f.env);
  await f.request("reset", "a@x.com");
  f.db.exec("CREATE TRIGGER no_sessions BEFORE INSERT ON portal_sessions BEGIN SELECT RAISE(ABORT, 'test'); END");
  const result = await f.complete(undefined, NEXT);
  assert.equal(result.status, 200);
  assert.equal(result.body.code, "password_updated");
  assert.equal(result.body.data.sign_in_required, true);
  f.db.exec("DROP TRIGGER no_sessions");
  assert.equal((await call(f.env, "POST", `${PATH}/login`, { body: { email: "a@x.com", password: NEXT } })).status, 200);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix services/cloudflare-customer-portal test -- --test-name-pattern "committed reset reports success"`
Expected: FAIL with 401 `invalid_credentials`, or a 500 if `mintSession` throws.

- [ ] **Step 3: Implement**

Replace the last line of `complete()`:

```ts
  let session: Response | null = null;
  try { session = await signedIn(request, env, reqId, id, passwordHash, now); } catch { session = null; }
  // The credential write is committed; never report it as a failed sign-in.
  return session?.status === 200 ? session : envelope(reqId, "password_updated", { sign_in_required: true }, 200, HEADERS);
```

- [ ] **Step 4: Split the OpenAPI responses by route**

In `openapi/paths/password.ts`, replace the shared `responses` spread for `/complete` and `/login` with explicit maps:

```ts
const common = {
  "403": errorResponse("Origin mismatch.", "cross_site_forbidden"),
  "404": errorResponse("Password sign-in disabled.", "not_found"),
  "413": errorResponse("Request body exceeds 8192 bytes.", "body_too_large"),
  "429": errorResponse("Per-IP or login-identifier limit reached.", "rate_limited"),
  "503": errorResponse("Session/database configuration unavailable.", "config_error"),
};
const accepted = { description: "Generic verification_requested envelope, including ineligible addresses and delivery failures. No session or account is created.",
  content: { "application/json": { schema: { type: "object", required: ["ok", "code"], properties: { ok: { type: "boolean", const: true }, code: { type: "string", const: "verification_requested" } } } } } };
```

Wire them up as follows:
- **register/reset:** 202 uses `accepted`.
- **`/complete`:** `{ "200": { description: "Signed in with a rotated session cookie (code signed_in), or password_updated with sign_in_required when the credential changed but no session could be issued." }, "400": <existing complete 400>, ...common }`.
- **`/login`:** `{ "200": responses["200"], "400": errorResponse("Invalid JSON.", "invalid_json"), "401": errorResponse("Invalid credentials.", "invalid_credentials"), ...common }`.
- **Settings `GET`/`POST`:** keep `responses`, and remove `registration_unavailable` from its 409 list (keep `password_change_conflict`).

Before finalising, cross-check every `envelope(reqId, "<code>"` literal in `routes/password.ts` and `routes/password-email.ts` against these maps.

- [ ] **Step 5: Remove the dead UI message, regenerate contracts and run the tests**

Delete line 8 (`registration_unavailable`) from `passwordMessages.ts`.

Run: `npm run write:contract-baselines && npm --prefix services/cloudflare-customer-portal run test:openapi && npm --prefix services/cloudflare-customer-portal test && npm run test:contracts`
Expected: PASS. `git diff test/contracts/portal.json` shows only the password operations changing.

- [ ] **Step 6: Commit**

```bash
git add services/cloudflare-customer-portal/src services/cloudflare-customer-portal/test test/contracts/portal.json
git commit -m "fix(portal): report committed resets as success; align password OpenAPI"
```

### Task B5: Portal UI hides email actions without a sender, matches the server length and handles `password_updated`

**Files:**
- Modify: `services/cloudflare-customer-portal/src/worker/routes/oauth.ts:95` (`providers.email` also requires `emailApiOrigin(env)`)
- Modify: `services/cloudflare-customer-portal/src/ui/features/auth/AuthFeature.tsx:196`
- Modify: `services/cloudflare-customer-portal/src/ui/features/auth/PasswordSignIn.tsx`
- Modify: `services/cloudflare-customer-portal/src/ui/features/auth/PasswordAction.tsx`
- Modify: `services/cloudflare-customer-portal/src/ui/features/auth/passwordMessages.ts`
- Modify: the account `PasswordSettings.tsx` (`rg -l PasswordSettings services/cloudflare-customer-portal/src/ui`), line ~41
- Test: `services/cloudflare-customer-portal/test/portal-ui.e2e.mjs`, `test/portal-worker-oauth.test.mjs` (or whichever test asserts the providers envelope; find it with `rg -n "auth_providers" services/cloudflare-customer-portal/test`)

- [ ] **Step 1: Write the failing tests**

In the providers test, add a case: with `PORTAL_EMAIL_API_KEY` and `PORTAL_EMAIL_FROM` set but `PORTAL_EMAIL_API_BASE: "http://insecure.test"`, expect `body.data.email === false`.

In `portal-ui.e2e.mjs`, add:

```js
test("password sign-in hides email-only actions when email delivery is off", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/providers", route => route.fulfill({ json: makeEnvelope("auth_providers", { google: false, github: false, password: true, email: false }) }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create an account", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Forgot your password?" })).toHaveCount(0);
});

test("password completion enforces the server length and explains a sign-in-required success", async ({ page }) => {
  await page.route("**/api/portal/me", route => route.fulfill({ status: 401, json: { ok: false, code: "unauthorized" } }));
  await page.route("**/portal/v1/auth/password/complete", route => route.fulfill({ json: makeEnvelope("password_updated", { sign_in_required: true }) }));
  await page.goto("/password-action#token=" + "A".repeat(43));
  await expect(page.getByLabel("New password")).toHaveAttribute("maxlength", "128");
  await page.getByLabel("New password").fill("A long testing passphrase 1!");
  await page.getByLabel("Confirm password").fill("A long testing passphrase 1!");
  await page.getByRole("button", { name: "Save password and sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Password saved. Sign in with your new password.");
});
```

Use the same `makeEnvelope` helper and provider-route pattern the file already uses. If the existing tests stub providers with a different URL glob, copy theirs.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm --prefix services/cloudflare-customer-portal run test:e2e -- -g "email-only actions|server length"` plus the providers unit test.
Expected: FAIL.

- [ ] **Step 3: Implement**

`oauth.ts:95` becomes `email: Boolean(env.PORTAL_EMAIL_API_KEY && env.PORTAL_EMAIL_FROM && emailApiOrigin(env)),`. Import `emailApiOrigin` from `../../auth/portal_destination.mjs`.

`AuthFeature.tsx:196` passes `emailLinks={Boolean(providers.email)}` to `PasswordSignIn`.

In `PasswordSignIn.tsx`:
- Add `emailLinks` to the props type (`emailLinks: boolean`).
- Render the "Create an account"/"Back to sign in" toggle only when `emailLinks || mode !== "login"`.
- Render "Forgot your password?" only when `mode === "login" && emailLinks`.
- Change the login password `maxLength={256}` to `maxLength={128}`.

In `PasswordAction.tsx`:
- Set both inputs to `maxLength={128}`, and add `minLength={15}` to the confirmation input.
- On `result.ok`, if `result.code === "password_updated"`, call `setFinished(true); setMessage("Password saved. Sign in with your new password.");` and skip `onDone()`. Otherwise keep `setFinished(true); await onDone();`.
- On failure, map `invalid_registration` to `"Choose a password of 15–128 characters."` on this page. Add a `passwordActionMessage(code)` wrapper in `passwordMessages.ts` that overrides only that code.

Set the settings password inputs to `maxLength={128}` and `minLength={15}` (new password only).

- [ ] **Step 4: Run the UI suites**

Run: `npm --prefix services/cloudflare-customer-portal run test:ui && npm --prefix services/cloudflare-customer-portal run test:e2e && npm --prefix services/cloudflare-customer-portal test`
Expected: PASS. Existing e2e flows that click "Create an account" stub providers with `email: true`; if one does not, add `email: true` to its stub.

- [ ] **Step 5: Commit and gate**

```bash
git add services/cloudflare-customer-portal/src services/cloudflare-customer-portal/test
git commit -m "fix(portal-ui): gate email actions on delivery, match server password length"
```

Run `npm run check:pr`. Open PR B.

---

## Workstream C — Native Linux protected licensing

Owner: `src/library/device_identity/` (library), `test/library/device_identity/`, root/`src` CMake, `.github/workflows/native-security.yml`. Run all steps on Linux.

Configure/test commands used below:
- `cmake --preset ci-linux-device-identity-test && cmake --build --preset ci-linux-device-identity-test`
- `ctest --preset ci-linux-device-identity-test --no-tests=error -R device_bound_linux_test --output-on-failure`

### Task C1: Loopback callbacks accepted only from the same local user

**Files:**
- Create: `src/library/device_identity/bound_peer_linux.hpp`
- Create: `src/library/device_identity/bound_peer_linux.cpp`
- Modify: `src/library/device_identity/CMakeLists.txt:31-32` (add `bound_peer_linux.cpp` to the Linux desktop list)
- Modify: `src/library/device_identity/bound_loopback_linux.cpp:195-206` (accept path)
- Modify: `doc/api/device_identity.rst` (Linux requirements, near line 385)
- Test: `test/library/device_identity/device_bound_linux_test.cpp`

**Interfaces:**
- Produces: `bool license::device_identity::bound_loopback_peer_owned(const char* table, const sockaddr_storage& peer, const sockaddr_storage& local, uid_t owner) noexcept;`

- [ ] **Step 1: Write the failing tests** (add `#include "bound_peer_linux.hpp"`, `<arpa/inet.h>` and `<cstdio>` to the test)

```cpp
namespace {
sockaddr_storage ipv4(const char* text, unsigned short port) {
	sockaddr_storage value{};
	auto& address = reinterpret_cast<sockaddr_in&>(value);
	address.sin_family = AF_INET;
	address.sin_port = htons(port);
	BOOST_REQUIRE(inet_pton(AF_INET, text, &address.sin_addr) == 1);
	return value;
}
sockaddr_storage ipv6(const char* text, unsigned short port) {
	sockaddr_storage value{};
	auto& address = reinterpret_cast<sockaddr_in6&>(value);
	address.sin6_family = AF_INET6;
	address.sin6_port = htons(port);
	BOOST_REQUIRE(inet_pton(AF_INET6, text, &address.sin6_addr) == 1);
	return value;
}
// Format exactly like the kernel: raw 32-bit words printed as native integers.
std::string endpoint(const sockaddr_storage& value) {
	char text[64];
	if (value.ss_family == AF_INET) {
		const auto& a = reinterpret_cast<const sockaddr_in&>(value);
		std::snprintf(text, sizeof(text), "%08X:%04X", a.sin_addr.s_addr, ntohs(a.sin_port));
	} else {
		const auto& a = reinterpret_cast<const sockaddr_in6&>(value);
		std::uint32_t w[4];
		std::memcpy(w, &a.sin6_addr, sizeof(w));
		std::snprintf(text, sizeof(text), "%08X%08X%08X%08X:%04X", w[0], w[1], w[2], w[3], ntohs(a.sin6_port));
	}
	return text;
}
std::string table(const Directory& root, const std::string& rows) {
	const auto path = root.path + "/tcp";
	std::ofstream(path) << "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" << rows;
	return path;
}
std::string row(const sockaddr_storage& local, const sockaddr_storage& remote, unsigned uid) {
	return "   0: " + endpoint(local) + " " + endpoint(remote) + " 01 00000000:00000000 00:00000000 00000000 " +
		   std::to_string(uid) + "        0 12345 1 0000000000000000 20 4 30 10 -1\n";
}
}  // namespace

BOOST_AUTO_TEST_CASE(loopback_peer_must_belong_to_the_same_user) {
	Directory root;
	const auto peer = ipv4("127.0.0.1", 40000), local = ipv4("127.0.0.1", 45678);
	const auto me = geteuid();
	BOOST_CHECK(bound_loopback_peer_owned(table(root, row(local, peer, me) + row(peer, local, me)).c_str(), peer, local, me));
	BOOST_CHECK(!bound_loopback_peer_owned(table(root, row(local, peer, me) + row(peer, local, me + 1)).c_str(), peer, local, me));
	BOOST_CHECK(!bound_loopback_peer_owned(table(root, row(local, peer, me)).c_str(), peer, local, me));
	BOOST_CHECK(!bound_loopback_peer_owned((root.path + "/missing").c_str(), peer, local, me));
	const auto peer6 = ipv6("::1", 40001), local6 = ipv6("::1", 45679);
	BOOST_CHECK(bound_loopback_peer_owned(table(root, row(peer6, local6, me)).c_str(), peer6, local6, me));
	BOOST_CHECK(!bound_loopback_peer_owned(table(root, row(peer6, local6, me + 1)).c_str(), peer6, local6, me));
}
```

Add `<cstring>` for `std::memcpy`. The existing desktop/enrollment tests connect over real loopback from the same user. They are the integration proof that `/proc/self/net/tcp` parsing works, and they must keep passing.

- [ ] **Step 2: Run it and confirm it fails**

Build, then run `device_bound_linux_test`. Expected: compile error, `bound_loopback_peer_owned` undeclared.

- [ ] **Step 3: Implement the header**

```cpp
#ifndef LICENSECC_BOUND_PEER_LINUX_HPP_
#define LICENSECC_BOUND_PEER_LINUX_HPP_
#include <sys/socket.h>
#include <sys/types.h>

namespace license {
namespace device_identity {
// True only when `table` (a /proc/net/tcp or tcp6 file) lists a socket whose
// local endpoint is `peer`, whose remote endpoint is `local`, owned by `owner`.
// Missing, unreadable or unmatched tables fail closed.
bool bound_loopback_peer_owned(const char* table, const sockaddr_storage& peer, const sockaddr_storage& local,
							   uid_t owner) noexcept;
}  // namespace device_identity
}  // namespace license
#endif
```

- [ ] **Step 4: Implement the parser**

```cpp
#include "bound_peer_linux.hpp"
#include <netinet/in.h>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace license {
namespace device_identity {
namespace {
bool same(const sockaddr_storage& address, const unsigned (&words)[4], unsigned port) noexcept {
	if (address.ss_family == AF_INET) {
		const auto& value = reinterpret_cast<const sockaddr_in&>(address);
		return value.sin_addr.s_addr == words[0] && ntohs(value.sin_port) == port;
	}
	if (address.ss_family != AF_INET6) return false;
	const auto& value = reinterpret_cast<const sockaddr_in6&>(address);
	std::uint32_t expected[4];
	std::memcpy(expected, &value.sin6_addr, sizeof(expected));
	return expected[0] == words[0] && expected[1] == words[1] && expected[2] == words[2] && expected[3] == words[3] &&
		   ntohs(value.sin6_port) == port;
}
}  // namespace
bool bound_loopback_peer_owned(const char* table, const sockaddr_storage& peer, const sockaddr_storage& local,
							   uid_t owner) noexcept {
	if (peer.ss_family != local.ss_family) return false;
	std::FILE* file = std::fopen(table, "re");
	if (!file) return false;
	char line[512];
	bool owned = false;
	if (std::fgets(line, sizeof(line), file)) {
		while (std::fgets(line, sizeof(line), file)) {
			unsigned source[4]{}, target[4]{}, source_port = 0, target_port = 0, uid = 0;
			const bool parsed =
				peer.ss_family == AF_INET
					? std::sscanf(line, " %*u: %8X:%4X %8X:%4X %*X %*X:%*X %*X:%*X %*X %u", &source[0], &source_port,
								  &target[0], &target_port, &uid) == 5
					: std::sscanf(line, " %*u: %8X%8X%8X%8X:%4X %8X%8X%8X%8X:%4X %*X %*X:%*X %*X:%*X %*X %u",
								  &source[0], &source[1], &source[2], &source[3], &source_port, &target[0],
								  &target[1], &target[2], &target[3], &target_port, &uid) == 11;
			// The connecting socket's local endpoint is our peer; its remote endpoint is our listener side.
			if (parsed && same(peer, source, source_port) && same(local, target, target_port)) {
				owned = uid == owner;
				break;
			}
		}
	}
	std::fclose(file);
	return owned;
}
}  // namespace device_identity
}  // namespace license
```

- [ ] **Step 5: Wire it into accept**

In `bound_loopback_linux.cpp`, include `"bound_peer_linux.hpp"` and replace the accept branch condition:

```cpp
				sockaddr_storage local{};
				socklen_t local_length = sizeof(local);
				// Loopback ports are shared by every local user: accept only this user's sockets.
				if (!connection || !loopback_address(address, state.family) ||
					getsockname(peer, reinterpret_cast<sockaddr*>(&local), &local_length) != 0 ||
					!bound_loopback_peer_owned(state.family == AF_INET ? "/proc/self/net/tcp" : "/proc/self/net/tcp6",
											   address, local, geteuid())) {
					::close(peer);
					rejected = true;
				} else {
```

- [ ] **Step 6: Run the Linux device-identity tests**

Run: build, then `ctest --preset ci-linux-device-identity-test --no-tests=error -R "device_bound_(linux|desktop|enrollment)_test" --output-on-failure`
Expected: PASS.

- [ ] **Step 7: Document**

In `doc/api/device_identity.rst`, after the browser paragraph (~line 388), add:

> On Linux the callback listener accepts connections only from sockets owned by the same user, proven through `/proc/self/net/tcp` and `tcp6`; without a readable `/proc` the callback is refused. The consent URL is passed to `xdg-open` as an argument, so other local users can see it. They cannot complete enrollment for you, but they can use up the attempt, which then shows as a refused approval. Start a new attempt if that happens.

- [ ] **Step 8: Commit**

```bash
git add src/library/device_identity/bound_peer_linux.hpp src/library/device_identity/bound_peer_linux.cpp src/library/device_identity/CMakeLists.txt src/library/device_identity/bound_loopback_linux.cpp test/library/device_identity/device_bound_linux_test.cpp doc/api/device_identity.rst
git commit -m "fix(device-identity): accept Linux loopback callbacks only from the same user"
```

### Task C2: Browser launcher resolves `xdg-open` on PATH, tolerates reaped children and closes host fds

**Files:**
- Modify: `src/library/device_identity/bound_browser_linux.cpp`
- Test: `test/library/device_identity/device_bound_linux_test.cpp` (the `test_browser_exec` seam at lines 14–25, new cases after line 160)

- [ ] **Step 1: Loosen the exec seam and add probes**

```cpp
bool fail_browser_exec = false;
int inherited_fd = -1;
int test_browser_exec(const char* executable, char* const args[], char* const environment[]) {
	const std::string path(executable);
	if (path.empty() || path.front() != '/' || path.size() < 9 || path.compare(path.size() - 9, 9, "/xdg-open") != 0 || !args[1]) _exit(126);
	if (fail_browser_exec) return -1;
	if (inherited_fd >= 0 && (fcntl(inherited_fd, F_GETFD) & FD_CLOEXEC) == 0) return -1;
	char sleep[] = "/bin/sleep", duration[] = "2";
	char* command[]{sleep, duration, nullptr};
	return execve(sleep, command, environment);
}
```

The exec runs in a forked grandchild, so tests observe the choice through exec success or failure. Add `#include <fcntl.h>` and `<csignal>`.

- [ ] **Step 2: Write the failing tests**

```cpp
BOOST_AUTO_TEST_CASE(browser_launcher_tolerates_hosts_that_ignore_sigchld) {
	auto browser = make_test_linux_browser_launcher("https://example.com/authorize");
	BOOST_REQUIRE(browser);
	const auto previous = std::signal(SIGCHLD, SIG_IGN);
	const auto result = browser->open("https://example.com/authorize#attempt_handle=" + std::string(43, 'A'));
	std::signal(SIGCHLD, previous);
	BOOST_CHECK(result == BoundBrowserStatus::opened);
}

BOOST_AUTO_TEST_CASE(browser_launcher_does_not_leak_host_descriptors) {
	auto browser = make_test_linux_browser_launcher("https://example.com/authorize");
	BOOST_REQUIRE(browser);
	inherited_fd = ::open("/dev/null", O_RDONLY);
	BOOST_REQUIRE(inherited_fd >= 0);
	const auto result = browser->open("https://example.com/authorize#attempt_handle=" + std::string(43, 'A'));
	::close(inherited_fd);
	inherited_fd = -1;
	BOOST_CHECK(result == BoundBrowserStatus::opened);
}

BOOST_AUTO_TEST_CASE(browser_launcher_uses_absolute_path_entries_only) {
	Directory bin;
	const auto opener = bin.path + "/xdg-open";
	std::ofstream(opener) << "#!/bin/sh\n";
	BOOST_REQUIRE(chmod(opener.c_str(), 0700) == 0);
	const std::string saved = std::getenv("PATH") ? std::getenv("PATH") : "";
	auto browser = make_test_linux_browser_launcher("https://example.com/authorize");
	BOOST_REQUIRE(browser);
	const auto url = "https://example.com/authorize#attempt_handle=" + std::string(43, 'A');
	setenv("PATH", ("relative/bin:" + bin.path).c_str(), 1);
	BOOST_CHECK(browser->open(url) == BoundBrowserStatus::opened);
	setenv("PATH", "relative/bin", 1);
	BOOST_CHECK(browser->open(url) == BoundBrowserStatus::unavailable);
	setenv("PATH", saved.c_str(), 1);
}
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `ctest ... -R device_bound_linux_test`.
Expected:
- The SIGCHLD test returns `unavailable`.
- The descriptor test returns `unavailable`.
- In the PATH test, the no-absolute-entry case returns `opened` (the path is hard-coded).

- [ ] **Step 4: Implement**

In `bound_browser_linux.cpp`, add includes `<sys/resource.h>`, `<sys/syscall.h>`, `<cstdlib>`, `<string_view>`, and:

```cpp
#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif
```

Before `class LinuxBrowser`, add:

```cpp
// Resolve before fork: only absolute PATH entries, never the current directory.
std::string resolve_opener() {
	const char* path = std::getenv("PATH");
	std::string_view entries = path && *path ? path : "/usr/local/bin:/usr/bin:/bin";
	while (true) {
		const auto split = entries.find(':');
		const auto entry = entries.substr(0, split);
		if (!entry.empty() && entry.front() == '/') {
			std::string candidate(entry);
			candidate += "/xdg-open";
			if (::access(candidate.c_str(), X_OK) == 0) return candidate;
		}
		if (split == std::string_view::npos) return {};
		entries.remove_prefix(split + 1);
	}
}
int descriptor_ceiling() noexcept {
	rlimit limit{};
	return getrlimit(RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY && limit.rlim_cur < 65536
			   ? static_cast<int>(limit.rlim_cur)
			   : 65536;
}
```

In `open()`:
- Replace `char executable[] = "/usr/bin/xdg-open";` with:

  ```cpp
  			auto opener = resolve_opener();
  			if (opener.empty()) {
  				::close(channel[0]);
  				::close(channel[1]);
  				return BoundBrowserStatus::unavailable;
  			}
  			const int ceiling = descriptor_ceiling();
  ```

  and use `char* args[]{opener.data(), const_cast<char*>(url.c_str()), nullptr};`.
- In the grandchild, immediately before `execve(...)`:

  ```cpp
  							// Host descriptors must not outlive this call inside the browser.
  #ifdef SYS_close_range
  							if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) != 0)
  #endif
  								for (int fd = 3; fd < ceiling; ++fd) (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
  ```

  Change the call to `execve(opener.data(), args, environ);`. Move the `pipe2` block after the resolution so the early return does not leak.
- Replace the wait/return tail with:

  ```cpp
  			int status = 0;
  			pid_t waited;
  			do {
  				waited = waitpid(child, &status, 0);
  			} while (waited < 0 && errno == EINTR);
  			// A host that ignores or reaps SIGCHLD makes waitpid fail with ECHILD; the pipe still reports exec.
  			const bool reaped_elsewhere = waited < 0 && errno == ECHILD;
  			pollfd ready{channel[0], POLLIN, 0};
  			const int available = ::poll(&ready, 1, 3000);
  			char failed = 0;
  			const auto bytes = available > 0 ? ::read(channel[0], &failed, 1) : -1;
  			::close(channel[0]);
  			const bool child_ok = reaped_elsewhere || (waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  			// EOF means exec succeeded, not that a browser or user approved access.
  			return child_ok && bytes == 0 ? BoundBrowserStatus::opened : BoundBrowserStatus::unavailable;
  ```

- [ ] **Step 5: Run the Linux tests**

Run: `ctest --preset ci-linux-device-identity-test --no-tests=error -R device_bound_linux_test --output-on-failure`
Expected: PASS, including the existing "does not wait for browser lifetime" case.

- [ ] **Step 6: Update the docs and commit**

In `doc/api/device_identity.rst`, replace any mention of `/usr/bin/xdg-open` with "the first `xdg-open` on an absolute `PATH` entry".

```bash
git add src/library/device_identity/bound_browser_linux.cpp test/library/device_identity/device_bound_linux_test.cpp doc/api/device_identity.rst
git commit -m "fix(device-identity): harden the Linux browser launcher"
```

### Task C3: Checkpoint files survive restrictive umasks; key references reject hard links

**Files:**
- Modify: `src/library/device_identity/bound_checkpoint_linux.cpp:158`
- Modify: `src/library/device_identity/providers/tpm2_openssl.cpp:629-631`
- Modify: `test/library/device_identity/tpm2_openssl_test.cpp` (fake `fstat` ~line 643, flags ~line 828, symlink test ~line 1395)
- Test: `test/library/device_identity/device_bound_linux_test.cpp`

- [ ] **Step 1: Write the failing tests**

In `device_bound_linux_test.cpp`:

```cpp
BOOST_AUTO_TEST_CASE(checkpoint_publish_survives_a_restrictive_umask) {
	Directory root;
	const auto previous = ::umask(0277);
	auto storage = make_bound_checkpoint_storage_at_root(root.path, 0);
	BOOST_REQUIRE(storage);
	BOOST_REQUIRE(storage->lock() == BoundCheckpointIo::ok);
	observe_empty(*storage);
	const auto published = storage->publish(0, "first");
	storage->unlock();
	::umask(previous);
	BOOST_CHECK(published == BoundCheckpointIo::ok);
}
```

In `tpm2_openssl_test.cpp`:
- Add `bool reference_hard_linked = false;` next to `reference_symlink` (~line 828).
- In the fake `fstat`, after setting `st_mode`, add `status->st_nlink = descriptor_info.kind == Kind::Reference && reference_hard_linked ? 2 : 1;`.
- After the final-reference symlink block (~line 1397), add:

```cpp
	storage = std::make_shared<LockReachPosixStorageApi>();
	storage->reference_present = true;
	storage->reference_hard_linked = true;
	provider = license::device_identity::make_tpm2_openssl_provider(std::make_shared<FakeOpenSsl3Api>(true), storage);
	require(provider->open(request_for("/safe")) == LCC_DEVICE_KEY_CORRUPT, "hard-linked key reference was not rejected");
```

- [ ] **Step 2: Run them and confirm they fail**

Build and run `device_bound_linux_test` and the TPM2 provider unit test. Find its CTest name with `ctest -N | grep tpm2`.
Expected: the umask case returns `error`; the hard-link case opens.

- [ ] **Step 3: Implement**

In `bound_checkpoint_linux.cpp`, after the stage `openat(..., 0600)`:

```cpp
			File file(openat(directory_.fd, stage, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
			// The process umask may strip owner bits; the private mode is required, not requested.
			if (file.fd < 0 || fchmod(file.fd, 0600) != 0 || !valid(file.fd, stage, 8192)) return BoundCheckpointIo::error;
```

Check `bound_directory_linux.cpp` for `mkdirat(..., 0700)`. If it creates directories, add a `fchmod(fd, 0700)` on the opened directory in the creation branch, with the same comment.

In `tpm2_openssl.cpp`:

```cpp
bool valid_reference_status(const struct stat& status) noexcept {
	return S_ISREG(status.st_mode) && status.st_uid == ::geteuid() && (status.st_mode & 07777U) == 0600U &&
		   status.st_nlink == 1;
}
```

If a real stat of the temporary file flows through `valid_reference_status` before it is renamed into place, confirm it has `st_nlink == 1` there too (it is created `O_EXCL` and never linked twice).

- [ ] **Step 4: Run the tests**

Run: `ctest --preset ci-linux-device-identity-test --no-tests=error --output-on-failure -R "device_bound_linux_test|tpm2"`, then on the TPM2 preset (`ci-linux-debug-tpm2`) run `ctest --preset ci-linux-debug-tpm2 --no-tests=error -R tpm2 --output-on-failure`.
Expected: PASS.

- [ ] **Step 5: Commit**

The doc line at `device_identity.rst:393` is now accurate, so leave it unchanged.

```bash
git add src/library/device_identity/bound_checkpoint_linux.cpp src/library/device_identity/bound_directory_linux.cpp src/library/device_identity/providers/tpm2_openssl.cpp test/library/device_identity/device_bound_linux_test.cpp test/library/device_identity/tpm2_openssl_test.cpp
git commit -m "fix(device-identity): force private checkpoint modes; reject hard-linked key references"
```

### Task C4: Linux desktop adapters default on only with a key provider; clear curl diagnostics

**Files:**
- Modify: `CMakeLists.txt:160-167` (option order/defaults) and near `:207` (validation)
- Modify: `src/library/CMakeLists.txt:11-13`
- Modify: `src/cmake/licensecc-config.cmake:47-49`
- Modify: every doc mention found by `rg -n "LCC_ENABLE_LINUX_DESKTOP" doc README.md examples sdks services`

- [ ] **Step 1: Write the configure checks (failing first)**

Run each on Linux from a clean scratch build directory:

```bash
cmake -S . -B /tmp/lcc-di-only -DLCC_ENABLE_DEVICE_IDENTITY=ON -DLCC_PROJECT_NAME=test
cmake -S . -B /tmp/lcc-desktop-no-provider -DLCC_ENABLE_DEVICE_IDENTITY=ON -DLCC_ENABLE_LINUX_DESKTOP=ON -DLCC_PROJECT_NAME=test
```

Expected now:
- The first configure requires curl 7.85 (and fails on Ubuntu 22.04).
- The second configures and later fails at runtime with `PROVIDER_ERROR`.

Target:
- The first configures with desktop OFF on any curl.
- The second stops at configure time with the new FATAL_ERROR.

- [ ] **Step 2: Implement the options**

Reorder so the desktop option follows the provider options:

```cmake
option(LCC_ENABLE_TPM2_OPENSSL "Build the OpenSSL TPM2 device-key provider." OFF)
option(LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER "Build the process-local software device-key test provider." OFF)
# Desktop adapters open keys through the TPM2 provider (or the test provider); default them on only then.
if(LCC_ENABLE_TPM2_OPENSSL OR LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
	set(_lcc_linux_desktop_default ON)
else()
	set(_lcc_linux_desktop_default OFF)
endif()
option(LCC_ENABLE_LINUX_DESKTOP "Build Linux protected enrollment and feature-session platform adapters." ${_lcc_linux_desktop_default})
```

After the existing `LCC_ENABLE_TPM2_OPENSSL` Linux-only check (~line 207):

```cmake
if(LCC_ENABLE_DEVICE_IDENTITY AND CMAKE_SYSTEM_NAME STREQUAL "Linux" AND LCC_ENABLE_LINUX_DESKTOP
	AND NOT LCC_ENABLE_TPM2_OPENSSL AND NOT LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER)
	message(FATAL_ERROR
		"LCC_ENABLE_LINUX_DESKTOP=ON needs LCC_ENABLE_TPM2_OPENSSL=ON (or the test-only "
		"LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=ON). Set LCC_ENABLE_LINUX_DESKTOP=OFF for the portable identity core only.")
endif()
```

- [ ] **Step 3: Implement the curl diagnostics**

In `src/library/CMakeLists.txt`:

```cmake
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND LCC_ENABLE_LINUX_DESKTOP)
        find_package(CURL 7.85)
        if(NOT CURL_FOUND)
            message(FATAL_ERROR "Linux desktop adapters need libcurl >= 7.85 (found: '${CURL_VERSION_STRING}'). "
                "Install a newer libcurl development package or configure with -DLCC_ENABLE_LINUX_DESKTOP=OFF.")
        endif()
    endif()
```

In `licensecc-config.cmake`, use the same pattern with the message: `This licensecc package was built with Linux desktop adapters and needs libcurl >= 7.85 (found: '${CURL_VERSION_STRING}').`

- [ ] **Step 4: Re-run the configure checks and presets**

Re-run both Step 1 commands. Expected: the first succeeds with `LCC_ENABLE_LINUX_DESKTOP:BOOL=OFF` in `CMakeCache.txt`; the second fails with the new message.

Then run `cmake --preset ci-linux-device-identity-test` (desktop ON through the test provider) and `cmake --preset ci-linux-debug-tpm2` on Ubuntu 24.04. Expected: both configure. The `linux.yml:152-154` 22.04 override stays; update its step name to "Ubuntu 22 libcurl 7.81 cannot build desktop adapters".

Finally run `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`. Expected: PASS.

- [ ] **Step 5: Update the docs and commit**

For each doc mention from the `rg` above, state the default ("ON when `LCC_ENABLE_TPM2_OPENSSL` is ON") and the libcurl 7.85 requirement.

```bash
git add CMakeLists.txt src/library/CMakeLists.txt src/cmake/licensecc-config.cmake .github/workflows/linux.yml doc README.md examples sdks
git commit -m "fix(cmake): default Linux desktop adapters on only with a key provider"
```

### Task C5: Linux HTTPS response rules are unit-tested; sanitizers cover device identity

**Files:**
- Modify: `src/library/device_identity/bound_http_linux.cpp:175-184` (extract `finish_response`)
- Modify: `test/library/device_identity/device_bound_linux_test.cpp` (include the transport source under a renamed factory)
- Modify: `test/library/device_identity/CMakeLists.txt` (link `CURL::libcurl` into `device_bound_linux_test`)
- Modify: `CMakePresets.json` (new configure/build/test preset `ci-linux-sanitizers-device-identity`)
- Modify: `.github/workflows/native-security.yml` (new job)

- [ ] **Step 1: Extract the completion rule (pure refactor)**

In the anonymous namespace of `bound_http_linux.cpp`, after `struct Response`:

```cpp
BoundHttpStatus finish_response(Response& response, long code, BoundHttpResponse& out) {
	if (code < 200 || code >= 600 || (code >= 300 && code < 400) || !response.type || response.value.body.empty() ||
		(response.has_length && response.length != response.value.body.size()))
		return BoundHttpStatus::invalid_response;
	response.value.status = static_cast<unsigned>(code);
	out = std::move(response.value);
	return BoundHttpStatus::complete;
}
```

In `post()`, replace the block from `long code = 0;` through `return BoundHttpStatus::complete;` with:

```cpp
			long code = 0;
			if (curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &code) != CURLE_OK)
				return BoundHttpStatus::invalid_response;
			return finish_response(response, code, out);
```

- [ ] **Step 2: Write the tests**

In `device_bound_linux_test.cpp`, next to the browser include:

```cpp
#define make_bound_http_transport make_test_linux_http_transport
#include "bound_http_linux.cpp"
#undef make_bound_http_transport
```

Then add:

```cpp
namespace {
std::size_t feed(license::device_identity::Response& response, std::string line) {
	return license::device_identity::Response::header(line.data(), 1, line.size(), &response);
}
}  // namespace

BOOST_AUTO_TEST_CASE(linux_http_headers_fail_closed) {
	using license::device_identity::Response;
	{ Response r; feed(r, "HTTP/1.1 200 OK\r\n"); BOOST_CHECK(feed(r, "Content-Type: application/json\r\n")); BOOST_CHECK_EQUAL(feed(r, "content-type: application/json\r\n"), 0U); }
	{ Response r; BOOST_CHECK(feed(r, "Content-Length: 2\r\n")); BOOST_CHECK_EQUAL(feed(r, "Transfer-Encoding: chunked\r\n"), 0U); }
	{ Response r; BOOST_CHECK(feed(r, "Transfer-Encoding: chunked\r\n")); BOOST_CHECK_EQUAL(feed(r, "Content-Length: 2\r\n"), 0U); }
	{ Response r; BOOST_CHECK_EQUAL(feed(r, "Content-Encoding: gzip\r\n"), 0U); }
	{ Response r; BOOST_CHECK_EQUAL(feed(r, "Content-Type: text/html\r\n"), 0U); }
	{ Response r; BOOST_CHECK_EQUAL(feed(r, "Content-Length: 16385\r\n"), 0U); }
	{ Response r; BOOST_CHECK_EQUAL(feed(r, "X-Folded: a\r\n"), strlen("X-Folded: a\r\n")); BOOST_CHECK_EQUAL(feed(r, " continued\r\n"), 0U); }
	{ Response r; BOOST_CHECK_EQUAL(feed(r, "Content-Type: application/json\n"), 0U); }
	{ Response r;  // interim 1xx then final response: per-response header state resets
	  feed(r, "HTTP/1.1 100 Continue\r\n"); BOOST_CHECK(feed(r, "Content-Type: application/json\r\n")); feed(r, "\r\n");
	  feed(r, "HTTP/1.1 200 OK\r\n"); BOOST_CHECK(feed(r, "Content-Type: application/json\r\n")); BOOST_CHECK(!r.invalid); }
}

BOOST_AUTO_TEST_CASE(linux_http_completion_rejects_redirects_short_bodies_and_missing_type) {
	using license::device_identity::Response;
	using license::device_identity::finish_response;
	const auto ready = [](bool type, std::string body, bool has_length, std::uint64_t length) {
		Response r; r.type = type; r.value.body = std::move(body); r.has_length = has_length; r.length = length; return r;
	};
	BoundHttpResponse out{0, "unchanged"};
	auto a = ready(true, "{}", true, 2); BOOST_CHECK(finish_response(a, 200, out) == BoundHttpStatus::complete); BOOST_CHECK_EQUAL(out.status, 200U);
	auto b = ready(true, "{}", false, 0); BOOST_CHECK(finish_response(b, 302, out) == BoundHttpStatus::invalid_response);
	auto c = ready(true, "{}", true, 3); BOOST_CHECK(finish_response(c, 200, out) == BoundHttpStatus::invalid_response);
	auto d = ready(false, "{}", false, 0); BOOST_CHECK(finish_response(d, 200, out) == BoundHttpStatus::invalid_response);
	auto e = ready(true, "", false, 0); BOOST_CHECK(finish_response(e, 503, out) == BoundHttpStatus::invalid_response);
	auto f = ready(true, "{}", false, 0); BOOST_CHECK(finish_response(f, 199, out) == BoundHttpStatus::invalid_response);
	auto g = ready(true, "{\"e\":1}", false, 0); BOOST_CHECK(finish_response(g, 429, out) == BoundHttpStatus::complete);
}
```

`Response` and `finish_response` live in an unnamed namespace inside `license::device_identity`. Because the `.cpp` is included into this translation unit, they are reachable as `license::device_identity::Response`. If the compiler rejects the qualified name, add `using namespace license::device_identity;` at the top of each case.

In `test/library/device_identity/CMakeLists.txt`, after the foreach creates targets:

```cmake
if(TARGET device_bound_linux_test)
    target_link_libraries(device_bound_linux_test PRIVATE CURL::libcurl)
endif()
```

- [ ] **Step 3: Run them**

Run: build, then `ctest ... -R device_bound_linux_test`.
Expected: PASS. These tests pin existing behaviour; if any assertion fails, the parser has a real bug. Stop and report it rather than editing the test.

- [ ] **Step 4: Add the sanitizer preset**

In `CMakePresets.json`:
- **configurePresets**, after `ci-linux-sanitizers`:

  ```json
  {
    "name": "ci-linux-sanitizers-device-identity",
    "inherits": "ci-linux-sanitizers",
    "displayName": "CI Linux Clang Sanitizers with Device Identity",
    "description": "ASan/UBSan over the identity core, Linux desktop adapters and the software test provider.",
    "binaryDir": "${sourceDir}/build/ci-linux-sanitizers-device-identity",
    "cacheVariables": {
      "CMAKE_INSTALL_PREFIX": "${sourceDir}/build/ci-linux-sanitizers-device-identity/install",
      "LCC_ENABLE_DEVICE_IDENTITY": "TRUE",
      "LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER": "TRUE",
      "LCC_BUILD_FUZZERS": "FALSE"
    }
  }
  ```

- **buildPresets:** `{ "name": "ci-linux-sanitizers-device-identity", "configurePreset": "ci-linux-sanitizers-device-identity", "configuration": "Debug" }`.
- **testPresets:** copy the `ci-linux-sanitizers` test preset with the new name and `configurePreset`.

Run `npm run test:repository` and `npm run check:versions`; some repository checks enumerate presets. Update any allowlist those checks name.

- [ ] **Step 5: Add the CI job**

In `native-security.yml`, add job `sanitizers-device-identity`. Base it on `sanitizers-and-parser-fuzz` (same `runs-on: ubuntu-24.04`, env and checkout pins), with these changes:
- Add `libcurl4-openssl-dev` to the apt list.
- Drop both fuzz steps.
- Use `cmake --preset ci-linux-sanitizers-device-identity`, `cmake --build --preset ci-linux-sanitizers-device-identity --parallel 2` and `ctest --preset ci-linux-sanitizers-device-identity --no-tests=error`.

Keep action pins identical to the existing job (`npm run test:workflow-pins` enforces this).

- [ ] **Step 6: Run the sanitizer build locally (Linux with clang)**

Run the three commands from Step 5. Expected: PASS. If ASan/UBSan reports findings in device-identity code, fix each as its own commit with a regression test, and list them in the implementation report.

- [ ] **Step 7: Commit and gate**

```bash
git add src/library/device_identity/bound_http_linux.cpp test/library/device_identity CMakePresets.json .github/workflows/native-security.yml
git commit -m "test(device-identity): pin Linux HTTPS response rules; sanitize device identity"
```

Run `npm run check:pr`, `npm run test:native-security` and `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`. Open PR C.

---

## Workstream D — Backup, ops scripts and SDK loaders

### Task D1: Backup polling budget, terminal provider failures and orphan cleanup

**Files:**
- Modify: `services/cloudflare-d1-backup/src/core.ts` (`isTerminalExportError`, cleanup in `saveD1ExportToR2` ~lines 396–412)
- Modify: `services/cloudflare-d1-backup/src/index.ts:73-80`
- Modify: `services/cloudflare-d1-backup/src/cloudflare-workers.d.ts` (declare `cloudflare:workflows`)
- Modify: `services/cloudflare-d1-backup/README.md` (poll budget)
- Test: `services/cloudflare-d1-backup/test/backup-core.test.mjs`

**Interfaces:**
- Produces: `export function isTerminalExportError(error: unknown): boolean` in `core.ts`.

- [ ] **Step 1: Write the failing tests**

```js
test("provider export failures are terminal; not-ready is retryable", () => {
  assert.equal(isTerminalExportError(new Error("d1_export_provider_failed")), true);
  assert.equal(isTerminalExportError(new Error("d1_export_not_ready")), false);
  assert.equal(isTerminalExportError("d1_export_provider_failed"), false);
});

test("a dump that fails post-upload checks is removed from R2", async () => {
  // Use this file's existing fake bucket/fetch helpers for a successful save.
  // Make the dump contain no INSERT statements so snapshot_inventory_no_counted_tables fires.
  const { bucket, fetchImpl, config, started, ready } = fixtureWithDump("-- empty\n");
  await assert.rejects(saveD1ExportToR2(bucket, fetchImpl, config, started, ready), /snapshot_inventory_no_counted_tables/);
  assert.equal(bucket.objects.size, 0);
});
```

`fixtureWithDump` stands for the existing successful-save setup in `backup-core.test.mjs`. Reuse that setup and change only the dump body. If the fake bucket lacks `delete`, add `async delete(key) { objects.delete(key); }` to it.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm --prefix services/cloudflare-d1-backup test`.
Expected: FAIL. `isTerminalExportError` is not exported, and the object remains in R2.

- [ ] **Step 3: Implement `core.ts`**

```ts
// Provider-declared export failure: retrying the same bookmark cannot succeed.
export function isTerminalExportError(error: unknown): boolean {
  return error instanceof Error && error.message === "d1_export_provider_failed";
}
```

In `saveD1ExportToR2`, wrap everything after `putKnownLengthStream(...)` through the manifest write:

```ts
  try {
    // ... existing contentIntegrity, inventory, uploadedAt checks and manifest put, unchanged ...
  } catch (error) {
    // Never leave an unmanifested dump: restore drills require the manifest.
    await bucket.delete(objectKey).catch(() => {});
    throw error;
  }
```

Add `delete(key: string): Promise<void>` to `R2BucketLike` if it is missing.

- [ ] **Step 4: Implement `index.ts`**

Add to `cloudflare-workers.d.ts`:

```ts
declare module "cloudflare:workflows" {
  export class NonRetryableError extends Error { constructor(message: string, name?: string); }
}
```

In `index.ts`, import `NonRetryableError` from `"cloudflare:workflows"` and `isTerminalExportError` from `./core.js`. Change the poll step:

```ts
    const saved = await step.do(
      "poll export and store SQL dump in R2",
      // ~20 minutes of polling; large exports stay "active" longer than the old ~10-minute budget.
      { retries: { limit: 40, delay: "30 seconds", backoff: "constant" }, timeout: "15 minutes" },
      async () => {
        try {
          const ready = await pollD1Export(fetch, config, token, started.bookmark);
          return await saveD1ExportToR2(this.env.BACKUP_BUCKET, fetch, config, started, ready);
        } catch (error) {
          if (isTerminalExportError(error)) throw new NonRetryableError((error as Error).message);
          throw error;
        }
      },
    );
```

- [ ] **Step 5: Run the tests, then update the README and commit**

Run: `npm --prefix services/cloudflare-d1-backup test && npm --prefix services/cloudflare-d1-backup run typecheck` (use the package's actual typecheck script name).
Expected: PASS.

In the README, state that the poll budget is about 20 minutes, that provider failures stop immediately, and that failed saves leave no orphan dump.

```bash
git add services/cloudflare-d1-backup
git commit -m "fix(backup): longer export polling, terminal provider failures, no orphan dumps"
```

### Task D2: Readiness script supports env-scoped Wrangler vars

**Files:**
- Modify: `services/cloudflare-licensing-backend/scripts/protected-device-readiness.mjs:39-50`
- Test: `services/cloudflare-licensing-backend/test/protected-device-readiness.test.mjs`
- Modify: `doc/operations/cloudflare-setup.md` and the backend README, wherever the readiness command is shown

**Interfaces:**
- Produces: CLI `--config=<json> --secrets=<json> [--env=<name>]`.

- [ ] **Step 1: Write the failing test**

Follow the file's existing `main([...])` test pattern. Write a config JSON whose top-level `vars` lacks the protected settings and whose `env.production.vars` has the valid ones. Assert:
- `main(["--config=…","--secrets=…","--env=production"])` returns 0;
- the same call without `--env` returns 1;
- `--env=staging` (missing) returns 1 with `protected_configuration_unavailable`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix services/cloudflare-licensing-backend test -- --test-name-pattern readiness`.
Expected: FAIL, because the argument count is rejected.

- [ ] **Step 3: Implement**

```js
export async function main(argv) {
  try {
    const [configArg, secretsArg, envArg, ...rest] = argv;
    if (rest.length || !configArg?.startsWith("--config=") || !secretsArg?.startsWith("--secrets=") || (envArg !== undefined && !envArg.startsWith("--env="))) throw new Error();
    const config = await boundedJson(configArg.slice(9));
    const secrets = await boundedJson(secretsArg.slice(10));
    const name = envArg?.slice(6);
    // Wrangler env blocks do not inherit top-level vars; validate exactly what that environment deploys.
    const vars = name === undefined ? config.vars : config.env?.[name]?.vars;
    if (!vars || typeof vars !== "object") throw new Error();
    const result = await checkProtectedDeviceConfiguration({ ...vars, ...secrets });
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "protected_configuration_unavailable" }) + "\n");
    return 1;
  }
}
```

If the existing tests pass a config without top-level `vars`, the `!vars` check turns that into an error. Keep that behaviour: it was a silent pass before.

- [ ] **Step 4: Run the tests, update the docs and commit**

Run: `npm --prefix services/cloudflare-licensing-backend test`. Expected: PASS.

Add `--env=<name>` to every documented invocation.

```bash
git add services/cloudflare-licensing-backend/scripts/protected-device-readiness.mjs services/cloudflare-licensing-backend/test/protected-device-readiness.test.mjs services/cloudflare-licensing-backend/README.md doc/operations/cloudflare-setup.md
git commit -m "fix(backend): check env-scoped vars in protected-device readiness"
```

### Task D3: SDK Linux native-load errors

**Files:**
- Modify: `sdks/dotnet/src/Licensecc.Client/DeviceBoundNative.cs:83-87`
- Modify: `sdks/java/src/main/java/io/licensecc/client/DeviceBoundNative.java:20-23`
- Test: `sdks/dotnet` tests for `DeviceBoundNative` (`rg -l DeviceBoundNative sdks/dotnet`), `sdks/java/src/test/java/io/licensecc/client/DeviceBoundAdapterTest.java`

- [ ] **Step 1: Write the failing tests**

- **Java:** in `DeviceBoundAdapterTest`, on Linux, assert that a relative path throws `IllegalArgumentException` whose message contains `"absolute native library path"`, and that a `.txt` file throws one containing `"regular JNI library"`.
- **.NET:** on Linux, loading an existing non-ELF file (write a temp file with text) throws `DllNotFoundException` (or `BadImageFormatException`, matching what `NativeLibrary.Load` raises). Assert the exception propagates unwrapped rather than surfacing as `Win32Exception`.

- [ ] **Step 2: Implement**

**Java:** change the two messages to `"An application-owned absolute native library path is required"` and `"Expected a regular JNI library (.dll on Windows, .so on Linux)"`.

**.NET:**

```csharp
        internal Module(string path) : base(IntPtr.Zero,true)
        {
            if(OperatingSystem.IsWindows())
            {
                SetHandle(LoadLibraryExW(path,IntPtr.Zero,0x00000100|0x00000800));
                if(IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            else
            {
                // dlopen failures surface as DllNotFoundException with the loader message.
                // Bind eagerly (RTLD_NOW) like the Python bridge so missing TPM2/OpenSSL symbols fail at load.
                SetHandle(NativeLibrary.Load(path));
            }
        }
```

`NativeLibrary.Load` exposes no flags. For eager binding on Linux, P/Invoke `dlopen(path, RTLD_NOW | RTLD_LOCAL)` from `libc` (`[DllImport("libc", EntryPoint = "dlopen")] static extern IntPtr dlopen(string file, int mode);`, with `RTLD_NOW = 2` and `RTLD_LOCAL = 0`). If it returns zero, throw `new DllNotFoundException(Marshal.PtrToStringAnsi(dlerror()))`. Use this form instead of `NativeLibrary.Load`, and keep `NativeLibrary.Free` for release (it calls `dlclose`).

- [ ] **Step 3: Run the SDK suites**

Run: `npm run test:sdks`. Expected: PASS on the host OS; the Linux assertions run in the Linux CI bridge step (`linux.yml:182-198`).

- [ ] **Step 4: Commit and gate**

```bash
git add sdks/dotnet sdks/java
git commit -m "fix(sdks): accurate Linux native-load errors; eager binding in .NET"
```

Run `npm run check:pr`. Open PR D.

---

## Workstream E — Docs, example CI, UI cleanup, CHANGELOG

### Task E1: Setup guide and portal README match the #27 password flow and the `BACKEND` binding

**Files:**
- Modify: `doc/operations/cloudflare-setup.md:124` (portal row), `:192-198` (§6), `:248-250` (§8 step 2)
- Modify: `services/cloudflare-customer-portal/README.md:217-222`
- Modify: `services/cloudflare-customer-portal/wrangler.example.jsonc:6-9` (comment only)

- [ ] **Step 1: Rewrite §6's first paragraph**

```markdown
For password sign-in, set `PORTAL_PASSWORD_ENABLED="1"`, provision session
peppers, and configure email delivery (`PORTAL_EMAIL_API_KEY`,
`PORTAL_EMAIL_FROM`, optional `PORTAL_EMAIL_API_BASE`). Registration and
password reset send a single-use link valid for 15 minutes; without a working
sender both return `email_unconfigured` and the portal hides those actions.
Registration creates an empty customer after the address is verified; it never
grants a license. Accounts registered before email verification existed can
recover through reset once, which records the proven address as their contact
email.
```

- [ ] **Step 2: Rewrite §8 step 2**

```markdown
2. In **Customers → Add user**, create a synthetic portal user with an initial
   password, or let the user register in the portal (requires email delivery,
   step 6). No welcome email is sent by Add user. Share an initial password
   through an appropriate private channel.
```

- [ ] **Step 3: Portal table row and README**

Append to the portal row at line 124: `; `BACKEND` targets the backend Worker for readiness and self-service proxying (map it per environment)`.

Replace README lines 217–222 with:

```markdown
The portal reaches the backend through the `BACKEND` service binding (readiness
and self-service proxying) and `DEVICE_CONSENT` (the `DeviceConsent` RPC
entrypoint). Wrangler environment blocks do not inherit `services`: declare
both bindings under every `env.<name>` with that environment's backend Worker
name, or staging will call production.
```

Above the `services` array in `wrangler.example.jsonc`, add the comment `// Redeclare under each env.<name>: environments do not inherit services.`

- [ ] **Step 4: Run the docs gates and commit**

Run: `npm run test:docs-accuracy && npm run check:docs`. Expected: PASS.

```bash
git add doc/operations/cloudflare-setup.md services/cloudflare-customer-portal/README.md services/cloudflare-customer-portal/wrangler.example.jsonc
git commit -m "docs: align Cloudflare setup with email-verified passwords and BACKEND binding"
```

### Task E2: Build and test `examples/device_bound` in CI; complete the Linux docs

**Files:**
- Create: `scripts/ci/build-device-bound-example.ps1`
- Modify: `.github/workflows/linux.yml` (TPM2 job, after "OpenSSL TPM2 simulator, installed consumer, and example", on `ubuntu-24.04` only)
- Modify: `.github/workflows/windows.yml` (the job that installs a TPM-enabled package; find it with `rg -n "LCC_ENABLE_WINDOWS_TPM" .github/workflows/windows.yml`)
- Modify: `examples/device_bound/README.md:1,169-178`, `examples/device_bound/CALCULATOR.md` (add "Build on Linux")

- [ ] **Step 1: Write the CI script**

```powershell
#Requires -Version 7
param(
    [Parameter(Mandatory)] [string] $InstallPrefix,
    [Parameter(Mandatory)] [string] $BuildDirectory,
    [string] $Configuration = 'Debug'
)
$ErrorActionPreference = 'Stop'
$key = Join-Path $BuildDirectory 'example-signing-key.der'
New-Item -ItemType Directory -Force $BuildDirectory | Out-Null
# Public test key only: the example tests never contact a backend.
& openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out (Join-Path $BuildDirectory 'example-signing-key.pem')
& openssl pkey -in (Join-Path $BuildDirectory 'example-signing-key.pem') -pubout -outform DER -out $key
if ($LASTEXITCODE -ne 0) { throw 'openssl failed' }
$generator = if ($IsWindows) { @('-G', 'Visual Studio 17 2022', '-A', 'x64') } else { @() }
& cmake -S examples/device_bound -B $BuildDirectory @generator `
    "-DCMAKE_PREFIX_PATH=$InstallPrefix" "-Dlicensecc_DIR=$InstallPrefix/cmake/licensecc" `
    -DLCC_PROJECT_NAME=test -DLCC_BOUND_EXAMPLE_TESTS=ON `
    -DLCC_BOUND_APPLICATION_ID=com.example.cad -DLCC_BOUND_ENDPOINT_ORIGIN=https://backend.test `
    -DLCC_BOUND_PORTAL_URL=https://portal.test/authorize -DLCC_BOUND_ISSUER=https://issuer.test/ `
    -DLCC_BOUND_LEASE_AUDIENCE=CAD-client -DLCC_BOUND_PROOF_AUDIENCE=proof-audience `
    -DLCC_BOUND_PROJECT=CAD -DLCC_BOUND_FEATURE=DEFAULT -DLCC_BOUND_CLIENT_ID=CAD-client `
    "-DLCC_BOUND_SIGNING_SPKI=$key"
if ($LASTEXITCODE -ne 0) { throw 'configure failed' }
& cmake --build $BuildDirectory --config $Configuration
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
& ctest --test-dir $BuildDirectory -C $Configuration --no-tests=error --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'example tests failed' }
```

Confirm the installed `licensecc_DIR` layout from the existing README (`$PWD/build/device-bound-public-install/cmake/licensecc`). On Linux the install layout may be `lib/cmake/licensecc`; check `build/<preset>/install` after `cmake --install` and pass the right path from the workflow.

- [ ] **Step 2: Run it locally (Windows host, TPM package installed per the README)**

Run: `pwsh -NoProfile -File scripts/ci/build-device-bound-example.ps1 -InstallPrefix $PWD/build/device-bound-public-install -BuildDirectory build/device-bound-example-ci`.
Expected: `device_bound_example_recovery`, `feature_session_example_installed_api`, `feature_session_example_guards` and `calculator_example_*` pass.

- [ ] **Step 3: Wire CI**

In `linux.yml`'s TPM2 job, add after the simulator step:

```yaml
      -  name: Protected application example
         if: matrix.os == 'ubuntu-24.04'
         run: pwsh -NoProfile -File scripts/ci/build-device-bound-example.ps1 -InstallPrefix build/${{ matrix.preset }}/install -BuildDirectory build/${{ matrix.preset }}-example -Configuration ${{ matrix.configuration }}
```

Add the equivalent step to the Windows TPM-package job with its install prefix. Run `npm run test:workflow-pins` and `npm run test:repository`. If the repository doctor enumerates CI scripts, register the new script where it asks.

- [ ] **Step 4: Update the docs**

- **`README.md` line 1:** `# Protected device-bound application example (Windows and Linux)`.
- **Linux section:** replace its first sentence with "Build/install the native runtime with `LCC_ENABLE_DEVICE_IDENTITY=ON` and `LCC_ENABLE_TPM2_OPENSSL=ON` (this enables the Linux desktop adapters, which need libcurl 7.85+)". Add a bash block that mirrors the PowerShell configure block without the generator flags.
- **`CALCULATOR.md`:** add `## Build on Linux` after the Windows section, with the same commands in bash (`cmake -S . -B build/calculator-native -DLCC_ENABLE_DEVICE_IDENTITY=ON -DLCC_ENABLE_TPM2_OPENSSL=ON -DLCC_PROJECT_NAME=test`, install, then configure/build/ctest the example as in the script).

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/build-device-bound-example.ps1 .github/workflows/linux.yml .github/workflows/windows.yml examples/device_bound/README.md examples/device_bound/CALCULATOR.md
git commit -m "ci: build and test the protected application example on Windows and Linux"
```

### Task E3: Admin/portal UI cleanups

**Files:**
- Modify: `services/cloudflare-license-admin/src/ui/features/customers/CustomerAccess.tsx:78`
- Modify: `services/cloudflare-customer-portal/src/ui/features/devices/DevicesFeature.tsx:316-318` (and the `<details>` it controls)
- Modify: `services/cloudflare-customer-portal/src/ui/portalWorkflow.ts:116,118`; `test/portal-ui-workflow.test.mjs:85-86`
- Modify: `services/cloudflare-customer-portal/src/ui/features/devices/DeviceRegistrations.tsx:23`
- Modify: `services/cloudflare-customer-portal/src/ui/features/usage/UsageFeature.tsx:9`
- Modify: `services/cloudflare-customer-portal/test/portal-ui.e2e.mjs:706`
- Tests: the admin e2e spec that clicks "Assign existing license" (`rg -n "Assign existing license" services/cloudflare-license-admin/test`)

- [ ] **Step 1: Admin button**

Rename the label to `View assigned licenses` and add `disabled={busy}` if the component has a `busy` value in scope. If it has none, do not invent one; rename only. Update the admin e2e locator to the new name. Run `npm --prefix services/cloudflare-license-admin run test:e2e -- -g "customer"`. Expected: PASS.

- [ ] **Step 2: Browser sessions panel**

In `DevicesFeature.tsx`, find the `<details … open={browserSessionsOpen} onToggle=…>` that the state at 316–318 controls. When `hasBrowserSession` is true, render the same content in `<section aria-labelledby="browser-sessions-heading"><h3 id="browser-sessions-heading">Browser sessions</h3>…</section>`. Otherwise render the collapsible `<details>` with no forced reopen. Delete the `browserSessionsOpen` state and its effect.

Run `npm --prefix services/cloudflare-customer-portal run test:e2e -- -g "seat|session"`. Expected: PASS. Any test that clicked the summary to open a live-session panel now finds the content directly; update its locator.

- [ ] **Step 3: Dead code and copy**

- Delete `NO_USAGE_EMPTY_COPY` and `NO_DOWNLOADS_EMPTY_COPY`, and their two assertions in `portal-ui-workflow.test.mjs`.
- In `DeviceRegistrations.tsx:23`, reduce the empty state to the filtered case (`No matching devices` / `Try another device ID or app.`), because the component renders only when `devices.length > 0`.
- In `UsageFeature.tsx:9`, change the heading to `Activity` and the copy to `Activity is unavailable. Your license access and devices are still available.`, and the button to `Retry activity`. Update any test asserting the old strings (`rg -n "Recorded usage|Retry usage" services/cloudflare-customer-portal/test`).
- In `portal-ui.e2e.mjs:706`, replace the always-true `Download licenses` count assertion with a positive assertion on what the state does show: `await expect(page.getByText("Connect from your app", { exact: true })).toBeVisible();` is already present, so delete the vacuous line.

- [ ] **Step 4: Run the UI suites and commit**

Run: `npm --prefix services/cloudflare-customer-portal run test:ui && npm --prefix services/cloudflare-customer-portal run test:e2e && npm --prefix services/cloudflare-license-admin run test:e2e`. Expected: PASS.

```bash
git add services/cloudflare-license-admin services/cloudflare-customer-portal
git commit -m "fix(ui): honest admin action label, static live-session panel, remove dead copy"
```

### Task E4: CHANGELOG covers #23–#27 and this remediation (run after A–D merge)

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)

- [ ] **Step 1: Add the entries**

Under `### Added`:

```markdown
- Linux protected device licensing: TPM2 (OpenSSL provider) device keys, loopback
  enrollment, private checkpoint storage and Linux SDK bridges for Python, .NET
  and Java (#25).
- Protected enrollment can request a specific feature; consent offers only
  matching entitlements (#25).
- Email-verified password registration and reset links in the customer portal (#27).
- `examples/device_bound`: protected application, feature-session and calculator
  examples, built and tested in CI on Windows and Linux (#27, remediation).
```

Under `### Changed`:

```markdown
- Customer portal and operator console flows simplified; portal proxies the
  backend through the `BACKEND` service binding (#27).
- `LCC_ENABLE_LINUX_DESKTOP` defaults ON only with the TPM2 or test provider
  (remediation).
- Protected-device global rate fuse counts only per-source-admitted requests;
  optional `BOUND_SESSION_RATE_LIMITER` and `BOUND_GLOBAL_RATE_LIMIT` (remediation).
```

Under `### Fixed`:

```markdown
- Protected enrollment and license-validity wording in the portal (#23).
- Admin entitlement filter selection race (#24).
- D1 backup export compatibility and same-second checkpoint recovery (#26); longer
  export polling and no orphan dumps (remediation).
- Linux loopback callbacks are accepted only from the same local user; browser
  launcher hardening (remediation).
- Pre-verification password accounts can recover through reset; password link
  requests no longer reveal account existence by timing (remediation).
```

If the file already has `### Fixed`/`### Changed` headings under `[Unreleased]`, merge into them rather than duplicating.

- [ ] **Step 2: Run the gates and commit**

Run: `npm run test:docs-accuracy && npm run check:versions`. Expected: PASS.

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record #23-#27 and review remediation"
```

- [ ] **Step 3: Workstream E gate**

Run `npm run check:pr`, `npm run check:docs` and `npm run test:e2e`. Open PR E. In the implementation report, list every surface not run, for example real swtpm hardware, staging D1 and the real email provider.

---

## Self-review notes

- **Coverage:** every row of the finding map has a task; the declined items are listed with reasons.
- **Interfaces:** used consistently across tasks:
  - `limitBoundVerified(db, keyId, customerId, customerLimit)` (A2);
  - `password_updated` envelope (B4 produces, B5 consumes);
  - `bound_loopback_peer_owned(...)` (C1);
  - `finish_response(...)` (C5);
  - `isTerminalExportError` (D1).
- **Open to verify during execution:** each is a named check with a stated action, not a placeholder:
  - where `BoundRequestError` exposes its code (A1);
  - `e.max_active_devices` on the snapshot (A2);
  - the `loginEmail` test location (B3);
  - the providers test location (B5);
  - `mkdirat` in `bound_directory_linux.cpp` (C3);
  - the Linux install layout for `licensecc_DIR` (E2);
  - preset allowlists in repository checks (C5).
