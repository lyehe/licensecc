# Customer portal Worker

This directory owns the customer-facing Worker, authentication/session routes,
self-service routes, OpenAPI fragments, and React UI. It is independently
deployable; it does not import another service's implementation. Shared
portable policy and Cloudflare mechanics come from the explicit workspace
packages documented in [`../../doc/architecture/system-map.md`](../../doc/architecture/system-map.md).

**Audience:** portal contributors and authorized hosted-platform operators.
Offline native integrations and server-token verification do not require this
deployable.

## License access in the portal

App details distinguish protected-device grants from legacy license downloads. Protected grants direct customers to Connect in their application; they never offer a device-key field or a `.lic` download. Legacy downloads remain available for compatible non-floating grants.

The status label preserves disabled/revoked state and marks past or future validity windows as Expired or Not started. Enabled describes the listed dates only: the backend still checks device, trial and account eligibility. The browser clock updates these labels without server polling; it does not authorize access.

## Protected binding retirement API

`POST /api/portal/device-bindings/retire` accepts exactly `binding_id` and
`expected_revision`. Supply the configured HTTPS `Origin`,
`x-expected-customer-id` (the displayed account ID encoded with
`encodeURIComponent`), and an `idempotency-key` containing the canonical
base64url encoding of 32 random bytes. The binding ID encodes 16 bytes.
The session supplies authority; the displayed account is only a precondition.

This route calls the backend's named `DeviceConsent.retire` capability and
shares the consent global/customer rate budgets. It stops renewal immediately,
preserves outstanding signed access and capacity holds, and returns the exact
`effective_release_at`, binding revision and generation. That release time is
the later of the existing hold and the retirement commit. On a timeout or 503,
retry the same body and key; exact recovery lasts 48 hours. Never silently
replace a pending operation with a new key. All responses are `no-store`.
The Devices screen lists protected connections independently of legacy account
reads, with Connected, Disconnecting, and Disconnected states. Last verified means
authenticated contact, not live presence. Retirement requires confirmation and
saves the exact request in account-scoped session storage before sending. A lost
response, navigation or reload offers the same retry; storage failure prevents
sending. Terminal conflicts inspect the exact binding before a separate explicit
clear action. The old device-release endpoint keeps its own behavior and mode fence.

`GET /api/portal/device-bindings` requires the session and displayed-account
header. It returns at most 100 owned bindings in binding-ID order, with
`next_cursor`/`has_more`; supply `cursor` for the next page. This is live keyset
pagination, not a snapshot. Alternatively supply `binding_id` to inspect exactly
one owned connection (zero or one result); the two query fields are mutually
exclusive. Every read rechecks ownership and uses primary D1 session semantics
when available. Database time determines logical release at the hold boundary.
No private keys, raw proofs or license fingerprints are included.

## Staged device consent API

The three session-authenticated POST routes under
`/api/portal/device-authorizations/` inspect, approve and deny an attempt.
The example configuration binds `DEVICE_CONSENT` to the backend's named
`DeviceConsent` entrypoint. The deployment materializer requires that binding to
target the matching profile's backend and rejects overrides or duplicates;
a missing runtime capability fails closed. The portal needs
no lease-signing or approval-encryption key.

Requests require the exact configured portal Origin, bounded strict JSON,
`x-expected-customer-id` containing `encodeURIComponent` of the displayed
customer ID and, for approve/deny, an `idempotency-key`. The expected customer is
only a precondition: a changed session returns `account_changed` before RPC.
Customer authority comes only from the current session; customer IDs in request
bodies are rejected. The portal applies
global and customer rate limits before invoking RPC and validates the returned
code, status and data shape. Responses are no-store. Retry an uncertain mutation
with its original body and key; approval recovery ends at code expiry and denial
recovery at attempt expiry.

The staged consent screen captures and removes the enrollment fragment before
authentication. Tab-scoped state preserves the original mutation key through
login, reload and reopening the same link. Callback codes remain in memory;
loopback navigation retains the sanitized portal history entry so Back can
recover a failed handoff. Expiry clears pending actions/callbacks, account changes
fail closed, and sign-out shares the consent mutation guard.

