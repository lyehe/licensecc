# Licensecc untangling decision log

## Task packet

- Objective: remove substantiated hidden co-change requirements, unnecessary
  dependencies, and dormant implementation paths across the first-party codebase,
  while preserving intended public behavior.
- Inspected base: `24b5a424d930a593cbbde57ddf9178601592a207` on
  `fix/ui-ux-gap-closure-20261025`; the tracked checkout and index were clean.
- Workflow: [untangle-codebase](https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md),
  inspected skill blob `102ff57803e504876f6eb9b412e4eb0f6c576350`.
- Authority: [change guide](../../doc/architecture/change-guide.md),
  [ownership](../../doc/architecture/ownership.md), ADRs 0001–0006, and
  [task packets and handoffs](../../CONTRIBUTING.md#task-packets-and-handoffs).
- Optional additions: the user selected both comment and test cleanup. Remove
  comments that only restate implementation, retain external constraints, and do
  test cleanup last. Preserve meaningful behavioral, security, ABI, contract,
  platform, and independent-vector coverage; replace brittle internal seams with
  behavior checks rather than deleting their assertions.
- Non-goals: public ABI, wire formats, route/OpenAPI contracts, D1 schema changes,
  deployment, publication, secret rotation, dependency upgrades, vendor changes,
  or edits to protected plans. Existing ignored recovery/build material is
  user-owned and excluded from the refactor.
- Coordination: root owns this log, release tooling, portal composition,
  portable support-contact validation, root lockfile generation, and integration
  gates. Worker packets below have disjoint ownership. No source edits preceded
  the initial read-only inventory.

## Redesign decisions and the problems they address

### B1. Share generated-binding compatibility types; keep binding declarations local

- Backend `src/env.ts:18`, backup `src/index.ts:29`, admin
  `src/worker/env.ts:5`, and portal `src/worker/env.ts:26` repeat the same four
  type helpers for widening generated bindings, runtime narrowing, and detecting
  incompatibility. A change to the compatibility rule requires four edits.
- Put these type-only mechanics in the Cloudflare runtime package. Each Worker
  retains its explicit generated-binding selection and runtime declaration.
  Backup must declare the package dependency; regenerate the root lockfile.

### B2. Make enrollment workflows depend on cryptography

- Backend `device/bound_enrollment.mjs:5` owns hashing, random identities, and
  comparison hashing used by rate limiting, retirement, issuance, and consent.
  Those workflows consequently load enrollment's workflow/database dependencies.
- Move the primitives into existing `bound_crypto.mjs`, preserving portable
  transcript ownership and every cryptographic byte.

### B3. Give order acceptance and nonce retention one timing-policy owner

- Backend `fulfillment/order_hmac.mjs:91` and `order_ingest.mjs:266` repeat
  default/capped skew parsing. One controls accepted requests and the other
  replay-nonce retention.
- Introduce one fulfillment-local policy function, retaining default 300 seconds,
  maximum 3600, existing integer/fallback rules, and the nonce-expiration formula.

### B4. Return single-deployable adapters to their actual owners

- Runtime `d1/plan_projection`, `entitlements/policy_store`, and
  `d1/idempotency_store` have only admin production callers. Runtime
  `webhooks/webhook` and `webhook_delivery_store` have only backend production
  callers. Test imports created the appearance of broader reuse.
- Move implementations, declarations, and owning tests to admin/backend, update
  callers and obsolete package exports, and retain genuine shared contracts and
  SQL mechanics. ADR 0001 already requires these ownership boundaries.
- Preserve exact SQL, atomicity, query/result contracts, and webhook behavior.

### B5. Depend directly on the auth primitive

- Runtime `auth/password.mjs:2` imports constant-time equality through the HTTP
  kit, although `auth/primitives.mjs` owns it.
- Import its owner directly; retain the existing HTTP export for its consumers.

### B6. Keep SQL inspection in test support

- Runtime `d1/entitlement_json.mjs:83` exports lexical inspection and argument
  assertion functions used only by `test/entitlement-json.test.mjs`.
- Move inspection into a test helper, retaining all SQL builder behavior and
  argument-cap assertions. This isolates test machinery rather than deleting
  behavioral tests.

### B7. Put backup Workflow contracts below its HTTP and scheduled adapters

- Backup `scheduled.ts:1` and `index.ts:17` import trigger payloads, bindings,
  and instance identity through `http.ts`.
- Move Workflow contracts/identity into a service-local owner consumed by all
  three adapters. Preserve manual auth/body handling and scheduled identities.

### B8. Give backup and restore one durable-table inventory

- Backup `snapshot-inventory.ts:12` and `scripts/restore-drill.mjs:34` repeat
  the same 23 table names and inventory algorithm identifier.
- Share those values in a service-local module consumable by the Worker and raw
  Node CLI. Retain independently pinned historical schema/index/trigger checks
  and the different producer, gate, and restore error contracts.

### U1. Own the consequence-mutation lifecycle once

- Admin Catalog repeats the lifecycle three times; Customers, Entitlements,
  Policies, and Webhooks each repeat it again. Immutable requests, initial/replay
  classification, same-key reconciliation, exact-read proof, and GET-only recovery
  consequently have seven implementations.
- Add an admin-local transaction runner. Endpoints retain request construction,
  guards, local success updates, context predicates, and refresh behavior. Preserve
  every distinction between an unknown result, initial refusal, replayed success,
  and failed post-success reads.

### U2. Share portal protected-device request mechanics

- Portal `shared/consentApi.ts` and `features/devices/bindingApi.ts` repeat
  timeout, credentials/cache/redirect policy, displayed-account preconditions,
  envelope validation, retry-after parsing, and unknown-outcome handling.
- Share transport locally; keep endpoint-specific methods, bodies, status tables,
  and response validators with their workflows. Preserve explicit session recovery.

### U3. Separate portal HTTP transport from React presentation

- `shared/api.tsx` combines session-aware transport with `StatusLine`.
  `portal-ui-api.test.mjs` must slice production source at the component declaration
  and remove imports to exercise transport.
- Move transport to `api.ts` and presentation to `StatusLine.tsx`; have tests
  exercise the real transport module, preserving their behavioral assertions.

### U4. Reuse canonical encoding in admin connection workflows

- `customers/connectionWorkflow.ts:17` and `:80` repeat canonical base64url
  decoding/round-trip and encoding already owned by the domain protocol module.
- Consume the existing exports, preserving exact identity byte-length checks.

### N1. Remove the dormant strict field-parser mode

- Native SignedToken, Python `_signed_token`, .NET `SignedTokenCore`, and Java
  `SignedToken` retain a boolean value-validation mode. Every remaining production
  caller disables it; its former protocol was removed.
- Remove the parameter, unreachable branches, and newly unreferenced private
  helpers. Preserve all currently active canonical configuration-token checks,
  including Java's existing upfront CR rejection.

### N2. Make Python native invocation result shapes explicit

- `DeviceBoundClient._call` infers outcome/scalar/prepare behavior from operation
  strings and `_OUTCOME_CALLS`, duplicating the ABI signature catalogue.
- Use shape-specific invocation helpers and a dedicated prepare path. Preserve
  nonblocking admission, all BUSY result shapes, validation, ownership/finalizers,
  and close waiting.

### N3. Keep native implementation dependencies out of declaration headers

- `LicenseReader.hpp` exposes INI/OS implementation headers and a parser macro
  although its declarations need neither. `SignedToken.hpp` pulls base64, OS,
  generated-key/signature implementation into codec callers.
- Move implementation includes to `.cpp`, add direct standard-library includes,
  and forward-declare the signature policy used by reference. No PIMPL or layout
  changes are needed.
- Independent review found the same issue in `hw_identifier_facade.hpp`: remove
  its self-include and unused container include, and depend directly on the
  generated properties header for its enum instead of the provider hierarchy.

### N4. Remove unused private registry mutations and CMake code

- EventRegistry's `append` and two insertion operators have no callers and bypass
  bookkeeping owned by `addEventWithSeverity`. Its ostream output is used.
- `cmake/utilities.cmake` defines only uncalled, unreferenced `EVAL_CONDITION`.
- Remove the unused paths and module, retaining the real event APIs and output.

### R1. Separate deployment evidence and target definitions from rollback

- `run-protected-wrangler.mjs` and `capture-worker-deployment-transition.mjs`
  import their deployment parser through the rollback command implementation.
- These commands, rollback, and config materialization separately enumerate the
  same Worker/config targets.
- Give stable deployment parsing and target definitions internal release owners.
  Preserve stable command paths, error/evidence shapes, exact config confinement,
  pinned executable selection, bounded capture, redaction, and polling policy.

### R2. Derive portal dispatch completeness from the reviewed inventory

- Portal `app.ts` validates dispatch/inventory correspondence in both directions,
  then additionally pins `ALL_ROUTES.length` to 29. A route addition requires an
  otherwise unrelated literal edit.
- Retain both completeness checks and canonical contract tests; remove the
  redundant production count literal.

### R3. Give support-contact validation one portable contract owner

- Portal `worker/support.ts` and `scripts/materialize-deploy-configs.mjs:109`
  independently define the same mailto/credential-free HTTPS policy. The script
  explicitly documents that its copy must mirror the Worker.
- Extract a pure domain parser consumed by both. Retain the Worker's existing
  trimming and URL normalization, and the materializer's existing input rules.

### R4. Evaluate local source checks against the actual candidate tree

- `report-hotspots.mjs` enumerates cached paths only and then reads each one.
  Moving an adapter before staging leaves its old cached path unreadable and its
  replacement uninspected. Newly introduced untracked production hotspots can
  evade local checking until staged.
- Use cached plus non-ignored candidate source, excluding files removed from the
  current worktree. Keep ignored build trees excluded. Add real Git-worktree
  regression coverage for an unstaged removal/rename and an untracked oversized
  source. Relocate existing baseline entries with their implementations without
  increasing their accepted line limits.
- Typecheck-coverage enumeration has the same cached-path blind spot. Apply the
  same candidate-tree rule and regression tests. Preserve strict existing admin
  TypeScript while checking its three relocated legacy JS bodies in an exact-file
  adapter project with their original implicit-any policy. Backup's shared
  inventory module retains fully strict checked JS. A new mixed graph is allowed
  only with `checkJs` and strict implicit-any checking; legacy exceptions remain
  closed and cannot broaden their includes or bypass the build/typecheck scripts.
- Architecture input already includes untracked candidates, but still attempts to
  read deleted cached paths. Filter its current candidate tree as well, retaining
  cached-only hygiene enforcement and a regression for an unstaged source move.
- The simplification follow-up puts Git file discovery in
  `scripts/ci/git-files.mjs`, shared by architecture, hotspot, typecheck-coverage,
  and documentation checks. Cached hygiene evidence and existing source candidates
  remain separate operations, so their policy cannot drift across four copies.

## Deliberate cases retained

- Language-independent verifiers, Windows/Linux TPM providers, checkpoint and
  enrollment/session state machines represent actual platform/protocol boundaries.
- Canonical bytes, framing, unsigned numeric lexemes, UTF-8 validation, signed
  expiry, no-throw ABI fences, and bounded parsing remain fail closed.
- D1 authority rechecks, conditional writes/`changes()`, disconnect-first order,
  recovery, exact idempotent replay, and conservative offline holds remain intact.
- Backup asynchronous-export polling, streaming/integrity/cancellation boundaries,
  historical restore compatibility assertions, and validation-specific error
  contracts are requirements, not generic retry/configuration opportunities.
- UI session epochs, displayed account/operator preconditions, immutable pending
  keys, sparse-page cursor guards, mounted consent ownership, exact refresh proof,
  and accessible focus recovery remain intact.
- Reviewed route inventories/OpenAPI snapshots and independently asserted
  architecture composition restrictions remain separate compatibility evidence.
- Vendored INI/generator sources, generated trees, secrets/local configuration,
  and protected execution plans are excluded from source refactoring.

## Execution and validation evidence

Initial read-only audits covered runtime/domain/backend/backup, both UI trees,
native/SDK/build boundaries, release/deployment scripts, and admin/portal Worker
composition. Three independent audit agents produced the B/U/N inventories.

Required integration commands: pinned `npm ci`, `npm run check:pr`,
`npm run test:sdks`, `npm run setup:browsers`, `npm run test:e2e`,
`npm run check:dry-run`, `npm run check:docs`, and
`pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`.
Focused owning-surface checks precede integration. Native installed-bridge and
platform-only coverage will be reported explicitly. No deployment, publication,
remote database mutation, or network documentation link gate is authorized here.

## Completed handoff

All 20 redesign clusters above are implemented, based on
`24b5a424d930a593cbbde57ddf9178601592a207`. Initial validation used an uncommitted,
unstaged patch. The active checkout is still the only registered worktree.
No public headers, canonical API
snapshots, D1 baseline/schema files, or version authority changed.

The admin now has one consequence-mutation lifecycle instead of seven copies.
Portal protected requests share transport while their endpoint guards and session
recovery remain local. Service-specific persistence and delivery adapters belong
to their deployables; common policy, SQL mechanics, and portable contracts retain
their shared owners. No hotspot ratchet was raised.

Comment cleanup removed implementation narration and obsolete descriptions,
retaining protocol, security, concurrency, platform, ABI, and UX constraints.
Test cleanup replaced exact-import/source-slicing seams with a real compiled UI
module graph, removed an export-list copy and a tautological count assertion, and
made the repository-suite check assert required inputs and exact-once execution
instead of one incidental command string. Meaningful behavior, vectors, SQL,
ownership, concurrency, and public-contract assertions remain.

Independent reviewers closed the native/SDK, UI, Worker/runtime, release-tooling,
and final checker findings. Five localized production adapters have identical
non-import executable ASTs to their originals, including SQL and webhook logic.
Crypto primitives and timing-policy extraction were also checked for executable
equivalence. Static TS/JS graph inspection found no runtime import cycles before
or after the refactor; erased type dependencies were considered separately.

### Toolchain

Validation used Node `24.20.0`, npm `10.9.8` through
`npx --yes npm@10.9.8`, uv `0.12.18`, Python `3.12.8` for PR/SDK checks,
.NET SDK `8.0.423`, Java `17.0.20`, and the installed Visual Studio 2022 CMake/MSVC
toolchain. The documentation command retains the project's explicit Python 3.13
selector and Doxygen requirement. Dependency versions were unchanged; the lockfile
adds only backup's declared runtime workspace dependency.

### Integration results

The npm commands below used the pinned npm prefix above. Process-local PATH and
tool variables selected the pinned toolchains; browser override URLs were cleared
so E2E used its local servers. Local raw logs are under ignored
`build/untangle-20261109/`.

| Command | Outcome |
| --- | --- |
| `npx --yes npm@10.9.8 ci` | Passed before implementation validation and again after lockfile refresh. |
| `npx --yes npm@10.9.8 install --package-lock-only --ignore-scripts` | Passed; three added lockfile lines declare backup's existing workspace dependency. |
| `npm run check:pr` | Passed: repository, secret, workflow, version, release, capability, lint, type, architecture, hotspot, contract, service, and schema-parity checks. |
| `npm run test:sdks` | Passed: Python 171 passed / 2 skipped; .NET 37 passed / 4 skipped; Java vectors and adapter checks passed. |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | Passed: configure/build and all 34 CTest targets; source fingerprints unchanged. |
| `npm run setup:browsers` | Passed for both UI workspaces. |
| `npm run test:e2e` | Passed: 8 backend, 227 admin, and 150 portal checks. |
| `npm run check:dry-run` | Passed: all four Workers bundled with repository-pinned Wrangler. |
| `npm run check:docs` | Passed: Doxygen and strict Sphinx HTML build. |
| `git diff --check` | Passed; Git emitted line-ending normalization notices. |
| `git diff --exit-code -- include test/contracts services/cloudflare-licensing-backend/migrations services/cloudflare-licensing-backend/schema.sql version.json` | Passed; those public/authority surfaces are unchanged. |

Focused checks before integration also passed:

- `node --test scripts/rollback-workers.test.mjs scripts/materialize-deploy-configs.test.mjs scripts/report-hotspots.test.mjs`
  — 37 passed at that stage.
- `node --test packages/licensing-domain/test/support-contact.test.mjs` — 2 passed.
- `node --test scripts/check-typecheck-coverage.test.mjs scripts/report-hotspots.test.mjs`
  — 9 passed, including actual temporary Git repositories.
- `node --test scripts/check-architecture.test.mjs` — 28 passed, including source
  rename, ignored source, and dangling imports after an unstaged target deletion.
- `node scripts/check-architecture.mjs` — passed.
- `node --test scripts/workflow-action-pins.test.mjs` — 20 passed.
- `node --test scripts/docs-accuracy.test.mjs` — 18 passed with refreshed candidate
  source and composition measurements.
- Both workspaces' `test:ui`, `typecheck`, and `lint` — passed; final UI suites
  were admin 140 and portal 49.
- Owning Worker checks passed: runtime 29; admin SQL 204; backend 230 unit plus
  345 SQL/workerd; backup 96. Focused crypto/HMAC/order checks passed 143 cases.
- Native/SDK-focused Python config/device-bound/feature-session checks passed
  160 cases with 2 installed-fixture skips; full SDK results are recorded above.

### Findings resolved during validation

- The first native build exposed `LicenseVerifier`'s transitive dependency on
  `FUNCTION_RETURN`; its header now directly includes the type owner.
- The next native build exposed an unused hardware-test local constructed through
  the old facade include chain. Its constructor was empty. Removed that local and
  unused test imports, added direct algorithm/vector includes, and retained all
  three hardware integration tests and assertions. The subsequent complete native
  purity run passed.
- An initial admin SQL run used stale compiled output; rebuilding the Worker
  resolved it without weakening tests.
- The first aggregate PR attempt rejected the newly added coverage suite because
  its test pinned the old command text. The test now asserts safe direct inputs,
  all six required suites, uniqueness, and the unchanged outer exact-once gates;
  the next aggregate PR run passed.
- Final independent review caught deleted cached paths still participating in
  architecture resolution after source-read filtering. Resolution now uses only
  actual candidates/production files; hygiene still uses the complete cache.
  This last checker correction landed during the end of the passing aggregate
  run and was freshly revalidated with all 28 architecture tests, the real
  architecture command, and full `npm run lint`. The reviewer confirmed closure.

### Relevant checks not run

- Installed Python/.NET native bridge and Java JNI checks: no installed bridge
  fixture was configured. The SDK reports expose these skips. Two additional
  .NET cases require Linux and were skipped on Windows.
- Linux/macOS native builds and real TPM/browser/backend qualification: this was
  local Windows validation; no provider behavior or public ABI changed.
- `npm run test:docs-quickstart`: installation, issuance, minimal-consumer code,
  and their documentation were unchanged.
- `npm run check:docs:links`: the separate scheduled/manual network gate was not
  requested.
- Live deployment, publication, remote databases, and release assembly/publication
  are outside this refactor. Dry-runs and deterministic release tests ran instead.

Status: implementation, selected comment/test cleanup, independent review, and
required local validation complete. No remaining structural finding from the
audits is awaiting implementation.

## Simplification and publication follow-up — 2026-11-10

The user's follow-up requested simplification, commit, and push. Shared Git file
discovery replaces four repeated implementations without changing source or
hygiene boundaries. The existing real-Git regressions cover unstaged moves,
deleted import targets, ignored output, untracked source, and strict typechecking.
The focused architecture/hotspot/coverage/documentation/catalog run passed all
59 tests after this simplification. The real architecture, coverage, hotspot,
and whitespace checks also passed.

Publication target: `origin/fix/ui-ux-gap-closure-20261025`. Only task-owned source,
tests, and documentation are included; generated and local recovery material
remain ignored. Pinned `npm ci` and `npm run check:pr` both passed on the final
staged patch. Logs are retained locally in `build/simplify-publish-20261110/`.
Runtime code is unchanged from the full SDK/native/browser/packaging/documentation
proof above.
