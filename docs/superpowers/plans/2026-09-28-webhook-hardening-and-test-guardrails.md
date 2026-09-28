# Webhook Hardening and Test Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the webhook SSRF and audit gaps, stop one bad admin render from blanking the console, and make two silent test gaps fail loudly.

**Architecture:**
- **Webhook outbound calls.** The backend Worker makes every outbound webhook call. It gets Cloudflare's `global_fetch_strictly_public` flag, enforced by the deploy-config materializer. It also re-checks each stored URL, using a stricter shared `safeWebhookUrl`, right before sending.
- **Test-send audit.** Admin test sends become durable audit rows in the existing `webhook_events` table. A table-rebuild migration widens its `event_type` check.
- **Error boundary.** The admin UI gets a small React error boundary around each workspace feature and around the whole shell.
- **Test discovery.** Portal Playwright finds its spec files by pattern, not by side-effect imports.
- **Parity unit tests.** The PostgreSQL-parity Python unit tests join `check:schema-parity`.

**Tech Stack:**
- Cloudflare Workers (wrangler 4.x) with D1/SQLite migrations, plus the PostgreSQL mirror schema.
- React + Vite admin and portal UIs, tested with Playwright and `node:test`.
- Python 3.12 and `uv` for the sqlglot parity checker.

**Spec:** the "Follow-up list" and "Reviewed and left alone" sections of `docs/implementation/2026-09-23-ui-ux-workflow-remediation.md`. The rows covered are:
- `global_fetch_strictly_public` and webhook SSRF;
- an audit row for webhook test sends;
- the admin React error boundary;
- the portal Playwright `testMatch`.

The 2026-09-28 finding that `test/schema/test_check_pg_parity.py` runs in no gate is also covered.

## Global Constraints

- **PR gate:** `npm ci` then `npm run check:pr`, with Python 3.12 and uv 0.12.5. The only known local exception is the 7 `staging-lease-drill.test.mjs` failures on Node 24 hosts; CI's Node 22 must pass them.
- **UI changes:** also run the touched app's `test:ui` and `test:e2e`.
- **Hotspots:** `packages/cloudflare-runtime/src/webhooks/webhook.mjs` is 635 of its 638-line baseline. Never raise a hotspot baseline; put new logic in sibling files.
- **Migrations** need all of the following:
  - a numbered file `services/cloudflare-licensing-backend/migrations/NNNN_snake_case.sql`;
  - regenerated `schema.sql` (`npm run schema:write --workspace @licensecc/cloudflare-licensing-backend`);
  - a hand-edited `supabase-postgres/schema.pg.sql`;
  - a passing `npm run check:schema-parity`;
  - an updated restore-drill signature and pins in `services/cloudflare-d1-backup`.
- **Contract baselines** change only via `npm run write:contract-baselines`.
- **Local configuration:** never edit a local `wrangler.jsonc` or `wrangler.toml`. Only the tracked `wrangler.example.*` templates.
- **Repo text:** never cite plan task numbers or ruling IDs. State reasons in plain words.
- **Commits:** every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Documentation:** every operator-visible change gets a CHANGELOG `Unreleased` entry.

## Review Focus

1. **The deploy pipeline after Task 1.** The staging and production deploy workflows materialize configs from base64 secrets. After this change, a config without `global_fetch_strictly_public` is refused with a clear message, and the backend README states that operator action. It must not fail with a generic error.
2. **Endpoints stored before Task 2 that the stricter rules now refuse.** Examples are an IP-literal host and `https://user:pass@host`. They must stop receiving deliveries with a visible `last_error` of `invalid_url`, never a crash or an endless retry. Admin must still list them, and must let the operator fix or disable them.
3. **Test-send audit writes before migration 0043 is applied.** The receiver call has already happened, so the admin response must still report the real result. The audit failure is logged, not swallowed silently, and it does not turn into a 500.
4. **An error boundary on a tab that is not active.** All ten features stay mounted, so a feature that throws while hidden must not show its fallback over another tab. The fallback appears only when that tab is active, and the rest of the console keeps working.
5. **A new portal spec file.** Once imports are no longer needed, a new portal spec file is picked up and pinned. Removing the imports must not drop any of today's 156 scenarios.

---

### Task 1: Backend outbound fetch is strictly public