Inspection now supports live keyset pagination with at most 100 choices per
page. Previous/Next fetch current eligibility; successful navigation clears the
selected license and a failed request preserves it. A comparison code derived
from immutable enrollment intent is displayed before initial approval; the user
must confirm that it matches the app. See the
[enrollment reference](../../doc/api/device_enrollment.rst) for exact framing,
cursor semantics and the required native recomputation.

Focused browser scenarios cover these behaviors; desktop and 390-pixel visual
checks use synthetic data. The native comparison display and protected consumer
are documented in the [enrollment contract](../../doc/api/device_enrollment.rst).
These APIs and local Worker integration tests do not establish production
readiness; see the maintained [release conditions](../../doc/operations/production-readiness.md).

Administrators can provision portal accounts from the admin console's
**Customers → Add user** action when both services share D1. Add user invites
by default, and an invited account has no usable password: the customer sets
one by using "Forgot your password?" in the portal, which requires portal
email delivery and verifies the address in the process. When the portal
cannot send email, the admin instead chooses "Set an initial password" and
shares it with the customer through a private channel; the customer signs in
with it and changes it in Account. Provisioning itself sends no email and
grants no licenses. Password login must be enabled in the portal
configuration.

## Customer interface

The portal uses the shared charcoal visual style and a locally bundled IBM Plex
Sans font. Apps groups licenses by project. Each app has one License access
list with capacity, validity and mode-specific activation actions; Activity
expands separately. Devices distinguishes protected app connections, legacy
registrations and browser sessions. Browser sessions stays open while a local
seat or pending release needs attention; Renew seat sends the existing heartbeat.
Account contains sign-in methods and expandable password/account details.
Sign out stays in the shell and does not release app devices or seats.

Google and GitHub support sign-in and registration when their OAuth credentials
are configured. Existing customers can connect a provider from Account after
signing in through their existing method. Email-code login remains available
when email delivery is configured. Protected application enrollment uses the
Connect approval flow. Configured capacity is not presented as available capacity. The portal's browser-managed
seat controls do not represent native application sessions on other machines.

