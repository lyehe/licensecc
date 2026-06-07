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

7. Deploy:

   ```console
   npm ci
   npm test
   npm run lint
   npm run schema:parity
   npx wrangler deploy
   ```

8. Validate a remote Worker-signed assertion with the C++ verifier test against
   a staging/test D1 database:

   ```console
   npm run validate:remote-cpp -- wrangler.toml ../../build Debug
   ```

   The script deploys a temporary verifier Worker with generated online signing
   key material, creates a scratch entitlement, obtains a real `lccoa1`
   assertion, runs `test_online_verification` with the matching public key,
   revokes the scratch entitlement, deletes the temporary Worker, and removes
   temporary key material.

9. Validate the public verifier abuse controls against a staging Worker:

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
  requires an actor for mutations, stamps events as `source='cli'`, and increments
  `revocation_seq` in SQL instead of accepting caller-provided sequence values.
  Use `reenable` to reactivate a disabled entitlement; revoked entitlements are
  terminal for v1 and `upsert` will not update an existing revoked row. `upsert`
  is a full create/update operation for non-revoked rows and unspecified
  mutable fields use command defaults.
- This reference service does not prevent local binary patching or API hooking.
