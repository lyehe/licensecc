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

- protected deployment, rollback, recovery, and capacity jobs run only from
  `main`, check out the exact workflow SHA, and share one operations concurrency
  group per environment;
- protected configuration is bound to the expected Cloudflare account, D1
  database, validated service origins, and credential-bearing target origins;
- Wrangler dry-run, deploy, migration, and deployment-list output is captured
  behind a fixed-operation redaction wrapper, and deployment evidence requires
  a bounded transition to a new sole 100% active version;
- backend secret inventory is names-only and bounded; staging admin and portal
  drills exercise real authorization denials; capacity evidence pins one
  approved backend deployment/version and records an operator-attested
  candidate commit; and backup/recovery evidence binds streamed content
  integrity, snapshot time, and complete schema identity.

Those controls describe repository behavior, not a completed promotion. They
do not prove remote branch/ruleset or protected-environment policy, Cloudflare
resource isolation or token scope, deployed secret contents, dashboard/alert
routing, a completed burst/soak, rollback/recovery execution, registry
publication, or the production pilot. Until immutable external evidence covers
those items for one exact commit, the candidate remains a no-go.

## Launch scope

The initial hosted production scope is:

- the licensing-backend, license-admin, customer-portal, and D1-backup
  Cloudflare Workers;
- Cloudflare D1 as the production database;
- the platform release artifacts and the Python, .NET, and Java SDKs described
  by the platform version contract; and
- the Windows and Linux native validation matrix documented by the release
  evidence.

PostgreSQL/Supabase remains a fenced partial adapter. A failing conformance
test must be fixed, but the adapter is not a production runtime target until it
passes every promotion requirement in
[`doc/analysis/db-backends.md`](../analysis/db-backends.md).

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

Before a staging load run, the release evidence must record the intended peak
request rate and concurrency for the candidate. Tests use that declared value
as `P`; an absent value fails the gate rather than silently selecting a smaller
load.

The initial acceptance targets are:

| Objective | Acceptance threshold |
| --- | --- |
| Public verification availability | At least 99.9% over the production-pilot observation window, excluding an agreed provider-wide outage recorded in the evidence |
| Public verification latency | p95 below 500 ms and p99 below 1 second at `P` |
| Unexpected server errors | Less than 0.1% of requests at `P`, with no unexplained error class |
| Burst capacity | `2P` for 30 minutes without an objective or data-integrity violation |
| Soak capacity | `P` for four hours without resource growth, stale backup, or integrity drift |
| Recovery point objective | No more than one hour of committed production data at risk |
| Recovery time objective | Service restored and validated within four hours |
| Data safety | Zero cross-tenant disclosure, duplicate fulfillment, lost audit transition, or nonce/idempotency reuse |

A release may adopt stricter targets. Relaxing a target requires a reviewed
documentation change and an explicit risk decision before the affected test;
the evidence report must never redefine a threshold after seeing the result.

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

- `main` requires the reviewed Linux, Windows, service, contract, release, and
  applicable PostgreSQL checks.
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

### PRD-03: staged four-Worker rollout

- Protected configuration materializes successfully and every Worker passes a
  Wrangler dry run through the bounded, raw-output-suppressing wrapper.
- D1 migrations are reviewed for deployment-order compatibility.
- Backend, admin, portal, and backup deploy in the documented order against
  isolated staging resources.
- Every deploy records a changed deployment ID and a new sole version receiving
  100% of traffic within the bounded post-deploy poll.
- A synthetic tenant completes the backend, operator, customer, and recovery
  paths without touching production data.
- The admin drill proves unauthenticated and malformed-token denial, real
  non-admin mutation denial, authenticated access, and its mutation/idempotency
  cycle. The portal drill proves unauthenticated read denial, secure attributes
  on a newly issued staging cookie, authenticated paths, logout, and
  post-logout denial. Denial of an expired unused OTP, denial of a previously
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
- A separate direct staging lease drill uses the protected account token for
  one authorized fixture tuple and a fresh registered P-256 proof for both
  activate and renew. Before traffic it validates a canonical PKCS#1 DER RSA
  public key (2048–4096 bits) whose SHA-256 is the expected lease key ID. It
  then parses the exact fixture feature's v201 section, reconstructs the
  canonical signed fields, and RSA-SHA256 verifies both returned signatures.
  It also requires bounded request/server skew, ordered renew/valid-to times,
  the server UTC date inside the signed interval, and agreement between the
  signed and envelope valid-to values. This proves only the authorized fixture
  tuple; negative cross-scope token denial remains separate evidence, and the
  protected server-side fixture is not a portal/browser key workflow.
