# A-level organization evidence report

## Verdict

**A-level status: CONDITIONAL / PENDING.** The repository is well organized at
the reviewed implementation tip and its local deterministic gates are strong.
It is not yet an unconditional A because the final generator candidate is not
published and pinned, native Ubuntu and remote-CI evidence has not been
collected, and this Windows host cannot complete the documentation gate without
Doxygen.

| Dimension | Evidence at the reviewed tip | Assessment |
| --- | --- | --- |
| Ownership and dependency direction | Architecture gate is green; no production service-to-service import edge | A |
| API and schema governance | Canonical contracts, D1/PostgreSQL parity, exact transition evidence, and OpenAPI checks are green | A |
| Mutation safety | Catalog/projection capabilities, CAS transitions, atomic idempotency, and Free-tier query caps are migration-backed | A |
| Operator UX | Consequence-led dialogs, immutable replay, exact response proof, current-read recovery, focus, and pagination fences have browser coverage | A |
| Supply-chain hygiene | npm and workflow pins are exact; the 2026-08-09 audit attestation reports zero vulnerabilities | A |
| Release provenance | Reviewed generator candidate remains unpublished/unpinned | Pending |
| Cross-platform/documentation evidence | Windows is green; Ubuntu, Doxygen, and remote run identifiers are absent | Pending |

This is an evidence grade for organization and release readiness, not a claim
that every planned product feature exists. In particular, Windows/Ubuntu TPM
provider integration remains plan-only and this service does not claim TPM
support.

## Reviewed tree and protected state

The final integrated implementation tip is
`4f33243b09f27db83e090b914f2fb0d776c34302` on
`org/11-architecture-evidence`. Its final server/UI integration packets are:

| Purpose | Commit |
| --- | --- |
| Catalog, projection, and transition server integration | `a054d50a47f86fff9ef070a2615263ef6aee6874` |
| Free-tier entitlement batch budget | `550080adfcb1e62aa904a34f600df5643de63e9b` |
| Stale batch-cap cleanup | `f68a0df` |
| Consequence-led catalog-import UI integration | `26464bc17a8e7cf71ce1737c83f3a80c13776305` |
| Exact retained catalog replay proof | `b67d36a390f342999c3d1483710da54c5b8a7d12` |
| Focus preservation after stale replay | `eb68c5d243f40fdafeaed54f26e0ade3068ae88f` |
| Generated Wrangler binding-to-Env enforcement | `8b2343719b1c517a0d9789a518d22971424ab7f3` |
| Generated binding-kind compatibility enforcement | `4f33243b09f27db83e090b914f2fb0d776c34302` |

The final reviewed generator candidate
`74996a7d345df7b9a7cb46a08d423cb738217ed1` remains
unpublished/unpinned. The superproject gitlink `0227a3e` was not moved, while
the protected WIP `dbbaed0` and its 15 existing untracked `.lic` fixtures were
preserved. Publication and pinning are conditional on maintainer approval and
publication/pinning. The 3 untracked `docs/superpowers/plans/**` execution
plans were likewise preserved.

The documentation split is intentional:

- `doc/` contains maintained project and architecture documentation.
- `docs/superpowers/plans/` contains protected execution plans.
- `docs/implementation/` contains evidence reports.

## Resulting dependency and ownership model

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

Arrows point toward a dependency. The portable domain package owns shared
business contracts. The runtime package owns reusable Cloudflare/Web-platform
mechanics. Each deployable owns its composition root, routes, OpenAPI
fragments, service-specific persistence, UI, tests, and Wrangler configuration.
The root `package-lock.json` is the sole npm-workspace lockfile; SDK-native lock
files remain within their own ecosystems.

Current tracked service-source totals (TypeScript, TSX, JavaScript, and MJS)
show substantial bounded contexts without moving service behavior into a
generic dumping-ground package:

| Boundary | Files | Lines |
| --- | ---: | ---: |
| Admin | 90 | 16,432 |
| Licensing backend | 33 | 6,300 |
| Customer portal | 25 | 4,464 |
| D1 backup | 5 | 637 |

The deployable composition roots remain small:

| Composition boundary | Entry lines | App lines |
| --- | ---: | ---: |
| Backend Worker | 1 | 98 |
| Admin Worker | 1 | 55 |
| Admin UI | 6 | 81 |
| Portal Worker | 2 | 69 |

Large implementation files remain explicitly owned hotspots rather than
implicit architecture:

| Owned hotspot | Lines |
| --- | ---: |
| `src/library/licensecc.cpp` | 1,462 |
| `services/cloudflare-license-admin/src/worker/openapi/components.ts` | 1,308 |
| `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs` | 1,159 |
| `services/cloudflare-licensing-backend/src/routes/verify.ts` | 994 |
| `services/cloudflare-customer-portal/src/ui/main.tsx` | 875 |
| `services/cloudflare-d1-backup/src/core.ts` | 326 |

## Integrated correctness and organization outcomes

- Catalog import now uses an actor-bound, expiring Preview capability and one
  atomic Apply batch, with exact effects, source-generation fencing, rollback,
  consumption, replay, and a 13-action/Free-tier query budget.
- Plan projection snapshots are versioned and fail closed across rolling
  deployment, include the private cache TTL in internal reconciliation, scrub
  that field from outbound webhooks, fence legacy identities, bound cleanup,
  validate safe epochs, and durably audit assignment-only changes.
- Entitlement and device transitions use identity/status/sequence CAS. Their
  dependent audit, policy, device, and idempotency statements are claim-gated;
  same-key collection races roll back and replay the authoritative response.
