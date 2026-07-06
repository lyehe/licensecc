# Licensecc Cloudflare Online Verifier

Reference Cloudflare Worker for low-volume online license verification.

The Worker accepts `POST /v1/verify`, looks up an entitlement in D1, and returns
a signed `lccoa1.<payload_b64>.<signature_b64>` assertion for active
entitlements. Unknown, revoked, disabled, expired, or not-yet-valid
entitlements return a generic unsigned denial by default. Licensecc core still
does not perform HTTP; host applications call this Worker from their own
`LCC_ONLINE_CHECK` callback and pass returned assertions back to
`acquire_license_ex()`.

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
> `.wrangler/`. Run `npm ci` from this directory to reinstall dependencies.

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
   only. Production hosts should create or import the P-256 key through the OS
   key store/secure enclave/TPM path when available, then persist the public
   SPKI and `sha256:<spki der>` key id.

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
   npm ci
   npm test
   npm run lint
   npm run schema:parity
   npx wrangler deploy
   ```

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

   The drill sends a malformed request, an unknown-entitlement request, and a
   bounded burst from one source. It expects unsigned denial for unknown
   entitlements, observes a `429 rate_limited` response, waits for recovery,
   and redacts the target URL in output.
   Use `--flag=value` form when invoking through `npm run`; the script also
   supports direct `node scripts/public-verifier-drill.mjs --url <url> ...`.

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
  default.
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
- **Mode.** `ORDER_INGEST_MODE`: `required` (default), `soft` (verify + observe,
  never mutates), `off` (dev-only, 404). `ORDER_INGEST_AUDIENCE` blocks
  cross-environment replay and is asserted non-empty in `required`.
  `ORDER_MAX_SKEW_SECONDS` bounds timestamp skew (default 300, cap 3600). A
  `(key_id, event_id)` nonce is spent LAST (after verify+skew) against
  `order_ingest_nonces`; a replay is `401 replayed`, a nonce-store error is a
  fail-closed `503`.
- **Exactly-once.** Accept-then-apply: a durable cursor advance on
  `orders(order_epoch, last_seq)` + an event claim into `order_events` commit in
  one atomic batch (Step 3); the entitlement mutation and the `order_events`
  `status='processed'` mark commit in the *same* batch (Step 4), guarded by the
  per-entitlement monotonic floor `last_applied_order_{epoch,seq}`. A stale order
  is observably `stale_ignored`; a crashed `accepted` row re-drives idempotently
  (the floor makes re-apply self-superseding). A fingerprint belongs to exactly
  one subscription (`409 fingerprint_owned`).
- **Responses.** `200 applied` (with the entitlement snapshot + `license_fingerprint`),
  cached replay (identical body), `200 stale_ignored`, `409 seq_conflict`,
  `409 event_id_conflict`, `409 fingerprint_owned`, `200 no_entitlement`
  (modify on a never-activated subscription — never materializes access),
  `409 entitlement_revoked` (terminal), `401` (auth family), `400 invalid_order`,
  `503 write_failed`. The body is read once with `request.text()` and capped at
  `MAX_ORDER_BODY_BYTES = 16384`.
- Set the HMAC key map as a secret: `wrangler secret put ORDER_HMAC_SECRETS`.
