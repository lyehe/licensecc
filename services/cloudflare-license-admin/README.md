# licensecc Cloudflare admin

Private control-plane Worker and Vite + React console for managing online
verification entitlements stored in the shared D1 database.

**Audience:** contributors and authorized operators of the hosted control
plane. It is not required for offline native licensing.

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

This service is intentionally separate from the public verifier Worker. The
admin Worker does not bind or use the online assertion signing secret. It owns
ordinary control-plane D1 operations and delegates protected retirement to the
backend's named `DeviceOperator` capability.

## Add a customer portal user

Open **Customers → Add user** and enter a name, login email, and initial
password (15–128 characters). This requires the administrator role. Share the
initial password with the customer securely; no email is sent. They can sign in
to the customer portal and change their password in Account.

The portal must use the same D1 database and have password login enabled.
Creating a user grants no licenses and does not verify ownership of the login
email. Existing login or verified contact emails are rejected; this action
does not attach credentials to an existing customer. If a response is lost,
use **Reconcile status** to recover the original creation safely.

## Create protected application access

Create the customer and its license for the application's project, then open
**License access → New entitlement**. Choose **Protected devices**, set the
application's project and feature, then choose its customer and existing license
and enter the license fingerprint. Changing the project clears dependent selections.
Use the exact lowercase 64-character fingerprint. Protected project and feature
IDs use ASCII letters, numbers, `_`, `.`, `:`, or `-` (127 and 15 characters).
Leave the legacy device hash empty. A selected policy must have zero floating
pool, at least one device slot, and usable trial/expiry settings.

The application must already use the protected v2 integration. Creating access
does not enroll a machine or allocate a slot; the customer signs in and consents
during application enrollment. The backend checks key possession and allocates
the device binding. This setting does not certify hardware attestation or backend
deployment readiness.

Protection is create-only: existing legacy grants cannot be converted in place.
The API accepts `enforcement_mode: "device_bound_v1"` or `"legacy"` on admin
creation only. Omission retains compatibility (legacy insert or existing-mode
upsert); sync and PATCH reject the field. Explicit retries must use the same tuple
and mode. Historical responses without mode cannot establish protected success.
The UI preserves the original request/key through **Reconcile status**.

Eligibility and copied policy state are checked in the mutation batch. Conflicts
leave no partial grant, audit event or replay record. Retained legacy history
blocks protected creation; empty history does not prove that external or pruned
legacy grants never existed. Production still requires the issuer/cohort inventory
and cutover gates in ADR 0006. Apply backend migration 0036 before deploying the
new entitlement projections; the complete deployment requires the current schema.

## Hosted setup

