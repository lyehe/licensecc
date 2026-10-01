# Production readiness contract

This contract defines the minimum evidence required before Licensecc can be
described as production-ready or promoted from a release candidate. Passing
repository tests alone is necessary but is not sufficient: the exact release
commit must also pass protected-environment, staging, recovery, and pilot
gates.

Nothing in this page authorizes publishing, secret changes, or deployment.
Those actions remain explicit operator decisions performed through protected
environments.

## Repository hardening versus promotion evidence

The repository defines fail-closed automation for the following controls:

- protected deployment, rollback, and recovery jobs run only from `main`, check
  out the exact workflow SHA, and share one operations concurrency group per
  environment;
- protected configuration is bound to the expected Cloudflare account, D1
  database, validated service origins, and credential-bearing target origins;
- Wrangler dry-run, deploy, migration, and deployment-list output is captured
  behind a fixed-operation redaction wrapper, and deployment evidence requires
  a bounded transition to a new sole 100% active version;
- backend secret inventory is names-only and bounded; the production deploy
  runs a credential-free protected smoke that fails on any `/health`
  configuration warning; staging admin and portal drills exercise real
  authorization denials and a software-key protected-device journey; and
  backup/recovery evidence binds streamed content integrity, snapshot time,
  and complete schema identity.

Those controls describe repository behavior, not a completed promotion. They
do not prove remote branch/ruleset or protected-environment policy, Cloudflare
resource isolation or token scope, deployed secret contents, dashboard/alert
routing, a protected capacity run, the live TPM/browser/backend journey,
rollback/recovery execution, registry publication, or the production pilot.
Until immutable external evidence covers those items for one exact commit, the
candidate remains a no-go.

## Launch scope

The initial hosted production scope is:

- the licensing-backend, license-admin, customer-portal, and D1-backup
  Cloudflare Workers;
- Cloudflare D1 as the production database;
- offline v201 `.lic` licensing issued with `lccgen`, and `lcccfg1`
  configuration tokens;
- protected device-bound online licensing and feature sessions on Windows and
  Linux with a TPM and a desktop browser, served by the four `/v2` device
  routes, plus the signed order inbox `POST /v1/orders`;
- the platform release artifacts and the Python, .NET, and Java SDKs described
  by the platform version contract (config-token verification and the
  protected native adapters); and
- the Windows and Linux native validation matrix documented by the release
  evidence.

The owner has accepted that the initial release does not include:

- floating or concurrent seats;
- metering and quotas;
- usage reports;
- online revocation for `.lic` applications;
- server-issued 30-day offline leases: protected authority lasts at most
  24 hours and never survives a process restart;
- online licensing without a TPM and a desktop browser, so headless hosts, CI
  runners, containers, and Windows Server 2022 cannot license online;
- SDK-only online licensing, without the native runtime;
- customer account tokens;
- the `/v1/emergency` break-glass routes; and
- the local SQLite online demo.

The D1 schema is one baseline edited in place, with no upgrade path. Every D1
database, including staging, production, and restore scratch databases, must be
recreated from that baseline when it changes. The live TPM, browser, and
backend journeys remain release gates on each supported platform. The protected
global fuse, `BOUND_GLOBAL_RATE_LIMIT`, can deny all online licensing when a few
sources flood the protected routes; operators must size it to the expected peak
and add a WAF rate rule.

## Accountable roles

Named people or teams are configured outside the source tree. Every release
must nevertheless record one accountable actor for each semantic role below:

| Role | Required decision or evidence |
| --- | --- |
| Release coordinator | Exact commit, version, required-check status, artifact identity, and final go/no-go decision |
| Repository/CI administrator | `main` rulesets, required checks, protected-environment restrictions, reviewer policy, and security-product configuration |
| Service maintainers | Four-Worker configuration and post-deploy validation results for their owned deployables |
| Database/recovery operator | Migration review, pre-migration backup, restore result, RPO, and RTO |
| Security reviewer | Threat-model review, open-finding disposition, and credential-rotation evidence |
| Cloudflare operator | Environment isolation, Access policy, least-privilege credentials, routes, D1, R2, and Workflow bindings |
| Observability/on-call operator | Dashboard ownership, alert delivery and acknowledgement drills, sensitive-log review, and pilot monitoring |
| Artifact publisher | Registry identities, protected publication, re-download verification, and release-location integrity |

