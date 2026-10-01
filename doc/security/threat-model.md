# Platform threat model

This document is the maintained threat model for the Licensecc release scope.
It is evaluated with the [production-readiness
contract](../operations/production-readiness.md) for every release candidate.
It does not claim that an operator's Cloudflare account, credentials, DNS,
routes, or customer systems are correctly configured; those controls require
protected-environment evidence for the exact deployment.

## Scope and security objectives

The reviewed system comprises the C/C++ licensing runtime (offline v201 `.lic`
verification, `lcccfg1` configuration tokens, and the protected device-bound
client), the licensing backend, admin, customer portal, D1 backup Worker, D1
and R2 data, the Python, .NET, and Java SDKs (config-token verification and the
protected native adapters), and repository-owned CI/release automation.

The primary objectives are:

- only an authorized signer can produce an accepted license, configuration
  token, or protected `lccdl1` lease;
- revoked, disabled, expired, replayed, or cross-tenant authority fails closed;
- operator and customer identities cannot cross their assigned role or tenant;
- mutations, fulfillment, and audit transitions are atomic and idempotent;
- credentials, OTPs, customer data, license payloads, and signing material do
  not enter source, artifacts, logs, or public error responses;
- backups are integrity-bound strongly enough to identify corruption, restore
  into an empty scratch target, and validate without overwriting production
  automatically; backup authenticity remains explicitly unproven while the
  unsigned manifest shares the SQL object's R2 write trust boundary; and
- a release is traceable to one reviewed source commit and reproducible
  artifact set.

The model does not promise resistance to an administrator who intentionally
replaces both the application and all trust anchors, compromise of a customer's
operating system, perfect hardware identity, or availability during a
provider-wide outage. The native runtime is an enforcement component, not a
DRM guarantee against an attacker who fully controls its process.

## Assets and trust boundaries

| Boundary | Sensitive assets | Untrusted inputs | Required trust decision |
| --- | --- | --- | --- |
| Native host and SDKs | compiled v201 project public key, protected lease trust set (at most eight RSA-3072 SPKI keys), TPM-held device key, signed checkpoints and revision floor, license/token/lease bytes | local files, remote responses, host callbacks, browser callbacks, clocks | accept only authenticated, current, correctly scoped claims, prove local key possession before each protected operation, and never restore authority after a process restart |
| Licensing backend | protected lease signing private key, approval encryption key ring, order HMAC and webhook signing key rings, entitlement, binding, and lease state | `/v2` device requests and proofs, signed orders, webhook receivers, network identity | validate shape, scope, freshness, single-use challenges, replay state, capacity, and current authority before signing or mutation |
| Admin Worker and UI | Access roles, entitlement/catalog/customer data, sync secret | Access JWTs, UI/API bodies, sync projections | verify issuer/audience/signature and map an exact email allowlist before reads or writes |
| Customer portal | OTP/session peppers, password hashes, OAuth client secrets, customer identity, and device consent decisions | email, OTP, cookies, same-origin actions, enrollment links, configured downstream origins | bind sessions, consent, and records to one customer, rate-limit authentication and consent, and reject cross-origin or cross-tenant actions |
| D1 and R2 | customer/licensing/audit rows, nonces, sessions, SQL exports and manifests | Worker queries, migrations, backup/restore commands | retain atomicity and least privilege; never infer that an unverified restore is production-safe |
| CI and registries | source authority, workflow tokens, protected config, package identities | pull requests, dependency updates, tags, workflow inputs | run pinned review gates and release only an exact authorized commit through protected environments |
| Operators and key custody | Cloudflare/API credentials, signing keys, Access policy, registry publisher identity | human approvals and break-glass actions | use least privilege, separation of duties, auditable rotation, and an explicit go/no-go decision |

Internet clients, customer browsers, license files, order senders, webhook
receivers, pull-request authors, dependency publishers, and every value outside
a validated binding are untrusted. Cloudflare is trusted to enforce the
configured platform primitives, but configuration presence and isolation must
be independently verified.

## Threat register

Status here describes repository controls. An operator control remains
**unproven** until release evidence links the protected workflow or drill.
Retired IDs are not reused.

