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
   node scripts/entitlement.mjs upsert --remote --config wrangler.toml ^
     --database licensecc-online-verifier ^
     --project DEFAULT --feature DEFAULT ^
     --fingerprint <64 hex fingerprint> ^
     --status active --assertion-ttl 300 --cache-ttl 3600 ^
     --actor ops@example.com --reason "initial entitlement"
   ```

7. Deploy:

   ```console
   npm ci
   npm test
   npm run lint
   npm run schema:parity
   npx wrangler deploy
   ```

## Notes

- Use `LCC_ONLINE_AUDIT` first. Switch to `LCC_ONLINE_REQUIRE` only after
  testing network failures, entitlement misses, and host callback behavior.
- Cache assertions are bounded by `cache-until`; they improve outage tolerance
  and do not provide real-time revocation while offline.
- Licensecc core keeps a last-seen `revocation-seq` floor only for the current
  process. If your host persists assertions across restarts, also persist the
  last accepted sequence in your own session policy when restart-resilient
  rollback detection matters.
- Active entitlement assertions are clamped to `valid_until` when that optional
  D1 column is set. A `NULL` validity window means unbounded.
- Denied entitlements are unsigned by default to avoid spending signing CPU on
  arbitrary unknown fingerprints. Set `SIGN_DENIED_ASSERTIONS=1` only if your
  host integration explicitly requires signed denials, then keep the negative
  cache window short and validate abuse limits.
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
- The `scripts/entitlement.mjs` D1 helper is a break-glass operator path. Normal
  hosted writes should use the authenticated admin Worker. The helper requires
  an actor for mutations, stamps events as `source='cli'`, and increments
  `revocation_seq` in SQL instead of accepting caller-provided sequence values.
  Use `reenable` to reactivate a disabled entitlement; revoked entitlements are
  terminal for v1 and `upsert` will not update an existing revoked row. `upsert`
  is a full create/update operation for non-revoked rows and unspecified
  mutable fields use command defaults.
- This reference service does not prevent local binary patching or API hooking.
