# UI/UX workflow remediation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task follows the same cycle:
> 1. write the failing test named in **Test**;
> 2. see it fail;
> 3. implement **Change**;
> 4. see it pass;
> 5. run **Check**;
> 6. commit.

Status: proposed; reviewed once (Fable, 2026-09-23) and revised; not executed.

**Goal:** Fix every finding from the 2026-09-23 UI/UX workflow review of the customer portal and admin console, including the journeys that cross both.

**Architecture:** Six workstreams, one PR each, merged in the order at the end. Every change stays in its owning service (`doc/architecture/change-guide.md`, ADR 0001), and the server stays the policy authority. Code moves to `packages/` only where two deployables use it:
- the trial-deadline SQL (C5);
- the order-intent list (E4).

**Tech stack:**
- React + Vite UIs;
- Cloudflare Workers + D1 (Postgres parity);
- C++17 device-identity library with .NET/Java/Python SDK bridges;
- Playwright end-to-end tests and `node:test`.

**Spec:** the 2026-09-23 UI/UX review (four lanes: portal, admin, cross-app journeys, performance/accessibility). The **Finding → task map** below is authoritative. Each row cites evidence to re-check in the repo.

## Global Constraints

- **Gate:** `npm run check:pr` (Python 3.12, uv 0.12.5). Only known exception: backend `test/staging-lease-drill.test.mjs` fails on Node 24 hosts; CI's Node must pass it.
- **UI changes:** also run `test:ui` and `test:e2e` for the touched app.
- **Native changes:** also run `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`, `npm run test:sdks`, and WSL Linux ctest (the known DMI-skew failures are exempt).
- **Contract baselines:** change only via `npm run write:contract-baselines`. Every PR re-runs it after rebasing on `main`: A3, A4, A6, B3 and C5 touch the portal baseline; B1, B2, E2, E3 and E4 touch the admin baseline.
- **Portal routes:** they are static literals, GET/POST only, and `app.ts` asserts the route count. A new route updates the inventory, the count, OpenAPI and the baseline.
- **Migrations:** none are planned. If one becomes necessary, it needs D1, `schema.sql`, `schema.pg.sql`, `check:schema-parity`, and the backup restore-drill signature.
- **Gated doc totals:** refresh the `doc/architecture/system-map.md` line totals when `test:docs-accuracy` requires it. `check:hotspots` must pass without raising a baseline (the change guide forbids ratcheting up). E0 exists so that `controls.tsx` shrinks before E6 and E9 touch it.
- **Public C ABI:** changes to `include/licensecc/device_bound.h` get a CHANGELOG compatibility note and a `doc/api/device_identity.rst` update. They must keep struct size and version unchanged (B4).
- **Hygiene:** no secrets, no local Wrangler config, no generated trees. Commits end with the session attribution trailer.
- **Copy:**
  - customer-facing text never shows a snake_case code as the main text; codes and request ids go under "Technical details";
  - terms follow the F1 glossary, which lands first;
  - portal dates use the existing UTC formatter `formatEpoch` (`portal/src/ui/portalWorkflow.ts:146`).

## Review Focus

