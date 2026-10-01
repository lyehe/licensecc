# Customer, license, device: workflow redesign

- **Status:** proposed design, 2026-10-01. The owner approved each section in conversation. Three parallel reviews (security, product, architecture) then checked it against `main` at `34bb0d47`, and this version records the decisions taken after those reviews.
- **Scope:** the end-to-end workflow for every actor:
  - a store selling the vendor's app;
  - the operator who runs licensecc;
  - the customer who buys;
  - the computer that runs the app.
- **Out of scope:** the native offline license format (v201), the TPM device-key model and the lease cryptography. They stay as they are.

## 1. Intent

Licensecc is a self-hostable licensing platform. A software vendor (the **operator**) runs three Cloudflare Workers to license its own native Windows and Linux apps to its customers:

- the licensing backend;
- the admin console;
- the customer portal.

Online licensing is protected and device-bound: a TPM device key, browser approval in the portal, and a signed lease of at most 24 hours. Offline signed `.lic` files are the fallback for air-gapped machines.

**Buyer model.** Mixed, store-first. Most customers buy through an online store that sends signed orders. Occasional sales-led deals are created by hand.

**Constraints:**

- This is a new project with no live data.
- Schema, wire protocol, native ABI and SDK changes are allowed, with no compatibility layer.
- The single D1 baseline is recreated.

**Success criteria:**

1. A store buyer goes from purchase to a connected app with no support contact.
2. Replacing a computer is self-service and immediate in the common case.
3. Every refusal says why and what to do next, on every surface, and carries a reference that support can look up.
4. Operators handle exceptions from one customer page.
5. Each concept has one name and one data shape everywhere.
6. No input leaves an order, a request or a screen stuck forever.

**The elegance test applied throughout.** The design must remove more than it adds. Each concept must map to something a person already understands. Failure classes are removed by construction, not handled case by case.

## 2. Why: the current workflow

A UI/UX audit of `main` at `34bb0d47` found 65 issues. The design targets the structural causes behind the high-severity ones:

- **Split identity.** A customer has a contact email that may be blank, and separate sign-in emails held in password and provider rows. Store customer IDs arrive as internal IDs.
  - An order for an email that already has an account returns `503 write_failed` forever.
  - An invited customer who later buys is split into two accounts.
- **Fan-out.** One purchase becomes a license record plus one entitlement row per feature, each with its own status, validity and device limit.
  - Devices bind per feature, so a two-feature plan means approving the same computer twice.
  - Plan projection exists only to keep the fan-out in sync.
- **Seven writers.** Order ingest, admin create, admin edit, admin sync, plan apply, batch and the raw-SQL emergency CLI each enforce their own checks.
- **Fragile approval.** Approving a computer has several failure points:
  - a magic link in the sign-in email opens a new tab and loses the request;
  - a full license leaves the customer with no route to Devices;
  - approving from a phone fails silently;
  - the screen has no trust cues;
  - a slot freed by a disconnect is held for up to 24 hours.
- **Opaque refusals.** At least seven causes reach the device as a bare `DENIED` with no reference, while the portal still shows the computer as "Connected".
- **Console built around tables, not people.** Destructive dialogs name fingerprints, lists show raw customer IDs, and onboarding has no "grant access" step.

## 3. Decisions

Each decision gives its reason. The full mechanics follow in sections 4–11.

