# Platform threat model

This document is the maintained threat model for the Licensecc release scope.
It is evaluated with the [production-readiness
contract](../operations/production-readiness.md) for every release candidate.
It does not claim that an operator's Cloudflare account, credentials, DNS,
routes, or customer systems are correctly configured; those controls require
protected-environment evidence for the exact deployment.

## Scope and security objectives

The reviewed system comprises the C/C++ verifier runtime, the licensing
backend, admin, customer portal, D1 backup Worker, D1 and R2 data, the Python,
.NET, and Java verification SDKs, and repository-owned CI/release automation.
PostgreSQL is a conformance target rather than a hosted production runtime.

The primary objectives are:

- only an authorized signer can produce an accepted license or online
  assertion;
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
| Native host and SDKs | embedded public-key rings, persisted revocation floor, license/assertion bytes | local files, remote responses, host callbacks, clocks | accept only authenticated, current, correctly scoped claims and preserve the strongest revocation sequence |
| Public licensing backend | online signing private key, HMAC/pepper key rings, entitlement and lease state | verify/lease/order requests, device keys, webhooks, network identity | validate shape, scope, freshness, replay state, capacity, and authorization before signing or mutation |
| Admin Worker and UI | Access roles, entitlement/catalog/customer data, sync secret | Access JWTs, UI/API bodies, sync projections | verify issuer/audience/signature and map an exact email allowlist before reads or writes |
| Customer portal | OTP/session/account-token peppers, customer identity and downloadable license data | email, OTP, cookies, same-origin actions, configured downstream origins | bind sessions and records to one customer, rate-limit authentication, and reject cross-origin or cross-tenant actions |
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