The repository ownership map defines the source boundaries for these roles; it
does not invent GitHub teams or grant production access.

## Service objectives and capacity envelope

The release evidence must record the intended peak protected request rate and
concurrency for the candidate. Gates use that declared value as `P`; an absent
value fails the gate rather than silently selecting a smaller load. The same
value sizes `BOUND_GLOBAL_RATE_LIMIT`, so the global fuse does not trip below
the declared peak.

The protected objectives apply to the two routes that issue signed leases,
`POST /v2/device-authorizations/exchange` and `POST /v2/device-leases/renew`.
The initial acceptance targets are:

| Objective | Acceptance threshold |
| --- | --- |
| Protected exchange and renewal availability | At least 99.9% over the production-pilot observation window, excluding an agreed provider-wide outage recorded in the evidence |
| Protected exchange and renewal latency | p95 below 500 ms and p99 below 1 second at `P` |
| Unexpected server errors | Less than 0.1% of requests at `P`, with no unexplained error class |
| Burst capacity | `2P` for 30 minutes without an objective or data-integrity violation |
| Soak capacity | `P` for four hours without resource growth, stale backup, or integrity drift |
| Recovery point objective | No more than one hour of committed production data at risk |
| Recovery time objective | Service restored and validated within four hours |
| Data safety | Zero cross-tenant disclosure, duplicate fulfillment, lost audit transition, or nonce/idempotency reuse |

A release may adopt stricter targets. Relaxing a target requires a reviewed
documentation change and an explicit risk decision before the affected test;
the evidence report must never redefine a threshold after seeing the result.

No protected capacity harness exists yet. The repository therefore makes no
capacity claim: the burst and soak objectives above stay unmet, and the release
stays a no-go, until a reviewed harness exercises the exchange and renewal
routes at the declared `P`.

## Required gates

Each gate is evaluated against one exact commit. A skipped applicable check is
a failure, not a pass.

### PRD-01: deterministic source validation

From a clean or intentionally classified checkout with the exact pinned
toolchains:

```powershell
npm ci
npm run check:pr
npm run test:sdks
npm run setup:browsers
npm run test:e2e
npm run check:dry-run
npm run check:docs
pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug
```

The scheduled/manual network link check is recorded separately with
`npm run check:docs:links`.

### PRD-02: repository and environment protection

- `main` requires the reviewed Linux, Windows, service, contract, and release
  checks.
- Force-push and branch deletion are disabled, and review requirements apply
  to release-sensitive paths.
- The `production`, `pypi`, `nuget`, and `github-release` environments are
  protected by reviewers and branch/tag restrictions. Staging uses separate
  Cloudflare resources and credentials.
- Repository-owned protected operations reject non-`main` dispatch, check out
  and verify the exact workflow SHA, and serialize every staging or production
  mutation through that environment's one operations concurrency group.
- Materialized Worker configuration must match the protected Cloudflare
  account, D1 ID, service route origins, and credential-bearing target origins;
  structural validation is not a substitute for proving remote resource
  ownership and least-privilege scopes.
- Secret scanning, dependency security updates, and code scanning are enabled
  or an explicit equivalent control is recorded.

The workflow files can enforce their local conditions but cannot prove GitHub
rulesets, environment reviewers/restrictions, Cloudflare account settings, or
security-product enablement. Link immutable remote configuration evidence for
the exact candidate.

### PRD-03: staging rollout of the four Workers

- Protected configuration materializes successfully and every Worker passes a
  Wrangler dry run through the bounded, raw-output-suppressing wrapper. The
  materializer requires `BOUND_DEVICE_CONFIG`, an RSA-3072
  `BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM`, both edge rate-limit bindings, and
  an explicit `--profile`.
