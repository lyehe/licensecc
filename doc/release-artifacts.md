# Release artifact staging

`scripts/assemble-release-artifacts.mjs` is a local release-candidate evidence
tool. It never tags, publishes, uploads, deploys a Worker, or reads a real
Wrangler configuration. Its only Worker operation is the lockfile-pinned local
Wrangler `deploy --dry-run` bundle command against each tracked example config.

The command materializes regular files from the exact Git `HEAD` tree into an
owned temporary source tree before it builds anything. It runs a locked npm
install there with a sanitized environment, then builds the admin and portal
UI assets and all four Worker bundles from that tree. Python and .NET packaging
also use the canonical tree; a mutable checkout, ignored `.dev.vars`, local
Wrangler configuration, local database, or existing build output is not an
input. The dependency-free Java SDK is compiled from the same canonical tree.

The output must be new and either outside the checkout or below
`build/release-artifacts/`. The command checks lexical and real paths before
and after creation, rejects symlink/junction aliases, and only removes staging
that carries its own verified ownership marker.

Versions come from the same hardened readers used by
`scripts/check-version-contract.mjs`: tracked `version.json` is the sole
platform authority, the Python PEP 440 form is derived and checked, and the
CMake `project(licensecc VERSION ...)` remains the independent C++ authority.
The separately tracked `release-toolchains.json` pins Python **3.12.8**, uv
**0.12.5**, the .NET SDK **8.0.423**, and Temurin/OpenJDK **17.0.20+8**
(compiler version **17.0.20**); `global.json` repeats the exact .NET
SDK with roll-forward disabled. These are build-tool authorities, not package
version authorities. The assembler checks all four executable version outputs
before any dependency install, and both release workflows use the same exact
setup-action values.
Before any install or build command, the canonical tree also runs the complete
repository version contract over every tracked projection (workspace and lock
inventory, OpenAPI and snapshots, SDK runtime metadata, maintained prose, the
capability registry, and C++ projections). Optional expected values only
assert those authorities:

```powershell
node scripts/assemble-release-artifacts.mjs `
  --output build/release-artifacts/acme-0.1.0-rc.2 `
  --repeat-output build/release-artifacts/acme-0.1.0-rc.2-repeat `
  --consumer-id acme `
  --expect-platform-version 0.1.0-rc.2 `
  --expect-python-version 0.1.0rc2