| ID | Threat and impact | Repository control | Required verification / residual risk |
| --- | --- | --- | --- |
| TM-01 | Forged or downgraded license/assertion permits unauthorized use | signatures are checked against explicit key IDs; production decision API requires online verification and a host-persisted revocation floor | native and SDK negative vectors must pass; operator must prove the deployed public key ring and rotation overlap |
| TM-02 | Stolen online or lease signing key permits assertion/lease forgery | private material is a Worker secret, is excluded from configs/artifacts, and is separate from the offline issuing key | secret-name/config checks, the direct staging lease path, and a redacted rotation drill are required; the lease drill binds a canonical protected PKCS#1 public key to the expected key ID and RSA-SHA256 verifies the canonical v201 activate/renew fields, while endpoint compromise remains a key-compromise event and the server-side fixture is not a portal/browser key UX |
| TM-03 | Replay or concurrency bypass creates duplicate fulfillment, leases, or stale authority | timestamp/nonce checks, D1 uniqueness, idempotency records, atomic batches, capacity state, and monotonic revocation sequences | service, SQL, and live PostgreSQL-conformance tests must remain green; the protected order drill proves one apply, exact signed-attempt replay denial, and a freshly signed same-event durable cached result; controlled accept/apply crash redrive remains unexercised external evidence |
| TM-04 | Public verifier abuse causes enumeration or denial of service | generic unsigned denial, input/body bounds, optional device proof, entitlement/client rate-limit tiers, and fail-closed selector validation | staging must prove malformed denial, rotating-fingerprint limiting, recovery, and the declared capacity envelope; provider quota exhaustion remains residual |
| TM-05 | Admin authentication bypass or role escalation exposes or mutates all tenants | Cloudflare Access JWT signature/issuer/audience validation, exact reader/admin email lists, mutation role checks, and production-disabled development bearer | protected config must prove Access values and development auth off; staging automatically requires unauthenticated and malformed-token denial, a real non-admin mutation denial, and authenticated admin paths; remote Access policy/role assignment remains operator evidence |
| TM-06 | Browser injection or response framing steals operator/customer authority | dynamic API-doc content uses DOM text nodes and per-response CSP nonces; Vite static assets carry a self-only CSP; both paths deny framing and MIME sniffing and apply restrictive referrer/permissions policies; React escapes ordinary text | static-asset and API-doc policy tests plus deployed header/browser checks must pass; third-party script introduction requires a new review |
| TM-07 | CSRF, OTP guessing, session theft, or customer-ID manipulation crosses portal tenants | same-origin mutation checks, HttpOnly session cookies, short-lived single-use OTPs, HMAC-at-rest peppers, authentication rate limits, and server-derived customer scope | staging automatically proves unauthenticated read denial, secure attributes on a newly issued session cookie, authenticated paths, logout, and post-logout denial; expired-unused-OTP denial, denial after the server-side session TTL, transactional email delivery, and two-fixture cross-tenant denial remain external evidence |
| TM-08 | Configured downstream URL exfiltrates a bearer or email API key | credential-bearing destinations accept only canonical HTTPS origins without userinfo, path, query, or fragment | config validation and destination-negative tests must pass; DNS/provider compromise is residual |
| TM-09 | Tampered or replayed order ingestion grants entitlements | required HMAC key ring/mode, signer scope, signed-attempt nonce identity, durable event cache, idempotent apply, immutable non-null customer/license links for a logical order, and audit rows | exact SQL/bind tests must prove contradictory explicit links and their replay remain terminal `400 invalid_order` while omission carries durable values forward; protected staging apply/exact-replay/fresh-signature cached-retry evidence is also required, but its artifact remains partial/non-promotable because the conflict branch and crash redrive are not deployed proofs, and sender key custody remains external |
| TM-10 | D1 corruption, unsafe migration, or backup loss makes state unrecoverable | backend-owned migrations, immediate pre-migration run-and-wait backup, streamed SHA-256/size plus snapshot-count binding, R2 SQL+manifest retention, snapshot-time RPO, strict empty-scratch restore, canonical migration-prefix upgrade, and complete current table/index/trigger schema digest | protected workflow must prove manifest-pinned counts before migration, historical migration/schema identity, application of the checked-out suffix, final schema/semantic results, measured RPO/RTO, and no automatic production restore; current live counts are informational, and the unsigned co-located manifest requires either proven authenticity or an explicit lower-severity acceptance with compensating R2 controls while `authenticity_verified` remains false |
| TM-11 | Backup endpoint/token or R2 access discloses the whole database | separate Worker, authenticated manual endpoints, least-privilege D1 REST token, private R2 binding, redacted gate output, and unauthenticated fail-closed check | operator must prove token scope, bucket privacy, secret presence, retention, and access-log review |
| TM-12 | CI or dependency compromise publishes attacker-controlled code | exact action SHAs, read-only default token, deterministic gates, secret scanning, CodeQL, dependency review, Dependabot coverage, canonical-tree assembly, main-only exact-SHA protected operations, and protected trusted publishing | remote branch/ruleset/environment settings and successful checks must be linked; repository workflow guards do not prove those remote controls, and maintainer endpoint compromise remains residual |
| TM-13 | Artifact substitution or version confusion installs different code | one version contract, checksum/SBOM inspection, archive member closure, exact-HEAD manifests, and double deterministic assembly | registry/release downloads must be rehashed and smoke-tested before stable promotion |
| TM-14 | Logs or evidence expose secrets, OTPs, PII, or license payloads | structured allow-listed events, bounded/redacted drill output, a raw-output-suppressing Wrangler wrapper, names-only secret inventory, secret scan, and evidence rules prohibit raw config/customer payloads | staging log sampling and deliberate error/alert exercises are required; provider-retained logs and observability destination access are operator-owned |
| TM-15 | Break-glass access becomes a permanent bypass | emergency routes use separate secrets and audit events; portal bootstrap is documented unset in steady state; restores require explicit scratch confirmation | every use requires an incident/change record, immediate rotation, and review of resulting audit events |
| TM-16 | Requiring device proof without a browser/client key workflow either breaks portal issuance or tempts operators to place a private key in the portal | the standard portal-capable topology requires `DEVICE_PROOF_MODE=off`; missing lease/seat proof is accepted while every presented proof is still verified, and materialization rejects a global `required` claim | the portal must never receive or sign with a device private key; relay resistance for proof-less portal lease/seat issuance remains residual until a reviewed client/browser registration and signing UX exists |

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
   `ACCOUNT_TOKEN_PEPPERS`, `WEBHOOK_SIGNING_SECRETS`,
   `PORTAL_OTP_PEPPERS`, and `PORTAL_SESSION_PEPPERS`, retain the old verifier
   entry during the bounded overlap and switch only the active mint/sign ID.