| Goal | Start here | Side effects |
| --- | --- | --- |
| Validate code locally | [Local checks](#local-checks) | Local build/test output only |
| Review credential forwarding | [Credential-bearing destinations](#credential-bearing-destinations) | Read-only documentation |
| Validate a deployed portal | Use the staged/production drill below | Sends an authorized session to the named remote origin |
| Judge production readiness | [Production readiness](../../doc/operations/production-readiness.md) | Evidence review; deployment remains an operator decision |

Unless a block explicitly says "repository root," run service-local commands
from `services/cloudflare-customer-portal` after the single root workspace
install. Remote validation requires authority for the target and a deliberately
scoped credential.

## Hosted setup

Start with the [Cloudflare setup guide](../../doc/operations/cloudflare-setup.md)
for shared D1 initialization, admin Access, signing configuration and deployment
order. Deploy the backend before this portal's named `DeviceConsent` binding.

From the repository root after `npm ci`, create the ignored
`services/cloudflare-customer-portal/wrangler.jsonc` from its example only if no
live configuration exists. Set the intended account/Worker name, environment,
shared D1 database ID, exact `PORTAL_PUBLIC_ORIGIN`, matching `BACKEND_ORIGIN`,
and `DEVICE_CONSENT` service target. Configure session peppers and the chosen
sign-in method as described below, and optionally a
[support contact](#suspended-accounts-and-the-support-contact); the example is
not a complete live setup. Keep actual configuration and secrets out of version
control.

From the repository root in PowerShell, build the production UI and Worker:

```powershell
npm run build --workspace @licensecc/cloudflare-customer-portal
```

Expected result: updated `dist` assets and a successful Worker compilation.
Browser tests using the development server do not build production assets.
From `services/cloudflare-customer-portal` in PowerShell, inspect the configured
bundle, then deploy only to the authorized environment:

```powershell
npx wrangler deploy --dry-run --config wrangler.jsonc
npx wrangler deploy --config wrangler.jsonc
```

Verify the reported Worker name, account, D1 binding and new version. Reload the
public portal and validate sign-in and the documented staged portal drill.
Preserve any deliberate dashboard variable settings when choosing Wrangler's
variable-retention options; do not silently replace them with example values.

## Local checks

From the repository root after the pinned root install:

```powershell
npm run lint --workspace @licensecc/cloudflare-customer-portal
npm run typecheck --workspace @licensecc/cloudflare-customer-portal
npm run test --workspace @licensecc/cloudflare-customer-portal
npm run test:ui --workspace @licensecc/cloudflare-customer-portal
npm run test:openapi --workspace @licensecc/cloudflare-customer-portal
npm run dry-run --workspace @licensecc/cloudflare-customer-portal
```

Browser smoke tests require the explicit one-time setup command
`npm run setup:browsers`, followed by `npm run test:e2e`.

The deployed portal drill also verifies that the built UI shell and health
endpoint load before authenticating. With an existing session cookie and the
mutation flags left unset, it is safe for a production post-deploy read gate:

Run this block from the service directory. It is application-read-only but
still transmits the supplied session cookie to the configured remote origin.

```powershell
$env:LICENSECC_PORTAL_URL = "https://portal.example.workers.dev"
$env:LICENSECC_PORTAL_SESSION_COOKIE = "<redacted-session-cookie>"
npm run validate:staging-portal
```

The protected staging bootstrap path additionally requires an unauthenticated
`/api/portal/me` denial, verifies the newly issued `lccp_session` cookie has
`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and a positive `Max-Age`, and
requires another denial after logout. The existing-cookie production read gate
does not issue or log out that operator-supplied session, so it does not claim
cookie-issuance or post-logout coverage.

The shipped browser/session workflow does not hold a native device private key.
The standard protected four-Worker topology therefore uses
`DEVICE_PROOF_MODE=off`: absence is permitted, but the backend still verifies
every proof that a native client presents. Global `required` mode is a future
client-registration/signing migration; never place a device private key in this
Worker or in browser-delivered configuration to simulate possession.

## Credential-bearing destinations

`BACKEND_ORIGIN` and the optional `PORTAL_EMAIL_API_BASE` are strict canonical
HTTPS origins: use `https://host.example` (or the same origin with one terminal
slash) only. Userinfo, a path, query, fragment, malformed spelling, and HTTP
are rejected before the Worker mints/sends a bearer or constructs an email API
key request. There is no HTTP local-development exception; use a local HTTPS
endpoint when overriding either destination.

The portal reaches the backend through the `BACKEND` service binding (readiness
and self-service proxying) and `DEVICE_CONSENT` (the `DeviceConsent` RPC
entrypoint). Wrangler environment blocks do not inherit `services`: declare
both bindings under every `env.<name>` with that environment's backend Worker
name, or staging will call production.

See the [change guide](../../doc/architecture/change-guide.md) before adding
a route, migration, policy rule, UI workflow, or OpenAPI operation. Keep real
Wrangler configuration and secrets local; commit only the `wrangler.example.*`
templates.

## Google and GitHub sign-in

Apply backend-owned migration `0033_portal_oauth.sql` before deploying this
portal version. The migration is additive; the backend and admin do not need
new binaries to use the same database. Rollback can leave the new tables in
place. No licensing policy, entitlement, or SDK protocol changes are required.

Set `PORTAL_PUBLIC_ORIGIN` to the exact HTTPS portal origin. Register separate
OAuth applications for staging and production. On the provider dashboard:

1. Google: create a Web application OAuth client in Google Auth Platform. Set
   the authorized redirect URI to
   `https://YOUR-PORTAL/portal/v1/auth/google/callback`. Configure the consent
   screen for the intended audience; add test users while in Testing. Only
   `openid email profile` scopes are requested.
2. GitHub: register an OAuth App with the portal URL as Homepage URL and
   `https://YOUR-PORTAL/portal/v1/auth/github/callback` as Authorization callback
   URL. Only `read:user user:email` scopes are requested; no repository access.
3. Set `PORTAL_GOOGLE_CLIENT_ID` and `PORTAL_GITHUB_CLIENT_ID` in the local
   deployment configuration. Set `PORTAL_GOOGLE_CLIENT_SECRET` and
   `PORTAL_GITHUB_CLIENT_SECRET` as Worker secrets. Never place secrets in Vite
   variables, browser storage, source files, or committed configuration.
4. Deploy and verify both providers with a real account: register, sign out,
   sign in again, connect the other provider from Account, and confirm both
   methods reach the same customer. Provider cancellation should return a
   retryable message without creating a session.

Staging callback URLs for the deployed portal are:

- `https://licensecc-portal-staging.donight.workers.dev/portal/v1/auth/google/callback`
- `https://licensecc-portal-staging.donight.workers.dev/portal/v1/auth/github/callback`

The UI discovers configured providers from `/portal/v1/auth/providers`. A
provider needs both its client ID and secret; no placeholder button is enabled.
OAuth uses S256 PKCE, a Secure HttpOnly host-only browser cookie, ten-minute
single-use D1 state, and fixed redirect destinations. Google ID tokens are
signature/issuer/audience/expiry/nonce checked; GitHub identity comes from its
user API and a verified primary email. Provider tokens are never persisted.
The existing opaque D1-backed 24-hour session remains the browser credential.

A new provider subject registers an empty personal customer account, with no
licenses or entitlements. Email matches never silently merge accounts. If an
existing customer's email matches an unlinked provider, the user must first
sign in by the existing method and connect the provider from Account. During
migration, retain working email delivery or use the existing protected
operator bootstrap runbook for an authorized recovery; do not enable a public
bootstrap bypass.

Customers can disconnect a provider from Account
(`POST /portal/v1/auth/identities/unlink`). It is allowed only while another
sign-in method is usable now: a password while `PORTAL_PASSWORD_ENABLED="1"`,
the other provider's identity while that provider is configured, or a contact
email while email codes can be sent. Email codes need both email delivery
(`PORTAL_EMAIL_API_KEY`, `PORTAL_EMAIL_FROM`, and an HTTPS
`PORTAL_EMAIL_API_BASE` if you set one) and `PORTAL_OTP_PEPPERS`. The
providers endpoint's `email` flag reports delivery only, so it can be true
while email codes are not usable. A method switched off in configuration does
not count. Otherwise the answer is `409 last_sign_in_method`, and the portal
asks the customer to set up another way to sign in first. The rule, a
still-live session and the delete are one conditional statement, so two tabs
cannot disconnect the last two methods at once. A tab that loses such a race
gets `409` (no other method remains), `404` (the provider was already
disconnected) or `401` (the other tab's unlink signed it out). Disconnecting signs out the customer's other browser
sessions that signed in with Google or GitHub (sessions do not record which of
the two); the current session and password or email-code sessions stay signed
in.

Unlink judges only the configuration at the moment of each request. Turning a
method off later can strand customers who kept only that method: for example
setting `PORTAL_PASSWORD_ENABLED="0"`, removing a provider's client ID or
secret, or removing email delivery or `PORTAL_OTP_PEPPERS`. Before you turn a
method off, make sure the customers who rely on it have another way in.

Provider setup references: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
and [GitHub OAuth web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Email and password

Apply all backend migrations through `0042_portal_password_actions.sql` before
updating the portal. Keep `PORTAL_PASSWORD_ENABLED="0"` until Workers Paid and
email delivery are configured. Set the exact HTTPS `PORTAL_PUBLIC_ORIGIN` and
retain the existing session peppers. Disabling the flag hides the form and
rejects every password route.

To enable verified registration and recovery:

1. Configure a Resend-compatible sender with a verified sending domain. Set
   `PORTAL_EMAIL_FROM` (for example, `Licensecc <accounts@example.com>`), and
   store `PORTAL_EMAIL_API_KEY` as a Worker secret. The default
   `PORTAL_EMAIL_API_BASE` is `https://api.resend.com`; use only a trusted,
   compatible HTTPS service. Credentials must never be committed.
2. Enable Workers Paid and configure enough CPU time for the hashing below.
   This is a separate billing decision; deploying this code does not enable it.
3. Apply migration 0042, deploy the portal, then set
   `PORTAL_PASSWORD_ENABLED="1"`. Keep Google/GitHub available during rollout.
4. On staging, test delivery to a real inbox, registration, expiry/resend,
   password recovery, old-session revocation and normal password sign-in.

Email/password sign-in continues to work for existing credentials if email
is unavailable; new registration and emailed recovery require the sender.

Passwords use salted scrypt (N=32768, r=8, p=3), following an
[OWASP password-storage profile](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Use Workers Paid with sufficient CPU budget; this hashing workload is not
intended for the Free plan's per-request CPU limit. Each derivation uses a
32 MiB work buffer. Passwords accept 15–128 Unicode characters, up to 512 UTF-8
bytes, without trimming or truncation. IP and email limits run before hashing.

Registration asks only for an email address. The emailed link opens a password
form; submitting it verifies ownership and creates an empty account with that
verified contact email. No account or password is stored before verification,
and no licenses are granted. Existing accounts are never claimed or merged by
registration. Existing OAuth customers can set a password from Account after a
recent verified sign-in.

Forgot password sends a link for an active password account whose login
email matches its verified contact address, or whose contact email is still
empty -- a legacy or admin-created credential -- as long as no other customer
has already verified that address; redeeming the link also sets it as the
account's verified contact. This migration deliberately does not mark
historical emails as verified. An address another customer already verified
is refused with the same generic response; connect a provider or use the
protected operator recovery procedure instead.

Links expire after 15 minutes and are single-use. The random token is hashed in
D1, placed in the link fragment (not query string), and immediately removed
from browser history by the form. Opening a link does not consume it; submitting
a new password does. Reloading the form requires reopening the email link.
Requests return the same 202 response for ineligible addresses and mail delivery
failures. Resend uses the same request endpoint, limited to one email per minute
and ten per 15 minutes per action, with additional IP limits. No password or
raw token appears in API responses or application logs. Expired action rows are
removed on subsequent eligible email requests; audit events are unaffected.

Account supports changing a password with the current password, or setting or
resetting one within ten minutes of a Google, GitHub, or email-code sign-in.
Successful changes and emailed resets revoke old browser sessions and email
codes, advance the account-token revocation sequence, invalidate old reset
links, and issue a fresh session. Concurrent link redemption permits one write.

The registration API now accepts `{ "email": "..." }` and returns 202; clients
must follow the email link and POST `{ "token": "...", "password": "..." }` to
`/portal/v1/auth/password/complete`. POST `/portal/v1/auth/password/reset` requests
a recovery link. Update old registration clients before enabling this flow.

Before deployment, apply the migration, verify the billing/CPU configuration,
and test registration, sign-out/login, password changes, and provider recovery
on staging. The local browser tests mock API responses; Worker integration
tests separately exercise hashing, database ownership, and session rotation.

## Suspended accounts and the support contact

Disabling a customer in the admin console (status `disabled`) suspends their
portal account. The customer is not notified; the portal says so only after
they prove who they are:

- Password sign-in verifies the password first, with the same work for every
  login. A wrong password gets the usual `401 invalid_credentials`, suspended
  or not. Only the correct password on a suspended account gets
  `403 account_suspended`, and no session is issued.
- Google or GitHub sign-in through an identity already linked to a suspended
  customer returns to the portal with `auth_error=account_suspended` and no
  session.
- Email-code requests stay silent: a suspended address gets the same response
  as an unknown one, and no code is sent.

The portal then shows "This account is suspended." followed by a support
contact. Set the optional `PORTAL_SUPPORT_CONTACT` variable to an `https:` URL
or one `mailto:` address, for example `mailto:support@example.com`. The
providers endpoint publishes it as `support`, and the portal links it as
"Contact support" wherever its sign-in and app-connection messages tell a
customer to contact someone. The seat message "All seats are in use — release
one or ask your administrator." stays unlinked on purpose. A URL containing a
user name or password, a `mailto:` with several addresses or a `?` query, any
other scheme (`http:`, `javascript:` and so on), a relative path, or an empty
value counts as unset, and the portal says "Contact your administrator"
instead. The value is public configuration, not a secret.

Disabling is also the first step of deleting an account. The portal has no
delete action; follow the operator runbook
[Delete a customer account](../../doc/operations/customer-account-deletion.md),
which clears the customer's personal data and keeps the audit rows.
