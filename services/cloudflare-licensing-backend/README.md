# Licensecc Cloudflare Online Verifier

Reference Cloudflare Worker for low-volume online license verification.

**Audience:** backend contributors and operators of the optional hosted
platform. Native users who only need offline `.lic` files do not need this
service.

**Status:** Cloudflare D1 is the production target. The local SQLite host is
the supported evaluation path; PostgreSQL/Supabase remains fenced and partial.
See the [database backend status](../../doc/operations/database-backends.md).

| Goal | Start here | Side effects |
| --- | --- | --- |
| Evaluate online verification locally | [`local-host/README.md`](local-host/README.md) | Writes a local ignored SQLite database and local signing key only |
| Change backend behavior | Run the focused workspace checks documented below | Local build/test output only |
| Configure a hosted environment | [Hosted setup](#hosted-setup-remote-changes) | Creates or mutates Cloudflare resources and secrets |
| Judge production readiness | [Production readiness](../../doc/operations/production-readiness.md) | Evidence review; deployment remains an operator decision |

Unless a section says otherwise, run service-local commands from
`services/cloudflare-licensing-backend` after one `npm ci` at the repository
root. Blocks labelled staging or production require authority for the named
remote resources; copying this README never grants that authority.

The Worker accepts `POST /v1/verify`, looks up an entitlement in D1, and returns
a signed `lccoa1.<payload_b64>.<signature_b64>` assertion for active
entitlements. Unknown, revoked, disabled, expired, or not-yet-valid
entitlements return a generic unsigned denial by default. The accepted C++
library exposes `acquire_license_ex()` and the secure
`lcc_acquire_license_decision()` entry point in its public header/source. Core
does not perform HTTP: the host implements the `LCC_ONLINE_CHECK` callback,
calls this Worker from that callback, and returns the assertion to the C++ API.

For production C++ hosts, use `lcc_acquire_license_decision()`. It requires
online verification and host callbacks that load and store the strongest
persisted revocation sequence for the exact project/feature/fingerprint tuple;
it fails closed when those callbacks or the signed assertion are unavailable.
`acquire_license_ex()` remains available for lower-level integrations, but its
revocation floor is process-local unless the host restores a persisted floor
with the public floor helpers.

The successful hot path is one validated request, rate-limit checks, one D1
lookup by primary key, one signed assertion, and one JSON response. The Worker
also supports an optional Cloudflare rate-limit binding named
`VERIFY_RATE_LIMITER`.

> **Directory renamed (operator note).** This service directory was renamed
> from `cloudflare-online-verifier` to `cloudflare-licensing-backend` to reflect
> its multiple roles (online verifier, offline config signer, device/relay
> tooling). The deployed Worker `name` and the D1 `database_name` are
> intentionally **unchanged** (still `licensecc-online-verifier`) so live infra
> and hardcoded client URLs are not orphaned. After moving to this path you must
> re-create / reinstall the gitignored working files at the new location:
> `wrangler.toml`, `.dev.vars`, `.online-key/`, `node_modules/`, and
> `.wrangler/`. Run `npx --yes npm@10.9.8 ci` from the repository root; the root
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
   `ratelimits` explicit. If your account cannot use the rate-limit binding,
   remove `[[ratelimits]]`; the Worker will still run without the optional
   binding. Cloudflare requires `namespace_id` to be a positive integer string,
   for example `"1001"`.

3. Apply migrations:

   ```console
   npm run migrate:local
   npm run migrate:remote
   ```

4. Generate a dedicated online assertion key:

   ```console
   npm run generate-online-key -- --out-dir .online-key
   ```

   Store `.online-key/online_private_key.pkcs8.pem` as a Worker secret and pass
   the generated `LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` CMake value when
   building the C++ verifier. Production verifier builds fail closed without a
   configured online assertion public key ring. Do not reuse the license-issuing
   private key for online assertions.

5. Store signing material as Worker secrets:

   ```console
   npx wrangler secret put ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM
   npx wrangler secret put ONLINE_SIGNING_KEY_ID
   ```

   The private key must be PKCS#8 PEM. Do not commit it. `ONLINE_SIGNING_KEY_ID`
   must match a public key id trusted by the C++ online assertion verifier.

6. Insert or update an entitlement:

   From the repository root in PowerShell, with an authorized short-lived
   staging sync credential:

   ```powershell
   $env:LICENSECC_SYNC_TOKEN = "<secret>"
   npm run sync:entitlement --workspace @licensecc/cloudflare-license-admin -- `
     --url https://licensecc-admin.example.workers.dev `
     --project DEFAULT --feature DEFAULT `
     --fingerprint <64-hex-fingerprint> `
     --status active --assertion-ttl 300 `
     --customer-id cus_123 --license-id lic_123 `
     --reason "initial entitlement"
   Remove-Item Env:LICENSECC_SYNC_TOKEN
   ```

   The sync helper writes the base entitlement projection and is appropriate for
   simple node-locked access. Floating seats require capacity fields
   (`pool_size > 0`) and should be created through the admin policy or
   catalog-plan flows documented in `../cloudflare-license-admin/README.md`.

7. Optional: enroll a device signing key for request proof-of-possession.
   Generate the key on the client/device side, keep the private key in that
   app's platform key store, and register only the generated public SPKI record:

   ```console
   npm run device-key -- generate --out-dir .device-key
   npm run entitlement -- device-upsert --fingerprint FINGERPRINT_64_HEX --device-key-id sha256:KEY_ID_64_HEX --public-key-spki-der-base64 PUBLIC_KEY_SPKI_DER_BASE64 --actor operator@example.com --reason "initial device enrollment" --remote
   ```

   Replace the uppercase values with the entitlement fingerprint and the
   generated public-key record before running the command.

   The generated private-key file is for local integration tests and bootstrap
   only. Production hosts should create or import the P-256 key through their
   own platform key-store or secure-enclave integration when available, then
   persist only the public SPKI and `sha256:<spki der>` key id. The optional
   request-proof protocol is available for integration. The C++ client runtime
   provides conditional Windows Platform KSP and Ubuntu TPM2/OpenSSL provider
   surfaces, but they remain platform-specific and are not a universal client
   integration or a hosted-service feature. This service does not claim TPM
   support; callers must provision and configure their provider locally.

   To smoke-test the signed request body fields during integration:

   ```console
   npm run device-key -- sign --private-key .device-key/device_private_key.pkcs8.pem --device-key-id sha256:KEY_ID_64_HEX --fingerprint FINGERPRINT_64_HEX --nonce NONCE_64_HEX
   ```

   Replace the uppercase values with the exact registration and request values.

8. Deploy:

   ```console
   npx --yes npm@10.9.8 ci
   npm run test --workspace @licensecc/cloudflare-licensing-backend
   npm run lint --workspace @licensecc/cloudflare-licensing-backend
   npm run schema:parity --workspace @licensecc/cloudflare-licensing-backend
   npx wrangler deploy
   ```

   After the root install, the same `npm run <script>` commands also work from
   this service directory; do not create a package-local lockfile.

9. Validate a remote Worker-signed assertion with the C++ verifier test against
   a staging/test D1 database:

   ```console
   npm run validate:remote-cpp -- wrangler.toml ../../build Debug
   ```

   The script deploys a temporary verifier Worker with generated online signing
   key material, creates a scratch entitlement, obtains a real `lccoa1`
   assertion, runs `test_online_verification` with the matching public key,
   revokes the scratch entitlement, deletes the temporary Worker, and removes
   temporary key material.

10. Validate the public verifier abuse controls against a staging Worker:

   ```console
   npm run validate:public-verifier --url=https://licensecc-online-verifier.example.workers.dev --expect-rate-limit --json
   ```

   In a legacy unproved configuration the drill sends a malformed request, an
   unknown-entitlement request, and a bounded burst from one source. In the
   protected deployment workflows it instead reads a dedicated registered
   fixture and P-256 private key from `LICENSECC_PUBLIC_VERIFIER_*`, signs a
   fresh proof for every structurally valid request, requires a signed allow,
   observes `429 rate_limited`, waits for a proof-authenticated signed recovery,
   and redacts the target, fixture, proof key, fingerprint, and assertion.
   Use `--flag=value` form when invoking through `npm run`; the script also
   supports direct `node scripts/public-verifier-drill.mjs --url <url> ...`.

### Machine activation and renewal

The hosted setup above configures online assertions. To also use
`/v1/activate` and `/v1/renew`, configure the separate lease signer. From
`services/cloudflare-licensing-backend`, after configuring the intended remote
Worker, store its PKCS#8 private key and matching key id interactively:

```console
npx wrangler secret put LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM
npx wrangler secret put LEASE_SIGNING_KEY_ID
```

Use a dedicated lease-signing key, and distribute its matching public key to
the client license verifier. The online assertion key and lease key serve
different verification paths; configuring only `ONLINE_SIGNING_*` does not
enable lease issuance. Keep private keys in Worker secrets, never in D1 or the
admin UI.

Keep `ACCOUNT_TOKEN_MODE=required`, configure `ACCOUNT_TOKEN_PEPPERS`, and
issue a scoped account token using `scripts/account-token.mjs`. An entitlement
must belong to the token's customer. For device ownership proof on activation
and renewal, set `DEVICE_PROOF_MODE=required` and enroll the device public key
as described above. The client must sign each request with its device-held
private key. `REQUEST_SIGNATURE_MODE=required` protects online verification;
it does not replace the separate lease proof selector. This device-required
profile is for direct device clients, not the standard portal deployment
profile described below.

Use the [admin Worker](../cloudflare-license-admin/README.md#hosted-setup)
against the same D1 database to create entitlements, extend `valid_until`, and
disable or re-enable licenses and enrolled device keys. D1 stores validity,
device records, lease issuance history, and the entitlement `revocation_seq`.
That sequence is a revocation floor, not a per-activation revision counter.

There is currently no client `/v1/deactivate` route. `/v1/release` releases a
floating seat; admin device disabling prevents subsequent proof-authorized
use but does not release the node-locked issuance-history rebind cap. Already
issued offline leases remain subject to their signed expiry and the client's
online-verification policy. Applications requiring self-service machine
transfer need an explicit deactivation contract before deployment.

## Capacity and observability evidence

`npm run capacity:public-verifier` is the bounded, open-loop load harness for
the production-readiness `PRD-05` public-verification objectives. It always
requires a declared peak rate `P` and maximum in-flight concurrency. The
acceptance modes cannot be shortened below their contract durations:

| Mode | Offered load | Minimum duration | Promotion use |
| --- | ---: | ---: | --- |
| `burst` | `2P` | 30 minutes | Acceptance evidence for the burst objective |
| `soak` | `P` | 4 hours | Acceptance evidence for the soak objective |
| `rehearsal` | `P` | 0.1 seconds; 60-second cap | Fast local/CI validation only; never acceptance evidence |

Run acceptance modes only against an approved staging environment containing
a dedicated active entitlement. Supply sensitive request identity through the
environment so it is not copied into shell history, and record the exact
candidate commit explicitly:

```powershell
$env:LICENSECC_CAPACITY_URL = "https://staging-verifier.example.workers.dev"
$env:LICENSECC_CAPACITY_FINGERPRINT = "<dedicated-staging-64-hex-fingerprint>"
$env:LICENSECC_CAPACITY_PEAK_RPS = "<declared-P>"
$env:LICENSECC_CAPACITY_MAX_CONCURRENCY = "<declared-concurrency>"
$env:LICENSECC_CAPACITY_ENVIRONMENT = "staging"
$env:LICENSECC_RELEASE_COMMIT = "<exact-40-hex-commit>"
npm run capacity:public-verifier -- --mode=burst
npm run capacity:public-verifier -- --mode=soak
```

The public `/v1/verify` route does not use account-token Authorization, so the
capacity harness neither accepts nor sends an account token. Account-token and
lease-signing readiness are exercised by the separate protected staging lease
drill. When request proof is enforced, set
`LICENSECC_CAPACITY_DEVICE_PRIVATE_KEY_PKCS8_PEM` and
`LICENSECC_CAPACITY_DEVICE_KEY_ID` to a dedicated registered staging P-256 key.
The key is imported once in memory and signs a fresh nonce and timestamp for
every request; neither key material nor key id appears in evidence. A short
plumbing check is explicitly labeled and emitted as non-promotable:

```powershell
npm run capacity:public-verifier -- --mode=rehearsal --url=http://127.0.0.1:8787 --peak-rps=5 --max-concurrency=2 --duration-seconds=5 --fingerprint=<64-hex> --expected-result=deny
```

Each run emits one JSON evidence document to standard output. It records the
declared and offered rates, planned/dispatched/completed totals, scheduling
misses, achieved throughput, maximum concurrency, p50/p95/p99 latency,
availability, unexpected-server-error percentage, status counts, and separate
allow, entitlement-deny, and rate-limit classifications. Acceptance modes use
representative `allow` traffic and enforce all of these checks: p95 below 500
ms, p99 below 1 second, recognized-response availability at least 99.9%,
allowed responses at least 99.9%, unexpected server errors below 0.1%, no
unexplained error class, and no dropped scheduled request. The target URL,
project, feature, fingerprint, device hash, request body,
response body, and signed assertion are never included in evidence.

The harness caps concurrency at 512, each request at the Worker's 4,096-byte
body limit, each response at 65,536 bytes, and each request timeout at 60
seconds. A concurrency-saturated scheduler records missed requests and fails
the run instead of building an unbounded queue. A single-source load can
legitimately encounter the public client-network limiter; those `429`
responses are reported separately and fail an acceptance run's representative
`allow` check. Use approved distributed staging runners or a reviewed staging
rate-limit profile when the declared traffic model has multiple sources.

Capacity evidence does not by itself prove the observability half of `PRD-05`.
For the same UTC window, retain Workers Logs/dashboard evidence, exercise the
documented elevated-error and stale-backup alert paths, and inspect structured
logs for tokens, OTPs, signing material, license payloads, and customer data.
The exact dashboard panels, thresholds, drill sequence, and evidence fields are
defined in [`doc/operations/observability.md`](../../doc/operations/observability.md).
Do not run the harness against production unless that separate operator action
is explicitly approved.

## Protected deployment readiness checks

The protected production and staging deployment workflows run a bounded,
name-only Worker secret inventory before any deploy. The check validates the
materialized `wrangler.toml` as the exact environment profile, requires
`REQUEST_SIGNATURE_MODE`, `ACCOUNT_TOKEN_MODE`, `ORDER_INGEST_MODE`, and
`ORDER_SIGNER_SCOPE_MODE` to be `required`, requires `DEVICE_PROOF_MODE=off`
for the standard portal-compatible topology, requires
the environment-specific `ORDER_INGEST_AUDIENCE`, and requires a structured
`ACCOUNT_TOKEN_ACTIVE_PEPPER_ID`. It then invokes one
`npx wrangler secret list --format json` command with a 30-second timeout and
bounded output. Only secret names are parsed; secret values, Wrangler
diagnostics, the account, and the Worker target are never emitted.

The required deployed secret names are:

- `ACCOUNT_TOKEN_PEPPERS`
- `LEASE_SIGNING_KEY_ID`
- `LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM`
- `ONLINE_SIGNING_KEY_ID`
- `ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM`
- `ORDER_HMAC_SECRETS`
- `ORDER_SIGNER_SCOPES`
- `WEBHOOK_SIGNING_KEY_ID`
- `WEBHOOK_SIGNING_SECRETS`

After materializing an approved protected config, an operator can run the same
check with `npm run validate:secret-inventory -- --profile=staging` (or
`--profile=production`). This proves presence by name, not the contents of a
secret map or whether an active selector names an entry in that map; runtime
health and the signed post-deploy drills remain necessary.

The standard four-Worker topology keeps `DEVICE_PROOF_MODE=off` because the
current portal checkout/download flows do not originate a device-held proof.
That selector controls whether proof is mandatory; a proof that is presented
is still always verified. The staging workflow therefore runs
`npm run validate:staging-lease` against the exact materializer-bound backend
URL using a dedicated active entitlement, scoped account token, registered
P-256 device key, expected lease key id, and matching RSA PKCS#1 DER public key
supplied only through protected environment values. The workflow provides the
last value as `LICENSECC_STAGING_LEASE_PUBLIC_KEY_PKCS1_DER_BASE64`; this
workflow-only public key is not part of the deployed Worker secret inventory.
Its canonical DER SHA-256 must equal the expected lease key id before any
request is sent. The drill sends fresh, separately signed `/v1/activate` and
`/v1/renew` requests. Both must return a bounded v201 lease with the expected
feature section, expected key id, time envelope, and an RSA-SHA256 signature
that verifies over the shared v201 canonical payload after reinserting the
protected fixture project and feature. The time check requires
`server_time < renew_by <= valid_to_epoch`, a server clock within 300 seconds
of the signed request, a signed interval containing the server UTC date, and a
signed `valid-to` date matching `valid_to_epoch`. This exercises account-token
authorization for the one protected fixture tuple, registered-device proof,
and the server lease-signing path
without emitting the token, private key, fixture, lease, customer, license, or
fingerprint. Evidence records only the verification booleans, not the public
key, key id, signature, or canonical payload. It does not exercise a negative
cross-scope token request, so it is not proof of least-privilege denial outside
that tuple.

These direct drill credentials must never be copied into browser or portal
runtime configuration. An architecture-correct future portal proof flow would
generate or load a non-exportable P-256 key on the end device, register only
its public SPKI/key id, and sign a fresh purpose-bound nonce locally. The drill
fixture and canonical proof helper demonstrate the protocol, but its protected
server-side private key is not a suitable portal implementation.

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

- Licensecc online verification is intentionally fail-closed: once a host
  supplies `online_check`, the C++ runtime requires a fresh signed assertion.
- Production C++ hosts should prefer `lcc_acquire_license_decision()`. It
  requires online verification plus host callbacks that load and store the
  strongest accepted `revocation_seq` for each project/feature/fingerprint
  tuple, so normal process restarts cannot silently accept older assertions.
- Direct `acquire_license_ex()` integrations keep a last-seen `revocation-seq`
  floor only for the current process. Use the decision wrapper or restore a
  host-persisted floor with the public floor helpers before checking licenses.
- Request `client_hardening` is telemetry only. The Worker logs it on allow and
  deny paths for operator visibility, but it is not included in the signed
  assertion payload and must not be treated as proof of host integrity.
- Request proof-of-possession is opt-in. Set `REQUEST_SIGNATURE_MODE=soft` to
  log missing or invalid device-key proof while preserving otherwise-valid
  allows, then move selected products to `required` only after clients register
  device keys and support has a recovery path. `off` is the compatibility
  default. Security rollout selectors are exact: `ACCOUNT_TOKEN_MODE`,
  `REQUEST_SIGNATURE_MODE`, `DEVICE_PROOF_MODE`, and
  `ORDER_SIGNER_SCOPE_MODE` accept only their documented lowercase values.
  An unset/empty value keeps its legacy `off` default; any other non-empty
  value fails closed with `503 config_error`. `/health` stays callable: a
  healthy `200` reports normalized `account_token_mode` plus optional
  names-only `config_warnings`; invalid configuration returns `503
  config_error` with selector names only. Static `/openapi.json` and `/docs`
  remain available so operators can inspect this contract during a readiness
  failure.
- `required` request-proof mode expects `request_signature_version=1`,
  `device_key_id=sha256:<64-hex>`, `request_timestamp`,
  `request_signature_algorithm=ecdsa-p256-sha256`, and a base64
  `request_signature` over the canonical request payload. The public key is
  loaded from `entitlement_devices.public_key_spki_der_base64` for the exact
  project/feature/license fingerprint and device key id.
- `REQUEST_SIGNATURE_MAX_SKEW_SECONDS` bounds request timestamp skew for proof
  verification. Keep the default small for production, and use `soft` mode to
  learn whether customer clocks or proxies need product-specific handling before
  enforcing it.
- Active entitlement assertions use `assertion_ttl_seconds` and are clamped to
  `valid_until` when that optional D1 column is set. A `NULL` validity window
  means unbounded.
- Denied entitlements are unsigned to avoid spending signing CPU on arbitrary
  unknown fingerprints.
- `VERIFY_RATE_LIMITER` protects the public verification endpoint before D1 is
  queried. The key is client-network scoped (`client:<ip>`) so rotating license
  fingerprints from one source cannot bypass the Cloudflare binding.
- `D1_RATE_LIMIT_ENABLED=1` enables deterministic fixed-window D1 fallback
  limiters. The Worker checks a client-network tier and an entitlement tier by
  default. Optional per-tier overrides are available through
  `D1_CLIENT_RATE_LIMIT_*`, `D1_ENTITLEMENT_RATE_LIMIT_*`, and
  `D1_GLOBAL_RATE_LIMIT_*`. D1 fallback limiting adds D1 writes before each
  entitlement lookup, so keep it conservative for low-volume deployments.
- Rate-limit tier defaults are a deliberate low-scale decision, not an omission:
  the client-network tier and the entitlement tier are on (with
  `D1_RATE_LIMIT_ENABLED`, plus the optional Cloudflare `VERIFY_RATE_LIMITER`),
  and the global tier is **off** by default because it adds a contended D1 write
  on every request. Enable `D1_GLOBAL_RATE_LIMIT_ENABLED=1` only if you observe
  rotating-fingerprint abuse spread across many client IPs (where the per-IP and
  per-entitlement tiers cannot bound the aggregate). Validate that a
  rotating-fingerprint flood from one source is still limited with
  `npm run validate:public-verifier -- --url <staging> --rotate-fingerprint
  --expect-rate-limit`: distinct fingerprints cannot trip the entitlement tier,
  so a 429 proves the client-network tier holds. The HTTP response is a single
  `rate_limited` code for every tier; the limiting tier appears only in the
  `LOG_RATE_LIMIT_DECISIONS` server log.
- Set `LOG_RATE_LIMIT_DECISIONS=1` temporarily when validating a live rate-limit
  binding; leave it unset during normal operation.
- Logs are structured JSON and redact fingerprints/device hashes. Do not log
  assertions or private key material.
- `schema.sql` is a snapshot of the final schema. The forward migrations remain
  authoritative; run `npm run schema:parity` after schema edits to confirm the
  snapshot and migrations still match.
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
  the override is unmistakable in the log. `upsert` also accepts optional
  `--customer-id`/`--license-id`; unspecified mutable fields use command defaults
  and reset to their defaults on conflict.
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
  In signer-scope `required` mode, every key id needs its own
  `ORDER_SIGNER_SCOPES` entry containing at least one non-empty `project` or
  `customer_id` constraint and no other fields. Empty entries, misspellings,
  inherited property names, and malformed values fail configuration closed.
  A customer-scoped sender must include that customer id on every event,
  including events whose entitlement mutation would otherwise carry it forward.
- **Mode.** `ORDER_INGEST_MODE`: `required` (default), `soft` (verify + observe,
  never mutates), `off` (dev-only, 404). `ORDER_INGEST_AUDIENCE` blocks
  cross-environment replay and is asserted non-empty in `required`.
  `ORDER_MAX_SKEW_SECONDS` bounds timestamp skew (default 300, cap 3600). A
  signed-attempt identity `(key_id, authenticated_timestamp,
  sha256(exact_raw_body_bytes))` is spent LAST (after verify+skew) in the
  compatibility `order_ingest_nonces` store; an exact signed replay is `401
  replayed`, while a freshly signed same-event retry can reach the durable
  event cache. A nonce-store error is a fail-closed `503`.
- **Request shape.** The body is a closed object: `event_id`,
  `subscription_id`, `project`, `intent`, and non-negative `seq` are required;
  `feature` defaults to `project`. Unknown top-level, `customer`, or `quantity`
  fields return `400 invalid_order`. Quantity supports only non-negative
  `pool_size` and `max_active_devices`, must be non-empty when present, and is
  required for `quantity.changed`, so a typo cannot consume the monotonic floor.
- **Exactly-once.** Accept-then-apply: a durable cursor advance on
  `orders(order_epoch, last_seq)` + an event claim into `order_events` commit in
  one atomic batch (Step 3); the entitlement mutation and the `order_events`
  `status='processed'` mark commit in the *same* batch (Step 4), guarded by the
  per-entitlement monotonic floor `last_applied_order_{epoch,seq}`. A stale order
  is observably `stale_ignored`; a crashed `accepted` row re-drives idempotently
  (the floor makes re-apply self-superseding). A fingerprint belongs to exactly
  one subscription (`409 fingerprint_owned`).
  The subscription fingerprint/origin pair and any established non-null
  customer/license ids are immutable after first use. Omitting customer/license
  fields carries the established entitlement values forward; contradictory
  explicit values are not a transfer operation and return `400 invalid_order`.
  A global license id also cannot be rebound across projects or contradictory
  explicit customers. These identities are rechecked before admission.
- **Responses.** `200 applied` (with the entitlement snapshot + `license_fingerprint`),
  the stored application result for a freshly signed matching-event retry
  (`cached` is the neutral fallback when terminal result finalization did not
  complete or a legacy terminal row has no stored result), `200 stale_ignored`, `409 seq_conflict`,
  `409 event_id_conflict`, `409 fingerprint_owned`, `200 no_entitlement`
  (modify on a never-activated subscription — never materializes access),
  `409 entitlement_revoked` (terminal), `401` (auth family), `400 invalid_order`,
  `503 config_error`, or `503 write_failed`. The body is read once as a bounded raw-byte stream and
  capped at `MAX_ORDER_BODY_BYTES = 16384`; overflow cancels the stream even if
  `Content-Length` is absent or lies. The HMAC is over those original bytes,
  then the body must decode as valid UTF-8 before JSON parsing.
- Set the HMAC key map as a secret: `npx wrangler secret put ORDER_HMAC_SECRETS`.

### Portal OAuth schema

Migration `0034_portal_passwords.sql` adds portal password credentials and session
authentication provenance. Apply it before deploying the password-capable portal,
even if password sign-in is disabled. Login addresses are stored separately from
customer contact emails until verified; registration grants no licensing access.
The existing backend and admin remain compatible with this additive migration.

Migration `0033_portal_oauth.sql` adds provider identities and expiring browser-bound
OAuth state for the customer portal. Apply it before deploying the portal OAuth
routes; existing backend/admin deployments remain compatible. New social
registrations create customers without granting licensing access. See the
[portal setup](../cloudflare-customer-portal/README.md#google-and-github-sign-in).

### Protected-device API (staged implementation)

Migration `0036_device_bound_licensing.sql` adds persistent device bindings,
capacity holds, proof challenges, authorization attempts, exact operation
recovery and audit records. Apply it before deploying the backend lookup changes:
v1 verification, leases and floating-seat paths now select only legacy-mode
entitlements. Existing entitlements default to `legacy`; no customer is opted in.
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
lock without restarting the trial. Existing legacy trials retain their own path.
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

Migration `0038_bound_recovery_retention.sql` must precede deployment of recovery
cleanup. After the 48-hour recovery deadline, a separate bounded sweep erases
completed operation response payloads and deletes consumed authorization attempts.
Operation identity and digest remain as immutable tombstones: retries cannot
become new issuances after cleanup, and erased responses remain unavailable even
if the database clock moves backward. The database rejects tombstone deletion and
payload restoration. A restore predating the original
operation can omit its tombstone, so backup/cutover qualification remains required.

Migration `0039_bound_lease_cleanup.sql` must precede deployment of lease-table
cleanup. An indexed sweep prunes lease rows at `accept_until`, using database time
and at most ten batches of 1,000 rows per tick. Binding identities, generations
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

Apply migration `0040_bound_unconsumed_cleanup.sql` before deploying this
measurement/cleanup code. The unconsumed-attempt sweep and probe explicitly use
its partial index to avoid scanning retained consumed recovery history. Missing
required indexes fail visibly rather than falling back to a history scan. All
six probes use one statement with database time and fetch only the earliest
eligible deadline; they do not count all records, inspect account status or
change authority. PostgreSQL schema and backup restore inventories include the
same index; protected cleanup remains owned by the D1 backend.

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

In-place `legacy` to `device_bound_v1` updates fail with
`protected_mode_migration_required`. Pruned issuance history, released borrowed
seats and external offline licenses prevent empty current tables from proving
that legacy authority has drained. The backend/release owner must complete the
reviewed cutover-evidence protocol and restore tests before replacing that guard.
Use fresh synthetic protected-only entitlements for development; this migration
does not authorize enabling protection for existing customers.

`npm run test:sql` includes deterministic SQLite boundary tests and the local
Miniflare D1 binding tests for concurrent allocation and complete batch rollback.
The PostgreSQL bootstrap mirrors schema and trigger guards but remains a fenced
v1 verifier adapter; protected issuance is D1-only. Schema parity checks do not
replace execution against a real PostgreSQL server or deployed D1.

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
is no fallback to v201/online-assertion keys. Keep the private key out of local
tracked configuration and client artifacts. Existing health/secret-inventory
checks cover legacy readiness; they do not yet certify this staged v2 rollout.
Follow the [protected key rotation runbook](../../doc/operations/device-bound-key-rotation.md)
before switching signers. Old public keys can still be required to load saved
checkpoints after their leases expire; lease expiry alone is not a removal rule.

All four routes share mandatory fixed D1 budgets of 20 requests per client per
minute and 1,000 per backend per minute; the Cloudflare limiter also applies when
bound. Legacy limiter/proof/account-token `off` settings do not disable v2 checks.
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

Node HTTP tests and the local SQLite/PostgreSQL hosts import `dist/app.js`.
The deployed `src/index.ts` additionally loads the Cloudflare-native RPC runtime;
local workerd tests verify that entrypoint and its service-binding isolation.


### Protected enrollment compatibility and readiness

Migration 0041 adds immutable optional `requested_feature` to enrollment attempts.
New native clients always send it; consent and approval enforce it and the
comparison transcript uses `lcc-device-enrollment-comparison-v2`. Older clients
without the field retain v1 comparison and project-wide consent selection.
Deploy the migration and backend before distributing new native clients.

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
either budget, so idempotent reconciliation is never rate-limited. These
gates are independent of legacy optional-proof switches. The configured
legacy `VERIFY_RATE_LIMITER` additionally protects registration; the
optional `BOUND_SESSION_RATE_LIMITER`
Cloudflare rate limiter rejects session-route (challenge/exchange/renew)
floods at the edge, before any D1 write. Neither edge limiter imposes a low
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