| # | Decision | Reason |
| --- | --- | --- |
| D1 | **Four nouns: customer, license, feature, device.** A license is one purchase of one app, with one status, validity window, plan and device limit. | Removes the fan-out and the per-feature split, and matches how a buyer thinks. |
| D2 | **A customer is one email address.** It is unique, and verified on first sign-in. | Removes the identity split by construction. |
| D3 | **A device belongs to a license, not to a customer.** | Licenses can be transferred or erased without stranding devices. |
| D4 | **Orders carry the subscription's current state.** Licensecc reconciles the license to it. | One rule covers new purchases, renewals, plan changes, add-ons, quantity, refunds and trials. There is no intent table to keep complete. |
| D5 | **One set of license operations:** grant, change, suspend, resume, revoke, transfer, erase. Every writer calls them. | One place enforces every rule. |
| D6 | **Customers exist only through a grant.** The email code is the one universal sign-in. Google and GitHub are optional shortcuts. | One sign-in mechanism, no empty accounts, no passwords to reset. |
| D7 | **Approval is one tap:** pick the matching code from three. It is checked on the server. A full license becomes "Replace a computer" on the same screen, and the replacement commits when the new computer finishes connecting. | Fewer steps, stronger against blind approval, and no dead end. |
| D8 | **One access function and one closed list of refusal reasons**, generated into every surface. Every refusal is recorded with a reference. | No drift between surfaces, and support can trace any refusal. |
| D9 | **Policies fold into plans.** Licensecc's own trial engine is removed. Trials come from the store's `trialing` state, or from an end date for pilots. | Removes a concept, a screen and two tables. |
| D10 | **Offline files are computers on a license.** They occupy a slot and need an end date. The signing key stays off Cloudflare. | One concept, online or offline. A leaked offline key would forge permanent licenses. |
| D11 | **Pure logic lives in `packages/licensing-domain`.** D1 code lives in `packages/cloudflare-runtime/d1/license_store`. | Required by ADR 0001 and `doc/architecture/ownership.md`. |
| D12 | **Step-up and notices protect sensitive actions.** | A portal session becomes more powerful, so it must be harder to abuse quietly. |

## 4. Model

### 4.1 Customer

`customers` columns:

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `email` | As entered |
| `email_key` | `NFC(trim(email)).toLowerCase()`, computed in JavaScript. NOT NULL, UNIQUE. SQLite `lower()` folds only ASCII, so the key is never computed in SQL. |
| `email_verified_at` | Set on first sign-in |
| `name` | |
| `status` | `active` or `suspended` |
| `authority_revision` | |
| `created_at`, `updated_at` | |

Rules:

- **Sign-in identity.** `email` is the only one. The separate contact email and `portal_passwords.email_lower` are removed.
- **Linked providers.** Rows in `portal_identities` (Google, GitHub) attach to a customer. Linking requires a fresh email code (section 9). A provider never creates a customer and never auto-links.
- **Erasure.** `erase` replaces `email` and `email_key` with a tombstone derived from the id, deletes personal data, and keeps an anonymised audit trail (section 5.6).

### 4.2 License

`licenses` holds one row per purchase of one app:

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `customer_id` | Owner |
| `project` | The app |
| `plan_id`, `plan_version` | The plan the license was granted on |
| `addons_json` | Add-ons bought on top of the plan |
| `quantity` | Number bought; multiplies the device limit |
| `device_limit` | Plan device limit × quantity, unless overridden |
| `status` | `active`, `suspended` or `revoked` |
| `valid_from`, `valid_until` | Validity window |
| `grace_seconds` | Defaults to the plan's grace |
| `revision` | Compare-and-set counter; see below |
| `store`, `store_customer_ref`, `subscription_id` | Null for console grants |
| `source` | `order` or `console` |
| `created_at`, `updated_at` | |

`license_features` is a snapshot of `(license_id, feature)`: the plan's features plus add-ons, taken at grant or change time. Changing the features increments `revision`.

The lease carries this feature list, so a license has a feature cap that fits the lease size limits: 32 features of up to 15 characters.

`license_events` is the license's append-only history. The audit hash chain covers it.

### 4.3 Device

- **`device_bound_devices`** holds the key identity, the label and the status. It no longer has a `customer_id`.
- **`device_bound_bindings`** links a device to a license. It is keyed by `(license_id, device_id)` and has these states:
  - `active`;
  - `retiring`, held until the device's last lease ends;
  - `replaced`, which does not occupy a slot;
  - `released`.

  A binding also has `kind`, either `online` or `offline`. An offline binding references an `offline_files` row: hardware ID, features, end date, the request digest and who recorded it.
- **Occupancy.** A license's slots are used by `active` bindings, by `retiring` bindings still inside their hold, and by unexpired offline bindings.
- **Lost or stolen.** This blocks the device key for the license and signs out every portal session of the customer.

### 4.4 Catalog

An **app** has **plans**. A plan holds:

- its features;
- its add-ons;
- its device limit;
- its term and grace: a subscription follows the store's period, perpetual means no end, and a fixed term is a number of days;
- a version.

