# Repository DX and Long-Term Expansibility Implementation Plan

Date: 2026-07-06

## Objective

Make the current `main` branch easier to develop, verify, and extend before merging or expanding the SDK, service, database-backend, and licensing-tier work.

This plan is intentionally sequenced so the repository becomes clean and reproducible first. Feature/platform integration comes after source ownership, generated-file boundaries, local validation, and documentation are stable.

## Current-State Evidence

- `git status --short --branch` on `main` shows untracked `.wrangler/`, `dist/`, `doc/_doxygen/`, `sdks/`, and `services/`.
- Tracked `main` is currently mostly the C++ library: `src`, `test`, `doc`, `cmake`, `examples`, `include`, `benchmark`, and CI workflows.
- `feature/operations-back-office` contains the larger platform shape: `services/`, `sdks/`, database backend docs, package manifests, E2E tests, and improved generated-file ignore rules.
- The current implementation worktree has imported the backend, admin portal, customer portal, D1 backup service, Python SDK, .NET SDK, and shared golden-vector fixtures.
- `CMakeLists.txt` currently defaults generated project files into the source tree through `LCC_PROJECTS_BASE_DIR="${CMAKE_SOURCE_DIR}/projects"`.
- At plan creation, README and CONTRIBUTING still described old Travis/GitFlow/develop/master workflows while current active work was on public `main` with GitHub Actions.

## Non-Goals

- Do not redesign the license model in this pass.
- Do not merge the whole operations/platform branch as one large undifferentiated change.
- Do not add new CI workflows before the equivalent local commands exist.
- Do not delete untracked service/SDK work until it is either preserved on the intended branch or confirmed generated/disposable.

## Success Criteria

- A clean clone can configure, build, test, and verify the core C++ project from documented commands.
- A normal local build does not dirty the source tree.
- Generated outputs are ignored consistently across C++, docs, Python, .NET, Node, Vite, Wrangler, and Playwright surfaces.
- The repo has one documented local validation entry point for core, service, SDK, UI, E2E, schema-parity, and dry-run checks.
- README and CONTRIBUTING reflect the current branch, license, CI, and contribution workflow.
- The monorepo shape has clear ownership boundaries: C++ core, licensing backend, SDKs, portals, DB adapters, docs, and release artifacts.

## Implementation Status

Initial implementation pass completed on 2026-07-06:

- generated-output ignore rules,
- build-tree default for generated license project files,
- `CMakePresets.json`,
- `scripts/dev-check.ps1`,
- README and CONTRIBUTING refresh,
- current development workflow refresh,
- `Findlccgen.cmake` compatibility fix for the `LCC_LOCATION` path on newer CMake versions.
- backend service slice import from `feature/operations-back-office`,
- Python and .NET SDK slice import from `feature/operations-back-office`,
- shared golden-vector fixtures under `test/vectors/`,
- LF line-ending policy for byte-sensitive test vectors,
- backend DB-backend status documentation.
- admin portal, customer portal, and D1 backup service slice import from `feature/operations-back-office`,
- root `package.json` service orchestration scripts,
- local Wrangler config ignore rules that keep `wrangler.example.*` templates visible,
- expanded `scripts/dev-check.ps1` switches for services, UI workflow tests, browser E2E, schema parity, dry-runs, and service-only runs.
- existing Linux and Windows workflows now call `scripts/dev-check.ps1` with CI presets, preserving the Linux Debug/Release and Windows Debug/Release static/dynamic matrix coverage.

Verified in this pass:

- Boost 1.84.0 installed at `C:\local\boost_1_84_0` for local MSVC validation.
- `cmake --list-presets`, build presets, and test presets parse.
- `cmake --build build/dx-smoke2 --target licensecc_static --config Debug` passes with generated project files under the build tree.
- Focused core C++ library CTest set passes: 10/10.
- `npm --prefix services/cloudflare-licensing-backend run test` passes: 233/233.
- `npm --prefix services/cloudflare-licensing-backend run test:sql` passes: 116/116.
- `npm --prefix services/cloudflare-licensing-backend run test:db` passes: 3/3.
- `npm --prefix services/cloudflare-licensing-backend run test:pg` passes: 18/18.
- `uv run --directory sdks/python pytest` passes: 70/70.
- `dotnet test sdks/dotnet/Licensecc.Client.sln` passes: 43/43.
- `npm --prefix services/cloudflare-license-admin run test` passes: 54/54.
- `npm --prefix services/cloudflare-license-admin run test:ui` passes: 45/45.
- `npm --prefix services/cloudflare-license-admin run test:e2e` passes: 4/4.
- `npm --prefix services/cloudflare-customer-portal run test` passes: 51/51 plus 9/9 for the secondary node test invocation.
- `npm --prefix services/cloudflare-customer-portal run test:ui` passes: 8/8.
- `npm --prefix services/cloudflare-customer-portal run test:e2e` passes: 1/1.
- `npm --prefix services/cloudflare-d1-backup run test` passes: 38/38.
- service lint scripts pass for backend, admin portal, customer portal, and D1 backup.
- `npm --prefix services/cloudflare-licensing-backend run schema:parity` passes.
- `npm --prefix services/cloudflare-licensing-backend run schema:parity:pg` passes.

Remaining work starts with larger modularization, stricter TypeScript coverage, CI/local-command parity cleanup, and resolving the unrelated dirty `extern/license-generator` WIP. The default core `scripts/dev-check.ps1` intentionally stops early while that submodule has local modifications; preserve or clean that submodule before using the default core check as a full green signal.

## Phase 0: Preserve and Classify Current Local State

Goal: prevent accidental loss or accidental commit of the untracked service/SDK/platform work.

Files touched: none unless a preservation branch or stash is created.

Implementation steps:

1. Record current state.
   ```powershell
   git status --short --branch
   git branch --all --verbose --no-abbrev
   git diff --stat main..feature/operations-back-office
   ```
2. Classify each untracked root:
   - `.wrangler/`: generated Cloudflare local state.
   - `dist/`: generated build output unless proven otherwise.
   - `doc/_doxygen/`: generated documentation output.
   - `sdks/`: source-like platform work from the feature branch plus generated Python/.NET outputs.
   - `services/`: source-like platform work from the feature branch plus generated Node/Wrangler/Vite outputs.
3. Preserve source-like local work before cleanup.
   - Preferred: work in a separate worktree for `feature/operations-back-office`.
   - Acceptable: ensure the feature branch already contains the intended source files.
   - Avoid: `git add -A` from `main` while generated output is mixed with source-like files.

Verification:

```powershell
git ls-files sdks services
git ls-tree -r --name-only feature/operations-back-office services sdks | Select-Object -First 40
```

Done criteria:

- There is a written decision for each untracked root: keep as source, ignore as generated, move to feature branch, or delete after dry-run review.
- No generated dependency tree, build output, local DB, secret-bearing config, or cache is staged.

Rollback:

- If cleanup removes too much, restore from the feature branch, stash, or filesystem backup before continuing.

## Phase 1: Generated-File and Repo-Hygiene Boundary

Goal: make `git status` meaningful after normal development.

Files to change:

- `.gitignore`
- Optional follow-up: `.gitattributes` if line endings or generated docs need normalization.

Implementation steps:

1. Extend `.gitignore` for generated and local-only outputs:
   ```gitignore
   /doc/_build/
   /doc/_doxygen/
   /.wrangler/
   /dist/
   /build-fuzz-probe/
   **/node_modules/
   **/dist/
   **/dist-worker/
   **/.wrangler/
   **/playwright-report/
   **/test-results/
   **/.dev.vars
   **/.online-key/
   **/__pycache__/
   **/*.pyc
   **/bin/
   **/obj/
   ```
2. If services are not being merged to `main` yet, keep broad generated rules but do not ignore all of `services/` or `sdks/`; that would hide real source work later.
3. Run a dry-run cleanup only after verifying preservation:
   ```powershell
   git clean -ndX
   ```
   Do not run destructive cleanup until the listed paths are reviewed.

Verification:

```powershell
git status --short
git check-ignore -v .wrangler dist doc/_doxygen
```