- The D1 baseline is reviewed. A changed baseline has no upgrade path: every
  affected D1 database is recreated from it before dependent Workers deploy.
- Backend, admin, portal, and backup deploy in the documented order against
  isolated staging resources.
- Every deploy records a changed deployment ID and a new sole version receiving
  100% of traffic within the bounded post-deploy poll.
- Backend `/health` returns `200` with `protected_device_ready: true` and no
  `config_warnings`, and portal `/health` returns `200 healthy` with
  `data.backend_protected_ready: true`; any other answer is a readiness failure.
  The production deploy, not this staging rollout, runs the protected smoke
  right after its Worker deploy: it requires that backend readiness, fails on
  any configuration warning (an unset `ORDER_SIGNER_SCOPES` or an unbound edge
  limiter), requires an unauthenticated challenge for an unknown attempt to
  return `404 authorization_unavailable`, and retains its redacted evidence.
  Health proves local protected configuration only; the staging drill below and
  native live qualification prove issuance and renewal.
- A synthetic tenant completes the backend, operator, customer, and recovery
  paths without touching production data.
- The admin drill proves unauthenticated and malformed-token denial, real
  non-admin mutation denial, authenticated access, and its mutation/idempotency
  cycle. The portal drill proves unauthenticated read denial, secure attributes
  on a newly issued staging cookie, authenticated paths, logout, and
  post-logout denial. In staging it also enrolls a fresh software P-256 device
  key, approves it through portal consent, exchanges and renews its lease with
  key-possession proofs, verifies both leases against the staging lease public
  key, and retires the binding; the production post-deploy drill never enrolls
  a device. A software key proves the protocol, not hardware-backed key
  storage. Denial of an expired unused OTP, denial of a previously
  authenticated session after its server-side TTL, successful transactional
  email delivery, and a two-fixture cross-tenant denial require separate
  retained evidence. Cookie attributes or logout do not prove either expiry
  boundary.
- A signed staging order must apply once, the byte/header-identical signed
  replay must be rejected, and an identical logical body signed afresh with a
  later authenticated timestamp must return the durable cached result. This
  proves exact-attempt replay denial and deployed cached application
  idempotency. A crash between durable accept/apply remains unexercised and may
  not be reported as passed. Repository contract tests additionally require a
  contradictory explicit customer/license tuple for an already-linked order
  to remain terminal `400 invalid_order` (including replay), while omitted
  fields carry the durable values forward; the protected staging sequence does
  not by itself exercise that conflict branch.
- The last-known-good Worker version is restored in a timed rollback drill.
- On each supported platform, the real native example completes the live
  protected journey against the staging backend and portal: enrollment with a
  TPM-held key and browser consent, activation, protected work, a restart that
  needs a fresh online renewal, and a feature session. The staging drill's
  software key does not substitute for this journey.

### PRD-04: backup and recovery

- A backup completes and is verified immediately before the deployment's D1
  migration step.
- SHA-256 and byte size are computed in the same backpressured stream uploaded
  to R2; a names-and-counts-only durable-table inventory is derived from those
  same snapshot bytes; returned object size and any returned SHA-256 checksum
  are validated and retained without row values or raw Wrangler output.
- The retained backup is restored into a scratch D1 database.
- The scratch target has no pre-existing non-system table, including an
  unrelated empty table, before import.
- Immediately after import, the historical snapshot must have exactly the
  durable-table set and counts pinned in its manifest. Current live-source
  counts are informational only and cannot invalidate a valid historic
  snapshot after later writes.
- The imported `d1_migrations` history must equal the checked-out
  `migrations/0001_baseline.sql` baseline exactly. Its historical schema digest
  is recorded; any other history (missing, divergent, ahead, or incomplete)
  fails the drill closed, and no migration is applied. A backup of a database
  created from an earlier baseline cannot be restored this way: the database
  must be recreated from the current baseline instead.
- After the baseline history is verified, the complete table, named-index,
  and trigger inventory is compared to the canonical backend schema through a
  normalized digest/count contract, and service-level invariants are checked.