1. **Duplicate-account guard (A1).** A new Google/GitHub user whose email matches no customer and no password login still self-registers. Pinned in A1.
2. **Device capacity on the consent page (B3).** Capacity shown as full disables Approve; "Check again" re-inspects. The approve request sends no capacity claim; the server decides. Pinned in B3.
3. **Unknown codes (C1, E9).** Unknown codes render the generic fallback and reference, never a raw code. Pinned in C1 and E9.
4. **Admin dates in non-UTC zones (E7).** The displayed validity date equals the typed date. Pinned in E7 (the portal already renders UTC).
5. **Batch partial failure (E5).** 20 rows in chunks of 4, and chunk 3 returns 500: the UI reports 8 done, 4 outcome-unknown (reconcile with chunk 3's key) and 8 not attempted, with no further requests. Pinned in E5.

## Finding → task map

| # | Finding (evidence) | Task |
|---|---|---|
| 1 | Operator-added user + Google/GitHub creates a second, empty account (`portal/src/worker/oauth/accounts.ts:29`; admin `groups/customers/create.ts:35`) | A1 |
| 2 | Emailed sign-in link lands on raw JSON (`portal/src/worker/routes/auth.ts:271-273`) | A2 |
| 3 | Suspended customer told "password incorrect"; no support contact (`routes/password.ts:18`, `oauth/accounts.ts:26`) | A3 |
| 4 | Signed-in identity never shown (`self-service.ts:29-31`, `ConsentFeature.tsx:141`) | A4 |
| 5 | Add user uses a plaintext initial password; recovery copy contradicts behaviour (`AddUser.tsx:47`, `PasswordSettings.tsx:38`, portal `README.md:320-322`) | A5 |
| 6 | Linked providers can't be unlinked; no deletion path (`AccountFeature.tsx:28-29`) | A6 |
| 7 | No admin path to create license records; catch-all `protected_creation_conflict` (`create-enforcement.ts:71`; admin `README.md:40-48`) | B1 |
| 8 | Protected grant device limit can't be seen or set; policies not editable; all customers loaded (`EntitlementEditor.tsx:60`, `EntitlementRelationships.tsx:26`) | B2 |
| 9 | Device limit discovered only after approval (`ConsentFeature.tsx:126`, `bound_issue.mjs:75-83`) | B3 |
| 10 | Native maps `device_limit_reached` to CONFLICT with no detail; example says "result 7" (`bound_wire.cpp:62-64`, `enrollment_work.hpp:47-49`) | B4 |
| 11 | Operators can't see capacity or denied attempts | B5 |
| 12 | Raw codes are the main portal feedback (`shared/api.tsx:41`, `portalWorkflow.ts:119`) | C1 |
| 13 | Network failures silent (`api.tsx:10-17`, `DownloadsFeature.tsx:46`, `AuthFeature.tsx:82,115,134`) | C2 |
| 14 | Mid-session 401 recognised only on Devices/Connect (`usePortalData.ts:47`) | C3 |
| 15 | Any refresh failure says "Seat released" (`App.tsx:66,69`) | C4 |
| 16 | No next step on inactive licenses; trial end hidden; download offered on inactive rows (`portalWorkflow.ts:262-265`, `self-service.ts:35`) | C5 |
| 17 | Sign-in copy ignores configured methods; lost focus; static title; label-in-name (`PasswordSignIn.tsx:9`, `AuthFeature.tsx:189`, `AppsFeature.tsx:40`, `index.html:6`) | C6 |
| 18 | Devices page mixes vocabularies; search covers legacy only; "View devices" drops the app (`DeviceRegistrations.tsx:11-14`, `AppsFeature.tsx:24`) | D1 |
| 19 | Results far from control; seat state and expiry hidden; `pool_exhausted` copy wrong (`App.tsx:119`, `portalWorkflow.ts:121`) | D2 |
| 20 | Sign-out orphans browser seats (`App.tsx:84`, `DevicesFeature.tsx:337`) | D3 |
| 21 | Legacy Release `window.confirm` doesn't name the device; three dialog patterns (`DevicesFeature.tsx:325,426-437`) | D4 |
| 22 | Primary hover contrast 1.2:1; error colour; Sign out alignment; mobile cell (`styles.css:79,83,135`) | D5 |
| 23 | License picker labelled by fingerprint tail (`LicenseChoice.tsx:6,19`) | D6 |
| 24 | Admin refetch storm on filter and tab change; blanking; lost selection; double render (`Entitlements.tsx:69,120-128,151`, `EntitlementList.tsx:81-82`) | E1 |
| 25 | Deep links drop the entitlement id; Expiring soon shows raw ids (`search/workflow.ts:29`, `Reports.tsx:147`, `Licenses.tsx:95`) | E2 |
| 26 | Events hide the reason; no filters or paging (`Events.tsx:12-24`, `query.ts:53`) | E3 |
| 27 | Webhook placeholder types never match; no edit or test (`Webhooks.tsx:298`, `webhook.mjs:91-101`) | E4, E4b |
| 28 | Batch capped at 4 per operation (`src/shared/api.ts:246`) | E5 |
| 29 | Uniform confirmation friction; Retire primary; projection Apply has no dialog (`controls.tsx:1071-1082`, `ProtectedConnections.tsx:130`, `usePlanProjectionWorkflow.ts:141`) | E6 |
| 30 | Validity entered in UTC, listed in local time (`dates.ts:8`, `format.ts:12`) | E7 |
| 31 | Drill-downs not in history; stale unsaved prompt (`useCatalogWorkspace.ts:37`, `navigation.tsx:9-13`) | E8 |
| 32 | Admin raw-code banners, stale across tabs (`ui/shared/api.ts:30-33`) | E9 |
| 33 | Inspector far away; menus stay open; density; hidden nav; wrong empty state; unstyled range buttons (`Entitlements.tsx:627`, `Sidebar.tsx:52`, `EntitlementList.tsx:55`) | E10 |
| 34 | Customer and operator vocabularies diverge | F1 |
| 35 | Drifted style tokens (`portal styles.css:374` `#203026` vs admin `console.css:145` `#203020`) | F2 |
| 36 | Admin h1 hidden on mobile; 18px checkboxes; 21px summaries (`console.css:33`) | F3 |
| 38 | Admin dual native/fallback dialog (`controls.tsx:216-217,1123-1129`) | F5 |
| 39 | `OperatorControlsProvider` 785 lines (`controls.tsx:349-1132`) | E0 |

**Decided — no change:**
- **#37 code splitting.** Bundles are 89 kB and 135 kB gzipped, the admin sits behind Access, and splitting adds loading states and brittle size targets for no measured user cost.
- **Row virtualization.** The server caps pages at 100 rows (`admin/src/worker/query.ts:11-12`); double rendering is fixed in E1.
- **A shared `api()` package.** C2 fixes the portal's transport gap.
- **A UI-tokens package.** ADR 0001 has no UI package category; F2 prevents drift with a test instead.
- **Dark patterns.** None found.

---

## Workstream F1 — Glossary first (branch `fix/ux-f1-glossary`)

### F1: One glossary, applied to both apps
**Files:** `doc/architecture/glossary.md` (new, added to the architecture toctree), the copy in both UIs, and the e2e text assertions in both apps.
**Change:** apply these canonical terms everywhere:

| Concept | Customer term | Operator term |
|---|---|---|
| Entitlement row | license | license (entitlement) |
| Protected binding | connected device · "Connection ID" · Disconnect | connection · "Connection ID" · Disconnect |
| Legacy device | activated device · Release | activated device · Release |
| Floating seat | seat · Release seat | seat |
| Status | active / suspended / revoked / expired | same |
| Capacity | device limit | device limit |

API codes and JSON fields are unchanged.
**Test:** a copy test fails when a retired term appears in either UI source: `Binding:` (`ProtectedConnections.tsx:114`), `Retire connection`, `Registered nodes` (`CustomerAccess.tsx:80`), or `"enabled"` as a displayed status (`portalWorkflow.ts:265`).
**Check:** both apps' `test:ui` and `test:e2e`; `check:docs`.

## Workstream A — Sign-in and accounts (branch `fix/ux-a-accounts`)

### A1: OAuth never duplicates a password-login account
**Files:** `portal/src/worker/oauth/accounts.ts:29`, `src/ui/features/auth/ProviderSignIn.tsx` (ERRORS map); Test: `test/portal-worker-oauth.test.mjs`.
**Change:**
```ts
if (await db.prepare("SELECT id FROM customers WHERE lower(email) = ? UNION ALL SELECT customer_id FROM portal_passwords WHERE email_lower = ? LIMIT 1")
  .bind(identity.email, identity.email).first()) throw new Error("account_link_required");
```
ERRORS copy for `account_link_required`: "An account already uses this email. Sign in with your password, then connect Google or GitHub under Account."
**Test:**
- Seed `customers.email=''` plus `portal_passwords.email_lower='alice@example.com'`. OAuth callback for alice → redirect has `auth_error=account_link_required`, and the customer count is unchanged.
- RF1: a new email creates exactly one customer.

**Check:** portal `npm test`.

### A2: The magic link signs in and lands on Apps
**Files:** `routes/oauth.ts:19-23` (move `redirect()` to `worker/support.ts` and export it), `routes/auth.ts:210-273` (`redeemAndMintSession`, `handleMagicRedeem`), `ui/features/auth/ProviderSignIn.tsx:30-37`.
**Change:** for the form-encoded redeem path:
- success → 303 to `${origin}/#/apps` with the session cookie;
- `invalid_otp` → 303 to `/?auth_error=link_expired`;
- `rate_limited` → `/?auth_error=rate_limited`;
- `config_error`/`invalid_request` → `/?auth_error=sign_in_failed`.

JSON callers are unchanged. Add ERRORS copy for `link_expired` ("This sign-in link has expired or was already used. Request a new code.") and for `rate_limited`.
**Test:** replace the 200 JSON assertion (`test/portal-worker-auth.test.mjs:348-360`) with 303 + `Location` + `set-cookie`. A reused token returns 303 to `link_expired`. Each error branch redirects. The JSON-caller test still passes.
**Check:** portal `npm test`, `test:e2e`.

### A3: Suspended accounts are told so, with a support contact
**Files:**
- portal: `worker/env.ts`, `worker/support.ts` (new `supportContact(env)` validator), `routes/oauth.ts:87,92-96`, `routes/password.ts:18`, `oauth/accounts.ts:26`, `ui/features/auth/passwordMessages.ts`, new `ui/shared/SupportContact.tsx`, `wrangler.example.jsonc`, `README.md`;
- admin: `src/ui/features/customers/workflow.ts:27-30`.

**Change:**
- `PORTAL_SUPPORT_CONTACT` accepts an `https:` URL or a `mailto:` address; anything else counts as unset. It needs its own validator, because `canonicalHttpsOrigin` rejects `mailto:` and paths. The providers envelope gains `support: string | null`.
- `password.ts`: look up the credential without the status filter. A correct password on a non-active customer → 403 `account_suspended`; a wrong password stays 401 `invalid_credentials`.
- `accounts.ts:26`: an existing identity on a disabled customer throws `account_suspended`, and the `oauth.ts:87` callback `fail()` maps it.
- Email codes stay silent for suspended accounts (`portal_otp.mjs:199`, no enumeration).
- Copy: "This account is suspended. {SupportContact}." Every "Contact your administrator" renders `<SupportContact/>`.
- The admin disable confirm adds "The customer is not notified."

**Test:** worker: correct password + disabled → 403 `account_suspended`; wrong password → 401; OAuth identity on a disabled customer → `auth_error=account_suspended`; providers includes `support`; the validator rejects `javascript:` and `http:`. UI unit test for `SupportContact` with and without a value.
**Check:** portal `npm test`, `test:ui`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### A4: Show which account is signed in
**Files:** `routes/self-service.ts:29-31` (`apiMe`), `worker/openapi/paths/self-service.ts:42` (add `email: {type:["string","null"]}`), `ui/app/App.tsx` (header), `ui/features/consent/ConsentFeature.tsx:141`, `ui/features/apps/AppsFeature.tsx` (empty state).
**Change:**
- `/me` returns `{customer_id, email}`, where `email` = `customers.email` if non-empty, otherwise `portal_passwords.email_lower`, otherwise the first `portal_identities.email`, otherwise `null`.
- The header shows "Signed in as {email}".
- Consent shows "Connecting to {email}".
- The empty state shows "Signed in as {email}. No apps are assigned to this account yet."

**Test:** a worker test for each email source; e2e checks the email on the header, empty-state and consent screens.
**Check:** portal `npm test`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### A5: No plaintext initial password by default
**Files:** admin `src/worker/groups/customers/create.ts:20` (password optional), `src/ui/features/customers/AddUser.tsx:47,53`, admin `README.md`, `doc/operations/cloudflare-setup.md:251-254`; portal `src/ui/features/account/PasswordSettings.tsx:38`, portal `README.md:320-322`.
**Change:**
- Add user defaults to **Invite**: create the customer with a random, never-disclosed password hash.
- The success panel says "Ask {email} to open {portal origin} and choose 'Forgot your password?' to set a password." This works because the reset branch of `complete()` (`password-email.ts:100-104`) adopts the empty contact email, and recovery is allowed for empty-email accounts (`:45-47`).
- "Set an initial password" stays as a secondary option with the current warning. It is needed when portal email isn't configured.
- `PasswordSettings` copy follows eligibility: "Use 'Forgot your password?' once to verify this email."
- The two READMEs and the setup guide match.

**Test:** admin worker: Invite without a password → a customer with an unusable hash. Portal: that account's reset → complete signs in and sets `customers.email`. Copy test: `PasswordSettings` text matches reset eligibility.
**Check:** admin + portal `npm test`, `test:e2e`.

### A6: Unlink sign-in providers; document account deletion
**Files:** portal `worker/routes.ts` (inventory), `app.ts:60` (35 → 36), `routes/oauth.ts` (beside `GET /portal/v1/auth/identities`), openapi, `ui/features/account/AccountFeature.tsx`; `doc/operations/customer-account-deletion.md` (new, linked from `doc/operations/index.rst`).
**Change:**
- New `POST /portal/v1/auth/identities/unlink {provider}`: authenticated session, `isCrossSite` check.
- Allowed only if another method remains: a password row, another identity, or a non-empty contact email with email codes configured. Otherwise 409 `last_sign_in_method`.
- On success, revoke every other active session of the customer with `auth_method='oauth'` and keep the current one.
- The UI shows "Disconnect" per identity, with a confirm.
- The doc gives the operator deletion procedure: disable, scrub PII columns, keep audit rows.

**Test:** worker: unlink allowed; last method refused; other OAuth sessions revoked and the current one kept. E2e unlink.
**Check:** portal `npm test`, `test:e2e`, `check:docs`; `write:contract-baselines` + `test:contracts`.

## Workstream B — Protected onboarding and device limits (branch `fix/ux-b-protected`)

### B1: Operators create license records; protected-create errors name the rule
**Files:** admin `src/worker/groups/customers.ts` (register), new `groups/customers/licenses.ts`, `routes.ts`, `dispatch.ts`, `openapi/paths/customers.ts`, `test/routes-table.test.mjs`, `groups/entitlements/create-enforcement.ts`, `ui/features/entitlements/{EntitlementRelationships.tsx,EntitlementEditor.tsx}`, admin `README.md:40-48`, `doc/operations/cloudflare-setup.md:254-256`.
**Change:**
- `POST /api/admin/customers/{id}/licenses {project, label}` inserts a `licenses` row (id `lic_<uuid>`) using the existing mutation-idempotency pattern.
- The protected form offers "Create license for {project}" when the lookup is empty.
- Add "Generate fingerprint" (32 random bytes as lowercase hex).
- On `protected_creation_conflict`, run one diagnostic SELECT and return `data.reason` ∈ {`customer_inactive`, `license_missing`, `license_customer_mismatch`, `fingerprint_in_use`, `plan_assignment_conflict`, `lease_history_exists`, `policy_mismatch`, `invalid_trial`, `invalid_capacity`, `unknown`}. The UI maps each reason to a sentence.
- The docs describe the console path.

**Test:** worker: create license, idempotent replay, and one diagnostic per reason. A new `test/admin-ui.onboarding.e2e.mjs` covers Add user → create license → protected grant, mirroring backend `test/e2e/protected-admin-enrollment.test.mjs:23-24` without its SQL insert.
**Check:** admin `npm test`, `test:sql`, `test:e2e`; backend `test:e2e`; `write:contract-baselines` + `test:contracts`.

### B2: Device limit visible and settable; policies editable; customer typeahead
**Files:** admin `groups/entitlements/{validation.ts:114-171,create-enforcement.ts}`, openapi, `ui/features/entitlements/{EntitlementEditor.tsx,workflow.ts:86-100,EntitlementRelationships.tsx:26}`, `ui/features/policies/{Policies.tsx,workflow.ts}`.
**Change:**
- **Create:** accept `max_active_devices` (1..1000000) only when no policy is selected. Write it through the runtime's `setEntitlementCapacity` (`packages/cloudflare-runtime/src/d1/entitlement_mutation.mjs:570`), appended to the create batch via `extraStatements` before `protectedCreateAssertion`. With a policy, the field is read-only and labelled "(from policy …)".
- **PATCH:** `max_active_devices` calls `setEntitlementCapacity`. Map the existing trigger abort `capacity_in_use` (`schema.sql:1110`, ADR 0006) to 409 `capacity_in_use`. The UI says "{n} devices are connected; disconnect one first."
- **Policies:** options read `{name} · {n} devices · {project}`, filtered by project, with a "Create policy…" link that returns to the draft. Policies get an Edit form on the existing `PATCH /api/admin/policies/{id}`.
- **Customer field:** a typeahead on the existing `GET /api/admin/customers?q=…&limit=20` (debounced 300 ms) instead of `loadAllExactPages`.

**Test:** worker: create with limit 3 and no policy → 3; PATCH to 5; PATCH below occupancy → 409 `capacity_in_use`. E2e: choosing a policy shows "3 devices"; opening the form sends ≤1 customers request.
**Check:** admin `npm test`, `test:sql`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### B3: The consent page shows devices in use and blocks a full license before approval
**Files:**
- backend: `src/device/bound_consent_page.mjs` (`page` CTE), `src/device/bound_consent.mjs:59-61` (row mapping);
- portal: `src/shared/consent.ts:35-38` (both `exact` key sets), `worker/openapi/paths/device-consent.ts`, `ui/shared/consentApi.ts`, `ui/features/consent/{ConsentFeature.tsx:126,LicenseChoice.tsx}`, `test/portal-ui.consent.e2e.mjs` (fixture entitlements).

**Change:** add to the `page` CTE:
```sql
(SELECT count(*) FROM device_bound_bindings b WHERE b.project=e.project AND b.feature=e.feature
  AND b.license_fingerprint=e.license_fingerprint
  AND (b.state='active' OR (b.state='retiring' AND b.hold_until>a.now))) AS page_devices_in_use,
(SELECT min(b.hold_until) FROM device_bound_bindings b WHERE b.project=e.project AND b.feature=e.feature
  AND b.license_fingerprint=e.license_fingerprint AND b.state='retiring' AND b.hold_until>a.now) AS page_slot_free_at
```
- Map these to `devices_in_use` and `slot_free_at`, and add them to both `exact` key sets and the `additionalProperties:false` schema.
- The UI shows "{in_use} of {limit} devices in use". When full, disable Approve and show "All {limit} device slots are in use. Disconnect a device under Devices, then check again," plus "A recently disconnected slot frees at {time}" when `slot_free_at` is set.
- Add a "Check again" button that re-inspects.

**Test:**
- Backend `test/sql/bound-consent.test.mjs`: at capacity, in_use == limit; a retiring hold counts until `hold_until`.
- RF2 e2e: inspect returns full → Approve disabled → Check again returns a free slot → Approve enabled. The approve body is still `{attempt_handle, entitlement_id, expected_attempt_revision}`.

**Check:** backend `test:sql`; portal `test:e2e`; `write:contract-baselines` + `test:contracts`.

### B4: Native reports "device limit reached" as an outcome detail
**Files:**
- `include/licensecc/device_bound.h:116`: rename `uint32_t reserved;` in `LccDeviceBoundOutcome` to `uint32_t denial_detail; /**< LCC_BOUND_DETAIL */`, and add `LCC_BOUND_DETAIL_NONE = 0` and `LCC_BOUND_DETAIL_DEVICE_LIMIT = 1`.
- `src/library/device_identity/bound_wire.{hpp,cpp:62-64}`: `BoundWireResponse.detail`.
- `bound_public_results.cpp:36,73`, `bound_client.cpp:108`, `bound_enrollment.cpp:131-135`, `feature_session.cpp:45,184` (unchanged mapping; verify it).
- `test/library/device_identity/{device_bound_wire_test.cpp:220,feature_session_failures_test.cpp:129}`.
- SDK outcome marshalling and exposure: `sdks/dotnet/src/Licensecc.Client/{DeviceBoundConfiguration.cs,DeviceBoundClient.cs}`, `sdks/java/src/main/java/io/licensecc/client/DeviceBoundClient.java`, `sdks/python/src/licensecc/device_bound.py`.
- `examples/device_bound/enrollment_work.hpp:47-49`, `doc/api/device_identity.rst`, `CHANGELOG.md`.

**Change:**
- The primary result stays `LCC_BOUND_CONFLICT`. Exchange 409 `device_limit_reached` sets `denial_detail=DEVICE_LIMIT`.
- Struct size and version are unchanged, so old SDKs ignore the field. SDKs expose `Outcome.Detail`.
- Example: when `result == CONFLICT && denial_detail == DEVICE_LIMIT`, print "All device slots for this license are in use. Disconnect a device in the customer portal (Devices), then try again."
- Compatibility note: an additive outcome field; no enum change.

**Test:** the wire test at `:220` keeps `conflict` and asserts `detail`; public exchange test → detail 1; SDK tests read detail 1; old-layout consumers are unaffected (size check).
**Check:** WSL ctest (device-identity presets), `test:sdks`, build-purity dev-debug, `check:docs`.

### B5: Operators see capacity and denied attempts (no migration)
**Files:** backend `src/device/bound_issue.mjs:75-83`; admin `groups/customers/bindings.ts:27-31` (read), `ui/features/customers/ProtectedConnections.tsx`.
**Change:**
- Before `deny("device_limit_reached")`, record the denial with a 15-minute dedupe. `usage_events.event_type='denied'` is already allowed (`schema.sql:632`):
  ```sql
  INSERT INTO usage_events (project,feature,license_fingerprint,event_type,device_key_id,reason,ts)
  SELECT ?,?,?,'denied',?,'device_limit_reached',unixepoch()
  WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE project=? AND feature=? AND license_fingerprint=?
    AND device_key_id=? AND reason='device_limit_reached' AND ts>unixepoch()-900)
  ```
- The admin protected-connections read returns `in_use` (same predicate as `bound_issue.mjs:75-77`), `limit`, and the last 5 denied rows. The UI shows "{in_use} of {limit} in use" and "Recent refused connections".

**Test:** backend SQL: one denial writes one row, and a repeat within 15 minutes writes none. The admin worker read returns in_use, limit and denied. E2e shows them.
**Check:** backend `test:sql`, `test:pg`; admin `npm test`, `test:e2e`.

## Workstream C — Portal feedback and lifecycle (branch `fix/ux-c-portal-feedback`)

### C1: A human message for every code, with a reference fallback
**Files:** `portal/src/ui/portalWorkflow.ts:119` (`RESULT_CODE_COPY`, the canonical map for `StatusLine`), `ui/shared/api.tsx:31-44`; Test: `test/portal-ui-workflow.test.mjs`, `test/portal-ui.e2e.mjs:548`.
**Change:**
- Cover the codes that reach `StatusLine`:
  - envelope codes from `routes/auth.ts`, `routes/self-service.ts`, `support.ts` and `app.ts`;
  - `BACKEND_PROXY_ERROR_MANIFEST`;
  - the local `localMessage(...)` codes;
  - the dynamic `download_failed_<status>` family, matched by prefix.
- `passwordMessage()` and `ProviderSignIn` ERRORS keep their own domains.
- Success copy: `otp_requested` → "Check your email for a sign-in code." `logged_out` → "You're signed out." `checkout_ok` → "Seat started." `release_ok` → "Seat released." `device_released` → "Device released." `download_started` → "Download started."
- Unknown codes → "Something went wrong. Reference {request_id}."
- `StatusLine` renders the human text, with the code and id inside `<details>Technical details</details>`.

**Test:** the unit test collects codes from those four route files' `envelope(reqId, "` literals, the manifest and the local codes, and fails on any unmapped code. An unknown code → fallback (RF3). E2e asserts human text instead of `/release_ok/`.
**Check:** portal `test:ui`, `test:e2e`.

### C2: Network failures are visible
**Files:** `ui/shared/api.tsx:10-17`, `ui/features/downloads/DownloadsFeature.tsx:46`, `ui/features/auth/AuthFeature.tsx:82,115,134`.
**Change:**
- `api()` catches a fetch rejection → `{ok:false, code:"network_unavailable", request_id:""}` → "Couldn't reach the portal. Check your connection and try again."
- The download uses the same guard.
- A failed logout shows "Sign-out didn't complete. You're still signed in — try again."

**Test:** e2e with `route.abort()` for request code, verify, logout, download and seat start: the message shows and no `pageerror` fires.
**Check:** portal `test:e2e`.

### C3: A mid-session 401 returns to sign-in on every `api()` path
**Files:** `ui/shared/api.tsx`, `ui/features/data/usePortalData.ts:47`, `ui/app/App.tsx`.
**Change:**
- `api()` gains an `onUnauthorized` hook, set once by App, that calls `auth.retrySession()` and shows "Your session ended. Sign in again."
- Keep the existing feature handlers for `bindingApi.ts` (raw fetch) and `consentApi.ts`; they already handle 401.

**Test:** e2e:
- session expires mid-download → sign-in with that message;
- the same after a seat action;
- a consent page with a saved mutation survives 401 → sign-in → resume.

**Check:** portal `test:e2e`.

### C4: Refresh failures say what failed
**Files:** `ui/app/App.tsx:66,69`.
**Change:** `refreshPortalData` uses `account_refresh_failed`; the seat code is used only in `confirmSeatRelease`.
**Test:** e2e: a failing Retry → "Account refresh failed…" with exactly one retry control.
**Check:** portal `test:e2e`.

### C5: Lifecycle states give a next step; trial end is visible
**Files:**
- Move `boundTrialSql`/`boundTrialDeadlineSql` from `services/cloudflare-licensing-backend/src/device/bound_trial.mjs:29,48` to `packages/cloudflare-runtime/src/device/bound_trial.mjs` (+ `.d.ts`, a package `exports` subpath). The backend re-imports it.
- `portal/src/worker/routes/self-service.ts:35` (select `trial_ends_at`), openapi, `ui/portalWorkflow.ts:146-155,262-265`, `ui/features/entitlements/EntitlementsFeature.tsx:21`, `ui/features/downloads/DownloadsFeature.tsx`, `ui/features/apps/AppsFeature.tsx`.

**Change:**
- `trial_ends_at` is null for activation trials not yet started (no prospective start); the copy then says "Trial starts when you activate".
- Status text, with dates from `formatEpoch`:
  - expired → "Expired on {date}. {SupportContact} to renew.";
  - disabled → "Suspended. {SupportContact}.";
  - revoked → "Revoked.";
  - not yet valid → "Starts {date}.".
- Inactive rows offer no "Activate and download".
- Trial: "Protected device · Trial · ends {date}".
- `formatEpoch` null → "No start date" / "No end date", via separate start and end helpers.
- The Apps list shows an attention badge for apps with a license that is expired, suspended or revoked.

**Test:** worker: an ended activation trial returns `trial_ends_at`; an unstarted one returns null. E2e: the copy per status, no download on inactive rows, the trial end date.
**Check:** portal `npm test`, `test:e2e`; backend `test:sql`; `check:architecture`; `write:contract-baselines` + `test:contracts`.

### C6: Sign-in copy, focus and titles
**Files:** `ui/features/auth/{PasswordSignIn.tsx:9,PasswordAction.tsx,AuthFeature.tsx:189,passwordMessages.ts:9}`, `ui/features/account/PasswordSettings.tsx:39`, `ui/app/App.tsx`, `ui/features/apps/AppsFeature.tsx:40`, `index.html:6`.
**Change:**
- Recovery hints list only the configured methods.
- In password-only mode: "{SupportContact} to reset your password."
- One rate-limit sentence, "Too many attempts. Try again in {n} minutes."; resend shows a countdown.
- An expired action link shows "Request a new link", which opens the reset form.
- Focus moves to the new `h1` on each auth step. The code-step `h1` is "Check your email".
- `document.title` is "{View} · Licensecc".
- The aria-label reads "View licenses for {app}".

**Test:** e2e: focus per step, title per view, the password-only hint.
**Check:** portal `test:e2e`.

## Workstream D — Portal devices and seats (branch `fix/ux-d-portal-devices`)

### D1: One devices page in customer terms
**Files:** `ui/features/devices/{DevicesFeature.tsx,DeviceRegistrations.tsx:11-14,ProtectedNodes.tsx}`, `ui/features/apps/AppsFeature.tsx:24`, `ui/shared/navigation.ts`.
**Change:**
- Sections: **Connected devices**, **Activated devices (older app versions)**, **Browser seats**. Verbs per F1.
- One search box above all sections filters by name, ID and app.
- "View devices" passes `project`.

**Test:** e2e: searching a connected device's label finds it; the link from an app opens the page filtered to it.
**Check:** portal `test:e2e`.

### D2: Results next to the control; seat state visible
**Files:** `ui/app/App.tsx:119`, `ui/features/devices/DevicesFeature.tsx`, `ui/portalWorkflow.ts:121`.
**Change:**
- Each card or row gets its own `role="status"` line; the page-level line is used only for page results.
- Seat cards show "Active until {time}".
- Start seat shows "Uses 1 of {pool} shared seats until released or it expires."
- `pool_exhausted` reads "All seats are in use. {SupportContact} to free one."
- The dialog label becomes "This browser".

**Test:** at 390x844 the result line is in the viewport after start, release and download; expiry is visible.
**Check:** portal `test:e2e`.

### D3: Signing out doesn't orphan browser seats
**Files:** `ui/app/App.tsx:84`, `ui/features/devices/DevicesFeature.tsx:337`.
**Change:**
- Sign-out best-effort releases this browser's seats, shows "Released {n} browser seats", then signs out.
- Failed releases stay in storage keyed by `customer_id` and are listed again after sign-in.

**Test:** e2e: sign out with 1 seat → release is called. With release failing → sign in again → the seat is listed and releasable.
**Check:** portal `test:e2e`.

### D4: Dialogs name their target; one native pattern
**Files:** `ui/features/devices/DevicesFeature.tsx:325` (legacy release), `:426-437` (SeatReleaseDialog), `ProtectedNodes.tsx:18,36,89`.
**Change:**
- Replace `window.confirm` and the manual SeatReleaseDialog with the native `<dialog>` pattern from `ProtectedNodes.tsx`, naming the device ID, app and feature.
- On close, focus returns to the section heading, matching `ProtectedNodes.tsx:18,36`.

**Test:** e2e: the confirm text contains the device ID, Escape cancels, and focus lands on the section heading.
**Check:** portal `test:e2e`.

### D5: Visual fixes
**Files:** `ui/styles.css:79,83,106-114,135`, `ui/app/App.tsx:114`, `ProtectedNodes.tsx` (disconnecting cell).
**Change:**
- `button.primary:hover:not(:disabled){background:#d4d4d4;border-color:#d4d4d4}`.
- Auth errors use the error colour.
- The header layout right-aligns Sign out.
- Wrap the "Disconnecting · slot available" text in a `<span>`.

**Test:** hover each primary button → computed contrast ≥4.5:1. Sign out's right edge equals the `.headerInner` content box's right edge (outer right minus `padding-right`) ±2px.
**Check:** portal `test:e2e`.

### D6: License choice shows meaningful labels
**Files:** `ui/features/consent/LicenseChoice.tsx:6,19`.
**Change:** options read "{feature} · expires {date|never} · {in_use}/{limit} devices", using B3 data. The fingerprint stays under "License details".
**Test:** e2e: the option text contains the expiry and usage and not the 12-character fingerprint tail from `shortReference`.
**Check:** portal `test:e2e`.

## Workstream E — Admin efficiency (branch `fix/ux-e-admin`)

### E0: Split `OperatorControlsProvider` (first, so E6 and E9 don't trip the hotspot ratchet)
**Files:** `admin/src/ui/shared/controls.tsx:349-1132` → new `shared/useConfirmDialog.tsx`, `shared/useActionNotice.ts`, `shared/useKeyedMutation.ts`; `scripts/hotspot-baseline.json` (lower `controls.tsx`).
**Change:** extract the three hooks with no behaviour change; `controls.tsx` < 400 lines.
**Test:** a unit test per hook, plus the full admin e2e.
**Check:** admin `test:ui`, `test:e2e`, `check:hotspots`.

### E1: No refetch storm, no blanking, one render
**Files:** `admin/src/ui/features/entitlements/{Entitlements.tsx:69-128,151,EntitlementList.tsx:76,81-82}`; debounce and no-blanking also in `features/licenses/Licenses.tsx:70-74`, `features/policies/Policies.tsx:59-62`, `features/webhooks/Webhooks.tsx:138-141`; new `shared/useDebouncedValue.ts`, `shared/useMediaQuery.ts`.
**Change:**
- In Entitlements, split the key: `fenceKey` includes `active` (request fence) and `filterKey` excludes it (reload trigger). A filter change calls `refresh` (the list only), not `refreshCore`, on a 300 ms-debounced value.
- All four lists keep the previous rows rendered while loading (`aria-busy`).
- Selection survives unless its row disappears.
- Render the table or the cards via `useMediaQuery("(max-width: 1023px)")`.

**Test:** e2e request log using `page.fill("DEFAULT")` (a single change event): ≤1 entitlements request and 0 summary/events requests. Entering or leaving the tab with no change → 0 requests. Rows stay visible. The DOM has `tr` rows or cards, not both.
**Check:** admin `test:ui`, `test:e2e`.

### E2: Deep links open the exact record
**Files:** `ui/features/search/workflow.ts:29`, `ui/features/reports/Reports.tsx:147`, `ui/features/licenses/Licenses.tsx:95`, `ui/features/entitlements/Entitlements.tsx:142`; admin worker entitlement list (`license_id` filter) and the reports "Expiring soon" query; openapi.
**Change:**
- Search passes `id` and `customer_id`.
- Expiring soon passes `id: entitlementId(project, feature, fingerprint)` (`@licensecc/licensing-domain/entitlements/contracts`).
- License links pass `customer_id`, plus a new `license_id` list filter.
- A "Showing 1 entitlement · Show all" banner, with the row focused.
- Expiring soon shows the customer name and includes activation trials.
- `id` and `customer_id` stay session-only; `urlFilters` excludes both (`navigationState.ts:6-11`).

**Test:** e2e: a search lands on exactly 1 row and the URL has no fingerprint; the expiring link lands on 1 row. Worker tests for `license_id` and trials in expiring.
**Check:** admin `npm test`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### E3: Events show who and why, filterable and paged
**Files:** admin `groups/entitlements/operations.ts:87-112`, `worker/query.ts:53`, openapi, `ui/features/events/Events.tsx:12-24,87`, `ui/features/entitlements/EntitlementList.tsx` (History item).
**Change:**
- `GET /api/admin/events` accepts `project`, `feature`, `entitlement_id`, `event_type`, `actor`, `since`, `until` and a cursor.
- The UI adds Reason and Actor columns, a filter bar and Next page.
- Each entitlement row gets a "History" item that opens filtered Events.

**Test:** worker: filters and cursor. E2e: disable with reason X → Events shows X; History lands filtered.
**Check:** admin `npm test`, `test:sql`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### E4: Webhooks: valid types and editing
**Files:** move `KNOWN_INTENTS` from `backend/src/fulfillment/order_event.mjs:50` to `packages/licensing-domain/src/orders/intents.mjs` (+ `.d.ts`, an exports subpath; the backend re-imports it); `packages/cloudflare-runtime/src/webhooks/webhook.mjs` (export `WEBHOOK_EVENT_TYPES`); admin `src/worker/webhooks.ts` (create/PATCH validation), openapi, `ui/features/webhooks/{Webhooks.tsx:298,workflow.ts}`.
**Change:**
- `WEBHOOK_EVENT_TYPES` has three sources:
  - `entitlement` (the `entitlement_events` CHECK, `schema.sql:311`);
  - `customer: ["disable","reenable"]` (`schema.sql:139`);
  - `order: [...KNOWN_INTENTS]`.
- Matching stays exact.
- Create and PATCH reject unknown tokens with 400 `invalid_event_types` + `data.allowed`.
- The UI groups checkboxes by source and notes that `disable` and `reenable` match both entitlement and customer events. Add an Edit form on the existing `PATCH /api/admin/webhooks/{id}`.

**Test:** worker: unknown token → 400. E2e: create via checkboxes and edit.
**Check:** runtime + domain tests; admin `npm test`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### E4b: "Send test event" through the backend that holds the secret
**Files:** backend new `src/webhook_operator_entrypoint.ts` (a `WorkerEntrypoint` named `WebhookOperator`), exported from `src/index.ts`; admin `wrangler.example.jsonc` (binding `WEBHOOK_OPERATOR`), `src/worker/env.ts`, `src/worker/webhooks.ts` (new `POST /api/admin/webhooks/{id}/test`, requires admin), openapi, `ui/features/webhooks/Webhooks.tsx`, `doc/operations/cloudflare-setup.md` (binding row).
**Change:**
- `WebhookOperator.sendTest(endpointId)` loads the active endpoint and re-validates its URL with `safeWebhookUrl` (https only).
- It signs `{type:"test", endpoint_id, sent_at}` with `WEBHOOK_SIGNING_SECRETS` and POSTs with a 5 s timeout and no redirects.
- It returns only `{status_class:"2xx"|"3xx"|"4xx"|"5xx"|"network_error"}` and is rate-limited to 1 per endpoint per 60 s (`rate_limit_counters`).
- No secret reaches the admin Worker.

**Test:** backend: signs with the endpoint's secret (mock fetch), rejects non-https, rate-limits, and doesn't follow redirects. Admin: route → binding → status class shown.
**Check:** backend `npm test`; admin `npm test`, `test:e2e`; `write:contract-baselines` + `test:contracts`.

### E5: Batch actions scale beyond 4
**Files:** `admin/src/ui/features/entitlements/{EntitlementList.tsx:80,workflow.ts}`; the cap stays at `admin/src/shared/api.ts:242-246` (its comment forbids raising it in a UI-only path).
**Change:**
- "Select all {n} loaded".
- One confirmation and one reason.
- Sequential chunks of `ENTITLEMENT_BATCH_MAX_IDS` (4), each with its own idempotency key.
- A progress panel.
- On the first non-success, stop. A 500 counts as outcome-unknown for that chunk, reconciled with its key. Report done / unknown / not attempted.

**Test:** e2e: 20 rows → 1 dialog and 5 requests. RF5: chunk 3 returns 500 → 8 done, 4 unknown, 8 not attempted, no more requests.
**Check:** admin `test:e2e`.

### E6: Confirmation matches the risk
**Files:** `ui/shared/useConfirmDialog.tsx` (from E0), the `ConfirmAction` type, callers in `features/entitlements`, `features/customers/ProtectedConnections.tsx:130`, `features/catalog/usePlanProjectionWorkflow.ts:141`.
**Change:**
- `ConfirmAction` gains `confirmLabel?`, `typedConfirmation?` and `reasonPresets?`.
- Revoke and batch revoke require typing "REVOKE {n}".
- Retire connection gets danger styling and typed confirmation. It gets no reason: the retire body is exactly `{expected_revision}` (`bindings.ts:71`).
- Projection Apply opens a dialog when the preview disables any grant.
- Disable offers presets: "Payment failed", "Customer request", "Fraud review".

**Test:** e2e: Confirm is disabled until "REVOKE 4" is typed; the Apply dialog appears when disabling; Retire has the danger class.
**Check:** admin `test:ui`, `test:e2e`, `check:hotspots`.

### E7: Validity dates display in UTC
**Files:** `ui/shared/format.ts:12`, `ui/shared/dates.ts:8`, and the validity columns in entitlements and reports.
**Change:** add `formatUtcDate(epoch)` → "2026-12-31 UTC" for all validity values. Event timestamps stay local with a zone suffix.
**Test:** RF4: e2e with `timezoneId:"America/New_York"`: typing 2026-12-31 → "2026-12-31 UTC".
**Check:** admin `test:e2e`.

### E8: Drill-downs are in history; no stale unsaved prompt
**Files:** `ui/app/navigationState.ts:4-10`, `ui/app/navigation.tsx:9-13,88,164,246-252` (`NavigationGuard.when: boolean | (() => boolean)`, evaluated in `allowLeave`), `features/customers/CustomerAccess.tsx:71-73`, `features/catalog/useCatalogWorkspace.ts:31-58`.
**Change:**
- The hash route carries the customer app/view and the catalog plan id.
- The catalog guard passes `when: () => dirtyNow()`, and `onApplied` resets the baseline.

**Test:** e2e: Back from Manage access returns to the customer; reload keeps plan detail; Apply → navigate shows no prompt.
**Check:** admin `test:e2e`.

### E9: Admin feedback is readable, local and fresh
**Files:** `ui/shared/api.ts:30-33`, new `ui/shared/messages.ts`, `ui/shared/useActionNotice.ts` (from E0), and the policy, webhook and catalog forms.
**Change:**
- `messages.ts` maps codes to `{text, tone}` for the admin Worker envelope and validation codes. The request id goes under "Technical details".
- The banner clears on navigation.
- Field-validation codes become inline `aria-describedby` errors.
- A create opens the created record.
- One error surface per failure.

**Test:** a unit test fails on unmapped Worker codes and asserts the unknown fallback. The e2e asserts no text outside `<details>` matches `/^[a-z_]+ \(/`.
**Check:** admin `test:ui`, `test:e2e`, `check:hotspots`.

### E10: Workspace layout and navigation polish
**Files:** `features/entitlements/{Entitlements.tsx:627,EntitlementList.tsx:55}`, `ui/app/Sidebar.tsx:52`, `features/reports/Reports.tsx`, `features/fulfillment/Fulfillment.tsx`, `features/search/Search.tsx`, `ui/shared/charts.tsx`, `ui/shared/console.css`.
**Change:**
- The inspector renders inline under its row and takes focus.
- "More actions" closes after an action.
- Compact density at ≥1280px, with ≥10 rows visible at 1440x900.
- Nav groups start expanded, with state remembered in `localStorage` (try/catch).
- Empty state: `filtered = Object.values(filter).some(v => v !== "" && v !== undefined)`.
- Range buttons get `aria-pressed` and an `.active` style.
- Chart axis labels and values.
- Search shows "Showing first 10 per type".

**Test:** e2e:
- after "Devices", the panel is in view and focused;
- ≥10 rows visible;
- the unfiltered empty text is correct;
- `aria-pressed` toggles.

**Check:** admin `test:e2e`.

## Workstream F — Consistency and accessibility (branch `fix/ux-f-consistency`)

### F2: Drift-proof style tokens (no new package)
**Files:** `portal/src/ui/styles.css`, `admin/src/ui/shared/console.css:3-13`, new `scripts/ui-token-parity.test.mjs` (added to `test:repository`).
**Change:**
- The portal defines the same named `:root` custom properties as admin (`--surface`, `--border`, `--muted`, the status backgrounds, `--radius`, the type scale) and uses them instead of raw hex.
- Reconcile the drifted pairs to admin's values (`#203020`, `#302a20`).

**Test:** the parity test parses both `:root` blocks and fails if a token defined in both has different values.
**Check:** `npm run test:repository`; both apps' `test:e2e`.

### F3: Admin accessibility fixes
**Files:** `ui/app/Sidebar.tsx`, the workspace heading, `ui/shared/console.css:33`.
**Change:**
- The workspace heading becomes the `h1`; the sidebar brand becomes non-heading text.
- Checkboxes ≥24x24; `summary{min-height:44px}`.

**Test:** axe on Overview at 390px with the menu closed shows no `page-has-heading-one`; targets are ≥24px.
**Check:** admin `test:e2e`.

### F5: One native dialog implementation in admin
**Files:** `ui/shared/useConfirmDialog.tsx` (after E0; the old `controls.tsx:216-217,1123-1129` fallback), admin `README.md` (supported browsers: evergreen).
**Change:** delete the non-native fallback branch and keep native `<dialog>`.
**Test:** the existing dialog e2e tests pass: focus trap, Escape, focus restore.
**Check:** admin `test:e2e`.

## Order and dependencies

1. **F1** (glossary) first: later tasks write copy in its terms.
2. **A, B, C, D, E** follow. They overlap at file level, so merge in this order and rebase each PR on `main` before its gate:
   - `App.tsx`: A4, C3, C4, C6, D2, D3;
   - `passwordMessages.ts` / `PasswordSettings.tsx`: A3, A5, C6;
   - `ConsentFeature.tsx`: A4, B3;
   - `AppsFeature.tsx`: A4, C5, C6, D1;
   - `portalWorkflow.ts`: C1, C5, D2;
   - `ProtectedNodes.tsx`: C3, D1, D4;
   - admin `README.md`: A5, B1.
3. **Within workstreams:** B1 before B2; B3 before D6 and B5; E0 first in E; E6 and E9 after E0; F5 after E0.
4. **F2, F3 and F5** last.
5. **Each PR:** rebase, re-run `write:contract-baselines` if its baseline changed, then the Global Constraints gate.