- The last-known-good Worker version is restored in a timed rollback drill.

The standard portal-compatible topology keeps `DEVICE_PROOF_MODE=off` for
lease/seat issuance: missing proof is accepted, while any presented proof is
verified. The portal does not hold a device private key. Global required proof
is blocked until a reviewed client/browser registration and signing workflow
exists; release evidence must carry this residual-risk disposition.

### PRD-04: backup and recovery

- A backup completes and is verified immediately before a production schema
  migration.
- SHA-256 and byte size are computed in the same backpressured stream uploaded
  to R2; a names-and-counts-only durable-table inventory is derived from those
  same snapshot bytes; returned object size and any returned SHA-256 checksum
  are validated and retained without row values or raw Wrangler output.
- The retained backup is restored into a scratch D1 database.
- The scratch target has no pre-existing non-system table, including an
  unrelated empty table, before import.
- Before migration, the imported historical snapshot must have exactly the
  durable-table set and counts pinned in its manifest. Current live-source
  counts are informational only and cannot invalidate a valid historic
  snapshot after later writes.
- The imported `d1_migrations` history must be an exact prefix of the
  checked-out canonical backend migration sequence. Its historical schema
  digest is recorded, the missing suffix is applied to scratch, and the final
  history must be current.
- After migration, the complete table, named-index, and trigger inventory is
  compared to the canonical backend schema through a normalized digest/count
  contract, and service-level invariants are checked.
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

### PRD-05: capacity and observability

- The `2P` burst and `P` soak tests meet every objective above.
- Each run names the backend deployment ID and sole active version UUID from
  the matching staging rollout and records an operator-attested commit equal to
  the workflow SHA. The capacity URL is the validated backend route, and the
  same sole 100% deployment remains active before and after the run. Cloudflare
  deployment-list output does not independently prove source-commit provenance,
  so the staging deployment artifact and protected operator attestation remain
  part of the evidence boundary.
- The public verifier capacity route does not use an account token; capacity
  evidence therefore makes no account-token or lease-signing readiness claim.
- Alert paths are deliberately exercised for elevated errors, stale backup,
  configuration inconsistency, and failed downstream delivery.
- Logs are inspected for tokens, OTPs, signing material, license payloads, and
  customer data; sensitive values must not appear.

The exact dashboard, alert thresholds, drill sequence, and redacted evidence
requirements are defined in
[`doc/operations/observability.md`](observability.md).

### PRD-06: security assurance

- The maintained threat model covers public verification, admin Access,
  portal sessions and OTP, signed order ingestion, D1, R2, CI, registries, and
  signing/credential custody.
- Supported dependency, static-analysis, sanitizer, and fuzzing gates pass.
- Protected backend secret inventory confirms required names only. It does not
  inspect secret values, prove a selector exists inside a secret map, or prove
  key/credential correctness; runtime health, positive signed operations, and
  rotation evidence remain required.
- Credential rotation is demonstrated without printing or committing values.
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
  declared `P`, launch-scope and PostgreSQL-fence confirmation, named actor for
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
  contracts, PostgreSQL conformance, security, and release required-check URLs
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
  names-only nine-secret inventory.
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

### Phase 3 — Prove staged behavior, authorization, and idempotency

- **Objective:** deploy the exact candidate to isolated staging and prove the
  security-sensitive positive, negative, replay, and lifecycle paths.
- **Deliverables:** four changed deployment IDs with sole 100% version/commit
  bindings; admin, portal, order, and direct-lease evidence; a controlled order
  crash/redrive result; rollback target identity; and a disposition for the
  portal device-proof compatibility posture.
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
  staging-lease, admin, portal, and rollback contract tests remain included and
  green.
- **Protected verification/evidence:** run `.github/workflows/deploy-staging.yml`
  from the exact SHA. Require the PRD-03 admin denials; order apply, exact
  replay denial, fresh-signature cached result, terminal linked-order conflict,
  and controlled crash redrive; and canonical v201 lease activate/renew with
  RSA-SHA256 verification. In addition to the authorized lease tuple, use an
  explicitly project/feature/operation-scoped staging token against a
  pre-created synthetic tuple outside that scope and require `403
  forbidden_scope` with no mutation. For the portal, separately require an
  expired unused OTP denial, denial of a previously authenticated cookie after
  the server-side session TTL, real email receipt, and two-fixture cross-tenant
  denial. Retain status/code and fixture-class labels, never credentials,
  fixture IDs, OTPs, keys, cookies, or payloads.
