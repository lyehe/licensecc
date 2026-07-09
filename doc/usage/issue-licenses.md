# Issue licenses

Licensecc supports two issuing paths:

- local/offline license files for the C++ library and inspector;
- online entitlements managed by the Cloudflare backend/admin service.

Use local license files when a product only needs offline verification. Use online
entitlements when you need account-bound activation, node-locked leases, floating
seats, trials, metering, catalog tiers, or customer self-service.

## Local license files

Configure and build the project first. By default, generated project material is
written under the CMake build tree:

```text
build/<preset>/projects/<project-name>
```

The generated project contains the public-key header, private signing key, and a
`licenses/` directory:

```text
projects/
└── DEFAULT
    ├── include/
    │   └── licensecc/
    │       └── DEFAULT/
    │           ├── licensecc_properties.h
    │           └── public_key.h
    ├── licenses/
    └── private_key.rsa
```

Use `LCC_PROJECT_NAME` to choose another project name, and use
`LCC_PROJECTS_BASE_DIR` only when you intentionally want a stable project
directory outside the build tree.

The license generator executable is built with the project. Put `lccgen` on your
`PATH`, or run it from the build/install tree.

Create a perpetual local license:

```console
cd build/dev-debug/projects/DEFAULT
lccgen license issue -o licenses/customer.lic
```

Create a license bound to a hardware identifier:

```console
cd build/dev-debug/projects/DEFAULT
lccgen license issue --client-signature XXXX-XXXX-XXXX -o licenses/customer.lic
```

The destination application can print its hardware identifier through your own
integration code, or you can use `lccinspector` while testing.

Useful options:

| Parameter | Description |
| --- | --- |
| `--base64`, `-b` | Encode the license for environment-variable transport. |
| `--valid-from` | Start date, formatted `YYYY-MM-DD`; defaults to today. |
| `--valid-to` | Expiration date, formatted `YYYY-MM-DD`; omitted means no expiration. |
| `--client-signature` | Hardware identifier in `XXXX-XXXX-XXXX` format. |
| `--output-file-name`, `-o` | License output file path. |
| `--extra-data` | Application-specific data returned by `acquire_license`. |
| `--feature-names` | Comma-separated licensed feature names. |

Run `lccgen license issue --help` for the full option set.

## Online entitlements

Online entitlements are created through the admin service and stored in the
licensing backend database. The license mode is derived from stamped entitlement
capacity:

- `trial`: `is_trial = 1`
- `floating`: `pool_size > 0`
- `node_locked`: `pool_size = 0`

The normal setup path is:

1. Deploy and migrate the licensing backend.
2. Deploy the admin Worker.
3. Enable policy stamping with `POLICY_STAMP_MODE=on`.
4. Create policy templates for node-locked, floating, trial, or subscription use.
5. Create entitlements from policies, or project catalog plans to entitlements.

Node-locked clients use `/v1/activate` and `/v1/renew`. Floating clients use
`/v1/checkout`, `/v1/heartbeat`, and `/v1/release`.

For concrete policy JSON examples and catalog-plan projection commands, see
`services/cloudflare-license-admin/README.md`.

## Zero to first online license

This is the single ordered runbook that takes you from an empty Cloudflare
account to a client that verifies an online entitlement. It consolidates the
backend Setup steps, the admin deploy steps, and every secret the two Workers
require, in strict dependency order. Each numbered step names the exact command
or secret. Run backend steps from
`services/cloudflare-licensing-backend/` and admin steps from
`services/cloudflare-license-admin/` unless noted.

### Backend (public online verifier)

1. **Create the D1 database.** This must exist before migrations or deploy.

   ```console
   cd services/cloudflare-licensing-backend
   wrangler d1 create licensecc-online-verifier
   ```

2. **Create `wrangler.toml`.** Copy `wrangler.example.toml` to `wrangler.toml`
   and paste the D1 database id from step 1. For local development, secrets go
   in a gitignored `.dev.vars` file instead of `wrangler secret put`; for hosted
   environments use `wrangler secret put` as shown below.

3. **Apply migrations.** The schema must exist before any Worker version that
   reads its columns is deployed.

   ```console
   npm run migrate:local
   npm run migrate:remote
   ```

