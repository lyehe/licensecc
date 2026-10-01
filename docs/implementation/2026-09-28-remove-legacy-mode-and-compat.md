# Protected-only licensing and backward-compatibility removal: evidence

This report records the evidence for the branch `fix/remove-legacy-and-compat`,
which removes the legacy enforcement mode and every backward-compatibility shim,
alias and compatibility-only document from the repository. For each change it
states what the change did, the commits and commands that verify it, and the
surfaces that were not run and why. It then gives the final schema, the
consequences an owner or operator sees, the whole-repository sweep, the final
gate, the whole-branch review and its fixes, and the open follow-ups.

## Scope and verified refs

- Base: local `main` at `3bd3f721`.
- Plan: `docs/superpowers/plans/2026-09-28-remove-legacy-mode-and-compat.md`,
  committed as `1e0f4305` and revised after its review as `40d9ffeb`.
- Branch: `fix/remove-legacy-and-compat`. This report was added in
  `b4084073` and completed after the whole-branch review; every commit named
  below is an ancestor of the branch head.
- Owner decisions the branch implements:
  - protected device-bound licensing (`device_bound_v1`) is the only online
    mode, and the owner accepted the capability losses listed below;
  - offline `.lic` licensing in the C++ library stays, with v201 as the only
    format, and `lcccfg1` configuration tokens stay;
  - there is no live D1 data, so the migrations collapse into one baseline that
    is edited in place, and every D1 database is recreated;
  - security rollout modes are always `required`;
  - all PostgreSQL support is deleted;
  - pure compatibility shims are removed.

Most changes ran one after another on the branch. Four ran in separate
worktrees and were rebased onto the branch at quiet points: the
health-readiness change and the tooling-alias change (integrated as
`37b464ac`..`656f2cd3`), and the order-nonce and portal-session change and the
webhook-scope change (integrated as `d5a59069`..`5989b065`). Each integration
regenerated the derived values that conflicted (the
`doc/architecture/system-map.md` totals and the restore-drill schema
signature) and re-ran the gates before the branch was fast-forwarded.

Until the change that deleted the staging lease drill, `npm run check:pr`
stopped on this Node 24 host at seven known failures in
`services/cloudflare-licensing-backend/test/staging-lease-drill.test.mjs` (CI
uses Node 22). Below this is called "the known stop". Every step before it
passed, and the steps after it (`test:sql`, `test:admin`, `test:portal`,
`test:backup`, `check:schema-parity`) were run one by one. From that change
onward `npm run check:pr` exits 0 with no tolerated failure.

Two host limits recur below. The repository `global.json` pins .NET SDK
8.0.423 with roll-forward disabled, and the host has 8.0.425. The .NET leg
therefore ran from a scratch copy of the tracked `sdks/dotnet` and
`test/vectors` trees whose own `global.json` names 8.0.425; the repository
`global.json` was never edited. Windows has no JDK, so the Java leg ran in WSL
(Ubuntu, OpenJDK 17) by repeating the `javac`/`jar`/`java` sequence of
`scripts/test-java-sdk.mjs`. WSL Linux CTest has five environment failures
that predate this branch: `test_project` and `test_file_publish` (drvfs
permission bits), `test_os_linux` and `test_dmi_info` (no disk or DMI data in
the VM) and `test_execution_environment` (VM detection). They are recorded
below as "the five known WSL failures".

## Final schema

| Measure | Base `3bd3f721` | Branch head |
| --- | --- | --- |
| Migration files | 43 (`0001`..`0043`) | 1 (`migrations/0001_baseline.sql`) |
| Tables | 50 | 42 |
| Indexes | 75 | 63 |
| Triggers | 53 | 48 |
| Schema-object rows in the restore-drill signature | 178 | 153 |
| Seed rows in the baseline | carried by migration DML | one: `license_plan_projection_generations` (`catalog`, 0, 0) |
| Served routes: backend / admin / portal | 23 / 75 / 36 | 8 / 68 / 29 |

The restore-drill schema signature at the branch head is
`6faf6913aa9b51354f8da728a6b1ab21e8b10063acf7c5aab095826382660e5a`, the value
pinned in `services/cloudflare-d1-backup/scripts/restore-drill.mjs`. The table,
index and trigger counts were recomputed from the baseline at the branch head.

`schema.sql` is generated from the baseline and is DDL-only. The baseline
creates every table after the tables its foreign keys reference, because a D1
export replays tables in creation order and enforces foreign keys on import;
`services/cloudflare-licensing-backend/test/db/db-conformance.test.mjs` pins
that order.

## Owner-visible consequences

### Capabilities removed

The owner accepted these losses with no protected replacement:

- floating or concurrent seats;
- metering, quotas and usage reports;
- online revocation for `.lic` applications;
- server-issued 30-day offline leases (protected authority lasts at most 24
  hours and never survives a process restart);
- online licensing without a TPM and a desktop browser: headless hosts, CI
  runners, containers and Windows Server 2022;
- SDK-only online licensing;
- customer account tokens;
- the `/v1/emergency` break-glass routes;
- the local SQLite online demo.

### Behaviour and contract changes

- **Native library.** The runtime accepts only v201 licence files, and `lccgen`
  issues only v201, with RSA keys of at least 3072 bits. `project init`
  refuses names that the v201 project field cannot carry (only letters, digits
  and underscores). OpenSSL 3.0 is the minimum. A rejected licence source is
  fatal by default. The online verification, decision and seat API,
  `confirm_license`/`release_license`, the upstream-only enum values and the
  older config-option struct sizes are gone, so the public ABI is renumbered;
  it has never been released.
- **SDKs.** The Python, .NET and Java backend HTTP clients and online-assertion
  verifiers are gone. A native bridge must export the feature-session
  functions.
- **Device-bound protocol.** Enrollment requires a requested feature, and the
  enrollment comparison has a single form.
- **Backend.** It serves eight routes: signed order ingest, the protected `/v2`
  device routes, health and docs. Every order names a customer, and an order
  acts only on a grant its own customer owns (otherwise 409
  `entitlement_owner_mismatch`). Order HMAC and signer scope are always
  enforced.
- **Admin API.** Grant create, sync and PATCH refuse any field the route does
  not read. Every grant mutation requires `expected_customer_id` and
  `expected_revocation_seq`; the batch body is
  `rows: [{id, expected_customer_id, expected_revocation_seq}]`. Every grant
  has a real, active owner. A webhook endpoint names its scope explicitly, and
  its event types must be ones the dispatcher emits.
- **Portal.** The seat, download, usage and legacy-device routes are gone; the
  portal serves 29 routes for sign-in, consent and connected devices.
- **Tooling.** Deploy configuration needs an explicit `--profile`, the
  compatibility command aliases are gone, and both entitlement CLIs refuse
  unknown options.

### Operator actions before the next deploy

The maintained version of the staging drill setup and of the configuration
to delete is in `doc/operations/cloudflare-setup.md`, under "Staging drill
prerequisites" and "Secrets and variables no longer read".

- Recreate every D1 database (staging, production and restore scratch
  databases) from the baseline, then apply it with
  `npm run migrate:remote --workspace @licensecc/cloudflare-licensing-backend`.
  There is no upgrade path: applying migrations to an older database is a
  no-op.
- Backend deploy configuration: set `BOUND_DEVICE_CONFIG` and
  `BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM`; rename the `VERIFY_RATE_LIMITER`
  binding to `BOUND_REGISTRATION_RATE_LIMITER` and add
  `BOUND_SESSION_RATE_LIMITER` (positive `namespace_id`, limit and period) in
  both deploy configurations; set `ORDER_SIGNER_SCOPES`, without which every
  order returns 503 `config_error`.
- Delete the secrets the backend no longer reads (the online signer, account
  token, lease-issuance and emergency-operator secrets), and drop the removed
  rollout selectors and the `D1_*RATE_LIMIT*` variables. Delete the portal's
  `ACCOUNT_TOKEN_PEPPERS` secret and `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID` variable,
  and the GitHub environment secrets and variables no workflow reads
  (`LICENSECC_STAGING_LEASE_*`, `LICENSECC_PUBLIC_VERIFIER_*` and
  `LICENSECC_CAPACITY_*`). Nothing refuses these: the materializer accepts
  unknown variables and the secret inventory checks only required names.
- Staging protected drill: set the repository variables
  `LICENSECC_STAGING_DEVICE_CLIENT_ID`, `LICENSECC_STAGING_DEVICE_PROJECT`,
  `LICENSECC_STAGING_DEVICE_FEATURE`, `LICENSECC_STAGING_DEVICE_REDIRECT_URI`,
  `LICENSECC_STAGING_DEVICE_AUDIENCE` and
  `LICENSECC_STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM`. Create a protected
  synthetic grant owned by the portal test customer for that project and
  feature, with a device limit of at least 20, and pass its id as the
  `portal_protected_entitlement_id` dispatch input. Register the drill's
  client, project and loopback callback in the staging `BOUND_DEVICE_CONFIG`
  with the same audience. Nothing checks these before the deploy: until they
  are set, a staging dispatch still deploys the Workers, then fails at its
  synthetic drill step and names the missing variables.