Plans are immutable per version, and licenses record the version they were granted on.

The current tables `entitlement_policies` and `policy_events` are removed, along with the per-feature policy and device-limit columns on the catalog. Catalog import keeps its concurrency fence, renamed from `license_plan_projection_generations` to `catalog_generations`.

### 4.5 Tables

Removed:

- `entitlements`
- `entitlement_events`
- `license_plan_assignments`
- `license_plan_assignment_events`
- `license_plan_projection_generations` (renamed to `catalog_generations`)
- `license_plan_projection_previews`
- `orders`
- `entitlement_policies`
- `policy_events`
- `portal_passwords`
- `portal_password_actions`

Added or reshaped:

- `licenses`
- `license_features`
- `license_events`
- `order_subscriptions`
- `offline_files`
- `customer_notifications`
- `access_refusals` (generalises `device_bound_denials`)
- `catalog_generations`
- `portal_otp` gains a `purpose` column: `sign_in`, `email_change` or `link`.

The order inbox (`order_events`, `order_ingest_nonces`) and the webhook tables stay.

## 5. Provisioning

### 5.1 License operations

Planning functions in `licensing-domain` are pure and return the statements to run. `license_store` executes each operation as one D1 batch guarded by `revision`.

| Operation | Effect |
| --- | --- |
| `grant(email, app, plan, addons, quantity, overrides, source)` | Resolves or creates the customer, then creates the license, its features, a `license.granted` event and a "license ready" notification. |
| `change(license, revision, {plan, addons, quantity, valid_until, device_limit})` | Recomputes the features and the device limit. If the new limit is below the number of occupying devices, the least recently seen online bindings become `replaced` in the same batch, with an event and a customer notice. **A change never fails because of devices in use.** |
| `suspend` / `resume` | Suspend keeps bindings. Resume restores access without reconnecting. |
| `revoke` | Permanent. Releases every online binding, and refuses any later change. Only an individual operator, or a refund or fraud order, can revoke. There is no bulk revoke. |
| `transfer(license, email, step_up)` | Moves the license and its bindings to the customer for `email`, creating that customer if needed. The recipient receives "license ready". |
| `erase(customer)` | Revokes the customer's licenses, deletes personal data, tombstones the email and keeps the audit chain. |

### 5.2 Orders

The inbox, the HMAC signature, the nonce, the epoch and the exactly-once rules are unchanged. The payload is the subscription's current state:

```json
{
  "event_id": "…", "subscription_id": "…", "seq": 7,
  "status": "trialing | active | past_due | canceled | refunded | chargeback | fraud",
  "period_end": 1790000000,
  "project": "COLMAP", "plan_key": "pro", "addons": ["export"], "quantity": 1,
  "customer": { "email": "dana@example.com", "name": "Dana Lee", "store_customer_ref": "cus_123" }
}
```

**`order_subscriptions`** is the accept-time cursor. It maps `(store, subscription_id)` to an optional `license_id` and records `last_seq` and the epoch. It exists before any license does, because a renewal can arrive before its purchase. Only the apply-time sequence floor moves onto `licenses`.

**Resolving the customer** happens only on the first applied snapshot of a subscription, in this order:

1. a previous license with the same `(store, store_customer_ref)`;
2. a customer with the same `email_key`;
3. otherwise, a new customer.

Later snapshots find the license through `order_subscriptions`. They never re-resolve the customer and never edit the customer's name, email or status. The signer scope that today keys on `customer_id` becomes a scope over `(store, project)`.

**Reconciliation** is one pure function, `reconcileSubscription(license?, snapshot, now)`:

| Snapshot status | License result |
| --- | --- |
| `trialing`, `active`, `past_due` | `active`; `valid_until = period_end + grace`. Payment problems are the store's to chase. |
| `canceled` | `valid_until = period_end` |
| `refunded`, `fraud` | `revoked` |
| `chargeback` | `suspended`, until an operator resumes or revokes |
| Plan, add-on or quantity differs | `change`, as in 5.1 |

Every refusal is terminal and recorded: a stale sequence, an unknown plan, or a snapshot for a revoked license. No order outcome is "retry forever" unless the cause is transient: a D1 error or a rate limit.