- Measured backup age starts at `snapshot_requested_at` immediately before D1
  export, not the later R2 upload time, and restore time meets the declared RPO
  and RTO.

The adjacent manifest is unsigned and shares the SQL object's R2 write trust
boundary. Digest/size agreement detects corruption but does not establish
authenticity; evidence must retain `authenticity_verified: false` unless a
separately reviewed authenticity mechanism is added and exercised. This may be
an accepted lower-severity residual only when the security reviewer records an
owner, rationale, review deadline, and compensating R2 write isolation,
version-retention, and access-review controls. A missing or rejected
disposition is a release blocker; an approved disposition does not turn the
field into `true`.

### PRD-05: protected objectives and observability

- `POST /v2/device-authorizations/exchange` and `POST /v2/device-leases/renew`
  meet the availability, latency, and unexpected-error objectives above over
  the pilot window, measured from retained service telemetry for the approved
  deployment, its sole active version UUID, and its exact commit.
- No protected capacity harness exists yet, so this gate makes no capacity
  claim. The `2P` burst and `P` soak objectives remain unmet blockers until a
  reviewed harness exercises both routes with real device-key proofs against
  one approved staging deployment. A health check, the protected smoke, or the
  staging software-key journey is not load evidence.
- `BOUND_GLOBAL_RATE_LIMIT` is recorded and is at least the declared `P`, and a
  WAF rate rule covers the protected routes; otherwise a few flooding sources
  can trip the global fuse and deny all online licensing.
- Alert paths are deliberately exercised for elevated errors, stale backup,
  configuration inconsistency, failed downstream delivery, and protected-route
  rate limiting.
- Logs are inspected for tokens, OTPs, signing material, license payloads, and
  customer data; sensitive values must not appear.

The exact dashboard, alert thresholds, drill sequence, and redacted evidence
requirements are defined in
[`doc/operations/observability.md`](observability.md).

Protected-device rollout additionally requires the OBS-08 cleanup drill in
that runbook, including failed/unknown sweeps, backlog age and an independently
evaluated missing schedule. Retain its predicate, delivery, acknowledgement and
recovery evidence separately from the other alert drills.

### PRD-06: security assurance

- The maintained threat model covers protected device licensing and consent,
  admin Access, portal sessions and OTP, signed order ingestion, D1, R2, CI,
  registries, and signing/credential custody.
- Supported dependency, static-analysis, sanitizer, and fuzzing gates pass.
- Protected backend secret inventory confirms required names only. It does not
  inspect secret values, prove a selector exists inside a secret map, or prove
  key/credential correctness; runtime health, positive signed operations, and
  rotation evidence remain required.
- Credential rotation is demonstrated without printing or committing values.
  Protected-device rollout also requires the evidence in the
  [key rotation runbook](device-bound-key-rotation.md), including saved-checkpoint
  compatibility before removal of old public trust.
- No critical or high finding is untriaged. Accepted lower-severity findings
  name an owner, deadline, and rationale.

### PRD-07: release candidate and pilot

- Canonical artifacts are assembled twice from the exact commit and compare
  byte-for-byte.
- Published artifacts install and pass smoke tests from their real registry or
  release location.
- The release candidate completes a production pilot for at least seven days;
  extend the observation to fourteen days after a rollback, objective breach,
  or material incident.
- Stable promotion requires all gates to remain green and an explicit human
  go/no-go decision.

## Phase 0–7 closure plan