- The staging catalog drill's manifest variable must not name the removed
  policy and plan-feature fields (the seat, borrow, meter and TTL fields).
- Size `BOUND_GLOBAL_RATE_LIMIT` to the expected peak and add a WAF rate rule:
  the protected global fuse can deny all online licensing under a flood.

## Changes and their evidence

Each entry gives the commits, the key commands with their outcomes as recorded
when the change was verified, and the surfaces not run. Counts are the ones the
implementer and reviewer recorded at that commit; test counts fall as suites
are deleted. Every change was reviewed before the next one started, and fix
rounds are noted where a review found something.

### PostgreSQL support deleted

- Commits: `a0c7d5cd`.
- Commands: `npm run check:pr` reached the known stop; backend `test:sql`
  331/331; `test:admin` 126/126; `test:portal` 50/50; `test:backup` 96/96;
  `check:schema-parity` ok; `test:workflow-pins` 20/20;
  `test:security-governance` 5/5; `test:docs-accuracy` 14/14; `check:docs`
  succeeded.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); e2e and `check:dry-run` (no UI source, Wrangler configuration or
  Worker code changed; the three edits to Worker-side modules were comments).

### Migrations collapsed into one baseline

- Commits: `64e5f74f`.
- Commands: backend `test:sql` 330/330; `test:admin` 162/185/126;
  `test:portal` 198/28/50; `test:backup` 95/95; `check:schema-parity` ok;
  backend e2e 7/7; `check:dry-run` exit 0; `test:docs-accuracy` 14/14;
  `check:docs` succeeded. The review confirmed 178 identical schema blocks and
  an unchanged `sqlite_schema` signature.
- The baseline orders its tables by foreign key rather than alphabetically:
  with alphabetical order a D1 restore of any backup holding a child row
  failed (`test:backup` 94/95). A test pins the order, and the baseline carries
  the catalog projection seed row that the DDL-only `schema.sql` cannot.
- Not run: UI e2e (no UI code changed).

### Restore drill requires the exact baseline history

- Commits: `de452999`.
- Commands: restore-drill test 38/38; `test:backup` 95/95;
  `test:docs-accuracy` 14/14; `check:docs` succeeded; `check:pr` reached the
  known stop, then backend `test:sql` 330/330, `test:admin` 126/126,
  `test:portal` 50/50 and `check:schema-parity` ok.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); e2e and `check:dry-run` (only the backup service's restore-drill
  script, its test and documentation changed, with no Worker code, UI or
  Wrangler configuration); a restore into a real scratch D1 database (it needs
  Cloudflare credentials).

### Online-verification consumers removed: examples, fuzz harness and remote C++ drill

- Commits: `ab8458ee`.
- Commands: `check-build-purity.ps1 -Preset dev-debug` 36/36;
  `ctest --preset dev-debug` 36/36; WSL `ci-linux-debug` and
  `ci-linux-sanitizers` each 31/36 with the five known WSL failures; a bounded
  fuzz smoke of the remaining activation harness; `test:native-security` 6/6;
  `test:docs-accuracy` 14/14; `check:docs` succeeded; `check:pr` reached the
  known stop, then backend `test:sql` 330, `test:admin` 126, `test:portal` 50,
  `test:backup` 95 and parity ok.
- Not run: SDKs (no SDK source changed).

### Native online verification, the decision and seat API, and revocation floors removed

- Commits: `7b152d8c`.
- Commands: build purity and `ctest --preset dev-debug` 32/32 (four test
  targets deleted); WSL `ci-linux-debug` and `ci-linux-sanitizers` 27/32 with
  the five known WSL failures; `test:native-security` 6/6;
  `test:docs-quickstart` passed; `test:capabilities` 17/17;
  `check:capabilities`, `check:hotspots` and `check:docs` passed;
  `test:docs-accuracy` 14/14; `check:pr` reached the known stop, then the
  remaining steps passed. SDKs: Python 226 passed and 3 skipped; .NET from the
  scratch copy passed (64).
- Not run: the Java leg (no JDK on Windows; no Java source changed).

### Shared device-identity tests moved to the v2 proof; request proof v1 removed

- Commits: `e41cef61`.
- Commands: build purity and dev-debug CTest 32/32;
  `ctest --preset dev-device-identity-test` 57/57; WSL
  `ci-linux-device-identity-test` 50/55 with the five known WSL failures;
  Python 226 passed and 3 skipped; .NET scratch copy 64/64;
  `test:docs-accuracy` 14/14; `check:docs` succeeded; `check:pr` reached the
  known stop, then the remaining steps passed.
- Not run: the Java leg (no JDK; `sdks/java` names none of the deleted
  symbols).

### Rejected licence sources fatal by default; key-rotation ring kept under test; dead lease-ring CMake deleted

- Commits: `862ae529` (failing test first), `0c72f919`.
- Commands: dev-debug CTest and build purity 32/32;
  `dev-device-identity-test` 57/57; WSL `ci-linux-debug` 27/32 with the five
  known WSL failures; `test:docs-quickstart` passed; `test:docs-accuracy`
  14/14; `check:pr` reached the known stop, then backend `test:sql` 330,
  `test:admin` 162/185/126, `test:portal` 198/28/50, `test:backup` 95 and
  parity ok.
- Not run: SDKs (not touched).

### `lccgen` issues only v201 licences

- Commits: `a58312f4`, `6d72a75c`; first fix round `4ce38cd5`, `7babc236`;
  second fix round `71b256d7`..`9a6f3923`.
- Commands: dev-debug CTest 32/32; build purity 32/32; WSL `ci-linux-debug`
  28/32 (four of the five known WSL failures; `test_execution_environment`
  passed that run). The second review found that `public_api_test` passed only
  because a warm build tree held generated project headers. After the fix,
  `test_public_api` passes on its own and dev-debug CTest is 32/32 from a
  brand-new build tree.
- Fix rounds: `project init` refuses names v201 cannot carry; the live
  weak-key refusal paths regained their tests; two existing-file tests now
  exercise the real code paths.
- Not run: SDKs (no SDK reference to the removed options).

### The runtime accepts only v201 licences

- Commits: `adc0bfdc`; fix round `25eff15e`, `fed14876`.
- Commands: dev-debug CTest 32/32 after a clean reconfigure; WSL 28/32 (known
  failures only); `test:docs-quickstart` passed; `test:docs-accuracy` 14/14;
  `check:docs` succeeded; `check:pr` reached the known stop, then backend
  `test:sql` 330, `test:admin` 162/185/126, `test:portal` 198/28/50,
  `test:backup` 95 and parity ok.
- Fix round: the supported format floor is a plain constant, so a stale build
  cache can no longer advertise v200 (shown with a seeded cache value).
- Not run: SDKs (not touched).

### Upstream-only ABI values and older config-option sizes removed

- Commits: `265bdcdf` (failing test first), `6dab4226`; fix round `82ee3ddd`,
  `d3f49a4e`.
- Commands: each changed test run alone, failing first and then passing;
  dev-debug CTest 32/32; build purity 37/37 as recorded; WSL `ci-linux-debug`
  27/32 (known failures only); `test:capabilities` 16/16; `test:versions`
  38/38; `test:docs-accuracy` 14/14; `check:docs` succeeded; `check:pr`
  reached the known stop. Every event code has an `lcc_strerror` case.
- Fix round: non-zero reserved config-option fields are shown to be refused.
- Not run: SDKs (not touched).

### OpenSSL 3.0 required; public-key metadata generated from the template

- Commits: `a74bcac6` (failing test first), `eb5d01b1`; fix round `e4b86aa7`.
- Commands: build purity 32/32; `test:docs-quickstart` passed; clean scratch
  builds: Windows 32/32, WSL `ci-linux-debug` 27/32 and the TPM2 capability
  preset 28/33, both with the five known WSL failures; `check:pr` reached the
  known stop, then backend `test:sql` 330/330 and the admin and portal suites
  passed.
- Not run: SDKs (not touched).

### Python SDK: backend HTTP client and online assertions removed

- Commits: `0042c400`.
- Commands: Python 164 passed and 3 skipped; `test:versions` 37/37;
  `check:versions` clean; `test:release-artifacts` 24/24;
  `test:docs-accuracy` 14/14; .NET scratch copy 64 passed and 5 skipped;
  `check:pr` reached the known stop, then domain 23/23, runtime 49/49, backend
  `test:sql` 330/330 and the admin, portal and backup suites passed.
- Not run: the Java leg (no JDK on Windows).

### .NET SDK: backend client and online assertions removed