**Files:**
- Modify: `services/cloudflare-licensing-backend/wrangler.example.toml:3` (add a `compatibility_flags` line after `compatibility_date`)
- Modify: `scripts/materialize-deploy-configs.mjs`, in `validateBackend` (about line 352)
- Test: `scripts/materialize-deploy-configs.test.mjs` (the backend fixture at about line 66, plus a new negative test)
- Modify: `services/cloudflare-licensing-backend/test/db/webhook-operator-worker.test.mjs:30-41` (mirror the production flag)
- Modify: `doc/security/threat-model.md`: a new threat-register row `TM-17` after `TM-16` (about line 79)
- Modify: `services/cloudflare-licensing-backend/README.md` (deployment configuration), `CHANGELOG.md` (`Unreleased` → `Changed`)

**Interfaces:**
- Produces: the materializer refuses a backend config unless `compatibility_flags` includes `"global_fetch_strictly_public"` and excludes `"global_fetch_private_origin"`. The error text is `must enable compatibility flag global_fetch_strictly_public so webhook fetches cannot reach this zone's origin directly`.

- [ ] **Step 1: Write the failing tests.**
  - In `scripts/materialize-deploy-configs.test.mjs`, add `compatibility_flags = ["global_fetch_strictly_public"]` to the backend fixture so existing tests keep passing.
  - Then add:

```js
test("backend config must enable global_fetch_strictly_public", () => {
  for (const flags of [undefined, [], ["nodejs_compat"], ["global_fetch_strictly_public", "global_fetch_private_origin"]]) {
    const config = backendFixture(); // use the file's existing backend fixture builder
    if (flags === undefined) delete config.compatibility_flags; else config.compatibility_flags = flags;
    assert.throws(() => materializeFromFixture({ backend: config }), /global_fetch_strictly_public/u, JSON.stringify(flags));
  }
});
```

  Adapt `backendFixture`/`materializeFromFixture` to the helper names the file already uses. Read its first 120 lines before writing.

- [ ] **Step 2: Run it and confirm it fails.** Run `node --test scripts/materialize-deploy-configs.test.mjs`. Expected: the new test fails, because nothing reads `compatibility_flags` yet.

- [ ] **Step 3: Implement.** In `validateBackend`:

```js
  const flags = config.compatibility_flags;
  if (!Array.isArray(flags) || !flags.includes("global_fetch_strictly_public") || flags.includes("global_fetch_private_origin")) {
    fail(target, "must enable compatibility flag global_fetch_strictly_public so webhook fetches cannot reach this zone's origin directly");
  }
```

  Also make these changes:
  - Add `compatibility_flags = ["global_fetch_strictly_public"]` to `wrangler.example.toml`, directly under `compatibility_date`.
  - In `webhook-operator-worker.test.mjs`, add `compatibilityFlags: ["global_fetch_strictly_public"]` to the backend worker options and confirm the test still passes. Its `outboundService` receiver still intercepts outbound `fetch`.

- [ ] **Step 4: Document.**
  - Threat-model row, in the table's four-column format:

```
| TM-17 | An operator-configured webhook URL on the deployment's own zone makes the backend's `fetch` reach the origin directly, bypassing Cloudflare security settings, and the delivery log reads back part of the response | the backend Worker runs with `global_fetch_strictly_public` (enforced by the deploy-config materializer), so same-zone URLs go through Cloudflare's front door; `safeWebhookUrl` refuses userinfo, IP-literal and internal hostnames and is re-checked before every delivery | materializer and `safeWebhookUrl` negative tests must pass; a public receiver that returns sensitive error text is residual and bounded to 1 KiB in `last_error` |
```

  - Backend README: one short paragraph in the deployment configuration section. It explains that the deployed backend config must set `compatibility_flags = ["global_fetch_strictly_public"]`, that the materializer refuses configs without it, and that existing base64 config secrets must be updated before the next deploy.
  - CHANGELOG entry under `Unreleased` → `Changed`, worded for operators.

- [ ] **Step 5: Verify.**
  - `node --test scripts/materialize-deploy-configs.test.mjs`
  - `npm run test:release-operations`
  - `npm run test --workspace @licensecc/cloudflare-licensing-backend -- test/db/webhook-operator-worker.test.mjs`, or the backend's db test script if it runs that file
  - `npm run test:docs-accuracy`

  Expected: all pass.

- [ ] **Step 6: Commit.** `fix(backend): route webhook fetches strictly through the public internet`

### Task 2: Stricter webhook URLs, re-checked before every delivery

