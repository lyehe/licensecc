# Remove Legacy Mode and Backward Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make protected (`device_bound_v1`) licensing the only online mode, keep offline `.lic` (v201 only) and `lcccfg1` config tokens, delete all PostgreSQL support, and remove every backward-compatibility shim, alias and compatibility-only document, starting from one D1 schema baseline.

**Architecture:**
- **Schema first.** PostgreSQL goes first, so no second schema has to move in lockstep. Migrations 0001–0043 then collapse into `migrations/0001_baseline.sql`, byte-equivalent to today's `schema.sql`. Every later schema change edits that baseline in place and regenerates `schema.sql`; there is never a second migration.
- **Order of removal.**
  1. Clients: native and SDKs.
  2. Writers: after this, nothing can create a legacy row.
  3. Portal and admin.
  4. Backend routes, drills and CI. A protected staging drill and a new health contract land before the legacy drills and routes go.
  5. Legacy-only tables, then legacy columns and `enforcement_mode`.
  6. Documentation.
- **Owners.** Each task stays inside the owning deployable or package boundary from `doc/architecture/ownership.md`.

**Tech Stack:**
- C++17 with CMake presets, CTest and OpenSSL 3.
- Cloudflare Workers (wrangler 4.x) with D1/SQLite.
- React + Vite admin and portal UIs, tested with Playwright and `node:test`.
- Python (uv), .NET and Java SDKs.
- Python 3.12 + uv 0.12.5 for `check-schema-parity.py`.

**Spec:**
- Design brief (file:line evidence, phases P0–P7, schema changes, risks R1–R14, staged items S1–S17, latent defects): `C:/Users/HEQ/AppData/Local/Temp/claude/C--Users-HEQ-Projects-licensecc/a320d68a-3d35-4781-9d67-672e055c66a3/scratchpad/legacy-removal-design.md`
- Compatibility inventory (categories A–E, controller rulings): `C:/Users/HEQ/AppData/Local/Temp/claude/C--Users-HEQ-Projects-licensecc/a320d68a-3d35-4781-9d67-672e055c66a3/scratchpad/compat-inventory.md`
- Verified ref: `main` @ `3bd3f721`. Every file:line below was checked at that ref. Re-read the lines before editing, because earlier tasks shift them.

**Owner decisions (binding; quoted so this plan is self-contained).** "This is a NEW project: anything old can be removed."
1. "Remove the legacy enforcement mode entirely. Protected (`device_bound_v1`) mode becomes the only mode." The owner has accepted losing, with no protected replacement:
   - floating seats;
   - metering, quotas and usage reports;
   - online revocation for `.lic` apps;
   - 30-day offline leases;
   - headless/CI/non-TPM/Windows Server 2022 online licensing;
   - SDK-only online licensing;
   - customer account tokens;
   - `/v1/emergency`;
   - the SQLite online demo.
2. "Offline `.lic` file licensing in the C++ library stays", meaning plain `acquire_license` with `lccgen`-signed licence files.
   - Config tokens (`lcccfg1`) also stay.
   - "Remove the v200 format (inventory A4): v201 becomes the only offline format and the `lccgen` default."
   - "Keep the additional-key ring, since it is the only way to rotate the offline project key."
3. "There is no live D1 data." Collapse migrations 0001–0043 into one baseline first (P0), then edit the baseline in place.
   - Delete the upgrade-path tests and the migration-lineage pins.
   - Keep the restore drill itself, re-pinned to the new baseline.
   - Every D1 database must be recreated; the docs must say so.
4. "Security modes are always `required`. Delete `off`/`soft` and the legacy `LEASE_ISSUE_BEARER`, with no dev override."
5. "Delete ALL PostgreSQL support":
   - the PG host and adapter;
   - `supabase-postgres/`, including `schema.pg.sql` and `statements.pg.sql`;
   - `scripts/check-pg-parity.py`, `scripts/pg-parity/` and `scripts/bound_trigger_contract.py` (verified PG-only: it is imported only by `check-pg-parity.py` and `test/schema/test_check_pg_parity.py`);
   - `test/schema/test_check_pg_parity.py` and `test/fixtures/pg-parity/`;
   - the `schema:parity:pg` and `schema:parity:pg:test` scripts and their use in `check:schema-parity`;
   - `pg-toolchain-contract.test.mjs`;
   - `.github/workflows/postgres-conformance.yml`;
   - the dependabot `pg-parity` entry;
   - the PG docs, README sections and real-PG tests.

   `setup-uv` stays in CI: `check:schema-parity` (`uv run --no-project python scripts/check-schema-parity.py`) and `test:sdks` (`uv run --directory sdks/python`) still need it, in 9 workflows.
   `check:schema-parity` keeps only the SQLite `schema.sql`-versus-migrations check.
6. "Pure compatibility shims": remove every inventory A item the legacy removal does not already delete, applying the controller rulings:
   - OpenSSL 3.0 minimum;
   - strict source-fatal on by default;
   - `expected_customer_id` and `expected_revocation_seq` required;
   - an explicit deploy profile required;
   - webhooks require an explicit scope or an explicit global marker, with no NULL default;
   - remove the E3 `confirm_license`/`release_license` stubs;
   - remove the E2 upstream-only enum values and fix the stale "Reserved" comment, accepting the ABI renumbering since the ABI was never released.

   Also remove the D items (compatibility-only documentation), and reset `CHANGELOG.md` to a single Unreleased initial baseline.

   KEEP:
   - E1 (`size`/`version`/`reserved` struct fields);
   - E4, E5, E6 and E7;
   - B4, B5, B7 and B9;
   - everything in "looks like compat but is live".

   Re-evaluate `DEVICE_PROOF_MODE` (B2) after the legacy removal: remove it with evidence if nothing that needs it survives. It does not survive. Its only readers are `/v1/verify` (deleted in Task 30), leases and seats (Task 28), and the config checks that pin it to `off`. Task 30 deletes it with the grep evidence.

## Global Constraints

- **PR gate.** Every task leaves `npm ci` then `npm run check:pr` green, using Python 3.12 and uv 0.12.5. The only tolerated failures are the 7 known Node-24 `services/cloudflare-licensing-backend/test/staging-lease-drill.test.mjs` failures, and only until Task 28 deletes that drill. CI's Node 22 must pass them.
- **Extra gates.** Each task names its own. The standard sets are:
  - **Core native:** `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`, `ctest --preset dev-debug`, plus WSL Linux `ctest --preset ci-linux-debug` where relevant.
  - **SDK:** `npm run test:sdks`.
  - **UI:** the touched app's `test:ui` and `test:e2e`.
  - **Routes or contracts:** `npm run write:contract-baselines`, then `npm run test:contracts`.
  - **Docs:** `npm run test:docs-accuracy`, then `npm run check:docs`.
- **Repo text.** Never cite plan task numbers, phase names (P0–P7) or ruling/inventory IDs (A4, B3, R8, S4…) in repo text: code, comments, docs, commit messages or test titles. State the reason in plain words.
- **Commits.** Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Contract baselines** under `test/contracts/*.json` change only via `npm run write:contract-baselines`, after reviewing the route or OpenAPI change.
- **Hotspots.** Never raise a value in `scripts/hotspot-baseline.json`.
  - When a listed file is deleted, delete its entry in the same commit (`HOTSPOT_BASELINE_MISSING_FILE`).
  - When a listed file shrinks, lower its entry to the new count.
  - New logic goes into sibling files, never into a file at its limit.
- **Local configuration.** Never create or edit a local `wrangler.toml`/`wrangler.jsonc`, `.dev.vars`, secrets, `.wrangler/`, `dist/`, `dist-worker/` or `build/` tree; edit only tracked `wrangler.example.*` templates. Delete stale `dist/` and `dist-worker/` output locally before running tests that import it, because deleted sources otherwise linger there.
- **Python.** Always `uv run` (for example `npm run schema:write --workspace @licensecc/cloudflare-licensing-backend`, which wraps `uv run --no-project python scripts/check-schema-parity.py --write`).
- **Schema edits** after Task 2 edit `services/cloudflare-licensing-backend/migrations/0001_baseline.sql` in place, then:
  - regenerate `schema.sql` with `npm run schema:write --workspace @licensecc/cloudflare-licensing-backend`;
  - run `npm run check:schema-parity`;
  - update the restore-drill schema signature and inventories in `services/cloudflare-d1-backup` in the same commit.

  Never add a `0002_*.sql`.
- **`doc/architecture/system-map.md`** must stay accurate:
  - the canonical route counts (23/75/36 today);
  - the hotspot table rows;
  - the composition-root line counts;
  - the production-source totals.

  `scripts/docs-accuracy.test.mjs:486-525` recomputes them.
- **Route inventories and counts move together.** The places are:
  - backend `src/routes.ts` and its dispatch in `src/app.ts`;
  - admin `ALL_ROUTES`;
  - portal `src/worker/routes.ts` and the literal count in `src/worker/app.ts:60`;
  - `scripts/canonical-contracts.mjs:15-17,439`;
  - `system-map.md:67-69`;
  - route-owner tests.
- **The capability registry** (`doc/capabilities/registry.json`, checked by `npm run check:capabilities` and `npm run test:capabilities`) is updated in the same commit as any file, test title or selector it cites is deleted or renamed.
- **The script catalog** (`scripts/script-catalog.json`, checked by `npm run check:scripts`) loses an entry in the same commit as the script it names.
- **Protected guards.** Keep every protected guard listed in "Protected guards that must survive" below.
- **Handoffs.** Status reports follow `CONTRIBUTING.md` "Task Packets and Handoffs": the verified commit, the exact commands with their outcomes, and the surfaces not run, with reasons. Never a bare "all green".
- **Protected plans.** Do not edit this plan file while executing it. Record evidence in `docs/implementation/2026-09-28-remove-legacy-mode-and-compat.md` (Task 42).

### Protected guards that must survive

- Every `tr_bound_*` trigger except the seven this plan deletes (`tr_bound_reject_legacy_device_insert`, `_device_update`, `_lease`, `_seat_insert`, `_seat_update`, `tr_bound_mode_no_downgrade`, `tr_bound_mode_requires_migration`). The survivors are:
  - `tr_bound_capacity_decrease` and `tr_bound_entitlement_revision`, rewritten in Tasks 34–35 but kept;
  - the immutability, monotonic, tombstone and no-resurrection triggers;
  - `tr_bound_owner_change`, `tr_bound_customer_revision`, `tr_bound_device_disable`, `tr_bound_requested_feature_*`.
- The 18 `bump_license_plan_projection_generation_*` triggers.
- The order-ingest monotonic floor and the HMAC replay store (`order_ingest_nonces`).
- `rate_limit_counters` and the protected limiter in `src/device/bound_rate.mjs`, including the global fuse.
- `entitlements.revocation_seq`, `authority_revision`, `lease_seconds`, `max_active_devices` and all `trial_*` columns except `trial_require_device_proof`.

### Kept on purpose (not compatibility code)

- E1: the `size`/`version`/`reserved` fields of the public C structs.
- E4: the hardware-identifier byte layout.
- E5: versioned wire and protocol names (`lccdl1`, `lcccfg1`, `lcc-device-proof-v2`, `…/v1/…` vector directories).
- E6: the bridge ABI layout and protocol probes.
- E7: CMake `COMPATIBILITY SameMajorVersion`.
- B4: environment-variable licence sources and `IDENTIFICATION_STRATEGY`.
- B5: the weak hardware-binding opt-ins.
- B7: password recovery for accounts with an empty email.
- B9: the `from_first_use` trial basis.
- B8: the Windows Server 2022 CI legs (`.github/workflows/windows.yml:24-35`); they build the surviving offline core.
- The inventory's "looks like compatibility but is live" list:
  - `license_generator_lib`;
  - `LEGACY_RSAPRIVATE_BLOB`/`legacy_key_spec` (Windows API names);
  - pepper and key rotation;
  - the order-ingest `cached` fallback;
  - the plan-projection identity fence;
  - `package_config_rejects_old_curl`;
  - the admin customer-detail bundle and `/api/sync/entitlements` (made protected-only, not removed);
  - deployment transition tooling;
  - the typecheck-coverage JS graphs.

## Review Focus

1. **A writer still creates a legacy-shaped row after the writers task.**
   - The risk: order ingest, plan apply, sync or the break-glass CLI keeps inserting `enforcement_mode='legacy'` or a non-zero `pool_size`. The protected issuer then refuses that grant (`bound_issue.mjs:56,60`), so a paid order or a plan apply yields an unusable licence.
   - Tests:
     - Task 17: `plan apply keeps a protected grant issuable` asserts `pool_size = 0` and `enforcement_mode = 'device_bound_v1'` after applying a plan whose feature has `pool_size > 0`.
     - Task 18: `an order creates a protected grant owned by its customer` and `an order without a customer is refused`.
     - Task 16: `admin create without enforcement_mode is refused`.
2. **A protected reader loses a legacy-named table, column or binding.**
   - The risk: the protected issuer writes denial rows to `usage_events` (`bound_issue.mjs:87-94`); the admin reads them (`customers/bindings.ts:75-83`); registration rides `VERIFY_RATE_LIMITER` (`bound_rate.mjs:88`); trials store the proven key in `trial_device_hash`. Deleting any of these with the legacy code silently removes a protected behaviour.
   - Tests:
     - Task 30: `registration is edge-limited through BOUND_REGISTRATION_RATE_LIMITER`.
     - Task 33: `a device-limit refusal writes one device_bound_denials row per 15 minutes and the admin lists it`.
     - Task 35: `a protected trial locks to the proven key in trial_device_key_id`.
3. **The admin console rejects every entitlement read after the column drop.**
   - The risk: `hasEntitlementRecordData` in `services/cloudflare-license-admin/src/ui/shared/mutationGuards.ts:350-364` requires `heartbeat_grace_sec`, `allow_overdraft`, `rebind_window_sec` and the other legacy columns. The file is an 866-line hotspot at its baseline.
   - Test (Task 34): `the entitlement record guard accepts the protected row shape` in `services/cloudflare-license-admin/test/admin-ui-workflow/entitlements.test.mjs`. It checks that `hasEntitlementRecordData` accepts the post-drop row shape and rejects a row missing `max_active_devices`; admin `test:e2e` must also pass `admin-ui.lifecycle.e2e.mjs`. `wc -l mutationGuards.ts` must be ≤ 866.
4. **Deploys go unverified, or the three health readers disagree.**
   - The risk: the legacy drills (lease drill, public-verifier drill, portal seat/download mutation) are the only deployed licensing smoke tests. Backend `/health`, portal `/health` and `scripts/check-worker-rollback-health.mjs` all key on `account_token_mode`.
   - Tests:
     - Task 20: `the staging portal drill completes a protected enrollment, exchange and renewal and retires the binding` in `services/cloudflare-customer-portal/test/staging-portal-drill.test.mjs`.
     - Task 27: `rollback health accepts protected_device_ready and rejects account_token_mode` in `scripts/check-worker-rollback-health.test.mjs`, plus `portal health is healthy only when the backend reports protected readiness` in `services/cloudflare-customer-portal/test/portal-worker-public.test.mjs`, plus the production smoke test `test/protected-readiness-smoke.test.mjs`.
5. **A rewritten trigger stops guarding protected authority.**
   - The risk: dropping `enforcement_mode`, `pool_size`, `trial_require_device_proof` and renaming `trial_device_hash` rewrites `tr_bound_capacity_decrease` and `tr_bound_entitlement_revision`. A careless rewrite drops the retiring-slot `hold_until > unixepoch()` rule, or stops bumping `authority_revision` for `lease_seconds`, `revocation_seq` or a trial column.
   - Test: `entitlement authority revision advances for every authority column` in `services/cloudflare-licensing-backend/test/sql/bound-device-store.test.mjs`. Task 34 creates it; Task 35 switches it to `trial_device_key_id`. It updates each of `status`, `customer_id`, `valid_from`, `valid_until`, `max_active_devices`, `lease_seconds`, `revocation_seq`, `is_trial`, `trial_started_at`, `trial_duration_sec`, `trial_expiration_basis`, `trial_one_per_device` and `trial_device_key_id` in turn, and asserts `authority_revision` increments once each. `test/sql/bound-capacity-predicate.test.mjs` must still pin the capacity rule against `boundOccupiedSql`.

## Phase map and dependencies

| Phase | Tasks | Depends on | May run in parallel with |
|---|---|---|---|
| P0 PostgreSQL removal and schema baseline | 1–3 | — | — |
| P1a Native client | 4–11 | P0 | P1b, P2 |
| P1b SDK clients | 12–15 | P0 | P1a, P2 |
| P2 Writers protected-only | 16–19 | P0 | P1a, P1b |
| P3 Portal (protected staging drill first) | 20–22 | P2 | P4 |
| P4 Admin | 23–26 | P2 | P3 |
| P5a Backend runtime, routes, drills and CI | 27–31 | P1a, P1b, P3, P4. Strict order: 27 → 28 → 29 → 30 → 31. | — |
| P5b Legacy-only tables | 32 | P5a | — |
| P6 Schema columns, mode and baseline tidy-ups | 33–38 | P5b. Strict order. | — |
| P7 Tooling, docs, final sweep | 39–42 | P6 (Task 39 may run any time after P0) | — |

Execute tasks in number order unless the table allows parallel work. A parallel branch must rebase and re-run `check:pr` before merging.

Scripts, drills, workflow steps, vectors and shared-package modules are deleted in the same task that deletes their last consumer route or test, not in a separate cleanup task. This keeps every task green and every deploy covered by a drill. P5b therefore holds only the baseline table drop.

---

## P0 — PostgreSQL removal and schema baseline

### Task 1: Delete PostgreSQL support

PostgreSQL goes first, so the migration collapse and every later baseline edit have no second schema to keep in lockstep. The adapter served only `GET /health` and `POST /v1/verify` (`supabase-postgres/pg-route-guard.mjs:10-13`), and it could not see protected rows (`bound-device-real-pg.mjs:23-25`).

**Files:**
- Delete `services/cloudflare-licensing-backend/supabase-postgres/`: all 24 tracked files.
  - `README.md`, `bound-device-real-pg.mjs`, `db-postgres.mjs`, `entitlement-pg.mjs`, `entitlement-pg.test.mjs`
  - `order-apply-pg.mjs`, `order-apply-pg.test.mjs`, `order-apply-smoke-real-pg.mjs`
  - `pg-http-handler.mjs`, `pg-http-handler.test.mjs`, `pg-route-guard.mjs`, `pg-route-guard.test.mjs`
  - `pg-sql.mjs`, `real-pg-gate-contract.test.mjs`, `schema.pg.sql`, `server.mjs`
  - `smoke-real-pg.mjs`, `smoke-worker-sql.mjs`, `sql-translate.mjs`, `statements.pg.sql`, `translate.test.mjs`
  - `verify-sql-contract.test.mjs`, `verify-worker-pg-adapter.test.mjs`, `verify-worker-real-pg.mjs`
- Delete these backend files:
  - `services/cloudflare-licensing-backend/scripts/check-pg-parity.py`, `scripts/bound_trigger_contract.py`
  - `scripts/pg-parity/pyproject.toml`, `scripts/pg-parity/uv.lock`
  - `services/cloudflare-licensing-backend/test/schema/test_check_pg_parity.py`, `test/fixtures/pg-parity/adversarial-mutations.json`
  - `services/cloudflare-licensing-backend/test/pg-toolchain-contract.test.mjs`
- Delete `.github/workflows/postgres-conformance.yml`.
- Modify `services/cloudflare-licensing-backend/package.json`:
  - dependency `postgres` (:15);
  - scripts `test:pg` (:24), `test:pg:real` (:25), `schema:parity:pg` (:32), `schema:parity:pg:test` (:33);
  - devDependencies `pg` and `pg-mem` (:59-60).
- Modify root `package.json`:
  - `test:backend` (:38): drop `&& npm run test:pg --workspace …`;
  - `check:schema-parity` (:42): becomes exactly `npm run schema:parity --workspace @licensecc/cloudflare-licensing-backend`.
- Modify `package-lock.json`, regenerated only by npm 10.9.8.
- Modify `.github/dependabot.yml:41-48` (delete the `uv` `/services/cloudflare-licensing-backend/scripts/pg-parity` block).
- Modify `scripts/ci/security-governance.test.mjs:64` (expected ecosystem list) and `:78` (the `pg-parity/uv.lock` dependency-authority path).
- Modify `scripts/workflow-action-pins.test.mjs`:
  - delete `assertPostgresWorkflowContract` (:396-447) and the two PostgreSQL tests (:1052-1055, :1057-1111);
  - add the uv toolchain test described in Step 3.
- Modify `scripts/dev-check.ps1`: :198 (`test:pg`), :217 (`schema:parity:pg`), :260 (message "D1/PostgreSQL parity gates" becomes "D1 schema parity").
- Modify docs:
  - `doc/operations/database-backends.md`: delete the :21 table row, the "PostgreSQL and Supabase" section :60-72 and the "Promotion rule" section :74-87, which existed only to fence PostgreSQL.
  - `services/cloudflare-licensing-backend/README.md`: :10-11, :734, :768-770, :850.
  - `AGENTS.md:15-16`: drop the clause "PostgreSQL schema-parity dependencies are lock-backed under the backend service".
  - `CONTRIBUTING.md:39-40`: drop "The PostgreSQL schema checker resolves `sqlglot` only from its checked-in lock."
  - `CHANGELOG.md:33`.
  - `doc/operations/production-readiness.md`: :50-53, :124-125, :304, :343.
  - `doc/security/threat-model.md`: :15, TM-03 at :66, :123.
  - `doc/tutorials/local-online-evaluation.rst:59-61`.
  - `doc/architecture/decisions/0002-node-workspace.md`: :5 amended line, :41-43 decision item 7, :60-61.
  - `doc/architecture/decisions/0006-device-bound-licensing.md:86-88`.
- Modify comments that name the deleted adapter:
  - `services/cloudflare-licensing-backend/src/db/verify-statements.mjs:1-3`
  - `services/cloudflare-licensing-backend/host-common.mjs:3-4`
  - `services/cloudflare-licensing-backend/local-host/README.md:196`
  - `packages/cloudflare-runtime/src/lease/metering.mjs:17,66-67`
  - `packages/licensing-domain/src/catalog/plan_projection.mjs:25`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `npm run check:schema-parity` is `npm run schema:parity --workspace @licensecc/cloudflare-licensing-backend`: SQLite `migrations/` versus `schema.sql` only.
  - `npm run test:backend` is backend `test` plus `test:sql`.
  - The uv toolchain contract (the `uv.toml` pin, the entry points naming Python 3.12 and uv 0.12.5, and `services.yml` using `astral-sh/setup-uv`) moves into `scripts/workflow-action-pins.test.mjs`.

- [ ] **Step 1: Delete the files listed above.** Use `git rm -r services/cloudflare-licensing-backend/supabase-postgres services/cloudflare-licensing-backend/scripts/pg-parity`, then `git rm` each single file.
- [ ] **Step 2: Edit the manifests.**
  - Remove the scripts and dependencies from `services/cloudflare-licensing-backend/package.json` and root `package.json` as listed.
  - Run `npx --yes npm@10.9.8 install --package-lock-only --ignore-scripts`.
  - Review `git diff package-lock.json`. It may only remove the PostgreSQL-only closure: `postgres`, `pg`, `pg-connection-string`, `pg-pool`, `pg-protocol`, `pg-types`, `pg-int8`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, `pgpass`, `split2`, `pg-cloudflare`, `pg-mem` and its private dependencies (`functional-red-black-tree`, `immutable`, `json-stable-stringify`, `jsonify`, `moment`, `object-hash`, `pgsql-ast-parser`, `moo`, `nearley`, `commander`, `railroad-diagrams`, `randexp`, `discontinuous-range`, `ret`, `xtend`).
  - Shared packages (`call-bind*`, `get-intrinsic`, `isarray`, `object-keys`, the top-level `lru-cache`/`yallist`) must remain.
  - Run `npx --yes npm@10.9.8 ci`.
- [ ] **Step 3: Move the surviving toolchain assertions.** Add this test to `scripts/workflow-action-pins.test.mjs`, reusing the file's existing `read`/root helpers:

```js
test("schema parity and SDK checks share one pinned uv and Python 3.12 contract", () => {
  assert.equal(read("uv.toml"), 'required-version = "==0.12.5"\n');
  const backend = JSON.parse(read("services/cloudflare-licensing-backend/package.json"));
  assert.equal(backend.scripts["schema:parity"], "uv run --no-project python scripts/check-schema-parity.py");
  const root = JSON.parse(read("package.json"));
  assert.equal(root.scripts["check:schema-parity"], "npm run schema:parity --workspace @licensecc/cloudflare-licensing-backend");
  for (const path of ["AGENTS.md", "CONTRIBUTING.md", "README.md"]) {
    assert.match(read(path), /Python 3\.12/u, path);
    assert.match(read(path), /uv 0\.12\.5/u, path);
  }
  assert.ok((read(".github/workflows/services.yml").match(/uses: astral-sh\/setup-uv@/gu) ?? []).length > 0);
});
```

  Delete the PostgreSQL helpers and tests from the same file. In `security-governance.test.mjs`, remove the `uv:/services/cloudflare-licensing-backend/scripts/pg-parity` expectation and the `pg-parity/uv.lock` path.
- [ ] **Step 4: Rewrite the docs.**
  - `database-backends.md` describes two rows: D1 (production) and local SQLite (evaluation and tests).
  - ADR 0002 item 7 and the matching consequence become: "No database client packages are installed; D1 is reached only through Worker bindings." Remove the "Amended: 2026-08-11" line's PostgreSQL wording.
  - ADR 0006:86-88 becomes: "D1 is the only store for protected state; the repository has no PostgreSQL adapter."
  - The threat-model boundary text at :15 no longer mentions PostgreSQL. The TM-03 verification column and :123 drop "PostgreSQL conformance".
  - Edit the `production-readiness.md` lines in place. Keep the surrounding gates.
- [ ] **Step 5: Grep that no reference remains.** This must print nothing:

```bash
git grep -nIiE "postgres|supabase|pg-parity|schema\.pg|statements\.pg|check-pg-parity|bound_trigger_contract|test:pg|pg:real|pg-mem|schema:parity:pg|sqlglot" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
```

  `doc/analysis/` is historical and excluded from the Sphinx build (`doc/conf.py:33`). Leave it.
- [ ] **Step 6: Run the gates.**
  - `npm run check:pr`
  - `npm run test:workflow-pins`
  - `npm run test:security-governance`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `pwsh -NoProfile -File scripts/dev-check.ps1 -SkipCore -IncludeServices -IncludeSchemaParity`

  Expected: all pass (apart from the known Node-24 lease-drill failures).
- [ ] **Step 7: Commit.** `chore(backend): delete the PostgreSQL adapter, parity checker and conformance workflow`

### Task 2: Collapse migrations 0001–0043 into one baseline

**Files:**
- Delete `services/cloudflare-licensing-backend/migrations/0001_create_entitlements.sql` through `0043_allow_webhook_test_send_event.sql`, all 43 files.
- Create `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`.
- Modify `services/cloudflare-licensing-backend/scripts/check-schema-parity.py:12-15` (`GENERATED_HEADER` text only) and the regenerated `services/cloudflare-licensing-backend/schema.sql`.
- Delete these upgrade-path tests:
  - `services/cloudflare-licensing-backend/test/sql/bound-migration-legacy-data.test.mjs`
  - `services/cloudflare-licensing-backend/test/sql/webhook-events-test-send-migration.test.mjs`
- Modify `services/cloudflare-licensing-backend/test/sql/plan-projection.test.mjs`: delete `preProjectionProtocolDb` (:144-150) and the test "projection preview migrations upgrade a pre-0028 D1 database without rewriting catalog data" (:351-363).
- Modify `services/cloudflare-licensing-backend/test/contexts/operator-tools.test.mjs`: :61-66, :108-113, :115-124 read `schema.sql` only, not `migrations/0006…`/`0007…`/`0008…`.
- Modify `services/cloudflare-license-admin/test/sql/webhook-admin.test.mjs:392`: title "after all migrations" becomes "the baseline schema".
- Modify `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`:
  - :329-343: the canonical inventory is `["0001_baseline.sql"]`;
  - delete the upgrade test "real backend migration suffix upgrades a deterministic old local D1 to the current schema" (:345-391);
  - :839: title "through migration 0043" becomes "in the baseline schema".
- Modify `services/cloudflare-d1-backup/scripts/restore-drill.mjs:120`: the comment "from migrations 0001-0043" becomes "from the baseline schema".
- Modify comments that point at deleted migration files:
  - `services/cloudflare-customer-portal/src/auth/portal_ratelimit.mjs:7`
  - `services/cloudflare-license-admin/src/shared/api.ts:163,332`
  - `services/cloudflare-license-admin/src/worker/webhooks.ts:1,29,349`
  - `services/cloudflare-license-admin/test/sql/webhook-admin.test.mjs:4`
- Modify the docs that say "apply migration 00NN":
  - `services/cloudflare-licensing-backend/README.md`: :578, :584, :592, :624, :633, :700, :728, :857
  - `services/cloudflare-license-admin/README.md`: :122, :182
  - `services/cloudflare-customer-portal/README.md`: :237, :313, :328
  - `services/cloudflare-d1-backup/README.md:296`
  - `doc/operations/cloudflare-setup.md`: :403, section "10. Upgrade and recover" (:328-357)
  - `CHANGELOG.md`: :96, :216
  - `doc/architecture/decisions/0006-device-bound-licensing.md:79`
  - `doc/architecture/change-guide.md` "D1 query or migration" (:39-50)

**Interfaces:**
- Consumes: Task 1 (no `schema.pg.sql` to keep in lockstep).
- Produces:
  - `migrations/0001_baseline.sql` is the only migration. `canonicalMigrationNames()` returns `["0001_baseline.sql"]`.
  - `schema.sql` objects are identical to today's, so `EXPECTED_SCHEMA_SIGNATURE_SHA256` (`restore-drill.mjs:23`, `43f0c9b9…aaaaa`) is **unchanged**.
  - The documented rule: edit `0001_baseline.sql` in place, run `npm run schema:write`, and recreate every D1 database.

- [ ] **Step 1: Create the baseline from the snapshot.** In `services/cloudflare-licensing-backend`:
  - Confirm that `head -3 schema.sql` shows the two GENERATED lines followed by one blank line.
  - Write `migrations/0001_baseline.sql` as these three comment lines plus a blank line, followed by `tail -n +4 schema.sql`:
    - `-- Licensecc D1 baseline schema. This is the only migration: edit it in place and`
    - ``-- run `npm run schema:write` to regenerate schema.sql. A database created from any``
    - `-- earlier migration history cannot be upgraded; recreate it from this baseline.`
  - Run `git rm` on the 43 old files, keeping the new `0001_baseline.sql`, then `git add migrations/0001_baseline.sql`.