```

The output contains exactly four parsed Worker bundle directories, the Python
wheel and sdist, the primary NuGet package and matching `snupkg` symbol
package, the deterministic `licensecc-client-0.1.0-rc.2.jar`, and one
consumer-ID-labelled C++ source archive. `dotnet` is required by default;
`--allow-partial` is the explicit exception and records a boolean `incomplete`
field while omitting all NuGet payloads. The manifest records platform, Python,
Java, C++, consumer, and exact HEAD identities plus the C++ archive hash. The
inspector recomputes the exact payload records, checksums, manifest, and SPDX
2.3 object, including the vendored generator BSD license and provenance. It
requires nonempty `index.html` plus built UI assets before the two UI-backed
Workers are bundled, and lexically checks nonempty Worker module entrypoints
without treating comment or string decoys as handlers. It parses ZIP/tar
internals: wheel/sdist member closure is derived from canonical HEAD and their
tracked member bytes are compared; wheel `RECORD` must cover every member with
the correct SHA-256 and size; generated metadata is parsed as RFC 822 headers.
Primary NuGet and `snupkg` archives have exact allowed member closure and a
valid OPC `[Content_Types].xml`/relationship/core-properties structure; their
`.nuspec` identities are XML-parsed, not regex-matched, and the managed DLL
and portable PDB require PE/`BSJB` signatures. The secret/forbidden-member
policy applies inside every package archive. A matching filename alone is
never sufficient.

The Java artifact contains only Java 17 class files derived from tracked
`sdks/java/src/main/java` sources, the exact tracked manifest, and the root
license. Its ZIP order, compression, timestamp, manifest, class-file magic and
major version, and top-level source closure are inspected before metadata is
accepted.

The Python PEP 517 backend is pinned to Hatchling 1.27.0 in `pyproject.toml`.
The assembler first checks the canonical `uv.lock`, then invokes `uv build`
with the tracked hash-constrained `sdks/python/build-constraints.txt` and
`--require-hashes`. NuGet packaging
sets `SymbolPackageFormat=snupkg` both in the SDK project and the pack command.
Its locked restore targets only
`sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj` and its tracked
`packages.lock.json`, using a generated canonical-only NuGet configuration,
package caches, and disabled persistent build servers so host-level NuGet
settings do not influence the staged payload.

The assembler derives `SOURCE_DATE_EPOCH` from the exact Git commit timestamp
and sets UTC, deterministic Python, and .NET reproducibility inputs in its
sanitized build environment. It makes .NET source paths stable, omits
Wrangler's timestamped README, makes Worker source-map roots bundle-relative,
and rewrites only NuGet's generated relationship/container metadata with
ordinal entry order and Git-timestamped ZIP headers. Runtime Worker JavaScript,
managed DLLs/PDBs, and all package metadata are parsed and validated before
and after that normalization. Passing `--repeat-output` performs two
independent canonical assemblies and fails unless every payload and metadata
byte matches.

The C++ archive is built from ordinal-sorted canonical Git blobs only. It
contains the curated runtime CMake/include/source inputs and the vendored
generator's CMake/source/license/provenance closure, never CI install binaries,
tests, generated keys, private keys, or generic consumer keys. A consumer
generates and retains any signing keys during its own build or deployment; no
key is accepted or packaged here.

Before metadata succeeds, the assembler parses and safely extracts its own
archive into an owned temporary directory, configures and builds the embedded
`lccgen`, then configures the extracted root with the documented
`-DLCC_LOCATION=<built lccgen>` selector and builds `licensecc_static` with
`BUILD_TESTING=OFF`. It supplies an install prefix only inside that temporary
directory and never invokes `cmake --install`.

Run the deterministic coverage locally with:

```powershell
npm run test:release-artifacts
```

The manual **Release artifact dry-run** workflow performs the same assembly
and inspection twice in runner-local temporary staging. Pull requests run the
same real toolchain-backed double assembly (including the no-install CMake
archive verifier), rather than relying only on mocked unit tests. Those two
evidence workflows have no upload, tag, publish, or deployment step.

## Protected platform publication

Pushing the exact tag `platform-v<version.json platform_version>` starts
`.github/workflows/platform-release.yml`. The workflow rejects every other tag,
runs the complete platform/SDK/dry-run gates, performs one canonical double
assembly, and uploads that one inspected result between jobs. It then:

1. publishes the Python wheel and sdist through the protected `pypi`
   environment and PyPI trusted publishing;
2. publishes the primary NuGet package through the protected `nuget`
   environment and NuGet trusted publishing; and
3. creates a GitHub release through the protected `github-release` environment
   only after both registry jobs succeed. The GitHub release includes the
   Python, .NET, Java, and C++ payloads plus checksums, the release manifest,
   and SPDX document.

Repository administrators must configure environment reviewers and the two
trusted-publisher identities before creating a tag. The `nuget` environment
also supplies the non-secret `NUGET_USER` variable. No long-lived PyPI or NuGet
API key is stored in the repository. A failed or unconfigured publisher stops
the release; it does not silently downgrade to a partial publication.

## Protected production deployment

`.github/workflows/deploy-production.yml` is a manual four-Worker
rollout. It runs only when the operator types the exact confirmation
`deploy-production` and the protected `production` environment authorizes the
job from `main`. Checkout is pinned to the workflow's exact `github.sha` and is
checked again before protected material is read. Its
`licensecc-production-operations` concurrency group serializes deployment with
production rollback. The environment must provide `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and four base64-encoded complete production Wrangler
config secrets named `LICENSECC_<BACKEND|ADMIN|PORTAL|BACKUP>_WRANGLER_CONFIG_B64`.
Those configs remain ignored and runner-local; the materializer rejects
development modes, placeholder domains, unsafe bindings, embedded Worker
application secrets, split D1 identities, mismatched routes/origins, incomplete
Access or asset configuration, disabled invocation logs, and incomplete backup
wiring. It binds every D1 binding, every present top-level Worker account ID,
the backup export account, and each credential-bearing drill URL to the exact
protected account, D1 ID, and validated Worker route. The environment also
supplies `BACKUP_TRIGGER_TOKEN`, a short-lived
`LICENSECC_ADMIN_ACCESS_JWT`, an authenticated
`LICENSECC_PORTAL_SESSION_COOKIE`, and the non-secret
`LICENSECC_D1_DATABASE_ID` environment variable.