**Files:**
- Modify: `packages/cloudflare-runtime/src/webhooks/webhook_endpoint.mjs:15-25` (`safeWebhookUrl`)
- Modify: `packages/cloudflare-runtime/src/webhooks/webhook_delivery_store.mjs` (new `refuseUnsafeWebhookDelivery`)
- Modify: `packages/cloudflare-runtime/src/webhooks/webhook.mjs`, in `deliverOne` (about line 538). **At most 3 added lines** (baseline 638, currently 635).
- Test: `packages/cloudflare-runtime/test/webhook-endpoint.test.mjs`, `packages/cloudflare-runtime/test/webhook-delivery.test.mjs`

**Interfaces:**
- Produces: `safeWebhookUrl(value: unknown): string | null`. It keeps its current behaviour, and also returns `null` for:
  - userinfo, meaning a non-empty `username` or `password`;
  - IPv4 or IPv6 literal hosts;
  - single-label hosts, meaning no dot;
  - hosts that equal or end in `localhost`, `.local`, `.internal` or `.home.arpa`.
- Produces: `refuseUnsafeWebhookDelivery(db, delivery, now, claimUntil): Promise<boolean>`. It records a terminal failure with `last_status = 0` and `last_error = "invalid_url"` through `persistWebhookDeliveryOutcome`.

- [ ] **Step 1: Write the failing URL tests** in `webhook-endpoint.test.mjs`:

```js
test("safeWebhookUrl refuses credentials, IP literals and internal hostnames", () => {
  for (const url of [
    "https://user:pass@hooks.example.com/", "https://user@hooks.example.com/",
    "https://127.0.0.1/", "https://10.0.0.5/hook", "https://[::1]/", "https://[fd00::1]/",
    "https://localhost/", "https://api.localhost/", "https://intranet/", "https://printer.local/",
    "https://db.internal/", "https://nas.home.arpa/",
  ]) {
    assert.equal(safeWebhookUrl(url), null, url);
  }
  assert.equal(safeWebhookUrl("https://hooks.example.com:8443/lcc"), "https://hooks.example.com:8443/lcc");
});
```

- [ ] **Step 2: Write the failing delivery test** in `webhook-delivery.test.mjs`. Use the existing `makeEnvironment` harness and its fake `fetch` injection. Read how other tests in the file stub `fetch` first.

```js
test("a stored endpoint URL that is no longer safe is never fetched and fails terminally", async () => {
  const env = makeEnvironment({ delivery: { url: "https://127.0.0.1/hook" } });
  let fetched = 0;
  await withFetch(async () => { fetched += 1; return new Response("ok"); }, () =>
    deliverWebhooks({ ...env, ...SIGNING_ENV }, 1_000, () => {}));
  assert.equal(fetched, 0);
  assert.equal(env.state.status, "failed");
  assert.equal(env.state.last_error, "invalid_url");
});
```

  Use whatever the file calls its fetch-stub helper and state accessor; add small ones if it has none.

- [ ] **Step 3: Run the tests and confirm they fail.** Run `npm run test --workspace @licensecc/cloudflare-runtime`. Expected: the new URL cases return an href instead of `null`, and the delivery test sees `fetched === 1`.

- [ ] **Step 4: Implement `safeWebhookUrl`** in `webhook_endpoint.mjs`:

```js
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function publicHostname(host) {
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return false; // IPv6 / IPv4 literal
  if (!host.includes(".") || host === "localhost") return false;
  return !INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
// in safeWebhookUrl, replace the final return with:
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  return publicHostname(parsed.hostname) ? parsed.href : null;
```

  Update the doc comment. It should say that the backend also applies the check before every scheduled delivery.

- [ ] **Step 5: Implement the delivery guard.**
  - In `webhook_delivery_store.mjs`:

```js
/** Record a delivery whose stored URL no longer passes safeWebhookUrl as failed, without fetching. */
export async function refuseUnsafeWebhookDelivery(db, delivery, now, claimUntil) {
  return persistWebhookDeliveryOutcome(db, {
    deliveryId: Number(delivery.id), claimUntil, now, ok: false, statusCode: 0,
    errorText: "invalid_url", attempts: Number(delivery.attempts) + 1, terminal: true, retryAt: null,
  });
}
```

  - In `webhook.mjs`, import `safeWebhookUrl` and `refuseUnsafeWebhookDelivery`: extend the existing store import and add one import line. At the top of `deliverOne`, before signing, add:

```js
  if (safeWebhookUrl(delivery.url) === null) { await refuseUnsafeWebhookDelivery(env.DB, delivery, now, claimUntil); return; }
```

  - Check the result with `wc -l packages/cloudflare-runtime/src/webhooks/webhook.mjs` (expected ≤ 638) and `npm run check:hotspots`.

- [ ] **Step 6: Verify.**
  - `npm run test --workspace @licensecc/cloudflare-runtime`.
  - The admin Worker tests that call `safeWebhookUrl` on create and patch: `npm run test:admin`. Add one admin worker test asserting that creating `https://127.0.0.1/` returns `invalid_url`.
  - The backend `test/sql/webhook-test-send.test.mjs`.
  - `npm run check:hotspots`.

- [ ] **Step 7: Document and commit.**
  - CHANGELOG `Unreleased` → `Changed`: which webhook URLs are now refused, and that stored endpoints with such URLs fail with `invalid_url` until an operator edits them.
  - Commit: `fix(webhooks): refuse credential, IP-literal and internal webhook hosts, checked before every delivery`

### Task 3: Durable audit rows for webhook test sends

**Files:**
- Create: `services/cloudflare-licensing-backend/migrations/0043_allow_webhook_test_send_event.sql`
- Regenerate: `services/cloudflare-licensing-backend/schema.sql`
- Modify: `services/cloudflare-licensing-backend/supabase-postgres/schema.pg.sql:603-618` (`webhook_events` CHECK)
- Modify: `services/cloudflare-license-admin/src/worker/groups/webhooks/test-send.ts` (write the audit row)
- Modify: `services/cloudflare-d1-backup/scripts/restore-drill.mjs`:
  - `:23` `EXPECTED_SCHEMA_SIGNATURE_SHA256`;
  - `:120` the comment "migrations 0001-0042" becomes 0043.
- Modify: `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`:
  - `:331` becomes `43`;
  - `:333` names the new last migration;
  - `:839` changes the test title to "migration 0043";
  - `:922-932` counts: unchanged unless the migration adds objects.
- Test: `services/cloudflare-license-admin/test/worker/webhook-test-send.test.mjs`, `services/cloudflare-license-admin/test/sql/webhook-admin.test.mjs`

**Interfaces:**
- Consumes: `Actor` (`subject`, `email`, `actorType`) and `requestId`, both already passed to `sendWebhookTest`.
- Produces: one `webhook_events` row per test send that reached the receiver. It has:
  - `event_type = 'test_send'`;
  - `prev_status` and `next_status` set to the endpoint's current status;
  - `reason` set to the reported status class (`2xx` … `network_error`);
  - `source = 'admin'`, plus the actor and the request id.

  A send the backend refused (`not_found`, `invalid_url`, `rate_limited`, `webhook_signing_unconfigured`, `temporarily_unavailable`) writes no row, because nothing reached the receiver.

- [ ] **Step 1: Write the failing tests.**
  - **Admin worker test:** a successful test send leaves exactly one `webhook_events` row with `event_type 'test_send'`, the actor's email, `actor_type`, `reason '2xx'` and the request id. A `rate_limited` result leaves none.
  - **SQL test:** after all migrations, inserting `event_type 'test_send'` succeeds, and `'unknown'` still fails the CHECK.

- [ ] **Step 2: Run them and confirm they fail.** Run `npm run test:admin`. Expected: the CHECK rejects `'test_send'`, and no row is written.

- [ ] **Step 3: Write migration 0043** as a table rebuild. SQLite cannot alter a CHECK in place, so follow the precedent in `migrations/0007_allow_revoked_override_event_type.sql`:

```sql
-- Operator test sends reach a real receiver, so they are audited like disable/reenable:
-- actor, request id and the receiver's status class. SQLite cannot widen a CHECK in place,
-- so the table is rebuilt with the same columns, rows and index.
DROP INDEX IF EXISTS idx_webhook_events_endpoint;
CREATE TABLE webhook_events_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('disable', 'reenable', 'test_send')),
  prev_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  actor_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (actor_type IN ('access', 'dev', 'cli', 'sync', 'system', 'unknown')),
  source      TEXT NOT NULL DEFAULT 'admin',
  reason      TEXT NOT NULL DEFAULT '',
  request_id  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);
INSERT INTO webhook_events_new SELECT id, endpoint_id, event_type, prev_status, next_status, actor, actor_type, source, reason, request_id, created_at FROM webhook_events;
DROP TABLE webhook_events;
ALTER TABLE webhook_events_new RENAME TO webhook_events;
CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint ON webhook_events(endpoint_id, created_at DESC);
```

  Then:
  - Run `npm run schema:write --workspace @licensecc/cloudflare-licensing-backend`.
  - Edit the `webhook_events` CHECK in `schema.pg.sql` to add `'test_send'`, with a comment naming migration 0043 in the style of the file's other migration notes.
  - Run `npm run check:schema-parity`. Expected: `schema parity ok` and `pg schema semantic parity ok`.