- [ ] **Step 2: Retarget the generator header.** Set `GENERATED_HEADER` to:
  - `-- GENERATED from migrations/0001_baseline.sql — edit the baseline and run npm run schema:write`
  - `-- Do not edit this file by hand; it is a canonicalized dump of the applied baseline.`

  Then run `npm run schema:write --workspace @licensecc/cloudflare-licensing-backend`.
- [ ] **Step 3: Prove behaviour neutrality.**
  - `git diff -U0 services/cloudflare-licensing-backend/schema.sql` must show only the two header lines.
  - `npm run check:schema-parity` prints `schema parity ok`.
  - `node --test services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs` passes with `EXPECTED_SCHEMA_SIGNATURE_SHA256` untouched, still 50 tables, 75 named indexes, 53 triggers and 178 rows.
- [ ] **Step 4: Delete and rewrite the upgrade-path tests.** Make the deletions and edits listed under Files. Each `operator-tools` test keeps its `schema.sql` assertions and drops the `migrations/00NN_*.sql` read. The restore-drill inventory test asserts `assert.deepEqual(canonicalMigrationNames(), ["0001_baseline.sql"])`.
- [ ] **Step 5: Rewrite the docs.**
  - Each "Migration 00NN adds …" paragraph states what the baseline contains, with no number.
  - Each "apply migration 00NN before deploying" becomes "apply the baseline (`npm run migrate:remote`) to a newly created database".
  - `cloudflare-setup.md` §10 states: "The schema is a single baseline that is edited in place until the first release. There is no upgrade path: after pulling a schema change, delete and recreate each D1 database (local `.wrangler` state, staging, production, restore scratch databases), apply the baseline, and take a fresh backup. Backups of an earlier database cannot be restored into the new schema."
  - Add the same operator notice under the backend README "Hosted setup" and as a `CHANGELOG.md` `Unreleased` → `Changed` bullet.
  - Delete the two CHANGELOG upgrade-note items that tell operators to apply migration 0043 (:96, :216).
  - Change-guide "D1 query or migration": replace "migrations" with "the single baseline migration `migrations/0001_baseline.sql`, edited in place"; keep the ownership sentences.
- [ ] **Step 6: Grep that no lineage reference remains.**

```bash
git grep -nE "00(0[2-9]|[1-3][0-9]|4[0-3])_[a-z_]+\.sql|[Mm]igrations? 00(0[2-9]|[1-3][0-9]|4[0-3])\b|0001-0043|0001_create_entitlements" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
```

  Expected: only the synthetic lineage names `0002_current.sql` in `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`. Those unit-test the generic history check, not the real lineage.
- [ ] **Step 7: Run the gates.**
  - `npm run check:pr`
  - `npm run test:e2e --workspace @licensecc/cloudflare-licensing-backend`
  - `npm run check:dry-run`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
- [ ] **Step 8: Commit.** `refactor(db): replace the migration history with one baseline schema`. The body states that every D1 database must be recreated.

### Task 3: Restore drill requires the exact baseline history

With one baseline edited in place, the drill's "apply the missing migration suffix" branch (`restore-drill.mjs:679-747`) can never fire correctly. A backup whose history differs from the baseline must fail closed, not be upgraded.

**Files:**
- Modify `services/cloudflare-d1-backup/scripts/restore-drill.mjs`:
  - `migrationHistoryFromRows` (:645-669);
  - `migrateScratchToCurrent` (:679-747), renamed `verifyScratchMigrationHistory`;
  - the caller at :1299-1340;
  - the exports at :1374-1386.
- Modify `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`:
  - delete "canonical migration lineage upgrades an old snapshot before current-schema validation" (:266-309);
  - rewrite "migration lineage fails closed…" (:311-327).
- Modify `services/cloudflare-d1-backup/README.md:284-294`.
- Modify `doc/operations/production-readiness.md` PRD-04 (:210-216).

**Interfaces:**
- Consumes: Task 2 (`canonicalMigrationNames()` returns `["0001_baseline.sql"]`).
- Produces:
  - `verifyScratchMigrationHistory(options, deps)` returns `{ snapshot_schema_identity: { migration_history, schema_objects } }` and never runs `wrangler d1 migrations apply`.
  - `migrationHistoryFromRows(rows, canonicalNames)` throws `snapshot_migration_history_incomplete` when `rows.length < canonicalNames.length`, and keeps the `_ahead`, `_invalid` and `_not_canonical_prefix` errors.
  - The drill evidence object no longer has `migration_upgrade`.

- [ ] **Step 1: Write the failing test.**