4. **Generate the online assertion signing key.** This produces the private key
   you store as a secret and the public-key CMake value the C++ verifier trusts.
   Do not reuse the license-issuing key.

   ```console
   npm run generate-online-key -- --out-dir .online-key
   ```

5. **Store the signing secrets** (contents of `.online-key/`):

   ```console
   wrangler secret put ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM
   wrangler secret put ONLINE_SIGNING_KEY_ID
   ```

   `ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM` is the PKCS#8 PEM private key.
   `ONLINE_SIGNING_KEY_ID` must match a public key id trusted by the C++ online
   assertion verifier.

6. **Store the sync token.** The admin Worker authenticates to the backend's
   `/api/sync/entitlements` projection endpoint with this shared bearer token.
   Generate a random value now; the admin side reuses it in step 9 as
   `LICENSECC_SYNC_TOKEN`.

   ```console
   wrangler secret put SYNC_API_TOKEN
   ```

7. **Deploy the backend.**

   ```console
   npm ci && npm test && npm run lint && npm run schema:parity
   npx wrangler deploy
   ```

### Admin (control plane)

8. **Configure Cloudflare Access for the admin Worker** (all four are required
   for a hosted deployment):

   ```console
   cd ../cloudflare-license-admin
   wrangler secret put ADMIN_ACCESS_ISSUER
   wrangler secret put ADMIN_ACCESS_AUDIENCE
   wrangler secret put ADMIN_ACCESS_ADMIN_EMAILS
   wrangler secret put ADMIN_ACCESS_READER_EMAILS
   ```

   `ADMIN_ACCESS_ADMIN_EMAILS` may mutate; `ADMIN_ACCESS_READER_EMAILS` is
   read-only. See the Authentication section above for the local-development
   bearer alternative (never enable it in a hosted environment).

9. **Store the admin's copy of the sync token.** This value MUST equal the
   backend's `SYNC_API_TOKEN` from step 6 so the admin Worker's sync client is
   accepted by the backend.

   ```console
   wrangler secret put LICENSECC_SYNC_TOKEN
   ```

10. **Deploy the admin Worker.**

    ```console
    npm ci && npm test && npm run lint
    npx wrangler deploy
    ```

### First entitlement and client verification

11. **Enable policy stamping and create a policy.** Turn on `POLICY_STAMP_MODE`
    (`POLICY_STAMP_MODE=on`) for the admin Worker, then create a policy through
    the admin console or API:

    ```console
    POST /api/admin/policies
    ```

    Use the node-locked or floating policy JSON in
    `services/cloudflare-license-admin/README.md` as the request body.

12. **Create the first entitlement** by stamping it from the policy id returned
    in step 11 (`POST /api/admin/entitlements` with `policy_id`), or project a
    catalog plan. For simple node-locked access you can instead use the
    bearer-authenticated sync helper, which writes the base projection:

    ```console
    LICENSECC_SYNC_TOKEN=<secret> npm run sync:entitlement -- \
      --url https://licensecc-admin.example.workers.dev \
      --fingerprint <64 hex fingerprint> \
      --customer-id cus_123 --license-id lic_123 \
      --status active --reason "initial entitlement"
    ```

13. **Verify from the client.** The host application calls the backend
    `POST /v1/verify` (node-locked clients via `/v1/activate` and `/v1/renew`;
    floating clients via `/v1/checkout`, `/v1/heartbeat`, `/v1/release`) and
    passes the returned `lccoa1` assertion to its licensecc verification
    callback. Confirm end to end against staging with:

    ```console
    cd ../cloudflare-licensing-backend
    npm run validate:remote-cpp -- wrangler.toml ../../build Debug
    ```

### Additional secrets for optional subsystems

These are not on the minimal path above but are required if you enable the
matching subsystem:

- **Order ingest** (`POST /v1/orders` billing inbox): set the HMAC key map on
  the backend with `wrangler secret put ORDER_HMAC_SECRETS`.
- **Access staging drill** (`scripts/access-admin-drill.mjs`): supply a real
  Access token through `LICENSECC_ACCESS_JWT`, or set
  `LICENSECC_ACCESS_USE_CLOUDFLARED=1` to use the cached `cloudflared` token.
  Set `LICENSECC_NON_ADMIN_ACCESS_JWT` to also prove a non-admin identity is
  rejected.