- Commits: `5f240e17`.
- Commands: .NET scratch copy 33 passed and 5 skipped (the HTTP and online
  test files were deleted); Python 164 passed and 3 skipped;
  `check:capabilities` exit 0; `test:docs-accuracy` 14/14; `check:pr` reached
  the known stop, then backend `test:sql` 330, `test:admin` 162/185/126,
  `test:portal` 50 and `test:backup` 95.
- Not run: the Java leg (no JDK on Windows; no Java source changed).

### Java SDK: backend client and online assertions removed

- Commits: `497d2703`.
- Commands: the Java sequence of `scripts/test-java-sdk.mjs` in WSL (JDK 17)
  passed before and after the change; `test:versions` 36/36;
  `check:versions` clean; `test:release-artifacts` 24/24; Python 164 passed
  and 3 skipped; `check:pr` reached the known stop, then backend `test:sql`
  330, the admin and portal suites, `test:backup` 95 and parity ok.
- Not run: the .NET leg is not recorded for this change (no .NET source
  changed).

### Native bridges must export the feature-session functions

- Commits: `55ba9469`.
- Commands: Python 163 passed and the installed bridge suite 138/138; .NET
  scratch copy 35 passed and 2 skipped; Java in WSL against a freshly built JNI
  bridge and fixture; `test:workflow-pins` 20/20; `test:docs-accuracy` 14/14;
  `check:docs` succeeded; `check:pr` reached the known stop, then backend
  `test:sql` 330, `test:admin` 126, `test:portal` 50, `test:backup` 95 and
  parity ok.
- Not run: core native CTest (no core C++ changed; the bridge projects are
  separate CMake projects and were built above).

### Shared entitlement writes and admin create are protected-only

- Commits: `5dcd5b69` (failing test first), `1b30fcb7`.
- Commands: admin worker 164/164, SQL 184/184, UI 126/126; admin e2e 200
  passed; backend e2e 7/7; runtime 49/49; contracts regenerated (backend 23,
  admin 75, portal 36 routes) and `test:contracts` 8/8; `check:hotspots`,
  `test:docs-accuracy` 14/14 and `check:dry-run` passed; `check:pr` reached the
  known stop, then the remaining steps passed.
- Not run: native and SDK gates (not touched).

### Admin UI: protection-mode choice and floating policies removed from the create form

- Commits: `960e3e1f`; fix round `e030b60b`.
- Commands: admin `test:ui` 126/126; admin e2e 201/201, run twice (one
  feedback-spec failure under load passed on reruns); `check:capabilities`
  passed; `test:docs-accuracy` 14/14; `check:pr` reached the known stop, then
  the remaining steps passed.
- Fix round: fixture-seeded grants derive their device capacity the same way
  the create route does.
- Not run: native, CTest and SDKs (an admin-UI-only change).

### Plan apply, policy stamps and sync keep protected grants usable

- Commits: `47847e9b` (failing test first), `e5509554`; fix round `6b586568`,
  `2bac7fe2`.
- Commands: backend `test:sql` 332/332; admin worker 170/170, SQL 186/186, UI
  126/126; portal 198/28/50; backup 95/95; parity ok; backend e2e 7/7; admin
  e2e 201 passed; contracts regenerated and passed; `check:hotspots` passed;
  `check:pr` reached the known stop.
- Fix round: a synced disable or revoke of an existing grant always applies, as
  a status-only transition that keeps the stored owner.
- Not run: native, CTest, SDKs, `check:docs` and `check:dry-run` (no C++, SDK
  or Sphinx change).

### Order ingest creates protected grants and requires a customer

- Commits: `d3c66bce` (failing test first), `a8b84af6`; fix rounds
  `287ad037`, `c3eb867a`, `1fa26817`, `5700f15f`.
- Commands: order suite 76/76 and backend `test:sql` 361/361 after the last
  fix round; `test:backup` 95/95 with the re-pinned signature; before the fix
  rounds, `test:sql` 345/345, admin 172/201/126, portal 198/28/50, contracts
  regenerated, `check:hotspots` and `test:docs-accuracy` passed, and
  `check:pr` reached the known stop.
- Fix rounds: an order acts only on its own customer's grant (409
  `entitlement_owner_mismatch`); the baseline's order floor default became -1
  so that a first withdrawal revokes; the audit insert is guarded by owner and
  by the count of applied rows.
- Not run: native, CTest, SDKs, UI e2e and `check:dry-run` (not touched).

### Operator tools create protected grants with an owner

- Commits: `de8b444c`.
- Commands: backend `test` 366/373 (the known stop) and `test:sql` 358/358;
  admin 172/201/126 and the portal and backup suites passed; parity ok;
  `check:pr` reached the known stop.
- Not run: `remote-d1-atomicity.mjs` deploys a real temporary Worker, so it was
  checked against the baseline columns by inspection only; admin UI e2e (no
  admin UI change).

### The staging portal drill proves a protected enrollment, exchange and renewal

- Commits: `22923196` (failing test first), `73415ba8`; fix round `8120f70b`.
- Commands: drill tests 9/9; `test:workflow-pins` 20/20; `test:portal`
  198/29/50; `test:docs-accuracy` 14/14; `check:docs` succeeded; `check:pr`
  reached the known stop, then backend `test:sql` 358, `test:admin`
  172/201/126, `test:backup` 95 and parity ok. Three deliberate breaks were
  shown to be caught.
- Not run: the live staging drill (it needs Cloudflare credentials and the
  operator actions above; the drill ran only against in-test fakes), UI e2e,
  SDKs and native gates.

### Portal Worker: legacy routes, token mint and legacy trial branch removed

- Commits: `127d6660` (failing test first), `aaa49e6b`.
- Commands: `test:portal` 169/169, 28/28, 50/50; portal typecheck and lint
  exit 0; contracts regenerated (portal 29 routes) and `test:contracts` 8/8;
  `test:docs-accuracy` 14/14; `check:dry-run` exit 0; portal UI e2e 156
  passed; `check:pr` reached the known stop, then backend `test:sql` 358,
  `test:admin` 172/201/126 and the backup suite passed.
- Not run: `check:docs` (a two-line paragraph edit), SDKs and native gates.

### Portal UI: seats, legacy devices, downloads and usage removed

- Commits: `3c95f0bc`, `5a8e979e`; fix round `432cf534` (failing test first),
  `9e133430`.
- Commands: portal Worker 170/170, openapi and drill 28/28, UI 43/43; portal
  e2e 128/128, then 130/130 after the fix round; `test:docs-accuracy` 14/14;
  `check:capabilities` and `check:docs` passed; `check:pr` reached the known
  stop, then backend `test:sql` 358, the admin suites, `test:backup` 95 and
  parity ok.
- Fix round: a loading or failed read never reports a real app as unknown.
- Not run: native, SDKs and contract regeneration (no C++, SDK or OpenAPI
  change).

### Admin Worker: legacy-only routes and the account-token list removed

- Commits: `3c66d374` (failing test first), `e9990dd9`.
- Commands: admin worker 171/171, SQL 195/195, UI 126/126, openapi 24/24;
  contracts regenerated (admin 68 routes) and `test:contracts` 8/8; `check:pr`
  reached the known stop, then backend `test:sql` 358, portal 170/28/43 and
  `test:backup` 95.
- Not run: admin e2e (no UI source or e2e fixture changed), native, SDKs and
  `check:docs`.

### Shared seat and legacy-device helpers and admin Worker facades deleted

- Commits: `75a2c73d`.
- Commands: runtime 49 passed and 1 failed before the deletion, then 50/50;
  the six ported entitlement-transition tests 6/6; `check:architecture`,
  `test:architecture` 32/32, `check:hotspots` and `test:docs-accuracy` 14/14
  passed; backend `test:sql` 350/350; admin 171/195/126; portal 170/28/43;
  backup 95/95; parity ok; `check:pr` reached the known stop.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); e2e (no UI source changed); `check:dry-run` (the admin Worker
  change only re-pointed two imports, which the typecheck in `check:pr`
  covers); `check:docs` (only the system-map totals changed, which
  `test:docs-accuracy` checks).

### Admin Worker: legacy fields removed from grants, policies, catalog and reports

- Commits: `983cefc3` (failing test first), `79c9b25c`.
- Commands: domain 23/23; runtime 50/50; admin 175/195/126; backend `test`
  366/373 (the known stop) and `test:sql` 350/350; backend e2e 8/8; admin e2e
  201/201; contracts regenerated (68 routes) and `test:contracts` 8/8;
  `check:hotspots` and `test:docs-accuracy` passed; `check:pr` reached the
  known stop.
- Not run: native, CTest, SDKs, `check:docs` and `check:dry-run`.

### Admin UI: legacy screens and fields removed