```js
test("a snapshot whose migration history is not the complete baseline is refused, never upgraded", () => {
  const canonicalNames = ["0001_initial.sql", "0002_current.sql"];
  let executed = 0;
  const deps = {
    canonicalNames,
    existingUserTables: () => ["d1_migrations", "entitlements"],
    migrationRows: () => [{ id: 1, name: canonicalNames[0] }],
    snapshotSchemaRows: () => [{ type: "table", name: "entitlements", table_name: "entitlements", sql: "CREATE TABLE entitlements (id TEXT)" }],
    execute() { executed += 1; },
  };
  assert.throws(() => verifyScratchMigrationHistory({ scratchDatabase: "scratch", scratchConfig: "backend.toml", mode: "remote" }, deps),
    /snapshot_migration_history_incomplete/);
  assert.equal(executed, 0);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `node --test services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`. Expected: FAIL, because `verifyScratchMigrationHistory` is not exported.
- [ ] **Step 3: Implement.**
  - Rename the function and delete the `execute([...,"migrations","apply",...])` branch, the `now`/`elapsedMs` timing and the `migration_upgrade` result.
  - In `migrationHistoryFromRows`, add `if (rows.length < canonicalNames.length) throw new Error("snapshot_migration_history_incomplete");` after the `_ahead` check.
  - Update the caller at :1299 and the evidence object at :1339-1340.
  - Keep `EXPECTED_SCHEMA_SIGNATURE_SHA256` and every inventory unchanged.
- [ ] **Step 4: Rewrite the tests and docs.**
  - The fail-closed test covers: missing `d1_migrations`, a divergent name, an ahead history, an incomplete history, and a non-contiguous id.
  - README :284-294 states: the drill requires `d1_migrations` to equal the checked-out baseline exactly; any other history fails closed; a backup of a database created before the current baseline cannot be restored and the database must be recreated.
  - PRD-04 :210-216 says the same.
- [ ] **Step 5: Grep.** `git grep -nE "migrateScratchToCurrent|migration_upgrade|migrated_to_current|scratch_migration_upgrade_incomplete|scratch_config_required_for_migration_upgrade" -- ':!docs/superpowers/plans' ':!docs/implementation'` must print nothing.
- [ ] **Step 6: Run the gates.**
  - `npm run test:backup`
  - `npm run check:pr`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
- [ ] **Step 7: Commit.** `fix(backup): refuse restores whose migration history is not the exact baseline`

---

## P1a — Native client

The offline core stays:
- `acquire_license`, `identify_pc` and `acquire_license_ex` (for tamper checks and custom limits);
- `LicenseReader`, `license_verifier.cpp`, `v201_canonical_payload.cpp`, `hw_identifier/` and `locate/`;
- config tokens (`lcc_verify_config`, `LccConfigVerifyOptions`);
- the protected API (`device_bound.h`, `feature_session.h` and the non-proof parts of `device_identity.h`);
- the orphaned `lccareq1` activation codec (`src/library/activation/`). It is an offline feature, not a compatibility shim, and is recorded as a follow-up in Task 42.

Change-guide rule: public ABI or licence-format changes need a compatibility note in the pull request **and** the API docs. Each task below that changes the ABI or the format puts a short "ABI change" paragraph in its PR description. Task 9 adds the single API-docs statement that the C ABI is unreleased and may renumber.

### Task 4: Remove the native online-verification layer and its decision and seat API

This deletes the online `lccoa1` verification layered on `.lic` files. It also removes:
- `lcc_acquire_license_decision`, `lcc_confirm_license`, `lcc_release_license` and the revocation floors;
- `LccOnlineRequest` and `LCC_ONLINE_*` (compat item A3 disappears with the type);
- the `confirm_license`/`release_license` no-op stubs;
- the `LicenseCheckOptions` v1/v2 prefix-size acceptance (its `offsetof(online_policy)` anchor disappears with the online fields);
- the decision-options v1 acceptance.

**Files:**
- Delete:
  - `src/library/online_verification/CMakeLists.txt`, `OnlineVerification.cpp`, `OnlineVerification.hpp`
  - `src/library/limits/lease_client.hpp`, `seat_client.hpp`, `clock_floor.hpp`
  - `test/library/online_verification_test.cpp`, `online_callback_failover_test.cpp`, `clock_floor_test.cpp`, `lease_client_test.cpp`, `seat_client_test.cpp`
  - `examples/online_callback/` (`CMakeLists.txt`, `main.cpp`, `main_winhttp.cpp`, `online_callback_common.hpp`, `README.md`)
  - `examples/production_decision_host/` (`CMakeLists.txt`, `main.cpp`, `README.md`)
  - `fuzz/online_assertion_fuzzer.cpp` and `fuzz/corpus/online_assertion/` (`canonical-payload.txt`, `envelope-shaped.txt`, `malformed.txt`)
  - `services/cloudflare-licensing-backend/scripts/remote-cpp-verify.mjs`. It runs `ctest -R test_online_verification$` (:199-228).
- Modify root `CMakeLists.txt`:
  - :12-17: rename `LCC_REQUIRED_ONLINE_V201_SOURCES` to `LCC_REQUIRED_CORE_SOURCES` and drop `src/library/online_verification/OnlineVerification.cpp`;
  - :44-47: delete the `LCC_ONLINE_ASSERTION_PUBLIC_KEY_RECORDS` and `LCC_ONLINE_ASSERTION_RETIRED_KEY_IDS` cache variables.
- Modify `src/library/CMakeLists.txt`:
  - :4 `add_subdirectory("online_verification")`;
  - :22 (the `online_verification` entry in the generated-metadata foreach);
  - :39 `$<TARGET_OBJECTS:online_verification>`;
  - :96-120 (the online assertion key-record and retired-id defines).
- Modify `src/library/licensecc.cpp`:
  - :28 include; :55-67 `RevocationFloorCallbacks` and `RuntimeHardeningStatus`;
  - :93-100 the `LICENSE_ONLINE_*` cases in `lcc_strerror`;
  - :143-206 floor helpers (`fixed_public_field_to_string`, `floor_record_key_to_strings`, `floor_record_from_context`);
  - :269-298 `lcc_init_revocation_floor_record`, `lcc_init_license_decision_options`, `lcc_init_license_decision`;
  - :510-552 `normalize_decision_options`; :609-675 `secure_decision_check_options`, `call_revocation_floor_load`/`_store`;
  - :922-1016, the online block in `acquire_license_with_runtime_checks`, plus its `floor_callbacks`/`hardening_out` parameters;
  - :1057-1272 (`populate_license_decision` through `lcc_get_online_revocation_floor`);
  - :1476-1486 `confirm_license`/`release_license`.

  Keep these shared helpers: `lcc_copy_public_string` (:118-132), `is_public_hex_string` (:134-141), `add_runtime_security_failure_event` (:504-508), `validate_config_input` (:554-575), `normalize_config_verify_options` (:577-607), and the config floor helpers (:208-230, :677-723).
- Modify `include/licensecc/licensecc.h`:
  - delete :61-80, :199-265, :310-318, :345-357;
  - reword the comments at :48-60, :169-195 and :286-287 so that none names a deleted function.
- Modify `include/licensecc/datatypes.h`:
  - delete `LICENSE_ONLINE_REQUIRED`, `LICENSE_ONLINE_VERIFICATION_FAILED`, `LICENSE_ONLINE_ASSERTION_INVALID` and `LICENSE_ONLINE_CACHE_EXPIRED` (:51-54, taking the stale "Reserved" comment with them);
  - delete :81-106 (`LCC_ONLINE_FLAG_*`, `LCC_CLIENT_HARDENING_*`);
  - delete `LCC_API_ONLINE_NONCE_SIZE`, `LCC_API_ONLINE_ASSERTION_SIZE`, `LCC_ONLINE_REQUEST_VERSION`, `LCC_ONLINE_DEFAULT_TIMEOUT_MS`, `LCC_ONLINE_MAX_TIMEOUT_MS`, `LCC_LICENSE_DECISION_OPTIONS_VERSION`, `LCC_LICENSE_DECISION_VERSION`;
  - delete :152-187 (`LCC_ONLINE_POLICY`, `LCC_ONLINE_CALLBACK_STATUS`, `LccOnlineRequest`, `LCC_ONLINE_CHECK`);
  - delete the six online fields of `LicenseCheckOptions` (:196-201);
  - delete :208-240 (`LccRevocationFloorRecord`, floor callbacks) and :242-279 (`LccLicenseDecisionOptions`, `LccLicenseDecision`);
  - set `LCC_LICENSE_CHECK_OPTIONS_VERSION` to `1u`.

  Keep `LCC_LICENSE_DECISION` (:206) and `LCC_API_ONLINE_PROJECT_SIZE`/`_LICENSE_FINGERPRINT_SIZE`/`_DEVICE_HASH_SIZE`: config tokens and `device_identity.h` use them. Reword the config-token `bound_to_device` comment (:374-380) so it no longer points at "the online verifier's request-proof path".
- Modify `src/library/os/signature_verifier.hpp`: :29 `LCC_ONLINE_ASSERTION_SIGNATURE_VERSION`; :177-199 `online_assertion_public_key_ring()`, `append_online_assertion_retired_key_ids()`; :274-285 `online_assertion_signature_policy()`.
- Modify `src/library/anti_tamper/AntiTamper.cpp`:
  - :17-27 (`kSupportedOnlineFlags`, `kOptionsVersionV1/V2`, `LCC_OPTIONS_FIELD_PRESENT`);
  - :114-172: accept exactly `sizeof(LicenseCheckOptions)` and `LCC_LICENSE_CHECK_OPTIONS_VERSION`;
  - :185-216 (online field validation).
- Modify `test/library/CMakeLists.txt`: :149-180 (targets `test_online_verification`, `test_online_callback_failover`), :196-230 (`test_clock_floor`, `test_lease_client`, `test_seat_client`), :241-246 (`ADD_TEST`), :253-266 and :308-316 (labels).
- Modify tests:
  - `test/library/public_api_test.cpp`:
    - every case that calls a deleted function, sets an `online_*` field, or asserts `LICENSE_ONLINE_*`;
    - the numeric `LCC_EVENT_TYPE` pins at :262-285: delete :273-276 and renumber the config and custom-limit pins as listed under Interfaces.
  - `test/library/anti_tamper_test.cpp`: :282-331 (`v1_options_size_remains_accepted_and_ignores_online_tail`, `v2_options_size_remains_accepted_and_ignores_custom_limit_tail`) and the online-field cases.
  - `test/library/device_identity/CMakeLists.txt:60` (comment).
- Modify `fuzz/CMakeLists.txt:12`, `fuzz/README.md:3-4`, `.github/workflows/native-security.yml:70-75`.
- Modify `scripts/native-security-contract.test.mjs`: :15, :90, :94, :101-103, :109, :149, :152 (`maxLengths` becomes one entry), :154 (`fuzzBudgets.length === 1`), :157.
- Modify `scripts/docs-accuracy.test.mjs:382-403` (test "backend documentation tracks the accepted C++ online API").
- Modify `services/cloudflare-licensing-backend/package.json` (script `validate:remote-cpp`) and its README :171-182 (remote C++ verification section).
- Modify `examples/anti_tamper_host/README.md:21`, `examples/anti_tamper_host/main.cpp:5`, `doc/usage/examples.rst:30-43`.
- Modify `doc/capabilities/registry.json`:
  - delete entries `online-verification` (:62-78), `floating-seats` (:97-117) and `legacy-remote-license-type` (:118-131). The last must go with `floating-seats`, which is its only replacement (`check-capability-registry.mjs:385-386`).
  - Update `doc/capabilities/index.rst:48-49,86-91`.
- Modify `scripts/hotspot-baseline.json`: delete `src/library/online_verification/OnlineVerification.cpp`; lower `src/library/licensecc.cpp` and `src/library/os/signature_verifier.hpp` to their new counts.
- Modify `doc/architecture/system-map.md`: :14-15 (area text naming "online decision/seat lifecycle" and "online verification"), :105 (`licensecc.cpp` row).

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `acquire_license_ex(const CallerInformations*, const LicenseLocation*, LicenseInfo*, const LicenseCheckOptions*)` keeps tamper and custom-limit enforcement only.
  - `LicenseCheckOptions` holds only `size`, `version` (1), the tamper fields and `custom_limit_check`/`custom_limit_user_data`, plus the E1 reserved fields.
  - `LCC_EVENT_TYPE` config and custom-limit codes move down by four (accepted renumbering): `LICENSE_CONFIG_TOKEN_INVALID` 15 → 11, `LICENSE_CONFIG_BINDING_MISMATCH` 16 → 12, `LICENSE_CONFIG_HASH_MISMATCH` 17 → 13, `LICENSE_CONFIG_EXPIRED` 18 → 14, `LICENSE_CONFIG_ROLLBACK` 19 → 15, `LICENSE_CUSTOM_LIMIT_DENIED` 20 → 16, `LICENSE_CUSTOM_LIMIT_EVALUATION_FAILED` 21 → 17. Task 9 shifts everything after `LICENSE_FILE_NOT_FOUND` down by one more.

- [ ] **Step 1: Delete the files listed under Delete.**
- [ ] **Step 2: Remove the code.**
  - Remove the listed code from `licensecc.cpp`, `licensecc.h`, `datatypes.h`, `signature_verifier.hpp` and `AntiTamper.cpp`.
  - In `acquire_license_with_runtime_checks`, keep :906-921 (tamper and custom limits) and return after them.
  - Remove the targets, labels, fuzz step and CMake variables listed.
- [ ] **Step 3: Delete or rewrite the tests that pinned them.**
  - `public_api_test.cpp` keeps every offline, config and strict-source case.
  - `anti_tamper_test.cpp` gets one new case: `options_with_a_different_size_or_version_are_rejected`. `acquire_license_ex` with `size = sizeof(LicenseCheckOptions) - 1`, and separately with `version = 2`, returns `LICENSE_MALFORMED` (`licensecc.cpp:1035-1038` maps a failed `normalize_options` to it).
- [ ] **Step 4: Rewrite the docs-accuracy test** as "native public API documents offline licences and protected sessions only":

```js
test("native public API documents offline licences and protected sessions only", () => {
  const backendReadme = source("services/cloudflare-licensing-backend/README.md");
  const publicHeader = source("include/licensecc/licensecc.h");
  const dataTypes = source("include/licensecc/datatypes.h");
  assert.match(publicHeader, /LCC_EVENT_TYPE\s+acquire_license_ex\s*\(/u);
  assert.doesNotMatch(publicHeader, /lcc_acquire_license_decision|lcc_confirm_license|lcc_release_license|revocation_floor/u);
  assert.doesNotMatch(dataTypes, /LCC_ONLINE_CHECK|LccOnlineRequest|LCC_ONLINE_FLAG_/u);
  assert.doesNotMatch(backendReadme, /lcc_acquire_license_decision|persisted revocation sequence/iu);
  assert.match(backendReadme, /C\+\+ client runtime\s+provides conditional Windows Platform KSP and Ubuntu TPM2\/OpenSSL provider\s+surfaces/isu);
  assert.match(backendReadme, /does not\s+claim\s+TPM\s+support/iu);
});
```

  Delete the backend README sentences "For production C++ hosts, use `lcc_acquire_license_decision()`…" and the "persisted revocation sequence" sentence.
- [ ] **Step 5: Update the registry, hotspot baseline, system map, examples catalogue and fuzz README.**
  - `doc/usage/examples.rst` lists only the examples that remain (`minimal`, `fail_closed_host`, `anti_tamper_host`, `device_bound`, `device_identity`). `docs-accuracy.test.mjs:284-289` enforces that the catalogue matches `examples/*`.
- [ ] **Step 6: Grep that no reference remains.** Both must print nothing:

```bash
git grep -nE "online_verification|OnlineVerification|lcc_acquire_license_decision|lcc_confirm_license|lcc_release_license|lcc_(set|get)_online_revocation_floor|LccOnlineRequest|LCC_ONLINE_(CHECK|POLICY|FLAG|CALLBACK|REQUEST|DEFAULT|MAX)|LICENSE_ONLINE_|LccLicenseDecision|LccRevocationFloorRecord|LCC_CLIENT_HARDENING|online_callback|production_decision_host|fuzz_online_assertion|online_assertion_fuzzer|lease_client|seat_client|clock_floor|remote-cpp-verify|validate:remote-cpp|LCC_ONLINE_ASSERTION_" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
git grep -nE "\b(confirm_license|release_license)\s*\(" -- include src test examples
```

  `test/vectors/online_assertion/` stays: backend and SDK tests still read it until Task 30.
- [ ] **Step 7: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug --output-on-failure`
  - WSL: `cmake --preset ci-linux-debug && cmake --build --preset ci-linux-debug && ctest --preset ci-linux-debug`
  - WSL Clang: `cmake --preset ci-linux-sanitizers && cmake --build --preset ci-linux-sanitizers && ctest --preset ci-linux-sanitizers`, then the bounded corpus smoke for the remaining `fuzz_activation_request` target
  - `npm run test:native-security`
  - `npm run test:docs-quickstart`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 8: Commit.** `refactor(core)!: remove online verification, the decision and seat API, and the revocation floors`. The PR description carries the ABI-change paragraph: removed functions and types, the `LCC_EVENT_TYPE` renumbering, and `LicenseCheckOptions` version 1.

### Task 5: Move shared device-identity tests to the v2 proof and remove request proof v1

The v1 request proof (`lcc_device_identity_build_request_proof_v1`, audiences VERIFY/LEASE/SEAT) exists only for the legacy `/v1` routes. Protected clients sign with `license::device_identity::sign_bound_proof_v2` (`bound_protocol.hpp:82-85`, `bound_signing.cpp:48-57`). Several tests exercise shared signing, locking and P-256 strictness through the v1 path, so they move to v2 first.

**Files:**
- Modify tests (under `test/library/device_identity/`):
  - `device_identity_concurrency_test.cpp:41-52,136-179`: `shared_handle_serializes_signing_and_keeps_getters_safe` signs with `sign_bound_proof_v2`, using the renew input from `test/vectors/device_bound/v1/protocol.json`.
  - `device_identity_vectors_test.cpp`:
    - delete :170-215 `task1_request_proof_fixture_builds_and_verifies`, which is covered by `device_bound_vectors_test.cpp:41`;
    - re-point :217-322 `strict_p256_negative_corpus_fails_closed` at `device_bound/v1/protocol.json` (`device_spki`, `proof_input_hex`, `proof_signature`, base64url-decoded);
    - delete :324-363, which is covered by `device_bound_operations_test.cpp:232`.
  - `device_identity_policy_test.cpp:40-52,195-269`: keep the shared `get_metadata` size check (:258-263) as its own test `metadata_output_size_is_strict`; delete the v1 input cases, which are covered by `device_bound_operations_test.cpp:268-277`.
  - `windows_tpm_test.cpp:1240-1249,1281-1287,1296-1300`: real signing uses `sign_bound_proof_v2` with `BoundLocalContext{"DEFAULT", audience}`.
  - `device_identity_abi_test.cpp`: delete :45-49, :56, :90-130, :203-232.
- Modify `test/consumer/device_identity/c_header_smoke.c:9-10,14-15,17`.
- Modify `include/licensecc/device_identity.h`: delete :105-118 (`LCC_DEVICE_PROOF_AUDIENCE`, `LCC_DEVICE_PROOF_VERSION`), :126 (`LCC_DEVICE_SIGNATURE_BASE64_MAX`), :176-218 (`LccDeviceProofInput`, `LccDeviceProof`), :224-227, :235-237; reword the group doc at :13-17.
- Modify `src/library/device_identity/device_identity.cpp`: :59-99 (proof static_asserts), :272-280, :311-327, :429-489.
- Modify `src/library/device_identity/proof_payload.cpp`: :13-22, :70-79, :117-182. Keep `derive_namespace_v1` (:83-115), `is_application_id` and `is_proof_name`.
- Modify `src/library/device_identity/device_key_provider.hpp:103-104`.
- Modify `scripts/hotspot-baseline.json`: lower `src/library/device_identity/device_identity.cpp` to its new count.
- Modify `doc/api/device_identity.rst:1-26`: request proofs are no longer "accepted by online verification, lease, and seat operations".
- Modify `doc/capabilities/registry.json`, entry `tpm-request-proof-provider` (:291-309): retitle it "TPM device-key provider" and re-point any selector that names a deleted v1 test.

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `device_identity.h` keeps open/metadata/SPKI/delete/close and namespace derivation, with no request-proof API.
  - `test/vectors/device_proof/v1/*` is no longer read by native tests. Backend and Python readers go in Tasks 12 and 30.

- [ ] **Step 1: Migrate the four shared tests to v2** as listed. Each must still exercise the same property (mutex serialisation, P-256 strictness, output-size strictness, real TPM signing). Run `ctest --preset dev-debug -R device_identity` and confirm it passes **before** deleting any API.
- [ ] **Step 2: Delete the v1 API and implementation** as listed.
- [ ] **Step 3: Delete the pure-v1 ABI and C-header test lines.**
- [ ] **Step 4: Grep.**

```bash
git grep -nE "build_request_proof_v1|build_request_proof_payload_v1|LCC_DEVICE_PROOF_AUDIENCE|LccDeviceProofInput|LccDeviceProof\b|lcc_init_device_proof|LCC_DEVICE_PROOF_VERSION|LCC_DEVICE_SIGNATURE_BASE64_MAX" -- include src test examples sdks doc
```

  Expected: no output. The `sdks/` bridges never exported these; confirm.
- [ ] **Step 5: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - `ctest --preset dev-device-identity-test`
  - WSL `ctest --preset ci-linux-device-identity-test`
  - `npm run test:sdks` (the bridges link the identity library)
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `refactor(device-identity)!: remove the v1 request proof after moving shared tests to the v2 signer`

### Task 6: Delete the dead lease-ring CMake and describe the additional-key ring as project-key rotation

`cmake/LeaseRing.cmake` is dead:
- its helper `scripts/build_lease_ring.py` does not exist;
- `lcc_generate_test_lease_ring` is never called;
- `LCC_BUILD_LEASE_RING_TEST` defaults OFF.

The additional-key ring itself (`LCC_ADDITIONAL_PUBLIC_KEY_RECORDS`/`LCC_RETIRED_PUBLIC_KEY_IDS`) stays: it is the only way to rotate the offline project key.

**Files:**
- Delete `cmake/LeaseRing.cmake`, `test/functional/lease_ring_test.cpp`, `test/vectors/lease_ring/README.md`.
- Modify root `CMakeLists.txt:56-58` (option `LCC_BUILD_LEASE_RING_TEST` and the `include`), `test/functional/CMakeLists.txt:96-115`.
- Modify `src/library/CMakeLists.txt:148`: the comment becomes `# Project verification ring: the embedded project key plus additional keys used to rotate the offline project key.`
- Modify `doc/architecture/system-map.md:81-84`: drop `${CMAKE_BINARY_DIR}/lease_test_ring` and `lease_ring_records.cmake`.
- Create no file. Add one test to `test/functional/signature_verifier_test.cpp`: `additional_ring_key_verifies_and_retired_id_is_refused`. The ring that `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS` builds (`signature_verifier.hpp:154-175`) reaches the verifier as `SignatureVerificationPolicy::public_keys` and `retired_key_ids`, so the test drives that policy directly:
  1. Start from `v201_golden_request("minimal", v201_minimal_fields())` (:219-236).
  2. Set `request.policy.allow_external_public_key_der = false` and clear `request.public_key_der`.
  3. Set `request.policy.public_keys = { SignaturePublicKey(<embedded project key id>, embedded_public_key_der(), embedded_public_key_bits()), SignaturePublicKey(kGoldenV201KeyId, <the golden DER the request used>, 3072) }`, modelling the embedded key plus one additional key, and keep `kGoldenV201KeyId` in `allowed_key_ids`.
  4. Assert `verify_signature(request) == FUNC_RET_OK`.
  5. Push `kGoldenV201KeyId` into `request.policy.retired_key_ids` and assert `FUNC_RET_ERROR`.

**Interfaces:**
- Consumes: nothing.
- Produces: no ABI change. `LCC_ADDITIONAL_PUBLIC_KEY_RECORDS`/`LCC_RETIRED_PUBLIC_KEY_IDS` stay documented in root `CMakeLists.txt:52-55`.

- [ ] **Step 1: Write the ring test** described above. Run it with `ctest --preset dev-debug -R signature_verifier`. Expected: PASS, because the ring already works. The test guards the kept behaviour, since the deleted lease-ring test was its only other coverage.
- [ ] **Step 2: Delete the three files and the CMake wiring.**
- [ ] **Step 3: Grep.** `git grep -nE "LeaseRing|lease_ring|LEASE_RING|build_lease_ring|lease_test_ring|hot lease" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `chore(cmake): delete the unused lease-ring generator and keep the project-key rotation ring`

### Task 7: lccgen issues only v201 licences

**Files:**
- Modify `extern/license-generator/src/base_lib/base.h:37-39`: `LICENSE_FILE_VERSION` becomes 201; delete the V200 constant.
- Modify `extern/license-generator/src/license_generator/license.cpp`:
  - delete the v200 branches at :229-231, :279, :364-372, :799-840, :972-1005, :1060-1082;
  - the constructor at :934-936 and the check at :952-956 are no longer needed with a single format; delete them.
- Modify `extern/license-generator/src/license_generator/command_line-parser.cpp`:
  - delete `--license-version` and `--target-license-format-max` (:593-598);
  - delete `--legacy-rsa1024` (:374-378, :455-457), `--allow-insecure-key-size` (:458-460) and `project migrate-weak-key` (`migrateWeakProjectKey`, :498-560 and the dispatch at :716);
  - `--key-bits` (:59, :452) keeps 3072 and 4096 and rejects 2048.
- Modify `extern/license-generator/README.md:12-39`: delete the "Weak RSA-key migration" section and the v200 wording.
- Modify `extern/license-generator/PROVENANCE.md`: add a line recording the repository-owned removal of v200 issuance and weak-key options.
- Delete `extern/license-generator/test/data/v200/legacy_fixed_key.lic` and `legacy_append_noncanonical.lic`.
- Modify generator tests:
  - `extern/license-generator/test/license_test.cpp`: :126, :142-233, :496-514. The fixture project key at :143 is 1024-bit; regenerate the fixture with a 3072-bit key.
  - `command-line_test.cpp`: :375-395, :580-608, :743, :775-793, :1002, :1383-1422, :1821, :1846, :1976.
  - `cryptohelper_test.cpp:116-122`, `project_test.cpp:144-178`.
- Modify licensecc tests that relied on the v200 default:
  - `test/functional/generate-license.cpp:57-127`: `generate_license()` and `sign_data()`;
  - `test/functional/crack_test.cpp:253-281` (edits `"lic_ver = 200"`);
  - `test/library/anti_tamper_test.cpp:66-87,187`;
  - `test/library/public_api_test.cpp:82-95,985`;
  - `test/library/config_public_api_test.cpp:87`.
- Modify `scripts/check-architecture.mjs:420-421` and `scripts/check-architecture.test.mjs:451-452,458`.

**Interfaces:**
- Consumes: Task 4 (`online_verification_test.cpp` no longer issues licences).
- Produces:
  - `lccgen license issue` always writes `lic_ver = 201`.
  - `lccgen project init` refuses keys below 3072 bits.
  - The runtime still reads v200 until Task 8.

- [ ] **Step 1: Write the failing generator test** in `command-line_test.cpp`: `issue_writes_v201_by_default_and_rejects_license_version_option`. It issues with no version option, asserts `lic_ver = 201`, and asserts that `--license-version 200` is an unknown option (non-zero exit). Run `ctest --preset dev-debug -R license_generator`. Expected: FAIL (it writes 200).
- [ ] **Step 2: Implement** the generator changes above, in order: default first, then option removal, then v200 branch deletion.
- [ ] **Step 3: Regenerate the 3072-bit generator fixture key and rewrite the pinned tests.** A test whose only purpose was v200 or weak-key behaviour is deleted, not converted.
- [ ] **Step 4: Update the licensecc test helpers** so every issued licence is v201. `crack_test.cpp:253-281` searches for `lic_ver = 201`.
- [ ] **Step 5: Grep.**

```bash
git grep -nE "legacy-rsa1024|allow-insecure-key-size|migrate-weak-key|target-license-format-max|license-version|LICENSE_FILE_VERSION_V200|lic_ver = 200" -- extern test scripts doc
```

  Expected: no output outside explicit v200 reader fixtures under `test/`, which Task 8 deletes.
- [ ] **Step 6: Run the gates.**
  - `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly`
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug`
  - `npm run test:docs-quickstart`
  - `npm run check:pr` (includes `test:architecture`)
- [ ] **Step 7: Commit.** `feat(lccgen)!: issue only v201 licences and drop weak-key options`

### Task 8: The runtime accepts only v201 licences

**Files:**
- Modify `src/library/base/base.h:47-51`: `LCC_LICENSE_FORMAT_VERSION` becomes V201; delete V200.
- Modify `src/library/LicenseReader.cpp`:
  - :52-54 `is_valid_v200_license_version`, :86-91 `v200_allowed_keys`, :169-221 `validate_v200_raw_value_shapes`/`validate_v200_section`;
  - :327-341, the v200 branch;
  - :371, the v200-only `printForSign` path.
- Modify `src/library/base/string_utils.cpp:44-75`: delete `is_canonical_v200_date`; rename `parse_canonical_v200_date` to `parse_canonical_date` and keep it, because `seconds_from_epoch` (:77-97) is shared with v201 (`license_verifier.cpp:243,257,379`).
- Modify `src/library/limits/license_verifier.cpp:86-94` (v200 `else` branch).
- Modify `src/library/os/signature_verifier.hpp`: :245-259 `legacy_v200_signature_policy`; :28 `LCC_SIGNATURE_KEY_ID_LEGACY_V200`, which has no users; :528, the two-string `verify_signature` overload declaration.
- Modify `src/library/os/openssl/signature_verifier.cpp:123-137` and `src/library/os/windows/signature_verifier.cpp:293-307` (the overload bodies).
- Modify root `CMakeLists.txt:37` (`LCC_SUPPORTED_LICENSE_FORMAT_MIN` becomes 201), `src/templates/licensecc_properties.h.in:30`, `test/library/public_api_test.cpp:162`.
- Modify v200 tests:
  - `test/functional/signature_verifier_test.cpp`: :46-60, :358-406, :461-481, :633-667, :780-784, :805-845, :891-897, :997-1000;
  - `test/functional/crack_test.cpp`: :61-73, :502-518, :638-650;
  - `test/functional/date_test.cpp:26,101-105`;
  - `test/library/license_verifier_test.cpp:29,54,81`;
  - `test/library/LicenseReader_test.cpp:58,123-156,383-451`;
  - `test/library/test_reader.ini`: it is `lic_ver = 200` today. Rewrite it as a v201-shaped licence for section `[PRODUCT]`, with the same keys and value shapes as `test/vectors/v201/minimal.license`. Its consumers only parse or locate it, never verify its signature:
    - `LicenseReader_test.cpp:92,472` expect one parsed licence, and product-not-licensed;
    - `LicenseLocator_test.cpp:26,81,108-121` copy and locate it;
    - `public_api_test.cpp:785,837,852` use it as a disabled environment source.
- Modify `doc/capabilities/registry.json:280,287` (`custom-execution-limits` wording "Legacy v200 licenses cannot carry it"/"reject v200").

**Interfaces:**
- Consumes: Task 7.
- Produces: a `lic_ver = 200` licence is refused. The reader's final `else` branch (`LicenseReader.cpp:358-360`) records `LICENSE_MALFORMED` "Invalid license format version", exactly as it already does for any other unknown version.

- [ ] **Step 1: Write the failing test** in `test/library/LicenseReader_test.cpp`: `v200_license_is_refused`. It reads a minimal v200 licence written by the test into a temporary file, and asserts that no licence is accepted and that the registry holds `LICENSE_MALFORMED` "Invalid license format version". Run `ctest --preset dev-debug -R LicenseReader`. Expected: FAIL (v200 still accepted).
- [ ] **Step 2: Delete the v200 code** listed above.
- [ ] **Step 3: Delete or rewrite the v200 tests.** A test that only characterised v200 is deleted. A test that checked a shared property (dates, crack resistance) is re-pointed at a v201 licence.
- [ ] **Step 4: Grep.**

```bash
git grep -nIiE "v200|lic_ver\s*=\s*200|LEGACY_V200|legacy_v200|LICENSE_FILE_VERSION_V200|FORMAT_MIN 200" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
```

  Expected: only the new `v200_license_is_refused` test.
- [ ] **Step 5: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug`
  - `npm run test:docs-quickstart`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `feat(core)!: accept only v201 licence files`. The PR description notes the format change (change-guide rule).

### Task 9: Remove upstream-only ABI values and the config-options v2 acceptance

**Files:**
- Modify `include/licensecc/datatypes.h`:
  - delete `LICENSE_SERVER_NOT_FOUND` (:42);
  - delete `LCC_REMOTE` (:72) and its comment;
  - `LicenseInfo.license_type` comment at :475 becomes "always LCC_LOCAL";
  - values after `LICENSE_FILE_NOT_FOUND` renumber down by one. `LICENSE_SPECIFIED` = 100 onward are unchanged.
- Modify `src/library/licensecc.cpp`:
  - :75-76 (the `lcc_strerror` case);
  - :583-603 in `normalize_config_verify_options`: accept exactly `sizeof(LccConfigVerifyOptions)` and the current version; delete the version-2 prefix branch.
- Modify tests:
  - `test/library/public_api_test.cpp`: :63 and :285 (`LCC_REMOTE`); the numeric `LCC_EVENT_TYPE` pins at :262-285 (delete :264 `LICENSE_SERVER_NOT_FOUND`; every later value moves down by one);
  - `test/library/config_public_api_test.cpp`: add the negative case `config_verify_options_with_old_size_are_rejected`. No existing case pins the v2 size (verified).
- Modify `scripts/check-capability-registry.mjs`:
  - :24: drop `"deprecated"` from the status set;
  - :385-386 and :500: delete the `deprecated`/`hasReplacement` machinery;
  - :449-463 in `scripts/check-version-contract.mjs`: remove the skip for `deprecated`.
- Modify `scripts/capability-registry.schema.json:25`: drop `"deprecated"` from the enum.
- Modify `scripts/check-capability-registry.test.mjs:97-101,229-246` (deprecated fixtures).
- Modify `doc/api/public_api.rst`, the page that documents `LCC_EVENT_TYPE`: add one sentence, "The C ABI is unreleased; `LCC_EVENT_TYPE` values and struct layouts may change until the first C++ release."

**Interfaces:**
- Consumes: Task 4 (which already removed the `LICENSE_ONLINE_*` values and `legacy-remote-license-type`).
- Produces: `LCC_EVENT_TYPE` = `LICENSE_OK` 0, `LICENSE_FILE_NOT_FOUND` 1, `ENVIRONMENT_VARIABLE_NOT_DEFINED` 2, … `LICENSE_CUSTOM_LIMIT_EVALUATION_FAILED` 16, `LICENSE_SPECIFIED` 100 … `SIGNATURE_VERIFIED` 103. `LCC_LICENSE_TYPE` = `{ LCC_LOCAL }`. No SDK mirrors these values (verified: no hits under `sdks/` or `packages/`).

- [ ] **Step 1: Write the failing test** `config_verify_options_with_old_size_are_rejected`: pass `size = offsetof(LccConfigVerifyOptions, custom_limit_check)` and `version = 2`, and expect rejection. Run `ctest --preset dev-debug -R config_public_api`. Expected: FAIL (accepted today).
- [ ] **Step 2: Implement** the header and implementation edits.
- [ ] **Step 3: Remove the deprecated-status machinery and fixtures** from the capability tooling.
- [ ] **Step 4: Grep.**

```bash
git grep -nE "LICENSE_SERVER_NOT_FOUND|LCC_REMOTE\b|\"deprecated\"|hasReplacement" -- include src test scripts doc sdks
```

  Expected: no output. `LCC_REMOTE_ONLINE_*` env names were deleted in Task 4.
- [ ] **Step 5: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug`
  - `npm run test:capabilities`
  - `npm run check:capabilities`
  - `npm run test:versions`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `refactor(core)!: drop upstream-only ABI values and old config-option sizes`

### Task 10: Require OpenSSL 3.0 and ship the public-key metadata in the template

**Files:**
- Modify root `CMakeLists.txt`:
  - :258-262: `find_package(OpenSSL 3.0 COMPONENTS Crypto QUIET)` in the non-TPM branch. If OpenSSL is found but older than 3.0, fail with `message(FATAL_ERROR "licensecc requires OpenSSL >= 3.0")`.
  - :289-297: delete the zlib branch for OpenSSL ≤ 1.0.2.
  - :336-365: delete the overlay comment, `LCC_PROJECT_TEMPLATE_DIR`, the `configure_file` copy and the `file(APPEND …)`.
  - :374-375: `lccgen project initialize -t "${PROJECT_SOURCE_DIR}/src/templates"`, with `DEPENDS … "${PROJECT_SOURCE_DIR}/src/templates/public_key.inja"`. It only reads the source template; nothing is written into the source tree.
- Modify `doc/architecture/system-map.md:79-82`: drop `${CMAKE_BINARY_DIR}/generated-project-templates`.
- Modify `src/templates/public_key.inja`: add, inside the include guard, the five `#define`s the overlay appended today (`LCC_PUBLIC_KEY_ALGORITHM`, `LCC_PUBLIC_KEY_BITS`, `LCC_PUBLIC_KEY_SHA256`, `LCC_PUBLIC_KEY_ID`, `LCC_SIGNATURE_ALGORITHM`), without the `#ifndef` wrappers.
- Modify `src/library/os/signature_verifier.hpp:116-128`: delete the `#else` fallback in `embedded_public_key_id()`, because the macros are now always generated.
- Modify `src/library/os/openssl/signature_verifier.cpp`:
  - :39-49: delete `initialize()` (`ERR_load_*`, `OpenSSL_add_all_algorithms`) and its callers;
  - :35 and :82: `EVP_MD_CTX_create`/`destroy` become `EVP_MD_CTX_new`/`free`.
- Modify `src/library/os/openssl/p256_crypto_openssl.cpp:8-10,36-54`: delete the pre-3.0 `EC_KEY` branch.
- Modify `src/cmake/licensecc-config.cmake:60`: `find_package(OpenSSL 3.0 REQUIRED COMPONENTS Crypto)`, matching the TPM branch at :56.
- Modify `extern/license-generator/CMakeLists.txt`: :42 (`find_package(OpenSSL 3.0 …)`) and :69-74 (zlib branch). Record the change in `extern/license-generator/PROVENANCE.md`.
- Modify `doc/development/Dependencies.md` and `doc/development/Build-the-library.md`: state OpenSSL ≥ 3.0 wherever an OpenSSL version is named.

**Interfaces:**
- Consumes: Tasks 4 and 7 (fewer OpenSSL call sites).
- Produces:
  - Configuring with OpenSSL < 3.0 fails with `licensecc requires OpenSSL >= 3.0`.
  - Every generated `public_key.h` defines `LCC_PUBLIC_KEY_ID` and the other four macros.
  - Windows presets that disable OpenSSL (`CMAKE_DISABLE_FIND_PACKAGE_OpenSSL`) are unchanged.

- [ ] **Step 1: Write the failing check.** In `scripts/build-purity-static.test.mjs`, add a test asserting that root `CMakeLists.txt` contains `find_package(OpenSSL 3.0 COMPONENTS Crypto QUIET)` and does not contain `VERSION_LESS_EQUAL 1.0.2`, and that `src/templates/public_key.inja` defines `LCC_PUBLIC_KEY_ID`. Run `node --test scripts/build-purity-static.test.mjs`. Expected: FAIL.
- [ ] **Step 2: Implement** the CMake, template and OpenSSL source edits.
- [ ] **Step 3: Grep.**

```bash
git grep -nE "VERSION_LESS_EQUAL 1\.0\.2|OPENSSL_VERSION_NUMBER\s*<\s*0x30000000|ERR_load_crypto_strings|OpenSSL_add_all_algorithms|EVP_MD_CTX_(create|destroy)|compatibility overlay|byte-compatible with older generated" -- CMakeLists.txt src extern cmake
```

  Expected: no output.
- [ ] **Step 4: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug` and `ctest --preset ci-linux-debug-tpm2-capability`
  - `npm run test:docs-quickstart`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `build(core)!: require OpenSSL 3.0 and generate public-key metadata from the template`

### Task 11: Strict source-fatal handling is on by default

**Files:**
- Modify `src/library/licensecc.cpp:42`: `static std::atomic_bool strict_source_fatal_enabled{true};`.
- Modify `include/licensecc/licensecc.h:331-343`: the doc says the default is enabled, and that disabling it downgrades rejected candidates to warnings when another candidate verifies.
- Modify tests:
  - `test/library/public_api_test.cpp`: 376 (symbol check stays), 879, 897, 906, 925, 937, 954, 976, 1003;
  - `test/library/anti_tamper_test.cpp:28,36` (`RuntimePolicyGuard` restores `true`, not `false`).
- Modify `examples/fail_closed_host/main.cpp:74` and `examples/fail_closed_host/README.md:73`: remove the explicit enable call and say that it is the default.

**Interfaces:**
- Consumes: Task 4 (the `lcc_release_license` reader of the flag is gone).
- Produces: `acquire_license` reports a malformed, corrupted, expired, identifier-mismatched or unlicensed-product candidate as fatal, even when another candidate verifies, unless the host calls `lcc_set_strict_source_fatal_enabled(false)`.

- [ ] **Step 1: Write the failing test** in `public_api_test.cpp`: `rejected_candidate_is_fatal_by_default`. With no call to the setter, configure two sources, one valid and one corrupted, call `acquire_license`, and expect the corrupted candidate's fatal event (the same expectation the existing strict-enabled case uses). Run `ctest --preset dev-debug -R public_api`. Expected: FAIL.
- [ ] **Step 2: Flip the default** and update the 12 other call sites so that each test states the mode it needs.
- [ ] **Step 3: Grep.** `git grep -nE "default is disabled for\s+compatibility|for compatibility" -- include/licensecc src/library` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug`
  - `npm run test:docs-quickstart`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `feat(core)!: treat rejected licence sources as fatal by default`

---

## P1b — SDK clients

The SDKs keep:
- config-token (`lcccfg1`) verification;
- `TrustedPublicKey`/key parsing;
- the protected adapters (Python `licensecc.device_bound`/`feature_session`, .NET `Licensecc.Client.DeviceBound.*`, Java JNI `DeviceBoundLibrary`/`FeatureSessionLibrary`);
- the E6 layout and protocol probes.

They lose the backend HTTP clients and the `lccoa1` online-assertion verifiers. No SDK mirrors `LCC_EVENT_TYPE` values (verified), so the native renumbering needs no SDK change.

### Task 12: Python SDK — remove the backend HTTP client and online assertions

**Files:**
- Delete:
  - `sdks/python/src/licensecc/http_client.py` (388 lines; includes the deprecated `request_proof` mapping at :47-56 and :248-295);
  - `sdks/python/src/licensecc/online_assertion.py` (221);
  - `sdks/python/tests/test_http_client.py` (356), `test_online_assertion.py` (286), `test_device_proof.py` (209).
    - :86-180 of `test_device_proof.py` test the deprecated mapping.
    - :183-209 re-check `test/vectors/device_proof/v1`, which native and backend tests already cover.
- Modify `sdks/python/src/licensecc/__init__.py`: docstring :3-20, imports :29, :36-39, :42, `__all__` :52, :54, :56, :65-67.
- Modify `sdks/python/src/licensecc/results.py`:
  - delete `OnlineAssertionClaims` (:53-70);
  - delete `VerificationResult.used_cache` (:96-97, :105-106, :115-119);
  - delete the six `RejectionCode` members used only by `online_assertion.py`: `STATUS_UNSUPPORTED` :40, `STATUS_DENIED` :41, `HEX_FIELD_MALFORMED` :43, `TIME_WINDOW_MALFORMED` :44, `CACHE_WINDOW_EXCEEDED` :45, `REVOCATION_BELOW_FLOOR` :47.
- Modify the docstrings at `sdks/python/src/licensecc/_signed_token.py:3` and `config_attestation.py:3`.
- Modify `sdks/python/tests/conftest.py`: :4 docstring, :18 `ONLINE_DIR`, :26-31 `OnlineGolden`, :48-57 `online_golden`.
- Modify `sdks/python/tests/test_keys.py`:
  - all 8 tests use `config_golden` (`test/vectors/config_attestation/golden.public_key.pkcs1.der.hex`, also 3072-bit PKCS#1) instead of `online_golden`;
  - use the embedded golden key as the "unknown key";
  - delete the older-`cryptography` tolerance at :29-45 (the `try/except` at :38-42).
- Modify `sdks/python/tests/test_config_attestation.py`:
  - :155-159 `test_config_unknown_key_id_rejected` trusts the embedded config key;
  - delete :162-187 `test_config_wrong_purpose_rejected`, because the parametrised `lccoa1.aGVsbG8=.aGVsbG8=` case at :192 still proves prefix separation.
- Modify `sdks/python/pyproject.toml`: description :4, comment :17-18, the `httpx` optional extra :23-27 (imported by nothing). Regenerate `sdks/python/uv.lock` with `uv lock --directory sdks/python`.
- Modify docs:
  - `sdks/python/README.md`: :3-13, :17-37, :41-43, :49, :56-58, :60-94 ("Verify an online assertion"), :120-163 ("Call the verifier over HTTP"), :175-191;
  - `sdks/python/native/README.md:14`;
  - `doc/api/python.rst`: :4-6, :18, :25-26, :37-38, :55-62;
  - `doc/api/sdks.rst:16-20` (Python row);
  - `doc/tutorials/sdk-and-support.rst:7-8,17,20,23`;
  - `README.md:121`.
- Modify `scripts/docs-accuracy.test.mjs:563-564`: assert `autofunction:: verify_config_token` and assert that `autoclass:: HttpClient` is absent.
- Modify `scripts/check-version-contract.mjs:68,535-537` (Python user-agent anchor in `http_client.py`; the Python version stays anchored by `pyproject.toml`, `uv.lock` and `__version__`), `scripts/check-version-contract.test.mjs:56,153`, `scripts/release-artifacts.test.mjs:124,149-150,322`.
- Modify `doc/capabilities/registry.json`, entry `python-sdk` (:226-241):
  - title "Python SDK token verification";
  - surfaces drop "Python HTTP client";
  - evidence becomes `sdks/python/src/licensecc/config_attestation.py` selector `def verify_config_token(` and `sdks/python/tests/test_config_attestation.py` selector `def test_golden_config_token_verifies`.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `import licensecc` exports config-token, key and protected-adapter names only.
  - `licensecc.HttpClient`, `verify_online_assertion`, `OnlineAssertionExpected` and `OnlineAssertionClaims` no longer exist.

- [ ] **Step 1: Delete the listed files** and edit `__init__.py` first, so `import licensecc.device_bound` keeps working (it breaks if `__init__` still imports deleted modules).
- [ ] **Step 2: Rewire the offline tests** off `online_golden` as listed.
- [ ] **Step 3: Update packaging, docs, version anchors and the registry.**
- [ ] **Step 4: Grep.**

```bash
git grep -nE "http_client|HttpClient|ApiResponse|online_assertion|verify_online_assertion|OnlineAssertion|online_golden|used_cache|request_proof|httpx|CACHE_WINDOW_EXCEEDED|REVOCATION_BELOW_FLOOR" -- sdks/python doc/api/python.rst doc/api/sdks.rst scripts doc/capabilities
```

  Expected: no output.
- [ ] **Step 5: Run the gates.**
  - `npm run test:sdks`
  - `npm run test:versions`
  - `npm run check:versions`
  - `npm run test:release-artifacts`
  - `npm run test:docs-accuracy`
  - `npm run check:docs` (autodoc `-W`)
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `refactor(sdk-python)!: remove the backend HTTP client and online-assertion verifier`

### Task 13: .NET SDK — remove the backend client and online assertions

**Files:**
- Delete:
  - `sdks/dotnet/src/Licensecc.Client/LicensingBackendClient.cs` (281; defines `BackendResponse` and `RequestBody`);
  - `OnlineAssertion.cs` (295);
  - `Json.cs` (372; only `LicensingBackendClient.cs:150,230` use it);
  - `sdks/dotnet/test/Licensecc.Client.Tests/HttpClientTests.cs` (263) and `OnlineAssertionTests.cs` (323).
- Modify:
  - `sdks/dotnet/src/Licensecc.Client/Hex.cs:53`: delete `IsAsciiHex`, which only `OnlineAssertion.cs` used.
  - Delete any `VerifyFailureCode` member referenced only by `OnlineAssertion.cs`. Grep each member after deleting the file.
- Modify `sdks/dotnet/test/Licensecc.Client.Tests/ConfigTokenTests.cs`:
  - delete :155-174 `Negative_WrongPurpose_RejectedViaOnlineVerifier`;
  - :196-206 `Negative_UnknownKeyId_Rejected` trusts a freshly generated key instead of the online golden key: `using RSA rsa = RSA.Create(3072); TrustedPublicKey.FromPkcs1DerHex(Convert.ToHexString(rsa.ExportRSAPublicKey()))`.
- Modify `sdks/dotnet/test/Licensecc.Client.Tests/GoldenVectors.cs:17` (`OnlineDir`).
- Modify `sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj:25-31`: the description drops `lccoa1` and the HttpClient wrapper; "Windows x64" becomes "Windows and Linux x64".
- Modify `sdks/dotnet/README.md`: :5, :27-38, :42, :116-129 (layout), :152-195, :225-281.
- Modify `doc/api/sdks.rst:21-26` (.NET row).
- Modify `doc/capabilities/registry.json`, entry `dotnet-sdk` (:242-257): evidence becomes `ConfigToken.cs` and `ConfigTokenTests.cs`; surfaces drop the HTTP client.

**Interfaces:**
- Consumes: nothing.
- Produces: `Licensecc.Client` exposes `ConfigTokenVerifier`, `TrustedKeyRing`/`TrustedPublicKey` and `Licensecc.Client.DeviceBound.*` only.

- [ ] **Step 1: Delete the files** and fix the compile errors they leave.
- [ ] **Step 2: Rewire `ConfigTokenTests` and `GoldenVectors`.**
- [ ] **Step 3: Grep.** `git grep -nE "LicensingBackendClient|OnlineAssertion|BackendResponse|OnlineDir|IsAsciiHex|\bJson\.(Serialize|Parse)" -- sdks/dotnet doc/api/sdks.rst doc/capabilities` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `dotnet test sdks/dotnet/Licensecc.Client.sln`
  - `npm run test:sdks`
  - `npm run check:capabilities`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `refactor(sdk-dotnet)!: remove the backend client and online-assertion verifier`

### Task 14: Java SDK — remove the backend client and online assertions

**Files:**
- Delete `sdks/java/src/main/java/io/licensecc/client/LicensingBackendClient.java` (154), `BackendResponse.java` (18), `OnlineAssertion.java` (126).
- Move `sdks/java/src/main/java/io/licensecc/client/Json.java` to `sdks/java/src/test/java/io/licensecc/client/Json.java` with `git mv`. It is package-private. Its only remaining users are `DeviceBoundVectorsTest.java:165` and `SdkTest.java:85-87`.
- Modify `sdks/java/src/test/java/io/licensecc/client/SdkTest.java`:
  - `main` drops :24 `onlineGolden()` and :30 `httpContract()` and keeps :27-29;
  - delete :34-54 `onlineGolden`, :74-84 (the online and `parseResponse` parts of `failClosedParsing`), :91-126 `httpContract`, :128-134 `respond`;
  - delete the imports at :3-4, :8, :9, :13, :16, :17.
- Modify `sdks/java/src/main/java/io/licensecc/client/RejectionCode.java`: delete the members at :21, :22, :24, :25, :26, :28 if no surviving class uses them (grep each).
- Modify `sdks/java/src/main/java/io/licensecc/client/DeviceBoundClient.java`: delete the five-argument `Outcome` constructor (:42-46); `BUSY` (:53) uses the six-argument form with `DenialDetail.NONE`.
- Modify `sdks/java/src/test/java/io/licensecc/client/DeviceBoundAdapterTest.java:172-174` (five-argument use).
- Modify `scripts/test-java-sdk.mjs:34-35`: drop `--add-modules jdk.httpserver`.
- Modify `scripts/check-version-contract.mjs:71,545-547` (the `VERSION` anchor on `LicensingBackendClient.java:17`; the version stays anchored by `MANIFEST.MF` and the README jar line), `scripts/check-version-contract.test.mjs:60,157`, `scripts/release-artifacts.test.mjs:326`.
- Modify `sdks/java/README.md`: :5, :24-32, :52-53, :64-108, :110-166, :168-211, :213-218. Keep :19-21 and :57.
- Modify `sdks/java/native/README.md:38-39`, `doc/api/sdks.rst:27-31` (Java row).
- Modify `doc/capabilities/registry.json`, entry `java-sdk` (:326-341): evidence becomes `ConfigAttestation.java` and `SdkTest.java` selector `configGolden`.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - The Java jar contains config-token verification, keys and the JNI protected adapters.
  - `DeviceBoundClient.Outcome` has one constructor.

- [ ] **Step 1: Delete and move the files**; fix `SdkTest` and the `Outcome` callers.
- [ ] **Step 2: Grep.** `git grep -nE "LicensingBackendClient|BackendResponse|OnlineAssertion|onlineGolden|httpContract|jdk\.httpserver|VERSION = \"" -- sdks/java scripts doc/capabilities` must print nothing.
- [ ] **Step 3: Run the gates.**
  - `npm run test:java-sdk`
  - `npm run test:sdks`
  - `npm run test:versions`
  - `npm run check:versions`
  - `npm run test:release-artifacts`
  - `npm run check:pr`
- [ ] **Step 4: Commit.** `refactor(sdk-java)!: remove the backend client, online-assertion verifier and the old Outcome constructor`

### Task 15: Remove the tolerance for bridges without feature-session exports

The SDKs turn a missing feature-session export into a friendly "unsupported" error so that an older bridge DLL keeps working. The bridge ships in the same release as the SDK, so a missing export is a broken install. The E6 layout and protocol probes stay: a present-but-mismatched layout is still rejected.

**Files:**
- Modify `sdks/python/src/licensecc/_feature_session_abi.py`: :1 docstring, :24 `try:`, :41-42 `except AttributeError` → `NotImplementedError`. Keep :13-17 and :25-28, the layout probe.
- Modify `sdks/python/src/licensecc/feature_session.py:69-70` (docstring).
- Modify `sdks/python/native/CMakeLists.txt:34-44`: delete the `LCC_BRIDGE_BUILD_TESTS` `licensecc_device_bound_original` target and its `original-exports.def` generation.
- Modify `sdks/python/tests/test_feature_session_bridge.py`: delete :114-116 and :138-145.
- Modify `scripts/ci/run-installed-python-device-bound.ps1`: :29, :41, :54-58, :66, :72.
- Modify `.github/workflows/windows.yml:171-172` (`LCC_TEST_OLD_DEVICE_BOUND_DLL`).
- Modify .NET:
  - `sdks/dotnet/src/Licensecc.Client/FeatureSessionNative.cs:61,71` (the `try`/`catch (EntryPointNotFoundException)`; keep :15-28 and :63);
  - `FeatureSession.cs:15`;
  - `sdks/dotnet/test/Licensecc.Client.Tests/FeatureSessionTests.cs:94-103` (`OriginalExportsRejectOptionalApiWithoutBreakingDeviceBound`).
- Modify Java:
  - `sdks/java/src/main/java/io/licensecc/client/FeatureSessionNative.java:9,11-13` (keep :10, the version check);
  - `sdks/java/src/test/java/io/licensecc/client/FeatureSessionAdapterTest.java:89-95`;
  - `scripts/test-java-sdk.mjs:38-41`.
  - Keep the JNI test fixture (`sdks/java/native/bridge.cpp:248`, `sdks/java/native/CMakeLists.txt:31-40`): `DeviceBoundAdapterTest.java:237-242` uses it.
- Modify docs:
  - `sdks/python/README.md:235-236`;
  - `sdks/python/native/README.md:3-8,113-116`;
  - `sdks/dotnet/README.md:21-23,112-114`;
  - `sdks/java/native/README.md:8-11`;
  - `doc/api/feature_sessions.rst:102-104` ("Windows bridge DLL" becomes "native bridge").

**Interfaces:**
- Consumes: nothing.
- Produces: loading feature sessions against a bridge without the exports fails with the platform loader error (`AttributeError`, `EntryPointNotFoundException`, `UnsatisfiedLinkError`). The layout and protocol probes are unchanged.

- [ ] **Step 1: Delete the tolerance code, the original-exports target and the tests that pinned it.**
- [ ] **Step 2: Grep.**

```bash
git grep -nE "LCC_TEST_OLD_DEVICE_BOUND_DLL|licensecc_device_bound_original|original-exports|does not support feature sessions|older DLL|Old native bridges|OriginalExports" -- sdks scripts .github doc
```

  Expected: no output.
- [ ] **Step 3: Run the gates.**
  - `npm run test:sdks`
  - `npm run test:workflow-pins`
  - On Windows: `pwsh -NoProfile -File scripts/ci/run-installed-python-device-bound.ps1`, after the install build it documents.
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 4: Commit.** `refactor(sdks)!: stop tolerating native bridges without feature-session exports`

---

## P2 — Writers become protected-only

After this phase, no production code path can create a legacy row. Legacy routes still exist until P5 and serve only rows that tests insert directly. The protected create checks in `services/cloudflare-license-admin/src/worker/groups/entitlements/protected-checks.ts:82-86` require:
- an active customer;
- licence ownership;
- fingerprint pairing;
- a device limit;
- `pool_size = 0`.

### Task 16: Shared entitlement writes and admin create are protected-only

**Files:**
- Modify `packages/cloudflare-runtime/src/d1/entitlement_mutation.mjs:342-350` (`createEntitlement`):
  - always insert `enforcement_mode = 'device_bound_v1'` and guard the conflict update with `AND entitlements.enforcement_mode = 'device_bound_v1'`;
  - throw `invalid_patch` for any `input.enforcement_mode` other than `device_bound_v1`;
  - keep `enforcement_mode_conflict` for an existing non-protected row.
- Modify `packages/cloudflare-runtime/src/d1/entitlement_mutation.d.ts` (input type).
- Modify `services/cloudflare-license-admin/src/worker/groups/entitlements/create-enforcement.ts`:
  - :19: delete the non-protected branch, so every create runs the protected checks and `protectedCreateAssertion`;
  - :41-47: `enforcement_mode` is required and must equal `"device_bound_v1"`;
  - :55;
  - :58-67: `createReplayAdmission` always applies.
- Modify `services/cloudflare-license-admin/src/worker/groups/entitlements/entitlement-schema.ts:7,38,41-54,76`: `enforcement_mode` `const: "device_bound_v1"`, required.
- Modify `services/cloudflare-license-admin/src/worker/groups/entitlements/protected-checks.ts:38,63-70`: delete `HISTORY_TABLES` and the `lease_history_exists` rule. A protected denial row in `usage_events`, written by `bound_issue.mjs:88`, otherwise refuses a later re-create of the same key. Every create is now protected, so the defect would hit every create.
- Modify `services/cloudflare-license-admin/src/shared/api.ts` (the `ProtectedCreateReason` union drops `lease_history_exists`).
- Modify the admin UI:
  - `services/cloudflare-license-admin/src/ui/features/entitlements/workflow.ts`: :25, :56 (default `enforcement_mode: "device_bound_v1"`), :366-367, and the policy picker :134-144 (`policyGrant`/`policyOptionLabel` exclude `type === "floating"`);
  - `EntitlementEditor.tsx:36,79,95`: delete the mode select; the form always sends `device_bound_v1`;
  - `services/cloudflare-license-admin/src/ui/shared/messages.ts:69` (`lease_history_exists` copy).
- Modify admin test fixtures:
  - `services/cloudflare-license-admin/test/worker/fixtures.mjs:134-156`: the default row is `device_bound_v1`, owned by a seeded active customer with a licence, `pool_size` 0;
  - `test/admin-ui.fixture.mjs:583-621,1815-1848` (`seedEntitlement` and create default).
- Modify admin tests:
  - `test/worker/entitlements.test.mjs:66-348` (creates now carry a customer, licence and `enforcement_mode`);
  - `test/sql/protected-create.test.mjs:55-78,149-171,197-224,241,261`;
  - `test/sql/audit-json-object.test.mjs:92`;
  - `test/sql/workstream-f.test.mjs:191`;
  - `test/admin-ui.lifecycle.e2e.mjs:5-6,31,63,92`;
  - `test/admin-ui.onboarding.e2e.mjs:112,130`;
  - the UI workflow test `test/admin-ui-workflow/entitlements.test.mjs:59,63,130-158,200-215,311-316`.
- Modify backend tests that go through `createEntitlement`:
  - `services/cloudflare-licensing-backend/test/entitlement-mutation.test.mjs`: expectations become `device_bound_v1`.
  - `services/cloudflare-licensing-backend/test/e2e/admin-sync-flow.test.mjs`. Sync now yields protected rows, so the `/v1/verify` assertions at :209-222 fail. Sync the grant with `customer_id`/`license_id` for a seeded active customer and licence, and finish with a signed protected exchange, copying the flow at `test/e2e/protected-admin-enrollment.test.mjs:43-70`.
- Tests of legacy-only admin routes (release-seats, devices, meter and resources in `test/sql/workstream-f.test.mjs:512-675`, `test/sql/admin-console.test.mjs:332-370`, `test/sql/device-limit.test.mjs:15,77-121,199-223`, `test/worker/transition-contracts.test.mjs:197-243`) must no longer create their grants through the admin API. They seed them with an explicit SQL insert of `enforcement_mode = 'legacy'` until Task 23 deletes those routes and tests. Triggers refuse seat and device rows on protected grants.
- Modify `doc/capabilities/registry.json:190` (`admin-control-plane` cites the lifecycle e2e title that creates a legacy grant; update the selector to the renamed title).
- Modify `services/cloudflare-license-admin/README.md:111-122` (mode default text).

**Interfaces:**
- Consumes: Task 2 (baseline).
- Produces:
  - `POST /api/admin/entitlements` requires `enforcement_mode: "device_bound_v1"`. An omitted or `"legacy"` mode returns 400 `invalid_request`.
  - `createEntitlement` never writes a legacy row.
  - `ProtectedCreateReason` no longer includes `lease_history_exists`.

- [ ] **Step 1: Write the failing tests** in `services/cloudflare-license-admin/test/worker/entitlements.test.mjs`:

```js
test("admin create without enforcement_mode is refused", async () => {
  const { env, request } = protectedCreateFixture(); // extend fixtures.mjs: seeded active customer + licence
  const body = { project: "APP", feature: "PRO", license_fingerprint: "c".repeat(64), customer_id: "cus_1", license_id: "lic_1" };
  const response = await request("/api/admin/entitlements", body);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_request");
});

test("admin create with enforcement_mode legacy is refused", async () => {
  const { request } = protectedCreateFixture();
  const response = await request("/api/admin/entitlements", { project: "APP", feature: "PRO", license_fingerprint: "c".repeat(64),
    customer_id: "cus_1", license_id: "lic_1", enforcement_mode: "legacy" });
  assert.equal(response.status, 400);
});
```

  Add `protectedCreateFixture()` to `test/worker/fixtures.mjs`. It returns `{ env, db, request(path, body) }`, where `request` POSTs with the fixture's dev bearer and a fresh `idempotency-key`, over a database seeded with active customer `cus_1` and licence `lic_1` (project `APP`, owned by `cus_1`).

  In `test/sql/protected-create.test.mjs`, add `a protected denial does not block re-creating the same grant`. Insert a `usage_events` row (`event_type 'denied'`, `reason 'device_limit_reached'`, `device_key_id` = the key) for an existing protected grant's key, re-create the grant with the same fingerprint, and expect 200. This replaces the old `lease_history_exists` pin at :155/:241.

  Run `npm run test:admin`. Expected: FAIL on all three.
- [ ] **Step 2: Implement** the runtime and admin changes above.
- [ ] **Step 3: Migrate every admin fixture and test** that relied on the legacy default, as listed. A test whose purpose was the legacy create branch is deleted.
- [ ] **Step 4: Run the UI changes.** Build and run `npm run test:ui --workspace @licensecc/cloudflare-license-admin` and `CI=1 npm run test:e2e --workspace @licensecc/cloudflare-license-admin`.
  - Update `test/admin-ui-e2e-layout.test.mjs:36` (196 titles) only if a scenario is deleted or added, and state the new count in the commit.
- [ ] **Step 5: Regenerate contracts.** `npm run write:contract-baselines`, review the admin diff (the `enforcement_mode` schema), then `npm run test:contracts`.
- [ ] **Step 6: Grep.** `git grep -nE "enforcement_mode:\s*\"legacy\"|mode !== \"legacy\"|lease_history_exists|HISTORY_TABLES" -- services/cloudflare-license-admin packages/cloudflare-runtime/src` must print nothing.
- [ ] **Step 7: Run the gates.**
  - `npm run test:admin`
  - `npm run test --workspace @licensecc/cloudflare-runtime`
  - `npm run test:e2e --workspace @licensecc/cloudflare-licensing-backend` (runs `e2e/protected-admin-enrollment.test.mjs`)
  - admin `test:e2e`
  - `npm run check:dry-run`
  - `npm run check:pr`
- [ ] **Step 8: Commit.** `feat(admin)!: create only protected grants and stop protected denials blocking re-creation`

### Task 17: Plan apply, policy stamps and sync keep protected grants usable

This fixes two latent defects:
- Plan apply's UPDATE writes `device_hash`, TTLs, `pool_size`, `max_borrow_sec` and `meter_*` onto any row, protected ones included (`packages/cloudflare-runtime/src/d1/plan_projection.mjs:585-626`). A non-zero `pool_size` then makes the grant unusable (`bound_issue.mjs:56`).
- Admin PATCH (`services/cloudflare-license-admin/src/worker/groups/entitlements/validation.ts:133-141`) and sync can set a non-empty `device_hash` on a protected row.

**Files:**
- Modify `packages/cloudflare-runtime/src/d1/plan_projection.mjs`:
  - INSERT :537-583: add `enforcement_mode` = `'device_bound_v1'`; write `device_hash` `''`, `pool_size` 0, `max_borrow_sec` 0, `meter_quota` 0 and the column defaults for the TTLs and `meter_period_sec`;
  - UPDATE :585-626: stop writing `device_hash`, `assertion_ttl_seconds`, `cache_ttl_seconds`, `pool_size`, `max_borrow_sec`, `meter_quota`, `meter_period_sec`;
  - :484-535 (the comparison that decides "changed"): drop the same fields.

  `wc -l` must stay ≤ 1031 (hotspot).
- Modify `packages/cloudflare-runtime/src/entitlements/policy_store.mjs:4-29` (`buildPolicyStampStatement`): stop writing `pool_size`, `max_borrow_sec`, `meter_quota`, `meter_period_sec`.
- Modify `packages/licensing-domain/src/catalog/plan_projection.mjs:3-9,131-171,173-197`: `DEFAULT_CAPACITY` and `desiredPlanProjectionRow` stop producing legacy capacity; `capabilityMode` never returns `floating`.
- Modify `services/cloudflare-license-admin/src/worker/groups/entitlements/validation.ts`: :84-88, :109, :133-141 (reject `device_hash` on create and PATCH); :90, :111, :142-148 (reject `assertion_ttl_seconds`).
- Modify `services/cloudflare-license-admin/src/worker/groups/sync/operations.ts:36`: sync input requires `customer_id` and `license_id`, carries `enforcement_mode: "device_bound_v1"`, and runs the same protected checks as admin create (`createWithEnforcement` from `create-enforcement.ts`).
- Modify `services/cloudflare-license-admin/scripts/sync-entitlement.mjs:78-106` and `src/shared/sync-client.ts` (send `customer_id`, `license_id`).
- Modify `services/cloudflare-license-admin/test/worker/sync.test.mjs`: the cases at :54, :84, :116 already send `customer_id`; add `license_id` and seed the active customer and the owned licence.
- Modify tests:
  - `services/cloudflare-licensing-backend/test/sql/plan-projection.test.mjs:315-349` (protected-row cases) plus the new test below;
  - `test/sql/policy-stamp.test.mjs`;
  - `services/cloudflare-license-admin/test/sql/plan-projection-admin.test.mjs:741,796`;
  - `services/cloudflare-licensing-backend/test/sql/bound-admin-writers.test.mjs:68-73`;
  - `services/cloudflare-licensing-backend/test/e2e/catalog-admin-projection-flow.test.mjs:50,158`: plan apply now yields protected rows, so replace the `/v1/verify` assertions with a signed protected exchange, copying the flow at `test/e2e/protected-admin-enrollment.test.mjs:43-70`.
- Modify `services/cloudflare-license-admin/README.md:603-643` (sync section).

**Interfaces:**
- Consumes: Task 16.
- Produces:
  - Plan apply writes only protected-relevant columns.
  - `POST /api/sync/entitlements` requires `customer_id` and `license_id` and yields `device_bound_v1` rows.
  - Admin create and PATCH reject `device_hash` and `assertion_ttl_seconds` with 400 `invalid_request`.

- [ ] **Step 1: Write the failing tests.**
  - In `services/cloudflare-licensing-backend/test/sql/plan-projection.test.mjs`, add `plan apply keeps a protected grant issuable`:
    - seed a protected grant (the existing :319 insert shape);
    - seed a catalog feature whose plan row carries `pool_size = 5`, `max_borrow_sec = 60`, `meter_quota = 10`;
    - preview and apply;
    - assert the row keeps `enforcement_mode = 'device_bound_v1'`, `pool_size = 0`, `max_borrow_sec = 0`, `meter_quota = 0`, `device_hash = ''`;
    - assert that the protected authority query (`SELECT … WHERE pool_size = 0 AND enforcement_mode = 'device_bound_v1'`, as in `bound_issue.mjs:51-60`) still finds it.
  - Add `plan apply creates protected rows`.
  - In `services/cloudflare-license-admin/test/worker/entitlements.test.mjs`, add `PATCH refuses device_hash on a protected grant` (400, and the row is unchanged).
  - In `services/cloudflare-license-admin/test/worker/sync.test.mjs`, add `sync without customer_id is refused`.

  Run `npm run test:backend` and `npm run test:admin`. Expected: FAIL.
- [ ] **Step 2: Implement** the runtime, domain and admin changes.
- [ ] **Step 3: Rewrite the catalog projection e2e flow** to finish with a signed protected exchange instead of `/v1/verify`.
- [ ] **Step 4: Regenerate contracts** (`npm run write:contract-baselines`, review, `npm run test:contracts`).
- [ ] **Step 5: Grep.** `git grep -nE "device_hash = excluded|pool_size = excluded|meter_quota = excluded|max_borrow_sec = excluded" -- packages/cloudflare-runtime/src services/cloudflare-license-admin/src` must print nothing.
- [ ] **Step 6: Run the gates.**
  - `npm run test --workspace @licensecc/licensing-domain`
  - `npm run test --workspace @licensecc/cloudflare-runtime`
  - `npm run test:backend`
  - `npm run test:e2e --workspace @licensecc/cloudflare-licensing-backend`
  - `npm run test:admin`
  - admin `test:e2e`
  - `npm run check:hotspots`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `fix(entitlements): keep plan-applied and synced grants protected and issuable`

### Task 18: Order ingest creates protected grants and requires a customer

**Files:**
- Modify `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs`:
  - `buildCreateStatement` :329-364: insert `enforcement_mode` `'device_bound_v1'`; drop `pool_size` from the column list, `VALUES` and `DO UPDATE SET`;
  - :59-62 stale comment; :431 capacity allow-list; :483 audit JSON;
  - :632-667, :687-688, :716-728, :776-784 (seat reclaim and the `usage_events` `'reclaim'` insert);
  - :816-818 (`customer_id` fallback and `pool_size` from quantity).
- Modify `services/cloudflare-licensing-backend/src/fulfillment/order_event.mjs`:
  - :37: `QUANTITY_FIELDS` becomes `max_active_devices` only;
  - :216-240;
  - :242-280: `customer` and `customer.id` are required for every intent; a missing one returns `{ error: "invalid_order" }`.
- Modify `services/cloudflare-licensing-backend/src/fulfillment/order_mutation.mjs:110-131` (the `quantity.changed` reclaim descriptor).
- Modify `services/cloudflare-licensing-backend/src/openapi/components.ts:271-279` (`OrderRequest.quantity` drops `pool_size`; `customer` and `customer.id` required).
- Modify tests:
  - `services/cloudflare-licensing-backend/test/fulfillment/order_ingest_exactly_once.test.mjs`:
    - `makeOrder` (:126-140) carries `customer: { id: "cus_order" }`;
    - delete the seat cases 9 (:589-609), 13 (:677-696), 13b (:698-715), 13d (:1037-1057), 13c (:1089-1117) and the pool/seat parts of 14b (:1131-1260);
    - delete `liveSeats`/`seedSeats` (:194-206);
    - rewrite 11h and 11i (:937-997), the NULL-then-fill identity cases, to expect refusal.
  - `test/fulfillment/order_event.test.mjs`: :56-72, :124, :132, :156-162, :324-355, :380.
  - `test/fulfillment/order_ingest_gates.test.mjs:406-417`.
  - `test/staging-order-drill.test.mjs` and `scripts/staging-order-drill.mjs`: the fixture already sends `customer_id`; confirm it sends `customer.id`.
- Modify `scripts/hotspot-baseline.json`: lower `order_ingest.mjs` to its new count.
- Modify `doc/architecture/system-map.md:107` (`order_ingest.mjs` row).
- Modify `services/cloudflare-licensing-backend/README.md:514-574` (order ingest section, `pool_size` at :546-548).

**Interfaces:**
- Consumes: Task 16.
- Produces:
  - `POST /v1/orders` requires `customer.id`. A body without it, or with `quantity.pool_size`, returns 400 `invalid_order`.
  - A `subscription.active` order creates or updates a `device_bound_v1` row owned by that customer.
  - Seat reclaim no longer exists.

- [ ] **Step 1: Write the failing tests** in `order_ingest_exactly_once.test.mjs`:
  - `an order creates a protected grant owned by its customer`: apply `subscription.active` with `customer: { id: "cus_order" }`, and assert `enforcement_mode = 'device_bound_v1'`, `customer_id = 'cus_order'`, `pool_size = 0`.
  - `an order without a customer is refused`: `handleOrderIngest` returns 400 `invalid_order` and no `entitlements` row exists.
  - `quantity.pool_size is refused`: 400 `invalid_order`.

  Run `npm run test:sql --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Implement** the order changes.
- [ ] **Step 3: Delete or rewrite the seat and NULL-owner tests** as listed.
- [ ] **Step 4: Regenerate contracts** (`npm run write:contract-baselines`, review the backend `OrderRequest` diff, `npm run test:contracts`).
- [ ] **Step 5: Grep.** `git grep -nE "pool_size|seat_checkouts|reclaim" -- services/cloudflare-licensing-backend/src/fulfillment` must print nothing.
- [ ] **Step 6: Run the gates.**
  - `npm run test:backend`
  - `npm run test:deployed-readiness --workspace @licensecc/cloudflare-licensing-backend` (staging-order-drill tests)
  - `npm run check:hotspots`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `feat(orders)!: materialise protected grants and require the customer on every order`

### Task 19: Operator tools create protected grants with an owner

**Files:**
- Modify `services/cloudflare-licensing-backend/scripts/entitlement.mjs`:
  - :206: `--customer-id` is required, and so is `--license-id`;
  - :219: `upsert` inserts `enforcement_mode` `'device_bound_v1'` and no longer clears `customer_id` on conflict;
  - delete the `device-upsert`, `device-disable`, `device-revoke` and `device-list` commands (:23-26, :238-266, and their `MUTATION_COMMANDS` entries at :282). They write `entitlement_devices`, which triggers reject for protected rows.
- Modify `services/cloudflare-licensing-backend/test/contexts/operator-tools.test.mjs`:
  - :100-105 "leaves customer_id and license_id NULL when unset" becomes "upsert requires --customer-id and --license-id";
  - the CLI cases at :39-106 and :126-136 pass an owner.
- Modify `services/cloudflare-licensing-backend/test/sql/entitlement-cli-sql.test.mjs`: :29, and delete the device-* cases at :39-41 and :175-228.
- Modify `services/cloudflare-license-admin/scripts/validate-access-admin.mjs:219-229,285`: create a customer and a licence through the admin API first, then create the grant with `enforcement_mode: "device_bound_v1"`, `customer_id`, `license_id`.
- Modify `services/cloudflare-license-admin/scripts/remote-d1-atomicity.mjs:150`: the raw INSERT writes `enforcement_mode = 'device_bound_v1'` and an owning customer row.
- Modify `services/cloudflare-license-admin/README.md:585-601` and `services/cloudflare-licensing-backend/README.md:491-511` (CLI sections).

**Interfaces:**
- Consumes: Task 16.
- Produces:
  - `npm run entitlement -- upsert` requires `--customer-id` and `--license-id` and writes protected rows.
  - The `device-*` commands no longer exist.

- [ ] **Step 1: Write the failing test** in `operator-tools.test.mjs`: `break-glass upsert without --customer-id is refused` (the CLI exits non-zero with a usage error before emitting SQL). Run `npm run test --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Implement** the CLI changes and update the two admin drills.
- [ ] **Step 3: Grep.** `git grep -nE "device-upsert|device-disable|device-revoke|device-list" -- services scripts doc` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `npm run test:backend`
  - `npm run test:admin`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `feat(cli)!: break-glass entitlements are protected and always owned`

---

## P3 — Portal

The protected staging drill lands first in this phase. Today every deployed licensing drill is legacy: the portal seat and download mutations, the backend lease drill and the public-verifier drill. Each of them is removed only in the same task as the route it exercises, so no deploy runs without a licensing smoke test.

### Task 20: The staging portal drill proves a protected enrollment, exchange and renewal

The backend proves key possession and does not verify attestation (ADR 0006:33-35), so the drill can use a software P-256 key, with no TPM.

**Files:**
- Modify `services/cloudflare-customer-portal/scripts/staging-portal-drill.mjs`:
  - delete `runSeatCycle` (:364-406), `runDownload` (:408-433), the `/devices` and `/usage` reads (:456-457), the result fields (:486-489) and the env aliases (:12-16, :128-132);
  - add `runProtectedDeviceJourney(options)` (Step 3).
- Modify `services/cloudflare-customer-portal/test/staging-portal-drill.test.mjs`: :94-115, :131-186, and the new journey test.
- Modify `.github/workflows/deploy-staging.yml`:
  - inputs :30-37: replace `portal_floating_entitlement_id` and `portal_download_entitlement_id` with `portal_protected_entitlement_id`;
  - "Run synthetic staging tenant drills" env :176-195: delete `STAGING_PORTAL_ALLOW_SEAT_MUTATION`, `STAGING_PORTAL_FLOATING_ENTITLEMENT_ID`, `STAGING_PORTAL_ALLOW_DOWNLOAD`, `STAGING_PORTAL_DOWNLOAD_ENTITLEMENT_ID`;
  - add `STAGING_BACKEND_BASE_URL: ${{ inputs.backend_url }}`, `STAGING_PORTAL_PROTECTED_ENTITLEMENT_ID: ${{ inputs.portal_protected_entitlement_id }}`, `STAGING_DEVICE_CLIENT_ID: ${{ vars.LICENSECC_STAGING_DEVICE_CLIENT_ID }}`, `STAGING_DEVICE_PROJECT: ${{ vars.LICENSECC_STAGING_DEVICE_PROJECT }}`, `STAGING_DEVICE_FEATURE: ${{ vars.LICENSECC_STAGING_DEVICE_FEATURE }}`, `STAGING_DEVICE_REDIRECT_URI: ${{ vars.LICENSECC_STAGING_DEVICE_REDIRECT_URI }}`, `STAGING_DEVICE_AUDIENCE: ${{ vars.LICENSECC_STAGING_DEVICE_AUDIENCE }}` (the `audience` of the staging `BOUND_DEVICE_CONFIG`), `STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM: ${{ vars.LICENSECC_STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM }}`.
- Modify `scripts/workflow-action-pins.test.mjs:707-708` (the seat and download flags); pin the new env names instead.
- Modify `services/cloudflare-customer-portal/README.md:188-199` (drill mutation flags).
- Modify `doc/release-artifacts.md:225-226` and `doc/operations/production-readiness.md` PRD-03 (:146-193, the floating-seat portal drill wording).

**Interfaces:**
- Consumes: the backend `/v2/device-authorizations`, `/v2/device-challenges`, `/v2/device-authorizations/exchange`, `/v2/device-leases/renew`; the portal `/api/portal/device-authorizations/{inspect,approve}` and `/api/portal/device-bindings/retire`; `@licensecc/licensing-domain/lease/device_protocol` (`encodeBase64url`, `deviceOperationBody`, `deviceProofSigningInput`, `decodeDeviceLeaseEnvelope`, `deviceLeaseSigningInput`).
- Produces:
  - `runStagingPortalDrill` evidence gains `protected_device: { exchanged: true, renewed: true, retired: true, lease_key_id }`.
  - The synthetic staging entitlement must be protected, owned by the drill customer, with `max_active_devices` of at least 20. A retired binding holds its slot until `hold_until` (at most 24 h + 120 s), so each run consumes one slot for a day.

- [ ] **Step 1: Write the failing test** in `staging-portal-drill.test.mjs`: `the staging portal drill completes a protected enrollment, exchange and renewal and retires the binding`.
  - The fake `fetch` serves the portal and backend routes.
  - The fake backend signs leases with an RSA-3072 key generated in the test, using `encodeDeviceLeasePayload`, `deviceLeaseSigningInput`, `encodeDeviceLeaseEnvelope` and `crypto.subtle.sign`.
  - It asserts:
    - the drill posts the four `/v2` calls and the three portal calls in order;
    - each proof verifies against the drill's reported SPKI;
    - the drill rejects a lease signed by a different key (a second run where the fake signs with another key must fail with a redacted error).
  - Run `node --test services/cloudflare-customer-portal/test/staging-portal-drill.test.mjs`. Expected: FAIL, because the function does not exist.
- [ ] **Step 2: Remove the legacy steps** listed above.
- [ ] **Step 3: Implement `runProtectedDeviceJourney`.**
  1. Generate an ECDSA P-256 key with `crypto.subtle.generateKey`. The SPKI is `encodeBase64url(exportKey("spki"))`, and the key id is `sha256:` + the hex SHA-256 of the SPKI DER.
  2. `POST {backend}/v2/device-authorizations` with `client_id`, `project`, `public_key_spki`, `device_label` (`"staging drill <run id>"`), `redirect_uri`, `state` and `code_challenge` (32 random bytes, base64url; the challenge is SHA-256 of the verifier), `code_challenge_method: "S256"` and `requested_feature`. The fields are exactly those `validateBoundRequest("authorize", …)` accepts in `services/cloudflare-licensing-backend/src/device/bound_request.mjs:34-49`.
  3. With the authenticated portal session: `POST /api/portal/device-authorizations/inspect` `{ attempt_handle }`, then `POST /api/portal/device-authorizations/approve` `{ attempt_handle, entitlement_id, expected_attempt_revision: 0, operation_id }`. Read `code` from `data.callback_url`.
  4. `POST {backend}/v2/device-challenges` `{ purpose: "exchange", attempt_handle, operation_id }`.
     - Build the exchange body `{ attempt_handle, code, code_verifier, redirect_uri, operation_id }`, and set `body_sha256` to the lowercase hex SHA-256 of `deviceOperationBody("exchange", body)`.
     - Sign `deviceProofSigningInput({ audience, method: "POST", path: "/v2/device-authorizations/exchange", key_id, operation_id, body_sha256, ...challenge })` with ECDSA/SHA-256. This is the same construction as `services/cloudflare-licensing-backend/test/e2e/protected-admin-enrollment.test.mjs:60-66`.
     - Normalise to low-S: if `s > n/2`, set `s = n - s`, where `n` is the P-256 order `0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551`.
     - `POST /v2/device-authorizations/exchange` with `proof: { key_id, challenge_id, nonce, expires_at, signature }`.
  5. Verify the lease: `decodeDeviceLeaseEnvelope`, then RSA-PKCS1v1.5/SHA-256 over `deviceLeaseSigningInput(payload)` with `STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM`. The claims `project`, `feature`, `device-key-id`, `binding-id` and `generation` must match.
  6. Renew: `POST /v2/device-challenges` `{ purpose: "renew", binding_id, operation_id }`, then sign the renew proof the same way. The path is `/v2/device-leases/renew`, and `body_sha256` is taken over `deviceOperationBody("renew", { binding_id, generation, operation_id })`. Then `POST /v2/device-leases/renew` `{ binding_id, generation, operation_id, proof }` and verify the second lease.
  7. `POST /api/portal/device-bindings/retire` with the body `validRetirement` expects (`services/cloudflare-customer-portal/src/worker/routes/device-consent.ts:55-58`). Assert 200.

  Errors are redacted the way the existing drill redacts them (`readBoundedText` and friends at :24-66). Never print a lease, proof or key.
- [ ] **Step 4: Wire the workflow and pin test** as listed. Run `npm run test:workflow-pins`.
- [ ] **Step 5: Grep.** `git grep -nE "ALLOW_SEAT_MUTATION|FLOATING_ENTITLEMENT_ID|ALLOW_DOWNLOAD|DOWNLOAD_ENTITLEMENT_ID|runSeatCycle|runDownload|portal_floating_entitlement_id|portal_download_entitlement_id" -- services scripts .github doc` must print nothing.
- [ ] **Step 6: Run the gates.**
  - `npm run test:portal`
  - `npm run test:workflow-pins`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `test(staging): replace the portal seat and download drill with a protected enrollment journey`. The PR description lists the operator actions:
  - set the five `LICENSECC_STAGING_DEVICE_*` repository variables and `LICENSECC_STAGING_BOUND_LEASE_PUBLIC_KEY_SPKI_PEM`;
  - create the protected synthetic entitlement;
  - register the drill's client id and loopback callback in the staging `BOUND_DEVICE_CONFIG`.

### Task 21: Portal Worker — remove the legacy routes, token mint and legacy trial branch

**Files:**
- Delete:
  - `services/cloudflare-customer-portal/src/auth/portal_token.mjs` (335);
  - `src/auth/portal_backend_error_manifest.mjs` (145);
  - `test/backend-proxy-contract.mjs` (239). It throws on import when backend `/v1/verify` 500 docs disappear (:102-105), and its dual `backendErrorPaths` (:112-115) is a compatibility shim.
- Modify `src/worker/routes/self-service.ts`:
  - delete :4-7, :19-29, `apiDevices` :78-90, `apiDeviceRelease` :92-202, `apiUsage` :204-214, `resolveOwnedEntitlement` :216-231, `apiAction` :233-293, `apiDownload` :295-344, and the `SESSION_DISPATCH` entries :349-355;
  - `TRIAL_SQL` (:56-61) keeps only the protected branch (`boundTrialDeadlineSql`).
- Modify `src/worker/routes.ts:52-58` and `src/worker/app.ts`: :9 and :84 (`resolveOwnedEntitlement` in `portalInternalsForTests`); :60 becomes `if (ALL_ROUTES.length !== 29)`.
- Modify OpenAPI:
  - `src/worker/openapi/paths/self-service.ts`: keep `/api/portal/me` (:27-59) and `/api/portal/entitlements` (:60-114); delete :4-22 and :115-end; fix the entitlement descriptions at :88, :94, :98.
  - `src/worker/openapi/components.ts:40-47,100-121` (`LEASE_ACTION_REQUEST`, `LeaseActionRequest`, `DownloadRequest`) and the unused imports at `paths/auth.ts:2`, `paths/ops.ts:2`.
  - `src/worker/openapi/document.ts:35-37,47`.
- Modify `src/worker/routes/auth.ts:332-337` (the logout account-token revocation bump) and its OpenAPI description at `src/worker/openapi/paths/auth.ts:232`.
- Modify the comments that cite account tokens: `src/auth/portal_otp.mjs:6,100` and `src/auth/portal_session.mjs:5,144`.
- Modify `src/worker/password/invalidation.ts:19-20` (the `account_token_revocations` insert) and its callers' argument at `routes/password.ts:73` and `routes/password-email.ts:110`.
- Modify `src/worker/support.ts`: :15-31 (`OwnedEntitlement.enforcement_mode` becomes `"device_bound_v1"`); :76-79 (`licenseMode` returns `trial` or `node_locked`, never `floating`).
- Modify `src/worker/env.ts:67-68` (`ACCOUNT_TOKEN_*`), `wrangler.example.jsonc:41,61` (comments).
- Delete the password crypto re-export facade `src/worker/password/crypto.ts`. `routes/password.ts:3` and `routes/password-email.ts:6` import the real module. Update the dist-worker imports in `test/portal-worker-password.test.mjs:4` and `test/portal-worker-password-email.test.mjs:3`.
- Modify tests:
  - `test/helpers.mjs:106-126`: `seedEntitlement` inserts `enforcement_mode = 'device_bound_v1'`, `pool_size = 0`, `device_hash = ''` and an owning customer, and drops the legacy `ACCOUNT_TOKEN_*` env;
  - `test/portal-worker-fixtures.mjs:92-100`;
  - `test/portal-worker-route-owners.test.mjs:31-68` (legacy keys at :61-67);
  - `test/portal-worker-self-service.test.mjs`: :11-13, :299-342, :480, :492, :562-572 (`DIRECT_ROUTE_TESTS`), :588-660 (legacy trial cases);
  - `test/portal-worker-session.test.mjs:25-37`: the CSRF case posts to `/api/portal/device-bindings/retire`;
  - `test/portal-worker-public.test.mjs`: :5, :7, :298-325, :410-478, :580-900, :911-920;
  - `test/openapi.test.mjs`: :16-17, :252-290;
  - `test/portal-ui-workflow.test.mjs`: :8, :179-182 (`routeCodes.size >= 20` becomes the exact post-trim count, 19), :184-191 (manifest assertions deleted).
- Modify `scripts/canonical-contracts.mjs:17,439` (36 → 29) and `doc/architecture/system-map.md:69` (29), and the system-map customer-portal source total at :123.
- Modify `doc/capabilities/registry.json`, entry `portal-self-service` (:194-209): evidence stays `self-service.ts`; re-point any selector that named a deleted handler.
- Modify `services/cloudflare-customer-portal/README.md`: :15, :35-36, :41, :110-114, :120-121, :224-225, :372, :406-407.

**Interfaces:**
- Consumes: Task 16 (protected rows only), Task 20 (the drill no longer calls deleted routes).
- Produces:
  - The portal serves 29 routes. Session routes: `GET /api/portal/me`, `GET /api/portal/entitlements`, `GET /api/portal/device-bindings`, `POST /api/portal/device-bindings/retire`, `POST /api/portal/device-authorizations/{inspect,approve,deny}`.
  - The portal no longer mints account tokens or bumps `account_token_revocations`.
  - Portal `/health` is unchanged until Task 27.

- [ ] **Step 1: Write the failing test** in `portal-worker-route-owners.test.mjs`: `the portal serves exactly the protected self-service routes`. It asserts the session route key set equals the seven routes above and that `ALL_ROUTES.length === 29`. Run `npm run test:portal`. Expected: FAIL (36).
- [ ] **Step 2: Delete the routes, files and facade** as listed.
- [ ] **Step 3: Rewrite `seedEntitlement`** and every suite that used legacy-shaped rows.
- [ ] **Step 4: Regenerate contracts.** `npm run write:contract-baselines`, review `test/contracts/portal.json` (routeCount 29, no `DownloadRequest`/`LeaseActionRequest`), then `npm run test:contracts`.
- [ ] **Step 5: Grep.**

```bash
git grep -nE "portal_token|portal_backend_error_manifest|backend-proxy-contract|/api/portal/(devices|usage|checkout|heartbeat|release|download)\b|account_token|legacyTrialDeadlineSql|LeaseActionRequest|DownloadRequest|password/crypto" -- services/cloudflare-customer-portal/src services/cloudflare-customer-portal/test scripts/canonical-contracts.mjs
```

  Expected, and only these:
  - `src/auth/portal_session.mjs:90` (the `account_token_id` column in the session `INSERT`; Task 32 drops the column);
  - the health code in `src/worker/routes/meta.ts` and `src/worker/openapi/paths/ops.ts` (Task 27);
  - `src/ui` (Task 22).

  List the `src/ui` hits in the PR.
- [ ] **Step 6: Run the gates.**
  - `npm run test:portal`
  - `npm run test:contracts`
  - `npm run check:dry-run`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `refactor(portal)!: remove seat, download, usage and legacy-device routes and the account-token mint`

### Task 22: Portal UI — remove seats, legacy devices, downloads and usage

**Files:**
- Delete under `services/cloudflare-customer-portal/src/ui/`:
  - `features/devices/BrowserSeats.tsx`, `DeviceRegistrations.tsx`, `ReleaseDialogs.tsx`, `seatReleaseDialog.ts`, `deviceReleaseDialog.ts`, `seatStorage.ts` (including `discardLegacyStoredSeats`), `nativeDialog.ts`;
  - `features/downloads/DownloadsFeature.tsx`;
  - `shared/ActionResult.tsx`;
  - `features/usage/UsageFeature.tsx`.
- Delete `services/cloudflare-customer-portal/test/portal-ui.devices-results.e2e.mjs` (all 17 scenarios are legacy).
- Modify `src/ui/features/devices/DevicesFeature.tsx`: delete `useDevicesController` (:111-347) and the interfaces (:20-95). Keep the page shell (:356-386), `<ProtectedNodes>` (:387) and the unknown-app check (:377), fed from `usePortalData` entitlements. Delete :388-401.
- Modify `src/ui/portalWorkflow.ts`:
  - :32-65, :89-131;
  - the `RESULT_CODE_COPY` legacy entries at :170-176, :181-203, :214-216, :227-239;
  - :242-255, :323-376;
  - the older-Worker tolerance at :425-427, :461-466, :489-491.
- Modify `src/ui/app/App.tsx`: :8-10, :42-48, :54, :66-84, :86-117, :127-137, :176-203, :264-298, :312-318, :330, :334-341, :343, :346.
- Modify `src/ui/types.ts`: :14 (`enforcement_mode` is `"device_bound_v1"`), :20-26 (trial fields required; drop the "older Worker" comment), :29-66 (`DeviceRow`, `UsageRow`, `PortalTab`, `SeatOperation`, `SeatActionResult`, the seat params).
- Modify `src/ui/features/auth/ProviderSignIn.tsx:29` (older-Worker `support` tolerance).
- Modify `src/ui/features/data/usePortalData.ts:39,45`: the Apps page gates on entitlements only. Deleting the `/devices` read changes this gate deliberately.
- Modify `src/ui/features/entitlements/EntitlementsFeature.tsx:17,47-48,66`, `src/ui/features/apps/AppsFeature.tsx:6-7`, `src/ui/shared/api.tsx:102-139` (`seatsReleasedMessage`), `src/shared/api.ts:25-41` (`PortalEntitlementSummary`), `src/ui/features/devices/deviceSearch.ts` (comment "three sections"), `src/ui/styles.css:440-475,670,696-706`.
- Modify the e2e specs:
  - `test/portal-ui.e2e.mjs`: delete :1275, :1318, :1346, :1368, :1420; rewrite the mixed :793 (keep its title, which `doc/capabilities/registry.json:207` pins), :1215, :1254, :1446;
  - `test/portal-ui.devices-search.e2e.mjs`: delete :42; rewrite :77, :94;
  - `test/portal-ui.network-failures.e2e.mjs`: delete :169, :189, :204; rewrite :221;
  - `test/portal-ui.session-expired.e2e.mjs`: delete :98, :113, :385; rewrite :149, :278;
  - `test/portal-ui.license-lifecycle.e2e.mjs:13,29,62`;
  - `test/portal-ui.nodes.e2e.mjs:92-98` (heading "Activated devices and seats unavailable").
- Modify `test/portal-ui-e2e-layout.test.mjs`: :9-13 (drop `portal-ui.devices-results.e2e.mjs`), :32-33 (the new title count, computed at implementation time and stated in the commit).
- Modify `test/portal-ui-workflow.test.mjs`: :38-73, :152, :161-280, :350, :432, :478-564.
- Modify `test/portal-ui-api.test.mjs:151-175` and `test/portal-glossary-copy.test.mjs:19`.
- Modify `doc/architecture/system-map.md`: :110 (the `DevicesFeature.tsx` row; `scripts/docs-accuracy.test.mjs:519` lists it: update or drop the row if the file falls well below the other rows), :121 (portal UI `App.tsx` count), :123 (portal total).

**Interfaces:**
- Consumes: Task 21.
- Produces: the portal UI shows apps and entitlements, protected connected devices (Disconnect) and consent. No seat, download, usage or "older app versions" view remains.

- [ ] **Step 1: Write the failing e2e assertion** in `test/portal-ui.nodes.e2e.mjs`: the Devices page shows "Connected devices" and does **not** show "Activated devices", "Browser seats" or "Download". Run `cd services/cloudflare-customer-portal && CI=1 npx playwright test test/portal-ui.nodes.e2e.mjs`. Expected: FAIL.
- [ ] **Step 2: Delete the UI files and trim the listed modules.**
- [ ] **Step 3: Rewrite or delete the e2e and workflow tests** as listed. Update the layout pin.
- [ ] **Step 4: Grep.**

```bash
git grep -nE "BrowserSeats|DeviceRegistrations|ReleaseDialogs|seatStorage|discardLegacyStoredSeats|DownloadsFeature|UsageFeature|ActionResult|older Worker|older app versions|legacy" -- services/cloudflare-customer-portal/src services/cloudflare-customer-portal/test
```

  Expected: only `src/auth/portal_otp.mjs:194` (empty-pepper-map behaviour, unrelated) and `src/auth/portal_session.mjs:18,79` (`authMethod "legacy"`, fixed in Task 37).
- [ ] **Step 5: Run the gates.**
  - `npm run test:portal`
  - `npm run test:ui --workspace @licensecc/cloudflare-customer-portal`
  - `CI=1 npm run test:e2e --workspace @licensecc/cloudflare-customer-portal`
  - `npm run check:capabilities`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `refactor(portal-ui)!: show only protected devices and consent`

---

## P4 — Admin

### Task 23: Admin Worker — remove the legacy-only routes and the account-token list

**Files:**
- Delete:
  - `services/cloudflare-license-admin/src/worker/groups/devices.ts`, `src/worker/groups/devices/operations.ts`, `src/worker/openapi/paths/devices.ts`;
  - `test/worker/devices.test.mjs`;
  - `packages/cloudflare-runtime/src/lease/seat_reclaim.mjs` and `seat_reclaim.d.ts`;
  - `services/cloudflare-licensing-backend/test/sql/device-transition.test.mjs`.
- Delete the admin test aggregator `services/cloudflare-license-admin/test/admin-worker.test.mjs`. It keeps "the historical test entrypoint stable". `package.json:12` `test` runs `test/worker/*.test.mjs` directly.
- Modify routes (`src/worker/routes.ts`): :21 (#9 `GET /api/admin/customers/{id}/resources`), :75 (#63 `POST /api/admin/entitlements/{id}/release-seats`), :81-85 (#69 `GET …/devices`, #70 `GET …/meter`, #71-73 `POST …/devices/{deviceKeyId}/{revoke,disable,reenable}`).
- Modify wiring:
  - `src/worker/route-descriptor.ts:12`; `dispatch.ts:9,20`; `operations.ts:44,71,127,133-137`;
  - `openapi/document.ts:12,46`;
  - `openapi/components.ts:196` (`deviceKeyIdParam` and its imports in `paths/*.ts`), :1221-1263 (`ReleaseSeatsData`, `EntitlementDevice`, `DevicesListData`, `MeterStatusData`);
  - `openapi/paths/workspace.ts:30-38`.
- Modify `src/worker/groups/customers/workspace.ts:5,8-9,22-35` (the `resources` view goes; `/apps` stays) and `src/worker/query.ts:45`.
- Modify the account-token reads:
  - `src/worker/groups/customers/operations.ts:72-74,88` (`getCustomer` stops returning tokens);
  - `groups/summary-reports/operations.ts:48-50` (report `account_tokens`);
  - `components.ts:890`, `:939-948`;
  - `groups/catalog/import-operations.ts` (its `account_token` reference; delete it).
- Delete the worker facades:
  - `src/worker/response.ts`: `app.ts:6` imports `./responses.js`; update `scripts/architecture-boundaries.json:19`, `scripts/check-architecture.mjs:23` and `scripts/check-architecture.test.mjs:40`.
  - `src/worker/request.ts:29-30`: `webhooks.ts:17` imports `boundedCursor` from `./query.js`.
- Modify `packages/cloudflare-runtime/src/d1/entitlement_mutation.mjs`: delete `classifyDeviceTransitionGuardMiss` (:309-332), `listEntitlementDevices` (:470), `shortDeviceKeyId` (:479), `transitionEntitlementDevice` (:494-535). Also modify `.d.ts:138-139`, `packages/cloudflare-runtime/package.json:63-66` (the `seat_reclaim` export) and `packages/cloudflare-runtime/test/runtime-primitives.test.mjs:21`.
- Modify `packages/licensing-domain/src/entitlements/contracts.d.ts:9,12-22` (`DeviceStatus`, `EntitlementDeviceRecord`).
- Modify tests:
  - `test/worker/customers.test.mjs:7` (`assertRouteGroup("customers", 15)` becomes 14);
  - `test/worker/transition-contracts.test.mjs:15,197-243,291-306,501-535,557-584,631` ("73 JSON 2xx responses" becomes 66), :634-658;
  - `test/worker/structure.test.mjs:26,43,54`;
  - `test/sql/workstream-f.test.mjs:28,205,512-675`;
  - `test/sql/admin-console.test.mjs:111-112,332-370,416-417,492-515,550-568,634`;
  - `test/sql/device-limit.test.mjs:15,77-121,199-223` (the `legacyGrant` cases become protected grants);
  - `test/openapi-crosscheck.test.mjs:425`.
- Modify `scripts/canonical-contracts.mjs:16,429` (75 → 68) and `doc/architecture/system-map.md:68` (68), plus the admin source total at :123.

**Interfaces:**
- Consumes: Task 16.
- Produces:
  - The admin Worker serves 68 routes. `GET /api/admin/customers/{id}` no longer includes `account_tokens`, and `GET /api/admin/report` no longer includes an `account_tokens` count.
  - `forceReleaseLiveSeats` and the legacy device helpers no longer exist.

- [ ] **Step 1: Write the failing test** in `test/routes-table.test.mjs`: `the admin serves no seat, legacy-device, meter or resources route`. It asserts that `ALL_ROUTES.length === 68` and that no path matches `/release-seats|\/devices\b|\/meter\b|\/resources\b/`. Run `npm run test:admin`. Expected: FAIL.
- [ ] **Step 2: Delete the routes, files, runtime helpers and facades** as listed.
- [ ] **Step 3: Rewrite the tests.**
- [ ] **Step 4: Regenerate contracts** (`npm run write:contract-baselines`, review `test/contracts/admin.json` routeCount 68, then `npm run test:contracts`).
- [ ] **Step 5: Grep.**

```bash
git grep -nE "release-seats|releaseSeats|forceReleaseLiveSeats|seat_reclaim|handleDevice(List|Transition)|handleMeterStatus|listEntitlementDevices|transitionEntitlementDevice|EntitlementDeviceRecord|resources\?kind|account_tokens|admin-worker\.test|worker/response\.js" -- services/cloudflare-license-admin/src services/cloudflare-license-admin/test packages scripts
```

  Expected: no output outside `src/ui`, which Task 25 cleans.
- [ ] **Step 6: Run the gates.**
  - `npm run test:admin`
  - `npm run test --workspace @licensecc/cloudflare-runtime`
  - `npm run test:backend`
  - `npm run check:architecture`
  - `npm run test:architecture`
  - `npm run test:contracts`
  - `npm run check:dry-run`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `refactor(admin)!: remove seat, legacy-device, meter and resources routes and the token list`

### Task 24: Admin Worker — remove legacy fields from grants, policies, catalog and reports

**Files:**
- Modify `packages/licensing-domain/src/entitlements/policy.mjs:21-45,97-103`: `POLICY_TYPES` drops `floating`; delete the pool, borrow and meter rules in `policyCapacityViolation`.
- Modify `packages/licensing-domain/src/entitlements/contracts.d.ts:8`, `contracts.mjs:29-33`: `LicenseMode` drops `floating`.
- Modify `services/cloudflare-license-admin/src/worker/policy_validation.ts:54-58,65-75,80-84,89,103-113,130,158-174`: refuse `type: "floating"`, `pool_size`, `max_borrow_sec`, `meter_quota`, `meter_period_sec`, `assertion_ttl_seconds` and `trial_require_device_proof` with 400 `invalid_request`.
- Modify `services/cloudflare-license-admin/src/worker/groups/policies/operations.ts:14,116-123,158-170`.
- Modify catalog:
  - `src/worker/groups/catalog/validation.ts:200-205,377-422`: plan features refuse `pool_size`, `max_borrow_sec`, `meter_quota`, `meter_period_sec`, `assertion_ttl_seconds`;
  - `groups/catalog/import-protocol.ts`: :168-173, :201-206, :290-295, :651-654, :662-663, :729, :738-739, :743-744;
  - `groups/catalog/operations.ts`: :59, :173-206;
  - `groups/catalog/plan-operations.ts`: :208-209, :229-230;
  - `groups/catalog/import-operations.ts:153-158`.
- Modify `packages/licensing-domain/src/catalog/import_preview.mjs:42` and `import_preview.d.ts:28,69`, and `plan_projection.d.ts:51,100`.
- Modify `src/worker/groups/entitlements/operations.ts:72,177-182,190,207-208`: list and PATCH no longer project or accept `device_hash`/`assertion_ttl_seconds`. The columns still exist until Task 34, but no admin path reads or writes them.
- Modify `src/worker/groups/entitlements/protected-checks.ts:24-26,32-33` (`POLICY_FIELDS`, `STAMP_COLUMN_DEFAULTS`).
- Modify `src/worker/groups/summary-reports/operations.ts`:
  - :110-116: timeseries drops the checkout and release series; denials keep only the protected `usage_events` rows;
  - :176-177: expiring uses `boundTrialDeadlineSql` only; delete the `legacyTrialDeadlineSql` import at :6;
  - :239-242: stale comment.
- Modify `packages/cloudflare-runtime/src/lease/trial_store.mjs:11` and `.d.ts:27` (delete `legacyTrialDeadlineSql`); delete `packages/cloudflare-runtime/test/legacy-trial-deadline.test.mjs`.
- Modify `src/worker/openapi/components.ts`: :347, :363, :400, :572, :594, :752, :761, :771, :779, :788, :794, :799, :808 (policy, catalog, entitlement and report schemas).
- Modify tests:
  - `test/worker/policies.test.mjs`, `test/worker/catalog.test.mjs`, `test/worker/summary-reports.test.mjs`;
  - `test/sql/policy-admin.test.mjs`, `test/sql/plan-projection-admin.test.mjs`, `test/sql/catalog-import-preview-admin.test.mjs`, `test/sql/workstream-f.test.mjs:211-300,408-510`;
  - `packages/licensing-domain/test/domain-contracts.test.mjs:15,29`;
  - the backend `test/sql/policy-stamp.test.mjs`.
- Modify `services/cloudflare-license-admin/README.md`: :70-72, :79-80, :98, :103, :509-583 ("License mode setup").

**Interfaces:**
- Consumes: Tasks 17 and 23.
- Produces:
  - Policies are `trial`, `node_locked` or `subscription`.
  - Catalog plan features carry `max_active_devices`, `policy_id` and trial fields only.
  - `GET /api/admin/report/timeseries` returns protected denials only.
  - `legacyTrialDeadlineSql` no longer exists.

- [ ] **Step 1: Write the failing tests.**
  - `test/worker/policies.test.mjs`: `a floating policy is refused` (400 `invalid_request`).
  - `test/worker/catalog.test.mjs`: `a plan feature with pool_size is refused`.
  - `test/worker/summary-reports.test.mjs`: `timeseries reports protected denials and no checkout series`.

  Run `npm run test:admin`. Expected: FAIL.
- [ ] **Step 2: Implement** the domain, runtime and admin changes.
- [ ] **Step 3: Rewrite the tests.**
- [ ] **Step 4: Regenerate contracts** (`npm run write:contract-baselines`, review `admin.json`, then `npm run test:contracts`).
- [ ] **Step 5: Grep.**

```bash
git grep -nE "\"floating\"|'floating'|max_borrow_sec|meter_quota|meter_period_sec|assertion_ttl_seconds|legacyTrialDeadlineSql" -- services/cloudflare-license-admin/src/worker packages/licensing-domain/src packages/cloudflare-runtime/src
```

  Expected: only reads that Task 34 deletes with the columns: `entitlement_mutation.mjs` `ENTITLEMENT_COLUMNS`, `entitlement_json.mjs`, `plan_projection.mjs` INSERT defaults, `policy_store.mjs`. List them in the PR.
- [ ] **Step 6: Run the gates.**
  - `npm run test --workspace @licensecc/licensing-domain`
  - `npm run test --workspace @licensecc/cloudflare-runtime`
  - `npm run test:admin`
  - `npm run test:backend`
  - `npm run check:hotspots` (`import-protocol.ts` 960, `components.ts` 1308, `Catalog.tsx` 740 may only shrink)
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `refactor(admin)!: drop floating policies, seat, borrow, meter and TTL fields`

### Task 25: Admin UI — remove the legacy screens and fields

**Files:**
- Delete `services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementInspectors.tsx` (35) and `useEntitlementInspection.ts` (158).
- Modify `src/ui/features/entitlements/Entitlements.tsx`: :3, :10, :21-24, :39, :100, :103-104, :235, :382-547 (`refreshReleasedEntitlement`, `releaseSeats`, `deviceTransition`).
- Modify `src/ui/features/entitlements/EntitlementList.tsx`: :16, :42, :47-49, :60, :92-94, :118-121, :139, :144.
- Modify `src/ui/features/entitlements/EntitlementEditor.tsx`: :70-72, :86, :98-102 (Device hash, Assertion TTL).
- Modify `src/ui/features/entitlements/workflow.ts`: :30-31, :46-47, :61-62, :72-73, :92-95, :111, :115-116, :153, :159-161, :173-174, :185-186, :217-257, :336-338, :349-350, :365-381.
- Modify `src/ui/features/entitlements/DeviceLimitForm.tsx:74,80` (mode conditionals; the form stays).
- Modify customers:
  - `src/ui/features/customers/CustomerAccess.tsx`: :16, :46-48, :53, :96, :101, :107, :110 ("Activated devices" and "Floating seats" tabs);
  - `src/ui/features/customers/Customers.tsx`: :54-63, :69, :75-87 (including the non-JSON scope fallback at :84), :297-300, :336-338 (the token section and table; the Account tab keeps login email and details).
- Modify `src/ui/app/types.ts:13,15` and `src/ui/app/navigationState.ts:4-5` (`tokens`, `nodes`, `sessions`).
- Modify `src/ui/features/reports/Reports.tsx:23,134,137-142` (tokens card; "Checkouts vs denials" becomes "Refused connections").
- Modify `src/ui/features/policies/Policies.tsx`: :131-136, :313-332; `src/ui/features/policies/workflow.ts`: :19, :28, :39, :48, :77-81, :92, :101, :115, :124, :141-145.
- Modify catalog: `src/ui/features/catalog/CatalogDetails.tsx:18,85`, `CatalogForms.tsx:161`, `fieldErrors.ts:30`, `workflow.ts:53,99,346`.
- Modify `src/ui/shared/messages.ts:73-79,173,191-192`.
- Modify `src/ui/shared/useMediaQuery.ts:20-27`: delete the `MediaQueryList.addListener` fallback; `addEventListener("change", …)` only.
- Modify `src/ui/shared/mutationGuards.ts`: 49-53, 95-113 (`releaseSeats`/`deviceTransition` policies), 404-415, 450-468, 477-480, 493, 807-813, 841.
  - Leave `hasEntitlementRecordData` (:350-364) and the policy and catalog record guards that check legacy columns unchanged: the API still returns those columns until Task 34 changes the guard and the schema together.
  - `wc -l` must be ≤ 866; lower the baseline to the new count.
- Modify `src/shared/api.ts`: :137, :155, :182, :191, :198, :206, :215, :221, :226, :235, :408, :410 (legacy request and response types, where they are not needed for reading still-present columns).
- Modify the e2e specs:
  - `test/admin-ui.consequences.e2e.mjs`: :18, :91, :1067, :1097, :1408, :1463, :1486, :1563;
  - `test/admin-ui.reads.e2e.mjs`: :514, :554;
  - `test/admin-ui.recovery.e2e.mjs`: :202, :225, :249;
  - `test/admin-ui.navigation.e2e.mjs`: :52, :294;
  - `test/admin-ui.workspace.e2e.mjs:146`.
- Modify `test/admin-ui.fixture.mjs`: :80-84, :164-167, :655-656, :681, :815-830, :871, :878-898, :960-980, :987, :1858-1920.
- Modify `test/admin-ui-e2e-layout.test.mjs:36` (the new title count, stated in the commit).
- Modify the UI workflow tests: `test/admin-ui-workflow/lists-reports.test.mjs:116-126`, `policies.test.mjs:61-62,88,113-114`, `messages.test.mjs:129`, `device-limit.test.mjs:39-44`, `glossary-copy.test.mjs:19-20` (labels "Activated devices"/"Floating seats").
- Modify `doc/architecture/glossary.md:28-29` (rows "Legacy device" and "Floating seat"; `glossary-copy.test.mjs` reads it), :60-73, :101-105.

**Interfaces:**
- Consumes: Tasks 23 and 24.
- Produces: the console shows protected grants, device limits, protected connections, policies (`trial`, `node_locked`, `subscription`), the catalog and refused-connection reports. There are no seat, legacy-device, meter or account-token views.

- [ ] **Step 1: Write the failing e2e assertion** in `test/admin-ui.workspace.e2e.mjs`: a customer workspace shows "Connected devices" and no "Activated devices", "Floating seats" or "Account tokens" tab. Run `cd services/cloudflare-license-admin && CI=1 npx playwright test test/admin-ui.workspace.e2e.mjs`. Expected: FAIL.
- [ ] **Step 2: Delete and trim the UI** as listed.
- [ ] **Step 3: Rewrite the e2e, fixture and workflow tests.**
- [ ] **Step 4: Grep.**

```bash
git grep -nE "releaseSeats|Release seats|Floating seats|Activated devices|Account tokens|EntitlementInspectors|useEntitlementInspection|addListener\(|readableScopes|Checkouts vs denials" -- services/cloudflare-license-admin/src services/cloudflare-license-admin/test doc/architecture/glossary.md
```

  Expected: no output.
- [ ] **Step 5: Run the gates.**
  - `npm run test:admin`
  - `npm run test:ui --workspace @licensecc/cloudflare-license-admin`
  - `CI=1 npm run test:e2e --workspace @licensecc/cloudflare-license-admin`
  - `npm run check:hotspots`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `refactor(admin-ui)!: remove seat, legacy-device, meter and account-token views`

### Task 26: Admin mutations require the expected owner and revocation sequence

Controller ruling: `expected_customer_id` and `expected_revocation_seq` become required on:
- `PATCH /api/admin/entitlements/{id}`;
- `POST …/disable`, `…/reenable` and `…/revoke`.

Today they are optional (`openapi/paths/entitlements.ts:28-34`, `dependentRequired`). `operations.ts:266-274` enforces them only when present, and `admin-console.test.mjs:391` pins "legacy callers remain supported".

**Files:**
- Modify `services/cloudflare-license-admin/src/worker/openapi/paths/entitlements.ts`: :28-34, :103, :126, :149, :171 (both fields `required` on all four bodies; reenable's body is no longer optional).
- Modify `services/cloudflare-license-admin/src/worker/groups/entitlements/operations.ts:266-274`: a missing field returns 400 `invalid_request` before any read.
- Modify `packages/cloudflare-runtime/src/d1/entitlement_guards.mjs:3-8`: the guard is never a no-op; an undefined expectation throws `invalid_patch`.
- Modify the callers:
  - `src/ui/features/entitlements/batchRunner.ts:65` and `workflow.ts:285-291` (batch sends both from the row it holds);
  - `services/cloudflare-license-admin/scripts/validate-access-admin.mjs:311-324`.
- Modify `test/sql/admin-console.test.mjs:391` (`PATCH {}` now returns 400); `test/admin-ui-workflow/batch-runner.test.mjs`.
- Modify `services/cloudflare-license-admin/README.md:134-138,703-708`.

**Interfaces:**
- Consumes: Task 25.
- Produces: the four mutation routes return 400 `invalid_request` without both fields. The device-limit PATCH (`setEntitlementCapacity`, `entitlement_mutation.mjs:576`) goes through the same guard. After this task it is mandatory there too, and the UI already sends both fields (`src/ui/features/entitlements/deviceLimit.ts:13`).

- [ ] **Step 1: Write the failing tests** in `test/worker/entitlements.test.mjs`:
  - `PATCH without expected_customer_id and expected_revocation_seq is refused`;
  - `revoke without the expected fields is refused`.

  Each returns 400, and the row is unchanged. Run `npm run test:admin`. Expected: FAIL.
- [ ] **Step 2: Implement** the schema, handler, runtime guard and caller changes.
- [ ] **Step 3: Regenerate contracts** (`npm run write:contract-baselines`, review the four request schemas, then `npm run test:contracts`).
- [ ] **Step 4: Grep.** `git grep -nE "legacy callers remain supported|dependentRequired" -- services/cloudflare-license-admin` must print nothing.
- [ ] **Step 5: Run the gates.**
  - `npm run test:admin`
  - admin `test:ui` and `CI=1 npm run test:e2e`
  - `npm run test:contracts`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `fix(admin)!: require the expected owner and revocation sequence on every grant mutation`

---

## P5a — Backend runtime, routes, drills and CI

Order follows the import graph:
- `routes/leases.ts`, `seats.ts`, `metering.ts` and `reports.ts` import helpers from `routes/verify.ts`, and `emergency.ts` re-serves them. They go first (Task 28).
- `verify.ts` imports `accountAuth`, so account tokens go together with `/v1/verify` (Task 30).
- Each task also deletes the scripts, drills, workflow steps, vectors and shared-package modules whose last consumer it removes. Nothing is left orphaned for a later task.

### Task 27: Replace the health readiness contract and add a protected production smoke

Backend `/health` reports `account_token_mode` (`src/routes/meta.ts:17-32`). Portal `/health` is healthy only when that equals `required` (`services/cloudflare-customer-portal/src/worker/routes/meta.ts:16,24-29,101-145`). The rollback checker requires both (`scripts/check-worker-rollback-health.mjs:229-240,249-259`). All three change together to a protected-readiness signal. The deploy materializer also starts validating `BOUND_DEVICE_CONFIG`, which is a non-secret var.

**Files:**
- Create `services/cloudflare-licensing-backend/src/device/bound_readiness.mjs`. Export `async function boundDeviceReadiness(env)`, which returns `{ ready: boolean, checks: { registry, signing_key_pair, approval_key_ring, global_rate_limit } }`.
  - The logic moves from `scripts/protected-device-readiness.mjs:11-36`. It must be Worker-safe: no `node:` imports.
  - It is memoised per `env` object in a module-level `WeakMap`, because `/health` is unauthenticated and the check signs with RSA-3072.
- Modify `services/cloudflare-licensing-backend/scripts/protected-device-readiness.mjs`: import `boundDeviceReadiness`; the output shape is unchanged.
- Modify `services/cloudflare-licensing-backend/src/routes/meta.ts:17-32`: `handleHealth` becomes `async` and returns `{ ok, service: "licensecc-online-verifier", protected_device_ready, …invalid-mode fields while the selectors still exist, …config_warnings }`, with status 200 when `ok` and 503 otherwise. `account_token_mode` is removed.
- Modify `services/cloudflare-licensing-backend/src/openapi/components.ts:142-187` (`HealthSuccess`, `HealthConfigError`), `src/openapi/paths/meta.ts:40-72` (description and examples) and `services/cloudflare-licensing-backend/README.md:439`.
- Modify `services/cloudflare-licensing-backend/src/app.ts:18-21`. The dispatch comment says the meta thunks are env-free because the OpenAPI crosscheck calls them with an empty env. `/health` now reads the protected configuration: with an empty env it returns 503 `protected_device_ready: false` and never throws. The crosscheck in `test/openapi-spec.test.mjs` accepts that.
- Modify the portal:
  - `services/cloudflare-customer-portal/src/worker/routes/meta.ts:16,24-29,101-145`: `backendProtectedReady()` requires backend `/health` to return `ok === true` and `protected_device_ready === true`;
  - the portal response becomes `{ ok, code: "healthy" | "backend_not_ready", request_id, data: { backend_protected_ready } }`;
  - delete the comment at :135.
- Modify `services/cloudflare-customer-portal/src/worker/openapi/paths/ops.ts:7-31`.
- Modify `scripts/check-worker-rollback-health.mjs`:
  - :233-234 backend requires `protected_device_ready === true` instead of `account_token_mode`;
  - :251-254 portal requires `data.backend_protected_ready === true`.
- Modify `scripts/check-worker-rollback-health.test.mjs:60,66`.
- Modify `scripts/materialize-deploy-configs.mjs` (`validateBackend`, :352): require `vars.BOUND_DEVICE_CONFIG`, validated by `boundDeviceConfig` imported from `services/cloudflare-licensing-backend/src/device/bound_config.mjs`, and `vars.BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM` (a PEM `PUBLIC KEY`). Also modify `scripts/materialize-deploy-configs.test.mjs` (the fixture gains both).
- Create `services/cloudflare-licensing-backend/scripts/protected-readiness-smoke.mjs` and `services/cloudflare-licensing-backend/test/protected-readiness-smoke.test.mjs`, and add package script `validate:protected-smoke` (`node scripts/protected-readiness-smoke.mjs`). The script:
  - `GET {url}/health` requires 200 and `protected_device_ready === true`;
  - `POST {url}/v2/device-challenges` with `{ purpose: "exchange", attempt_handle: <32 random bytes base64url>, operation_id: <32 random bytes base64url> }` requires 404 `authorization_unavailable` (`src/device/bound_enrollment.mjs:79`);
  - prints redacted JSON evidence.
- Modify `.github/workflows/deploy-production.yml`: add the step "Run protected post-deploy smoke" after the Worker deploy, running `npm --silent run validate:protected-smoke --workspace @licensecc/cloudflare-licensing-backend -- --url "$BACKEND_URL" > "$RUNNER_TEMP/licensecc-deployment-evidence/backend-protected-smoke.json"`. Update `scripts/workflow-action-pins.test.mjs` to pin it.
- Modify tests:
  - `services/cloudflare-licensing-backend/test/contexts/meta.test.mjs`, `test/openapi-spec.test.mjs:190-201`;
  - `services/cloudflare-customer-portal/test/portal-worker-public.test.mjs:195-297,479-578,901-905`, `test/openapi.test.mjs:241-250`, `test/staging-portal-drill.test.mjs:46` (and the drill's health check at `scripts/staging-portal-drill.mjs:449`).
- Modify `services/cloudflare-licensing-backend/README.md:801-802` ("do not yet certify this staged v2 rollout"), `doc/operations/cloudflare-setup.md:378-416`, `doc/operations/production-readiness.md` PRD-03 (`/health` wording).

**Interfaces:**
- Consumes: Task 20.
- Produces:
  - Backend `/health`: `protected_device_ready: boolean`. Portal `/health`: `data.backend_protected_ready: boolean`, with code `backend_not_ready` on 503.
  - `boundDeviceReadiness(env)`.
  - `validate:protected-smoke --url <backend>`.
  - The materializer refuses a backend config without a valid `BOUND_DEVICE_CONFIG`.

- [ ] **Step 1: Write the failing tests.**
  - `scripts/check-worker-rollback-health.test.mjs`: `rollback health accepts protected_device_ready and rejects account_token_mode`. A backend body `{ ok: true, service: "licensecc-online-verifier", protected_device_ready: true }` passes; the old `{ …, account_token_mode: "required" }` without `protected_device_ready` fails with `READINESS_CONTRACT_FAILED`.
  - `services/cloudflare-customer-portal/test/portal-worker-public.test.mjs`: `portal health is healthy only when the backend reports protected readiness`.
  - `services/cloudflare-licensing-backend/test/contexts/meta.test.mjs`: `health reports protected_device_ready false and 503 without BOUND_DEVICE_CONFIG`.
  - `scripts/materialize-deploy-configs.test.mjs`: `backend config without a valid BOUND_DEVICE_CONFIG is refused`.
  - `test/protected-readiness-smoke.test.mjs`: the smoke passes against a fake backend and fails when health reports `false`.

  Run `npm run test:release-operations`, `npm run test:portal` and `npm run test --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Implement** the readiness module, the three health changes, the materializer check and the smoke script.
- [ ] **Step 3: Regenerate contracts** (`npm run write:contract-baselines`, review the backend and portal health schemas, then `npm run test:contracts`).
- [ ] **Step 4: Grep.** `git grep -nE "account_token_mode|REQUIRED_ACCOUNT_TOKEN_MODE" -- services scripts doc` must print nothing. The `accountTokenMode` function in `services/cloudflare-licensing-backend/src/auth/account_auth.mjs` stays until Task 30, but no health path imports it any more.
- [ ] **Step 5: Run the gates.**
  - `npm run test:release-operations`
  - `npm run test:worker-rollback`
  - `npm run test:portal`
  - `npm run test:backend`
  - `npm run test:workflow-pins`
  - `npm run test:contracts`
  - `npm run check:dry-run`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `feat(ops)!: health and rollback readiness certify protected licensing instead of account tokens`. The PR description tells operators to put `BOUND_DEVICE_CONFIG` and `BOUND_LEASE_SIGNING_PUBLIC_KEY_SPKI_PEM` in the deploy config vars.

### Task 28: Delete the lease, seat, meter, report and emergency routes

**Files:**
- Delete backend source:
  - `services/cloudflare-licensing-backend/src/routes/leases.ts` (420), `seats.ts` (401), `metering.ts`, `reports.ts`, `emergency.ts`;
  - `src/lease/issuance_sql.mjs` (174);
  - `src/openapi/paths/leases.ts`, `seats.ts`, `metering.ts`, `reports.ts`, `emergency.ts`.
- Delete backend scripts: `lease-sign.mjs`, `staging-lease-drill.mjs`, `report.mjs`.
- Delete backend tests:
  - `test/lease-sign.test.mjs`, `lease-worker.test.mjs`, `seat-worker.test.mjs`, `staging-lease-drill.test.mjs` (the 7 Node-24 failures end here);
  - `test/usage-report.test.mjs`, `usage-worker.test.mjs`;
  - `test/sql/lease-rebind.test.mjs`, `metering.test.mjs`, `seat-pool.test.mjs`, `seat-revocation-sla.test.mjs`, `trial-activation.test.mjs`, `usage-events.test.mjs`;
  - `test/fulfillment/account_isolation.test.mjs` (account-token isolation of the scoped and emergency routes).
- Delete from `packages/cloudflare-runtime`: `src/lease/metering.mjs`, `src/lease/trial_store.mjs`, `trial_store.d.ts`, their `package.json` exports, and the `test/runtime-primitives.test.mjs:20` subpath entry.
- Delete from `packages/licensing-domain`: `src/lease/canonical_payload.mjs`, `src/lease/trial.mjs`, `src/usage/usage_report.mjs`, their `package.json` exports (`./lease/canonical_payload`, `./lease/trial`, `./usage/usage_report`) and the domain tests that cover them.
- Modify `services/cloudflare-licensing-backend/src/routes.ts:28-49`: delete `SCOPED_ROUTES` and `EMERGENCY_PREFIX`; `allCanonicalRoutes()` returns `[...META_ROUTES, ...CLIENT_ROUTES]`.
- Modify `src/app.ts`: imports :5, :6, :8, :10, :11 and `SCOPED_ROUTES` at :14; dispatch :32-38; :43; the `/v1/emergency/` condition at :72; :85-91.
- Modify `src/maintenance/index.ts`: :1, :7, :10-14, :16-65 (`sweepLapsedSeats`, `reclaimOvercapSeats`), :73-74, :80-92. Keep the `usage_events` retention (:75-79) until Task 33, and keep protected cleanup (:72), portal sweeps, webhooks and the audit digest.
- Modify `src/env.ts`: `LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM`, `LEASE_SIGNING_KEY_ID`, `LEASE_SKEW_DAYS`, `EMERGENCY_OPERATOR_BEARER`, and the `AccountOperation` type (:22).
- Modify `src/openapi/document.ts:28-39,49-58` (paths and the `lease`/`seat`/`report`/`emergency` tags).
- Modify `src/openapi/components.ts`: `LEASE_SUCCESS` :57-64, `SEAT_SUCCESS` :66-71, `REPORT_SUCCESS` :73-78, `leaseBearer` :119-124, `emergencyBearer` :125-130, and schemas `LeaseRequest` through `ReportSuccess` (:302-484).
- Modify `wrangler.example.toml`: :8-10 (the cron comment becomes "protected-device cleanup, portal session sweeps, webhook delivery and the audit digest"), :113-115 (`EMERGENCY_OPERATOR_BEARER`).
- Modify `scripts/materialize-deploy-configs.mjs`: :82-85 (`EMERGENCY_OPERATOR_BEARER`, `LEASE_ISSUE_BEARER`, `LEASE_SIGNING_*` in `workerSecretNames`); :377 (the cron label `"seat-reclamation"` becomes `"maintenance"`).
- Modify `scripts/materialize-deploy-configs.test.mjs:72-73,552`.
- Modify `services/cloudflare-licensing-backend/scripts/backend-secret-inventory.mjs:16-28` (`LEASE_SIGNING_*`) and `test/backend-secret-inventory.test.mjs`.
- Modify `services/cloudflare-licensing-backend/package.json`:
  - scripts `report`, `validate:staging-lease`;
  - `test:deployed-readiness` drops `test/staging-lease-drill.test.mjs`;
  - `test:sql` (:21) drops `test/fulfillment/account_isolation.test.mjs`.
- Modify `.github/workflows/deploy-staging.yml:146-156` (step "Verify scoped staging leases, proof, and signatures") and `scripts/workflow-action-pins.test.mjs:666-678`.
- Modify tests:
  - `test/app-composition.test.mjs:145-191` (meter, emergency, "seven scoped operations");
  - `test/openapi-spec.test.mjs:16-23,67-81,113-136,166-178`;
  - `test/sql/bound-device-store.test.mjs:9` (imports legacy issuance SQL);
  - `test/contexts/fixtures.mjs:14-69` (mocks only what `/v1/verify` still needs).
- Modify `scripts/canonical-contracts.mjs:15,419` (23 → 9) and `doc/architecture/system-map.md:67` (9), plus the backend source total at :123.
- Modify `doc/capabilities/registry.json`: delete entry `backend-metering` (:147-161); update `doc/capabilities/index.rst`.
- Modify `services/cloudflare-licensing-backend/README.md`: :200-239 "Machine activation and renewal", :357-389 (staging lease drill).
- Modify `doc/release-artifacts.md:267-282` and `doc/operations/production-readiness.md:176-186` (lease drill).

**Interfaces:**
- Consumes: Tasks 21, 23, 24 and 27. Portal and admin no longer call or read these routes, and the staging drill is protected.
- Produces:
  - The backend serves 9 canonical routes: `GET /openapi.json`, `GET /docs`, `GET /health`, `POST /v1/verify`, `POST /v1/orders`, and the four `/v2` routes.
  - No emergency prefix.
  - The cron label is `maintenance`.

- [ ] **Step 1: Write the failing test** in `test/app-composition.test.mjs`: `the backend serves no lease, seat, meter, report or emergency route`. It asserts that `allCanonicalRoutes().length === 9`, and that `POST /v1/activate`, `POST /v1/checkout` and `POST /v1/emergency/v1/release` each return 404 `not_found`. Run `npm run test --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Delete the files, scripts, tests and package modules** as listed.
- [ ] **Step 3: Trim `app.ts`, `routes.ts`, maintenance, env, OpenAPI, wrangler, materializer, secret inventory and the staging workflow.**
- [ ] **Step 4: Regenerate contracts** (`npm run write:contract-baselines`, review `test/contracts/backend.json`: routeCount 9, and the removed paths and schemas; then `npm run test:contracts`).
- [ ] **Step 5: Grep.**

```bash
git grep -nE "/v1/(activate|renew|checkout|heartbeat|release|meter|admin/report|emergency)|handleLeaseIssue|handleSeat|handleMeter|handleUsageReport|handleEmergencyRoute|SCOPED_ROUTES|EMERGENCY_PREFIX|EMERGENCY_OPERATOR_BEARER|LEASE_SIGNING|LEASE_SKEW_DAYS|issuance_sql|canonical_payload|usage_report|trial_store|lease/metering|staging-lease-drill|lease-sign|seat-reclamation" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis' ':!doc/**/*.md' ':!**/README.md' ':!CHANGELOG.md'
```

  Expected: no output. The prose docs are finished in Task 40; list the doc hits in the PR.
- [ ] **Step 6: Run the gates.**
  - `npm run check:pr`. The Node-24 exception no longer applies: every test must pass.
  - `npm run test:e2e`
  - `npm run check:dry-run`
  - `npm run test:release-operations`
  - `npm run test:workflow-pins`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
- [ ] **Step 7: Commit.** `refactor(backend)!: delete lease, seat, metering, usage-report and emergency routes`

### Task 29: Retire the local SQLite online demo

The local host (`services/cloudflare-licensing-backend/local-host/server.mjs`) only demonstrates `POST /v1/verify` and forwards legacy env (:86-116, :203). The owner accepted losing the zero-cloud online demo. The SQLite adapter itself stays: `test/db/db-conformance.test.mjs` and `test/e2e/catalog-admin-projection-flow.test.mjs` use `local-host/db-sqlite.mjs`.

**Files:**
- Delete:
  - `services/cloudflare-licensing-backend/local-host/server.mjs` (204; includes the Node < 20 WebCrypto shim at :40-46);
  - `local-host/README.md` (203);
  - `services/cloudflare-licensing-backend/host-common.mjs`, `host-common.test.mjs` (used only by the two deleted hosts);
  - `doc/tutorials/local-online-evaluation.rst`.
- Modify `services/cloudflare-licensing-backend/package.json` (script `local:server`; keep `db:local:init` and `db:local:reset`).
- Modify:
  - `README.md:28` (the row);
  - `doc/index.rst:26-28`, `doc/tutorials/index.rst:11`, `doc/usage/repository-workflows.rst:28,111`;
  - `doc/operations/database-backends.md` (the local SQLite row becomes "test and local schema adapter");
  - `services/cloudflare-licensing-backend/README.md:15`.
- Modify `scripts/docs-accuracy.test.mjs:292-307`: the tutorial list is `doc/tutorials/offline-first-license.rst` only.

**Interfaces:**
- Consumes: Task 28.
- Produces: `local-host/db-sqlite.mjs` and `migrate.mjs` remain for tests and `db:local:init`. There is no local HTTP host.

- [ ] **Step 1: Delete the files and the script entry.**
- [ ] **Step 2: Update the doc links, toctrees and the docs-accuracy tutorial list.**
- [ ] **Step 3: Grep.** `git grep -nE "local-online-evaluation|local:server|local-host/server|host-common|Evaluate online verification" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `npm run test:backend`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `chore(backend): retire the local online-verification demo host`

### Task 30: Delete `/v1/verify`, account tokens, request proof v1 and the online signer

This removes the last legacy route. With it go:
- customer account tokens;
- the `REQUEST_SIGNATURE_MODE`, `ACCOUNT_TOKEN_MODE` and `DEVICE_PROOF_MODE` selectors;
- `LEASE_ISSUE_BEARER`;
- the legacy D1 limiter tiers;
- the public-verifier drill and capacity harness;
- the `online_assertion` and `device_proof/v1` vectors.

It also renames `VERIFY_RATE_LIMITER`: protected registration uses it (`src/device/bound_rate.mjs:88`), so deleting it silently would drop the edge limiter on `POST /v2/device-authorizations`.

**`DEVICE_PROOF_MODE` evidence.** Its only readers are `src/routes/verify.ts` (:740), `leases.ts` and `seats.ts` (deleted in Task 28), plus the config checks in `scripts/materialize-deploy-configs.mjs:360` and `scripts/backend-secret-inventory.mjs:93`. Nothing protected reads it, so it is deleted rather than kept. Step 5 records the grep.

**Files:**
- Delete backend source: `services/cloudflare-licensing-backend/src/routes/verify.ts` (933), `src/db/verify-statements.mjs`, `src/auth/account_auth.mjs`, `src/auth/account_token.mjs`, `src/device/request_proof.mjs`, `request_proof.d.ts`, `src/openapi/paths/verify.ts`.
- Delete backend scripts: `account-token.mjs`, `token-guards.mjs`, `device-key.mjs`, `generate-online-key.mjs`, `generate-online-assertion-fixture.mjs`, `public-verifier-capacity.mjs`, `public-verifier-capacity-lib.mjs`, `public-verifier-drill.mjs`.
- Delete backend tests:
  - `test/auth/account_token.test.mjs`, `account_token_cli.test.mjs`;
  - `test/contexts/assertion-signing.test.mjs`, `entitlement.test.mjs`, `rate-limit.test.mjs`, `replay.test.mjs`, `request-proof.test.mjs`;
  - `test/online-verifier.test.mjs`, `device-proof.test.mjs`, `request-proof-contract.test.mjs`, `public-verifier-capacity.test.mjs`, `public-verifier-drill.test.mjs`.
- Delete `packages/cloudflare-runtime/src/auth/account_token_issue.mjs` and its export. Trim `src/auth/primitives.mjs` to `constantTimeEqual`, which `src/http/kit.mjs:11` re-exports. Its other consumers (`account_token_issue.mjs`, portal `portal_token.mjs`, backend `account_auth.mjs` and `account_token.mjs`) are all deleted by this task or Task 21. Confirm with `git grep -n "auth/primitives"`.
- Delete vectors: `test/vectors/online_assertion/` (4 files) and `test/vectors/device_proof/v1/` (10 files).
- Delete `.github/workflows/capacity.yml`.
- Modify `services/cloudflare-licensing-backend/package.json`:
  - `exports["./device/request_proof"]` (:6-11);
  - scripts `account-token`, `device-key`, `generate-online-key`, `generate-online-assertion-fixture`, `validate:public-verifier`, `capacity:public-verifier`, `test:capacity`;
  - the `test` script (:19) drops `test/auth/account_token.test.mjs test/auth/account_token_cli.test.mjs` and keeps `test/*.mjs` and the four `test/fulfillment/order_*.test.mjs` entries;
  - `test:deployed-readiness` drops `public-verifier-drill.test.mjs`.
- Modify `src/routes.ts:20` and `src/app.ts:12,26`. The catch-all log event `verify.unhandled_error` becomes `request.unhandled_error`; keep the response code.
- Modify `src/security_modes.mjs`: delete `parseAccountTokenMode`, `parseRequestSignatureMode`, `parseDeviceProofMode`. `invalidSecurityModeNames` checks `ORDER_SIGNER_SCOPE_MODE` only until Task 31.
- Modify `src/observability/index.ts`: :5, :7, :98-107, and the `LOG_FIELD_NAMES` entries used only by verify (`assertion_ttl_seconds`, `client_hardening`, `d1_duration_ms`, `request_proof`, `request_signature_mode`, `window_from`; grep each before removing).
- Modify `src/env.ts`:
  - remove `ONLINE_SIGNING_PRIVATE_KEY_PKCS8_PEM`, `ONLINE_SIGNING_KEY_ID`, `MAX_ASSERTION_TTL_SECONDS`, `MAX_CACHE_TTL_SECONDS`, `LOG_RATE_LIMIT_DECISIONS`, the ten `D1_*RATE_LIMIT*` vars, `REQUEST_SIGNATURE_MODE`, `REQUEST_SIGNATURE_MAX_SKEW_SECONDS`, `DEVICE_PROOF_MODE`, `ACCOUNT_TOKEN_PEPPERS`, `ACCOUNT_TOKEN_ACTIVE_PEPPER_ID`, `ACCOUNT_TOKEN_MODE`, `ACCOUNT_TOKEN_LAST_USED_THROTTLE_SEC`, `LEASE_ISSUE_BEARER`;
  - remove the types at :17-20 and :140-217;
  - declare `BOUND_REGISTRATION_RATE_LIMITER`, `BOUND_SESSION_RATE_LIMITER` and `BOUND_GLOBAL_RATE_LIMIT`, which are used today but undeclared.
- Modify `src/device/bound_rate.mjs:88`: `env.VERIFY_RATE_LIMITER` becomes `env.BOUND_REGISTRATION_RATE_LIMITER`.
- Modify `wrangler.example.toml`:
  - delete vars :15-31 and :50-69 (keep the `BOUND_GLOBAL_RATE_LIMIT` comment :70-72);
  - :90-93 `[[ratelimits]] name = "BOUND_REGISTRATION_RATE_LIMITER"`;
  - delete the secret comments :102-104 and :109-112.
- Modify `scripts/materialize-deploy-configs.mjs`:
  - :76, :86-87 (`ACCOUNT_TOKEN_PEPPERS`, `ONLINE_SIGNING_*` in `workerSecretNames`);
  - :354-356: `ORDER_*` only, until Task 31;
  - delete :360 (`DEVICE_PROOF_MODE`), :362-368 (pepper id, request-signature skew);
  - :370-376: exactly two limiters, `BOUND_REGISTRATION_RATE_LIMITER` and `BOUND_SESSION_RATE_LIMITER`, each with positive `namespace_id`, `limit` and `period`.
- Modify `scripts/materialize-deploy-configs.test.mjs`: :76-80, :102-105, :374-379, :551.
- Modify `services/cloudflare-licensing-backend/scripts/backend-secret-inventory.mjs:16-36,90-100` and `test/backend-secret-inventory.test.mjs`.
- Modify `src/openapi/components.ts`: :19-20 (`INVALID_SECURITY_MODE_CONFIG_ERROR` names only `ORDER_SIGNER_SCOPE_MODE`), :42-55, :84-90, :112-118, :177, :188-228.
- Modify `src/openapi/paths/meta.ts:2` and `paths/orders.ts:2` (unused legacy imports), `src/openapi/document.ts` (the `client` tag).
- Modify tests:
  - `test/contexts/fixtures.mjs` (drop the `dist/routes/verify.js` import at :3-6 and the `entitlement_devices` mocks);
  - `test/contexts/meta.test.mjs`;
  - `test/contexts/operator-tools.test.mjs:11-37` (`generate-online-key`);
  - `test/security-modes.test.mjs` (keep only the `ORDER_SIGNER_SCOPE_MODE` cases at :46-86);
  - `test/openapi-spec.test.mjs`, `test/app-composition.test.mjs`;
  - `test/sql/bound-device-http.test.mjs`: :43 (drop the legacy env); :364 (force the `/v2` 503 with `ORDER_SIGNER_SCOPE_MODE: "invalid"` instead of `REQUEST_SIGNATURE_MODE`);
  - `test/db/bound-device-worker.test.mjs:32`, `test/e2e/protected-admin-enrollment.test.mjs:39`: env without legacy selectors, with `BOUND_REGISTRATION_RATE_LIMITER` where a limiter is bound.
- Modify `scripts/check-architecture.mjs:414` and `scripts/check-architecture.test.mjs:367,394-395` (`device_proof/v1/manifest.json`).
- Modify workflows:
  - `.github/workflows/deploy-staging.yml:167-175` (step "Run proof-authenticated staging verifier drill");
  - `.github/workflows/deploy-production.yml:10-13` (the `backend_url` description) and :134-142 (step "Run proof-authenticated backend post-deploy drill"; the protected smoke from Task 27 remains).
- Modify `scripts/workflow-action-pins.test.mjs`: :604, :615-633, :695-703, :721-851 (capacity), :736, :812.
- Modify `scripts/hotspot-baseline.json`: delete `services/cloudflare-licensing-backend/src/routes/verify.ts`.
- Modify `scripts/docs-accuracy.test.mjs:513-525`: drop the `verify.ts` hotspot row; otherwise `lineCount` throws at :523.
- Modify `doc/architecture/system-map.md`: :108 (delete the `verify.ts` row), :67 (backend routes 9 → 8), :117 (backend `app.ts` count), :123 (backend total).
- Modify `scripts/canonical-contracts.mjs:15,419` (9 → 8).
- Modify `doc/capabilities/registry.json`:
  - delete entry `backend-request-proof` (:132-146);
  - add entry `protected-device-licensing`: status `experimental`; the limitation says live TPM, browser and backend journeys remain a release gate; the surfaces are the backend `/v2` routes and the portal consent routes; evidence is `services/cloudflare-licensing-backend/src/routes/bound_devices.mjs` (`handleBoundDevice`), `test/sql/bound-device-http.test.mjs`, the route contract `POST /v2/device-authorizations/exchange` in `test/contracts/backend.json`, and `test/e2e/protected-admin-enrollment.test.mjs`. Follow `scripts/capability-registry.schema.json` for the field set.
  - Add the id to `doc/capabilities/index.rst:86-91`.
- Modify `services/cloudflare-licensing-backend/README.md`:
  - :1 title "Licensecc Cloudflare Online Verifier" becomes "Licensecc Cloudflare Licensing Backend";
  - :25-45, :84-104, :128-156, :184-198, :241-312 (public-verifier capacity), :316-355, :416-482, :807-809, :874-876 (`VERIFY_RATE_LIMITER`);
  - keep the sentences `scripts/docs-accuracy.test.mjs` still asserts.

**Interfaces:**
- Consumes: Tasks 12–14 (SDKs no longer read the vectors), Task 5 (native no longer reads `device_proof/v1`), Tasks 28 and 29.
- Produces:
  - The backend serves 8 routes: META ×3, `POST /v1/orders`, and the four `/v2` routes.
  - The rate-limiter bindings are `BOUND_REGISTRATION_RATE_LIMITER` and `BOUND_SESSION_RATE_LIMITER`.
  - Account tokens, request proof v1 and the online signer no longer exist.

- [ ] **Step 1: Write the failing tests.**
  - `services/cloudflare-licensing-backend/test/db/bound-device-worker.test.mjs`: `registration is edge-limited through BOUND_REGISTRATION_RATE_LIMITER`. Bind a fake limiter under `BOUND_REGISTRATION_RATE_LIMITER` that returns `{ success: false }`; `POST /v2/device-authorizations` returns 429; the fake saw the key `device-v2:<hash>`.
  - `test/app-composition.test.mjs`: `the backend serves exactly eight routes and no /v1/verify`.
  - `scripts/materialize-deploy-configs.test.mjs`: `backend config must bind BOUND_REGISTRATION_RATE_LIMITER and BOUND_SESSION_RATE_LIMITER`.

  Run `npm run test:backend` and `npm run test:release-operations`. Expected: FAIL.
- [ ] **Step 2: Delete the source, scripts, tests, vectors and workflow** as listed.
- [ ] **Step 3: Rename the limiter** across `bound_rate.mjs`, `env.ts`, `wrangler.example.toml`, the materializer and its test, and `services/cloudflare-licensing-backend/README.md:874-876`.
- [ ] **Step 4: Regenerate contracts** (`npm run write:contract-baselines`, review `backend.json`: routeCount 8, and the removed schemas and security schemes; then `npm run test:contracts`).
- [ ] **Step 5: Grep.** This must print nothing:

```bash
git grep -nE "/v1/verify|handleVerify|VERIFY_SQL|verify-statements|account_auth|account_token|accountAuth|ACCOUNT_TOKEN_|REQUEST_SIGNATURE_|DEVICE_PROOF_MODE|parseDeviceProofMode|LEASE_ISSUE_BEARER|ONLINE_SIGNING_|D1_(CLIENT_|ENTITLEMENT_|GLOBAL_)?RATE_LIMIT|MAX_(ASSERTION|CACHE)_TTL_SECONDS|VERIFY_RATE_LIMITER|request_proof|device_proof/v1|online_assertion|public-verifier|capacity\.yml|device-key\.mjs|lccoa1" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis' ':!doc/**/*.md' ':!doc/**/*.rst' ':!**/README.md' ':!CHANGELOG.md'
```

  Record the `DEVICE_PROOF_MODE` evidence in the PR: the grep above, plus `git grep -n "DEVICE_PROOF_MODE" -- services packages scripts` printing nothing.
- [ ] **Step 6: Run the gates.**
  - `npm run check:pr`
  - `npm run test:e2e`
  - `npm run check:dry-run`
  - `npm run test:sdks` (the vectors are gone)
  - `ctest --preset dev-debug` (the vectors are gone)
  - `npm run test:release-operations`
  - `npm run test:workflow-pins`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
- [ ] **Step 7: Commit.** `refactor(backend)!: delete online verification, account tokens and request-proof v1`. The PR description lists the operator actions:
  - rename the `VERIFY_RATE_LIMITER` binding to `BOUND_REGISTRATION_RATE_LIMITER` in deploy configs;
  - delete the `ONLINE_SIGNING_*`, `ACCOUNT_TOKEN_*`, `LEASE_*` and `EMERGENCY_OPERATOR_BEARER` secrets.

### Task 31: Order-ingest security is always enforced

Owner decision: "Security modes are always `required`. Delete `off`/`soft` … with no dev override." Two selectors remain:
- `ORDER_INGEST_MODE` is parsed in `src/fulfillment/order_ingest.mjs:187-193`. `off` returns 404, `soft` only observes, and an invalid value silently becomes `required`.
- `ORDER_SIGNER_SCOPE_MODE` is parsed in `src/security_modes.mjs:31`. Unset means `off`.

Both selectors are deleted. HMAC ingest and signer-scope enforcement always apply.

**Files:**
- Delete `services/cloudflare-licensing-backend/src/security_modes.mjs` and `test/security-modes.test.mjs`.
- Modify `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs`:
  - delete `ingestMode` (:184-193), `signerScopeMode` (:195-206), the mode gates at :849-860 and the `soft` observe path at :925-935;
  - `ORDER_SIGNER_SCOPES` missing or malformed returns 503 `config_error`;
  - an out-of-scope signer returns 403 `signer_scope_forbidden`;
  - delete the `order.signer_scope_violation` warn path.
- Modify `src/app.ts:4,71-84`: delete the `invalidSecurityModeNames` gate.
- Modify `src/routes/meta.ts` (health drops `code`/`invalid_config_modes`).
- Modify `src/observability/index.ts:94,108-112` (`configConsistencyWarnings` keeps a warning when `ORDER_SIGNER_SCOPES` is missing).
- Modify `src/env.ts:55,58,103-104` (`ORDER_INGEST_MODE`, `ORDER_SIGNER_SCOPE_MODE`).
- Modify `src/openapi/components.ts`: :19-20 (delete `INVALID_SECURITY_MODE_CONFIG_ERROR`), :160-187 (delete `HealthConfigError`); `src/openapi/paths/orders.ts:43` (`securityModeConfigErrorResponse` becomes the plain `config_error` response).
- Modify `wrangler.example.toml:38-49`: delete `ORDER_INGEST_MODE` and `ORDER_SIGNER_SCOPE_MODE` and their comments. `ORDER_SIGNER_SCOPES` stays a required secret.
- Modify `scripts/materialize-deploy-configs.mjs:354-356` (no mode selectors remain) and `scripts/materialize-deploy-configs.test.mjs`.
- Modify `services/cloudflare-licensing-backend/scripts/backend-secret-inventory.mjs:30-36` (`REQUIRED_MODES` and `PROTECTED_SELECTOR_COUNT`); `ORDER_SIGNER_SCOPES` is required. Also update `test/backend-secret-inventory.test.mjs`.
- Modify tests:
  - `test/fulfillment/order_ingest_gates.test.mjs`, `order_ingest_exactly_once.test.mjs` and `order_hmac.test.mjs`: every env carries a valid `ORDER_SIGNER_SCOPES` covering the test signer; delete the `off`/`soft` cases;
  - `test/contexts/meta.test.mjs`, `test/app-composition.test.mjs`;
  - `test/sql/bound-device-http.test.mjs:364`: delete the "invalid security mode returns 503 on /v2" case, because no selector exists;
  - `test/openapi-spec.test.mjs`;
  - `test/staging-order-drill.test.mjs`.
- Modify `services/cloudflare-licensing-backend/README.md:430-441,514-574` and `doc/security/threat-model.md` TM-09.

**Interfaces:**
- Consumes: Task 30.
- Produces:
  - `POST /v1/orders` always verifies the HMAC, audience, skew and nonce.
  - It always enforces `ORDER_SIGNER_SCOPES`: missing or malformed returns 503 `config_error`; out of scope returns 403 `signer_scope_forbidden`.
  - No `off`/`soft` selector remains anywhere, and backend `/health` has no `invalid_config_modes`.

- [ ] **Step 1: Write the failing tests** in `order_ingest_gates.test.mjs`:
  - `ORDER_INGEST_MODE=off no longer disables ingest`: with `ORDER_INGEST_MODE: "off"`, a valid signed order is applied (200), not 404.
  - `ORDER_INGEST_MODE=soft no longer skips the mutation`: with `soft`, the row is written.
  - `a signer outside ORDER_SIGNER_SCOPES is refused with no scope mode set`: 403 `signer_scope_forbidden`.
  - `missing ORDER_SIGNER_SCOPES fails closed`: 503 `config_error`.

  Run `npm run test --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Implement** the deletions and the always-on paths.
- [ ] **Step 3: Regenerate contracts** (`npm run write:contract-baselines`, review, then `npm run test:contracts`).
- [ ] **Step 4: Grep.**

```bash
git grep -nE "ORDER_INGEST_MODE|ORDER_SIGNER_SCOPE_MODE|security_modes|invalidSecurityModeNames|invalid_config_modes|INVALID_SECURITY_MODE|\"soft\"|'soft'|mode === \"off\"" -- services packages scripts
```

  Expected: no output.
- [ ] **Step 5: Run the gates.**
  - `npm run test:backend`
  - `npm run test:deployed-readiness --workspace @licensecc/cloudflare-licensing-backend`
  - `npm run test:release-operations`
  - `npm run test:contracts`
  - `npm run check:dry-run`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `feat(orders)!: always enforce order HMAC and signer scope with no rollout modes`. The PR description tells operators that `ORDER_SIGNER_SCOPES` is now mandatory.

---

## P5b — Legacy-only tables

### Task 32: Drop the legacy-only tables and reject triggers from the baseline

Every writer and reader of these tables is gone after Tasks 16–31. `usage_events` stays until Task 33 replaces it, and `entitlements` columns stay until Task 34.

**Files:**
- Modify `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`:
  - delete the tables `account_token_events`, `account_token_revocations`, `account_tokens`, `entitlement_devices`, `lease_issuance`, `request_proof_nonces`, `seat_checkouts`, `usage_meters`;
  - delete the indexes `idx_account_token_events_customer`, `idx_account_token_events_token`, `idx_account_tokens_customer`, `idx_account_tokens_hmac`, `idx_account_tokens_status`, `idx_entitlement_devices_entitlement`, `idx_entitlement_devices_status`, `idx_lease_issuance_entitlement`, `idx_lease_issuance_issued_at`, `idx_request_proof_nonces_expires_at`, `idx_seat_checkouts_live`, `idx_usage_meters_entitlement`;
  - delete the triggers `tr_bound_reject_legacy_device_insert`, `tr_bound_reject_legacy_device_update`, `tr_bound_reject_legacy_lease`, `tr_bound_reject_legacy_seat_insert`, `tr_bound_reject_legacy_seat_update`;
  - delete the column `portal_sessions.account_token_id` and its `FOREIGN KEY … REFERENCES account_tokens(id)`.
- Regenerate `services/cloudflare-licensing-backend/schema.sql`.
- Modify `services/cloudflare-d1-backup/scripts/restore-drill.mjs`:
  - `REQUIRED_TABLES` (:34-62): `entitlement_devices`, `account_tokens`, `account_token_revocations`, `account_token_events`;
  - `PRESENCE_ONLY_TABLES` (:68-92): `request_proof_nonces`, `lease_issuance`, `seat_checkouts`, `usage_meters`;
  - `SENSITIVE_TABLES` (:98-115): :105-107;
  - `EXPECTED_INDEXES` (:123-200): the twelve indexes above;
  - `EXPECTED_TRIGGERS` (:202-256): the five triggers at :251-255;
  - `EXPECTED_SCHEMA_SIGNATURE_SHA256` (:23).
- Modify `services/cloudflare-d1-backup/src/snapshot-inventory.ts:22-27`.
- Modify `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`:
  - :839-867 (table list; `ALL_RESTORE_TABLES.length` 50 → 42);
  - :885-901 (presence-only);
  - :910, :912, :922-932 (row count 178 → the new count; 75 → 63 indexes; 53 → 48 triggers).
- Modify `services/cloudflare-d1-backup/README.md:303-306` ("50 tables, 75 named indexes, and 53 triggers" → 42, 63, 48).
- Modify the backend tests that still name these tables:
  - `test/sql/bound-device-store.test.mjs:268-269,363-368,406-424` (legacy-trigger cases deleted);
  - `test/app-composition.test.mjs:84` (table list);
  - `test/contexts/operator-tools.test.mjs:115-124` (the `entitlement_devices` schema test deleted).
- Modify `services/cloudflare-customer-portal/src/auth/portal_session.mjs:90` (drop `account_token_id` from the session `INSERT`) and any test that inserts `portal_sessions.account_token_id` (`services/cloudflare-customer-portal/test/portal-account-deletion-runbook.test.mjs:24`; grep `account_token_id`).
- Modify `doc/operations/customer-account-deletion.md:40,56-60,71,74` (no token tables or `account-token.mjs revoke-customer` step).

**Interfaces:**
- Consumes: Tasks 23, 28, 30.
- Produces: the baseline has 42 tables. `usage_events` is still present. `EXPECTED_SCHEMA_SIGNATURE_SHA256` is re-pinned.

- [ ] **Step 1: Write the failing test** in `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`: `the baseline has no legacy-only tables`. It asserts that none of the eight table names appears in `ALL_RESTORE_TABLES` or in `schemaRowsFromGeneratedSnapshot(schema.sql)`, and that no `tr_bound_reject_legacy_*` trigger appears. Run `npm run test:backup`. Expected: FAIL.
- [ ] **Step 2: Edit the baseline** as listed. Run `npm run schema:write --workspace @licensecc/cloudflare-licensing-backend`, then `npm run check:schema-parity`.
- [ ] **Step 3: Re-pin the restore drill.** Run `node --test services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs`. It fails and prints the new signature. Update `EXPECTED_SCHEMA_SIGNATURE_SHA256` and the counts.
- [ ] **Step 4: Grep.** This must print nothing outside the baseline history in `docs/`:

```bash
git grep -nE "account_token|entitlement_devices|lease_issuance|request_proof_nonces|seat_checkouts|usage_meters|tr_bound_reject_legacy|legacy_protocol_disabled" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
```

  `legacy_protocol_disabled` still appears in `src/device/bound_issue.mjs:60` and the protected route error lists until Task 35.
- [ ] **Step 5: Run the gates.**
  - `npm run check:schema-parity`
  - `npm run test:backup`
  - `npm run test:services`
  - `npm run test:e2e`
  - `npm run check:dry-run`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 6: Commit.** `refactor(db)!: drop legacy-only tables and reject triggers from the baseline`. The body says to recreate every D1 database.

---

## P6 — Schema columns, mode and baseline tidy-ups

Each task edits `migrations/0001_baseline.sql` in place, regenerates `schema.sql`, re-pins `EXPECTED_SCHEMA_SIGNATURE_SHA256`, and updates the restore-drill inventories and counts. The schema object counts (tables / named indexes / triggers, total rows) are:

| After task | Tables | Indexes | Triggers | Rows |
|---|---:|---:|---:|---:|
| 32 | 42 | 63 | 48 | 153 |
| 33 | 42 | 63 | 48 | 153 |
| 34 | 42 | 63 | 48 | 153 |
| 35 | 42 | 63 | 46 | 151 |
| 36 | 42 | 63 | 46 | 151 |
| 37 | 42 | 63 | 46 | 151 |
| 38 | 42 | 63 | 48 | 153 |

If a count differs, the implementer finds the unexpected object before re-pinning. A count mismatch is a finding, not a number to copy.

### Task 33: Replace `usage_events` with a protected denial table

Protected issuance writes a best-effort `usage_events('denied','device_limit_reached')` row, deduplicated per 15 minutes (`src/device/bound_issue.mjs:84-94`). The admin lists it as "recent refused connections" (`services/cloudflare-license-admin/src/worker/groups/customers/bindings.ts:75-83`) and in the timeseries (`groups/summary-reports/operations.ts:110-116`). Nothing else writes `usage_events` after Task 28.

**Files:**
- Modify `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`:
  - delete the table `usage_events` and the indexes `idx_usage_events_ts`, `idx_usage_events_window`;
  - add:

```sql
CREATE TABLE IF NOT EXISTS device_bound_denials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  feature TEXT NOT NULL,
  license_fingerprint TEXT NOT NULL,
  key_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('device_limit_reached')),
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_bound_denials_window ON device_bound_denials(project, feature, license_fingerprint, key_id, ts);
CREATE INDEX IF NOT EXISTS idx_device_bound_denials_ts ON device_bound_denials(ts);
```

- Regenerate `services/cloudflare-licensing-backend/schema.sql`.
- Modify `services/cloudflare-licensing-backend/src/device/bound_issue.mjs:84-94` (the insert and the 15-minute `NOT EXISTS` read use `device_bound_denials`/`key_id`).
- Modify `services/cloudflare-licensing-backend/src/maintenance/index.ts`: the `usage_events` retention (:9, :75-79) becomes `DEVICE_DENIAL_RETENTION_SEC` on `device_bound_denials`.
- Modify `services/cloudflare-license-admin/src/worker/groups/customers/bindings.ts:75-83` and `groups/summary-reports/operations.ts:110-116` (read `device_bound_denials`).
- Modify `services/cloudflare-d1-backup/scripts/restore-drill.mjs`: `PRESENCE_ONLY_TABLES` (`usage_events` becomes `device_bound_denials`), `EXPECTED_INDEXES`, the signature.
- Modify `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs` (table lists and presence-only list).
- Modify tests:
  - `services/cloudflare-licensing-backend/test/sql/bound-device-http.test.mjs:249-291` (the denial row);
  - `test/app-composition.test.mjs:66,84,106,140` (`usage_events` as a sentinel becomes `device_bound_denials`);
  - `services/cloudflare-license-admin/test/sql/protected-bindings.test.mjs:71-82` (seeds);
  - `test/worker/summary-reports.test.mjs`;
  - `test/sql/workstream-f.test.mjs` (timeseries cases).

**Interfaces:**
- Consumes: Task 32.
- Produces: `device_bound_denials(project, feature, license_fingerprint, key_id, reason, ts)`. It is the only usage-style table, and it holds protected refusals only.

- [ ] **Step 1: Write the failing test** in `bound-device-http.test.mjs`: `a device-limit refusal writes one device_bound_denials row per 15 minutes and the admin lists it`.
  - Exhaust capacity and attempt two exchanges within 15 minutes with the same key: exactly one `device_bound_denials` row.
  - Then import the admin bindings query (reuse the admin `protected-bindings.test.mjs` harness) and assert the row appears under "recent refused connections".

  Run `npm run test:sql --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL (no such table).