- Entitlement batch transitions are single-sourced at four IDs, reject five
  before any D1 query, and stay below the 50-query Free-tier ceiling in changed,
  no-op, and CAS-race paths.
- Admin destructive flows retain an immutable request body and idempotency key
  until exact applied/unapplied proof, separate mutation proof from refresh
  proof, reject malformed success evidence, fence stale/ABA reads, prevent
  cursor cycles and duplicate pages, and preserve keyboard focus.
- Catalog Apply is consequence-led and preview-ID-only. Its dialog shows exact
  typed targets/deltas, supports cancel/Escape/single-submit behavior, and
  accepts only a response that deep-matches the confirmed preview binding.
- Portal credentialed proxying uses manual redirects and bounded validated
  bodies; magic-link bodies, floating-seat release, webhook redirects, and
  response cancellation have explicit security and accessibility coverage.
- Wrangler and GitHub Actions are immutable-version pinned with repository
  gates that reject drift.
- Each Worker's effective environment now derives its checked bindings from
  generated `Cloudflare.Env`; a four-service negative regression removes a
  generated binding or substitutes an incompatible resource kind and requires
  a binding-specific TypeScript compilation failure.

Focused Sol reviews approved the integrated server/admin chain and final focus
correction. The final whole-root Sol audit then found the generated-Env and
prose-only evidence-gate P2 gaps, followed by a binding-kind compatibility
residual. Commits `8b23437` and `4f33243` plus the dynamic evidence gate in this
report packet close them. These reviews are local task evidence, not remote CI
attestations.

## Contract and schema evidence

Current canonical fixture hashes are:

| Contract | Routes / operations | SHA-256 |
| --- | --- | --- |
| Backend | 19 / 19 | `9c93750cb71fced5cdca781285c0899cd9e1824be85d13a78720c758c2ddf728` |
| Admin | 65 / 65 | `357421e2b07b50d8e51489f5894f2b78d48f6766bc5c600b93d55899bd156f41` |
| Portal | 18 routes / 16 operations | `c15e7c99ac393a0539071c186205da86a15c82cf351f4c0248ba12c260927400` |
| Backup | fetch, scheduled, workflow | `afe7676c22c35f5ca89f4e2882065b542018b1fd286b45e1fddff193d38705bf` |

The integrated schema includes migration 0031 for catalog-import previews and
0032 for projection assignment audit/index changes. D1 migration-to-snapshot
and PostgreSQL structural parity are green at 38 tables.

## Final local command attestations

All results below are timestamped command attestations measured on the final
integrated Windows tree on 2026-08-09 unless explicitly labeled accepted
candidate evidence. The docs-accuracy gate independently recomputes stable tree
facts (contract hashes and inventories, schema table sets, source counts,
gitlink state, and non-running E2E inventory); it does not pretend to rerun or
continuously prove these historical command results.

| Command / surface | Result |
| --- | --- |
| Fresh install (`npx --yes npm@10.9.8 ci`, Node 22.12.0) | Attested green; deterministic install |
| `npm run check:pr` | Attested green end-to-end: scans, pins, docs accuracy, lint, typecheck, architecture, contracts, services, SQL, and D1/PostgreSQL parity |
| `npm run check:dry-run` | Attested green for all four Workers; no deployment performed |
| `npm run setup:browsers` | Attested installation of both retained Playwright Chromium revisions |
| `npm run test:e2e` | Attested green; current non-running inventory is backend 2, admin 68, portal 1 |
| `npm run test:sdks` | Attested green: Python 70/70; .NET 43/43 |
| `npm audit --json` | Attested 0 total vulnerabilities at all severities |
| `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug` | Attested green: configure/build, CTest 34/34, and unchanged source fingerprints |
| `npm run check:docs` | Attested fail-closed prerequisite result because Doxygen is absent; no stale XML was consumed |
| Ubuntu native CMake | Not run; no Ubuntu CMake evidence collected |
| Remote CI | Not collected; no run link or identifier is claimed |

Accepted generator-candidate evidence remains separate from the protected
superproject state: candidate `74996a7` passed its standalone Debug suite 9/9,
Release build/install, external `find_package` consumer, and ZIP packaging; a
disposable superproject with that nested candidate passed Debug CTest 37/37.
This proves the candidate but does not publish or pin it.

No tracked `node_modules`, `.wrangler`, `dist`, SDK `bin`/`obj`, or virtual
environment output is present. The final working tree still contains only the
protected dirty generator gitlink state and protected untracked execution
plans.

## Remaining gaps and promotion gate

1. Publish the reviewed generator candidate, obtain maintainer approval, and
   update the superproject gitlink in a dedicated reviewed change.
2. Run Debug and Release native CMake/CTest on Ubuntu against the published
   candidate and retain CI run identifiers/artifacts.
3. Install Doxygen in the supported documentation environment and run the full
   `npm run check:docs` gate so Sphinx consumes freshly generated XML.
4. Capture green remote CI links/run IDs for the deterministic PR, SDK, E2E,
   dry-run, docs, and native matrix.
5. Treat TPM providers as a separate product implementation: define, build,
   test, and document Windows/Ubuntu providers before advertising TPM support.

Non-blocking maintenance remains: modernize the generator's CMake minimum and
Boost policy usage, consider the generator review's stricter zero ACE-flags and
MinGW target-version hardening, and retain a deliberate deployment policy for
any historical queued webhook bodies created before private-field scrubbing.

The project is therefore organized at an A-level standard in the reviewed
local implementation, while the release grade remains honestly
**CONDITIONAL / PENDING** until the five promotion items above are evidenced.