The deployment reruns `check:pr` and the credential-free dry-runs, builds both
UIs, validates the four protected configs, and runs a bounded, names-only
backend secret inventory. Protected Wrangler dry-run, deploy, migration, and
deployment-list operations pass through a fixed-operation wrapper that captures
and suppresses raw Wrangler output; retained output contains only bounded,
redacted status or deployment identity fields. The workflow captures current
Worker deployment identities plus configuration hashes, deploys and validates
the backup Worker first, then starts a backup and waits for an exact completed
Workflow result with the expected D1 identity, snapshot timestamp, and
SQL/manifest object pair.
Only after that gate succeeds does it apply backend-owned D1 migrations and
deploy backend → admin → portal with the lockfile-pinned Wrangler. The final
gate checks the public verifier, an authenticated read-only admin UI/API path,
an authenticated read-only customer portal UI/API path, and backup health,
secrets, and Workflow registration. A bounded post-deploy poll requires a new
deployment ID and a new sole version receiving 100% of traffic for every
Worker. Before/after deployment identities are retained as redacted workflow
artifacts for 30 days without uploading the protected configs or raw Wrangler
output. Required release evidence must be digest-bound into the restricted
long-term archive defined by the production-readiness contract before that
workflow window expires.

The workflow never provisions account resources or secrets. Those Cloudflare
objects, least-privilege token scopes, DNS/routes, short-lived validation
identities, and protected environment approval policy remain explicit operator
responsibilities.

## Protected staging deployment

`.github/workflows/deploy-staging.yml` is the isolated rehearsal for the same
four deployables. It requires exact `deploy-staging` confirmation and approval
through the protected `staging` environment, runs only from `main`, and checks
out and verifies the exact workflow SHA. Environment-scoped secrets use the
same names as production but must identify distinct Worker names, routes, D1
database, R2 bucket, Workflow, Access application, tokens, and signing key
rings. The structural materializer enforces the `staging` profile, exact
protected Cloudflare account and D1 identity, and credential-bearing route
origins; it rejects a route without a `staging` hostname label or a production
resource identity. Staging uses the same redacted Wrangler wrapper and bounded
post-deploy transition check as production.