- [ ] **Step 2: Edit the baseline**, regenerate `schema.sql`, run `npm run check:schema-parity`.
- [ ] **Step 3: Switch the writer, retention and the two admin readers.**
- [ ] **Step 4: Re-pin the restore drill** (counts unchanged: 42/63/48).
- [ ] **Step 5: Grep.** `git grep -nE "usage_events|idx_usage_events" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'` must print nothing.
- [ ] **Step 6: Run the gates.**
  - `npm run check:schema-parity`
  - `npm run test:services`
  - `npm run test:e2e`
  - admin `CI=1 npm run test:e2e` (`admin-ui.connections.e2e.mjs`)
  - `npm run check:dry-run`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `refactor(db): record protected refusals in device_bound_denials`

### Task 34: Drop the legacy entitlement, policy and catalog columns

This task removes the legacy columns in lockstep with the admin UI record guard. `hasEntitlementRecordData` (`services/cloudflare-license-admin/src/ui/shared/mutationGuards.ts:350-364`) **requires** `device_hash`, `assertion_ttl_seconds`, `rebind_window_sec`, `pool_size`, `heartbeat_grace_sec`, `max_borrow_sec`, `meter_quota`, `meter_period_sec`, `allow_overdraft` and `trial_require_device_proof`. Changing the schema without the guard makes the console reject every entitlement read. The file is an 866-line hotspot at its baseline.