- Commits: `c63de4c4` (failing test first), `ea0b30f2`, `b38d186a`.
- Commands: admin UI 123/123; admin e2e 194/194 at two commits; the feedback
  and lifecycle specs 78/78 with `--repeat-each 3`; domain 23/23; root
  typecheck and lint exit 0; `check:hotspots`, `test:docs-accuracy` and
  `check:docs` passed; `check:pr` reached the known stop, then backend
  `test:sql` 350, admin 176/195/123, portal 170/28/43, `test:backup` 95 and
  parity ok.
- Not run: native, CTest, SDKs and `check:dry-run`; no contract moved.

### Admin mutations require the expected owner and revocation sequence

- Commits: `19255dcb`, `505d82cd`; fix round `6332276c` (failing test first),
  `552efe69`.
- Commands: admin e2e 194/194 three times, then 195/195 after the fix round;
  backend `test:sql` 350/350 and `test` 366/373 (the known stop); domain 23/23;
  runtime 50/50; `test:portal` recorded as 43/43; backup 95/95; parity ok; contracts
  regenerated and passed; `test:docs-accuracy` 14/14; `check:hotspots` and
  `check:docs` passed; `check:pr` reached the known stop.
- Fix round: a stale batch row settles instead of staying unknown, and every
  new rule has a test shown to fail without it.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); portal e2e (no portal source changed); backend e2e (the backend's
  own changes were tests, and its `test` and `test:sql` suites cover the
  shared runtime change); `check:dry-run` (no Wrangler configuration or
  Worker entry point changed).

### Health readiness certifies protected licensing; protected production smoke added

- Commits: `37b464ac` (failing test first), `011815b0`, `b0b96bb8`
  (integrated by rebase from a parallel worktree).
- Commands: `test:release-operations` 37/37; `test:worker-rollback` 17/17;
  `test:workflow-pins` 20/20; contracts regenerated and `test:contracts` 8/8;
  `test:docs-accuracy` 14/14; `check:pr` reached the known stop (backend
  `test` 373/380), then backend `test:sql` 350, admin 176/195/123, portal
  170/29/43, `test:backup` 95 and parity ok. After integration:
  `check:dry-run` exit 0, admin e2e 195/195 and portal e2e 130/130.
- Not run in the worktree: UI e2e (the shared ports belong to the main
  worktree; run after integration), SDKs, `check:docs` and native build
  purity.

### Tooling compatibility aliases removed; explicit deploy profile required

- Commits: `656f2cd3` (integrated by rebase from a parallel worktree).
- Commands: materializer tests 17/17, then 18/18 after the integration fix;
  `test:docs-accuracy` 14/14; `build-purity-static` 20/20;
  `test:release-operations` 35/35; `test:security-governance` 5/5;
  `test:clean-checkout` 6/6 and the CMake tool-resolution fixtures;
  `check:docs` succeeded; build purity 32/32. After integration: the gates
  above plus admin e2e 195/195 and portal e2e 130/130.
- Not run in the worktree: UI e2e (run after integration).

### Lease, seat, meter, report and emergency routes deleted

- Commits: `df4c7c10` (failing test first), `18c7e1ef`.
- Commands: the backend serves 9 routes; contracts regenerated (backend 9) and
  `test:contracts` 8/8; `test:docs-accuracy` 14/14; `scan:secrets`,
  `test:workflow-pins` 20/20, `test:capabilities` 16/16, `check:capabilities`,
  `check:architecture`, `check:hotspots` and `test:architecture` 32/32 passed;
  `check:pr` reached the known stop; backend `test:sql` 305/305; e2e backend
  8, admin 195, portal 130.
- Not run: SDKs and native gates (not touched).

### Lease drill and signer, shared lease modules and the local online demo deleted

- Commits: `29c47553` (failing test first), `4dcea61e`.
- Commands: materializer 19/19; runtime 47/47; domain 23/23; backend `test`
  313/313, `test:sql` 291/291, openapi 11/11, deployed-readiness 26/26, db
  28/28; parity ok; `check:capabilities` exit 0; `check:dry-run` exit 0;
  `check:docs` succeeded. From this change on, `npm run check:pr` exits 0
  with every sub-suite passing. e2e: backend 8, admin 195, portal 130.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); `test:docs-quickstart` (the documentation changes removed the
  local online demo, not the native install, issuance or minimal-consumer
  journey).

### `/v1/verify` deleted

- Commits: `be73b52f` (failing test first), `6aba7b55`.
- Commands: backend `test` 280/280; `test:contracts` 8/8; `check:pr` exit 0;
  `test:e2e` backend 8, admin 195, portal 130; `check:dry-run` exit 0;
  `test:workflow-pins` 21/21; `test:capabilities` 16/16; `check:hotspots`,
  `test:docs-accuracy` 14/14 and `check:docs` passed.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); the edited staging and production deploy workflows against
  Cloudflare (they need credentials; `test:workflow-pins` checked them).

### Account tokens, request proof v1, the online signer and legacy selectors deleted; registration limiter renamed

- Commits: `7d5f2bed` (failing test first), `a9e42929`.
- Commands: `check:pr` exit 0; e2e backend 8, admin 195, portal 130;
  `check:dry-run` exit 0; Python 163 passed and 2 skipped; .NET scratch copy 33
  passed and 4 skipped; Java in WSL passed; dev-debug CTest 32/32;
  `test:release-operations` 39/39; deployed-readiness 15/15;
  `test:workflow-pins` 20/20; `test:architecture` 32/32;
  `test:docs-accuracy` 14/14.
- Not run: build purity (no C++ source changed).

### Order-ingest security always enforced

- Commits: `a752a731`; fix round `cd31ac75` (failing test first), `d1e65620`.
- Commands: backend `test:sql` 292/292; deployed-readiness 15/15;
  `test:release-operations` 40/40; contracts regenerated (backend 8 routes);
  `check:dry-run` passed; `check:docs` succeeded; `check:pr` exit 0.
- Fix round: the protected production smoke fails on any configuration
  warning, and the unreachable `observed` result code is gone.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); e2e (no UI source changed; the backend's `test` and `test:sql`
  suites cover the order path); the protected production smoke against a
  deployed backend (it needs a deployed Worker; its tests ran against fakes).

### Legacy-only tables and reject triggers dropped from the baseline

- Commits: `8bac7179` (failing test first), `9df829ff`.
- Commands: 42 tables, 63 indexes, 48 triggers and 153 rows at that point; the
  signature was re-pinned, and the reviewer recomputed it from a real SQLite
  database; `check:schema-parity` ok; `test:backup` 96/96; `test:services`
  green; `check:dry-run` passed; `test:docs-accuracy` 14/14; `check:docs`
  succeeded; `check:pr` exit 0; e2e green.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); a restore into a real scratch D1 database (it needs Cloudflare
  credentials; the signature was recomputed from a local SQLite database
  instead).

### `usage_events` replaced by a protected denial table

- Commits: `7b8f2627` (failing test first), `f8c6cc7b`.
- Commands: backend `test:sql` 291/291 and `test` 208/208; admin worker
  178/178 and SQL 196/196; contracts regenerated and passed; `test:backup`
  96/96 after the signature update; `test:services` green; `test:e2e` exit 0
  (admin 195, portal 130); admin connections e2e 19/19; `check:dry-run`
  passed; `check:pr` green.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); `check:docs` (the only Sphinx change was the system-map totals,
  which `test:docs-accuracy` in `check:pr` checks; `CHANGELOG.md` is not
  part of the Sphinx build); a restore into a real scratch D1 database (it
  needs Cloudflare credentials).

### Admin and portal readers accept rows without the legacy columns

- Commits: `430c6d3c` (failing test first), `b4f212d3`.
- Commands: admin UI 124/125, then 125/125; portal 170 + 29 and UI 43;
  `test:docs-accuracy` 14/14; `check:hotspots` passed; contracts unchanged;
  admin e2e 195 (one `ERR_NO_BUFFER_SPACE` failure on the first run passed on
  a clean rerun); portal e2e 130; `check:pr` exit 0.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); backend e2e (no backend source changed); `check:dry-run` (no
  Wrangler configuration or Worker entry point changed; the portal Worker
  edits are covered by its typecheck and Worker tests); `check:docs` (only
  the system-map totals changed, which `test:docs-accuracy` checks).

### Legacy grant, policy and catalog columns dropped

- Commits: `2ba48630` (failing test first), `cdd2e718`.
- Commands: `check:schema-parity` ok; backend `test:sql` 293/293; admin SQL
  190/190 and UI 125/125; portal UI 43/43; capacity predicate 3/3; contracts
  8/8; `check:hotspots` and `test:docs-accuracy` passed; root `test:e2e` exit
  0 (8/195/130); `check:dry-run` exit 0; `check:pr` green twice.
- Not run: native CTest, build purity and the SDK legs (no C++ or SDK source
  changed); `check:docs` (the only Sphinx change was the system-map totals,
  which `test:docs-accuracy` checks; the service READMEs are outside the
  Sphinx build); a restore into a real scratch D1 database (it needs
  Cloudflare credentials).