The staging order is backup → completed pre-migration backup → D1 migrations →
backend → admin → portal. Before deployment, a bounded backend check validates
the protected selector posture and the presence of required Worker secret names
without reading or emitting secret values. Post-deploy checks deliberately
exercise the public client-network rate limiter with rotating fingerprints; real
unauthenticated, malformed-token, non-admin mutation-denial, and authenticated
admin paths; and a synthetic customer portal login, read, floating-seat
checkout/heartbeat/release, signed download, and logout. A newly issued staging
portal session must carry `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and a
positive `Max-Age`; the drill also proves unauthenticated and post-logout reads
are denied. Denial of an expired unused OTP, denial of a previously
authenticated cookie after the server-side session TTL, transactional email
delivery, and a two-fixture cross-tenant denial remain external staging
evidence. Cookie attributes and logout do not prove either expiry boundary.

Staging also sends one bounded, correctly signed synthetic order and requires
`200 applied`, then resends the byte/header-identical signed request and
requires `401 replayed`. It finally signs the identical logical body afresh with
the next authenticated timestamp and requires the durable cached `200 applied`
result. That proves exact signed-attempt replay rejection and deployed
same-event cached application idempotency. It does **not** inject a crash
between durable accept and apply. Controlled crash redrive therefore remains
explicitly blocked external evidence, and the order artifact remains partial
and non-promotable despite the cached-retry pass.

Backend contract tests separately require that, once the durable order row has
non-null customer/license links, contradictory explicit values for the same
subscription/project/feature return terminal `400 invalid_order`, including on
replay; omission carries the existing values forward. The protected staging
sequence above does not exercise that conflict path and must not be cited as
its deployed proof.

The required workflow inputs identify only pre-created synthetic staging
fixtures. They must never name a production tenant or entitlement. A shared
`licensecc-staging-operations` concurrency group serializes deployment,
rollback, capacity, and recovery work. As in production, before/after Worker
deployment identities and bounded drill results are retained as a redacted
30-day workflow artifact, then digest-bound into the restricted long-term
archive before expiry when they support a release decision.

The standard portal-compatible topology deliberately requires
`DEVICE_PROOF_MODE=off` for lease and seat issuance. Missing proof is accepted,
while any presented proof is still verified. The portal never receives or
signs with a device private key. Moving this global selector to `required`
remains blocked on a reviewed client/browser device-key registration and
signing workflow; the compatibility posture is a recorded residual risk, not a
claim of device possession.

To exercise the direct protected path without misrepresenting the portal, a
separate staging lease drill targets the exact materializer-bound backend URL.
Protected values supply a dedicated active entitlement, an account token for
that authorized fixture tuple,
registered P-256 device key, expected lease key ID, and canonical PKCS#1 DER
RSA public key. Before traffic the drill requires a canonical 2048–4096-bit
key and `sha256(DER) == expected_lease_key_id`. Fresh, separately signed
`/v1/activate` and `/v1/renew` requests must each return the exact fixture
feature's v201 section. The drill reconstructs the canonical signed fields and
RSA-SHA256 verifies both signatures with that protected expected public key. It
also validates bounded request/server skew, ordered renew/valid-to times, the
server UTC date inside the signed interval, and signed/envelope valid-to
agreement. The drill emits none of the token, private key, public-key bytes,
fixture, lease, customer, license, or fingerprint. Evidence proves only the
authorized fixture tuple, not a negative cross-scope least-privilege denial;
the protected server-side fixture is not a portal/browser key UX.

## Protected staging capacity evidence

`.github/workflows/capacity.yml` is the only repository-owned acceptance-load
entry point. It is manual, serialized through
`licensecc-staging-operations`, restricted to `main` and the protected
`staging` environment, checks out the exact workflow commit, and requires the
confirmation `run-staging-capacity`. The operator selects only `burst` or
`soak`, supplies the declared peak rate `P` and maximum concurrency, and cannot
shorten the 30-minute `2P` burst or four-hour `P` soak. Rehearsal mode is
intentionally not available in the protected workflow.

The operator must also supply the exact backend deployment ID, sole active
version UUID, and an attestation that the commit recorded in the matching
staging deployment artifact equals `github.sha`. Before any load credential is
used, the workflow materializes all four staging configs and binds the
Cloudflare account, D1 ID, and capacity URL origin to the validated backend
route. It then requires that approved backend deployment/version to be the sole
100% target both before and after the run. A changed or mismatched target fails
the evidence. The attested SHA is recorded as operator-supplied provenance;
Cloudflare's deployment listing does not independently bind that version to a
source commit.

Staging variables identify the verifier URL, project, and feature. Protected
secrets supply the synthetic fingerprint, optional device hash, and registered
request-proof key. The public `/v1/verify` route does not use an account token,
so the capacity workflow neither requests nor sends one and makes no
account-token readiness claim. The workflow validates inputs without printing
them, runs the harness tests, executes the bounded load, normalizes a redacted
JSON attestation, uploads it even when the harness fails, and then fails closed
unless the acceptance verdict is `pass`. This artifact is only the capacity
portion of PRD-05; the dashboard, alert, and sensitive-log review in
[`doc/operations/observability.md`](operations/observability.md) remain
required for the same UTC window.

## Protected recovery drill

`.github/workflows/recovery-drill.yml` is manual, serialized, and restricted to
`main` and the protected `staging` environment. It checks out the exact
workflow SHA and shares the `licensecc-staging-operations` group. Exact
`restore-staging-scratch` confirmation is required. Protected configuration is
bound to the expected Cloudflare account and D1 ID. The drill accepts only an
SQL object below the staging backup prefix and a unique empty D1 database whose name begins
`licensecc-restore-drill-`; production and staging source database names are
explicitly rejected as restore targets.

The drill materializes staging config, validates the export's adjacent bounded
manifest against the protected staging D1 ID/name and one-hour maximum age.
Backup production computes SHA-256 and byte size in the same backpressured
stream uploaded to R2 and derives a names-and-counts-only durable-table
inventory from those exact SQL bytes. It records returned R2 size, checksum
when available, ETag, version, and upload time. The pre-migration run-and-wait
gate rejects a completed backup without this bounded inventory. Recovery
downloads the selected object with bounded output, recomputes its SHA-256 and
size before import, and fails on a mismatch. Freshness and RPO are measured
from `snapshot_requested_at`, captured before D1 export, rather than the later
upload time.

The import uses the restore tool's explicit `--confirm-scratch` guard and
rejects any pre-existing non-system scratch table, including an empty unrelated
table. Immediately after import it requires the historical durable-table set
and counts to equal the snapshot-pinned manifest inventory. It records the
historical schema digest, requires `d1_migrations` to be an exact prefix of the
checked-out backend migration sequence, applies the missing suffix to scratch,
and requires the final history and complete table/named-index/trigger digest to
match the current canonical schema. Current staging source counts are retained
as informational only because post-snapshot writes are expected. Restored
active/revoked verifier semantics remain blocking. Evidence records the exact
commit, manifest identity, snapshot/upload timestamps, backup age, streamed
integrity, pre/post-migration schema identity, result, and elapsed time, and
fails if the one-hour RPO or four-hour RTO is not met. The SQL and adjacent
manifest share one R2 write trust boundary and the manifest is unsigned, so
this detects corruption but does not prove authenticity; evidence reports
`authenticity_verified: false`. The release can carry that condition only as a
security-reviewer-accepted lower-severity residual with an owner, rationale,
deadline, and compensating R2 write-isolation, version-retention, and
access-review evidence; without that disposition recovery remains blocked.
The workflow has no D1 create/delete, Time Travel restore, production config,
or `--allow-nonempty-scratch` path; scratch database lifecycle remains a
deliberate operator task.

## Protected Worker rollback

`.github/workflows/rollback-workers.yml` is the only repository-owned Worker
rollback entry point. It is a manual workflow serialized with every other
repository-owned operation in the selected protected `staging` or `production`
environment. It runs only from `main`, checks out and verifies the exact
workflow SHA, and uses `licensecc-staging-operations` or
`licensecc-production-operations` according to the selected environment. The operator must select one
of those environments, type its exact `rollback-staging` or
`rollback-production` confirmation, name a comma-separated subset of
`backend,admin,portal,backup`, provide one explicit Cloudflare Worker version
ID for every selected Worker, and give a printable reason of at most 120
characters. The operator also supplies the four canonical HTTPS service
origins used for the post-rollback checks. A version for an unselected or
unknown Worker is rejected; the tool never infers a target from the latest or
previous deployment and rejects a target that is already receiving 100% of
traffic.

Each protected environment supplies `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and the same four environment-scoped
`LICENSECC_<BACKEND|ADMIN|PORTAL|BACKUP>_WRANGLER_CONFIG_B64` secrets used by
deployment. The workflow materializes and validates all four configs with the
selected profile and binds their Cloudflare account and D1 identity to the
protected expected values even when only one Worker is selected. Each supplied
service origin is required to be the exact route origin proven by that
materialized configuration; credentials, ports, paths, queries, fragments,
placeholder hosts, and cross-service origin reuse fail closed. The rollback
tool accepts no config-path argument: it requires the four exact runner-local
paths to be nonempty regular files, rejects aliases, and invokes only the
lockfile-pinned Wrangler.