Validation:

- Build/test once and confirm generated outputs remain ignored.
- `git status --short` should show only intentional source changes.

Done criteria:

- Generated files no longer obscure real work.
- Source-like `sdks/` and `services/` remain visible if they are not tracked yet.

## Phase 2: Source-Tree-Clean CMake Defaults

Goal: make configure/build/test reproducible and non-mutating by default.

Files to change:

- `CMakeLists.txt`
- `doc/development/Build-the-library.md`
- `doc/development/Build-the-library-windows.rst`
- Optional: new `CMakePresets.json`

Implementation steps:

1. Change the default project base directory from the source tree to the build tree:
   ```cmake
   set(LCC_PROJECTS_BASE_DIR "${CMAKE_BINARY_DIR}/projects")
   ```
2. Keep `LCC_PROJECTS_BASE_DIR` overridable for release/package workflows that intentionally generate project material elsewhere.
3. Reconsider `CMAKE_DISABLE_SOURCE_CHANGES OFF`.
   - Preferred default: do not permit source-tree changes during normal configure.
   - If generator behavior still requires writes, constrain those writes to `${CMAKE_BINARY_DIR}` by default.
4. Update status messages so developers can see where generated keys and headers are written.
5. Add a documented opt-in example for source-tree project generation, if that workflow is still supported.

Verification:

```powershell
cmake -S . -B build/dx-clean -DLCC_PROJECT_NAME=test
cmake --build build/dx-clean --target licensecc_static --config Debug
ctest --test-dir build/dx-clean -C Debug --output-on-failure
git status --short
```

Validation:

- `projects/` should not receive generated files during the default configure.
- The generated public key include path must still resolve during compilation.
- Existing tests continue to pass.

Done criteria:

- Default CMake configure/build/test does not modify tracked or untracked source-tree project files.
- Docs match the new default.

## Phase 3: Developer Command Surface

Goal: give contributors one predictable local path before they rely on CI.

Files to change:

- New `CMakePresets.json`
- New `scripts/dev-check.ps1`
- Optional cross-platform shell equivalent later: `scripts/dev-check.sh`
- README build/test sections

Implementation steps:

1. Add CMake presets:
   - `dev-debug`: default local debug build.
   - `dev-release`: local release build.
   - `ci-linux-core`: mirrors Linux core CI options.
   - `ci-windows-msvc`: mirrors Windows MSVC CI options where practical.
2. Add `scripts/dev-check.ps1` with focused checks:
   - verify submodule availability,
   - configure via preset,
   - build core library and tests,
   - run `ctest`,
   - report whether optional service/SDK work is present but untracked.
3. Keep service/SDK checks optional so core-only contributors are not forced through Node, Python, and .NET tooling.
4. Add package-level delegates:
   - backend: `npm --prefix services/cloudflare-licensing-backend run test`
   - backend DB: `npm --prefix services/cloudflare-licensing-backend run test:db`
   - backend PG fenced adapter: `npm --prefix services/cloudflare-licensing-backend run test:pg`
   - admin/customer portals: package `test`, `test:ui`, and `test:e2e`
   - D1 backup: package `test`
   - schema parity: `schema:parity` and `schema:parity:pg`
   - deployment dry-runs using tracked example Wrangler configs
   - Python SDK: `pytest` or `uv run pytest`
   - .NET SDK: `dotnet test`