3. For online asymmetric signing, distribute and verify the new public key
   record before changing `ONLINE_SIGNING_KEY_ID` and its private key. The
   offline issuing key follows its separate custody process.
4. Run negative-old/positive-new staging checks, then the applicable
   backend/admin/portal/backup read and mutation drills. Confirm that logs show
   key IDs at most, never material.
5. Drain the documented token/assertion/session lifetime, remove the old
   verifier entry, rerun negative-old/positive-new checks, and record UTC
   timestamps, approvers, and rollback outcome.
6. Rotate immediately after suspected disclosure or break-glass use. Treat
   signing-key compromise as an incident requiring trust-anchor and issued
   assertion/license impact analysis, not merely a secret replacement.

Single-value credentials such as Cloudflare deployment tokens,
`SYNC_API_TOKEN`, `EMERGENCY_OPERATOR_BEARER`, `BACKUP_TRIGGER_TOKEN`, and
`D1_REST_API_TOKEN` require a provider-supported overlap or a planned bounded
cutover. The operator must prove least-privilege scopes again after rotation.

## Security verification matrix

| Surface | Repository gate | Protected/staging evidence |
| --- | --- | --- |
| Source and dependencies | `npm run scan:secrets`, `npm run test:security-governance`, `npm run lint`, `npm run typecheck`, CodeQL and dependency-review workflows | private vulnerability reporting, secret scanning/push protection, required checks, and alert triage enabled remotely |
| Native/SDK cryptography and parsing | `npm run check:pr`, `npm run test:sdks`, `npm run test:native-security`, and the Clang ASan/UBSan plus bounded libFuzzer workflow | real published artifacts re-downloaded and negative/positive vectors repeated; the native workflow must complete on Linux |
| Backend | backend unit/SQL/contract tests, PostgreSQL conformance, names-only secret-inventory tests, and bounded staging order/lease drill tests | public verifier abuse/capacity run bound to one deployment; secret-name presence and runtime correctness; signed order apply, exact replay denial, and fresh-signature cached retry; authorized-fixture activate/renew with presented P-256 proof, substantive time checks, and canonical v201 RSA-SHA256 verification against the protected expected key; negative cross-scope token denial and controlled crash-redrive evidence remain required |
| Admin | admin worker/UI/Access tests and validator tests | real Access unauthenticated/malformed/non-admin/admin checks; development bearer absent and remote role policy linked |
| Portal | portal worker/UI/session/OTP tests and deployed portal drill tests | real unauthenticated denial, new-cookie attributes, authenticated UI/session paths, logout/post-logout denial, expired-unused-OTP denial, server-side session-TTL denial, transactional email delivery, cross-tenant two-fixture denial, rate limit, and optional seat/download checks |
| Backup/recovery | backup tests, deploy validator, pre-migration run-and-wait tests, and restore-drill tests | completed integrity/snapshot-count-bound backup followed by strict empty-scratch import, pinned pre-migration count parity, canonical migration-prefix upgrade, complete current schema digest, semantic checks, explicit authenticity disposition, and measured snapshot-time RPO/RTO |
| Release chain | workflow contracts, version contract, secret scan, deterministic double assembly | protected approvals, trusted publishing, checksums/SBOM, registry smoke, rollback drill, and pilot observation |

The final security reviewer disposition belongs in `docs/implementation/` and
must identify the exact commit. Missing remote evidence is recorded as
`blocked` or `not run`; repository success must not be relabeled as deployed
security assurance.