Before the first mutation, every selected target is checked with `wrangler
versions view <id> --json --config <owned-path>` and every current deployment
identity is captured with `wrangler deployments list --json`. Malformed JSON,
a mismatched ID, an unavailable target, a missing config, or any command
failure during these prechecks stops the operation before rollback begins.
Once all targets pass, the tool unwinds the normal rollout order (backup →
portal → admin → backend) and runs `wrangler rollback <id> --yes --message
<reason> --config <owned-path>`. It then requires the target to appear as the
sole version receiving 100% of traffic before continuing to the next Worker.
A mutation or postcheck failure stops every remaining Worker and records the
completed identities plus the failing Worker's pre-state.

After every selected deployment reaches its target, a separate fail-closed
postcheck probes all four services, not only the selected subset. It performs
bounded, timed, redirect-disabled `GET` requests only: backend readiness must
prove required account isolation; the Access-authenticated admin summary must
be readable; portal readiness must prove the backend's required account-token
mode; and backup readiness must return `backup_ready`. Backend, admin, and
portal must also serve a nonempty OpenAPI 3.1 contract. The protected
`LICENSECC_ADMIN_ACCESS_JWT` is sent only to the admin origin and is never
written to evidence. A failed status, malformed or oversized body, redirect,
contract mismatch, missing credential, or unavailable service fails the job.

The job retains a redacted JSON evidence directory for 30 days. When the run
supports a release decision, its digest, protected archive object identifier,
and retention date are recorded in the committed summary and the artifact is
copied to the restricted long-term archive before expiry. `rollback.json`
contains the environment, selected logical Worker names, requested version
IDs, pre/post deployment IDs and traffic identities, timestamps, and elapsed
milliseconds. On a successful rollback,
`post-rollback-health.json` adds the exact workflow commit, redacted canonical
origin bindings, safe response status/code/size/digest facts, and OpenAPI path
counts. Neither response bodies nor raw origins are retained. Both files use
the explicit `storage_action: "none"` marker because the rollback changes
Worker deployments while every health probe is GET-only and neither path
authorizes a D1, R2, KV, Durable Object, or Workflow-state action. The artifact
excludes the operator reason, Wrangler output, author identities, bindings,
configuration paths or content, tokens, cookies, raw URLs, and secrets.

A Worker rollback changes Worker code and versioned configuration only. It
never rolls back, migrates, exports, restores, or otherwise mutates D1, R2, KV,
Durable Object, or Workflow state. Before approving a target, the operator must
confirm that its code remains compatible with the current storage schemas and
bound resources. If data recovery is required, stop this workflow and use the
separately reviewed recovery procedure; a Worker rollback is not authorization
for a database restore.