### 5.3 Console grants

**Grant license** works the same way for store purchases and sales-led deals:

1. Enter an email, with type-ahead over existing customers.
2. Choose the app and plan.
3. Choose add-ons and quantity.
4. Optionally override the end date or device limit.
5. Review the inline summary, which shows "Creates dana@… with Colmap Pro, 2 computers, until 2027-10-01, and sends the welcome email".
6. Grant.

### 5.4 Command-line access

The emergency CLI becomes a thin client of the admin API. It authenticates with the operator's own Cloudflare Access login (`cloudflared access login`). Service tokens are allowed only for named automation scopes: an explicit `common_name` → role map, denied by default. The raw-SQL path and `--allow-revoked-override` are removed.

### 5.5 Welcome and notices

**Outbox.** A grant, transfer, replace, disconnect, email change or lost-device action writes a `customer_notifications` row in its own batch. The portal Worker gains a `scheduled` handler that sends and then purges these rows. Notices are fixed templates: no customer-supplied text, and the product name is validated.

**"License ready"** leads with the next action: "Download Colmap, open it, choose Connect, and sign in with this address". It links to the portal as well.

**Security notices** go to the account email:

- a computer connected, replaced or disconnected;
- the email changed (sent to the old address);
- a provider linked;
- a license transferred.

**Configuration.** Email delivery is required. The readiness check covers SPF, DKIM and DMARC alignment for `PORTAL_EMAIL_FROM`.

### 5.6 Erasure and audit

The audit chain moves from `entitlement_events` to `license_events`. Digests cover only non-personal fields, so erasing a customer (tombstoning the email and deleting personal data) never breaks the chain.

## 6. Sign-in

- **Email code.** 8 digits, valid 10 minutes, single use. The email carries no link.
- **Requesting a code** for an address with no account shows the same message as for a real one: "If dana@… has a license, we sent a code. Bought with a different address? Try that one, or contact support."
- **Limits.**
  - A wrong guess counts against the live code. The code dies after 5 wrong guesses.
  - There are per-email request and verify budgets.
  - IPv6 is grouped by /64 for per-IP budgets.
  - Every refusal shape is identical, so a response reveals nothing about the account.
- **Google and GitHub** sign in only after they have been linked. Linking requires a fresh email code.
- **Sessions** last 24 hours, with "Sign out everywhere" on Account.
- **Removed:** passwords, registration, magic links, and the magic-link page.
- **Break-glass bootstrap** for the first operator test account goes through a console-issued, single-use code that the operator delivers out of band. It replaces the magic-link dependency recorded in TM-15.

## 7. Connecting a computer

The security core is unchanged:

- the TPM device key;
- the loopback hand-off on `127.0.0.1`, which completes approval only on the machine that asked;
- a 60-second exchange code;
- leases of at most 24 hours.

### 7.1 Flow

1. **The app asks.** The user chooses Connect. The app shows its code and a countdown, and opens `/connect` in the default browser. A request lives 10 minutes. The 5-minute constant is defined once and used in every place that today hard-codes it.
2. **Sign-in, if needed.** It happens in the same tab with an email code, so the request is never lost.
3. **The page asks:** "Connect DESKTOP-7Q2K to Colmap Pro?" Below the question it shows:
   - the device label, introduced as "named by the app";
   - where the request started (city or network, when available);
   - three codes.
4. **The customer taps the code the app shows.**
   - The approve call carries the chosen code, and the server checks it.
   - The decoys are derived by HMAC from the attempt, so they are stable across reloads, and the three codes are shown sorted.
   - A wrong pick ends the attempt on the server, and the loopback receives an error, so the app stops waiting at once.
   - "I didn't start this" ends the attempt the same way.
5. **The hand-off completes.** The browser goes to the loopback. The app exchanges the code and says "Connected. Colmap Pro is on 2 of 2 computers."

### 7.2 Variations

- **Several eligible licenses:** a picker. This is rare once licenses are per purchase.
- **Full license:** the screen becomes "Replace a computer". It lists the license's computers by name and last seen, and needs a sign-in from the last 10 minutes or a fresh code.
  - Choosing a computer records the intent. The old binding becomes `replaced`, and the new one becomes `active`, together in the exchange batch.
  - An abandoned or phished approval therefore never disconnects anything.
