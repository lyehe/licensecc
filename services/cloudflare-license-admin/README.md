# licensecc Cloudflare admin

Private control-plane Worker and Vite + React console for managing the
protected device-licensing entitlements stored in the shared D1 database.

**Audience:** contributors and authorized operators of the hosted control
plane. It is not required for offline native licensing.

**Supported browsers:** current evergreen browsers (native `<dialog>`
required).

| Goal | Start here | Side effects |
| --- | --- | --- |
| Validate code locally | [Local validation](#local-validation) | Local build/test output and a disposable local D1 database |
| Understand authentication | [Authentication](#authentication) | Read-only documentation |
| Exercise staging | Use the specific staging validator documented below | Mutates only where the validator explicitly says so |
| Operate production | [Production readiness](../../doc/operations/production-readiness.md) | Protected operator action and evidence |

Unless a block explicitly says "repository root," run its service-local
command from `services/cloudflare-license-admin` after the single root
workspace install. Commands labelled staging, remote, deploy, break-glass, or
production require authority for the named environment.

This service is intentionally separate from the licensing backend Worker. The
admin Worker holds no signing secret. It owns
ordinary control-plane D1 operations, delegates protected retirement to the
backend's named `DeviceOperator` capability, and delegates webhook test sends to
its named `WebhookOperator` capability.

## Add a customer portal user

Open **Customers → Add user** and enter a name and login email. This requires
the administrator role. **Invite** is the default: the server stores a
random, never-disclosed credential, and the success panel tells the operator
to ask the customer to open the customer portal and choose "Forgot your
password?" to set their own password. That works because the portal treats
an admin-created account's empty contact email as eligible for password
recovery as long as no other customer has already verified that same
address -- a non-empty contact email that differs from the login is never
eligible. The first successful recovery records the proven address as the
account's verified contact, after which it recovers the ordinary way.

Choose **Set an initial password** instead when the customer portal cannot
send email: enter an initial password (15–128 characters) and share it with
the customer through a secure channel. No email is sent either way. They can
sign in to the customer portal and change their password in Account.

The portal must use the same D1 database and have password login enabled.
Creating a user grants no licenses and does not verify ownership of the login
email. Existing login or verified contact emails are rejected; this action
does not attach credentials to an existing customer. If a response is lost,
use **Reconcile status** to recover the original creation safely.

## Create protected application access

The whole path runs in the console; no SQL is needed.

1. Create the customer with **Customers → Add user** (above).
2. Open **License access → New entitlement**; **Protected devices** is the default.
   Set the application's project and feature, then choose the customer: the
   customer list shows the first 20 matches, and typing part of a name, email,
   or ID narrows it. The license list shows only that customer's licenses for
   this project. If it is empty, choose **Create license for {project}**: it
   creates the customer's license record and selects it. A suspended customer
   cannot get one.
3. Optionally set the **Device limit**, the most devices that can be connected
   at once (1 to 1,000,000). Blank sends none: a new license (entitlement) gets
   1, and an existing one keeps its limit. Or choose a policy instead: the list
   shows this project's active policies as "{name} · {n} devices · {project}",
   and a chosen policy sets the device limit, shown read-only as "Device limit
   (from policy {name})". **Create policy…** opens the policy form for this
   project and brings you back to the unchanged draft with the new policy
   chosen.
4. Choose **Generate fingerprint** for a new protected license, or enter its
   exact lowercase 64-character fingerprint, then choose **Create entitlement**.

Changing the project clears dependent selections. Protected project and feature
IDs use ASCII letters, numbers, `_`, `.`, `:`, or `-` (127 and 15 characters).
A create or PATCH body names only the fields its route reads: a body that
names any other field returns `400 invalid_request`. A selected policy stamps
an active grant with its device limit and trial/expiry settings, so it must have
at least one device slot and usable trial/expiry settings, and a create that
selects one names no `status` or `max_active_devices`.

To change an existing grant's device limit, open it with **Edit** and use **Save
device limit**. A protected grant cannot go below the devices already connected;
the console then says "{n} devices are connected; disconnect one first." See
[Device limit](#device-limit) for the API rules.

A refused protected create returns `409 protected_creation_conflict`, and its
`data.reason` names the first rule that failed. The console shows each reason
as a sentence with the request reference:

| `data.reason` | Rule |
| --- | --- |
| `customer_inactive` | The customer is suspended or missing. |
| `license_missing` | The chosen license record does not exist. |
| `license_customer_mismatch` | The license belongs to another customer or project. |
| `fingerprint_in_use` | Another license (entitlement) already pairs this fingerprint or license differently, or a concurrent create took this exact grant. |
| `plan_assignment_conflict` | The license's plan assignment uses another fingerprint. |
| `policy_mismatch` | The policy is not an active policy of this project, or it changed or was disabled after it was read. |
| `invalid_trial` | The trial settings cannot start a protected trial. |
| `devices_connected` | The create would move the grant to another customer while devices are still connected; disconnect them first. |
| `invalid_capacity` | The device limit is outside 1–1,000,000, or below the devices already connected. |
| `unknown` | Any other integrity rule, such as a validity window beyond the largest supported time. |

The application must already use the protected v2 integration. Creating access
does not enroll a machine or allocate a slot; the customer signs in and consents
during application enrollment. The backend checks key possession and allocates
the device binding. This setting does not certify hardware attestation or backend
deployment readiness.

Every admin create is protected, so `POST /api/admin/entitlements` names no
mode: like sync and PATCH, it returns `400 invalid_request` for a body naming
one. Retries must use the same tuple. The UI preserves the original request/key
through **Reconcile status**.

Eligibility and copied policy state are checked in the mutation batch. Conflicts
leave no partial grant, audit event or replay record. Earlier activity for the same
fingerprint, such as a refused device connection, does not block re-creating the
grant. Production still requires the live TPM, browser and backend journey in
the [production readiness](../../doc/operations/production-readiness.md) gates.
The complete deployment requires the backend's baseline schema.

### Device limit

`max_active_devices` is the device limit of a license (entitlement), from 1 to
1,000,000:

- `POST /api/admin/entitlements` accepts it only without a policy. It is written
  in the create's own batch, behind the create's claim, so it commits with the
  grant or not at all. Omitted, a new grant gets 1 and a re-create keeps the
  stored limit; the console sends it only when the field is filled in. With a
  `policy_id` it returns `400 invalid_request`: the policy stamps its own limit.
- `PATCH /api/admin/entitlements/{id}` sets it alone, with the required
  `expected_customer_id`/`expected_revocation_seq` precondition. With another
  PATCH field it returns `400 invalid_request`, because the limit is its own
  audited capacity write; keys a PATCH does not write are ignored, as always.
  A stale precondition returns `409 stale_transition` and writes nothing.
- A protected grant refuses a limit below its connected devices, counted as
  active connections plus disconnected ones still within their hold (ADR 0006).
  A PATCH returns `409 capacity_in_use` with `data.devices_in_use`, the count
  read just after the refusal. A create reports the same rule as
  `protected_creation_conflict` with `data.reason: "invalid_capacity"`, and a
  create that would move a grant with connected devices to another customer as
  `data.reason: "devices_connected"`.

## Hosted setup

Use this Worker alongside the
[licensing backend](../cloudflare-licensing-backend/README.md#hosted-setup-remote-changes).
Both Workers bind the same D1 database; only the backend holds signing keys.
Apply the backend-owned baseline with
`npm run migrate:remote --workspace @licensecc/cloudflare-licensing-backend`
to a newly created database before deploying either service.

From `services/cloudflare-license-admin`, after the root `npm ci`, copy
`wrangler.example.jsonc` to the ignored `wrangler.jsonc` without overwriting an
existing configuration. Configure the intended Worker name and the backend's
exact D1 database name and id. Set these non-secret values:

- `ENVIRONMENT`: `staging` or `production`.
- `ADMIN_DEV_BEARER_ENABLED`: `0`.
- `ADMIN_ACCESS_ISSUER`: your Access team issuer URL.
- `ADMIN_ACCESS_AUDIENCE`: the Access application's audience tag.
- `ADMIN_ACCESS_ADMIN_EMAILS`: the authorized operator email allowlist.
- `ADMIN_ACCESS_READER_EMAILS`: the optional read-only email allowlist.

The example configuration also binds the optional `WEBHOOK_OPERATOR` service to
the backend's `WebhookOperator` entrypoint for **Webhooks → Send test event**.
The backend, which alone holds `WEBHOOK_SIGNING_SECRETS`, signs the test event
the same way as a real delivery. It sends only to an active endpoint's https
URL, never follows a redirect, and waits at most 5 seconds. It returns only the
receiver's status class (`2xx`, `3xx`, `4xx`, `5xx` or `network_error`) and
accepts one test per endpoint per minute. Receivers see
`Licensecc-Event-Source: test` and a body of
`{"type":"test","endpoint_id":...,"sent_at":...}`. Without the binding the route
answers 503 `webhook_operator_not_configured`. Profile materialization pins the
binding to the same profile's backend, as it does for `DEVICE_OPERATOR`. Deploy
the backend version that exports `WebhookOperator` before an admin
configuration that binds it. Each test send the backend attempted also leaves
a `test_send` row in `webhook_events` with the operator, the request id and
the status class; a refused send leaves none. If that audit write fails, it is
logged as `webhook.test_send_audit_failed`, and the test send still reports its
outcome.

Create a Cloudflare Access application and allow policy for the admin hostname
before exposing it. Protect every enabled hostname, including `workers.dev`
if used; disable unused preview URLs. The Worker also validates the Access JWT
and operator role, as described in [Authentication](#authentication).

From this service directory, build and inspect the configured deployment:

```console
npm run build
npx wrangler deploy --dry-run --config wrangler.jsonc
```

After verifying the target account, Access policy, and shared D1 binding,
deploy to the authorized environment from the same directory:

```console
npx wrangler deploy --config wrangler.jsonc
```

Open the admin hostname and sign in through Access. Validate it with the
Access staging drill below. The console manages entitlements and their
validity, disable/re-enable transitions, and audit history; it does not
generate or expose private signing keys. Use the backup service before
operating on production data, as described in [Deployment notes](#deployment-notes).

## Local validation

Install dependencies once from the repository root; the root `package-lock.json`
is authoritative for every Worker workspace:

```sh
npx --yes npm@10.9.8 ci
npm run lint --workspace @licensecc/cloudflare-license-admin
npm run test --workspace @licensecc/cloudflare-license-admin
npm run test:ui --workspace @licensecc/cloudflare-license-admin
npm run test:e2e --workspace @licensecc/cloudflare-license-admin
npm run build --workspace @licensecc/cloudflare-license-admin
npm run dry-run --workspace @licensecc/cloudflare-license-admin
npm run migrate:local --workspace @licensecc/cloudflare-license-admin
```

After the root install, the same `npm run <script>` commands also work from
this service directory; do not create a package-local lockfile.

`npm run migrate:local` applies the backend's baseline migration from
`../cloudflare-licensing-backend/migrations` because the admin service and the
licensing backend share the same D1 schema.

Run `npm run setup:browsers` once from the repository root before browser
checks; that command installs the Playwright Chromium browser for both UI workspaces
(admin and portal). `npm run test:e2e` itself does not install
browsers. It starts a local Vite preview and runs a browser workflow with
mocked admin API responses. It covers create, metadata/validity patch,
disable, reenable, revoke, audit timeline display, duplicate-submit guarding,
and UI secret exposure checks. It does not replace the real Cloudflare Access
staging drill below.

Remote D1 atomicity validation against a staging/test Cloudflare database:

Run the following from this service directory. It creates and later deletes a
temporary Worker and mutates the configured staging/test database; never point
it at production as an evaluation shortcut.

```sh
npm run validate:remote-d1-atomicity -- ../cloudflare-licensing-backend/wrangler.toml
```

The script deploys a temporary authenticated Worker bound to the configured D1
database, forces a failed entitlement/audit `DB.batch()`, verifies that no
partial entitlement or event row persisted, and deletes the temporary Worker.

Cloudflare Access staging validation with a real Access JWT:

Run the following from this service directory with an explicitly authorized,
short-lived staging identity. This drill requires the separate `cloudflared`
binary; it is not installed by `npm ci`. Install it from Cloudflare's
[official downloads](https://developers.cloudflare.com/tunnel/downloads/) and
confirm `cloudflared --version` succeeds first.

In Bash:

```bash
cloudflared access login https://licensecc-admin.example.workers.dev
LICENSECC_ACCESS_USE_CLOUDFLARED=1 node scripts/access-admin-drill.mjs \
  --url https://licensecc-admin.example.workers.dev
```

In PowerShell:

```powershell
cloudflared access login https://licensecc-admin.example.workers.dev
$env:LICENSECC_ACCESS_USE_CLOUDFLARED = "1"
try {
  node scripts/access-admin-drill.mjs `
    --url https://licensecc-admin.example.workers.dev
} finally {
  Remove-Item Env:LICENSECC_ACCESS_USE_CLOUDFLARED -ErrorAction SilentlyContinue
}
```

Successful JSON reports `ok: true`, `mode: "mutation_drill"`, and
`final_status: "revoked"` after cleaning up the scratch entitlement.

The wrapper reads `LICENSECC_ACCESS_JWT` when present, or uses the cached
`cloudflared` application token when `LICENSECC_ACCESS_USE_CLOUDFLARED=1`.
It passes the token as both the Access edge cookie and the origin assertion
header, without putting the token on the command line. The drill verifies
unauthenticated and malformed-JWT rejection, reads the admin summary with the
valid Access JWT, creates a scratch entitlement with an idempotency key, replays
the same mutation without advancing `revocation_seq`, revokes the scratch row
for cleanup, and confirms revoked-terminal reactivation denial. Optionally set
`LICENSECC_NON_ADMIN_ACCESS_JWT=<redacted>` to prove a valid non-admin Access
identity cannot mutate.

For a production post-deploy gate, reuse the validator in read-only mode. It
checks unauthenticated and malformed-token rejection, loads the authenticated
UI shell, and reads the admin summary without creating or changing records:

Run the following from this service directory. Although the application calls
are read-only, the command still sends a credential to the named production
origin and therefore requires operator authorization.

```sh
LICENSECC_ACCESS_JWT=<redacted-short-lived-token> npm run validate:access-admin -- \
  --url https://licensecc-admin.example.workers.dev \
  --read-only
```

## Authentication

Production should be protected by Cloudflare Access. Configure:

- `ADMIN_ACCESS_ISSUER`
- `ADMIN_ACCESS_AUDIENCE`
- `ADMIN_ACCESS_ADMIN_EMAILS`
- `ADMIN_ACCESS_READER_EMAILS`

The Worker validates the Access JWT from `Cf-Access-Jwt-Assertion` using the
issuer JWKS endpoint. Users listed in `ADMIN_ACCESS_ADMIN_EMAILS` can mutate
entitlements. Users listed in `ADMIN_ACCESS_READER_EMAILS` can read only.
Use Access for every hosted environment, including staging.

For local development only, set:

- `ENVIRONMENT=development`
- `ADMIN_DEV_BEARER_ENABLED=1`
- `ADMIN_DEV_BEARER=<local value>`

The Worker refuses dev bearer auth unless `ENVIRONMENT=development`. The Vite
UI does not inject this header automatically; local API smoke tests can use a
manual `Authorization: Bearer <local value>` header or Cloudflare Access.

## API

This list is the complete API route inventory of the canonical dispatcher table
in `src/worker/routes.ts` (`API_ROUTES`): 66 API routes, plus the
`GET /openapi.json` and `GET /docs` meta routes, for 68 in all. Paths use
OpenAPI `{param}` templating. `test/openapi-crosscheck.test.mjs` fails if the
dispatcher, the canonical inventory, and the OpenAPI spec drift apart; update
this list by hand when a route changes.

Summary, reporting, and audit:

- `GET /api/admin/summary`
- `GET /api/admin/report`
- `GET /api/admin/report/timeseries`
- `GET /api/admin/report/expiring`
- `GET /api/admin/audit/verify`

Customers:

- `GET /api/admin/customers`
- `POST /api/admin/customers`
- `GET /api/admin/customers/{id}`
- `POST /api/admin/customers/{id}/disable`
- `POST /api/admin/customers/{id}/reenable`
- `POST /api/admin/customers/{id}/licenses`
- `GET /api/admin/customers/{id}/access`
- `GET /api/admin/customers/{id}/apps`
- `GET /api/admin/customers/{id}/bindings`
- `GET /api/admin/customers/{id}/bindings/{bindingId}/events`
- `POST /api/admin/customers/{id}/bindings/{bindingId}/retire`

License creation requires the administrator role and an `idempotency-key`.
Send `{"project": "<protected project ID>", "label": "<optional>"}`; the label
is trimmed and at most 128 characters; C0 control characters and DEL are
rejected. It inserts
one `lic_<uuid>` record for the customer and returns `license_created` with its
`id`, `customer_id`, `project`, `label` and `created_at` (`no-store`). The same
key replays that response without a second record. An unknown customer is
`404 not_found`; a suspended one is `409 customer_inactive`, checked in the same
statement as the insert. A license record alone grants no access.

Protected binding reads allow readers and administrators, including inspection
of disabled customers. They return at most 100 rows with live keyset pagination,
current authenticated `operator`, and database `server_time` from the same SQL
statement. Both device and entitlement ownership are checked. Binding reads
accept `cursor`, `project`, or exact `binding_id` (exclusive with `cursor`);
event reads accept the canonical decimal `next_cursor`. Last verified contact
does not establish live presence. All responses are `no-store`.

Retirement requires administrator authentication and an active target customer.
Send exactly `{"expected_revision": <displayed revision>}`, a fresh 32-byte
canonical base64url `idempotency-key`, and `x-expected-operator` equal to
`encodeURIComponent(JSON.stringify([operator.actor_type, operator.subject]))`
from the displayed read. Query/fragment delimiters and extra JSON fields are
rejected. The operator header is a precondition, not identity authority.
On timeout, preserve the exact body/key/operator for retry; authenticated exact
recovery lasts 48 hours. A changed operator or conflicting intent requires
review before another action. Retirement stops renewal, advances generation,
and preserves the maximum hold; a lease already accepted by a running process
stays valid until its signed expiry. There is no force-release or
key/ownership override.

The checked example configuration binds `DEVICE_OPERATOR` to the backend
service's `DeviceOperator` entrypoint. Profile materialization pins that binding
to the corresponding backend and rejects cross-profile or hidden overrides.
Deploy the backend capability before the admin integration. A missing or
malformed capability fails closed with `temporarily_unavailable`.
Open **Customers → Apps & access → Connected devices** to inspect bindings,
last verified contact and paginated audit history. Administrators can retire an
active connection after reviewing its binding ID and hold deadline. Reader and
disabled-customer contexts retain inspection and saved-request review.

Before sending, the UI saves the immutable request in customer-scoped tab
session storage and verifies that it can read it back. Unknown outcomes permit
only an exact retry; a GET cannot settle a potentially queued POST. A terminal
denial, changed operator/customer access, already-confirmed success needing
local cleanup, or unreadable saved state permits a current-state review followed
by a separate clear action. Clearing never cancels or reverses retirement.
Recovery remains accessible when customer-detail reads fail and across
customer section navigation. Closing a dialog preserves any sent request.
Hardware transfer and production release qualification remain separate gates.

Licenses, orders, search, and settings:

- `GET /api/admin/licenses`
- `GET /api/admin/orders`
- `GET /api/admin/search`
- `GET /api/admin/settings`

Policies:

- `GET /api/admin/policies`
- `POST /api/admin/policies`
- `GET /api/admin/policies/{id}`
- `PATCH /api/admin/policies/{id}`
- `POST /api/admin/policies/{id}/disable`
- `POST /api/admin/policies/{id}/reenable`

Catalog projects and features:

- `GET /api/admin/catalog/projects`
- `GET /api/admin/catalog/features`
- `POST /api/admin/catalog/features`
- `GET /api/admin/catalog/features/{id}`
- `PATCH /api/admin/catalog/features/{id}`
- `POST /api/admin/catalog/features/{id}/disable`
- `POST /api/admin/catalog/features/{id}/reenable`

Catalog plans and import/export:

- `GET /api/admin/catalog/plans`
- `POST /api/admin/catalog/plans`
- `POST /api/admin/catalog/import`
- `GET /api/admin/catalog/plans/{id}`
- `PATCH /api/admin/catalog/plans/{id}`
- `POST /api/admin/catalog/plans/{id}/disable`
- `POST /api/admin/catalog/plans/{id}/reenable`
- `GET /api/admin/catalog/plans/{id}/export`
- `GET /api/admin/catalog/plans/{id}/features`
- `POST /api/admin/catalog/plans/{id}/features`
- `POST /api/admin/catalog/plans/{id}/features/{featureKey}/disable`
- `POST /api/admin/catalog/plans/{id}/features/{featureKey}/reenable`

License-plan projection:

- `POST /api/admin/license-plans/preview`
- `POST /api/admin/license-plans/apply`

Webhooks:

- `GET /api/admin/webhooks`
- `POST /api/admin/webhooks`
- `GET /api/admin/webhooks/deliveries`
- `POST /api/admin/webhooks/deliveries/{id}/redrive`
- `GET /api/admin/webhooks/{id}`
- `PATCH /api/admin/webhooks/{id}`
- `POST /api/admin/webhooks/{id}/disable`
- `POST /api/admin/webhooks/{id}/reenable`
- `POST /api/admin/webhooks/{id}/test`

Every webhook endpoint names its scope in `scope_kind`: `global` receives every
event (operator-wide), `project` only the entitlement and order events of
`scope_project`, and `customer` only the customer events of `scope_customer_id`.
A create without `scope_kind`, or whose scope values do not match its kind,
returns 400 `invalid_request`; there is no default. A PATCH is checked against
the whole row it would leave, so moving an endpoint to another kind also clears
the old kind's value (`""`). `event_types` is a comma-separated filter of the
event types the dispatcher emits (empty receives every type). A token outside
that set returns 400 `invalid_event_types` on create and on every PATCH,
including one that resends a stored value unchanged or leaves it out. The
database refuses both on its own: a `CHECK` on the scope and two triggers on
`event_types`. Create and PATCH refuse a body naming any other field with 400
`invalid_request`.

Entitlements:

- `GET /api/admin/entitlements`
- `POST /api/admin/entitlements`
- `POST /api/admin/entitlements/batch`
- `GET /api/admin/entitlements/{id}`
- `PATCH /api/admin/entitlements/{id}`
- `POST /api/admin/entitlements/{id}/disable`
- `POST /api/admin/entitlements/{id}/reenable`
- `POST /api/admin/entitlements/{id}/revoke`

Connected devices are read and retired through the customer `bindings` routes
above.

Events:

- `GET /api/admin/events`

User database sync endpoint:

- `POST /api/sync/entitlements`

Mutations require admin role, validate request bodies, atomically increment
`revocation_seq` in D1, and write the entitlement row plus audit event in one
D1 `batch()` transaction. The `Idempotency-Key` header is supported for replay
of completed mutation responses. Mutation requests fail closed if the D1 binding
does not expose `batch()`.

For requests that change an entitlement, the entitlement row, audit event, and
idempotency replay record are written in the same D1 `batch()` transaction. A
no-op request may record replay metadata after the read because no entitlement
mutation occurred.

Revoked entitlements are terminal for this first admin version.

## License mode setup

Every grant is protected. Its `license_mode` is derived, not stored as a
separate operator switch:

- `trial`: `is_trial = 1`
- `node_locked`: every other grant

A grant's only capacity is its device limit, `max_active_devices`: the most
devices that can be connected at once.

Use policy stamping for normal setup. Enable `POLICY_STAMP_MODE=on`, create a
policy, then create an entitlement with that `policy_id`. The policy is frozen
onto the entitlement at stamp time; later policy edits affect new stamps only.
Edit a policy with **Policies → Edit** (`PATCH /api/admin/policies/{id}`); its
project, name, and type cannot change.

A policy is `trial`, `node_locked` or `subscription`. It carries a device
limit, a validity window and trial rules, and nothing else: a create or PATCH
that names any other field returns `400 invalid_request`, as does any other
type.

Node-locked policy example:

```json
{
  "project": "DEFAULT",
  "name": "Pro node locked",
  "type": "node_locked",
  "max_active_devices": 1
}
```

Subscription policy example:

```json
{
  "project": "DEFAULT",
  "name": "Team annual, 5 devices",
  "type": "subscription",
  "duration_sec": 31536000,
  "max_active_devices": 5
}
```

Then stamp an entitlement from either policy:

```json
{
  "project": "DEFAULT",
  "feature": "PRO",
  "license_fingerprint": "<64 hex fingerprint>",
  "policy_id": "<policy id>",
  "customer_id": "cus_123",
  "license_id": "lic_123"
}
```

The stamp always writes an active grant, so a create that selects a policy names
no `status`; a body naming one returns `400 invalid_request`.

For catalog-driven tiers, create catalog features and plans, attach each plan
feature to a policy or set a device limit override on the plan feature, then
use `/api/admin/license-plans/preview` and `/api/admin/license-plans/apply`.
A plan feature carries only its policy and that optional device limit; a plan
feature or imported manifest row that names any other field returns
`400 invalid_request`, and a plan export names none. Runtime
checks read the stamped entitlement rows, not plan or tier names. Plan apply
writes protected grants. An update writes only the validity window, notes,
owner, license, policy, device limit and trial state, so it never makes a
protected grant unusable. A preview item reports each grant's license mode
(`trial` or `node_locked`) and device limit.

Applications use the protected v2 integration: a customer enrolls each device,
and the device limit caps how many are connected at once.

The `/api/sync/entitlements` endpoint creates or updates a protected grant for a
named customer and license ([User database sync](#user-database-sync)); it sets
no device limit. Policies and catalog plan projection stamp the device limit and
trial state. An admin create without a policy, or a PATCH, can set the device
limit directly ([Device limit](#device-limit)).

### Break-glass CLI

The shared D1 helper `../cloudflare-licensing-backend/scripts/entitlement.mjs` is an
operator break-glass path that **bypasses Cloudflare Access**. It stamps
`actor_type='cli'`, `source='cli'`, requires `--actor`, and computes
`revocation_seq` server-side. `upsert` requires `--customer-id` and
`--license-id`: every entitlement it creates is a protected grant with a named
owner, and neither field is cleared or reassigned on a later conflict. Like the
admin Worker it treats revoked as terminal:
`upsert`/`disable`/`reenable` will not change a revoked row, and a guarded no-op
writes no audit event (the helper exits non-zero on `--remote`). To deliberately
reactivate a revoked entitlement, run `upsert --allow-revoked-override --reason
<text>`, which records a distinct `revoked-override` audit event. Mutations run via
`npx wrangler d1 execute --file`, so the entitlement write and its audit event commit
atomically. Prefer the authenticated admin Worker or `/api/sync/entitlements` for
normal, audited writes.

Production deployments should also deploy `../cloudflare-d1-backup` so D1 Time
Travel and scheduled R2 SQL exports are available before admin mutations run
against live data.

## User database sync

Use the sync endpoint when your user database, billing system, or CRM is the
source of truth. Configure `SYNC_API_TOKEN` as a Worker secret:

```sh
npx wrangler secret put SYNC_API_TOKEN
```

Then send a bearer-authenticated projection update:

```json
{
  "project": "DEFAULT",
  "feature": "DEFAULT",
  "license_fingerprint": "<64 lowercase hex fingerprint>",
  "status": "active",
  "customer_id": "cus_123",
  "license_id": "lic_123",
  "valid_until": 1767225600,
  "reason": "subscription active"
}
```

Every synced grant is protected, so the body names no mode. It must name
`customer_id` and `license_id`: the active customer who owns the grant and that
customer's license for the project. A body without either, or one that names
any field a sync does not read (such as a mode), returns `400 invalid_request`,
as do identifiers outside the protected rules
(see [Create protected application access](#create-protected-application-access)).

A sync that creates a grant, or that leaves or makes one active, runs the same
protected checks, D1 batch write, audit event, idempotency and revoked-terminal
rules as an admin create. A refused check returns `409
protected_creation_conflict` with `data.reason` naming the rule, as in the
create reason table, and writes nothing.

Revocations and disables always apply. A sync with status `disabled` or
`revoked` for an existing grant is the same status-only transition an operator
makes: no state of the customer, license, trial or row can block it, and it
keeps the grant's stored owner, license, notes and validity window, whatever the
body names. It records a `disable` or `revoke` audit event with the body's
`reason`, which such a payload requires. A synced revocation stops the grant's
enrolled devices from renewing, even if the customer is later restored.
Reactivating a disabled grant is an active write, so it runs every protected
check again; a revoked grant stays terminal.

Repeated identical projections return the current row without advancing
`revocation_seq`.

CLI smoke example (`--customer-id` and `--license-id` are required; any option
the CLI does not list exits 2 with `unknown option --<name>`):

```sh
LICENSECC_SYNC_TOKEN=<secret> npm run sync:entitlement -- \
  --url https://licensecc-admin.example.workers.dev \
  --fingerprint <64 hex fingerprint> \
  --customer-id cus_123 \
  --license-id lic_123 \
  --status active \
  --reason "subscription active"
```

## Deployment notes

The schema is a single baseline edited in place. After a schema change,
recreate each D1 database and apply the baseline with
`npm run migrate:remote --workspace @licensecc/cloudflare-licensing-backend`
before deploying a Worker version that reads the new columns. Use distinct D1
databases and Access applications for staging and production. Keep the
licensing backend and admin Worker on separate routes.

Do not deploy the admin Worker with local bearer authentication enabled. A
staging deployment should be protected by Cloudflare Access and should validate
`Cf-Access-Jwt-Assertion` against the Access JWKS endpoint before trusting any
identity or role headers.

## Customer workspace reads

`GET /api/admin/customers/{id}/access` returns a bounded grant page using the
existing `entitlements_listed` envelope. The path fixes customer scope; optional
`project` narrows it. Use `limit` (1–100, default 50) and `next_cursor` to read beyond
the customer detail bundle's 200-record cap. Each row includes its exact
entitlement `id`, independent validity dates, stored status, and revision fields.
Use that ID with the entitlement read and lifecycle routes.
This is a grant page, not a complete app-level summary or authorization decision.

`GET /api/admin/catalog/projects` discovers projects from catalog features/plans,
policies, entitlements, licenses, orders, and order events. It includes disabled configuration,
unassigned records, and configured apps with no access grants. It uses the
same bounded pagination and returns `{items: [{project}], next_cursor}` inside the
`projects_listed` envelope. Audit-only strings are not app configuration. There
is no separate app registry.

Both routes require existing admin-reader authorization. Results contain no
credential secrets. Pages have deterministic ordering on unchanged data, but offset
cursors are not snapshots: refresh after concurrent insertion/deletion or mutation.
Account state may change between reads; authoritative mutations must revalidate.

Overview and Reports share one stored-state entitlement aggregate query. An active
count still includes enabled grants whose validity dates may have expired; it is
not a count of currently usable licenses. No cross-report snapshot is implied.

`GET /api/admin/customers/{id}/apps` aggregates every grant belonging to each
returned app before pagination. It returns grant_count, enabled_count,
in_date_count, earliest_expiry, latest_expiry, and no_expiry_count. In-date counts
check grant status/dates only; customer suspension and runtime restrictions still
apply. Mixed expiry is never presented as one app expiry.

The customer Apps & access section consumes these pages and opens a selected
grant's existing editor/lifecycle workflow inline. Customer-scoped mode fixes the
exact grant/owner, hides global filtering and bulk actions, and retains confirmation,
unsaved-draft protection and idempotent recovery. Browse apps in the catalog reads the
complete configuration/business-record inventory, including apps with no plans.

Entitlement PATCH, individual disable/reenable/revoke, and batch transition rows each
require the pair expected_customer_id (the observed owner; every grant has a real one,
so it is never null, empty, blank or padded with whitespace) and expected_revocation_seq
(nonnegative integer). A missing or malformed field returns 400 invalid_request before
any read. A PATCH may move a grant to another customer or license, but a null, empty,
blank or padded customer_id returns 400 invalid_request: the owner is never cleared,
and the editor requires a customer. A move must meet the protected create's owner
rules before any write: an unknown or suspended customer, or a license that is missing
or owned by another customer or project, returns 409 protected_creation_conflict with
data.reason customer_inactive, license_missing or license_customer_mismatch. A PATCH
that changes neither owner nor license is not checked against them.
A mismatched owner or revision returns 409 stale_transition before any write.
Successful same-key retries return the original result; they do not initiate a new
operation. The UI sends this pair for edits, individual lifecycle transitions, and
every row of a batch run. Exact list filters id and customer_id compose with existing
project/feature/status filters.

The baseline schema has a customer/project/feature/fingerprint index for
efficient customer paging. Aggregation and deep offset scans still scale with
customer size.