### Protected is the schema default; no code reads or sends the enforcement mode

- Commits: `0b4dee44` (failing test first), `c47d9f65`.
- Commands: backend `test` 207/207 and `test:sql` 294/294; admin SQL 190/190
  and UI 125/125; portal UI 43/43; contracts 8/8; lint and typecheck clean;
  `check:hotspots` and `test:architecture` 32/32; `test:docs-accuracy` 14/14;
  `check:pr` green; e2e 8/194/130; native build purity 32/32;
  device-identity CTest 57/57.
- Not run: `check:docs` (READMEs and one system-map line, covered by
  `test:docs-accuracy`), SDKs (no SDK reference) and WSL CTest.

### Enforcement mode dropped; owner required; trial key column renamed; 24-hour lease default

- Commits: `00123b9e` (failing test first), `9bad8e5b`; first fix round
  `6c4a9592`, `69efb9fe`, `922311b5`; second fix round `1abda3d8`,
  `7595a234`.
- Commands: backend `test:sql` 296/296; parity ok; `test:services` green;
  runtime 47/47; e2e 8/194/130; `check:dry-run` 4/4; `check:hotspots`,
  `test:docs-accuracy` 14/14, contracts 8/8, lint and typecheck passed;
  `check:pr` exit 0 at each fix round.
- Fix rounds: an owner-less create or PATCH returns 400 before reaching D1;
  plan preview blocks an owner-less item as Apply does; blank or padded owners
  are refused; a PATCH that moves the owner or licence meets the create rules;
  the schema refuses a blank owner.
- Not run: `check:docs` (READMEs only), native and SDK gates.

### Enrollment requires a requested feature

- Commits: `300440cd` (failing test first), `f47bbaa7`.
- Commands: backend `test` 208/208 and `test:sql` 297/297; device-identity
  CTest 57/57; dev-debug 32/32; Python 163 passed and 2 skipped; .NET scratch
  copy 33 passed; Java in WSL passed; WSL with the five known failures only;
  architecture 28/28; contracts 8/8; `test:docs-accuracy` 14/14; `check:pr`
  green; e2e 8/194/130.
- Not run: `npm run test:sdks` as one command (host limits; its three legs
  ran), `check:docs` and `check:dry-run`.

### Order request nonce named; portal session auth method explicit

- Commits: `d5a59069` (failing test first), `f52befcf` (integrated by rebase
  from a parallel worktree).
- Commands: `test:portal` 171/171; backend `test` and `test:sql` 296/296;
  parity ok; `test:services` green; `check:pr` exit 0 in the worktree. After
  integration: `check:pr` exit 0 and root e2e 332/332.
- Not run in the worktree: portal e2e (run after integration), native and SDK
  gates.

### Webhook endpoints need an explicit scope and canonical event types

- Commits: `632b7801` (failing test first), `5989b065` (integrated by rebase
  from a parallel worktree).
- Commands: `check:schema-parity` ok; `check:hotspots` passed;
  `test:docs-accuracy` 14/14; typecheck and lint exit 0; contracts 8/8;
  `check:pr` exit 0; `check:dry-run` exit 0. After integration: the final
  counts and signature above, `test:backup` 96/96, `check:docs` succeeded,
  `check:pr` exit 0 and root e2e 332/332 (backend 8, admin 194, portal 130).
- Not run in the worktree: admin e2e (run after integration).

### Maintained documentation rewritten for protected-only licensing; CHANGELOG reset

- Commits: `b44493f6`.
- Commands: `check:pr` exit 0; `test:docs-accuracy` 14/14; `check:docs`
  succeeded; `check:capabilities` exit 0; `test:docs-quickstart` passed;
  `check:versions` exit 0; `test:versions` 36/36; `test:release-artifacts`
  24/24.
- Review: the CHANGELOG "Not included" list lacked three statements that the
  README and the launch scope make; the sweep below adds them.
- Not run: SDKs, e2e, `check:dry-run`, build purity and CTest (a documentation
  change).

### Whole-repository sweep, ADR 0006 amendment and this report

- Commits: `10cedea5` (failing test first), `8dd5da39`, `e0c37d49`,
  `4ac9fad0`, `a83f2315`, `496820a1`, `9ee08c57`, `23a613c3`, `d3e979a8`, and
  `b4084073`, which adds this report together with the ADR 0006 amendment.
- Commands: see "Sweep" and "Final gate" below.

## Sweep

The sweep ran these three searches from the repository root:

```bash
git grep -nIiE "legacy|compat|backward|deprecated" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis' ':!**/package-lock.json' ':!**/uv.lock' ':!**/packages.lock.json' ':!doc/requirements.txt'
git grep -nIE "LEASE_ISSUE_BEARER|enforcement_mode|v200" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
git grep -nIiE "supabase|postgres|pg-parity" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis' ':!**/package-lock.json'
```

| Search | Lines before the sweep (`b44493f6`) | Lines at the branch head |
| --- | --- | --- |
| legacy, compat, backward, deprecated | 442 | 339 |
| `LEASE_ISSUE_BEARER`, `enforcement_mode`, `v200` | 7 | 7 |
| supabase, postgres, pg-parity | 1 | 0 |

A supplementary search for the names of deleted concepts (account tokens,
request proof, `DEVICE_PROOF_MODE`, `lccoa1`, `/v1/verify`, `/v1/activate`,
`/v1/renew` and floating) found stale OpenAPI descriptions, which the sweep
fixed (the OpenAPI row below). Two more that still named account tokens, the
admin customer-detail summary and the project-discovery description, were
fixed after the whole-branch review. Every other hit is a negative test, a
capability-loss statement, a current protocol name or vendored text.

The second search counted 6 lines when the sweep finished. It counts 7 at the
branch head because the setup guide now lists `LEASE_ISSUE_BEARER` among the
secrets operators must delete (`doc/operations/cloudflare-setup.md:407`), a
removal record classified below.

### Fixed by the sweep

| Where | What changed |
| --- | --- |
| `services/cloudflare-licensing-backend/scripts/entitlement.mjs` and `services/cloudflare-license-admin/scripts/sync-entitlement.mjs` | Both CLIs refuse an option they do not read with `unknown option --<name>` and exit 2; the backend CLI checks the options of each command. The failing tests came first (`10cedea5`: backend 10/11, admin 20/21), then passed (11/11, 21/21). |
| `scripts/materialize-deploy-configs.mjs` | The dead `LICENSECC_EXPECTED_BACKEND_CREDENTIAL_ORIGIN` binding and its test are gone; its only setter was the deleted capacity workflow. Materializer tests 19/19. |
| `scripts/assert-worker-deployment.mjs` | Keeps only `parseSanitizedDeployment`, which the deploy-transition capture imports. The command-line form and the capacity-target assertion had the same deleted caller. Rollback tests 12/12. The parser later moved into `scripts/capture-worker-deployment-transition.mjs`, its only production importer, and the module was deleted. |
| Portal password and OAuth tests | The "legacy" account shape is the admin console's set-password shape (an empty contact address and an unverified login address), which is live; the helper, addresses and titles say so. A duplicate password session that stood in for the removed session method is gone. |
| Portal `src/worker/routes/password-email.ts` | The comment no longer mentions accounts "registered before verification existed". The empty-contact recovery branch stays, because the admin console still creates such accounts. |
| Portal OAuth unlink rule | Unchanged: an address without `@` does not count as a sign-in method. No writer stores one, so this is validation that matches the OTP sender, not a compatibility branch; the test comment says so. |
| Portal account-deletion runbook test, admin catalog e2e fixture, admin console and e2e titles | Renamed to what they hold: a malformed cached row, a retired feature, the customer-detail bundle, non-catalog records and the current customer section URLs. |
| 25 admin e2e comments | No longer claim the create form could make a legacy grant. |
| `packages/cloudflare-runtime/src/d1/plan_projection.mjs` and its tests | The identity fence is described as a non-catalog entitlement identity fence, and the test fixtures are renamed. |
| Backend device-HTTP, policy-stamp, anti-tamper and Windows CI generator test titles | No longer name legacy settings, rows, entry points or builds. |
| `test/library/device_identity/device_bound_vectors_test.cpp` | The empty-feature refusal pre-fills its output with a sentinel byte and requires it to survive. A temporary mutation that cleared the output on failure made the test fail (`0 != 165`); with the mutation reverted it passes. |
| `services/cloudflare-licensing-backend/test/db/db-conformance.test.mjs` | The foreign-key order guard requires at least ten walked edges, including the composite device-binding one (the baseline has 21). A temporary mutation that walked no edges made it fail. |
| `sdks/python/tests/test_device_bound_vectors.py` | PEP 8 spacing. |
| OpenAPI descriptions (admin webhook PATCH, binding retirement and customer detail; backend order ingest; portal password reset and change) and the admin README | A scope move requires sending the old kind's value as `''`, otherwise 400 `invalid_request`; no fallback, account-token field or account-token revocation is named; `code:cached` covers a terminal row whose finalization did not complete. Contracts regenerated with `npm run write:contract-baselines`; only these descriptions changed. |
| Root `CMakeLists.txt`, `include/licensecc/device_bound.h`, `include/licensecc/licensecc.h`, `src/library/device_identity/bound_lease.cpp`, backend `src/env.ts` and `src/routes/bound_devices.mjs` | The comments describe live behaviour without calling it legacy or compatibility. |
| Java and Python SDK READMEs | The Java JNI adapter is documented for Windows x64 and Linux, which Linux CI builds and tests; PKCS#1 is named as the offline licence project key's type. |
| `doc/capabilities/registry.json` and `doc/capabilities/index.rst` | The TPM device-key provider's id is `tpm-device-key-provider`, since request proof v1 no longer exists. `check:capabilities` passes. |
| `doc/architecture/change-guide.md` and `doc/api/extend.rst` | The parent-first table order is stated; one long line is rewrapped. |
| `extern/license-generator/PROVENANCE.md` and two generator tests | The note no longer claims the runtime reads v200 licences; a refused project-name sample and a comment drop "legacy". |
| `CHANGELOG.md` | "Not included" states that every D1 database is recreated from the baseline, that the live TPM, browser and backend journeys remain release gates, and that the protected global fuse can deny all online licensing. `check:versions` passes. |
| ADR 0006 and `doc/architecture/index.rst` | Amended; see below. |

