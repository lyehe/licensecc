# Set up Licensecc on Cloudflare

Use this guide to bring up a new hosted environment: a licensing API, protected
admin console, customer portal, and recoverable database. Start with staging.
There is no VM or database server to maintain: the applications run as Workers
and their shared database is Cloudflare D1.

This page provides the order of operations. The linked service runbooks own
their exact commands and configuration formats. Commands marked remote in those
runbooks create or change resources in your selected Cloudflare account. A
successful staging setup is not, by itself, production qualification; use the
{doc}`production-readiness` contract before launching production.

## 1. Prepare the account and checkout

You need:

- A Cloudflare account with Workers, D1, Zero Trust Access, and R2 enabled.
  The backup Worker also uses Cloudflare Workflows.
- Workers Paid with an adequate CPU budget if using email/password login.
  The portal's password hashing is not designed for the Free plan's CPU limit;
  see [password setup](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-customer-portal/README.md#email-and-password)
  and Cloudflare's [resource limits](https://developers.cloudflare.com/workers/platform/limits/).
- An operator who can create these resources and configure Access. Automated
  deployments should use a separately scoped API token rather than a personal
  interactive login.
- Git, Node.js 22, npm 10.9.8, Python 3.12, and uv 0.12.5. Use the repository's
  locked dependencies. Doxygen is needed for documentation validation, not for
  operating the deployed Workers.
- A clean checkout of the reviewed commit. Do not deploy from a checkout
  containing unrelated changes.

From the repository root in PowerShell, these commands install and check local
code only; they do not provision Cloudflare:

```powershell
npm ci
npm run check:pr
npm run check:dry-run
```

Expected result: every command exits successfully. Follow the
{doc}`repository workflow guide <../usage/repository-workflows>` for toolchain
and additional release gates. From the same directory, authenticate Wrangler
and check the selected account before any remote command:

```powershell
npx wrangler login
npx wrangler whoami
```

Keep account IDs, database IDs, actual hostnames and operator addresses in an
environment inventory outside version control. Do not paste credentials into
command arguments or commit live Wrangler files, `.dev.vars`, private keys,
database exports, or case-specific evidence.

## 2. Choose names and keep environments separate

Each environment has **one shared D1 database**. Backend, admin and portal bind
it as `DB`. Only the backend owns its migration history. The backup Worker
exports that database through the Cloudflare API into a private R2 bucket.

The repository's protected deployment profiles require these names:

| Resource | Staging | Production |
| --- | --- | --- |
| Backend Worker | `licensecc-online-verifier-staging` | `licensecc-online-verifier` |
| Admin Worker | `licensecc-admin-staging` | `licensecc-admin` |
| Portal Worker | `licensecc-customer-portal-staging` | `licensecc-customer-portal` |
| Backup Worker | `licensecc-d1-backup-staging` | `licensecc-d1-backup` |
| D1 database | `licensecc-online-verifier-staging` | `licensecc-online-verifier` |
| R2 bucket | `licensecc-d1-backups-staging` | `licensecc-d1-backups` |

Use different database IDs, secrets, backup destinations and customer fixtures
for staging and production. Custom names are possible for a manually operated
installation, but the protected workflow will reject them unless its profile
is deliberately updated. Do not copy an existing pilot's private configuration
and assume it meets the protected workflow's contract.

Choose a canonical HTTPS origin for each HTTP service. A manually operated
pilot can use configured `workers.dev` hostnames. The protected deployment
profiles instead require explicit routes, `workers_dev=false`, and
`preview_urls=false`; staging route hostnames must contain a `staging` DNS
label (for example, `admin.staging.example.com`). Origins contain no
path, query, fragment or user information. Keep the portal public for customer
sign-in and the backend reachable by native clients; protect the **admin** with
Access rather than accidentally placing all client traffic behind operator SSO.

## 3. Create D1 and initialize its schema

Follow [backend hosted setup](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-licensing-backend/README.md#hosted-setup-remote-changes)
from `services/cloudflare-licensing-backend`:

1. Create the environment's D1 database and record the returned database ID.
2. Copy `wrangler.example.toml` to ignored `wrangler.toml` only if that local
   file does not already exist. Set the account, Worker name, database name and
   ID for the chosen environment. Keep `migrations_dir = "migrations"`.
3. Inspect the migration list and apply the backend's ordered migrations to
   the **new, empty** remote database. Use the configured `DB` binding and an
   explicit remote target. Cloudflare documents the
   [D1 commands and migration behavior](https://developers.cloudflare.com/workers/wrangler/commands/d1/).
4. Verify there are no pending migrations before deploying application code.

Do not apply `schema.sql` on top of a migrated database or create separate
admin/portal migration histories. Do not stop at a historical migration number
mentioned in a feature section: a fresh install needs the complete migration
set in the selected checkout.

For an existing database, use the backup and upgrade sequence below instead.
An empty-database bootstrap does not need a backup of customer data that does
not yet exist; the deployment workflows' pre-migration backup gate still
requires a functioning backup service before an automated rollout.

## 4. Configure the Workers and admin Access

Copy each service's `wrangler.example.*` to its ignored live configuration
without overwriting an existing file. Treat example values as placeholders,
not production-ready configuration.

| Service | Configuration to complete | Authoritative runbook |
| --- | --- | --- |
| Backend | Account/name, `DB`, canonical client destinations, mode selectors, public verification keys, cron and rate limits | [Backend](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-licensing-backend/README.md) |
| Admin | Same `DB`, `ENVIRONMENT`, Access issuer/audience and operator allowlist; `ADMIN_DEV_BEARER_ENABLED="0"`; `DEVICE_OPERATOR` targets the backend's `DeviceOperator` entrypoint | [Hosted admin setup](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-license-admin/README.md#hosted-setup) |
| Portal | Same `DB`, `ENVIRONMENT`, exact `PORTAL_PUBLIC_ORIGIN`, matching `BACKEND_ORIGIN`, chosen sign-in method; `DEVICE_CONSENT` targets the backend's `DeviceConsent` entrypoint | [Customer portal](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-customer-portal/README.md) |
| Backup | Same account and D1 identifiers, private R2 bucket, prefix, retention, cron and `D1_BACKUP_WORKFLOW` binding | [Backup setup](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-d1-backup/README.md#cloudflare-setup) |

Keep the backend entrypoint as `src/index.ts` and the admin/portal entrypoints
as `src/worker/index.ts`. The backend entrypoint exports the named RPC
capabilities; deploying a local-host adapter does not provide them.

For admin access:

1. Enable Zero Trust and create an Access application and allow policy for
   the intended admin hostname before exposing it. Cloudflare supports
   [hostname and Worker-level protection](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
2. Put that application's issuer and audience in the admin configuration;
   list the actual administrators separately from optional read-only users.
3. Cover every enabled admin hostname, including `workers.dev`. Disable unused
   preview URLs. If using Worker-level protection, verify its issued JWT
   audience matches the configured admin audience.
4. Verify both layers: Access requires sign-in, and the Worker rejects a
   signed-in identity that is not in its configured roles.

Use explicit `workers_dev`, `preview_urls`, asset-routing and observability
settings. Serve both UI bundles from their freshly built `dist` directories;
ensure requests reach the Worker for authentication/API handling where required
(review `assets.run_worker_first` for your routing configuration). Consult the
[Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/)
when setting routes or bindings.

## 5. Provision secrets by purpose

Store secrets in each owning Worker's secret storage using the service runbook
and Wrangler's interactive input or a protected secret file. Public key material
belongs in public configuration; private keys and peppers do not. Use independent
random material per purpose and environment.

| Owner | Names | Purpose / when required |
| --- | --- | --- |
| Backend | `ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM`, `ONLINE_SIGNING_KEY_ID` | Signed online assertions; the backend key-generation helper documents the matching client public record |
| Backend | `LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM`, `LEASE_SIGNING_KEY_ID` | Legacy lease/download signer; separate from the protected v2 signer |
| Backend and portal | `ACCOUNT_TOKEN_PEPPERS` | Matching per-environment map for portal-minted legacy action tokens; align `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID` with a key in the map |
| Backend | `ORDER_HMAC_SECRETS`, `ORDER_SIGNER_SCOPES` | Order-ingest authentication and scoped signer authority |
| Backend | `WEBHOOK_SIGNING_SECRETS`, `WEBHOOK_SIGNING_KEY_ID` | Signed webhook delivery and active selector |
| Backend | `BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM` | Protected device leases; dedicated RSA-3072 key with matching `BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM` configuration |
| Backend | `BOUND_APPROVAL_ENCRYPTION_KEYS` | Separate approval-recovery encryption key ring |
| Portal | `PORTAL_SESSION_PEPPERS` | Customer browser sessions, including password login |
| Portal | `PORTAL_OTP_PEPPERS` | Email-code or operator-bootstrap authentication when enabled |
| Portal | `PORTAL_GOOGLE_CLIENT_SECRET`, `PORTAL_GITHUB_CLIENT_SECRET` | Only for the corresponding configured OAuth provider |
| Portal | `PORTAL_EMAIL_API_KEY` | Only for configured transactional email delivery |
| Backup | `D1_REST_API_TOKEN` | Export authority for the selected account/database |
| Backup | `BACKUP_TRIGGER_TOKEN` | Authenticated manual backup/status and pre-migration gate |

The protected deployment's backend inventory requires the legacy assertion,
lease, account-token, order and webhook secrets even if a pilot primarily uses
protected devices. See [readiness checks](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-licensing-backend/README.md#protected-deployment-readiness-checks)
for exact formats and selectors. Do not satisfy the inventory with dummy keys.
Secret-name presence does not prove that values are valid or paired correctly.

For protected devices, also configure `BOUND_DEVICE_CONFIG`: fixed issuer,
audience, portal `/connect` URL, and a registry of application client IDs,
projects and allowed loopback callbacks. Follow the
[protected-device configuration](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-licensing-backend/README.md#protected-device-api-staged-implementation)
for the JSON and encryption-key-ring formats. Keep the app's trusted public
key, issuer/audience and client registration aligned. Rotation follows the
{doc}`device-bound-key-rotation` runbook, not a reinstall or key deletion.

Break-glass secrets such as `EMERGENCY_OPERATOR_BEARER` and
`PORTAL_BOOTSTRAP_BEARER` are not normal customer-login credentials. Leave them
unset in steady state unless a documented protected drill requires them.
The default single-D1 topology does not need the optional replica-sync token.

## 6. Choose customer sign-in

For the simplest password-based installation, set `PORTAL_PASSWORD_ENABLED="1"`
and provision session peppers. No email provider or OAuth credentials are
needed. Registration creates an empty customer; it neither verifies the email
address nor grants a license. Password-only accounts have no public
forgot-password email endpoint, so document an operator recovery process.

Alternatively, follow the portal's
[Google/GitHub setup](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-customer-portal/README.md#google-and-github-sign-in):
register each provider, use the exact callback paths from the runbook with
**your** portal origin, and set the client ID plus corresponding Worker secret.
Provider callback URLs must differ between staging and production. Enable
email-code sign-in only after its sender, peppers and delivery provider work.

## 7. Establish backup and deploy in order

Create the private R2 bucket and complete the backup runbook. Do not enable
public bucket access. Configure a Cloudflare API token with the minimum
available D1 export permissions and verify the exact account/database target;
do not assume its permission model isolates one database without checking.

The tracked backup example runs every 30 minutes and retains 90 days. Review
the schedule, R2 lifecycle, logging and retention before enabling it. Private
pilot cost settings are not repository defaults. See the
{doc}`production recovery objectives <production-readiness>` before reducing
production backup frequency. Budget alerts are notifications, not spending
caps; monitor usage and set a suitable password-hashing CPU budget rather than
assuming the smallest CPU limit will work.

For the initial bootstrap, follow these service-local runbooks in order:

| Order | Action | Completion signal |
| --- | --- | --- |
| 1 | D1 initialization from step 3 | Complete migration history for the checked-out code |
| 2 | [Backup setup and validation](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-d1-backup/README.md#cloudflare-setup) | A completed, inspectable backup and a successful restore drill against a scratch database |
| 3 | [Backend deploy](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-licensing-backend/README.md#hosted-setup-remote-changes) | New serving version, expected health result and signing configuration |
| 4 | [Admin build and deploy](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-license-admin/README.md#hosted-setup) | Fresh UI assets, correct backend RPC binding, Access-protected console |
| 5 | [Portal build and deploy](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-customer-portal/README.md#hosted-setup) | Fresh UI assets, password/provider sign-in and backend RPC binding |

Before each deployment, inspect the dry run against the **actual** local config,
not only the checked-in example. Record the source commit, previous Worker
version, new version and database migration state. Explicitly build both UIs
before upload: passing a development-server browser test does not refresh
`dist`. Reload the deployed page afterward to verify the new assets.

Deployments preserve Worker secrets, but variable behavior needs deliberate
handling: [Wrangler `keep_vars`](https://developers.cloudflare.com/workers/wrangler/configuration/)
can retain dashboard variables. Values explicitly present in local configuration
still need review. It does not validate that retained settings match the code.

## 8. Create the first customer and test one app

1. Sign into the admin through Access. This is an operator identity, separate
   from a customer portal account.
2. In **Customers → Add user**, create a synthetic portal user with an initial
   password, or let the user register in the portal. No welcome email is sent
   by Add user. Share an initial password through an appropriate private channel.
3. Create the application's customer license and entitlement. Follow
   [protected application access](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-license-admin/README.md#create-protected-application-access)
   for a new protected grant, its exact project/feature/fingerprint and device
   limit. Do not convert an existing legacy grant to protected mode in place.
4. Use the configured native app to Connect. Compare the app/browser codes,
   approve the intended license, and verify activation and renewal. The portal
   does not issue a replacement downloadable `.lic` for protected enrollment.
5. Verify a second machine is refused when the one-device limit is occupied;
   test disabled/expired feature denial and separate feature grants. Retirement
   stops renewal, but signed access and the slot hold can persist until expiry.
6. Check customer search, device visibility and audit history in admin. Disable
   the synthetic account afterward; retain its audit/enforcement records.

Complete the service-specific deployed validators as well. A health response
or successful build alone does not exercise sign-in, signer trust, device
possession, Access roles or backup restoration. Native TPM integration and
feature-session timing require the separate app/client qualification.

## 9. Move to protected deployment workflows

After bootstrap, use the reviewed GitHub Actions workflows for repeatable
rollouts. They are not a one-click fresh-account provisioning system: they
expect resources, deployed secrets, backup readiness and synthetic drill
fixtures to exist already.

Create separate protected `staging` and `production` GitHub environments.
Configure these baseline inputs in the selected environment:

- Secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Variable `LICENSECC_D1_DATABASE_ID` for that environment.
- The four `LICENSECC_BACKEND_WRANGLER_CONFIG_B64`,
  `LICENSECC_ADMIN_WRANGLER_CONFIG_B64`, `LICENSECC_PORTAL_WRANGLER_CONFIG_B64`
  and `LICENSECC_BACKUP_WRANGLER_CONFIG_B64` secrets, containing base64-encoded
  live configuration **without embedded Worker secrets**. Base64 is not encryption.
- The workflow-specific Access/session credentials, backup trigger token and
  synthetic verifier, order, lease and portal fixtures. These are separate
  from Worker runtime secrets; inspect every `secrets.*`, `vars.*` and dispatch
  input in the selected workflow before running it. Short-lived JWTs must still
  be valid when their drill executes.

The source authorities are
[staging rollout](https://github.com/lyehe/licensecc/blob/main/.github/workflows/deploy-staging.yml),
[production rollout](https://github.com/lyehe/licensecc/blob/main/.github/workflows/deploy-production.yml), and
[configuration validation](https://github.com/lyehe/licensecc/blob/main/scripts/materialize-deploy-configs.mjs).
Their fixed profiles enforce names, origins, bindings, selector values and
schedules more strictly than standalone example configs. In particular, set
the profile's order audience and required modes rather than copying development
defaults. Do not change `DEVICE_PROOF_MODE` merely to satisfy an unrelated v2
requirement: the portal-compatible legacy profile and protected v2 proof checks
are distinct, as explained in the backend runbook.

Dispatch from `main` at the reviewed commit with the correct environment
confirmation and origins. Follow the workflow's backup, migration, build,
deployment and post-deploy gates without skipping failures. Its legacy portal
drills include fixtures beyond password-only protected enrollment; run the
protected native journey separately. Apply all applicable production-readiness
gates before promoting a staging success to production.

## 10. Upgrade and recover

For every later release:

1. Review the source commit, migration suffix and configuration changes. Record
   the currently serving versions and preserve the corresponding configuration
   and signer pairing.
2. Run the documented
   [pre-migration backup gate](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-d1-backup/README.md#pre-migration-backup-gate)
   and qualify restore against a separate scratch D1 database.
3. Apply reviewed backend migrations before dependent Workers. A failed D1
   migration does not imply earlier successful migrations were undone.
4. Build UI assets, deploy the candidate, and repeat the live checks from step 8.
5. If recovery is needed, use the
   [rollback workflow](https://github.com/lyehe/licensecc/blob/main/.github/workflows/rollback-workers.yml) and
   [restore runbook](https://github.com/lyehe/licensecc/blob/main/services/cloudflare-d1-backup/README.md#restore-runbook).
   A Worker rollback does not roll back D1. Confirm old code is compatible with
   the current schema and signing configuration before routing traffic to it.

Keep device audit events until an explicit retention policy is adopted. Do not
remove persistent identities, checkpoints or capacity holds as a shortcut for
recovering a failed deployment.

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Missing table/column or migration failure | Correct remote `DB` ID, ordered backend history, and pending migrations |
| Admin redirect loop or 403 | Access application audience/issuer, every enabled hostname, operator role allowlist |
| Portal login returns configuration error | Session peppers, enabled provider/password configuration, exact portal origin |
| Password request exceeds resources | Workers plan and CPU budget; preserve password hashing parameters |
| Consent fails or cannot call backend | Backend deployed first; named `DeviceConsent` binding and client registry match |
| Protected token rejected by app | Dedicated signer/public SPKI pairing, issuer/audience, app trust set and clock policy |
| New UI not visible | Production `dist` rebuilt in the deployed checkout; actual assets path and served version |
| R2 `NotEntitled` or backup fails | R2 activation/billing state, private bucket binding, export-token authority, Workflow result |
| Protected workflow rejects local config | Fixed profile names, environment origins/IDs and selectors; do not weaken the validator |

To validate edits to this guide, run `npm run test:docs-accuracy` and
`npm run check:docs` from the repository root; normal commit validation also
requires `npm run check:pr`. These checks validate documentation and source
contracts, not a fresh Cloudflare account or remote production readiness.


## Protected-device readiness

A secret-name inventory is not an end-to-end readiness verdict. The backend
inventory now requires `BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM` and
`BOUND_APPROVAL_ENCRYPTION_KEYS` in addition to the legacy secrets. It reports
`secret_names_only`; it cannot read or prove deployed secret values.

Before deploying protected licensing, validate the prepared JSON Worker config
and the local secret-input JSON (both remain untracked):

```sh
npm run validate:protected-config --workspace @licensecc/cloudflare-licensing-backend -- \
  --config=/absolute/private/backend.json --secrets=/absolute/private/backend-secrets.json --env=<name>
```

The command validates `BOUND_DEVICE_CONFIG`, the dedicated RSA public/private
signer pairing, and the approval encryption ring. Output contains only safe
check results and explicitly says live issuance/renewal were not run. This
command currently accepts JSON configuration, not TOML or JSONC.

Apply migration 0041 before deploying this backend. It preserves older pending
attempts with no requested feature and makes new feature intent immutable.
Deploy the backend before releasing the new native clients; older backends
correctly reject the new field. No audit-event deletion policy changes.

For release qualification, use a temporary protected entitlement and the real
native example: enroll the configured feature, compare/approve the browser
code, activate, authorize protected work, close the process, resume and renew,
then start/authorize a feature session. Record exact deployed Worker versions,
public signer id, platform/runtime build and results without tokens or private
keys. Both activation and post-restart renewal must pass. Configuration checks,
legacy lease smoke tests and simulator tests do not substitute for this live
qualification. Run it separately on each supported platform before claiming
that deployment/platform ready.