**Files:**
- Modify `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`.
  - `entitlements`: rewrite the `CREATE TABLE` as one clean column list without `device_hash`, `assertion_ttl_seconds`, `cache_ttl_seconds`, `rebind_window_sec`, `pool_size`, `heartbeat_grace_sec`, `max_borrow_sec`, `allow_overdraft`, `meter_quota`, `meter_period_sec`, `trial_require_device_proof`.
    - Keep `max_active_devices`, `lease_seconds`, `revocation_seq`, `authority_revision`, `is_trial`, `trial_expiration_basis`, `trial_duration_sec`, `trial_one_per_device`, `trial_started_at`, `trial_device_hash`, `last_applied_order_seq`, `last_applied_order_epoch`, `policy_id`, `customer_id`, `license_id`, `valid_from`, `valid_until`, `status`, `notes`, `enforcement_mode` (dropped in Task 35), `created_at`, `updated_at`.
  - `entitlement_events`: drop `device_hash`.
  - `entitlement_policies`: the `type` CHECK becomes `('trial', 'node_locked', 'subscription')`; drop `assertion_ttl_seconds`, `pool_size`, `max_borrow_sec`, `trial_require_device_proof`, `meter_quota`, `meter_period_sec`.
  - `catalog_plan_features`: drop `assertion_ttl_seconds`, `pool_size`, `max_borrow_sec`, `meter_quota`, `meter_period_sec`.
  - `tr_bound_entitlement_revision`: delete the `pool_size` and `trial_require_device_proof` terms. The re-derived watch list is `status`, `customer_id`, `valid_from`, `valid_until`, `max_active_devices`, `lease_seconds`, `enforcement_mode` (until Task 35), `revocation_seq`, `is_trial`, `trial_started_at`, `trial_duration_sec`, `trial_expiration_basis`, `trial_one_per_device`, `trial_device_hash`.