- **Ineligible:** the reason sentence (section 8) and a link to the license.
- **Phone or tablet:** the page says "Finish on the computer running Colmap" and shows no approve controls. If the hand-off fails, an approval that never reached exchange can be retried inside the window.
- **Device label rules:** printable Unicode, 1–80 code points. No control, bidi or format characters, and nothing matching the code pattern.

### 7.3 Freeing a slot

- **From the old computer.** "Disconnect this computer" calls `lcc_device_bound_release`.
  1. The library disables its local lease first.
  2. It then sends a request signed with the device key, carrying a fresh challenge.
  3. The slot frees at once.
- **Replacement from elsewhere** is immediate within an allowance of `max(3, device_limit)` per license per rolling 30 days. The allowance is counted from `license_events`; it is not a separate table.
  - Beyond the allowance, the hold applies: the slot frees when the replaced device's last lease ends.
  - The overlap is bounded by the lease: at most 24 hours, and under 12 for an online computer, which is refused at its next renewal.
- **Operator disconnects** are always immediate and do not use the allowance.

## 8. Lifecycle and refusals

### 8.1 Access function

`licenseAccess(license, customer, binding, now)` in `licensing-domain` returns `ok`, or `refused` with a reason. Its callers are lease issue and renewal, consent eligibility, the portal display and the console display.

### 8.2 Reasons

Every reason is defined once, with its wire code, its sentence and its next step:

| Reason | Sentence (customer) | Next step |
| --- | --- | --- |
| `license_expired` | Your Colmap license ended on 1 Oct 2026. | Renew in the store |
| `license_not_started` | Your Colmap license starts on 1 Nov 2026. | Wait, or contact support |
| `license_suspended` | Your Colmap license is paused. | Contact support |
| `license_revoked` | Your Colmap license has ended permanently. | Contact support |
| `account_suspended` | Your account is paused. | Contact support |
| `feature_not_included` | Your plan doesn't include Export. | Upgrade in the store |
| `device_disconnected` | This computer was disconnected from your license. | Connect again |
| `device_limit_reached` | All 2 computers on this license are in use. | Replace one |
| `device_unsupported` | This computer can't hold a secure license key (no TPM). | Use another computer or an offline license |
| `online_required` | Connect to the internet to keep using Colmap. | Go online |
| `retry_later` | Licensing is busy. Try again in a minute. | Retry |

Connect outcomes add three more reasons: `request_expired`, `request_denied` (a wrong code or "I didn't start this") and `request_used`.

### 8.3 Generation and visibility

**One table generates every surface.** The reason table lives in `licensing-domain`. A committed generator produces from it:

- the C `LCC_BOUND_DETAIL_*` values and `lcc_bound_strerror()`;
- the Python, .NET and Java enums with `describe()`;
- the portal and console strings.

A parity test fails on any drift.

**Reasons only after proof.**

- A renewal challenge is issued for any existing binding, whatever the license state. Unknown and ineligible bindings answer the same way before proof.
- The reason is returned only after the device proves its key.
- A device that has been replaced or disconnected only ever learns `device_disconnected`.

**Every refusal is recorded.**

- Every response carries a `request_id`.
- `access_refusals` records each refusal with its `request_id`, license, device and reason.
- Apps show "Reference: 7F3K-2M9Q". Console search accepts that reference and opens the license card with the fix.

**Wording.** Every surface states the same limit: "Connected computers stop within 24 hours". Device rows show the license state, for example "Connected · license paused". Billing emails stay with the store. `license.*` webhooks carry the reason.

## 9. Security requirements

These come from the security review and are part of this design:

- **Step-up.** These actions need a sign-in from the last 10 minutes, or a fresh code:
  - email change;
  - provider link;
  - transfer;
  - replace;
  - lost or stolen;
  - account closure.