| ID | Threat and impact | Repository control | Required verification / residual risk |
| --- | --- | --- | --- |
| TM-01 | A forged, altered, or downgraded `.lic` file or `lccdl1` lease permits unauthorized use | the runtime accepts only v201 `.lic` files signed by the compiled project key of at least 3072 bits; the native lease verifier accepts only the canonical `lccdl1` envelope signed by a trusted, unretired RSA-3072 key, checks issuer, audience, project, feature, binding, device key, and revision floor, uses the signed expiry without client grace, and requires fresh local device-key possession before every protected operation | native and SDK negative vectors must pass; operator must prove the deployed public trust set and rotation overlap; a modified host process remains outside this guarantee |
| TM-02 | Theft of the protected lease signer (`BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM`) permits lease forgery | the private key is a dedicated RSA-3072 Worker secret, never a deploy-config var or artifact, and never the v201 license-issuing key; the materializer accepts only its public SPKI in `vars`; `/health` readiness proves the pair signs and verifies without exposing either half | secret-name inventory, protected smoke, and a redacted rotation drill under the key-rotation runbook are required; Cloudflare account and operator endpoint compromise remain key-compromise events (see TM-18) |
| TM-03 | Replay of device proofs, orders, or operations creates duplicate leases, duplicate fulfillment, or stale authority | every proof signs a fresh single-use server challenge bound to the attempt or binding, device key, purpose, operation, and nonce; operation IDs recover the exact stored response for 48 hours and then stay as immutable tombstones; binding generations and revision floors only advance; order HMAC attempts are spent in a nonce store; D1 uniqueness and atomic batches guard every write | service and SQL tests must remain green; the staging portal drill proves a fresh-proof exchange and renewal, and the protected order drill proves one apply, exact signed-attempt replay denial, and a freshly signed same-event durable cached result; controlled accept/apply crash redrive remains unexercised external evidence |
| TM-04 | Enrollment or consent abuse enumerates attempts, exhausts device slots, approves into another customer's license, or floods the protected routes | registration attempts expire after five minutes and record an immutable requested feature; an unauthenticated challenge for an unknown attempt returns a generic `404 authorization_unavailable`; consent needs a portal session, the exact Origin, an expected-customer precondition, and an idempotency key, lists only the session customer's licenses for the requested feature, and rechecks ownership and capacity at approval; fixed D1 budgets (20/minute per source for registration, 600/minute per source for session traffic, 60/minute per device key, and max(240, 2 × device limit)/minute per customer) apply alongside the optional edge limiters; refusals are recorded in `device_bound_denials` | the production protected smoke proves the generic unknown-attempt denial; the staging portal drill proves consent, exchange, renewal, and retirement; provider quota exhaustion and distributed floods remain residual (see TM-20) |
| TM-05 | Admin authentication bypass or role escalation exposes or mutates all tenants | Cloudflare Access JWT signature/issuer/audience validation, exact reader/admin email lists, mutation role checks, and production-disabled development bearer | protected config must prove Access values and development auth off; staging automatically requires unauthenticated and malformed-token denial, a real non-admin mutation denial, and authenticated admin paths; remote Access policy/role assignment remains operator evidence |
| TM-06 | Browser injection or response framing steals operator/customer authority | dynamic API-doc content uses DOM text nodes and per-response CSP nonces; Vite static assets carry a self-only CSP; both paths deny framing and MIME sniffing and apply restrictive referrer/permissions policies; React escapes ordinary text | static-asset and API-doc policy tests plus deployed header/browser checks must pass; third-party script introduction requires a new review |
| TM-07 | CSRF, OTP guessing, session theft, or customer-ID manipulation crosses portal tenants | same-origin mutation checks, HttpOnly session cookies, short-lived single-use OTPs, HMAC-at-rest peppers, authentication rate limits, and server-derived customer scope | staging automatically proves unauthenticated read denial, secure attributes on a newly issued session cookie, authenticated paths, logout, and post-logout denial; expired-unused-OTP denial, denial after the server-side session TTL, transactional email delivery, and two-fixture cross-tenant denial remain external evidence |
| TM-08 | Configured downstream URL exfiltrates a bearer or email API key | credential-bearing destinations accept only canonical HTTPS origins without userinfo, path, query, or fragment | config validation and destination-negative tests must pass; DNS/provider compromise is residual |
| TM-09 | Tampered or replayed order ingestion grants entitlements | always-enforced HMAC key ring, mandatory signer scope (no rollout selector), signed-attempt nonce identity, durable event cache, idempotent apply, a customer id required on every order, orders acting only on a grant their own customer owns (every intent against another customer's or an unowned grant is refused with `409 entitlement_owner_mismatch`; a refusal before admission writes nothing, and one at apply records the rejected event, the cursor, and the order's own customer, license, and order identity rows, never an entitlement change or audit row), immutable customer/license links for a logical order, and audit rows | exact SQL/bind tests must prove a missing customer id is refused, a customer-scoped signer cannot activate, change or revoke another customer's grant through its fingerprint, and contradictory explicit links and their replay remain terminal `400 invalid_order` while an omitted license carries the durable value forward; protected staging apply/exact-replay/fresh-signature cached-retry evidence is also required, but its artifact remains partial/non-promotable because the conflict branch and crash redrive are not deployed proofs, and sender key custody remains external |
| TM-10 | D1 corruption, unsafe migration, or backup loss makes state unrecoverable | one backend-owned baseline migration with no upgrade path (a changed baseline means every database is recreated), immediate pre-migration run-and-wait backup, streamed SHA-256/size plus snapshot-count binding, R2 SQL+manifest retention, snapshot-time RPO, strict empty-scratch restore that refuses any migration history other than the exact baseline, and complete current table/index/trigger schema digest | protected workflow must prove manifest-pinned counts after import, historical schema identity, an exact baseline migration history, final schema/semantic results, measured RPO/RTO, and no automatic production restore; current live counts are informational, and the unsigned co-located manifest requires either proven authenticity or an explicit lower-severity acceptance with compensating R2 controls while `authenticity_verified` remains false |
| TM-11 | Backup endpoint/token or R2 access discloses the whole database | separate Worker, authenticated manual endpoints, least-privilege D1 REST token, private R2 binding, redacted gate output, and unauthenticated fail-closed check | operator must prove token scope, bucket privacy, secret presence, retention, and access-log review |
| TM-12 | CI or dependency compromise publishes attacker-controlled code | exact action SHAs, read-only default token, deterministic gates, secret scanning, CodeQL, dependency review, Dependabot coverage, canonical-tree assembly, main-only exact-SHA protected operations, and protected trusted publishing | remote branch/ruleset/environment settings and successful checks must be linked; repository workflow guards do not prove those remote controls, and maintainer endpoint compromise remains residual |
| TM-13 | Artifact substitution or version confusion installs different code | one version contract, checksum/SBOM inspection, archive member closure, exact-HEAD manifests, and double deterministic assembly | registry/release downloads must be rehashed and smoke-tested before stable promotion |
| TM-14 | Logs or evidence expose secrets, OTPs, PII, or license payloads | structured allow-listed events, bounded/redacted drill output, a raw-output-suppressing Wrangler wrapper, names-only secret inventory, secret scan, and evidence rules prohibit raw config/customer payloads | staging log sampling and deliberate error/alert exercises are required; provider-retained logs and observability destination access are operator-owned |
| TM-15 | Break-glass access becomes a permanent bypass | there are no emergency routes; the portal bootstrap bearer (`PORTAL_BOOTSTRAP_BEARER`) is the only break-glass sign-in path, is documented unset in steady state, and its route answers `404` while unset; the D1 entitlement CLI stamps `actor_type='cli'` audit events; restores require explicit scratch confirmation | every use requires an incident/change record, immediate rotation, and review of resulting audit events |
| TM-17 | An operator-configured webhook URL on the deployment's own zone makes the backend's `fetch` reach the origin directly, bypassing Cloudflare security settings, and the delivery log reads back part of the response | the backend Worker runs with `global_fetch_strictly_public` (enforced by the deploy-config materializer), so same-zone URLs go through Cloudflare's front door; `safeWebhookUrl` refuses userinfo, IP-literal, single-label, trailing-dot and internal hostnames and is re-checked before every delivery | materializer and `safeWebhookUrl` negative tests must pass; a public receiver that returns sensitive error text is residual and bounded to 256 characters in `last_error` |
| TM-18 | A compromised protected signer lets an attacker mint leases for any entitlement until trust is withdrawn | one active RSA-3072 signer whose key ID derives from its SPKI; the native trust set holds at most eight keys, and a `retired` key rejects leases and saved checkpoints; leases last at most 24 hours and never survive a process restart; the key-rotation runbook separates private-signing retirement from public-trust removal | compromise is an incident: stop compromised signing, ship corrected client trust, and record which releases still trust the key; removing the server secret cannot invalidate leases already accepted in running processes before their signed expiry |
| TM-19 | Consent phishing tricks a customer into approving an attacker's enrollment | the app and the browser show the same comparison code, derived from the immutable enrollment transcript (attempt handle, client, project, device key, callback, state, PKCE challenge, and requested feature), and the browser asks the customer to confirm the match; the authorization URL carries only the attempt handle; callbacks go only to the registered loopback path on `127.0.0.1` or `[::1]`; exchange needs the PKCE verifier and a device-key proof; attempts expire after five minutes, and an approval uses one device slot that the customer can disconnect | a customer who approves without comparing codes can still grant a slot to another device; the portal Devices screen and the admin connected-device view must keep unexpected connections visible; live browser qualification is required |
| TM-20 | A distributed flood trips the protected global fuse and denies all online licensing | `BOUND_GLOBAL_RATE_LIMIT` (default 1,000/minute, range 100 to 1,000,000) counts only requests already admitted by their own per-source budget, so one source cannot spend it; edge limiters reject per-source floods before any D1 write; `/health` names an unbound limiter; OBS-06 pages when the fuse is reached | with the defaults, two sources at the 600/minute session limit already exceed the fuse; operators must raise it to the declared peak and add a WAF rate rule; because leases last at most 24 hours and never survive a restart, a sustained fuse trip denies licensing to every protected client |

