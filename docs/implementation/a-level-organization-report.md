# A-level organization evidence report

## Status and scope

**A-level status: CONDITIONAL / PENDING.** The repository organization and
local gates have evidence, but the grade cannot be promoted while the reviewed
generator candidate is unpublished/unpinned and native Ubuntu CMake plus native
Doxygen/CI evidence is absent. CI links and run identifiers were not collected;
the results below are local evidence or accepted task evidence, never a claim
about a remote run.

This report covers Task 11 at base
`9b7bdef4dbf2e6cc97f676617fbdb4f01ba7dda3` on branch
`org/11-architecture-evidence`. The reviewed generator candidate is
`dbe2601f9bc0f55a386a14140d4b722b53348df6`, but it is unpublished and
unpinned: the superproject gitlink is `0227a3e` and the protected WIP nested
revision is `dbbaed0`. Promotion remains conditional on maintainer approval
and publication/pinning. The protected nested generator worktree is outside
the packet; the 15 existing untracked `.lic` files and untracked
`docs/superpowers/plans/**` were not staged, cleaned, or edited.

The documentation split is deliberate: `doc/` contains maintained project and
architecture documentation; `docs/superpowers/plans/` contains protected
execution plans; `docs/implementation/` contains evidence reports.

## Accepted implementation commits

The following task commits are the accepted evidence chain. Short SHAs are
preserved as supplied by the task packet; the generator candidate is explicitly
not accepted into the superproject.

| Task | Accepted commit(s) and provenance |
| --- | --- |
| Task 0 | `456f701270bf75040992c8e1bd0136fde8792fa2` |
| Task 1 | `d36c62f1c8f63ba6d2c58ae88bc95d489663aac8`, `2a8bf1854038e9b1c6fd3faaa30ed8ad61a8df58` |
| Task 2 | `21ef71b41ace61ef2e4caff1386915309f0dd8e9`; follow-up `83365aa7ca2fe4398d873e6cabfa57addff7df1a` (source `04ed6ee`) |
| Task 3 | Superproject `be6e551`, `8e5de1864006b85e5c4bf3e8057c333de449b08a`; final reviewed generator candidate `dbe2601f9bc0f55a386a14140d4b722b53348df6` remains unpublished/unpinned (superproject gitlink `0227a3e`, protected WIP `dbbaed0`). Promotion is conditional on maintainer approval and publication/pinning. |
| Task 4 | `15e7af553c167fcb1a2c94383d3e570a17ebab3b` |
| Task 5 | Integrated `dea865f` (source `5aab455`) |
| Task 6 | Integrated `142f453`, `c3dab95`, `10c64d6` |
| Task 7 | Integrated `9f3d0f5` (source `f3e3583`) |
| Task 8 | `a2ef469`, `d5146e2`, `9c7ec5c` |
| Task 9 | `e7bb8f91851febaf5031733b11c006340b916f3e` |
| Task 10 | `9b7bdef4dbf2e6cc97f676617fbdb4f01ba7dda3` |

## Dependency graph: before and after

Before the organization sequence, service implementation was concentrated in
deployable roots, admin and portal had 23 temporary direct imports into the
backend, each Worker carried an installation boundary, and route/OpenAPI
ownership was implicit. The C++ ABI/core and the platform slices were also
documented in separate local conventions.

The accepted result is:

```text
include/licensecc + src/library + CMake/test
                 |
                 v
       C++ ABI/core deployable surface

packages/licensing-domain
          ^
          |
packages/cloudflare-runtime
          ^
          |
  +-------+---------+---------+--------+
  |                 |         |        |
backend Worker   admin     portal   D1 backup
 + D1 owner     Worker/UI  Worker/UI  Worker/Workflow
```

Arrows point toward a dependency. The domain package is portable; runtime
contains only reusable Cloudflare/Web-platform mechanics; each service owns its
composition root, routes, OpenAPI inventory/fragments, service-specific SQL,
UI, tests, and deployment configuration. The root `package-lock.json` is the
only tracked **npm workspace** lockfile and covers the six workspaces;
SDK-specific lock/material files such as Python's `uv.lock` remain separate
concerns. `check:architecture`
reports no service-to-service debt and no package-to-service dependency.

## Hotspot responsibility audit

Tracked production-source line counts at the Task 11 base are evidence of
ownership pressure, not a quality score:

| Path | Lines | Responsible boundary / audit result |
| --- | ---: | --- |
| `src/library/licensecc.cpp` | 1,462 | C++ public API orchestration; pair ABI changes with public-header tests and CMake packaging. |
| `services/cloudflare-license-admin/src/worker/openapi/components.ts` | 988 | Admin contract components remain admin-owned. |
| `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs` | 1,091 | Backend order-ingest and exactly-once persistence remain backend-owned. |
| `services/cloudflare-licensing-backend/src/routes/verify.ts` | 985 | Backend verification and abuse controls are not shared implementation. |
| `services/cloudflare-customer-portal/src/ui/main.tsx` | 640 | Portal UI composition and customer workflows remain portal-local. |
| `services/cloudflare-d1-backup/src/core.ts` | 326 | D1 export/R2 backup orchestration remains backup-local. |

Composition-root measurements (Task 9 accepted final → current):

| Deployable | Task 9 | Current |
| --- | ---: | ---: |
| Backend `src/index.ts` / `src/app.ts` | 1 / 73 | 1 / 80 |
| Admin Worker `src/worker/index.ts` / `src/worker/app.ts` | 1 / 50 | 1 / 54 |
| Admin UI `src/ui/main.tsx` / `src/ui/app/App.tsx` | 4 / 75 | 6 / 81 |
| Portal Worker `src/worker/index.ts` / `src/worker/app.ts` | 2 / 67 | 2 / 75 |

Current service-source totals (TypeScript, TSX, JavaScript, and MJS under
tracked `src` trees) are: license-admin **10,940**, licensing-backend **5,946**,
customer-portal **3,480**, and D1-backup **568** lines. Large bounded-context
files remain local rather than being moved into a generic shared package.

## Contract and schema evidence

SHA-256 hashes of the reviewed canonical fixtures at the Task 10 base:

| Contract | File | SHA-256 |
| --- | --- | --- |
| Backend | `test/contracts/backend.json` | `4f80e2c81467ab9e3765b6b7274ce93f64c44e312e40e4047cc5b67b4a7d09d5` |
| Admin | `test/contracts/admin.json` | `b53fc33d05762b44dc2f0f3174b5758f40afaab07e15580cfffe3f28b38ce8c9` |
| Portal | `test/contracts/portal.json` | `b8aa4ddbcff8216036b9b1487b37875ae7be26ec91d9c1dd505d2a897a9f8817` |
| Backup | `test/contracts/backup.json` | `afe7676c22c35f5ca89f4e2882065b542018b1fd286b45e1fddff193d38705bf` |

The canonical contract fixture suite is **6/6** green; runtime contract
comparison reports backend **19** routes, admin **65**, portal **18**, and the
backup composition surface. D1 schema parity is green for both the SQLite/D1
snapshot and PostgreSQL translation; the PostgreSQL result reports **34
tables**. No contract or schema file was changed by this documentation packet.

## Command and test evidence

| Command/surface | Result |
| --- | --- |
| `npm run check:pr` | Green locally at the Task 10 base; scan, lint, typecheck, architecture, contracts, services, and schema gates completed. |
| Secret scan wrapper | **13/13** tests passed. |
| Architecture checker tests | **23/23** tests passed; production policy passed with empty service/hygiene allowances. |
| Contract tests | **6/6** tests passed; all four canonical hashes above unchanged. |
| Service and schema gate | Full package/Worker/SQL/UI/backup and schema-parity run green. Aggregate service TAP count was not separately collected in the Task 11 log; no failing suite was suppressed. |
| SDKs | Python **70/70**; .NET **43/43**. |
| Browser setup | One explicit `npm run setup:browsers` command installs both retained Playwright Chromium revisions. |
| Browser E2E | Backend **2**, admin **5**, portal **1** tests passed in the accepted Task 10 evidence. |
| Credential-free deploy checks | All four Worker dry-runs green. |
| Core Windows Task 0 | Full CTest **34/34** passed. |
| Isolated generator-candidate superproject check | Disposable short-path worktree at superproject `c306807614495027864b5bd8b809008df66671e4` with nested final reviewed candidate `dbe2601f9bc0f55a386a14140d4b722b53348df6`: embedded Debug configure/build and full CTest **37/37** passed. Logs: `build/fd-candidate/evidence/{identity,configure-debug,build-debug,ctest-debug}.log`. The published superproject remains at gitlink `0227a3e` while protected WIP is `dbbaed0`; candidate publication/pinning is conditional on maintainer approval. |
| Ubuntu native CMake | **Blocked/not-run**: the available WSL environment had no `cmake` executable; no tool installation was performed. |
| Strict raw Sphinx | Green locally using the pinned raw Sphinx command after the authored-page updates. |
| `npm run check:docs` | **Blocked/not-run to completion** on this host because `doxygen` is unavailable; the command fails closed before consuming stale XML. |
| CI links/run IDs | **not-collected**; no remote status is claimed here. |