Run these phases in order for one immutable candidate. A later source change
invalidates downstream evidence unless the relevant phase explicitly proves
that the changed artifact is outside its trust boundary. The model suggestions
refer to Codex: [GPT-5.6-Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
is the quality-first model for complex professional work, while
[GPT-5.6-Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
balances intelligence and cost. They assist the accountable people; they do
not approve, publish, change secrets, or operate a protected environment on
their own.

### Phase 0 — Freeze scope, ownership, and evidence policy

- **Objective:** turn the working tree and launch assumptions into one
  reviewable candidate definition before expensive or stateful verification.
- **Deliverables:** exact full commit SHA and version, classified checkout,
  declared `P`, launch-scope confirmation, named actor for
  every accountable role, open-risk ledger, evidence index, protected archive
  owner, and a retention-until date at least 12 months after the final go/no-go
  decision.
- **Dependencies:** none. This phase must precede every candidate-specific
  protected run.
- **Accountable roles:** release coordinator; each other role accepts its
  assignment and evidence obligation.
- **Suggested model/effort:** GPT-5.6-Terra, medium. The work is primarily
  bounded inventory, normalization, and omission detection.
- **Local verification:** run `git status --short`, `git rev-parse HEAD`,
  `npm run doctor`, and `npm run check:versions`; classify every modification
  and untracked path without cleaning or resetting it.
- **Protected verification/evidence:** create the candidate evidence ledger
  with the immutable SHA, version, `P`, actor names, risk states, expected
  workflow names, raw-artifact archive location, retention date, and required
  run-URL placeholders. No deployment or publication is authorized here.
- **Binary exit criterion:** pass only when every field has one value and one
  owner, the candidate is committed and intentionally classified, and every
  open risk is either blocking or has a proposed reviewer disposition. Any
  placeholder except a future run URL is a failure.

### Phase 1 — Prove deterministic source and documentation

- **Objective:** establish that the exact candidate builds and verifies with
  pinned tools on every supported repository surface.
- **Deliverables:** complete PRD-01 command transcript, required CI results,
  SDK/native matrices, dry-run output, documentation build, and build-purity
  result, all bound to the candidate SHA.
- **Dependencies:** Phase 0 candidate identity and toolchain inventory.
- **Accountable roles:** release coordinator and service maintainers;
  repository/CI administrator attests the matching required-check runs.
- **Suggested model/effort:** GPT-5.6-Sol, high. Cross-platform failures can
  cross service, native, packaging, schema, and documentation boundaries.
- **Local verification:** execute the complete PRD-01 block exactly. Run
  `npm run check:docs:links` separately: it is scheduled/manual network
  evidence and neither replaces nor is replaced by the deterministic local
  `npm run check:docs` build.
- **Protected verification/evidence:** retain Linux, Windows, services,
  contracts, security, and release required-check URLs
  for the same SHA, plus the separate network-link run and its UTC result.
- **Binary exit criterion:** pass only when every applicable command and
  required check exits successfully with no skip, waiver, or SHA mismatch and
  the separate link check has no unresolved failure. Otherwise stop.

### Phase 2 — Prove remote control-plane and environment isolation

- **Objective:** show that repository guards correspond to the real GitHub and
  Cloudflare control planes before protected credentials are used.
- **Deliverables:** `main` ruleset export, protected-environment policy,
  security-product status, staging/production resource inventory, route and
  origin map, exact account/D1/R2/Workflow binding map, Access policy summary,
  credential-origin matrix, least-privilege scope review, and backend
  names-only six-secret inventory.
- **Dependencies:** Phase 1 pass and the Phase 0 role assignments.
- **Accountable roles:** repository/CI administrator, Cloudflare operator, and
  security reviewer.
- **Suggested model/effort:** GPT-5.6-Sol, xhigh. This phase joins two remote
  authorization systems and must detect structurally valid but wrongly owned
  resources or credentials.
- **Local verification:** rerun `npm run test:workflow-pins`,
  `npm run test:security-governance`, `npm run test:release-operations`, and
  `npm run check:dry-run`; review the materialized, redacted summaries for
  exact-SHA checkout, one environment-wide concurrency group, account/D1 and
  origin binding, and raw-output suppression.
- **Protected verification/evidence:** retain access-controlled exports or
  screenshots showing branch deletion/force-push denial, required checks,
  reviewers and ref restrictions for every protected environment, security
  products, distinct staging/production resources, DNS/routes, D1/R2/Workflow
  ownership, Access policy, and token scope. Retain only required secret names
  and presence status in the committed summary—never values, map contents, or
  broad target diagnostics.
- **Binary exit criterion:** pass only when every remote control exists, is
  enabled for the exact candidate path, and every resource/credential is bound
  to its intended environment and least privilege. A missing export, ambiguous
  owner, extra secret name, or origin/scope mismatch is a failure.

### Phase 3 — Prove staging behavior, authorization, and idempotency

- **Objective:** deploy the exact candidate to isolated staging and prove the
  security-sensitive positive, negative, replay, and lifecycle paths.
- **Deliverables:** four changed deployment IDs with sole 100% version/commit
  bindings; admin, portal, protected-device, and order evidence; a controlled
  order crash/redrive result; the live native protected journey on each
  supported platform; and rollback target identity.
- **Dependencies:** Phases 1–2, pre-created synthetic fixtures, protected
  staging reviewers, and approved fault-injection isolation.
- **Accountable roles:** service maintainers and Cloudflare operator;
  security reviewer owns negative-path and residual-risk acceptance; database
  operator approves any fault injection.
- **Suggested model/effort:** GPT-5.6-Sol, xhigh. Use max only to design and
  review the crash-between-accept/apply injection and cleanup because a faulty
  experiment could corrupt shared state; routine execution remains xhigh.
- **Local verification:** run `npm run test:services`, `npm run test:e2e`, and
  `npm run test:release-operations`; verify protected-config, staging-order,
  admin, portal, and rollback contract tests remain included and
  green.
- **Protected verification/evidence:** run `.github/workflows/deploy-staging.yml`
  from the exact SHA. Require the PRD-03 admin denials; the portal drill's
  protected enrollment, consent, exchange, renewal, and retirement journey;
  order apply, exact replay denial, fresh-signature cached result, terminal
  linked-order conflict, and controlled crash redrive. For the portal,
  separately require an expired unused OTP denial, denial of a previously
  authenticated cookie after the server-side session TTL, real email receipt,
  and two-fixture cross-tenant denial. Run the live native TPM/browser/backend
  journey on each supported platform. Retain status/code and fixture-class
  labels, never credentials, fixture IDs, OTPs, keys, cookies, leases, or
  payloads.
- **Binary exit criterion:** pass only when every deployed identity and listed
  positive/negative path has the exact expected result, the live native
  journey passes on every supported platform, the scratch fault is cleaned up,
  and rollback is timed. Any partial staging artifact—including cached retry
  without crash redrive—is a failure.

### Phase 4 — Prove backup, migration recovery, and rollback

- **Objective:** demonstrate that the retained release backup can recover into
  strict scratch, prove it carries the exact current baseline, and support the
  declared RPO/RTO and rollback decisions without touching production data.
- **Deliverables:** immediate pre-migration backup manifest and SQL identity,
  streamed/downloaded integrity agreement, snapshot-pinned table inventory,
  historical schema identity, exact baseline migration history, complete
  current schema result, semantic checks, timed RPO/RTO, Worker rollback, and
  backup-authenticity disposition.
- **Dependencies:** Phase 3 staging identity; the reviewed baseline; a unique
  operator-created empty scratch D1; approved R2 retention and access controls.
- **Accountable roles:** database/recovery operator, Cloudflare operator,
  security reviewer, and release coordinator.
- **Suggested model/effort:** GPT-5.6-Sol, max. Restore, migration, and rollback
  verification cross destructive boundaries where false success and wrong
  targets have the highest launch impact.
- **Local verification:** run `npm test --workspace
  @licensecc/cloudflare-d1-backup`, `npm run lint --workspace
  @licensecc/cloudflare-d1-backup`, `npm run typecheck --workspace
  @licensecc/cloudflare-d1-backup`, `npm run scan:secrets --workspace
  @licensecc/cloudflare-d1-backup`, and `npm run test:worker-rollback`.
- **Protected verification/evidence:** select the immediate pre-migration
  object through `.github/workflows/recovery-drill.yml`, require strict empty
  scratch, exact manifest-pinned set/counts, a migration history equal to the
  baseline, final table/index/trigger digest, semantic checks, and measured
  snapshot-time RPO/RTO. Current live-source counts are informational
  only. Run `.github/workflows/rollback-workers.yml` for the approved target and
  retain before/after identities and health results.
- **Binary exit criterion:** pass only when recovery and rollback meet every
  identity, integrity, semantic, RPO, and RTO assertion. Backup authenticity
  passes the governance boundary only if it is cryptographically proven or the
  security reviewer accepts `authenticity_verified: false` as a lower-severity
  residual with owner, rationale, deadline, R2 write isolation,
  version-retention, and access-review evidence. Missing disposition or any
  scratch/source ambiguity is a failure.

### Phase 5 — Prove protected objectives, telemetry, and alert operations

- **Objective:** show the protected exchange and renewal objectives on the
  unchanged approved deployment and prove that operators receive, acknowledge,
  and clear the documented failure predicates without leaking sensitive data.
- **Deliverables:** exchange/renewal availability, latency, and error evidence;
  the `BOUND_GLOBAL_RATE_LIMIT` and WAF disposition against the declared `P`;
  dashboards for every required signal; predicate/route drills for every
  alert; receiver acknowledgements; and a sensitive-log review. Burst and soak
  artifacts need a protected capacity harness, which does not exist yet; record
  them as `blocked`.
- **Dependencies:** Phases 3–4; declared `P`; stable approved backend
  deployment/version plus its protected staging artifact and candidate commit;
  dashboards, receivers, and on-call schedule.
- **Accountable roles:** observability/on-call operator and service
  maintainers; release coordinator confirms the deployment join.
- **Suggested model/effort:** GPT-5.6-Sol, high for planned execution and
  evidence synthesis; raise to xhigh only for diagnosis of an unexplained
  latency, resource-growth, error-class, or telemetry discrepancy.
- **Local verification:** rerun the backend telemetry and rate-limit tests
  through `npm run test:backend` and review
  [`observability.md`](observability.md) thresholds against the declared `P`.
- **Protected verification/evidence:** retain the exact deployment ID, sole
  version UUID, commit, latency percentiles, availability, error classes, and
  rate-limit counts for the two protected routes. Exercise elevated errors,
  stale backup, configuration inconsistency, downstream-delivery failure,
  protected-route rate limiting, and protected-device cleanup; retain trigger,
  notification, acknowledgement, and clear times plus the redacted log-review
  result.
- **Binary exit criterion:** pass only when the protected routes meet every
  measured objective, the target stays unchanged, every alert reaches and is
  acknowledged by the expected receiver, and sensitive-log review has zero
  unexplained match. A missing dashboard or unrouted predicate is a failure,
  and burst/soak evidence stays a blocker until a protected capacity harness
  exists and passes.

### Phase 6 — Reproduce, publish, re-download, and deploy the candidate

- **Objective:** prove that the reviewed bytes are the bytes available to users
  and the bytes deployed to the protected production topology.
- **Deliverables:** double deterministic assembly, manifest/checksum/SBOM
  closure, protected registry and GitHub publication identities, re-downloaded
  install/smoke results, four production deployment identities, post-deploy
  read-only health evidence, and a retained rollback target.
- **Dependencies:** Phases 1–5 and human approval in every publishing and
  production environment.
- **Accountable roles:** artifact publisher, release coordinator, Cloudflare
  operator, service maintainers, and repository/CI administrator.
- **Suggested model/effort:** GPT-5.6-Sol, xhigh. Publication joins multiple
  registries, checksums, manifests, and production identities, so substitution
  or partial-success analysis needs deep cross-artifact reasoning.
- **Local verification:** run `npm run check:versions`,
  `npm run test:release-artifacts`, `npm run test:release-operations`, and
  `npm run check:dry-run`; verify the two assembled trees compare byte-for-byte
  and their manifests close over only the documented members.
- **Protected verification/evidence:** run the exact-SHA release-artifact,
  platform-publication, and production-deployment workflows under their
  protected environments. Re-download every published package/release payload,
  recompute checksums, install in fresh smoke environments, and bind each
  production Worker deployment ID/sole version/commit to the candidate.
- **Binary exit criterion:** pass only when every intended artifact is
  published exactly once, re-downloaded bytes match, every smoke test passes,
  all four Workers have one approved 100% active version, and rollback identity
  is retained. Any partial registry success, checksum drift, mutable tag, or
  deployment mismatch is a failure.

### Phase 7 — Observe the pilot and decide promotion

- **Objective:** validate real production behavior over time and make an
  explicit evidence-based stable-promotion decision.
- **Deliverables:** continuous objective/dashboards review, incident and change
  ledger, backup freshness, release-target stability, daily redacted summary,
  completed seven-day window or required fourteen-day extension, final risk
  register, and signed human go/no-go record.
- **Dependencies:** Phase 6 pass, staffed on-call coverage, working rollback and
  recovery procedures, and the Phase 0 evidence archive.
- **Accountable roles:** observability/on-call operator for monitoring; service
  maintainers for diagnosis; release coordinator and security reviewer for the
  final decision.
- **Suggested model/effort:** GPT-5.6-Sol, high for anomaly or incident
  analysis and the final cross-gate decision; GPT-5.6-Terra, medium for
  repeated monitoring normalization and checklist comparison. A model never
  makes the approval decision.
- **Local verification:** validate each daily summary against the PRD objective
  definitions and evidence schema; rerun only the deterministic check needed
  to investigate a finding, without replacing production evidence.
- **Protected verification/evidence:** retain immutable dashboard/query and
  incident/change references for at least seven complete days. Restart or
  extend observation to fourteen days after rollback, objective breach, or a
  material incident; verify daily backup freshness, target identity, error and
  latency objectives, alert operation, and absence of cross-tenant/data-safety
  events.
- **Binary exit criterion:** pass only after the uninterrupted required window,
  every gate remains green, every incident/finding has a disposition, the
  protected evidence archive is complete, and the named humans record `go`.
  Otherwise the result is `no-go`; elapsed time alone never passes the phase.

## Evidence format

Production-readiness evidence uses two tiers. A redacted attestation summary is
committed under `docs/implementation/`, never under a protected execution plan.
It records:

- gate identifier and exact commit SHA;
- UTC timestamp and operating environment;
- command or protected workflow name plus immutable run URL;
- tool/runtime versions and declared `P` values where applicable;
- result, relevant measurements, and artifact/checksum identifiers;
- accountable role and disposition of every failure or retry; and
- explicit `not run` or `blocked` status when evidence is absent;
- protected raw-artifact object/run identifiers, SHA-256 digests, archive
  location class, and retention-until date, but not their sensitive contents.

Detailed workflow artifacts, provider exports, logs, screenshots, and drill
JSON remain outside source control in an access-controlled evidence store.
The repository workflows currently retain their redacted artifacts for 30
days; before that window expires, the release coordinator copies the required
bundle to an approved restricted archive, verifies its digest against the
committed summary, and retains it for at least 12 months after the final
go/no-go decision or longer when incident/audit policy requires. A 30-day
workflow artifact alone is not sufficient release retention.

Do not copy secret values, complete deployment configuration, customer data,
private runbook credentials, or raw production payloads into evidence.

## Automatic no-go conditions

The release remains a no-go when any required check is red or skipped, a
protected environment is missing, a Worker lacks post-deploy validation,
backup restoration or rollback has not been demonstrated, an objective is
undefined or missed, a high-impact security finding is untriaged, artifacts
cannot be reproduced, or the pilot observation window is incomplete. Repository
implementation alone cannot clear this condition: absent remote branch and
environment controls, unexercised alert routes, a missing protected capacity
harness or burst/soak run, a missing live TPM/browser/backend journey, missing
rollback or recovery runs, unpublished/unverified registry artifacts, and an
unfinished pilot are all explicit no-go blockers. An unsigned backup is not an
automatic blocker after the specific lower-severity residual has been accepted
under PRD-04; lack of that recorded disposition is a blocker.