- [ ] **Step 4: Write the audit row in `test-send.ts`.** After `result` is obtained and before `relay`:
  - If the result is `webhook_test_sent` with a valid status class, read the endpoint's current `status` (`SELECT status FROM webhook_endpoints WHERE id = ?`).
  - Insert the row with a prepared statement shaped like `webhookEventAudit` in `src/worker/webhooks.ts:349-363`, but with no `WHERE EXISTS` guard, because nothing changes.
  - Wrap the audit in `try`/`catch`. On failure, call `console.error(JSON.stringify({ event: "webhook.test_send_audit_failed", request_id: requestId, endpoint_id: endpointId }))` and still return the relayed result. The receiver call has already happened, so the operator must see the real outcome.
  - Keep the file under 500 lines. If it grows past about 120 lines, move the audit helper into `groups/webhooks/test-send-audit.ts`.

- [ ] **Step 5: Update the restore drill.**
  - Run `node --test services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`. It fails and prints the new schema signature.
  - Update `EXPECTED_SCHEMA_SIGNATURE_SHA256`, the "0001-0042" comment, the migration count and last-name pins, and the "through migration 0043" title.
  - Confirm that table, index and trigger counts are unchanged. The rebuild keeps the same objects.
  - Grep the whole repo for other hard-coded latest-migration pins (`grep -rn "0042_" --include=*.mjs --include=*.md`). Update only pins that mean "the latest migration". Leave the portal README's "apply migrations through 0042" requirement alone, because the portal does not need 0043.

- [ ] **Step 6: Verify.**
  - `npm run test:admin`
  - `npm run test:backend` (use `npm run test:sql --workspace @licensecc/cloudflare-licensing-backend` if `staging-lease-drill` blocks it locally)
  - `npm run test:backup`
  - `npm run check:schema-parity`
  - `npm run test:contracts`. Expected: no baseline change, because the response shape is unchanged.

- [ ] **Step 7: Document and commit.**
  - Backend README (deploy order): apply migration 0043 before deploying the admin Worker. Until then, test-send audit rows fail and are logged, but test sends still work.
  - CHANGELOG `Unreleased` → `Added`.
  - Commit: `feat(webhooks): record each operator test send in webhook_events`

### Task 4: Admin error boundary

**Files:**
- Create: `services/cloudflare-license-admin/src/ui/app/WorkspaceErrorBoundary.tsx`
- Modify: `services/cloudflare-license-admin/src/ui/app/App.tsx:87-96` (wrap each feature); `src/ui/main.tsx` (wrap `<App />`)
- Modify: `services/cloudflare-license-admin/src/ui/shared/messages.ts` (fallback copy, if copy is centralised there)
- Test: `services/cloudflare-license-admin/test/admin-ui.workspace.e2e.mjs` (new scenario); `test/admin-ui-e2e-layout.test.mjs:36` (title count)

**Interfaces:**
- Produces: `WorkspaceErrorBoundary` with props `{ name: string; active: boolean; children: ReactNode }`.
  - It renders `children` until a descendant throws while rendering.
  - After that, it renders its fallback only when `active` is true, and `null` otherwise.
  - It resets when `active` goes from false to true, so returning to the tab retries the render.
  - `componentDidCatch` logs `{ event: "admin_ui.render_failed", feature: name }` with the error name only, never the message or props, because they may contain customer data.

- [ ] **Step 1: Write the failing e2e test.** The UI has no test hooks, so inject the fault from the browser side:

```js
test("a feature that fails to render shows a local fallback and leaves the console usable", async ({ page }) => {
  const api = makeAdminApiFixture();
  await page.route("**/api/admin/**", api.route);
  await page.addInitScript(() => {
    const original = Date.prototype.toLocaleString;
    Date.prototype.toLocaleString = function (...args) {
      if (globalThis.__lccFailLocaleRender === true) throw new Error("injected render failure");
      return original.apply(this, args);
    };
  });
  await page.goto("/");
  await page.evaluate(() => { globalThis.__lccFailLocaleRender = true; });
  await page.goto("/#/events"); // Events renders local timestamps through toLocaleString
  const fallback = page.getByRole("alert").filter({ hasText: "This page could not be shown" });
  await expect(fallback).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload the page" })).toBeVisible();
  await page.evaluate(() => { globalThis.__lccFailLocaleRender = false; });
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(fallback).toHaveCount(0);
});
```

  Two things to check before relying on it:
  - Confirm that the Events tab really renders a timestamp through `formatEpoch` (`toLocaleString`) with the fixture's seeded events.
  - If `page.goto("/#/events")` reloads the document, set the flag after it instead. The flag must be on before the Events render and off before Overview.

- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `cd services/cloudflare-license-admin && CI=1 npx playwright test test/admin-ui.workspace.e2e.mjs -g "fails to render"`
  - Expected: FAIL. The page blanks and no fallback appears.

- [ ] **Step 3: Implement the boundary.**

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { name: string; active: boolean; children: ReactNode }
interface State { failed: boolean }

export class WorkspaceErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidCatch(error: Error, _info: ErrorInfo): void {
    console.error(JSON.stringify({ event: "admin_ui.render_failed", feature: this.props.name, error: error.name }));
  }
  componentDidUpdate(previous: Props): void {
    if (this.state.failed && !previous.active && this.props.active) this.setState({ failed: false });
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (!this.props.active) return null;
    return <div className="activityMessage" data-tone="error" role="alert">
      <p>This page could not be shown. Reload the page to try again; other pages still work.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload the page</button>
    </div>;
  }
}
```

  Then:
  - In `App.tsx`, wrap each of the ten features, for example `<WorkspaceErrorBoundary name="events" active={activeTab === "events"}><Events … /></WorkspaceErrorBoundary>`.
  - In `main.tsx`, wrap `<App />` in `<WorkspaceErrorBoundary name="console" active>`.
  - Keep the copy consistent with `doc/architecture/glossary.md`, and within the E2E raw-code rule: the visible text is never a raw snake_case code.

- [ ] **Step 4: Verify.**
  - Run the new scenario again (expected PASS).
  - Update the pinned title count in `admin-ui-e2e-layout.test.mjs:36` by one.
  - Run admin `npm test`, `npm run test:ui`, `CI=1 npm run test:e2e`, typecheck and lint, then root `check:hotspots`, `check:architecture` and `test:docs-accuracy`. Refresh the `doc/architecture/system-map.md` totals if `test:docs-accuracy` asks.

- [ ] **Step 5: Commit.** `fix(admin-ui): contain a feature render failure instead of blanking the console`

### Task 5: Portal Playwright discovers every spec file

**Files:**
- Modify: `services/cloudflare-customer-portal/playwright.config.mjs:8` (`testMatch`)
- Modify: `services/cloudflare-customer-portal/test/portal-ui.e2e.mjs:3-9` (delete the seven side-effect imports)
- Create: `services/cloudflare-customer-portal/test/portal-ui-e2e-layout.test.mjs`
- Modify: `services/cloudflare-customer-portal/package.json` (`test:ui` runs the new layout test)

**Interfaces:**
- Produces: the portal spec set, pinned by name and total title count, mirroring `services/cloudflare-license-admin/test/admin-ui-e2e-layout.test.mjs`.
  - `portal-ui.e2e.mjs` keeps its name and keeps the capability-registry test `customer portal signs in with an 8-digit code and walks every screen without leaking secrets` (`doc/capabilities/registry.json:207`).

- [ ] **Step 1: Write the failing layout test.**

```js
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const expectedSpecs = [
  "portal-ui.consent.e2e.mjs", "portal-ui.devices-results.e2e.mjs", "portal-ui.devices-search.e2e.mjs",
  "portal-ui.e2e.mjs", "portal-ui.license-lifecycle.e2e.mjs", "portal-ui.network-failures.e2e.mjs",
  "portal-ui.nodes.e2e.mjs", "portal-ui.session-expired.e2e.mjs",
];

