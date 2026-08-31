# Licensecc Cloudflare Online Verifier

Reference Cloudflare Worker for low-volume online license verification.

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

## Setup

1. Create a D1 database:

   ```console
   wrangler d1 create licensecc-online-verifier
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
   wrangler secret put ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM
   wrangler secret put ONLINE_SIGNING_KEY_ID
   ```

   The private key must be PKCS#8 PEM. Do not commit it. `ONLINE_SIGNING_KEY_ID`
   must match a public key id trusted by the C++ online assertion verifier.

6. Insert or update an entitlement:

   ```console
   cd ../cloudflare-license-admin
   LICENSECC_SYNC_TOKEN=<secret> npm run sync:entitlement -- ^
     --url https://licensecc-admin.example.workers.dev ^
     --project DEFAULT --feature DEFAULT ^
     --fingerprint <64 hex fingerprint> ^
     --status active --assertion-ttl 300 ^
     --customer-id cus_123 --license-id lic_123 ^
     --reason "initial entitlement"
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
   npm run entitlement -- device-upsert ^
     --fingerprint <64 hex fingerprint> ^
     --device-key-id sha256:<64 hex key id> ^
     --public-key-spki-der-base64 <base64 from .device-key/device_public_key.json> ^
     --actor operator@example.com ^
     --reason "initial device enrollment" ^
     --remote
   ```

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
   npm run device-key -- sign ^
     --private-key .device-key/device_private_key.pkcs8.pem ^
     --device-key-id sha256:<64 hex key id> ^
     --fingerprint <64 hex fingerprint> ^
     --nonce <64 hex nonce>
   ```

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
`wrangler secret list --format json` command with a 30-second timeout and
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
  caller-provided sequence values. It runs mutations through `wrangler d1 execute
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
- Set the HMAC key map as a secret: `wrangler secret put ORDER_HMAC_SECRETS`.
