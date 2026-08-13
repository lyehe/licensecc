---
name: using-licensecc
description: Navigate and modify the Licensecc repository safely. Use when setting up Licensecc, integrating the C/C++ runtime, working on Worker services, SDKs, API contracts, schemas, documentation, examples, CI, or release tooling in this repository. Do not use for unrelated licensing products or generic CMake, Cloudflare, or SDK questions outside Licensecc.
---

# Use Licensecc

Route work through the repository's existing ownership boundaries and commands.
Treat `AGENTS.md` and `doc/architecture/` as authority; this skill is a compact
workflow index, not a second architecture specification.

## Quick start

1. Confirm the repository root contains `AGENTS.md`, `CMakeLists.txt`,
   `package.json`, and `version.json`.
2. Read `AGENTS.md`, then read `doc/architecture/change-guide.md`,
   `doc/architecture/ownership.md`, and any relevant ADR before editing.
3. Run `git status --short --branch`. Classify existing changes and preserve
   anything outside the requested task.
4. Identify the owning surface with the routing table below.
5. Read that surface's README, tests, and public contract before changing it.
6. Make the smallest coherent change and run the narrow gate first.
7. Fix failures, rerun the narrow gate, then run the required integration gate.
8. End with `git diff --check` and report any unrun or environment-blocked gate.

Avoid dependency installation for read-only questions. For implementation work
from a clean checkout, use `npm ci`; the root lockfile owns every Node workspace.

## Route the task

| Goal | Read first | Narrow validation |
| --- | --- | --- |
| Understand or use the repo | `doc/usage/repository-workflows.rst`, `README.md` | Read-only inspection |
| Integrate the native runtime | `doc/usage/integration.rst`, `examples/minimal/README.md`, `doc/api/index.rst` | Build the consumer example |
| Change C/C++ API or behavior | `include/licensecc/`, `src/library/`, relevant `test/` files | Configure/build/CTest for the affected preset |
| Change device identity | `doc/api/device_identity.rst`, `examples/device_identity/README.md` | Provider-specific preset and installed consumer test |
| Change a Worker or UI | Its `services/<name>/README.md`, route table, OpenAPI source, tests | Workspace `lint`, `typecheck`, and `test` scripts |
| Change shared service logic | `packages/licensing-domain/` or `packages/cloudflare-runtime/` ownership docs | Package tests plus every affected consumer |
| Change a database contract | Backend migrations/schema and schema-parity scripts | Service SQL tests and both parity gates |
| Change an SDK or token format | SDK README, `test/vectors/`, canonical server implementation | SDK-specific tests, then `npm run test:sdks` |
| Change docs or API references | `doc/development/documentation.md`, `doc/api/index.rst` | `npm run check:docs` |
| Change CI/release tooling | `scripts/README.md`, release docs, workflow contract tests | Focused script tests and dry-run gates |

Keep route dispatch and OpenAPI changes in the serving deployable. Regenerate
canonical contract snapshots only when the reviewed public contract truly
changes; never edit a snapshot merely to silence a failing comparison.

## Select integration gates

Run the deterministic pull-request gate for any implementation intended for
commit:

```powershell
npm ci
npm run check:pr
```

Add only the gates required by the affected surface:

- C/C++ core: `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
- SDKs: `npm run test:sdks`
- Browser flows: `npm run setup:browsers`, then `npm run test:e2e`
- Worker packaging: `npm run check:dry-run`
- Documentation: `npm run check:docs`
- Scheduled/manual external links: `npm run check:docs:links`

Prefer root scripts over direct tool invocations because they encode pinned
versions, service ordering, and cross-surface checks. Run a direct command only
when a surface README makes it the maintained narrow gate.

## Preserve operational boundaries

- Do not deploy, publish, tag, rotate secrets, or mutate remote data without
  explicit authorization. A request to test authorizes local or dry-run gates,
  not a production action.
- Do not create or commit real Wrangler configs, `.dev.vars`, credentials,
  databases, build trees, generated documentation, or `.wrangler` output.
- Do not clean untracked files, worktrees, or ignored output until their exact
  ownership and resolved paths are known. Concurrent work is user-owned.
- Do not edit `extern/license-generator` casually. It is repository-owned
  vendored source with a separate provenance and license boundary.
- Do not alter protected execution plans while implementing their tasks.
- Keep private signing keys out of applications and release artifacts. Native
  project generation creates consumer-specific material; only public material
  belongs in the distributed runtime.

## Examples

Request: "Add a backend endpoint."

1. Read backend ownership, route, OpenAPI, and contract tests.
2. Implement route and OpenAPI changes in the backend deployable.
3. Run backend tests, canonical-contract checks, and `npm run check:pr`.

Request: "Show me how to embed Licensecc."

1. Read `doc/usage/integration.rst` and `examples/minimal/README.md`.
2. Explain the install-prefix, project-name, imported-target, and license-issue
   flow without modifying the repo.

Request: "Prepare a release."

1. Inspect the version contract and release-artifact docs.
2. Run only repository-owned validation or dry-run assembly unless publishing,
   tagging, and destination authority are explicit.

## Finish

Summarize the outcome, changed ownership surfaces, commands that passed, and
any honest limitation. Do not call work complete while a required safe gate is
still failing.