Verification:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1
```

Validation:

- A failed prerequisite should produce a clear local message, not require reading GitHub Actions logs.
- Existing CI can later call the same script or equivalent commands.

Done criteria:

- README has one recommended local verification command.
- CI workflow commands and local commands no longer drift silently.

## Phase 4: Documentation Refresh

Goal: remove stale onboarding instructions and document the real project shape.

Files to change:

- `README.md`
- `CONTRIBUTING.md`
- `doc/analysis/Development-And-Usage-Workflow.md`
- `doc/analysis/features.rst`
- Optional: `doc/index.rst` if the new plan should be linked from generated docs.

Implementation steps:

1. Replace stale Travis/develop/master/GitFlow guidance with the current workflow:
   - public `main`,
   - AGPL-3.0-or-later,
   - GitHub Actions status,
   - local verification first,
   - pull requests against current active branch policy.
2. Add a concise repo map:
   - `src/`: C++ implementation,
   - `include/`: public API,
   - `test/`: C++ test suite,
   - `cmake/`: build discovery modules,
   - `examples/`: tracked examples,
   - `doc/`: documentation source,
   - `services/`: platform services,
   - `sdks/`: SDK packages.
3. Update build examples to use out-of-source configure from the repo root.
4. Mark service/SDK/database-backend status precisely:
   - tracked on `feature/operations-back-office`,
   - not yet part of `main` until deliberately merged.

Verification:

```powershell
rg -n "Travis|travis|develop|master|GitFlow|gitflow" README.md CONTRIBUTING.md doc/analysis
```

Validation:

- Remaining references to old branch names are historical only, explicitly labeled, or removed.
- A new contributor can identify the correct branch, license, build command, test command, and source layout.

Done criteria:

- README and CONTRIBUTING are internally consistent with current repository reality.

## Phase 5: Controlled Platform/Monorepo Integration

Goal: merge service, SDK, DB, and portal work in reviewable slices instead of as one large branch dump.

Files likely involved:

- `services/cloudflare-licensing-backend/**`
- `services/cloudflare-license-admin/**`
- `services/cloudflare-customer-portal/**`
- `services/cloudflare-d1-backup/**`
- `sdks/python/**`
- `sdks/dotnet/**`
- `docs/db-backends.md` or equivalent under the chosen docs root
- `.github/workflows/**` only after local commands exist

Implementation slices:

1. Backend foundation:
   - bring in backend source, package manifest, migrations, schema, local-host SQLite adapter, and unit tests.
   - exclude `node_modules`, `dist`, `.wrangler`, local DB files, and secrets.
2. DB backend contract:
   - document D1-shaped contract,
   - keep Cloudflare D1 as production default,
   - keep Local SQLite as supported local/dev backend,
   - keep PostgreSQL/Supabase as fenced partial adapter until promotion gates pass.
3. SDKs:
   - add Python SDK with `pyproject.toml`, tests, and README.
   - add .NET SDK with solution, test project, lockfile policy, and README.
4. Portals:
   - add admin/customer portal source with build/test scripts.
   - keep E2E tests local-command runnable before wiring CI.
5. Release/readiness:
   - add deployment runbooks only after source and tests are tracked.
   - avoid adding secret-bearing `wrangler.toml`; track examples/templates instead.

Verification per slice:

```powershell
git status --short
rg --files services sdks -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/bin/**' -g '!**/obj/**'
npm --prefix services/cloudflare-licensing-backend run test
npm --prefix services/cloudflare-licensing-backend run test:db
npm --prefix services/cloudflare-licensing-backend run test:pg
uv run --directory sdks/python pytest
dotnet test sdks/dotnet/Licensecc.Client.sln
```

Validation:

- Each slice has tests that fail if its source is omitted or generated output is accidentally committed.
- Service deploy configs use example files for public source and local secret files for private state.

Done criteria:

- `git ls-files services sdks` shows only intentional source, tests, docs, migrations, manifests, and lockfiles.
- All generated outputs are ignored.

## Phase 6: Long-Term Extension Boundaries

Goal: make future features such as node-locked licenses, floating licenses, tier gates, updates, and multiple database backends fit naturally.

Implementation steps:

1. Define bounded contexts:
   - C++ core: offline verification, hardware identity, local license checks.
   - Licensing backend: account, entitlement, lease, catalog, metering, audit, webhook, and API policy.
   - SDKs: thin clients and offline token verification, not business-policy owners.
   - Portals: UI workflows only; server remains source of truth.
   - DB adapters: D1-shaped persistence contract with conformance tests.
2. Make feature/tier gating policy server-owned:
   - license and entitlement data describe features,
   - server policy decides enabled/disabled features,
   - clients display or enforce based on signed assertions or API responses,
   - SDKs do not hard-code commercial tiers.
3. Make backend support explicit:
   - D1: production default.
   - SQLite: local/dev and deterministic tests.
   - PostgreSQL/Supabase: fenced adapter until promotion gates pass.
4. Require a conformance test suite for every new backend:
   - migrations apply cleanly,
   - transaction/idempotency semantics are verified,
   - entitlement mutation tests pass,
   - lease and metering paths pass,
   - API smoke tests pass.

Verification:

- Add or update architecture docs that name the owner of each policy.
- Add tests that prove a new feature flag/tier is decided once and reflected across API, SDK, and UI.

Validation:

- A new feature gate should require one policy change plus tests, not scattered UI/backend/SDK conditionals.
- A new DB adapter should run the same contract test suite as D1/SQLite.

Done criteria:

- Extension points are backed by tests and docs, not implied by folder names.

## Phase 7: CI Parity Without CI-Only Logic

Goal: keep GitHub Actions useful without making it the only place the project can be validated.

Files to change:

- Existing `.github/workflows/linux.yml`
- Existing `.github/workflows/windows.yml`
- Future service/SDK workflows only after local scripts exist
- `scripts/dev-check.ps1`

Implementation steps:

1. Keep existing core CI green.
2. Move repeated dependency/bootstrap logic into scripts where practical.
3. Have workflows call documented local commands or equivalent presets.
4. Add service/SDK workflows only after each package has a local `test`, `build`, and `dry-run` story.
5. Avoid workflow-only validation that developers cannot reproduce locally.

Verification:

```powershell
git grep -n "cmake -S\\|cmake --build\\|ctest\\|npm --prefix\\|dotnet test\\|pytest" -- .github scripts README.md
```

Validation:

- For every CI check, README or scripts show the local equivalent.
- Workflow failures map to commands contributors can run on their machine.

Done criteria:

- CI is a remote executor of documented checks, not a separate implementation of project knowledge.

## Execution Order

1. Phase 0: preserve and classify current local state.
2. Phase 1: update ignore rules and clean generated-file visibility.
3. Phase 2: make CMake source-tree-clean by default.
4. Phase 3: add presets and local dev-check command.
5. Phase 4: refresh README and CONTRIBUTING.
6. Phase 5: integrate backend, DB, SDK, and portal work in slices.
7. Phase 6: formalize extension boundaries and policy ownership.
8. Phase 7: align CI to local commands.

## First Commit Recommendation

The first implementation commit should be deliberately small:

- `.gitignore` generated-output rules.
- CMake default project directory moved to the build tree.
- `CMakePresets.json` for core local builds.
- `scripts/dev-check.ps1` for core local validation.
- README/CONTRIBUTING updates for current branch/build/test workflow.

Validation for the first commit:

```powershell
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --test-dir build/dev-debug -C Debug --output-on-failure
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1
git status --short
```

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Accidentally committing generated service/SDK output | High | High | Phase 0 classification plus Phase 1 ignore rules before any broad staging |
| Losing untracked platform work | Medium | High | Preserve via feature branch/worktree before cleanup |
| CMake include paths break after moving generated project dir | Medium | High | Build `licensecc_static` and run CTest immediately after change |
| Docs overstate platform support on `main` | Medium | Medium | Keep support status tied to imported, tested slices and avoid implying deployment readiness without dry-run/staging evidence |
| CI passes but local developers cannot reproduce | Medium | Medium | Add local scripts/presets before workflow expansion |
| Multiple DB backend support becomes speculative | Medium | Medium | Require conformance tests and promotion rules per backend |

## Final Verification Checklist

- [ ] `git status --short` is clean after a normal configure/build/test and after intentional source changes are committed.
- [x] `.gitignore` keeps generated output out of status without hiding source.
- [x] CMake default project generation occurs under the build tree.
- [x] README has current build/test/contribution instructions.
- [x] CONTRIBUTING no longer points contributors at stale branch policy.
- [x] `scripts/dev-check.ps1` runs core local verification and optional package gates.
- [x] Service/SDK integration is split into reviewable slices.
- [x] Each future DB backend has a documented status and conformance test gate.
- [ ] Existing CI remains green remotely.
- [x] Existing CI maps to documented local commands.