### Remaining hits, classified

Every remaining hit is **fine**: none is a legacy mode, a compatibility shim or
a description of removed behaviour as current.

| Class | Hits (path:line) | Why it is fine |
| --- | --- | --- |
| Vendored third-party text | `extern/license-generator/src/inja/nlohmann/json.hpp` (141 lines); `extern/license-generator/src/inja/inja.hpp:66`; `extern/license-generator/src/ini/SimpleIni.h:461`; `src/library/ini/SimpleIni.h:477`; `extern/license-generator/scripts/git-pre-commit-hook:39`; root `package-lock.json` (4 lines: `@babel/compat-data` and an npm deprecation notice; the `:!**/package-lock.json` pathspec does not match the root file) | Upstream library and package-manager text. |
| Windows API names | `extern/license-generator/src/base_lib/win/CryptoHelperWindows.cpp:39,91,99,106,115,165,191,215,313`; `src/library/device_identity/providers/windows_cng_api.hpp:35,37`; `windows_tpm.cpp:52,53,57,58`; `test/library/device_identity/windows_tpm_test.cpp:86,176,183,197,205,641,701` | `LEGACY_RSAPRIVATE_BLOB` and the `legacy_key_spec` parameter are Windows CNG names. |
| Kept stability commitments | `src/library/hw_identifier/hw_identifier.hpp:28` (hardware-identifier byte layout); bridge ABI probes in `sdks/dotnet/src/Licensecc.Client/DeviceBoundAbi.cs:55`, `FeatureSessionNative.cs:27`, `sdks/python/src/licensecc/_device_bound_abi.py:49`, `_feature_session_abi.py:27`, `sdks/java/src/main/java/io/licensecc/client/DeviceBoundNative.java:32`, `FeatureSessionNative.java:9`, `sdks/java/src/test/java/io/licensecc/client/DeviceBoundAdapterTest.java:229,267,268,273`, `sdks/java/native/CMakeLists.txt:31`, `sdks/java/native/README.md:7,140`; root `CMakeLists.txt:440` (`COMPATIBILITY SameMajorVersion`) | The owner kept the issued-licence byte layout, the bridge layout probes and the CMake package version rule. |
| Release, contribution and review policy | `doc/architecture/decisions/0005-platform-version-and-release-tags.md:68-72,74`; `CHANGELOG.md:13`; `CONTRIBUTING.md:30,161,178`; `doc/architecture/change-guide.md:20,99`; `doc/architecture/decisions/0003-route-openapi-ownership.md:24`; `doc/architecture/ownership.md:20,21`; `doc/development/Dependencies.md:12` | SemVer and release-tag rules, and the rule that a change to a public contract states its compatibility impact. |
| Rollback and key-rotation compatibility | `doc/operations/cloudflare-setup.md:380,384`; `doc/operations/device-bound-key-rotation.md:101,110`; `doc/operations/production-readiness.md:316`; `doc/release-artifacts.md:397` | A rolled-back Worker must match the current schema and trust; this is live operational guidance. |
| Cloudflare `compatibility_date` and `compatibility_flags` | `scripts/materialize-deploy-configs.mjs:308-310,390,392,510`; `scripts/materialize-deploy-configs.test.mjs:78,92,93,185,403-406`; `services/*/wrangler.example.*` (portal :5, D1 backup :5,6, admin :5, backend :3,4); `services/cloudflare-licensing-backend/README.md:142`; `services/cloudflare-license-admin/scripts/remote-d1-atomicity.mjs:223`; workerd test configs in `services/cloudflare-licensing-backend/test/db/bound-device-d1.test.mjs:64`, `bound-device-worker.test.mjs:28,33,43,46,235,238`, `pcp-evidence-workerd.test.mjs:33`, `webhook-operator-worker.test.mjs:32,35,43`, `services/cloudflare-customer-portal/test/portal-oauth-runtime.test.mjs:39`, `services/cloudflare-d1-backup/test/backup-runtime.test.mjs:39`, `backup-bound-restore.test.mjs:16`; `packages/cloudflare-runtime/test/entitlement-json.test.mjs:404` | Workers platform settings and Wrangler's local D1 runner. |
| Generated-binding type guards | `IncompatibleGeneratedBindings` in `services/cloudflare-licensing-backend/src/env.ts:24,28,77,78`, `services/cloudflare-license-admin/src/worker/env.ts:11,15,53,54`, `services/cloudflare-customer-portal/src/worker/env.ts:32,36,79,80`, `services/cloudflare-d1-backup/src/index.ts:35,39,58,59`; `scripts/wrangler-env-drift.test.mjs:17,25,33,41,88,92,118` | Compile-time checks that generated Wrangler types match the runtime environment. |
| Resend-compatible email | `services/cloudflare-customer-portal/README.md:342,346`; `src/auth/portal_email.mjs:1`; `wrangler.example.jsonc:45,49`; `test/portal-worker-public.test.mjs:194` | The email adapter speaks the Resend API. |
| Kept live features | `cmake/Findlccgen.cmake:25` (`license_generator_lib`); `scripts/check-typecheck-coverage.mjs:8,14,107,111,115,117` (the JavaScript graphs not yet strictly typed, which is type-coverage debt); `services/cloudflare-customer-portal/src/auth/portal_otp.mjs:194` (the empty pepper-map contract) | Live code that only looks like compatibility. |
| Vendored generator packaging | `extern/license-generator/CMakeLists.txt:22,100`; `extern/license-generator/src/license_generator/CMakeLists.txt:43,44,46` | A parent project's version value and the generator package's `lib/cmake` install path beside the Windows `cmake/` path; an install layout, not a data or protocol path (see Follow-ups). |
| Negative tests and removal records | `packages/cloudflare-runtime/test/runtime-primitives.test.mjs:28`; `services/cloudflare-license-admin/test/routes-table.test.mjs:16,18,19`; `test/admin-ui-workflow/glossary-copy.test.mjs:19,21,22`; `test/admin-ui.workspace.e2e.mjs:219`; `services/cloudflare-customer-portal/test/portal-ui.e2e.mjs:783`; `portal-ui.nodes.e2e.mjs:25`; `portal-session.test.mjs:142`; `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs:867,868,873,878,882,883`; `extern/license-generator/test/command-line_test.cpp:1534,1681,1682`; `extern/license-generator/test/license_test.cpp:279`; `extern/license-generator/PROVENANCE.md:14,15`; `test/library/LicenseReader_test.cpp:116,120,122`; `scripts/materialize-deploy-configs.test.mjs:476`; `doc/operations/cloudflare-setup.md:407` | Each asserts or records that a removed thing is absent or refused. |
| ADR 0006 text the amendment requires | `doc/architecture/decisions/0006-device-bound-licensing.md:7,76` | The required "Amended:" line and the statement that no legacy paths remain to fence. |
| General English | `CMakeLists.txt:248`; `doc/api/device_identity.rst:135,158`; `doc/usage/concepts.rst:44`; `doc/usage/repository-workflows.rst:90,166`; `doc/tutorials/sdk-and-support.rst:31`; `doc/architecture/decisions/0001-module-boundaries.md:70,87`; `scripts/README.md:21`; `scripts/canonical-contracts.mjs:25`; `scripts/rollback-workers.mjs:328,372`; `scripts/assemble-release-artifacts.mjs:1304`; `services/cloudflare-licensing-backend/README.md:404`; `services/cloudflare-licensing-backend/test/fulfillment/order_event.test.mjs:285`; `order_ingest_exactly_once.test.mjs:1029`; `test/sql/bound-device-store.test.mjs:117`; `services/cloudflare-license-admin/test/admin-ui.connections.e2e.mjs:51`; `test/admin-ui-workflow/entitlements.test.mjs:8`; `test/sql/policy-admin.test.mjs:393,399`; `test/worker/auth-and-request.test.mjs:158`; `test/worker/query-boundaries.test.mjs:24`; `src/library/device_identity/providers/tpm2_openssl.cpp:1559`; `extern/license-generator/test/CMakeLists.txt:33`; `extern/license-generator/test/license_test.cpp:125`; `extern/license-generator/test/project_test.cpp:193,209` | "Compatible", "incompatible", "backward" and "deprecated" in their ordinary senses: a compatible generator, clocks moving backwards, an incompatible identifier, a disable reason string, JSON-compatible values, OpenSSL and MSBuild behaviour, project names v201 cannot carry, and the closed module-import history of ADR 0001. |