test("portal browser specs are discovered by pattern, not by imports", () => {
  const config = readFileSync(join(directory, "..", "playwright.config.mjs"), "utf8");
  const match = config.match(/testMatch:\s*(\/.+\/)[,\n]/u);
  assert.ok(match, "playwright.config.mjs must declare a testMatch pattern");
  const pattern = new Function(`return ${match[1]}`)();
  const discovered = readdirSync(directory).filter((path) => pattern.test(path)).sort();
  assert.deepEqual(discovered, expectedSpecs);
  const entry = readFileSync(join(directory, "portal-ui.e2e.mjs"), "utf8");
  assert.doesNotMatch(entry, /^import\s+["']\.\/portal-ui\.[^"']+\.e2e\.mjs["'];/mu, "no spec may run only through a side-effect import");
});
```

  Also pin the total count of `^test\(` titles, and require that they are unique, as the admin layout test does. Compute the number at implementation time and state it in the commit message.

- [ ] **Step 2: Run it and confirm it fails.** Run `node --test services/cloudflare-customer-portal/test/portal-ui-e2e-layout.test.mjs`. Expected: FAIL, because only `portal-ui.e2e.mjs` is discovered and the imports are present.

- [ ] **Step 3: Implement.**
  - Set `testMatch: /portal-ui(\.[^.]+)?\.e2e\.mjs$/`.
  - Delete the seven `import "./portal-ui.*.e2e.mjs";` lines.
  - Add the layout test to `test:ui`.

- [ ] **Step 4: Verify.**
  - Run `cd services/cloudflare-customer-portal && CI=1 npm run test:e2e`. Expected: **156 passed**, the same count as before. Any other count means a spec was lost or run twice.
  - Run `npm run test:ui` and root `npm run check:capabilities`.

- [ ] **Step 5: Commit.** `test(portal): discover every browser spec by pattern and pin the set`

### Task 6: Run the PostgreSQL-parity unit tests in the gate

**Files:**
- Modify: `services/cloudflare-licensing-backend/package.json` (new script `schema:parity:pg:test`)
- Modify: `package.json:42` (`check:schema-parity`)
- Modify: `services/cloudflare-licensing-backend/test/pg-toolchain-contract.test.mjs` (pin the new script)

**Interfaces:**
- Produces: `schema:parity:pg:test`, which is `uv run --directory scripts/pg-parity --locked python -m unittest discover -s ../../test/schema -p "test_*.py"`. It runs as part of `check:schema-parity`, and so of `test:services` and `check:pr`.

- [ ] **Step 1: Write the failing contract assertion** in `pg-toolchain-contract.test.mjs`:

```js
  assert.equal(
    backendPackage.scripts["schema:parity:pg:test"],
    'uv run --directory scripts/pg-parity --locked python -m unittest discover -s ../../test/schema -p "test_*.py"',
  );
  assert.match(rootPackage.scripts["check:schema-parity"], /npm run schema:parity:pg:test --workspace @licensecc\/cloudflare-licensing-backend$/u);
```

  Reuse the variable names the file already has for the two package manifests.

- [ ] **Step 2: Run it and confirm it fails.** Run `node --test services/cloudflare-licensing-backend/test/pg-toolchain-contract.test.mjs`. Expected: FAIL, because the script is missing.

- [ ] **Step 3: Implement.**
  - Add the backend script.
  - Append `&& npm run schema:parity:pg:test --workspace @licensecc/cloudflare-licensing-backend` to root `check:schema-parity`.

- [ ] **Step 4: Verify.**
  - Run `npm run check:schema-parity`. Expected: both parity lines, then `Ran 2 tests … OK`.
  - Prove that the tests bite: temporarily change `_dropped_names` in `scripts/check-pg-parity.py` to read only `statement.this`, re-run, and expect a failure. Restore it and re-run to confirm OK.
  - Run `npm run test:docs-accuracy` and `npm run test:workflow-pins`.

- [ ] **Step 5: Commit.** `test(pg-parity): run the parity checker's mutation tests in check:schema-parity`

### Final check

- [ ] Run the full gate on the branch head: `npm ci`, then `npm run check:pr`. The only acceptable failures are the 7 known Node-24 `staging-lease-drill` tests.
- [ ] Also run the remaining steps: backend `test:sql`/`test:pg`, `test:admin`, `test:portal`, `test:backup`, `check:schema-parity`, and both apps' `test:e2e`.
- [ ] Record the commit, the commands and the outcomes in the PR description. Name any surface that was not run.