- **Email change** sends a code to the new address and a notice to the old one, then revokes every session.
- **Operator email edits** stay pending until the new address confirms a code.
- **Notices** go out for every connect, replace, disconnect, link, transfer and email change.
- **Orders** never edit an existing customer (section 5.2). Signer scopes are per `(store, project)`.
- **Offline issuance.** The console produces a validated request file: hardware ID checked against the C++ grammar, features from the plan, end date required. `lccgen license issue --request <file>` reads it. Nothing is interpolated into a shell command.
- **Command-line access** uses the operator's own Access identity (section 5.4).
- **The email provider is top-tier infrastructure,** because it can read every code. Delivery failures raise an alert on the console Overview.
- **The threat model** rows TM-01, 03–07, 09, 14, 15 and 19 must be updated with the design. ADR 0006 is amended (section 11).

## 10. Interfaces

### 10.1 Console

The navigation has six areas:

- **Overview.** What needs attention: expiring licenses, refused connections, failed webhooks, stuck orders, used-up replacement allowances and email delivery failures. Each item links to a filtered list.
- **Customers.**
- **Licenses.**
- **Activity.** One log of license, order and device events. Search accepts an email, name, license, subscription or reference.
- **Catalog.** Apps and plans.
- **Webhooks.**

The **customer page** is the support home:

- a header with name, email (editable, pending confirmation), status, and Suspend or Resume;
- one card per license, with:
  - the status sentence;
  - the dates;
  - "2 of 3 computers", with the computers nested (Disconnect, Lost or stolen);
  - Change, Suspend, Revoke and Transfer;
- one timeline;
- the actions Grant license, Resend welcome and Record offline license.

Across the console:

- People appear as "Dana Lee · dana@…", with IDs under Technical details.
- Destructive dialogs name the customer, the license and the environment.
- Production has a distinct style.
- A bulk Extend exists for outages. Bulk revoke does not.

### 10.2 Portal

- **Licenses** has one card per license:
  - the app's display name and plan;
  - the status sentence and next step;
  - "Renews 1 Oct 2027";
  - "Computers: 2 of 3", listed by name and last seen, each with Disconnect and Lost or stolen;
  - disconnected computers collapsed under "Show disconnected (n)".
- **Account** holds:
  - the email (changed with step-up);
  - linked providers;
  - Sign out everywhere;
  - support contact;
  - account closure, which goes through erase.
- **Connect** works as described in section 7.
- **Layout and branding:**
  - cards only;
  - one live region;
  - errors shown as errors;
  - local dates with the time zone;
  - the operator's product name and logo from `PORTAL_PRODUCT_NAME`.

### 10.3 Native library and SDKs

**ABI:**

- **New struct versions, added at the end.** Every option, view and outcome struct changes in one coordinated version bump: both bridge probes and all three SDK mirrors move in the same commit.
- **`LccDeviceBoundOptions` loses `feature`.** The struct gets a new version number, not an edited layout.
- **The device-bound outcome gains three fields:** `request_id`, `devices_in_use` and `device_limit`.
- **The feature-session outcome gains** `denial_detail`.
- **New calls:**
  - `lcc_device_bound_release()`;
  - a loopback error callback, so the app learns of a wrong code or "I didn't start this" at once.

**Lease and tests:**

- **The lease claims carry the license's feature list.** It is sorted and capped as in 4.2. `lcc_feature_session` checks the required feature against the list. A feature-session start renews first, so `feature_not_included` is final only after a fresh lease.
- **Golden vectors** get a committed generator, and the vector allowlist in `scripts/check-architecture.mjs` is updated.

## 11. Architecture

- **ADR 0007 records the model.** It covers the four nouns, email identity, orders as state, and the license operations.
- **ADR 0006 is amended** for:
  - immediate replacement within an allowance;
  - device-signed release;
  - automatic disconnection on a lower limit;
  - license transfer;
  - the challenge-before-proof rule.
- **Code placement (D11).** `licensing-domain` holds `planGrant`, `reconcileSubscription`, `licenseAccess`, the reason table and the generators. `cloudflare-runtime/d1/license_store` holds every D1 batch. Order ingest, the admin Worker and the portal Worker call `license_store`. No Worker writes license tables directly.
- **Webhook events become:**
  - `license.granted`, `license.changed`, `license.suspended`, `license.resumed`, `license.revoked`, `license.transferred`;
  - `device.connected`, `device.replaced`, `device.disconnected`.