## ADR 0006

ADR 0006 is amended in place, as it was before and as ADR 0002 records its own
amendment; no new ADR is needed. Its status block gains "Amended: 2026-09-28 —
protected mode is the only online mode; the compatibility and cutover section
is superseded." The context no longer asks the flow to stay separate from
legacy and floating clients. "Compatibility and cutover" is replaced by
"Protected-only operation": entitlements have no enforcement mode; there are no
legacy verification, issuance, device-registration or floating-seat paths to
fence; there is no cutover, because the schema is a single baseline and every
database is recreated; and D1 is the only store. The release evidence no
longer lists protected legacy-route denial. `doc/architecture/index.rst`
describes the ADR as covering persistent capacity, recovery and clock policy.

## Final gate

The gate ran on `d3e979a8` with the ADR 0006 and
`doc/architecture/index.rst` edits of `b4084073` already in the working tree;
`b4084073` adds only those two files and this report. `npm run check:pr` first ran at
`23a613c3`, whose only difference from `d3e979a8` is one sentence in
`extern/license-generator/PROVENANCE.md`, and was run again with the
full content of `b4084073` staged (last row). Node 24.20.0, npm 10.9.8 for
`npm ci`, uv 0.12.5, CMake
3.28.3 and Clang 18.1.3 in WSL.

| Command | Outcome |
| --- | --- |
| `npx -y npm@10.9.8 ci` | exit 0; added 357 packages. npm reports 4 audit findings (2 moderate, 2 high); the lockfile is unchanged by the sweep. |
| `npm run check:pr` (at `23a613c3`) | exit 0 in 6 min; 26 node test summaries, every one `fail 0`, 1,667 tests passed; secret scan, script catalog, versions, capabilities, lint, typecheck, architecture, hotspots, contracts and schema parity all passed. |
| `uv run --directory sdks/python --locked pytest` (Python leg of `npm run test:sdks`) | 163 passed, 2 skipped. |
| `dotnet test sdks/dotnet/Licensecc.Client.sln` (.NET leg, from a scratch copy of the committed `sdks/dotnet` and `test/vectors` with SDK 8.0.425) | 33 passed, 4 skipped, 0 failed (37). The skips need an installed native bridge. |
| Java leg: the `javac`/`jar`/`java` sequence of `scripts/test-java-sdk.mjs` in WSL (OpenJDK 17.0.20.1) | 14 main and 6 test sources compiled with `-Xlint:all -Werror`; `SdkTest` passed ("Java SDK tests passed"). The installed-JNI checks reported themselves skipped because no JNI library was supplied. |
| `npm run setup:browsers` | exit 0 (Chromium already present). |
| `CI=1 npm run test:e2e` | exit 0: backend 8/8, admin 194 passed, portal 130 passed. Ports 4173 and 4174 were free before and after; the vite server on 5173 belongs to another session and was left alone. |
| `npm run check:dry-run` | exit 0; all four Workers reached `--dry-run: exiting now.` |
| `npm run check:docs` | exit 0; Doxygen and Sphinx "build succeeded", including the amended ADR. |
| `npm run test:docs-quickstart` | exit 0; node 3/3; "Offline documentation quickstart passed: native install, local license issuance, installed minimal consumer, and license verification all succeeded." |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | exit 0; 32/32; "Build purity check passed: source fingerprints were unchanged." |
| `ctest --preset dev-debug` | 32/32. |
| Brand-new build tree: `cmake --preset dev-debug -B build/fresh-dev-debug-sweep`, build, then `ctest --test-dir build/fresh-dev-debug-sweep -C Debug` with the preset's `VIRTUAL_ENV=VM` | configure and build from an empty directory, then 32/32. This guards against tests that pass only because a warm tree holds generated files. The directory was removed afterwards. |
| `ctest --preset dev-device-identity-test` | 57/57 (run because the sweep changed a device-identity test). |
| WSL `cmake --preset ci-linux-debug`, build, `ctest --preset ci-linux-debug` | configure and build exit 0; 27/32, the five known WSL failures only. |
| WSL `cmake --preset ci-linux-sanitizers`, build, `ctest --preset ci-linux-sanitizers` | configure and build exit 0; 27/32, the five known WSL failures only. |
| `npm run check:pr` (with the content of `b4084073` staged on `d3e979a8`) | exit 0 in 5 min; 26 node test summaries, every one `fail 0`, 1,667 tests passed; the secret scan covered this report. |

Not run, with reasons:

- `npm run test:sdks` as one command: the repository `global.json` pins an SDK
  this host does not have, and Windows has no JDK. Its three legs ran
  separately as listed.
- The live staging drill and the protected production smoke against deployed
  Workers: they need Cloudflare credentials and the operator actions above.
- `remote-d1-atomicity.mjs`: it deploys a real temporary Worker.
- The installed Windows and Linux JNI and Python bridge gates
  (`scripts/ci/run-installed-*-device-bound.ps1` and the Linux CI bridge step):
  they need an installed TPM-enabled package; the sweep changed no bridge code.
- `npm run check:docs:links`: a scheduled network check, not part of the
  deterministic gate.
- Live TPM, browser and backend journeys: release gates that need real
  hardware and a deployed backend.

## Whole-branch review

After the final gate, a whole-branch review read the full range
`3bd3f721..b4084073` area by area (baseline schema, backend, shared packages,
admin, portal, backup, native library, generator, SDKs, scripts and CI, tests
and documentation) and swept the repository for dangling references. It found
no defect in the code, schema, contracts, native ABI or SDKs. Its main finding
was documentation: the one-time setup for the protected staging drill and the
list of configuration operators must delete lived only in this report and the
staging workflow, not in the maintained operator guide. Its smaller findings
were stale comments and an unused export in the portal UI, a synthetic test
path named after a removed route, an admin OpenAPI summary that still listed
tokens, a compatibility rationale in the generator's CMake comment, a library
module that kept its command-line name, and wording in this report. All of
them were fixed on the branch:

| Commit | Change |
| --- | --- |
| `4e48cfe2` | `doc/operations/cloudflare-setup.md` gains "Staging drill prerequisites" and "Secrets and variables no longer read"; a docs-accuracy test keeps the guide naming every staging drill variable the workflow reads (shown to fail when one is removed). |
| `60d0cad3` | Portal UI: the download and seat-card comments are gone, `currentSessionEpoch()` is deleted, and `reportUnauthorized()` and `LicenseNextStep` are module-private. The test that read the epoch now proves through `api()` that a credential 401 never fires the session-ended hook (shown to fail when the code check is removed). |
| `8008be31` | The portal `api()` tests use `/api/portal/example` instead of two removed route names. |
| `ec881070` | The admin customer-detail summary and project-discovery description no longer name account tokens; contracts regenerated with `npm run write:contract-baselines`, only those two strings changed. |
| `ff5e8a3a` | The generator's CMake comment states the install layout; no install path changed. |
| `803ce2bc` | `parseSanitizedDeployment` moved into `scripts/capture-worker-deployment-transition.mjs`; `scripts/assert-worker-deployment.mjs` and its script-catalog entry are gone. |
| `0031a373` | The system map's customer-portal total follows the portal change (5,751 to 5,742 lines). From `60d0cad3` until this commit, `test:docs-accuracy` failed on that total. |
| `d38f4dbb`, `2c71c5f9`, `c3910976` | This report: the not-run surfaces of every change, the operator actions and sweep record, and one follow-up per parked item. |

Everything else the review raised is a follow-up, listed below. The sweep's
three searches, re-run at `c3910976`, count 339, 7 and 0 lines; the one new hit
is the setup guide's list of secrets to delete. The audit findings in the
follow-ups come from `npm audit --json` and `npm audit --omit=dev --json` (npm
11.19.0) against the unchanged lockfile on 2026-09-30.