## Required audit searches

The final verification searches are recorded as local evidence:

* `git ls-files pyvenv.cfg build dist .wrangler node_modules` returned only the
  tracked `build/.gitkeep` sentinel, not generated/local-environment output.
* `rg -n "submodule update|git -C extern/license-generator apply" CMakeLists.txt cmake scripts`
  found only the explicit `scripts/bootstrap.ps1` initialization action; no
  configure/check-time mutation command applies a patch or updates Git state.
* `rg -n "confirm_license.*return LICENSE_OK|release_license.*return LICENSE_OK" src/library/licensecc.cpp test/library`
  returned no placeholder public-API success assertion.
* The service-to-service import search found no production import edge; package
  manifests and service-local documentation references to the backend name are
  expected and are not implementation imports.
* The typecheck audit found no `checkJs:false`, `@ts-nocheck`,
  `@ts-ignore`, or `@ts-expect-error` production suppression. The intentional
  legacy JSDoc graphs remain explicitly closed with `checkJs:true` and
  quantified `noImplicitAny` debt: domain **80**, runtime **214**, backend
  **291**, portal **52** diagnostics.

Deletion proof was completed before removing the two obsolete files:
Excluding this evidence report, `rg` found no consumer of
`doc/analysis/Backoffice.txt` (the file itself said it was an old sketch to
remove) or `doc/snippets.txt`; `git ls-files` confirmed both were tracked and
`doc/snippets/hardware.cpp` was a separate retained snippet. No compatibility
shim or service code was deleted.

## Destructive-flow and smell audit

The final audit used the repository-wide code/design/anti-pattern/UX lanes.
Findings are classified as risks rather than bugs, and no legal conclusion is
made:

* **Insufficient evidence / resource-boundary policy risk — portal magic
  redeem.** `services/cloudflare-customer-portal/src/worker/support.ts:9,99-103`
  caps JSON through `readTextBody(..., 8192)`, while
  `src/worker/routes/auth.ts:115-125` accepts the interstitial through
  `request.formData()` with no equivalent explicit byte cap. The interstitial
  is intentional CSRF protection, so this is a bounded follow-up to validate
  form parsing limits, not a confirmed exploit or dark pattern.
* **Usability/policy risk — floating-seat release has no explicit confirmation.**
  `src/ui/main.tsx:567-569` binds the `Release` button directly to
  `seatAction(item, "release")`; by contrast, device release at lines 374-376
  calls `window.confirm` with consequence copy. This packet does not change the
  behavior; add a deliberate confirmation before treating the flow as safe for
  high-consequence release.
* **Usability/policy risk — catalog import Apply bypasses preview confirmation.**
  `services/cloudflare-license-admin/src/ui/features/catalog/Catalog.tsx:351-352`
  exposes `Preview import` and `Apply import` side by side, and the Apply path
  calls `runCatalogImport(false)` without requiring the preview result. The
  server remains authoritative and tests cover preview/apply; a rendered-flow
  review should decide whether an explicit preview/confirmation is required.

No confirmed deceptive/dark pattern was found. The listed risks are
transparent, reversible or policy-dependent signals requiring product-policy
and rendered-flow validation; no source or UI behavior was altered in this
docs packet. `npm audit` reported **6 inherited vulnerabilities**; severity
breakdown was not collected, so no severity is inferred here.

## Unresolved risks and exit gate

1. Final reviewed generator candidate
   `dbe2601f9bc0f55a386a14140d4b722b53348df6` is not a published/pinned
   submodule revision: the superproject gitlink is `0227a3e` and the protected
   WIP nested revision is `dbbaed0`. Publication/pinning remains conditional on
   maintainer approval; the protected nested worktree remains untouched.
2. Ubuntu Debug/Release native CMake and native Doxygen/Sphinx CI evidence is
   absent from this local environment; CI links/run IDs are `not-collected`.
3. The quantified legacy JSDoc `noImplicitAny` debt and six inherited npm audit
   findings remain; neither was broadened or hidden by this packet.
4. The three flow risks above need product/security review and rendered E2E
   evidence; they are not P0/P1 organizational blockers based on current
   evidence.

The organization exit gate is therefore **pending/conditional** until the
generator is published and pinned and the missing Ubuntu/native Doxygen/green
CI evidence is collected. All documentation, ownership, route/OpenAPI ADR,
build/bootstrap ADR, protected-state, local command, contract-hash, schema,
dry-run, and deletion-proof requirements in this packet have local evidence.