## 12. Removals and accepted losses

**Removed:**

- per-feature entitlements and the plan-projection mechanism;
- policies as a separate concept;
- licensecc's trial engine and the one-computer trial lock;
- the admin sync endpoint and its CLI;
- Add user;
- passwords, registration and magic links;
- the raw-SQL CLI and the revoke override;
- the separate Issued-licenses, Events, Order-activity, Reports and Policies screens, and the portal's separate Apps and Devices pages.

**Capability losses the owner accepted:**

- per-feature device limits and per-feature lifecycles;
- password sign-in and self-registration;
- pushing grants through the sync endpoint;
- undoing a revocation;
- a payment failure suspending access (the store ends access by sending `canceled`);
- trials timed from first activation, and the per-computer trial lock;
- Google or GitHub creating an account on their own.

**Out of scope, as possible later work:**

- teams, with one person assigning employees' computers (quantity covers volume purchases);
- passkeys;
- license-key activation;
- store adapters such as Stripe and Paddle (the state-snapshot contract keeps each adapter a thin mapping).

## 13. Phases and gates

**Phases:**

1. **P0, decisions and the pure model.** About 20 files, and stays green. It contains:
   - ADR 0007 and the ADR 0006 amendment;
   - the threat-model updates;
   - `licensing-domain` planning functions;
   - `reconcileSubscription` and `licenseAccess`;
   - the reason table and generators, with tests only;
   - no runtime wiring yet.
2. **P1, the storage cutover.** It is done as expand, then migrate each reader and writer path, then contract, so every task stays green. It splits into P1a (backend and runtime) and P1b (admin, portal and contracts).
   - **What it covers:**
     - the new baseline, including `customer_notifications` so the restore-drill signature changes once;
     - `license_store`;
     - order ingest v2 (state snapshot);
     - device binding keyed by license, with the lease format unchanged;
     - removal of plan projection, sync and Add user.
   - **Size:** about 180–230 files.
3. **Three lanes in parallel:**
   - native and SDK wire v2: lease features, ABI, release, the error callback, generated reasons and vectors;
   - portal sign-in and the outbox: code-only sign-in, budgets, step-up, notices and the welcome email;
   - the console UI: navigation, the customer page, grant and the dialogs.
4. **Connect:** number matching, replace at exchange, the allowance, the phone guard and the 10-minute window. This needs the native error callback and in-tab sign-in.
5. **Portal UI:** license cards and Account. It can run alongside the console lane.

**The first implementation plan covers P0 and P1.**

**Gates for every phase:**

- `npm run check:pr`;
- `ctest --preset dev-debug`, plus build purity for any native change;
- `npm run test:sdks`;
- `npm run test:e2e`;
- `npm run check:docs`.

`check:pr` alone misses native and SDK drift.

## 14. Risks

| Risk | Mitigation |
| --- | --- |
| Staging deploys only apply migrations, so an edited baseline is never re-applied, and pre-cutover backups fail the new restore drill. | An operator recreate step and a documented cutover checklist. The restore drill re-pins once. |
| D1 limits: 100 bound parameters per query, and 50 queries per invocation on the Free plan. The existing lease batch already has 14 statements. | Keep batches small. Require Workers Paid for production. |
| The Free plan's 10 ms CPU budget versus RSA-3072 lease signing. | Require Workers Paid. Measure in P1. |
| An exactly-once regression in order ingest (1,007 lines, no growth allowed). | Order ingest v2 lands as extracted modules with the existing exactly-once tests ported first. |
| Hotspot ratchets force extractions in the middle of the rewrite. | Plan the extractions as explicit tasks. |
| Email becomes the only universal sign-in. | Linked providers, a delivery-failure alert, and break-glass codes from the console. |

## 15. Relation to the interim fixes

Several live defects on `main` are being fixed separately, before this design lands:

- the email-code brute force;
- provider linking with a stale session;
- the order email conflict and the device-limit decrease returning 503 forever;
- the emergency CLI accepting unknown customers and undoing revocations;
- device labels being able to imitate the comparison code.

Those fixes keep the current model. This design then replaces the order-identity and CLI fixes with the structural versions in sections 5.2 and 5.4.