No critical or high threat may be accepted silently. A lower-severity accepted
risk must name its owner, rationale, compensating control, and review deadline
in the release evidence.

## Credential and trust-anchor rotation

Rotation is a production operation and is never performed by a source-review
agent. A release drill records names and key IDs only, never values.

1. Inventory the affected secret name, active key ID, consumers, expiry, and
   rollback owner. Confirm the old credential is not present in source,
   artifacts, workflow inputs, or logs.
2. Add a new random credential through the protected provider interface. For
   key-ring controls such as `ORDER_HMAC_SECRETS`,
   `WEBHOOK_SIGNING_SECRETS`, `BOUND_APPROVAL_ENCRYPTION_KEYS`,
   `PORTAL_OTP_PEPPERS`, and `PORTAL_SESSION_PEPPERS`, retain the old verifier
   or decryptor entry during the bounded overlap and switch only the active
   mint/sign/encrypt ID.
3. For the protected lease signer, follow the
   [key rotation runbook](../operations/device-bound-key-rotation.md): ship an
   application release that trusts both public keys before the backend switches
   `BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM` and its public SPKI as one pair.
   The offline v201 issuing key follows its separate custody process.
4. Run negative-old/positive-new staging checks, then the applicable
   backend/admin/portal/backup read and mutation drills. Confirm that logs show
   key IDs at most, never material.