- **Binary exit criterion:** pass only when every deployed identity and listed
  positive/negative path has the exact expected result, the scratch fault is
  cleaned up, rollback is timed, and `DEVICE_PROOF_MODE=off` is explicitly
  accepted with the documented browser-key UX limitation. Any partial staging
  artifact—including cached retry without crash redrive—is a failure.

### Phase 4 — Prove backup, migration recovery, and rollback

- **Objective:** demonstrate that the retained release backup can recover into
  strict scratch, upgrade from its historical schema, and support the declared
  RPO/RTO and rollback decisions without touching production data.
- **Deliverables:** immediate pre-migration backup manifest and SQL identity,
  streamed/downloaded integrity agreement, snapshot-pinned table inventory,
  historical schema/migration identity, applied canonical suffix, complete
  current schema result, semantic checks, timed RPO/RTO, Worker rollback, and
  backup-authenticity disposition.
- **Dependencies:** Phase 3 staging identity; reviewed migrations; a unique
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
  scratch, exact manifest-pinned pre-migration set/counts, canonical migration
  prefix and suffix, final table/index/trigger digest, semantic checks, and
  measured snapshot-time RPO/RTO. Current live-source counts are informational
  only. Run `.github/workflows/rollback-workers.yml` for the approved target and
  retain before/after identities and health results.
- **Binary exit criterion:** pass only when recovery and rollback meet every
  identity, integrity, semantic, RPO, and RTO assertion. Backup authenticity
  passes the governance boundary only if it is cryptographically proven or the
  security reviewer accepts `authenticity_verified: false` as a lower-severity
  residual with owner, rationale, deadline, R2 write isolation,
  version-retention, and access-review evidence. Missing disposition or any
  scratch/source ambiguity is a failure.

### Phase 5 — Prove capacity, telemetry, and alert operations

- **Objective:** demonstrate the declared envelope on the unchanged approved
  deployment and prove that operators receive, acknowledge, and clear the
  documented failure predicates without leaking sensitive data.
- **Deliverables:** accepted `2P` burst and `P` soak artifacts, target-stability
  evidence, dashboards for every required signal, four predicate/route drills,
  receiver acknowledgements, and a sensitive-log review.
- **Dependencies:** Phases 3–4; declared `P`; stable approved backend
  deployment/version plus its protected staging artifact and operator-attested
  candidate commit; dashboards, receivers, and on-call schedule.
- **Accountable roles:** observability/on-call operator and service
  maintainers; release coordinator confirms the deployment join.
- **Suggested model/effort:** GPT-5.6-Sol, high for planned execution and
  evidence synthesis; raise to xhigh only for diagnosis of an unexplained
  latency, resource-growth, error-class, or telemetry discrepancy.
- **Local verification:** rerun the capacity-harness and telemetry contract
  tests through `npm run test:backend` and review
  [`observability.md`](observability.md) thresholds against the declared `P`.
- **Protected verification/evidence:** run `.github/workflows/capacity.yml` in
  both immutable profiles. Retain the exact deployment ID, sole version UUID,
  operator-attested commit, matching staging deployment artifact, before/after
  target, offered/achieved rate, latency percentiles, availability, error
  classes, and resource trend. Exercise elevated errors,
  stale backup, configuration inconsistency, and downstream-delivery failure;
  retain trigger, notification, acknowledgement, and clear times plus the
  redacted log-review result. Capacity uses no account token and cannot satisfy
  the Phase 3 token-scope drill.
- **Binary exit criterion:** pass only when both full-duration profiles meet
  every objective, the target stays unchanged, all four alerts reach and are
  acknowledged by the expected receiver, and sensitive-log review has zero
  unexplained match. A shortened run, missing dashboard, or unrouted predicate
  is a failure.

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
environment controls, unexercised alert routes, missing protected burst/soak,
rollback, or recovery runs, unpublished/unverified registry artifacts, and an
unfinished pilot are all explicit no-go blockers. An unsigned backup is not an
automatic blocker after the specific lower-severity residual has been accepted
under PRD-04; lack of that recorded disposition is a blocker.