The gates below ran on `c3910976`, the parent of the commit that adds this
section, which changes only this report. Node 24.20.0, npm 11.19.0 (the
dependencies installed earlier with `npm ci` and npm 10.9.8 were unchanged).

| Command | Outcome |
| --- | --- |
| `npm run check:pr` | exit 0; 26 node test summaries, every one `fail 0`, 1,668 tests passed (one more than before: the setup-guide test); secret scan, script catalog, lint, typecheck, architecture, hotspots, contracts and schema parity all passed. |
| `npm run check:docs` | exit 0; Doxygen and Sphinx "build succeeded". |
| `npm run check:dry-run` | exit 0; all four Workers reached `--dry-run: exiting now.` |
| `CI=1 npm run test:e2e --workspace @licensecc/cloudflare-customer-portal` | exit 0; 130 passed. Ports 4173 and 4174 were free before and after. |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` (at `803ce2bc`, after the last change to a CMake file) | exit 0; 32/32; "Build purity check passed: source fingerprints were unchanged." |
| Focused runs while fixing | portal `test:ui` 43/43 and `portal-ui-api.test.mjs` 9/9; portal typecheck and lint exit 0; rollback tests 12/12; `check:scripts` passed; admin `test:openapi` 25/25; `test:contracts` passed; `test:docs-accuracy` 15/15. |

Not run, with reasons:

- Admin and backend e2e: no admin or backend route, UI or Worker logic
  changed; the admin change is two OpenAPI strings, which `test:contracts` and
  the admin `test:openapi` cover.
- The SDK legs and WSL CTest: no C++ or SDK source changed; the one CMake edit
  is a comment, and the Windows build-purity run covers it.
- `npm run test:docs-quickstart`: no documentation of the native install,
  local issuance or minimal-consumer journey changed.
- The live staging drill and production smoke: they need Cloudflare
  credentials and the operator actions above.

## Follow-ups

Not removed, with reasons:

- The `lccareq1` activation codec in `src/library/activation/` has no caller,
  but it is an offline feature, not compatibility code.
- A protected-only native consumer still needs an `lccgen`-generated project
  header (`src/library/os/signature_verifier.hpp:18-22`).
- The live TPM, browser and backend release gate, remote signer rotation
  qualification, the global fuse and the protected capacity harness remain
  open release items.
- The "online verifier" name survives in three places that should be renamed
  together, as one operator-visible decision:
  - the D1 database name `licensecc-online-verifier`
    (`services/cloudflare-d1-backup/src/core.ts:110`, the backend
    `wrangler.example.toml:45`, the deploy workflows and the
    `services/cloudflare-licensing-backend/scripts/entitlement.mjs:8`
    break-glass CLI default);
  - the backend Worker and service name `licensecc-online-verifier`
    (`services/cloudflare-licensing-backend/wrangler.example.toml:1`, the
    `/health` `service` field in `src/routes/meta.ts:21`, the rollback
    health check `scripts/check-worker-rollback-health.mjs:233` and the
    protected smoke
    `services/cloudflare-licensing-backend/scripts/protected-readiness-smoke.mjs:11`);
  - the admin `PUBLIC_VERIFIER_URL` binding
    (`services/cloudflare-license-admin/src/worker/env.ts:30,48`,
    `src/worker/groups/summary-reports/operations.ts:24` and
    `scripts/materialize-deploy-configs.mjs:422,539`).
- `LCC_API_ONLINE_PROJECT_SIZE`, `LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE` and
  `LCC_API_ONLINE_DEVICE_HASH_SIZE` keep their names because configuration
  tokens and `device_identity.h` share them.
- The `**/.online-key/` ignore rule in `.gitignore` and its mention in
  `CONTRIBUTING.md` stay. The script that wrote that directory is gone, but a
  developer machine may still hold one with private key material, and the
  session's permission policy refused to remove an ignore rule for secrets.
  Keeping it is harmless; removing it needs an explicit owner decision.
- The vendored generator installs its CMake package to both the Windows
  `cmake/` path and `lib/cmake/` (`extern/license-generator/CMakeLists.txt:96-100`).
  This is an install layout, not a data or protocol compatibility path, and
  the root package uses the same Windows path; changing it is a packaging
  decision.

Parked for a later change, one item each:

- An in-place baseline edit is a no-op for `wrangler d1 migrations apply` on
  an older database, which is why every database is recreated. Once there is
  live data, a post-migrate schema-signature check in the deploy workflows
  would catch a database that was not recreated.
- Clang reports `-Wtautological-pointer-compare` warnings in
  `public_api_symbols_are_linkable` (`test/library/public_api_test.cpp:307`);
  they predate this branch.
- The rewritten `docs-accuracy` test dropped two negative README guards;
  consider restoring the TPM `doesNotMatch` line.
- The runtime still accepts 1024-bit project keys, because the golden v201
  vectors use one, while `lccgen` refuses keys below 3072 bits. Schedule
  3072-bit golden vectors and give `current_v201_signature_policy`
  (`src/library/os/signature_verifier.hpp:209`) the same floor.
- `src/library/os/openssl/signature_verifier.cpp:48` calls
  `d2i_RSAPublicKey_bio`, which raises a deprecation warning. With OpenSSL 3.0
  as the floor it can move to the EVP or `OSSL_DECODER` API.
- CI still runs `apt-get install` with `zlib1g-dev` in the CodeQL, lint,
  Linux, native-security, platform-release and release-artifacts workflows,
  which may be dead weight; check that nothing links zlib before removing it.
- The .NET suite has no wrong-prefix token test: a token with another prefix,
  such as `lccoa1`, should be pinned to `VerifyFailureCode.Envelope`.
- A sync withdrawal whose body names a different owner is ignored without
  recording the mismatch in the audit `detail`.
- A sync idempotency key reused with a different body replays the first cached
  200, whereas admin create returns 409 `idempotency_request_conflict`. This
  predates the branch.
- The admin console can report "status could not be refreshed" when a create
  lands inside the list's 300 ms filter debounce. The e2e waits for the
  filtered list, but the race in the console remains.
- The webhook dispatcher's `reason` log field is not on `LOG_FIELD_NAMES`
  (`services/cloudflare-licensing-backend/src/observability/index.ts:8`), so it
  is dropped. This predates the branch.
- The admin grant PATCH's owner and licence check (`protectedOwnerReason` in
  `services/cloudflare-license-admin/src/worker/groups/entitlements/protected-checks.ts`)
  is a read before the write, not an assertion inside the batch. The window is
  narrow, and issuance re-checks the customer.
- The plan-projection `customer_id` paths trim a padded id instead of refusing
  it with 400, unlike create, PATCH and sync. This predates the branch.
- Webhook deliveries queued before a scope or URL change go to the endpoint's
  current URL, because delivery and redrive do not re-check the scope. This
  predates the branch.
- The admin `services/cloudflare-license-admin/src/worker/webhooks.ts` is 496
  lines, close to the 500-line hotspot threshold.
- Schema tightening, cheapest now while no data exists but only after an audit
  of every writer: `orders.customer_id` and
  `license_plan_assignments.customer_id` are still nullable
  (`services/cloudflare-licensing-backend/migrations/0001_baseline.sql:417`
  and `:335`), and
  `entitlements.trial_expiration_basis` (`:265`) lacks the CHECK constraint
  that `entitlement_policies.trial_expiration_basis` has (`:220`).
- `LCC_LICENSE_CHECK_OPTIONS_VERSION` was reset to 1, but
  `LCC_CONFIG_VERIFY_OPTIONS_VERSION` is still 3
  (`include/licensecc/datatypes.h:78,81`). Both are exact-match and neither
  was ever released, so the difference is cosmetic; pick one convention.
- `services/cloudflare-license-admin/scripts/sync-entitlement.mjs` reports a
  missing `--url` or token before an unknown option. This is cosmetic.
- `npm ci` reports four audit findings, two moderate and two high, all in
  development dependencies (`npm audit --omit=dev` reports none):
  `brace-expansion` 1.1.18 (high, through `eslint-plugin-import` and
  `minimatch` 3.1.5; `npm audit fix` resolves it within the existing ranges),
  and `undici` (high) through `miniflare` (moderate) through the pinned
  `wrangler` 4.140.0 (moderate), which npm says `wrangler` 4.145.0 fixes.
  Bump the four service Wrangler pins together, as `test:wrangler-pins`
  requires.
- Two admin e2e flakes appeared under full-suite load on the Windows host and
  passed on reruns: `admin-ui.feedback.e2e.mjs` failed once (it matches the
  300 ms debounce race above), and one `admin-ui.connections.e2e.mjs` run
  failed with `net::ERR_NO_BUFFER_SPACE` navigating to
  `http://127.0.0.1:4173/` (local TCP exhaustion from the parallel Playwright
  run). If either recurs, lower the admin suite's parallelism on Windows rather
  than retrying silently.
