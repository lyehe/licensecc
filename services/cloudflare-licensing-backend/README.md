# Licensecc Cloudflare Licensing Backend

Reference Cloudflare Worker for low-volume online license verification.

**Audience:** backend contributors and operators of the optional hosted
platform. Native users who only need offline `.lic` files do not need this
service.

**Status:** Cloudflare D1 is the production target. The local SQLite adapter
backs the backend's own tests and local schema initialization only.
See the [database backend status](../../doc/operations/database-backends.md).

| Goal | Start here | Side effects |
| --- | --- | --- |
| Change backend behavior | Run the focused workspace checks documented below | Local build/test output only |
| Configure a hosted environment | [Hosted setup](#hosted-setup-remote-changes) | Creates or mutates Cloudflare resources and secrets |
| Judge production readiness | [Production readiness](../../doc/operations/production-readiness.md) | Evidence review; deployment remains an operator decision |

Unless a section says otherwise, run service-local commands from
`services/cloudflare-licensing-backend` after one `npm ci` at the repository
root. Blocks labelled staging or production require authority for the named
remote resources; copying this README never grants that authority.

The Worker serves the protected device-bound routes
(`POST /v2/device-authorizations`, `/v2/device-challenges`,
`/v2/device-authorizations/exchange` and `/v2/device-leases/renew`), the signed
order inbox `POST /v1/orders`, and `/health`, `/openapi.json` and `/docs`.
Native hosts check offline `.lic` licenses with `acquire_license_ex()` and use
the device-bound API for protected online sessions.

Two optional Cloudflare rate-limit bindings reject floods at the edge before any
D1 write: `BOUND_REGISTRATION_RATE_LIMITER` for registration and
`BOUND_SESSION_RATE_LIMITER` for challenge, exchange and renewal traffic. The
fixed D1 budgets apply either way, so an unbound limiter is never an outage;
`/health` reports it as a names-only `config_warnings` entry so a stale or
manual deploy that dropped a binding is visible instead of silent.

> **Directory renamed (operator note).** This service directory was renamed
> from `cloudflare-online-verifier` to `cloudflare-licensing-backend` to reflect
> its multiple roles (protected device licensing, order fulfillment, webhooks,
> offline config signer). The deployed Worker `name` and the D1 `database_name` are
> intentionally **unchanged** (still `licensecc-online-verifier`) so live infra
> and hardcoded client URLs are not orphaned. After moving to this path you must
> re-create / reinstall the gitignored working files at the new location:
> `wrangler.toml`, `.dev.vars`, `node_modules/`, and `.wrangler/`. Run
> `npx --yes npm@10.9.8 ci` from the repository root; the root
> `package-lock.json` is authoritative for every Worker workspace.

## Hosted setup (remote changes)

This section provisions or mutates Cloudflare resources. It is not the local
quickstart. Use a dedicated non-production account/environment first and keep
real `wrangler.toml`, `.dev.vars`, databases, and private keys untracked.

1. Create a D1 database:

   ```console
   npx wrangler d1 create licensecc-online-verifier
   ```

2. Copy `wrangler.example.toml` to `wrangler.toml` and set the D1 database id.
   Keep `workers_dev`, `preview_urls`, `observability`, `migrations_dir`, and
   `ratelimits` explicit. If your account cannot use rate-limit bindings,
   remove both `[[ratelimits]]` blocks; the Worker will still run without the
   optional bindings, but the protected deploy workflows require both.
   Cloudflare requires `namespace_id` to be a positive integer string, for
   example `"1001"`.

3. Apply the baseline schema to the newly created database:

   ```console
   npm run migrate:local
   npm run migrate:remote
   ```

   The schema is a single baseline that is edited in place until the first
   release. There is no upgrade path: after pulling a schema change, delete and
   recreate each D1 database (local `.wrangler` state, staging, production,
   restore scratch databases), apply the baseline, and take a fresh backup.
   Backups of an earlier database cannot be restored into the new schema.

4. Store each name listed under
   [Protected deployment readiness checks](#protected-deployment-readiness-checks)
   as a Worker secret with `npx wrangler secret put <NAME>`. Do not commit them,
   and never reuse the license-issuing private key as the protected lease signer.

5. Insert or update an entitlement:

   From the repository root in PowerShell, with an authorized short-lived
   staging sync credential:

   ```powershell
   $env:LICENSECC_SYNC_TOKEN = "<secret>"
   npm run sync:entitlement --workspace @licensecc/cloudflare-license-admin -- `
     --url https://licensecc-admin.example.workers.dev `
     --project DEFAULT --feature DEFAULT `
     --fingerprint <64-hex-fingerprint> `
     --status active `
     --customer-id cus_123 --license-id lic_123 `
     --reason "initial entitlement"
   Remove-Item Env:LICENSECC_SYNC_TOKEN
   ```

   The sync helper writes a protected grant for the named customer and that
   customer's license; both are required. Policies and catalog plans stamp the
   device limit and trial state, never a seat pool, as documented in
   `../cloudflare-license-admin/README.md`.

6. Deploy:

   ```console
   npx --yes npm@10.9.8 ci
   npm run test --workspace @licensecc/cloudflare-licensing-backend
   npm run lint --workspace @licensecc/cloudflare-licensing-backend
   npm run schema:parity --workspace @licensecc/cloudflare-licensing-backend
   npx wrangler deploy
   ```

   After the root install, the same `npm run <script>` commands also work from
   this service directory; do not create a package-local lockfile.

7. Validate protected readiness against the deployed Worker:

   ```console
   npm run validate:protected-smoke -- --url https://licensecc-online-verifier.example.workers.dev
   ```

   The smoke is credential-free; it also fails on any non-empty or malformed
   `config_warnings`, not only on a failed readiness check. The
   [protected-device API](#protected-device-api-staged-implementation) section
   describes what it proves.

## Protected deployment readiness checks

The protected production and staging deployment workflows run a bounded,
name-only Worker secret inventory before any deploy. The check validates the
materialized `wrangler.toml` as the exact environment profile, and requires the
environment-specific `ORDER_INGEST_AUDIENCE`. It then invokes one
`npx wrangler secret list --format json` command with a 30-second timeout and
bounded output. Only secret names are parsed; secret values, Wrangler
diagnostics, the account, and the Worker target are never emitted.

The deployed backend config must also set `compatibility_flags =
["global_fetch_strictly_public"]`. Without it, a `fetch` call from the backend
Worker to a URL on the deployment's own zone (for example an operator-configured
webhook pointed at its own domain) reaches the zone's origin server directly and
bypasses Cloudflare security settings instead of going through the front door.
The materializer refuses to write a backend config that omits this flag or that
also sets `global_fetch_private_origin`. Update the base64
`LICENSECC_BACKEND_WRANGLER_CONFIG_B64` secret to include the flag before the
next deploy; an unmigrated existing config now fails materialization instead of
deploying silently.

The materializer also refuses a backend config whose `vars` lack a valid
`BOUND_DEVICE_CONFIG` or an RSA-3072 `BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM`.
Add both to `LICENSECC_BACKEND_WRANGLER_CONFIG_B64` in both the `staging` and
`production` environments before any protected workflow runs: every workflow
that materializes the backend config (`deploy-production.yml`,
`deploy-staging.yml`, `rollback-workers.yml` and `recovery-drill.yml`) fails at
materialization until they are there, including an emergency rollback. The
materializer also requires exactly two `[[ratelimits]]` bindings,
`BOUND_REGISTRATION_RATE_LIMITER` and `BOUND_SESSION_RATE_LIMITER`, each with a
positive `namespace_id`, `limit` and `period`.

The required deployed secret names are:

- `BOUND_APPROVAL_ENCRYPTION_KEYS`
- `BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM`
- `ORDER_HMAC_SECRETS`
- `ORDER_SIGNER_SCOPES`
- `WEBHOOK_SIGNING_KEY_ID`
- `WEBHOOK_SIGNING_SECRETS`

After materializing an approved protected config, an operator can run the same
check with `npm run validate:secret-inventory -- --profile=staging` (or
`--profile=production`). This proves presence by name, not the contents of a
secret map or whether an active selector names an entry in that map; runtime
health and the signed post-deploy drills remain necessary.

Staging additionally runs `npm run validate:staging-order` with no command-line
arguments. Its URL, dedicated HMAC key id and key bytes, and exact synthetic
fixture are supplied only through the protected staging environment. The
fixture JSON has exactly `subscription_id`, `project`, `feature`, and
`customer_id`; its signer must be authorized for that synthetic project and
customer by both `ORDER_HMAC_SECRETS` and `ORDER_SIGNER_SCOPES`. The drill sends
one bounded `subscription.active` event to `/v1/orders`, requires `200 applied`,
then sends the identical signed request and requires `401 replayed`. Finally it
signs the identical event body with timestamp + 1, requires another `200
applied`, and records that fresh-signature logical retry as a durable cached
result. Evidence
contains only status/`ok`/code classifications, the candidate commit, and fixed
coverage labels. It never contains the URL, key, fixture, request/response
payload, customer, license, or fingerprint.

This remote check proves signed positive ingestion, exact signed-request replay
protection, and the fresh-signature same-event path into the durable cached
application result. The backend integration test separately asserts that this
cached path performs no second mutation. There is still no safe remote
fault-injection point between the durable accept and apply steps, so evidence
explicitly marks crash redrive as
`blocked_external_drill` and is not promotion-eligible. A true crash-redrive
exercise remains an external, controlled staging drill; do not relabel the
duplicate check as crash-redrive evidence.

## Notes

- Order-ingest security has no rollout selector: HMAC verification and
  `ORDER_SIGNER_SCOPES` signer-scope authorization always apply. A missing or
  malformed scope map fails every order closed with `503 config_error`; a
  signer outside its declared scope is refused with `403
  signer_scope_forbidden`. `/health` stays callable: a healthy `200` reports
  `protected_device_ready: true` plus optional names-only `config_warnings`;
  a protected device configuration that fails its local readiness checks
  returns `503` with `protected_device_ready: false`. Static `/openapi.json`
  and `/docs` remain available so operators can inspect this contract during
  a readiness failure.
- Protected device keys are created and held on the client. The C++ client runtime
  provides conditional Windows Platform KSP and Ubuntu TPM2/OpenSSL provider
  surfaces, but they remain platform-specific and are not a universal client
  integration or a hosted-service feature. This service does not claim TPM
  support; callers must provision and configure their provider locally.
- Logs are structured JSON and carry only allowlisted operational fields. Do
  not log lease tokens or private key material.
- `schema.sql` is a generated snapshot of the single baseline migration
  `migrations/0001_baseline.sql`, which stays authoritative and is edited in
  place. After editing the baseline, run `npm run schema:write`;
  `npm run schema:parity` confirms the snapshot and the baseline still match.
- D1 Time Travel is the short-window emergency recovery path. For longer
  retention, deploy the companion backup Workflow in `../cloudflare-d1-backup`
  to export SQL dumps into R2 on a schedule.
- The `scripts/entitlement.mjs` D1 helper is a break-glass operator path. Normal
  hosted writes should use the authenticated admin Worker or its
  bearer-authenticated `/api/sync/entitlements` projection endpoint. The helper
  requires an actor for mutations, stamps events as `actor_type='cli'`,
  `source='cli'`, and increments `revocation_seq` in SQL instead of accepting
  caller-provided sequence values. It runs mutations through `npx wrangler d1 execute
  --file`, which is transactional on both local (`db.batch()`) and remote (the D1
  import path), so the entitlement write and its audit event commit atomically or
  not at all — there is no path that writes the row without the event.
- Revoked entitlements are terminal for v1. `upsert`, `disable`, and `reenable`
  are guarded by `status != 'revoked'` and will not change a revoked row. A
  guarded mutation is a NO-OP: it changes zero rows and writes no audit event. On
  `--remote` the helper detects this (zero `rows_written`) and exits non-zero with
  a notice; on `--local` wrangler reports no row counts, so the helper prints a
  note and you should confirm with `get`. Use `reenable` to reactivate a
  *disabled* entitlement. To intentionally reactivate a *revoked* entitlement
  (e.g. a mistaken revoke), run `upsert --allow-revoked-override --reason <text>`:
  it requires a reason and records a distinct `revoked-override` audit event so
  the override is unmistakable in the log. `upsert` requires `--customer-id` and
  `--license-id`: every entitlement it writes is a protected grant with a named
  owner, and neither field is cleared or reassigned on a later conflict —
  ownership is set once, at creation.
- This reference service does not prevent local binary patching or API hooking.

## Order ingest (`POST /v1/orders`)

The signed, exactly-once subscription-fulfillment inbox (Slice 1). A billing
back-office posts subscription lifecycle events (active / renewed / past_due /
paused / payment_failed / canceled_at_period_end / resumed / quantity.changed /
fraud.confirmed / chargeback) and the Worker projects them onto entitlements.

- **Auth (HMAC).** Headers `X-LCC-Key-Id`, `X-LCC-Timestamp` (canonical integer
  unix seconds), `X-LCC-Signature` (base64 HMAC-SHA256). The signed bytes are
  `"POST\n/v1/orders\n" + ORDER_INGEST_AUDIENCE + "\n" + <ts> + "\n" + <raw body>`
  — verified over the EXACT request bytes via `crypto.subtle.verify`
  (constant-time). `ORDER_HMAC_SECRETS` is a JSON `{ key_id: base64-secret }` map
  (each secret ≥ 32 bytes), loaded into a null-prototype map (so a `__proto__`
  key_id cannot poison the lookup); an empty/short/malformed map fails closed.
  Signer-scope authorization always applies: every key id needs its own
  `ORDER_SIGNER_SCOPES` entry containing at least one non-empty `project` or
  `customer_id` constraint and no other fields. Empty entries, misspellings,
  inherited property names, and malformed values fail configuration closed
  with `503 config_error`; a signer outside its declared scope is refused
  with `403 signer_scope_forbidden`. A customer-scoped signer is checked
  against the `customer.id` every event carries.
- **No rollout selector.** HMAC verification and signer-scope authorization
  always apply; there is no dev-only bypass. `ORDER_INGEST_AUDIENCE` blocks
  cross-environment replay and is asserted non-empty. `ORDER_MAX_SKEW_SECONDS`
  bounds timestamp skew (default 300, cap 3600). A signed-attempt identity
  `(key_id, authenticated_timestamp, sha256(exact_raw_body_bytes))` is spent
  LAST (after verify+skew) in the compatibility `order_ingest_nonces` store;
  an exact signed replay is `401 replayed`, while a freshly signed same-event
  retry can reach the durable event cache. A nonce-store error is a
  fail-closed `503`.
- **Request shape.** The body is a closed object: `event_id`,
  `subscription_id`, `project`, `intent`, non-negative `seq`, and
  `customer.id` are required on every intent, revocations included;
  `feature` defaults to `project`. Unknown top-level, `customer`, or `quantity`
  fields return `400 invalid_order`. Quantity carries only a non-negative
  `max_active_devices` and is required for `quantity.changed`, so a typo cannot
  consume the monotonic floor.
  A billing integration must therefore send the customer id on every event,
  including a revocation or cancellation for which its provider supplies only the
  subscription id.
- **Grants.** `subscription.active` creates or refreshes a protected grant owned
  by the order's customer, with a device limit of `quantity.max_active_devices`
  (default 1); `quantity.changed` changes only that device limit.
- **Grant ownership.** An order may act only on a grant its own `customer.id`
  already owns, or create a new one. If a grant already exists for the order's
  project, feature and fingerprint and another customer owns it, or no one does,
  the order is refused with `409 entitlement_owner_mismatch` for every intent,
  withdrawals included. A refusal before admission writes nothing. An order
  already admitted when the grant changed hands is refused at apply instead: its
  event is recorded as rejected and the subscription cursor has advanced, but the
  grant is untouched and no audit or webhook row is written. A customer-scoped
  signer therefore cannot reach another customer's grant by supplying its
  fingerprint. Orders never change a grant's owner, and a subscription's customer
  is fixed, so after an operator reassigns a grant to another customer, orders can
  no longer reach it.
- **Withdrawals always apply** for the grant's own customer. The withdrawals
  (`subscription.past_due`, `subscription.paused`,
  `subscription.payment_failed`, `subscription.canceled_at_period_end`,
  `fraud.confirmed`, `chargeback`) are never refused because that customer is
  disabled or the period they concern ended long ago, and they never change the
  grant's license. A withdrawal for a subscription with no grant returns `200
  no_entitlement` and creates no grant. It still records the subscription's order
  identity and the order event, and upserts the named customer and license rows.
- **Exactly-once.** Accept-then-apply: a durable cursor advance on
  `orders(order_epoch, last_seq)` + an event claim into `order_events` commit in
  one atomic batch (Step 3); the entitlement mutation and the `order_events`
  `status='processed'` mark commit in the *same* batch (Step 4), guarded by the
  per-entitlement monotonic floor `last_applied_order_{epoch,seq}`. A grant no
  order has applied yet (for example an operator-made one) has floor `(0, -1)`, so
  a first order at `(0, 0)` applies. The entitlement audit row, which webhooks fan
  out, is written only when the order's entitlement write lands. A stale order
  is observably `stale_ignored`; a crashed `accepted` row re-drives idempotently
  (the floor makes re-apply self-superseding). A fingerprint belongs to exactly
  one subscription (`409 fingerprint_owned`), and its grant to exactly one
  customer (`409 entitlement_owner_mismatch`, above).
  The subscription fingerprint/origin pair, its customer id, and any established
  license id are immutable after first use. Omitting `license_id` carries the
  established license forward; a contradictory customer or license id is not a
  transfer operation and returns `400 invalid_order`.
  A global license id also cannot be rebound across projects or contradictory
  explicit customers. These identities are rechecked before admission.
- **Responses.** `200 applied` (with the entitlement snapshot + `license_fingerprint`),
  the stored application result for a freshly signed matching-event retry
  (`cached` is the neutral fallback when terminal result finalization did not
  complete or a legacy terminal row has no stored result), `200 stale_ignored`, `409 seq_conflict`,
  `409 event_id_conflict`, `409 fingerprint_owned`, `409 entitlement_owner_mismatch`, `200 no_entitlement`
  (modify on a never-activated subscription — never materializes access),
  `409 entitlement_revoked` (terminal), `401` (auth family), `400 invalid_order`,
  `503 config_error`, or `503 write_failed`. The body is read once as a bounded raw-byte stream and
  capped at `MAX_ORDER_BODY_BYTES = 16384`; overflow cancels the stream even if
  `Content-Length` is absent or lies. The HMAC is over those original bytes,
  then the body must decode as valid UTF-8 before JSON parsing.
- Set the HMAC key map as a secret: `npx wrangler secret put ORDER_HMAC_SECRETS`.

### Portal OAuth schema

The baseline schema contains portal password credentials and session
authentication provenance, which the password-capable portal uses even if
password sign-in is disabled. Login addresses are stored separately from
customer contact emails until verified; registration grants no licensing access.

The baseline schema also contains provider identities and expiring browser-bound
OAuth state for the customer portal's OAuth routes. New social registrations
create customers without granting licensing access. See the
[portal setup](../cloudflare-customer-portal/README.md#google-and-github-sign-in).

### Protected-device API (staged implementation)

The baseline schema contains persistent device bindings, capacity holds, proof
challenges, authorization attempts, exact operation recovery and audit records.
Every grant is protected, and there is no enforcement mode. Each entitlement names
its owning customer. Its `lease_seconds` defaults to 86400 (24 hours), which is
also the longest lease the issuer signs.
The backend now serves `/v2/device-authorizations`, `/v2/device-challenges`,
`/v2/device-authorizations/exchange` and `/v2/device-leases/renew`. Staged browser
consent is implemented; the native protected consumer remains unfinished. Local
workerd tests exercise real portal sessions, named consent RPC and backend D1;
browser tests separately exercise the UI with API fixtures. This does not prove
an end-to-end production enrollment workflow.
Protected trials use the same proven-device exchange. First successful exchange
atomically records the trial start and device key; browser approval starts no
clock and reserves no slot. Activation-based trials expire at that persisted
start plus their duration; `from_issue` preserves its absolute `valid_until`.
The earliest trial, entitlement or lease deadline caps each signed lease.
Renewal and response recovery recheck current expiry and the optional first-key
lock without restarting the trial. The first-key lock is the proven key id stored
in `trial_device_key_id`.
Consent inspection includes optional `activation_trial_seconds` only for an
unstarted activation-based trial. Its `valid_until` is an optional absolute cap;
for a started trial it is the effective expiry. The portal explains activation
timing instead of presenting a null date as “No expiry.” Deploy the portal
validator/UI update before enabling protected trials in the backend.

Scheduled maintenance deletes expired proof challenges and unconsumed
authorization attempts using the database clock and existing expiry indexes.
Each statement deletes at most 1,000 rows, with up to ten batches per record
type per tick. Repeated or interrupted sweeps are safe; expired rows are already
rejected by request admission. Consumed attempts are retained for the separate
operation-recovery lifecycle. This sweep does not delete devices, bindings,
leases, operation results or audit records, and cannot free a device slot.

Recovery cleanup uses the baseline's operation-tombstone triggers and cleanup
indexes. After the 48-hour recovery deadline, a separate bounded sweep erases
completed operation response payloads and deletes consumed authorization attempts.
Operation identity and digest remain as immutable tombstones: retries cannot
become new issuances after cleanup, and erased responses remain unavailable even
if the database clock moves backward. The database rejects tombstone deletion and
payload restoration. A restore predating the original
operation can omit its tombstone, so backup/cutover qualification remains required.

Lease-table cleanup uses the baseline's `accept_until` index. An indexed sweep
prunes lease rows at `accept_until`, using database time and at most ten
batches of 1,000 rows per tick. Binding identities, generations
and maximum holds remain unchanged. Exact operation responses retain their token
copy for the separate 48-hour recovery window; recovering one never extends its
original expiry. Backup lifecycle qualification remains open; device audit
events follow the retain-until-policy-changes rule documented below.

The authenticated `DeviceConsent` backend capability also exposes
`retire(customerId, { binding_id, expected_revision, operation_id })` for an owned
protected binding. IDs use the same canonical 16-byte binding and 32-byte operation
encoding as the protected protocol. A successful retirement returns `binding_id`,
`state: "retiring"`, `effective_release_at`, `revision` and `generation`.
The backend advances generation/revision once and preserves the maximum hold;
renewal stops immediately, while the slot remains occupied until that hold ends.
`effective_release_at` is the later of the preserved hold and retirement commit
time, so an already-expired hold makes the slot available at retirement.
Expired or disabled entitlements can still be retired by their active owner.

Retirement uses the existing durable operation ledger and one guarded D1 batch
for the operation, binding and audit. Same-intent retries recover the original
result for 48 hours; changed intent or an expired/erased result fails with
`idempotency_conflict`. Neither retry nor retirement creates a lease or deletes
identity. This method is a named service capability, not a public HTTP route:
only bind authenticated callers that derive customer identity from their session.
The customer portal exposes this capability through its session-protected
`POST /api/portal/device-bindings/retire` route. Its Nodes screen lists protected
bindings and confirms retirement, with exact pending-request recovery and
instructions to connect another machine after the hold ends. Physical native
transfer qualification remains a release gate.

The separate named `DeviceOperator` capability exposes only
`retire(actor, customerId, input)` for the admin Worker. The actor must be derived
from verified admin authentication, with exactly `subject`, `actor_type`
(`access` or development `dev`), and `role: "admin"`. The caller chooses the
customer context; the backend rechecks that both device and entitlement belong
to it and that the target customer is active. Operator authentication does not
override this customer-state rule. Subjects must round-trip through UTF-8 exactly.
Never bind the customer portal or an untrusted Worker to this capability.
It cannot approve enrollment, issue leases, edit keys/ownership or shorten holds.

Operator retirement uses the same atomic transition and 48-hour recovery rules.
Its digest additionally binds the authenticated operator; another operator or
customer self-service cannot recover the same operation key as its own intent.
The device audit actor is `operator:<actor_type>:<subject>`; no email is required.
Customer actor/digest encoding is unchanged. The admin Worker owns its protected
read/event/retirement HTTP routes and profile-pinned `DEVICE_OPERATOR` binding;
see its README for the authenticated retry contract and browser operator
inspection/retirement workflow.

The separate named `WebhookOperator` capability exposes only
`sendTest(endpointId)` for the admin Worker's **Send test event**. It loads the
active endpoint, rechecks that its stored URL is https, and signs
`{"type":"test","endpoint_id":...,"sent_at":...}`. Signing uses the same
`WEBHOOK_SIGNING_SECRETS` selector and signer as real deliveries, with
`Licensecc-Event-Source: test`. It POSTs once with a 5-second timeout and no
redirect following, and returns only the receiver's status class. Each endpoint
gets one test per 60 seconds, tracked in `rate_limit_counters` under the
`webhook-test` namespace. It never returns the secret, the signature or any
part of the receiver's response. Bind only the authenticated admin Worker to
this capability.

Because a test send goes to a real receiver, the admin Worker records each one
the backend attempted in `webhook_events` as a `test_send` row: the operator,
the actor type, the request id, the endpoint's unchanged status and the
receiver's status class (including `network_error`) as the reason. A send the
backend refused writes no row. The baseline's `webhook_events` table allows
that event type. If a test-send audit row cannot be written, the admin Worker
logs `webhook.test_send_audit_failed` with the request and endpoint ids, and the
test send still reports the real outcome.

Monitor scheduled protected-device cleanup using structured events:

- `device.cleanup_completed` reports `source`, `target`, `affected_rows` and
  `limit_reached: false`, including zero-row sweeps.
- `device.cleanup_limit_reached` warns when a target reaches the 10,000-row
  per-tick budget. It signals cleanup pressure, not a measured remaining backlog.
  Repeated warnings warrant checking cron delivery and whether incoming expired
  records exceed sweep throughput; do not bypass holds or tombstones to catch up.
- `device.approval_cleanup_failed`, `device.ephemera_cleanup_failed`,
  `device.recovery_cleanup_failed` and `device.lease_cleanup_failed` identify
  failed jobs. Other jobs continue; a failed multi-target job may have partially
  committed earlier batches and safely resumes on the next tick.
- `device.cleanup_backlog` reports a post-sweep primary-database snapshot for
  each source/target: `measured_at`, `backlog_present`, `oldest_expired_at` and
  `backlog_age_seconds`. Present backlogs use warning severity; clear samples
  use info with null deadline/age. A deadline equal to database time is expired
  and has age zero. A full-budget sweep may still have a clear sample; a failed
  sweep may have a measurable backlog. These are independent observations.
- `device.cleanup_backlog_failed` means the snapshot is unavailable or invalid.
  It emits no per-target samples and must not be interpreted as a zero backlog.

The unconsumed-attempt sweep and probe explicitly use the baseline's partial
index `idx_bound_unconsumed_attempt_cleanup` to avoid scanning retained consumed
recovery history. Missing required indexes fail visibly rather than falling
back to a history scan. All six probes use one statement with database time and
fetch only the earliest eligible deadline; they do not count all records, inspect account status or
change authority. Backup restore inventories include the same index;
protected cleanup remains owned by the D1 backend.

Sources are `approval`, `ephemera`, `recovery` and `lease`; targets distinguish
responses, challenges, attempts and leases. Logs contain no row identifiers,
codes, token payloads or database exception text. Alert on repeated failures or
limit warnings, and investigate missing completion events alongside scheduler
invocation evidence. Log absence alone cannot establish that a sweep succeeded.
Graph backlog age by source/target and investigate sustained or growing age,
especially ephemera approaching its 24-hour physical cleanup limit. A clear
sample only proves absence of eligible rows at that snapshot; it says nothing
about later arrivals, tombstones or prepared operations. Alert delivery and
missing-schedule detection must be qualified in the deployed monitoring system;
these structured events do not claim an external alert has been configured.
The required thresholds, invocation/snapshot correlation rules and fault drill
are specified by [OBS-08 in the operations runbook](../../doc/operations/observability.md#protected-device-cleanup-evaluation).

Device audit events are retained without automatic expiry until a different
policy is explicitly decided (user instruction, 2026-09-14). They are excluded
from these cleanup jobs and backlog probes. Enforcement identities, generations,
operation tombstones and slot holds remain protected independently of event
retention. A future audit-history policy must not release slots or erase that
enforcement state.

`npm run test:sql` includes deterministic SQLite boundary tests and the local
Miniflare D1 binding tests for concurrent allocation and complete batch rollback.
Schema parity checks do not replace execution against a deployed D1.

The v2 routes fail closed without `BOUND_DEVICE_CONFIG`. Its non-secret JSON
configuration has this shape (these example hosts do not identify a deployment):

```json
{
  "issuer": "https://licenses.example.test/",
  "audience": "desktop",
  "authorization_url": "https://portal.example.test/connect",
  "clients": [{
    "client_id": "desktop",
    "project": "APP",
    "display_name": "Example app",
    "callbacks": [{ "host": "127.0.0.1", "path": "/callback" }]
  }]
}
```

Issuer and authorization destination must be canonical HTTPS URLs with no query,
fragment or userinfo. Callback hosts are explicitly `127.0.0.1` or `[::1]`;
clients supply a nonzero listener port and the exact registered path. Registry
entries are deployment configuration, not request-supplied customer authority.
The serving `/openapi.json` documents fields and error/retry semantics. Numeric
wire tokens are unsigned decimal safe integers; `challenge_id` is 16 random
bytes and `nonce` is 32, both canonical unpadded base64url.

Configure `BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM` as an independently purposed
Worker secret and `BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM` with its public key.
The pair must use RSA-3072/SHA-256; the key ID is derived from public SPKI. There
is no fallback to the v201 license-signing keys. Keep the private key out of local
tracked configuration and client artifacts. `BOUND_DEVICE_CONFIG` and
`BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM` are deploy-config vars, and the
protected deploy materializer refuses a backend config without a valid registry
and an RSA-3072 PEM public key. `/health` certifies protected readiness:
`protected_device_ready` is true only when the registry parses, the signer pair
signs and verifies, the approval key ring seals and opens, and
`BOUND_GLOBAL_RATE_LIMIT` is valid. The check runs once per Worker isolate. After
a production deploy, `npm run validate:protected-smoke -- --url <backend-origin>`
requires that readiness, refuses any non-empty or malformed `config_warnings`
(a distinct `CONFIG_WARNINGS_PRESENT` failure carrying only the warning count,
never the warning text), and requires an `authorization_unavailable` denial
for an unauthenticated challenge naming an unknown attempt; it prints redacted
JSON evidence. Neither proves a live issuance or renewal. Follow the [protected key rotation runbook](../../doc/operations/device-bound-key-rotation.md)
before switching signers. Old public keys can still be required to load saved
checkpoints after their leases expire; lease expiry alone is not a removal rule.

All four routes share mandatory fixed D1 budgets of 20 requests per client per
minute and 1,000 per backend per minute; the Cloudflare edge limiters also apply
when bound. No configuration switch disables these checks.
Limits run before JSON parsing/key import. Responses are no-store, and 429 includes
`Retry-After: 60`. A request URL must have no query or fragment, including empty
delimiters; those bytes are not part of the signed protocol path.

After a lost response, preserve the device key and exact operation body, obtain
a fresh challenge and sign again. Recovery rechecks current authority and returns
the original response without minting another lease or extending the hold. A
denial of this request does not prove an earlier concurrent/timed-out invocation
never committed. Native clients must preserve the original monotonic send anchor;
a new process requires fresh online renewal. Customer/device denial stops new
issuance, while previously signed offline authority remains bounded by its expiry.

The deployment entrypoint exports `DeviceConsent`, a named Workers RPC capability
with `inspect`, `approve`, and `deny` methods. Bind only the authenticated customer
portal to that entrypoint; the default/public Worker does not expose these methods.
The portal adapter derives customer identity from its session and enforces Origin,
rate limits, idempotency keys and strict parsing of original HTTP bytes before
invoking it. RPC cannot recover duplicate keys or numeric lexemes already lost
through JSON parsing. The portal's browser consent screen owns interactive
review and confirmation. The physical native/browser/backend journey still
requires its separate release qualification.

Registration and inspection return the same immutable enrollment comparison
code. Inspection also supports bounded live keyset pages using the existing
customer/project index; current authority and eligibility are read together.
See the [enrollment protocol reference](../../doc/api/device_enrollment.rst)
for byte-level comparison rules and cursor semantics. The app must independently
recompute the comparison from its own enrollment fields before opening the
browser; the displayed code never replaces PKCE or device-key proof.

Approval recovery requires the separate Worker secret
`BOUND_APPROVAL_ENCRYPTION_KEYS`: JSON with `active` naming a key in `keys`, whose
values are canonical base64url encodings of 32 random bytes. Retain at most three
keys for brief rotation overlap. Never use the lease signing secret for encryption.
Approval recovery ends at code expiry; denial recovery ends at attempt expiry.
Maintenance clears expired approval ciphertext from live rows in bounded indexed
batches, up to 10,000 rows per scheduled run. Logical expiry does not depend on
the sweep. Outages and backlog can delay erasure, and historical backups require
their own retention policy.

Node HTTP tests import `dist/app.js`.
The deployed `src/index.ts` additionally loads the Cloudflare-native RPC runtime;
local workerd tests verify that entrypoint and its service-binding isolation.


### Protected enrollment compatibility and readiness

The baseline schema gives enrollment attempts an immutable optional
`requested_feature`.
New native clients always send it; consent and approval enforce it and the
comparison transcript uses `lcc-device-enrollment-comparison-v2`. Older clients
without the field retain v1 comparison and project-wide consent selection.
Deploy the backend before distributing new native clients.

Protected traffic has a 1,000/minute global fuse (`BOUND_GLOBAL_RATE_LIMIT`,
range 100..1000000), a 20/minute registration IP limit, and a separate
600/minute session-traffic IP limit. The global fuse counts only requests
already admitted by their own per-source budget, so one flooding source
cannot exhaust the shared budget for every other source. After proof and
current authority checks, fresh issuance has a 60/minute device-key limit
and a max(240, 2 × `max_active_devices`)/minute customer limit, computed
from the entitlement being renewed or exchanged and charged against one
counter shared by every entitlement of that customer; replaying an
already-committed operation returns the stored lease without spending
either budget, so idempotent reconciliation is never rate-limited. The
optional `BOUND_REGISTRATION_RATE_LIMITER` Cloudflare rate limiter rejects
registration floods and the optional `BOUND_SESSION_RATE_LIMITER` rejects
session-route (challenge/exchange/renew) floods at the edge, before any D1
write. Neither edge limiter imposes a low
shared-IP budget on short feature jobs. Operators should also add a WAF rate
rule in front of these routes to blunt floods distributed across many source
IPs, which per-source edge and D1 limits cannot address alone.

A per-source identity is the IPv4 address, or the IPv6 /64 prefix (an
IPv4-mapped IPv6 address counts as its IPv4 address), for both the edge and D1
limiters. With the defaults, two sources each at the 600/minute session limit
(1,200/minute) already exceed the 1,000/minute global fuse, so a few sources
can deny protected traffic to everyone. Production operators should raise
`BOUND_GLOBAL_RATE_LIMIT` to their expected peak protected request rate and
enforce a WAF rate rule on the protected routes.

Use `npm run validate:protected-config -- --config=<private-json-config>
--secrets=<private-json-secrets> [--env=<name>]` for local protected registry/signer/key-ring
validation. `--env=<name>` is optional (omit it for the top-level `vars`); when
given, it must follow `--config` and `--secrets`. It does not claim live issuance or renewal. Follow the protected
readiness section of [Cloudflare setup](../../doc/operations/cloudflare-setup.md)
for deployment order and native live qualification.