- Regenerate `schema.sql`.
- Modify `packages/cloudflare-runtime`:
  - `src/d1/entitlement_mutation.mjs:36` (`ENTITLEMENT_COLUMNS`), plus the `createEntitlement` INSERT and UPDATE column lists; lower the hotspot entry to the new count;
  - `src/d1/entitlement_json.mjs:62,85,91`: `license_mode` becomes `CASE WHEN is_trial = 1 THEN 'trial' ELSE 'node_locked' END`;
  - `src/d1/entitlement_guards.mjs:10-20` (`CAPACITY_COLUMNS`);
  - `src/d1/plan_projection.mjs` (the INSERT and comparison lists; ≤ 1031 lines, lower the entry);
  - `src/entitlements/policy_store.mjs:4-29`;
  - `src/device/bound_trial.mjs:13,37` (the `trial_require_device_proof` range checks).
- Modify `packages/licensing-domain`: `src/entitlements/contracts.d.ts:44,49-56,90-100` and `contracts.mjs:29-33`; `policy.d.ts:18,44,52,75` and `policy.mjs:26-28,45,97`; `catalog/plan_projection.mjs:4,107,125,175,191,212,239` and `.d.ts:51,100`; `catalog/import_preview.mjs:42` and `.d.ts:28,69`.
- Modify the backend:
  - `src/device/bound_issue.mjs:56` (`pool_size !== 0`);
  - `bound_consent.mjs:79,102,117` (`pool_size=0`); `bound_consent_page.mjs:47`; `bound_enrollment.mjs:58`; `bound_recovery.mjs:21`; `bound_store.mjs:15`;
  - `src/fulfillment/order_ingest.mjs` (`device_hash`, `assertion_ttl_seconds`, `cache_ttl_seconds` in `buildCreateStatement` and the audit `SELECT` at :482).