5. Drain the documented token/lease/session lifetime, remove the old verifier
   entry, rerun negative-old/positive-new checks, and record UTC timestamps,
   approvers, and rollback outcome.
6. Rotate immediately after suspected disclosure or break-glass use. Treat
   signing-key compromise as an incident requiring trust-anchor and issued
   lease/license impact analysis, not merely a secret replacement.

Single-value credentials such as Cloudflare deployment tokens,
`SYNC_API_TOKEN`, `PORTAL_BOOTSTRAP_BEARER`, `BACKUP_TRIGGER_TOKEN`, and
`D1_REST_API_TOKEN` require a provider-supported overlap or a planned bounded
cutover. The operator must prove least-privilege scopes again after rotation.

## Security verification matrix

| Surface | Repository gate | Protected/staging evidence |
| --- | --- | --- |
| Source and dependencies | `npm run scan:secrets`, `npm run test:security-governance`, `npm run lint`, `npm run typecheck`, CodeQL and dependency-review workflows | private vulnerability reporting, secret scanning/push protection, required checks, and alert triage enabled remotely |
| Native/SDK cryptography and parsing | `npm run check:pr`, `npm run test:sdks`, `npm run test:native-security`, and the Clang ASan/UBSan plus bounded libFuzzer workflow | real published artifacts re-downloaded and negative/positive vectors repeated; the native workflow must complete on Linux |
| Backend | backend unit/SQL/contract tests, names-only secret-inventory tests, protected smoke tests, and bounded staging order drill tests | secret-name presence and runtime correctness; the production protected smoke (readiness, no configuration warnings, generic unknown-attempt denial); signed order apply, exact replay denial, and fresh-signature cached retry; the live native TPM/browser/backend journey on each supported platform; a protected capacity harness, which does not exist yet, and controlled crash-redrive evidence remain required |
| Admin | admin worker/UI/Access tests and validator tests | real Access unauthenticated/malformed/non-admin/admin checks; development bearer absent and remote role policy linked |
| Portal | portal worker/UI/session/OTP tests and deployed portal drill tests | real unauthenticated denial, new-cookie attributes, authenticated UI/session paths, logout/post-logout denial, expired-unused-OTP denial, server-side session-TTL denial, transactional email delivery, cross-tenant two-fixture denial, rate limit, and the staging-only protected device enrollment, exchange, renewal, and binding retirement journey |
| Backup/recovery | backup tests, deploy validator, pre-migration run-and-wait tests, and restore-drill tests | completed integrity/snapshot-count-bound backup followed by strict empty-scratch import, pinned snapshot count parity, an exact baseline migration history, complete current schema digest, semantic checks, explicit authenticity disposition, and measured snapshot-time RPO/RTO |
| Release chain | workflow contracts, version contract, secret scan, deterministic double assembly | protected approvals, trusted publishing, checksums/SBOM, registry smoke, rollback drill, and pilot observation |

The final security reviewer disposition belongs in `docs/implementation/` and
must identify the exact commit. Missing remote evidence is recorded as
`blocked` or `not run`; repository success must not be relabeled as deployed
security assurance.