Use this Worker alongside the
[licensing backend](../cloudflare-licensing-backend/README.md#hosted-setup-remote-changes).
Both Workers bind the same D1 database; only the backend holds signing keys.
Apply backend-owned migrations before deploying either service.

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

`npm run migrate:local` applies the shared verifier migrations from
`../cloudflare-licensing-backend/migrations` because the admin service and public
verifier share the same D1 schema.

Run `npm run setup:browsers` once from the repository root before browser
checks; that command installs the Playwright Chromium browser for both UI workspaces
(admin and portal). `npm run test:e2e` itself does not install
browsers. It starts a local Vite preview and runs a browser workflow with
mocked admin API responses. It covers create, metadata/validity/TTL patch,
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

This list is the complete route inventory and is kept in lockstep with the
canonical dispatcher table in `src/worker/routes.ts` (`API_ROUTES`). Paths use
OpenAPI `{param}` templating. `test/openapi-crosscheck.test.mjs` fails if the
dispatcher, the OpenAPI spec, and this inventory drift apart.

Summary, reporting, and audit:

- `GET /api/admin/summary`
- `GET /api/admin/report`
- `GET /api/admin/report/timeseries`
- `GET /api/admin/report/expiring`
- `GET /api/admin/audit/verify`

Customers:

- `GET /api/admin/customers`
- `GET /api/admin/customers/{id}`
- `POST /api/admin/customers/{id}/disable`
- `POST /api/admin/customers/{id}/reenable`
- `GET /api/admin/customers/{id}/bindings`
- `GET /api/admin/customers/{id}/bindings/{bindingId}/events`
- `POST /api/admin/customers/{id}/bindings/{bindingId}/retire`

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
and preserves the maximum hold; existing offline access can continue until its
signed deadline. There is no force-release or key/ownership override.

The checked example configuration binds `DEVICE_OPERATOR` to the backend
service's `DeviceOperator` entrypoint. Profile materialization pins that binding
to the corresponding backend and rejects cross-profile or hidden overrides.
Deploy the backend capability before the admin integration. A missing or
malformed capability fails closed with `temporarily_unavailable`.
Open **Customers → Apps & access → Protected connections** to inspect bindings,
last verified contact and paginated audit history. Administrators can retire an
active connection after reviewing its binding ID and hold deadline. Reader and
disabled-customer contexts retain inspection and saved-request review.

Before sending, the UI saves the immutable request in customer-scoped tab
session storage and verifies that it can read it back. Unknown outcomes permit
only an exact retry; a GET cannot settle a potentially queued POST. A terminal
denial, changed operator/customer access, already-confirmed success needing
local cleanup, or unreadable saved state permits a current-state review followed
by a separate clear action. Clearing never cancels or reverses retirement.
Recovery remains accessible when legacy customer-detail reads fail and across
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

Catalog features:

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

Entitlements:

- `GET /api/admin/entitlements`
- `POST /api/admin/entitlements`
- `POST /api/admin/entitlements/batch`
- `POST /api/admin/entitlements/{id}/release-seats`
- `GET /api/admin/entitlements/{id}`
- `PATCH /api/admin/entitlements/{id}`
- `POST /api/admin/entitlements/{id}/disable`
- `POST /api/admin/entitlements/{id}/reenable`
- `POST /api/admin/entitlements/{id}/revoke`
- `GET /api/admin/entitlements/{id}/devices`
- `GET /api/admin/entitlements/{id}/meter`
- `POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/revoke`
- `POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/disable`
- `POST /api/admin/entitlements/{id}/devices/{deviceKeyId}/reenable`

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

`license_mode` is derived from entitlement capacity, not stored as a separate
operator switch:

- `node_locked`: `pool_size = 0`
- `floating`: `pool_size > 0`
- `trial`: `is_trial = 1`

Use policy stamping for normal setup. Enable `POLICY_STAMP_MODE=on`, create a
policy, then create an entitlement with that `policy_id`. The policy is frozen
onto the entitlement at stamp time; later policy edits affect new stamps only.

Node-locked policy example:

```json
{
  "project": "DEFAULT",
  "name": "Pro node locked",
  "type": "node_locked",
  "pool_size": 0,
  "max_active_devices": 1,
  "max_borrow_sec": 0,
  "assertion_ttl_seconds": 300
}
```

Floating policy example:

```json
{
  "project": "DEFAULT",
  "name": "Team floating 5 seats",
  "type": "floating",
  "pool_size": 5,
  "max_active_devices": 5,
  "max_borrow_sec": 0,
  "assertion_ttl_seconds": 300
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
  "license_id": "lic_123",
  "status": "active"
}
```

For catalog-driven tiers, create catalog features and plans, attach each plan
feature to a policy or set explicit capacity overrides on the plan feature, then
use `/api/admin/license-plans/preview` and `/api/admin/license-plans/apply`.
Runtime checks read the stamped entitlement rows, not plan or tier names.

Client behavior differs by mode:

- Node-locked clients use `/v1/activate` and `/v1/renew`; `max_active_devices`
  controls how many distinct devices can hold a lease in the rebind window.
- Floating clients use `/v1/checkout`, `/v1/heartbeat`, and `/v1/release`;
  `pool_size` is the live seat pool, and `max_borrow_sec > 0` enables bounded
  borrowed/offline seats.

The `/api/sync/entitlements` helper creates the base entitlement projection but
does not expose seat capacity fields. Use policies, catalog plan projection, or
the admin API paths that stamp capacity when setting up floating licenses.

### Break-glass CLI

The shared D1 helper `../cloudflare-licensing-backend/scripts/entitlement.mjs` is an
operator break-glass path that **bypasses Cloudflare Access**. It stamps
`actor_type='cli'`, `source='cli'`, requires `--actor`, and computes
`revocation_seq` server-side. Like the admin Worker it treats revoked as terminal:
`upsert`/`disable`/`reenable` will not change a revoked row, and a guarded no-op
writes no audit event (the helper exits non-zero on `--remote`). To deliberately
reactivate a revoked entitlement, run `upsert --allow-revoked-override --reason
<text>`, which records a distinct `revoked-override` audit event. Mutations run via
`npx wrangler d1 execute --file`, so the entitlement write and its audit event commit
atomically. Prefer the authenticated admin Worker or `/api/sync/entitlements` for
normal, audited writes.

Production deployments should also deploy `../cloudflare-d1-backup` so D1 Time
Travel and scheduled R2 SQL exports are available before admin mutations or
migrations are run against live data.

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
  "license_fingerprint": "<64 hex fingerprint>",
  "status": "active",
  "assertion_ttl_seconds": 300,
  "customer_id": "cus_123",
  "license_id": "lic_123",
  "valid_until": 1767225600,
  "reason": "subscription active"
}
```

The endpoint uses the same validation, D1 batch write, audit event, idempotency,
and revoked-terminal rules as the admin console. Repeated identical projections
return the current row without advancing `revocation_seq`. Disabled and revoked
sync payloads require `reason`.

CLI smoke example:

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

Apply D1 migrations before deploying a Worker version that reads the new
columns. Use distinct D1 databases and Access applications for staging and
production. Keep the public verifier and admin Worker on separate routes.

Do not deploy the admin Worker with local bearer authentication enabled. A
staging deployment should be protected by Cloudflare Access and should validate
`Cf-Access-Jwt-Assertion` against the Access JWKS endpoint before trusting any
identity or role headers.

## Customer workspace reads

`GET /api/admin/customers/{id}/access` returns a bounded grant page using the
existing `entitlements_listed` envelope. The path fixes customer scope; optional
`project` narrows it. Use `limit` (1–100, default 50) and `next_cursor` to read beyond
the legacy customer detail bundle's 200-record cap. Each row includes its exact
entitlement `id`, independent validity dates, stored status, and revision fields.
Use that ID with the existing entitlement read/actions and device/meter routes.
This is a grant page, not a complete app-level summary or authorization decision.

`GET /api/admin/catalog/projects` discovers projects from catalog features/plans,
policies, entitlements, licenses, orders, and order events. It includes disabled configuration,
unassigned legacy access, and configured apps with no access grants. It uses the
same bounded pagination and returns `{items: [{project}], next_cursor}` inside the
`projects_listed` envelope. Audit-only and token-scope-only strings are not app
configuration. No separate app registry or schema migration is introduced.

Both routes require existing admin-reader authorization. Results contain no
credential secrets. Pages have deterministic ordering on unchanged data, but offset
cursors are not snapshots: refresh after concurrent insertion/deletion or mutation.
Account state may change between reads; authoritative mutations must revalidate.
These additions do not replace old routes or change SDK licensing protocols.

Overview and Reports share one stored-state entitlement aggregate query. An active
count still includes enabled grants whose validity dates may have expired; it is
not a count of currently usable licenses. No cross-report snapshot is implied.

`GET /api/admin/customers/{id}/apps` aggregates every grant belonging to each
returned app before pagination. It returns grant_count, enabled_count,
in_date_count, earliest_expiry, latest_expiry, and no_expiry_count. In-date counts
check grant status/dates only; customer suspension and runtime restrictions still
apply. Mixed expiry is never presented as one app expiry.

`GET /api/admin/customers/{id}/resources?kind=nodes|sessions&project=...` independently
paginates node registrations or floating-session records through a customer-owned
grant join. Expired session rows may remain until runtime cleanup; compare their
heartbeat_deadline with server_time. These reader-authorized pages select no
public key material, credentials, or private notes. They use the same bounded
limit/cursor contract and are not snapshot reads.

The customer Apps & access section consumes these pages and opens a selected
grant's existing editor/lifecycle workflow inline. Customer-scoped mode fixes the
exact grant/owner, hides global filtering and bulk actions, and retains confirmation,
unsaved-draft protection and idempotent recovery. Advanced device/seat operations
remain in the global entitlement workspace. Browse apps in the catalog reads the
complete configuration/business-record inventory, including apps with no plans.

Entitlement PATCH and individual disable/reenable/revoke accept the optional pair
expected_customer_id (nullable) and expected_revocation_seq (nonnegative integer).
Both are required when either is supplied. A mismatched owner or revision returns
409 stale_transition before any write. Existing callers may omit both. Successful
same-key retries return the original result; they do not initiate a new operation.
The UI sends this pair for edits and individual lifecycle transitions. Exact list
filters id and customer_id compose with existing project/feature/status filters.

Migration 0035 adds a customer/project/feature/fingerprint index. Apply it through
the backend migration workflow before rollout for efficient customer paging; old
code and schemas remain functionally compatible. No data rewrite or rollback DROP
is required. Aggregation and deep offset scans still scale with customer size.