- Modify the admin:
  - `src/worker/groups/entitlements/protected-checks.ts:86,118`;
  - `entitlements/operations.ts`;
  - `src/shared/api.ts` (record types);
  - `src/worker/openapi/components.ts` (entitlement, policy and catalog record schemas);
  - `src/ui/shared/mutationGuards.ts`: `hasEntitlementRecordData` (:350-364) drops the legacy fields, and `license_mode` becomes `trial | node_locked`; also the policy and catalog guards at :361, :381, :401, :461-462, :513, :575, :644, :665. `wc -l` must be ≤ 866; lower the baseline to the new count.
- Modify the portal: `src/worker/support.ts:15-31,76-79` (`OwnedEntitlement`; `licenseMode` from `is_trial`), the entitlements `SELECT` in `src/worker/routes/self-service.ts`, and `src/ui/types.ts`.
- Modify `services/cloudflare-d1-backup/scripts/restore-drill.mjs`:
  - `entitlementSemanticsSql` (:757-777): delete `AND assertion_ttl_seconds > 0 AND (device_hash = '' OR length(device_hash) = 64)`;
  - rename `verifier_candidates` to `authority_candidates`, and the SQL aliases `active_verifier_candidate_count`, `revoked_verifier_denial_count`, `disabled_verifier_denial_count` to `active_authority_candidate_count`, `revoked_authority_denial_count`, `disabled_authority_denial_count`;
  - the reasons at :846-853 say "eligible for protected issuance";
  - re-pin the signature.
- Modify `services/cloudflare-d1-backup/test/backup-restore-drill.test.mjs` and `README.md:313-316`.
- Modify the tests that insert the dropped columns:
  - `services/cloudflare-customer-portal/test/helpers.mjs:106-114`;
  - `services/cloudflare-license-admin/test/worker/fixtures.mjs`, `test/admin-ui.fixture.mjs`;
  - backend `test/sql/bound-device-store.test.mjs:95,295` (the `pool_size` guard cases are deleted with the column);
  - `test/sql/plan-projection.test.mjs`, `test/sql/policy-stamp.test.mjs`;
  - the order suites;
  - `test/admin-ui-workflow/*`;
  - `packages/cloudflare-runtime/test/entitlement-json.test.mjs:132,268`.

  Find the remaining files with the Step 6 grep.

**Interfaces:**
- Consumes: Tasks 17, 18, 24, 25, 33.
- Produces:
  - Entitlement records carry only protected-relevant fields.
  - `license_mode` ∈ {`trial`, `node_locked`}.
  - Policies ∈ {`trial`, `node_locked`, `subscription`}.
  - Restore-drill evidence uses `authority_candidates`.

- [ ] **Step 1: Write the failing tests.**
  - `services/cloudflare-license-admin/test/admin-ui-workflow/entitlements.test.mjs` (run through `test/admin-ui-workflow.test.mjs`): `the entitlement record guard accepts the protected row shape`. `hasEntitlementRecordData` accepts a row with only the kept columns (plus `enforcement_mode: "device_bound_v1"`) and rejects the same row without `max_active_devices`.
  - `services/cloudflare-licensing-backend/test/sql/bound-device-store.test.mjs`: `entitlement authority revision advances for every authority column`. Update each of `status`, `customer_id`, `valid_from`, `valid_until`, `max_active_devices`, `lease_seconds`, `revocation_seq`, `is_trial`, `trial_started_at`, `trial_duration_sec`, `trial_expiration_basis`, `trial_one_per_device`, `trial_device_hash` in turn, and assert that `authority_revision` increments by exactly one each time. Updating `notes` must not bump it.

  Run `npm run test:admin` and `npm run test:sql --workspace @licensecc/cloudflare-licensing-backend`. Expected: the guard test FAILS (legacy fields required). The revision test passes today; keep it as the regression guard for this task and Task 35.
- [ ] **Step 2: Edit the baseline** and regenerate `schema.sql`. Run `npm run check:schema-parity`.
- [ ] **Step 3: Update the runtime, domain, backend, admin, portal and backup code** as listed, including the guard in the same commit.
- [ ] **Step 4: Re-pin the restore drill**, then regenerate contracts (`npm run write:contract-baselines`; review admin, portal and backend; `npm run test:contracts`).
- [ ] **Step 5: Confirm the capacity rule survived.** `node --experimental-sqlite --test services/cloudflare-licensing-backend/test/sql/bound-capacity-predicate.test.mjs` passes. It pins `tr_bound_capacity_decrease`'s `hold_until > unixepoch()` rule against `boundOccupiedSql`.
- [ ] **Step 6: Grep.** This must print nothing:

```bash
git grep -nE "\b(device_hash|assertion_ttl_seconds|cache_ttl_seconds|rebind_window_sec|pool_size|heartbeat_grace_sec|max_borrow_sec|allow_overdraft|meter_quota|meter_period_sec|trial_require_device_proof)\b" -- services packages ':!**/*.md'
```

  One exception: `LccConfigInput.device_hash` lives under `include/` and `sdks/` (config tokens), not under `services`/`packages`, so it is not matched.
- [ ] **Step 7: Run the gates.**
  - `npm run check:schema-parity`
  - `npm run test:services`
  - `npm run test:e2e`
  - admin and portal `test:ui` and `CI=1 npm run test:e2e`
  - `npm run check:hotspots`
  - `npm run check:dry-run`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 8: Commit.** `refactor(db)!: drop seat, meter, TTL and device-hash columns from grants, policies and catalog`

### Task 35: Drop `enforcement_mode`; require an owner; rename the trial key column; default leases to 24 hours

**Files:**
- Modify `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`.
  - `entitlements`:
    - drop `enforcement_mode` and its CHECK;
    - `customer_id TEXT NOT NULL`;
    - `lease_seconds INTEGER NOT NULL DEFAULT 86400` (anything larger is clamped by `bound_issue.mjs:153-155`);
    - rename `trial_device_hash` to `trial_device_key_id` (it stores `sha256:<hex>`, `bound_trial.mjs:8,16`).
  - Delete the triggers `tr_bound_mode_no_downgrade` and `tr_bound_mode_requires_migration`.
  - Rewrite `tr_bound_capacity_decrease`:

```sql
CREATE TRIGGER IF NOT EXISTS tr_bound_capacity_decrease BEFORE UPDATE OF max_active_devices ON entitlements
WHEN NEW.max_active_devices < (
  SELECT COUNT(*) FROM device_bound_bindings b WHERE b.project = OLD.project
  AND b.feature = OLD.feature AND b.license_fingerprint = OLD.license_fingerprint
  AND (b.state = 'active' OR (b.state = 'retiring' AND b.hold_until > unixepoch()))
)
BEGIN SELECT RAISE(ABORT, 'capacity_in_use'); END;
```

  - Rewrite `tr_bound_entitlement_revision`'s `WHEN` so it watches exactly `status`, `customer_id`, `valid_from`, `valid_until`, `max_active_devices`, `lease_seconds`, `revocation_seq`, `is_trial`, `trial_started_at`, `trial_duration_sec`, `trial_expiration_basis`, `trial_one_per_device`, `trial_device_key_id`.
- Regenerate `schema.sql`.
- Modify the backend:
  - `src/device/bound_consent.mjs:79,102,117`, `bound_consent_page.mjs:45`, `bound_enrollment.mjs:58`, `bound_recovery.mjs:20`, `bound_retire.mjs:13`, `bound_store.mjs:14`: drop the `enforcement_mode='device_bound_v1'` predicates;
  - `bound_store.mjs:73-75,135`: `trial_device_key_id`;
  - `bound_issue.mjs:59-60`: delete the mode check and the `legacy_protocol_disabled` denial;
  - delete `legacy_protocol_disabled` from the `/v2` error code lists and OpenAPI (`src/openapi/paths/bound-devices.ts` and any shared error enum).
- Modify `packages/cloudflare-runtime`:
  - `src/device/bound_trial.mjs:15-17,33-42` (`trial_device_key_id`);
  - `src/d1/entitlement_json.mjs:62`;
  - `src/d1/entitlement_mutation.mjs:36,342-350`: delete the mode handling and `enforcement_mode_conflict`.
- Modify `packages/licensing-domain/src/entitlements/contracts.d.ts:26,46,77`.
- Modify the admin:
  - `src/worker/groups/entitlements/create-enforcement.ts:19,41,47,55,59,66`: `enforcement_mode` is no longer accepted. A body carrying it is refused by `validateEntitlementInput`, which already rejects that key at `validation.ts:75,121`.
  - `entitlement-schema.ts:7,38,41,76`; `protected-checks.ts:69,101,126`; `groups/customers/bindings.ts:17,34,67,79`; `summary-reports/operations.ts:177`; `idempotency.ts:113`; `openapi/components.ts:363`; `openapi/paths/entitlements.ts:75`;
  - UI: `DeviceLimitForm.tsx:74`, `EntitlementEditor.tsx`, `Entitlements.tsx:235`, `entitlements/workflow.ts:25,56,111,153,365-367`, `shared/messages.ts:69`, `shared/mutationGuards.ts:60`, the record guards (`trial_device_hash` → `trial_device_key_id`);
  - `src/shared/api.ts`.
- Modify the admin sync and CLI paths that sent `enforcement_mode` (`services/cloudflare-license-admin/scripts/sync-entitlement.mjs`, `src/shared/sync-client.ts`, `services/cloudflare-licensing-backend/scripts/entitlement.mjs`, `services/cloudflare-license-admin/scripts/validate-access-admin.mjs`, `remote-d1-atomicity.mjs`).
- Modify the portal: `src/worker/support.ts:29`, `src/ui/types.ts:14`, the self-service entitlements `SELECT`.
- Modify `services/cloudflare-d1-backup/scripts/restore-drill.mjs` (`EXPECTED_TRIGGERS` drops the two mode triggers; re-pin the signature; triggers 48 → 46) and its test and README counts.
- Modify every test that inserts or asserts `enforcement_mode` or `trial_device_hash`, about 33 files. They are listed by the Step 5 grep; the known ones are:
  - backend: `db/bound-device-d1:78`, `db/bound-device-worker:59,101,176,193`, `fulfillment/order_ingest_exactly_once:217`, `sql/bound-admin-writers:12`, `sql/bound-cleanup-backlog:14`, `sql/bound-consent:17,34,310,359`, `sql/bound-device-http:28,590`, `sql/bound-device-store:21`, `sql/bound-retire:15`, `sql/entitlement-cli-sql:29`, `sql/plan-projection:319,339-340`, `e2e/protected-admin-enrollment:34,70`;
  - admin: the SQL and worker suites;
  - portal: `test/helpers.mjs`, `test/portal-worker-bindings.test.mjs:7`.

**Interfaces:**
- Consumes: Task 34.
- Produces:
  - No `enforcement_mode` anywhere.
  - Every entitlement has a `customer_id`; inserting NULL fails with `NOT NULL constraint failed`.
  - `trial_device_key_id` holds the proven key id.
  - `lease_seconds` defaults to 86400.
  - Admin create with an `enforcement_mode` key returns 400 `invalid_request`.

- [ ] **Step 1: Write the failing tests** in `services/cloudflare-licensing-backend/test/sql/bound-device-store.test.mjs`:
  - `an entitlement without a customer is refused by the schema`: an `INSERT` with `customer_id` NULL throws `/NOT NULL constraint failed: entitlements.customer_id/`.
  - `a protected trial locks to the proven key in trial_device_key_id`: first exchange on a trial grant stores the key id in `trial_device_key_id`; a second key is refused per `bound_trial.mjs`.
  - `a new grant's lease_seconds defaults to 86400`.
  - Extend `entitlement authority revision advances for every authority column` from Task 34 to use `trial_device_key_id`.

  Run `npm run test:sql --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Edit the baseline**, regenerate `schema.sql`, run `npm run check:schema-parity`.
- [ ] **Step 3: Remove every mode predicate and rename the trial column** across backend, runtime, domain, admin, portal and tests.
- [ ] **Step 4: Re-pin the restore drill; regenerate contracts** (`npm run write:contract-baselines`, review, `npm run test:contracts`).
- [ ] **Step 5: Grep.** This must print nothing:

```bash
git grep -nE "enforcement_mode|device_bound_v1'|\"device_bound_v1\"|trial_device_hash|legacy_protocol_disabled|protected_mode_(downgrade|migration_required)|tr_bound_mode_|enforcement_mode_conflict" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
```

  The protected wire names (`lccdl1`, `device-lease`, `lcc-device-proof-v2`) are E5 versioned names and are not matched.
- [ ] **Step 6: Run the gates.**
  - `npm run check:schema-parity`
  - `npm run test:services`
  - `npm run test:e2e`
  - admin and portal `test:ui` and `CI=1 npm run test:e2e`
  - `npm run check:dry-run`
  - `npm run check:hotspots`
  - `npm run test:docs-accuracy`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `refactor(db)!: remove the enforcement mode, require an owner and store the trial key id`

### Task 36: Enrollment requires a requested feature

The v1 enrollment comparison and the optional `requested_feature` exist only for "older clients without the field" (backend `README.md:855-861`). Native clients always send the feature: `bound_public_config.cpp:45` requires a non-empty `session.feature`. The staging drill sends it too (Task 20).

**Files:**
- Modify native:
  - `src/library/device_identity/bound_protocol.cpp:230-249`: `enrollment_comparison_input` always uses `lcc-device-enrollment-comparison-v2`; an empty feature is an error;
  - `bound_protocol.hpp:31` (comment);
  - `test/library/device_identity/device_bound_vectors_test.cpp:95-137`: delete the v1 comparison case and keep :139-156.
- Delete `test/vectors/device_bound/v1/enrollment_comparison.json`. Keep `enrollment_comparison_feature.json`.
- Modify the SDK vector tests: `sdks/python/tests/test_device_bound_vectors.py:39-42`, `sdks/dotnet/test/Licensecc.Client.Tests/DeviceBoundVectorsTests.cs:125-129`, `sdks/java/src/test/java/io/licensecc/client/DeviceBoundVectorsTest.java:33,127-129`.
- Modify `packages/licensing-domain/src/lease/device_protocol.mjs:48-59` (`requested_feature` required; v2 prefix only) and `packages/licensing-domain/test/device-protocol.test.mjs:27-28`.
- Modify the backend:
  - `src/device/bound_request.mjs:37-40` (`requested_feature` required in `authorize`);
  - `bound_enrollment.mjs:28-38`;
  - `bound_consent.mjs:56,78,95,116` (delete the project-wide selection path used when no feature was requested);
  - `bound_consent_page.mjs:46`;
  - `src/openapi/paths/bound-devices.ts:19-20` (required).
- Modify the baseline:
  - `device_bound_authorizations.requested_feature TEXT NOT NULL CHECK (length(requested_feature) BETWEEN 1 AND 15 AND requested_feature NOT GLOB '*[^A-Za-z0-9_.:-]*')`;
  - `tr_bound_requested_feature_insert`/`_update`: `WHEN NEW.feature IS NOT NULL AND NEW.feature <> NEW.requested_feature`;
  - keep `tr_bound_requested_feature_immutable`.
  - Regenerate `schema.sql`; re-pin the restore drill (counts unchanged).
- No portal source change. The portal renders whatever licence choices the backend inspect returns, and neither `services/cloudflare-customer-portal/src` nor its tests mention `requested_feature` (verified). Run the portal consent suites as a gate.
- Modify `scripts/check-architecture.mjs:406` and `scripts/check-architecture.test.mjs:385` (the v1 comparison vector path).
- Modify docs:
  - backend `README.md:855-861`: the heading "Protected enrollment compatibility and readiness" becomes "Protected enrollment readiness";
  - `doc/api/feature_sessions.rst:21`;
  - `doc/operations/cloudflare-setup.md:403-406`;
  - `doc/api/device_enrollment.rst:38,53`.

**Interfaces:**
- Consumes: Task 35.
- Produces: `POST /v2/device-authorizations` without `requested_feature` returns 400 `invalid_request`. The comparison transcript is always `lcc-device-enrollment-comparison-v2`.

- [ ] **Step 1: Write the failing test** in `services/cloudflare-licensing-backend/test/bound-device-request.test.mjs`: `an authorization without requested_feature is refused` (`validateBoundRequest("authorize", …)` throws `invalid_request`). Run `npm run test --workspace @licensecc/cloudflare-licensing-backend`. Expected: FAIL.
- [ ] **Step 2: Implement** across native, domain, backend, baseline and portal.
- [ ] **Step 3: Grep.** `git grep -nE "comparison-v1|enrollment_comparison\.json|Older clients|older clients" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug`
  - `npm run test:sdks`
  - `npm run check:schema-parity`
  - `npm run test:services`
  - portal `CI=1 npm run test:e2e`
  - `npm run test:contracts`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `feat(device-bound)!: require the requested feature and drop the v1 enrollment comparison`

### Task 37: Baseline tidy-ups — the order nonce column and the portal session auth method

**Files:**
- Modify `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`:
  - `order_ingest_nonces`: rename `event_id` to `request_nonce_id` (primary key `(key_id, request_nonce_id)`);
  - `portal_sessions`: `auth_method TEXT NOT NULL CHECK (auth_method IN ('otp', 'oauth', 'password'))`, with no `DEFAULT` and no `'legacy'`.
  - Regenerate `schema.sql` and re-pin the restore drill.
- Modify `services/cloudflare-licensing-backend/src/fulfillment/order_ingest.mjs:256-267` (the SQL and the comment "in its legacy `event_id` column").
- Modify `services/cloudflare-customer-portal/src/auth/portal_session.mjs`: :18 (the typedef drops `"legacy"`), :79 (`authMethod` is required; `mintSession` throws `invalid_session_method` without it).
- Modify tests:
  - `services/cloudflare-customer-portal/test/portal-session.test.mjs`: the 11 `mintSession` calls at :22-129 pass `authMethod`;
  - `test/portal-worker-fixtures.mjs:58`: `cookieFor` passes `"password"`, which is not a "verified" method (`routes/password.ts:46` treats only `otp`/`oauth` within 600 s as verified), so no suite silently gains verified status;
  - `test/portal-worker-oauth.test.mjs:375,416` (`"legacy"` becomes `"password"`);
  - `services/cloudflare-licensing-backend/test/db/bound-device-worker.test.mjs:87`;
  - the order nonce tests (`test/fulfillment/order_hmac.test.mjs`, `order_ingest_exactly_once.test.mjs`) that read the column.

**Interfaces:**
- Consumes: Task 36.
- Produces: `order_ingest_nonces(key_id, request_nonce_id, …)`, and `portal_sessions.auth_method` ∈ {`otp`, `oauth`, `password`} with no default.

- [ ] **Step 1: Write the failing tests.**
  - `services/cloudflare-customer-portal/test/portal-session.test.mjs`: `mintSession without an auth method is refused`, and `a portal session with auth_method legacy is refused by the schema` (a raw `INSERT` with `auth_method = 'legacy'` throws `CHECK constraint failed`).

  Run `npm run test:portal` and `npm run test:backend`. Expected: FAIL.
- [ ] **Step 2: Edit the baseline and the code**; update the tests.
- [ ] **Step 3: Grep.** `git grep -nE "'legacy'|\"legacy\"|legacy .event_id|auth_method TEXT NOT NULL DEFAULT" -- services packages` must print nothing.
- [ ] **Step 4: Run the gates.**
  - `npm run check:schema-parity`
  - `npm run test:services`
  - portal `CI=1 npm run test:e2e`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `refactor(db): name the order request nonce and require an explicit portal session method`

### Task 38: Webhook endpoints need an explicit scope and canonical event types

Controller ruling: "require an explicit scope, or an explicit `global` marker for operator-wide endpoints; drop the NULL default." The legacy `event_types` tolerance is also removed:
- today, patch may resend an unknown token unchanged (`services/cloudflare-license-admin/src/worker/webhook_event_types.ts:6-11,60-77`; `webhooks.ts:98-106,123-129,305-313`);
- the UI displays and drops unknown tokens (`Webhooks.tsx:46-50,404-436`; `ui/features/webhooks/workflow.ts:66-91`).

A SQLite `CHECK` cannot inspect CSV tokens, so the baseline enforces membership with two triggers that use `json_each`. The token list is pinned against `WEBHOOK_EVENT_TYPES` by the existing schema-parity test for event types.

**Files:**
- Modify `services/cloudflare-licensing-backend/migrations/0001_baseline.sql`.
  - `webhook_endpoints`: rewrite as one column list adding `scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'customer'))`, with no default, plus:

```sql
CHECK ((scope_kind = 'global' AND scope_project IS NULL AND scope_customer_id IS NULL)
    OR (scope_kind = 'project' AND length(scope_project) > 0 AND scope_customer_id IS NULL)
    OR (scope_kind = 'customer' AND length(scope_customer_id) > 0 AND scope_project IS NULL))
```

  - Add `tr_webhook_event_types_known_insert` (`BEFORE INSERT ON webhook_endpoints`) and `tr_webhook_event_types_known_update` (`BEFORE UPDATE OF event_types ON webhook_endpoints`), each:

```sql
WHEN NEW.event_types <> '' AND EXISTS (
  SELECT 1 FROM json_each('["' || replace(NEW.event_types, ',', '","') || '"]')
  WHERE value NOT IN ('create', 'update', 'disable', 'reenable', 'revoke', 'upsert', 'revoked-override',
    'subscription.active', 'subscription.renewed', 'subscription.past_due', 'subscription.paused',
    'subscription.payment_failed', 'subscription.canceled_at_period_end', 'subscription.resumed',
    'quantity.changed', 'fraud.confirmed', 'chargeback'))
BEGIN SELECT RAISE(ABORT, 'invalid_event_types'); END;
```

  This list is the union of `WEBHOOK_EVENT_TYPES` (`packages/cloudflare-runtime/src/webhooks/event_types.mjs:17-24`) and `ORDER_INTENTS` (`packages/licensing-domain/src/orders/intents.mjs`). The customer tokens `disable`/`reenable` are already in the entitlement list. A token containing `"` makes `json_each` fail, which aborts the write (fail closed); the admin shape validator already refuses such tokens.

  - Regenerate `schema.sql`. Re-pin the restore drill: `EXPECTED_TRIGGERS` +2, so triggers 46 → 48.
- Modify `packages/cloudflare-runtime/src/webhooks/webhook.mjs`: :377 (select `scope_kind`); :383-402 (`endpointScopeMatches` switches on `scope_kind`; delete the null/empty "global (back-compat)" branch). `wc -l` must be ≤ 638.
- Modify `packages/cloudflare-runtime/src/webhooks/event_types.mjs` (comment). Extend `packages/cloudflare-runtime/test/webhook-event-types.test.mjs`, which already parses `schema.sql` for the event-type CHECK lists, to assert that the token set in `tr_webhook_event_types_known_insert` and `_update` equals the union of `WEBHOOK_EVENT_TYPES`.
- Modify the admin:
  - `services/cloudflare-license-admin/src/worker/webhooks.ts`: :84-91, :98-106, :123-129, :137-145, :149-150, :256-270, :305-328. Create requires `scope_kind`; `project` requires `scope_project`; `customer` requires `scope_customer_id`; `global` requires neither. Patch revalidates the full resulting scope and the full `event_types` set every time.
  - `src/worker/webhook_event_types.ts`: one validator, shape plus membership; delete the shape-only patch path and its comment.
- Modify the admin UI:
  - `src/ui/features/webhooks/Webhooks.tsx:46-50,404-442`: a scope selector ("Every event (operator-wide)", "One project", "One customer"); no unknown-token display;
  - `src/ui/features/webhooks/workflow.ts:18-29,66-91,132-133,154-164,168-176,183-184`;
  - `src/ui/shared/mutationGuards.ts:386,521`: require `scope_kind`. It must stay ≤ its lowered baseline.
- Modify `src/worker/openapi/components.ts:823-847` and `src/shared/api.ts:351-373`.
- Modify tests:
  - `services/cloudflare-licensing-backend/test/sql/webhook-dispatch.test.mjs:153,220,231`;
  - `services/cloudflare-license-admin/test/sql/webhook-admin.test.mjs:226-247`;
  - `test/worker/webhooks.test.mjs:42-157`, `test/webhooks.test.mjs:106-125`;
  - `test/admin-ui.webhooks.e2e.mjs:70-93`, `test/admin-ui-workflow/webhooks.test.mjs:51-55`;
  - `packages/cloudflare-runtime/test/webhook-*.test.mjs` (scope fixtures).
- Modify `services/cloudflare-license-admin/README.md` (webhook section).

**Interfaces:**
- Consumes: Task 37.
- Produces:
  - `POST /api/admin/webhooks` requires `scope_kind` ∈ {`global`, `project`, `customer`} with the matching field.
  - A missing `scope_kind` returns 400 `invalid_request`.
  - Unknown event tokens return 400 `invalid_event_types` on create and on every patch.
  - The database refuses both independently.

- [ ] **Step 1: Write the failing tests.**
  - `services/cloudflare-license-admin/test/worker/webhooks.test.mjs`: `a webhook without scope_kind is refused` (400 `invalid_request`); `patching a webhook keeps rejecting an unknown event token even when unchanged`.
  - `services/cloudflare-license-admin/test/sql/webhook-admin.test.mjs`: `the schema refuses a webhook with no scope_kind or an unknown event type`.
  - `services/cloudflare-licensing-backend/test/sql/webhook-dispatch.test.mjs`: `a global endpoint receives every event only when scope_kind is global`.

  Run `npm run test:admin` and `npm run test:backend`. Expected: FAIL.
- [ ] **Step 2: Edit the baseline**, regenerate `schema.sql`, run `npm run check:schema-parity`.
- [ ] **Step 3: Update the runtime, admin Worker, UI, OpenAPI and tests.**
- [ ] **Step 4: Re-pin the restore drill; regenerate contracts** (`npm run write:contract-baselines`, review, `npm run test:contracts`).
- [ ] **Step 5: Grep.**

```bash
git grep -nE "back-compat|legacy value|legacy token|unknownWebhookEventTypes|blank = all|safeWebhookEventTypesShape" -- services/cloudflare-license-admin packages/cloudflare-runtime/src
```

  Expected: no output.
- [ ] **Step 6: Run the gates.**
  - `npm run check:schema-parity`
  - `npm run test:services`
  - admin `test:ui` and `CI=1 npm run test:e2e`
  - `npm run check:hotspots`
  - `npm run check:dry-run`
  - `npm run check:pr`
- [ ] **Step 7: Commit.** `feat(webhooks)!: require an explicit endpoint scope and known event types`

---

## P7 — Tooling aliases, documentation and final sweep

### Task 39: Remove the tooling compatibility aliases and require an explicit deploy profile

**Files:**
- Modify root `package.json:8`: delete `check:all`.
- Modify `scripts/README.md:31` (the `check:all` row), `CONTRIBUTING.md:74`, `doc/architecture/change-guide.md:213-217`, `.agents/skills/using-licensecc/SKILL.md:61`.
- Modify `scripts/docs-accuracy.test.mjs`:
  - :366: assert `check:all` is absent;
  - :363 pins "not a literal completeness claim", which today appears only in the `check:all` row of `scripts/README.md`. Move the phrase into the `check:review` row's excluded-surfaces cell ("… network link validation, staging, and production evidence; “review” is not a literal completeness claim.") and keep the assertion.
- Modify `scripts/dev-check.ps1`: delete `-IncludeBackend` (param :34, uses :158, :195-199, :239, :243-244); `-IncludeServices` covers it. Also remove `ci-linux-core` (:10) and `ci-windows-msvc` (:25) from the preset `ValidateSet`.
- Modify `CMakePresets.json`: delete the configure, build and test presets `ci-linux-core` (:122, :432, :626) and `ci-windows-msvc` (:358, :520, :791). `ci-linux-core` is identical to `ci-linux-debug` apart from its directories; `ci-windows-msvc` is the debug-dynamic shape.
- Modify `scripts/check-build-purity.ps1:10,25`; `.github/workflows/codeql.yml:57` (`-Preset ci-linux-debug`); `scripts/build-purity-static.test.mjs:415` (loop over `ci-linux-debug`, `ci-linux-release`); `scripts/ci/security-governance.test.mjs:97` (`-Preset ci-linux-debug`).
- Modify `scripts/materialize-deploy-configs.mjs`:
  - :592: no default `profile`;
  - :627-631: `profileFromArguments` throws the usage error when `--profile` is absent.

  Every workflow already passes `--profile` (`deploy-production.yml:76`, `deploy-staging.yml:88`, `recovery-drill.yml:65`, `rollback-workers.yml:101`).
- Modify `scripts/materialize-deploy-configs.test.mjs:234-242` ("keeps the omitted profile backward-compatible with production" becomes the refusal test).

**Interfaces:**
- Consumes: nothing. This task may run any time after Task 1.
- Produces:
  - `npm run check:review` is the only aggregate.
  - `dev-check.ps1 -IncludeServices` replaces `-IncludeBackend`.
  - The presets are `ci-linux-debug` and `ci-windows-msvc-debug-dynamic`.
  - `node scripts/materialize-deploy-configs.mjs` with no `--profile` exits non-zero with the usage message.

- [ ] **Step 1: Write the failing test** in `scripts/materialize-deploy-configs.test.mjs`: `an omitted deploy profile is refused` (the materializer throws the usage error; nothing is written). Run `node --test scripts/materialize-deploy-configs.test.mjs`. Expected: FAIL.
- [ ] **Step 2: Implement** the materializer change and delete the aliases and presets.
- [ ] **Step 3: Grep.**

```bash
git grep -nE "check:all|IncludeBackend|ci-linux-core|\"ci-windows-msvc\"|ci-windows-msvc[^-]|backward-compatible with production|compatibility alias" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
```

  Expected: no output.
- [ ] **Step 4: Run the gates.**
  - `npm run test:release-operations`
  - `npm run test:security-governance`
  - `npm run test:clean-checkout`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `npm run check:pr`
- [ ] **Step 5: Commit.** `chore(tooling)!: drop compatibility aliases and require an explicit deploy profile`

### Task 40: Rewrite the maintained documentation for protected-only licensing

This finishes every doc not already forced by an earlier task's gates. It also fixes the stale protected-docs text the brief found:
- the backend README still says "the native protected consumer remains unfinished";
- `device_identity.rst:375` says "no production transport on non-Windows platforms";
- `sdks.rst:33-36` describes "Windows"-only adapters;
- `device_enrollment.rst:1` and the portal `README.md:52` still say "Staged".

**Files:**
- Modify `doc/operations/production-readiness.md`:
  - PRD-03 (:146-193);
  - PRD-04 (:195-229);
  - PRD-05 (:231-256): restate the objectives for `/v2/device-authorizations/exchange` and `/v2/device-leases/renew`, state that no protected capacity harness exists yet, and make no capacity claim;
  - Launch scope (:38-54): the owner-accepted capability losses, listed below;
  - Phases 3 and 5 (:381-488).
- Modify `doc/operations/observability.md`: :64-93 (public-verifier, request-proof and rate-limit panels; OBS-01/02/04/06), :166-169, :207-240 (`lcca_`, `lccoa1`, capacity).
- Modify `doc/operations/cloudflare-setup.md`: :161-179 (secrets by purpose: only `BOUND_*`, `ORDER_*`, `WEBHOOK_*`, portal and admin secrets), :272-276, :302-326, :380-416.
- Modify `doc/usage/issue-licenses.md:8-10,100-147`: offline `.lic` issuance with `lccgen` (v201) plus protected grants; no `/v1` routes.
- Modify the API docs:
  - `doc/api/services.rst:15-46`;
  - `doc/api/device_identity.rst:1-26,367-375`;
  - `doc/api/device_enrollment.rst:1` (title "Device enrollment");
  - `doc/api/feature_sessions.rst:96-104`;
  - `doc/api/sdks.rst:4,33-42`;
  - `doc/tutorials/sdk-and-support.rst`.
- Modify `doc/release-artifacts.md:189-317` (the public-verifier gate, `DEVICE_PROOF_MODE`, the lease drill, the capacity harness).
- Modify `doc/security/threat-model.md`:
  - :44-46 (boundary rows): drop verify/lease inputs and account-token peppers;
  - TM-01 to TM-04 (:64-67): rewrite for protected leases (`lccdl1` forgery, signer theft, replay of proofs, enrollment and consent abuse);
  - TM-15 (:78): no emergency routes; portal bootstrap only;
  - TM-16 (:79): delete it, because `DEVICE_PROOF_MODE` is gone;
  - add rows for the global fuse denying all licensing (`BOUND_GLOBAL_RATE_LIMIT`), protected signer compromise, and consent phishing;
  - :123-125 (verification column).
- Modify `doc/architecture/system-map.md:14-17` (module responsibilities: no "online decision/seat lifecycle" or "online verification"), `doc/architecture/ownership.md:16` (backend owns "protected device licensing, fulfillment, webhooks, D1 schema, backend OpenAPI and deployment").
- Modify `doc/architecture/glossary.md`: the copy-guard term lists and any remaining legacy rows not handled in Task 25.
- Modify `README.md:12,120-121` (product summary: offline `.lic` files, config tokens, and protected device-bound online licensing).
- Modify `services/cloudflare-licensing-backend/README.md`: :1-57, :58-199, :590-602 (the "staged implementation" heading and the stale "native protected consumer remains unfinished" text), :758-764 (cutover), :801-812.
- Modify `services/cloudflare-customer-portal/README.md:52`, `services/cloudflare-license-admin/README.md` (the remaining legacy lines at :410, :476, :482-486, :661-668, :689-700), `doc/usage/concepts.rst`, `doc/usage/integration.rst`, `doc/usage/examples.rst`, `doc/index.rst`. Each must be clean against the Step 2 grep.
- Modify `doc/capabilities/index.rst` (status narrative).
- Modify `scripts/docs-accuracy.test.mjs` where a prose pin names text this task deletes. Never weaken a pin to make prose pass.

The owner-accepted capability losses to state in `production-readiness.md` Launch scope and in the root README status:
1. floating/concurrent seats;
2. metering and quotas;
3. usage reports;
4. online revocation for `.lic` apps;
5. server-issued 30-day offline leases (protected authority lasts at most 24 h and never survives a process restart);
6. online licensing without a TPM and a desktop browser (headless, CI, containers, Windows Server 2022);
7. SDK-only online licensing;
8. customer account tokens;
9. `/v1/emergency`;
10. the local SQLite online demo.

Also state:
- every D1 database must be recreated from the baseline;
- live TPM, browser and backend journeys remain release gates;
- the protected global fuse can deny all online licensing.

**Interfaces:**
- Consumes: Tasks 1–39.
- Produces: maintained docs describe only the surviving system.

- [ ] **Step 1: Rewrite the pages** listed above.
- [ ] **Step 2: Grep the maintained docs.**

```bash
git grep -nIiE "/v1/(verify|activate|renew|checkout|heartbeat|release|meter|admin/report|emergency)|lccoa1|account token|floating seat|seat pool|DEVICE_PROOF_MODE|REQUEST_SIGNATURE|public verifier|staged (device|browser|implementation)|older clients|v200" -- README.md CONTRIBUTING.md SECURITY.md AGENTS.md .agents doc services/*/README.md sdks/*/README.md sdks/*/native/README.md examples fuzz/README.md ':!doc/analysis'
```

  Expected: no output, except capability-loss statements that name a removed feature in order to say it is gone. List each remaining line in the PR.
- [ ] **Step 3: Run the gates.**
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:capabilities`
  - `npm run test:docs-quickstart`
  - `npm run check:pr`
- [ ] **Step 4: Commit.** `docs: describe protected-only licensing, the single schema baseline and the capabilities removed`

### Task 41: Reset the CHANGELOG and remove the inherited-tag narrative

Controller ruling: "reset the CHANGELOG to a single 'Unreleased: initial release' baseline". The inherited-bare-tag text is compatibility-only history. The rule itself ("no new bare `v*` tags") is enforced by `scripts/check-release-tag.mjs` and stays.

**Files:**
- Modify `CHANGELOG.md`. The whole file becomes:
  - the title and the Keep-a-Changelog line;
  - the two version lines `check-version-contract.mjs:425-435` requires (`- **C++ library** (\`CMakeLists.txt\`): \`2.1.0\` …` and `- **Platform packages** … \`0.1.0-rc.2\` (Python \`0.1.0rc2\`) …`);
  - the tag-namespace sentence, without "The reachable bare tag (`v1.0.0`) predates … and remains legacy history";
  - one section `## [Unreleased] — initial release`, with:
    - `### Included`: offline v201 `.lic` licensing with `lccgen`; `lcccfg1` config tokens; protected device-bound licensing and feature sessions (Windows and Linux TPM); backend order ingest and the four `/v2` routes; the admin console; the customer portal (consent, connected devices); webhooks and audit; the D1 backup and restore drill; Python, .NET and Java SDKs (config tokens and protected adapters);
    - `### Not included`: the capability-loss list from Task 40, one line each.
- Modify `doc/architecture/decisions/0005-platform-version-and-release-tags.md`:
  - :13: drop the sentence about the bare `v1.0.0` tag;
  - :61-62: keep "no new bare `v*` tags"; drop "Existing bare tags remain immutable legacy history…";
  - :85: drop "without interpreting inherited bare tags".
- Modify `SECURITY.md:11-13`: drop "inherited legacy tags do not describe the current platform".
- No test pins the removed tag sentences (verified: no hit for "legacy history" or "inherited" in `scripts/check-version-contract*.mjs`, `scripts/release-artifacts.test.mjs`, `scripts/docs-accuracy.test.mjs`).

**Interfaces:**
- Consumes: Task 40.
- Produces: `CHANGELOG.md` has one Unreleased section. `npm run check:versions` still finds both version lines.

- [ ] **Step 1: Rewrite the CHANGELOG and the three tag sentences.**
- [ ] **Step 2: Grep.** `git grep -nIiE "legacy history|inherited (bare|legacy) tags|Upgrade notes" -- CHANGELOG.md SECURITY.md doc/architecture` must print nothing.
- [ ] **Step 3: Run the gates.**
  - `npm run check:versions`
  - `npm run test:versions`
  - `npm run test:release-artifacts`
  - `npm run test:docs-accuracy`
  - `npm run check:docs`
  - `npm run check:pr`
- [ ] **Step 4: Commit.** `docs: reset the changelog to a single initial-release baseline`

### Task 42: Whole-repository sweep, ADR update and evidence report

**Files:**
- Modify `doc/architecture/decisions/0006-device-bound-licensing.md`:
  - Status: add "Amended: 2026-09-28 — protected mode is the only online mode; the compatibility and cutover section is superseded."
  - Context (:17-19): delete "remain separate from supported legacy and floating clients".
  - Replace "Compatibility and cutover" (:72-88) with a section "Protected-only operation": entitlements have no enforcement mode; there are no legacy verification, issuance, device-registration or floating-seat paths to fence; there is no cutover because the schema is a single baseline and every database is recreated; D1 is the only store.
  - Consequences (:96-99): drop "protected legacy-route denial".
- Modify `doc/architecture/index.rst`: the ADR 0006 line "persistent capacity, recovery, clock policy and legacy cutover boundaries" becomes "persistent capacity, recovery and clock policy".
- Create `docs/implementation/2026-09-28-remove-legacy-mode-and-compat.md` (the evidence report), containing:
  - per task: the verified commit, the exact commands with their outcomes, and the surfaces not run, with reasons;
  - the sweep classification table (Step 2);
  - the final schema counts;
  - the owner-visible consequences;
  - follow-ups (Step 4).

**ADR decision.** The change guide does not require a new ADR. ADR 0006 has been amended in place before (its status line records later changes), and ADR 0002 uses an "Amended:" line. So the decision is recorded by amending ADR 0006, with no ADR 0007.

**Interfaces:**
- Consumes: Tasks 1–41.
- Produces: the evidence report, and ADR 0006 in its final form.

- [ ] **Step 1: Run the sweep greps** from the repository root:

```bash
git grep -nIiE "legacy|compat|backward|deprecated" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis' ':!**/package-lock.json' ':!**/uv.lock' ':!**/packages.lock.json' ':!doc/requirements.txt'
git grep -nIE "LEASE_ISSUE_BEARER|enforcement_mode|v200" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis'
git grep -nIiE "supabase|postgres|pg-parity" -- ':!docs/superpowers/plans' ':!docs/implementation' ':!doc/analysis' ':!**/package-lock.json'
```

- [ ] **Step 2: Classify every remaining hit** in the evidence report as **fine** or **fix**.
  - Expected **fine** hits:
    - Windows API names `LEGACY_RSAPRIVATE_BLOB` and `legacy_key_spec`;
    - E1 `size`/`version`/`reserved` field comments;
    - E7 CMake `COMPATIBILITY SameMajorVersion`;
    - E6 bridge-layout "incompatible" probes and `sdks/python/native/bridge.cpp:58` ("keep the old bridge layout byte-for-byte stable");
    - the ADR 0005 SemVer "backward-compatible" release policy;
    - `license_generator_lib`;
    - the plan-projection "legacy entitlement identity" fence for non-catalog rows (reword to "non-catalog entitlement identity" if the word remains in code; it is not a mode);
    - the admin "legacy customer-detail bundle" wording (reword to "customer-detail bundle");
    - the typecheck-coverage "legacy JS graphs" (tech debt, not compatibility);
    - `package_config_rejects_old_curl`;
    - the order-ingest `cached` fallback;
    - pepper and key rotation;
    - `portal_otp.mjs:194` (empty pepper map);
    - `doc/architecture/decisions/0005` release-tag rule text;
    - the capability-loss statements from Tasks 40 and 41.
  - Anything else is **fix**: fix it in this task and re-run the grep.
- [ ] **Step 3: Update ADR 0006 and `doc/architecture/index.rst`** as listed.
- [ ] **Step 4: Write the evidence report.** Follow-ups (not removed, with reasons):
  - the orphaned `lccareq1` activation codec (`src/library/activation/`) is an offline feature, not compatibility;
  - a protected-only native consumer still needs an `lccgen`-generated project header (`os/signature_verifier.hpp:18-22`);
  - the live TPM, browser and backend release gate, remote signer rotation qualification, the global fuse and the protected capacity harness are open release items;
  - the D1 database is still named `licensecc-online-verifier` (`services/cloudflare-d1-backup/src/core.ts:110`, workflows); renaming it is an operator-visible change for a separate decision;
  - `LCC_API_ONLINE_PROJECT_SIZE`, `_LICENSE_FINGERPRINT_SIZE` and `_DEVICE_HASH_SIZE` keep their names because config tokens and `device_identity.h` share them.
- [ ] **Step 5: Run the full final gate** on the branch head:
  - `npm ci`
  - `npm run check:pr`, with no tolerated failures;
  - `npm run test:sdks`
  - `npm run setup:browsers`, then `npm run test:e2e`
  - `npm run check:dry-run`
  - `npm run check:docs`
  - `npm run test:docs-quickstart`
  - `pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug`
  - `ctest --preset dev-debug`
  - WSL `ctest --preset ci-linux-debug` and `ctest --preset ci-linux-sanitizers`

  Record each command and outcome in the evidence report. Name any surface not run and why (for example, the live staging drill needs Cloudflare credentials).
- [ ] **Step 6: Commit.** `docs(architecture): record protected-only licensing and the single schema baseline`

