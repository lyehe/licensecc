# Essential Features Implementation Plan

> Comprehensive, dependency-ordered plan to implement licensecc's missing **essential** features, derived from the 2026-06-25 competitive gap analysis (Keygen / Cryptolens / LicenseSpring / Flexera-FlexNet / Thales Sentinel / Reprise RLM / the billing-led cohort / Zentitle-10Duke-Revenera). Every design below is grounded in the actual code (Cloudflare Workers + D1, the shared `entitlement_mutation.mjs`, the C++ static lib, the two React consoles). Authored via a multi-agent planning workflow (8 parallel code-grounded workstream designs + a sequencing synthesis).

**Workstreams:** A policy/template + trials (keystone) · B portal device self-serve · C operator-console scale · D integration surface (OpenAPI + webhooks + Stripe adapter) · E multi-language SDKs · F dashboards/triage · G C++ client lifecycle · H hardware-match reliability.

## Executive summary

This plan sequences eight workstreams into five phases ordered by hard dependencies, not by desirability. "Essential" is scoped to: the platform being deployable and consumable (Phase 0), the policy/trial keystone every richer attribute hangs off (A), the self-serve and operator surfaces the keystone unlocks (B, C, F), the documented integration contract (D) and the SDKs it gates (E), the turnkey C++ lifecycle that pairs with the SDKs (G), and the hardware-reliability path that depends on the policy knobs (H). The spine is: deploy plus client-lifecycle prerequisites first, then A as the single keystone, then the additive surfaces that consume A in parallel, then the OpenAPI-gated SDK chain, then the policy-gated fuzzy-match work. Phase 0 is mandatory because nothing is consumable until the back-office is landed and deployed on a shared branch and the C++ confirm/release lifecycle exists. A is the true keystone: it owns the entitlement_policies template, the stampFromPolicy helper, the per-policy knobs (match_*, relink_*, named-user, metering windows), and the first ALTER TABLE entitlements, so B, C, D, F all depend on A's envelope/projection stability and H depends on A's policy columns. The most acute cross-cutting hazard is migration-number collision: six workstreams each independently propose migration 0018 and two of them (A, H) both ALTER entitlements, so a single owner must arbitrate migration numbering and the schema.sql plus schema.pg.sql plus parity-checker triple-edit per PR. The byte-identical entitlement_mutation.mjs constraint (createEntitlement's INSERT...ON CONFLICT body and ENTITLEMENT_COLUMNS must never drift, mirrored by order_ingest) is the second invariant that constrains every backend workstream to compose existing mutators rather than edit them. Quick wins (pagination consumption, typed-confirm dialogs, OpenAPI-doc-of-existing) are pulled forward within their phases so value lands before the large builds complete. The signed-token ABI change (trial-in-token, MATCH_MOST canonical) is deliberately deferred behind coordinated version bumps with golden-vector regen, never rushed inside a feature slice.

## Scope — what is essential vs deferred

- IN: Phase 0 land+deploy of the operations back-office on a shared integration branch, plus the C++ confirm_license/release_license lifecycle (G structs/orchestrator) because the platform is not consumable and the C++ adoption story does not exist until both land. This is the prerequisite gate for every consumer-facing slice.
- IN: Workstream A in full as the keystone: entitlement_policies table, stampFromPolicy pure pre-step, trial model surfaced ONLY in the unsigned response envelope, staged POLICY_STAMP_MODE=off|soft|required. It gates B, C, D, F and H.
- IN: Workstreams B, C, F as the A-consuming surfaces (portal device lifecycle, console scale, dashboards/triage), all additive, all composing existing mutators, all read-side or audit-only writes except the well-bounded force-release and portal deactivate.
- IN: Workstream D (OpenAPI 3.1 doc-of-existing + signed webhooks + Stripe adapter): the doc-of-existing half is a quick win pulled early; webhooks are a strictly read-side cron-drained outbox with zero hot-path coupling.
- IN: Workstream E (C#/.NET + Python SDKs) hard-gated on D's stable spec; ports the offline canonical-payload verifier against the existing golden vectors as the parity oracle.
- IN: Workstream G (C++ lease/seat lifecycle): the lifecycle ABI structs and orchestrator land in Phase 0, with the full transport wiring completing in Phase 3 alongside B/E pairing.
- IN: Workstream H (fuzzy/partial HW matching + relink) gated on A's per-policy knobs; verify-side MATCH_MOST and server relink both default fail-closed/OFF.
- DEFERRED to fast-follow: the SIGNED-token trial flag (A's P2, adding trial=0|1 to the lccoa1/v201 canonical), a cross-language ABI break requiring coordinated version bump + golden regen, gated separately and never inside the P1 slice. The unsigned-envelope trial flag fully expresses the clamped window via existing has_expiry/days_left/valid_to today.
- DEFERRED to fast-follow: H's offline multi-signature license GENERATION in lccgen (extern/license-generator submodule); without it MATCH_MOST is verify-only; out-of-tree generator work is scheduled after the C++ verify side proves out.
- DEFERRED to fast-follow: rolling expiry_strategy (stubbed enum, computed at activation not on verify), full device self-enrollment for portal transfer (needs a Plan-3 backend enrollment endpoint), seat/lease webhooks (usage_events lacks before/after), the bulk_import_jobs audit table if import slips, and the Paddle adapter (ship canonical Stripe + a porting doc).
- DEFERRED to fast-follow: SDK config_attestation (lcccfg1) verification, Java/Go SDKs, Recharts (inline-SVG is the deliberate zero-dep choice), the optional idx_usage_events_type_ts covering index, and any second/dedicated webhook cron trigger until a latency SLO demands it.

## Phased roadmap

### Phase 0 — Deploy the platform + land the C++ lifecycle prerequisite (nothing is consumable until both exist)

**Workstreams:** Land + deploy the operations back-office (Slice 0: admin + licensing-backend on the shared entitlements D1) on a shared integration branch, G (prerequisite half): lifecycle ABI structs + orchestrator + clock-floor host seam + legacy stub repurposing, Cross-cutting setup: migration-number registry, schema+PG+parity triple-edit discipline, shared admin design-system tokens, staged-cutover-mode helper  
**Rough effort:** large (deploy + the full G ABI surface + orchestrator is itself large; the platform-land is the gating cost)

Every downstream slice consumes either the deployed Workers (B/C/D/F/E) or the C++ ABI surface (G/E pairing). The back-office must be merged and deployed first or the consumer-facing features have no live platform. G's ABI structs (LccLeaseOptions/Status, LccSeatOptions/Status, LCC_LIFECYCLE_HTTP callback, clock-floor LOAD/STORE typedefs, new event codes) are a permanent ABI commitment that must land before SDKs (E) model the wire/token contract and before B's seat-meter has a live client. Establishing the migration-number registry and the schema/PG/parity convention here prevents the six-way 0018 collision that otherwise corrupts the whole backend track. Shared design-system tokens must exist before C/F/B build admin/portal UI or they diverge.

**Exit criteria:**

- Operations back-office merged to the integration branch and deployed; /health green on the deployed licensing-backend; admin + backend bind the same entitlements D1 with backend owning migrations
- C++ confirm_license/release_license are thin fail-closed wrappers delegating to the new orchestrator; lcc_lease_* / lcc_seat_* surface compiles; public_api_test ABI-shape assertion passes; lifecycle_orchestrator.hpp/.cpp wired into licensecc_static with lease_client/seat_client/clock_floor DECISION logic unchanged
- A migration-number registry exists assigning 0018+ uniquely across A/B/C/D/F/H; check-schema-parity.py prints 'schema parity ok' and translate.test.mjs is green on the integration branch baseline
- Staged-cutover-mode helper (mirroring ACCOUNT_TOKEN_MODE off|soft|required) factored for reuse by POLICY_STAMP_MODE / PORTAL_DEVICE_ACTIONS_MODE / ADMIN_BULK_ENABLED
- Shared admin/portal design-system tokens (classes-only, no hard-coded colors) committed for C/F/B to consume

### Phase 1 — Land the policy/trial keystone (A) - the single object every richer attribute hangs off

**Workstreams:** A: entitlement_policies template object, stampFromPolicy pure pre-step, policy_events audit, server-computed trial model, POLICY_STAMP_MODE staged cutover, A quick win: policy-editor admin UI (date-picker UX) on the shared design-system, A migrations 0018_create_entitlement_policies + 0019_create_policy_events + the first ALTER TABLE entitlements (policy_id/is_trial/trial_*)  
**Rough effort:** large

A must precede B, C, D, F, and H. It owns the first ALTER TABLE entitlements (policy_id, is_trial, trial_*) and the per-policy knob columns that H later extends, so sequencing A first prevents conflicting entitlements ALTERs between A and H. createEntitlement stays byte-identical: stampFromPolicy is a pure pre-step + extraStatements side-write, never touching the INSERT...ON CONFLICT body or ENTITLEMENT_COLUMNS, and trial_* are kept out of the public projection (same precedent as cache_ttl_seconds stripped via withId()). Trial is surfaced ONLY in the unsigned response envelope here; the signed-token field is a separately-gated fast-follow. POLICY_STAMP_MODE=off default lets it ship dark.

**Exit criteria:**

- entitlement_policies CRUD endpoints live behind Access+RBAC with the {ok,code,request_id,data} envelope, cursor pagination, Idempotency-Key reuse; validatePolicyInput/Patch reuse safeString/boundedInt/nullableEpoch
- POST /api/admin/entitlements accepts optional policy_id; stampFromPolicy produces the SAME EntitlementInput and calls createEntitlement byte-identically; absent policy_id is exact legacy behavior; 43 existing mutation tests still pass unchanged
- Backend /v1/activate stamps trial_started_at/trial_device_hash atomically and clamps valid_to to min(existing, started_at+duration); trial_device_locked (403) re-request lock enforced in required mode; from_first_use collapsed to from_first_activation for P1 (enum value retained)
- schema.sql == post-migration state byte-for-byte after normalize_sql; schema.pg.sql hand-ported (policy_id TEXT NULL no-FK parity, INTEGER booleans, CHECKs verbatim); translate.test.mjs extended and green; check-schema-parity.py green
- POLICY_STAMP_MODE off|soft|required wired; expiry_strategy ships fixed_window+non_expiring only (rolling stubbed, not on verify path); admin detail tolerates a dangling policy_id ('(deleted policy)')

### Phase 2 — A-consuming surfaces in parallel: self-serve device lifecycle, console scale, dashboards/triage, and the OpenAPI doc-of-existing quick win

**Workstreams:** B: portal self-serve device deactivate/transfer + live seat meter (depends on A), C: console pagination + bulk ops + CSV + typed-confirm dialogs + global search (depends on A), F: dashboards/analytics + operator triage + force-release (data-model-independent, parallelizable), D (quick-win half only): OpenAPI 3.1 doc-of-existing served at /openapi.json + /docs on all three Workers  
**Rough effort:** large (three large/medium workstreams in parallel + one quick-win)

Once A's envelope, projection, and migration baseline are stable, B/C/F are clean additive layers that compose existing mutators and never edit the byte-identical write path. They parallelize because they touch disjoint surfaces (B=portal Worker, C=admin batch/search/CSV orchestration, F=admin report endpoints + React charts) and share only the design-system and the migration registry. The OpenAPI doc-of-existing is pulled into this phase as a quick win because it is build-time-generated, zero-runtime-cost, and unblocks E, but the webhook/Stripe build half of D is held to Phase 3 to keep this phase additive-only. Quick wins (pagination consumption, typed-confirm modals echoing the target + reason, force-release one-click) land early. Migration arbitration is critical: B/C/F each propose 0018+; the registry assigns unique numbers (A took 0018/0019, so the rest continue from 0020) and many of these slices (F entirely, C for pagination/search/export) need NO migration at all.

**Exit criteria:**

- B: POST /api/portal/deactivate + /transfer atomic batch (revoke device, bump revocation_seq, free seats, audit row); seat meter folded into GET /api/portal/entitlements via LEFT JOIN subquery; Devices view returns status+last_seen_at; PORTAL_DEVICE_ACTIONS_MODE off default; the seat-to-device linkage fork resolved (revocation-only vs precise per-device free) and documented
- C: every list/sub-table consumes next_cursor (events route extended to honor limit+cursor); POST /entitlements/batch composes transitionEntitlement/patchEntitlement with fresh retry sub-keys (idempotency-replay footgun tested); typed-confirm modals gate every destructive verb with echoed target + mandatory reason; GET /search fan-out with prefix-indexed fingerprint search; CSV export streams via ReadableStream with row cap; createEntitlement still byte-identical
- F: GET /api/admin/report/timeseries + /expiring + POST force-release live; inline-SVG charts are structural-only (geometry unit-tested, CSS owns aesthetics); force-release is admin-only + mandatory reason + audited entitlement_events row; carried-baseline peak_concurrent correctness covered by the two-bucket real-SQLite test
- D quick-win: GET /openapi.json (build-time generated per Worker, unauthenticated) + GET /docs (pinned Scalar/Redoc, no external CDN) live on all three Workers; spec pinned to actual handlers with the build-time path/code cross-check test
- All Phase-2 migrations assigned unique numbers from the registry; schema.sql/schema.pg.sql/parity-checker triple-edit green for every slice that adds DDL (B's portal_device_actions; C's optional bulk_import_jobs if import lands)

### Phase 3 — The documented integration platform: webhooks + adapter, then the OpenAPI-gated SDKs

**Workstreams:** D (build half): signed outbound-webhook outbox + cron dispatcher + verify helper + Stripe-to-order-ingest reference adapter, E: C#/.NET + Python SDKs against the now-stable OpenAPI spec, with offline signed-token verifiers (depends on D), G (transport-wiring half): orchestrators driving the live endpoints, pairing with E  
**Rough effort:** large

E hard-depends on D: without a stable, accurate OpenAPI spec the generated HTTP client drifts from index.ts, and E must model the FLAT client-facing {ok,code,...} envelope, not the admin {ok,code,request_id,data} envelope, so D must pin the spec to the real handlers before E codegens. The webhook build half lands here (after the doc-of-existing proved the spec source in Phase 2) as a strictly read-side cron-drained transactional outbox: INSERT OR IGNORE dedup index for exactly-once-enqueue, per-tick cap + AbortController-bounded fetch, emission cron-only (any inline waitUntil emission PR must be rejected to keep UNMETERED operationally true). E ports BOTH canonical formats (lccoa1 line-framed + v201 length-framed) against the existing golden vectors as the parity oracle, handles the PKCS#1-vs-SPKI DER import asymmetry, and supports a runtime-injected trusted key mirroring the C++ override. G's transport wiring finishes pairing with E here so the C++ and non-C++ adoption stories ship together.

**Exit criteria:**

- D: webhook_endpoints + webhook_deliveries + webhook_cursor migrations land (registry-assigned numbers) with the UNIQUE dedup index; admin webhook CRUD + rotate + redrive endpoints live (secret one-time display, only secret_hmac+secret_prefix stored, lint extended to forbid secret_prefix as SQL selector); cron fan-out bounded per-tick; signed framing shared by dispatcher + verify helper; entitlement/order/customer webhooks ship (seat/lease deferred); adversarial received_at-collision dedup test passes
- D: Stripe reference adapter verifies Stripe signature, normalizes to KNOWN_INTENTS, HMAC-signs via order_hmac.mjs framing, POSTs /v1/orders; shipped as a single deployable Worker + README; Paddle ported as a doc section
- E: C#/.NET + Python SDKs wrap verify/activate/renew/checkout/heartbeat/release against the flat client envelope; offline verifiers pass byte-parity against BOTH lccoa1 and v201 golden vector sets; PKCS#1/SPKI import correctness covered by the signature-parity test; request_proof passed through opaquely (SDK does not mint device keys); documented compatibility matrix vs {spec version, token format, embedded key-id set}; loud docs that anti-tamper/HW-fingerprinting stays C++-only
- G transport wiring complete: lcc_lease_acquire/renew/release + lcc_seat_checkout/heartbeat/release drive the live endpoints via LCC_LIFECYCLE_HTTP; seat-token returns verified by the EXISTING online_verification verify_assertion_envelope (no new verify code); lease durable write gated by should_replace_lease then host STORE; all under the no-throw C-ABI guard

### Phase 4 — Hardware-reliability: policy-gated fuzzy/partial matching + server relink reconciliation

**Workstreams:** H: offline MATCH_MOST (verify-side N-of-M signature set) + online /v1/relink reconciliation (depends on A), Fast-follow scheduling: lccgen multi-signature license GENERATION (extern/license-generator submodule) to make MATCH_MOST usable end-to-end  
**Rough effort:** large (verify-side + relink is large; generator fast-follow is additional)

H depends on A's per-policy knobs (match_strategy/match_min_components/relink_window_sec/max_relinks_per_window are policy-owned columns) and must extend the SAME entitlements table A first ALTERed, so sequencing H last avoids any conflicting entitlements migration with A and lets H add its knob columns ONLY through setEntitlementCapacity/CAPACITY_COLUMNS (disjoint from the byte-identical createEntitlement body). It is placed last because: it is the lowest-frequency adoption need, it introduces a NEW license-format surface (the v201 multi-signature canonical) whose generator side lives in an out-of-tree submodule and is itself deferred, and MATCH_MOST deliberately lowers the binding bar (defaults fail-closed: match_min_components=0 disabled, max_relinks_per_window=0 relink OFF). The server relink decision is a single atomic SQL (copy of LEASE_ISSUANCE_ATOMIC_SQL, no TOCTOU) with a per-operation RELINK_PROOF_PURPOSE so a verify/lease proof is not replayable. The C++ side is additive enum + a verify-only validate_pc_signature_set over DefaultStrategy::alternative_ids(), no new component strategies, no ABI struct change.

**Exit criteria:**

- H migration (registry-assigned) lands: entitlements knob columns via setEntitlementCapacity/CAPACITY_COLUMNS (createEntitlement byte-identical); entitlement_fingerprints + relink_events tables with FK-to-entitlements and retention indexes; schema.sql/schema.pg.sql/parity triple green; relink_events + retired fingerprints swept by scheduled() cron
- POST /v1/relink: single atomic SQL gated by max_relinks_per_window with EXISTS(active+within-validity+new_device_hash in fingerprints), guarded entitlements.device_hash UPDATE + audit row in one batch; RELINK_PROOF_PURPOSE device-proof gate; codes relink_ok/denied_rate/denied_policy/denied_unseen/relink_disabled; 200 ok:false for policy denials, 500 only on store failure (fail-closed)
- /v1/verify gains ONLY the fourth accept path (device_hash present in active fingerprints), gated behind max_relinks_per_window>0 so inert for non-opted entitlements; removes no existing check
- C++ verify side: STRATEGY_MATCH_MOST enum + client-signatures/client-signature-match canonical keys folded into v201_fields_for() so the whole set is SIGNED; validate_pc_signature_set returns LICENSE_OK iff matched>=min_match with per-token weak-source/IP/env policy still failing closed; single-signature exact path unchanged; relink_client.hpp pure decision unit-tested like decide_action()
- lccgen multi-signature generation scheduled as the explicit fast-follow that makes MATCH_MOST usable by real licenses; coordinated golden-vector regen for the multi-signature canonical

## Dependency graph

- **Phase 0 (deploy + G ABI) -> ALL consumer-facing workstreams (A,B,C,D,E,F,G,H)** — Nothing is consumable until the back-office is landed/deployed on the shared branch, and the C++ adoption story (G's ABI) must exist before SDKs model the contract and before B's seat-meter has a live client.
- **A -> B** — B's self-serve device lifecycle and trial-aware seat meter depend on A's entitlement_policies/trial columns and the stable envelope/projection; A also owns the first ALTER TABLE entitlements B reads.
- **A -> C** — C's batch/CSV/search compose A's (potentially new) exported mutators and the envelope/MutationContext shape; if A relocates the shared mutation module or changes exports, C must coordinate, so A-first makes C a clean additive layer.
- **A -> D** — D's OpenAPI spec and webhook before/after payloads must describe A's stabilized endpoints and policy/trial response fields; documenting an unstable contract guarantees drift.
- **A -> F** — Soft edge: F is data-model-independent but renders policy/trial badges and shares the design-system and migration registry; F parallelizes with B/C after A but must not conflict on migration numbers.
- **A -> H** — H's match_strategy/match_min_components/relink_window_sec/max_relinks_per_window are A-owned per-policy knobs, and H must ALTER the SAME entitlements table A first ALTERed; conflicting entitlements migrations are avoided only by A-before-H.
- **D -> E** — Hard dependency: the SDKs are generated/pinned against D's OpenAPI spec; without a stable spec modeling the FLAT client-facing envelope (not the admin envelope), codegen drifts from index.ts and produces wrong response models.
- **G (ABI, Phase 0) -> G (transport wiring, Phase 3)** — The permanent ABI structs/callback must be frozen before the orchestrator wires the live endpoints, and the wiring pairs with E so the C++ and non-C++ adoption stories ship together.
- **signed_token/online_verification core -> G and E** — G must not fork the lccoa1 envelope verify the seat path reuses; E ports the same canonical-payload discipline; both consume the shared signed-token core as the parity oracle.
- **lccgen multi-signature generation (fast-follow) -> H end-to-end usability** — MATCH_MOST is verify-only until the out-of-tree generator emits multi-signature licenses; the submodule work gates real-license adoption but not the C++ verify-side landing.

## Cross-cutting concerns

- Migration-number arbitration: A,B,C,D,F,H each independently propose migration 0018 and two (A,H) both ALTER TABLE entitlements. A single owner must maintain a migration-number registry assigning unique 0018+ numbers across the whole program and enforce that A's entitlements ALTER lands before H's. This is the single most error-prone cross-cutting concern and is established in Phase 0.
- Schema evolution + PG parity + parity-checker triple-edit: every backend migration requires a same-PR edit to migrations/, schema.sql (byte-exact post-state after normalize_sql, IF NOT EXISTS stripped), supabase-postgres/schema.pg.sql (INTEGER->BIGINT for epochs, AUTOINCREMENT->GENERATED ALWAYS AS IDENTITY, CHECKs verbatim, no-FK parity where SQLite omits it), and translate.test.mjs coverage. check-schema-parity.py must print 'schema parity ok' AND translate.test.mjs must stay green per PR. The parity script only enforces SQLite migrations-vs-schema.sql, NOT PG, so a PG-smoke assertion must be added to each migration's test plan or the Postgres mirror silently rots.
- Byte-identical shared mutation module: createEntitlement's INSERT...ON CONFLICT body and ENTITLEMENT_COLUMNS must never drift; order_ingest.mjs:buildCreateStatement mirrors the column list verbatim and 43 admin tests assert the exact write. ALL new behavior (stampFromPolicy pre-step, bulk orchestration, capacity columns) is added in separate functions or via CAPACITY_COLUMNS/extraStatements, never by editing the existing mutators. A reviewer must reject any bulkCreate fast-path or trial-column-in-ENTITLEMENT_COLUMNS PR.
- Staged off->soft->required cutover modes: every new write surface ships dark behind a mode gate mirroring ACCOUNT_TOKEN_MODE/REQUEST_SIGNATURE_MODE: POLICY_STAMP_MODE (A), PORTAL_DEVICE_ACTIONS_MODE (B), ADMIN_BULK_ENABLED (C, optional), webhook enable (D), max_relinks_per_window=0 OFF default (H). A shared mode-helper factored in Phase 0 keeps semantics identical across slices.
- Shared admin design-system: C/F/B build admin and portal UI; the inline-SVG charts (F), typed-confirm modals (C), and portal device views (B) must use classes-only design tokens (no hard-coded colors, geometry unit-tested, CSS owns aesthetics) committed in Phase 0 so the surfaces do not visually diverge. The deliberate no-charting-dependency choice (inline SVG, not Recharts) is documented to prevent bundle creep.
- Fail-closed posture everywhere: trial_device_locked, relink defaults OFF, force-release admin-only+reason+audit, webhook emission cron-only (never inline/UNMETERED-breaking), SDK verifiers return typed reject never raw throw, C++ orchestrator under the no-throw C-ABI guard, clock-floor fail-closed-on-load-failure modeled byte-for-byte on call_revocation_floor_load/store. Any accept-path widening (H's /v1/verify fourth path) only adds, never removes, and is gated behind opt-in.
- Signed-token ABI discipline: the two genuinely cross-language ABI changes (A's trial-in-token and H's MATCH_MOST multi-signature canonical) are positionally/field-named parsed by C++ with golden vectors. Both are deferred behind a coordinated version bump + golden-vector regen and NEVER bundled into a feature slice; the unsigned-envelope trial flag and the verify-only MATCH_MOST land first.
- Deploy/land prerequisite (Phase 0): the operations back-office must be merged and deployed on a shared integration branch before any consumer slice, and all subsequent workstreams branch from and merge back to that shared branch to avoid migration/schema divergence across long-lived feature branches.

## Sequencing rationale

The order is dictated by three real constraints, in priority order. First, consumability: nothing downstream means anything until the platform is deployed and the C++ lifecycle ABI exists, so Phase 0 is land+deploy + G's ABI structs/orchestrator, a prerequisite not a feature. Second, the A keystone: A owns the entitlement_policies template, stampFromPolicy, the first ALTER TABLE entitlements, and the per-policy knobs (trial, named-user, metering, and H's match_*/relink_*), so A must land before B/C/D/F (which depend on its envelope/projection stability) and before H (which extends the same table and consumes its knobs). Putting A second prevents the conflicting-entitlements-ALTER hazard between A and H and gives the other five backend workstreams a stable additive base. Third, the OpenAPI->SDK chain: D's spec gates E's codegen because the SDKs must model the actual handlers and the flat client envelope, so the OpenAPI doc-of-existing is pulled early as a Phase-2 quick win (build-time, zero-cost, additive) while the webhook/adapter build and the SDKs themselves land in Phase 3 once the spec is proven stable. Within phases, quick wins are pulled forward: pagination consumption, typed-confirm dialogs, force-release, and OpenAPI-doc-of-existing all land in Phase 2 so operator value arrives before the large builds complete. H is last because it is the lowest-frequency need, introduces a new license-format surface whose generator side is out-of-tree and deferred, and its binding-bar-lowering defaults must be fail-closed/OFF. G is split across Phase 0 (the permanent ABI commitment, which must freeze early) and Phase 3 (transport wiring paired with E) so the C++ and non-C++ adoption stories ship together. Genuinely independent work (F is data-model-independent; B/C/F touch disjoint surfaces) is parallelized inside Phase 2 to compress the critical path, bounded only by the shared design-system and the migration registry.

## Top risks

- Migration-number collision and conflicting entitlements ALTERs: six workstreams independently claim 0018 and A+H both ALTER entitlements. Without the Phase-0 registry + A-before-H ordering, two long-lived branches corrupt schema.sql and the parity checker. Mitigation: single migration-number owner, A's entitlements ALTER lands first, H adds knobs only via CAPACITY_COLUMNS.
- Drift of the byte-identical createEntitlement / order_ingest mirror: any edit to the INSERT...ON CONFLICT body or ENTITLEMENT_COLUMNS breaks exactly-once fulfillment and the 43 mutation tests. Highest-blast-radius landmine. Mitigation: stampFromPolicy is a pure pre-step + side-write; bulk composes existing mutators in a separate module; trial/capacity columns kept out of the public projection.
- PG parity silently rotting: check-schema-parity.py enforces only SQLite migrations-vs-schema.sql, not the Postgres mirror, so a forgotten schema.pg.sql/translate.test.mjs edit ships a broken PG port undetected. Mitigation: mandatory PG-smoke assertion in every migration's test plan; triple-edit discipline as a PR gate.
- OpenAPI spec drift gating bad SDK codegen: if D models the wrong envelope (admin {ok,code,request_id,data} vs the flat client-facing {ok,code,...}) or a hand-maintained spec rots, E generates wrong response models against index.ts. Mitigation: pin the spec to actual handlers with a build-time path/code cross-check test; snapshot real responses; the doc-of-existing lands and is validated in Phase 2 before E codegens in Phase 3.
- Cron budget + subrequest limits for webhooks: adding bounded-fetch fan-out to the already-busy 5-min scheduled() tick can exceed wall-clock/subrequest budgets at backlog. Mitigation: per-tick cap, AbortController timeouts, enqueue (cheap D1) separated from send, emission cron-only (reject any inline waitUntil emission PR to keep UNMETERED true); a dedicated webhook trigger only if a latency SLO demands it.
- Cross-language signed-token ABI breaks rushed into a slice: appending trial (A) or the multi-signature set (H) to the positionally/field-named lccoa1/v201 canonical without a coordinated version bump + golden regen silently breaks C++ verifiers and SDK parity. Mitigation: both deferred behind gated version bumps; unsigned-envelope trial and verify-only MATCH_MOST land first.
- MATCH_MOST lowers the binding bar and H's generator is out-of-tree: N<M lets a partially-cloned machine pass, and real licenses cannot use MATCH_MOST until the lccgen submodule emits multi-signature licenses. Mitigation: match_min_components=0 (disabled) and max_relinks_per_window=0 (relink OFF) fail-closed defaults; weak-source tokens excluded from N; generator work scheduled as an explicit fast-follow after the verify side proves out.
- Seat-to-device linkage ambiguity in B: seat_checkouts is keyed by client_instance_id with no device_key_id, so 'free THIS device's seat' on deactivate cannot be done precisely, a genuine product/architecture fork (add a hot-path column vs join through usage_events vs rely on revocation_seq+grace lapse). Mitigation: resolve the fork in Phase 2 with a default of revocation-only reclaim (simplest, T7-correct) unless precise per-device free is required; this is a human-only product call.
- G ABI surface-creep: the lifecycle structs are a permanent ABI commitment; a wrong field layout is expensive to revise and the transport-callback shape (one unified LCC_LIFECYCLE_HTTP vs two callbacks; whether the library owns file I/O) is a genuine ergonomics fork affecting SDK pairing. Mitigation: copy the LccLicenseDecisionOptions size/version/reserved discipline exactly, add a public_api_test ABI-shape assertion in Phase 0, and treat the callback-count and persistence-ownership questions as human-only forks resolved before the ABI freezes.

---

# Workstream designs (detailed)

_Each section is a buildable design grounded in the real files; phase + effort + dependencies are noted per the synthesis above._

<!-- A — License-policy/template object + Trial model (keystone) | phase_suggestion=P1 effort=large depends_on= -->

## Workstream A — License-policy/template object + Trial model (keystone)

> **STATUS — DONE (2026-06-29), commits `04ecb80` (Stage 1+2) + `4ee669f` (Stage 3-5), pushed to lyehe.**
> Migrations 0018/0019 (entitlement_policies + policy_events + frozen trial columns on entitlements;
> parity green, PG ported); `stampFromPolicy`/`buildPolicyStampStatement` riding `createEntitlement`'s
> extraStatements seam (INSERT byte-identical, 218/+50 tests unchanged); admin policy CRUD +
> create-from-policy gated by `POLICY_STAMP_MODE=off|on`; server-computed `/v1/activate` trial timing
> (write-once stamp atomic with the cap-insert, device-lock fail-closed, valid_to clamp); admin Policies
> tab + pick-policy-then-override create with date pickers. Forks resolved as: proven-device_key_id-else-
> device_hash lock + opt-in `trial_require_device_proof`; frozen stamp-time policies; from_first_use→
> from_first_activation in P1; UNIQUE(project, lower(name)). Stage 4 adversarially reviewed clean.
> Follow-ups: the signed-token `trial` field (P2 ABI), and confirming the live-D1 UNIQUE error wording
> for the 409 name-conflict (degrades to 500 otherwise; dup still rejected).

### Goal
Turn the flat `entitlements` row (operators hand-type epoch TTLs) into a reusable **policy/template** object — Trial, Node-locked, Floating, Subscription — that stamps default windows and capacity into new entitlements, plus a server-computed **trial model** (`from_issue | from_first_activation | from_first_use`) with a device re-request lock. This is the foundation later attributes (named-user, metering, maintenance windows) hang off.

### Design
A new `entitlement_policies` table holds the template; `entitlements` gains an advisory `policy_id` plus frozen `is_trial`/`trial_*` columns. On create, the admin Worker loads the policy and runs a **pure** `stampFromPolicy(policy, overrides, now)` that emits the **existing** `EntitlementInput` shape — so `createEntitlement` (and its byte-identical mirror in `order_ingest.mjs:buildCreateStatement`) is unchanged. The `is_trial`/`trial_*` side-write rides the `writeEntitlementWithAudit(extraStatements)` seam (the same atomic mechanism order-ingest already uses), never the shared `INSERT...ON CONFLICT` column list or `ENTITLEMENT_COLUMNS`. Trial timing is computed **server-side** inside `handleLeaseIssue`'s atomic `atomicLeaseIssuance` batch: first activation of a `from_first_activation`/`from_first_use` trial stamps `trial_started_at=now` write-once (`WHERE trial_started_at IS NULL`) and clamps `valid_to` to `trial_started_at + trial_duration_sec`; `clock_floor.hpp` already fails closed on rollback so the trial clock can't be extended locally.

### Data model
Migration `0018_create_entitlement_policies.sql`: the policies table (id, project, name, type CHECK in (trial,node_locked,floating,subscription), default offset/duration/ttl/capacity columns, `expiry_strategy`, `trial_expiration_basis`, `trial_duration_sec`, `trial_one_per_device`) + `ALTER TABLE entitlements ADD COLUMN policy_id/is_trial/trial_expiration_basis/trial_duration_sec/trial_started_at/trial_device_hash` (all nullable/defaulted, append-only like 0010/0014). Migration `0019_create_policy_events.sql`: append-only audit mirroring `entitlement_events`. `policy_id` has **no FK** (D1/SQLite + order-ingest must never break; integrity is enforced in code). Trial columns are deliberately **excluded** from `ENTITLEMENT_COLUMNS` (read by dedicated SELECTs, same precedent as `cache_ttl_seconds`). Update `schema.sql` to the exact post-migration state (`check-schema-parity.py` diffs object-by-object) and hand-port to `supabase-postgres/schema.pg.sql` (+ `translate.test.mjs`).

### API
Admin (Access JWT + RBAC, `{ok,code,request_id,data}`, cursor pagination, Idempotency-Key): `POST/PATCH /api/admin/policies(/:id)`, `POST /api/admin/policies/:id/(disable|reenable)`, `GET /api/admin/policies(/:id)`. `POST /api/admin/entitlements` gains optional `policy_id` + per-field overrides; absent => current behavior. Backend `POST /v1/activate` stamps trial timing and returns **unsigned** `trial`/`trial_expires_at_epoch` in the response envelope; a different device on a `one_per_device` trial => `403 trial_device_locked`. New gate `POLICY_STAMP_MODE=off|soft|required` (default off) mirrors `ACCOUNT_TOKEN_MODE`/`REQUEST_SIGNATURE_MODE`.

### UI
New Policies tab in `main.tsx`: list + Policy Editor (type select, duration/offset as quantity+unit pickers, capacity, expiry_strategy, a Trial sub-panel gated on `type==='trial'`), disable/reenable with required reason. Create-entitlement upgraded to **pick-policy-then-override**; the raw epoch `Valid from/until` inputs (`main.tsx:473-474`,`:525-526`) become `<input type=date>`/`datetime-local` converted to epoch on submit. `shared/api.ts` gains `Policy`/`PolicyInput`/`PolicyPatch` and optional entitlement trial fields.

### C++
P1: zero ABI change — trial is surfaced in the unsigned HTTP response; `LicenseInfo.has_expiry/days_left/expiry_date` already express the clamped window, and `lease_client.hpp:decide_action` drives offline tolerance off `valid_to`. P2 (gated): optionally append a `trial` field to the lccoa1 + v201 canonical payloads with a coordinated version bump and golden-vector regen (`test/lease-sign.test.mjs`), surfacing `LicenseInfo.is_trial`. Do **not** do P2 inside P1.

### Security
Fail-closed throughout: `stampFromPolicy` is pure and keeps `createEntitlement` byte-identical; trial timestamps are write-once and server-only; the device lock and trial clamp bound trial farming alongside existing `/v1/activate` rate limiting; the verify/lease hot path **never joins** policies (no added latency/failure mode); `POLICY_STAMP_MODE` default off gives a reversible, observable cutover.

### Tests
Real-SQLite (`node:sqlite`, DB from migrations like `seat-pool.test.mjs`): byte-identical-create guard, trial activation matrix (basis variants, write-once idempotency, device lock, rollback), order-ingest-over-a-trial-row preserving `trial_*`. Hermetic unit for validators/override-merge/purity. Gates: `schema:parity`, `test:pg`, lint, admin worker/UI RBAC tests.

### Effort / Dependencies / Risks
Large; no hard dependency on other workstreams (it is the keystone others build on). Top risk is drift in the shared mutator — mitigated by the pure-prestep + extraStatements pattern and re-running the existing mutation/order-ingest suites unchanged.

**Open decisions (need product sign-off):**

- expiration_basis from_first_use vs from_first_activation: 'first use' implies a client-reported signal distinct from server-side activation. Is there a product distinction, or should from_first_use be an alias of from_first_activation for P1 (server only sees activation)? Recommend: collapse to from_first_activation in P1, keep the enum value for a future client-reported-use channel.
- Should the trial device-lock key on the self-asserted device_hash (spoofable) or the cryptographically-proven ECDSA device_key_id (entitlement_devices, relay-resistant)? device_key_id is far stronger but requires the device-proof path to be active. Recommend device_key_id when a proof is present, else device_hash, with a policy flag trial_require_device_proof.
- Do we want per-project policy uniqueness on name (UNIQUE(project,name)) to prevent operator confusion, or allow duplicates? Leaning UNIQUE(project, lower(name)) like idx_customers_email.
- Should disabling a policy retroactively affect entitlements stamped from it (it does NOT in this design — stamped values are frozen)? Confirm this is the intended product semantics vs a 'live template' expectation.

---

<!-- B — Self-serve device deactivation / transfer + seat meter in the customer portal | phase_suggestion=P1 effort=medium depends_on=A -->

## Workstream B — Self-serve device deactivation / transfer + seat meter (customer portal)

### Goal
Eliminate the #1 support ticket ("new laptop") by letting a signed-in customer, in the portal, (1) **deactivate** one of their own devices, (2) **transfer** a license "deactivate-here -> activate-there", and (3) see a live **seat meter** (N of M in use, K overdraft) and a **Devices** view with last-seen. No operator, and the portal **never holds a signing key**.

### Design
The portal already binds the SAME D1 as the backend and already performs a privileged owned-state write (logout bumps `account_token_revocations.revocation_seq`, `src/worker/index.ts` ~L279). Deactivation is the same privilege envelope: a **direct, owned, atomic D1 write**, no token mint.

Deactivate flow (`POST /api/portal/deactivate`, body `{project, feature, device_key_id}`):
1. `isCrossSite` gate -> `authSession` (session-derived `customer_id` only) -> `resolveOwnedFingerprint(env, session.customer_id, project, feature)` (existing; 0 rows -> generic `not_found`, no oracle).
2. `resolveOwnedDevice` (NEW): the `device_key_id` must belong to that owned entitlement; foreign/unknown -> same generic `not_found`.
3. **One `env.DB.batch`** of four statements: `UPDATE entitlement_devices SET status='revoked'`; bump `entitlements.revocation_seq` using the exact monotonic `REVOCATION_SEQ_BUMP`/`nextExistingRevocationSeqSql` form (re-derive floor from `entitlement_events` MAX, +1); free this device's live `seat_checkouts`; insert a `portal_device_actions` audit row. `env.DB.batch === undefined` -> throw `write_failed` (fail-closed; never two un-transactioned writes — mirrors `writeEntitlementWithAudit`).

**Enforcement is the backend's existing machinery, unchanged**: the revoked device fails `checkDeviceProof` (`device.status !== 'active'` -> `disabled_device`), and the bumped `revocation_seq` makes the old device's in-flight `lccoa1` seat/assertion token fail the C++ `online_verification` revocation-seq floor on its next online check — dead within one grace window (T7). The reference `seat_client.hpp` already models this (`Reclaimed -> Checkout/RefuseNoSeat`).

Transfer (`POST /api/portal/transfer`) = deactivate(from) + promote(to: disabled->active) **in one batch** so the device-count cap is never transiently exceeded; an unregistered `to` device -> `409 transfer_target_unregistered` (atomic rollback). The portal cannot create a device key (no signing key), so "activate-there" P0 = promote an already-uploaded device.

Seat meter: fold into the EXISTING `GET /api/portal/entitlements` (no extra round-trip) — extend `apiEntitlements` to carry `live_seats` (`COUNT(*) FROM seat_checkouts WHERE tuple AND heartbeat_deadline > now`), `pool_size`, `allow_overdraft`, `overdraft_in_use = max(0, live - pool_size)`. `pool_size=0` -> "Floating disabled".

### Data model
New migration `0018_create_portal_device_actions.sql` (latest is 0017) — append-only audit table, **no column changes** (kill-switch columns already exist: `entitlement_devices.status`/`last_seen_at` 0008, `entitlements.revocation_seq` 0001, `seat_checkouts.heartbeat_deadline` 0011). Columns: `id, customer_id (FK customers ON DELETE CASCADE), project, feature, license_fingerprint, action CHECK IN ('deactivate','transfer'), device_key_id, to_device_key_id, seats_freed, revocation_seq, request_id, created_at` + two indexes. Mirror byte-identically into `schema.sql` (so `check-schema-parity.py` passes) and hand-port into `supabase-postgres/schema.pg.sql` (`created_at BIGINT`, after `customer_events`).

### API
`POST /api/portal/deactivate`, `POST /api/portal/transfer` (envelope `{ok,code,request_id,data}`); extend `GET /api/portal/entitlements` (seat meter fields) and `GET /api/portal/devices` (status + last_seen_at); extend `apiMe` with `device_actions_mode`. **No backend endpoint change.** Staged `PORTAL_DEVICE_ACTIONS_MODE = off|soft|required` (default off), mirroring `ACCOUNT_TOKEN_MODE`.

### UI (`src/ui/main.tsx`, `portalWorkflow.ts`, `styles.css`)
Devices tab gains Status + Last-seen columns and a Deactivate button (confirm dialog, ~15 min warning). Real per-entitlement seat meter (proportional bar, overdraft chip). Transfer flow listing customer devices. Pure `seatMeter()` formatter + `deactivatePath()`/`transferPath()` builders (unit-testable, no React).

### C++
None.

### Security
Server-resolve fingerprint AND device ownership (`customer_id=session.customer_id`); foreign/unknown -> generic `not_found` (no IDOR oracle). Atomic batch, fail-closed. Monotonic `revocation_seq` bump (can never decrease). `isCrossSite` CSRF gate. Per-customer rate limit (`rate_limit_counters`, namespace `portal-device-action`) to bound churn. Revoked entitlement is terminal (no resurrection). Default-off cutover.

### Tests
Extend the real-SQLite `portal-worker.test.mjs` IDOR matrix (A vs B), seat-meter correctness (live vs lapsed, overdraft), transfer atomicity, staged-mode, cross-site, `batch`-undefined fail-closed. Backend integration: freed seat -> `410 seat_reclaimed`, revoked device -> `disabled_device`, stale-`revocation_seq` lccoa1 rejected. Pure-formatter unit tests. CI: `check-schema-parity.py` + PG smoke asserting `portal_device_actions`.

### Effort: medium. Dependencies: Workstream A (shared mutation/extraction discipline) for reusing `REVOCATION_SEQ_BUMP`. 

### Risks
Seats keyed by `client_instance_id` not `device_key_id` (precise per-device seat free is the core fork); `last_seen_at` only written on device-proof; full self-enrollment needs a backend endpoint (P0 promotes already-uploaded device); PG parity not auto-enforced.

**Open decisions (need product sign-off):**

- Seat-to-device linkage: seat_checkouts is keyed by client_instance_id with no device_key_id column. To free 'this device's' seat on deactivate we either (a) add a device_key_id column to seat_checkouts (schema change to a hot-path table) and bind it at checkout, (b) join through usage_events.device_key_id (best-effort, only populated when a proof was present), or (c) rely solely on the revocation_seq bump + grace lapse (no precise seat free, simplest). Which model — precise per-device seat free (a/b) vs. revocation-only (c)? This is the core product/architecture fork.
- Transfer 'activate-there' semantics: does the new laptop self-enroll its own ECDSA device key (requires a new backend enrollment endpoint, since the portal holds no signing key) — or does transfer only promote a device the customer already uploaded via the CLI/backend (status disabled->active)? The latter is shippable now; the former needs a Plan-3-style backend endpoint and a workstream dependency.
- Should deactivate REVOKE (terminal) or DISABLE the entitlement_devices row? Revoke is terminal and matches 'this laptop is gone'; disable is reversible ('temporarily'). Revoke aligns with the support-ticket intent but forbids re-adding the same key id later (the ON CONFLICT in device-upsert would resurrect it via admin only). Recommend revoke for deactivate, but confirm.
- Does last_seen_at need a new writer (e.g. update it on every /v1/heartbeat and /v1/verify with a proof) so the Devices view is meaningful for floating customers? That is a small backend change with hot-path cost; in scope for this workstream or deferred?

---

<!-- C — Operator console scale: pagination + bulk ops + CSV + confirm dialogs + global search | phase_suggestion=P1 effort=large depends_on=A -->

## Workstream C — Operator console scale: pagination, bulk ops, CSV, confirm dialogs, global search

### Goal
The admin SPA (`services/cloudflare-license-admin`) is first-page-only, has no bulk lifecycle ops, no CSV in/out, fires destructive Revoke on a single click, and offers no cross-resource search. This workstream makes the console usable at fleet scale without touching the C++ verifier or the byte-identical entitlement write path.

### Design

**1. Pagination (no schema change).** Every list route already clamps `limit` (`min(n,100)`) and returns `next_cursor` using an OFFSET-cursor scheme (`listEntitlements`/`listCustomers`/`listLicenses`/`listOrders` in `src/worker/index.ts`). The bug is purely client-side: `main.tsx` destructures `next_cursor` and discards it (≈lines 263, 284). Fix: (a) make `listEvents` honor `?limit`/`?cursor` and return `next_cursor` (today it ignores both); (b) add a generic `<Pager>` (Load-more + result count + a cursor stack for Prev/Next) and wire it into entitlements, events, customers, licenses, orders, and the customer-detail sub-tables (which hard-cap at `LIMIT 100–200` and silently drop overflow).

**2. Bulk endpoint — reuse, never re-implement.** `POST /api/admin/entitlements/batch` (admin-only). Body `{action, reason?, items:[{id, patch?}]}`, ≤200 items, dedicated `MAX_BATCH_BODY_BYTES=65536`. Processing is a thin loop in the admin Worker (or a new `entitlements/bulk.mjs` that only *composes* existing functions) calling the unchanged `transitionEntitlement`/`patchEntitlement` per row. Each row is its own atomic `env.DB.batch([write, event, idempotency])` so the "no row persists without its audit event" invariant from `writeEntitlementWithAudit` is preserved and per-row failures (`revoked_terminal`) are isolated and reported. `createEntitlement` and the other `entitlement_mutation.mjs` exports stay byte-identical (CLAUDE.md rule). Per-row idempotency sub-key = `envelopeKey + ':' + entitlementId` for exactly-once replay. Response carries `{results:[{id, ok, code, status, revocation_seq}], applied, failed, skipped}`; returns 200 even on partial failure.

**3. Typed-confirm modal.** Replace the one-click Revoke/Disable openers (`main.tsx` ≈line 516) with a `<ConfirmDialog>` that echoes the target(s) ("Revoke 7 entitlements" / "Revoke DEFAULT/DEFAULT/a1b2…"), requires a reason, and requires typing a match token (`REVOKE` or the short fingerprint). Server stays the source of truth: `reason_required` (400) already enforced; the modal is friction, not security.

**4. CSV.** Export: `GET /api/admin/export/{entitlements|customers|events}.csv?<list-filters>` streams `text/csv` with an attachment header; server iterates the same filtered query in cursor pages, caps total rows (~50000) then truncates, RFC4180-quotes, and reuses `getCustomer`'s secret deny-list so `token_hmac`/`pepper_key_id`/`raw_payload` never appear. Import: UI parses CSV client-side to `rows[]`, POSTs `mode=dry_run` first (validates each row through the SAME `validateEntitlementInput`, writes nothing, flags create-vs-update), then `mode=commit` with an Idempotency-Key reusing `createEntitlement` per row.

**5. Global search.** `GET /api/admin/search?q=&limit=` (reader+admin) fans out — customers (`id|email|name|external_ref` LIKE), licenses (`id|label` LIKE), entitlements (`license_fingerprint` *prefix* `q%` to hit the PK index), orders (`subscription_id`). Each branch `LIMIT 5` (max 20). Reuses the existing `likeContains()` escaper. Returns `{results:[{type, id, label, sublabel, deep_link}]}`; the SPA turns deep-links into `setActiveTab` + filter/selection.

### Data model
No DDL for pagination/search/export/bulk/confirm. One optional migration `0018_create_bulk_import_jobs.sql` (kind/actor/mode/total/applied/failed/summary_json/created_at, CHECK on kind+mode+actor_type mirroring `customer_events`) to record import runs; mirror into `schema.sql` (parity-stripped) and `supabase-postgres/schema.pg.sql` (BIGINT epochs). `check-schema-parity.py` must print "schema parity ok"; `translate.test.mjs` green. If import slips to P2, this migration is skipped.

### API
- Extend `GET …/events` to honor cursor; all other lists already paginate.
- `POST /api/admin/entitlements/batch` (admin) — per-row results, idempotent.
- `GET /api/admin/search` (reader+admin) — typed deep-links.
- `GET /api/admin/export/{kind}.csv` (reader+admin).
- `POST /api/admin/import/entitlements?mode=dry_run|commit` (admin).

### C++ / UI
C++: none. UI: `<Pager>`, multi-select + sticky bulk bar + results drawer with "Retry failed", `<ConfirmDialog>`, topbar search dropdown, per-tab Export/Import buttons; new `.modal/.checkbox/.searchResults` rules in the hand-rolled `styles.css` (no new deps).

### Security
Per-row atomic batches (not one mega-transaction) keep the audit invariant and enable partial-failure reporting. RBAC: all writes `requireAdmin`, reader read-only (mirror the Slice 4 reader test). Secret deny-list on export/search. "Retry failed" mints a FRESH idempotency key (reusing it replays the stored partial response — a real footgun, tested). Bounds: batch ≤200, import ≤500, search branches ≤20, export ≤50000, all `q` `safeString(128)` + LIKE-escaped, entitlement search uses prefix not leading wildcard. Optional `ADMIN_BULK_ENABLED` flag to ship the new write surface "off" to prod first.

### Tests
Real-SQLite `test/sql/bulk-and-search.test.mjs` (D1Like over `node:sqlite`, migrations-seeded, through `worker.fetch`): bulk disable flips all + writes events; revoked sibling fails in isolation; missing reason → 400 + zero writes; envelope replay → `x-idempotent-replay`, no dup events; reader → 403, DB unchanged. Search matrix incl. LIKE-escape + over-long q. CSV export asserts seeded `TOKEN_HMAC_SECRET` never appears + RFC4180 quoting + truncation marker. Import dry-run writes nothing; commit creates via `createEntitlement`; replay is a no-op. Pure-function tests via the `operatorWorkflow.ts` transpile harness for path builders, cursor stack, CSV parser, sub-key derivation. Gate on `check-schema-parity.py` + `translate.test.mjs`. Adversarial: 201-item batch, 501-row import, oversize body (413), NUL/newline in q (400).

### Effort / dependencies / risks
Large. Depends on Workstream A only if A relocates the shared mutation module or changes the `{ok,code,request_id,data}` envelope / `MutationContext`; otherwise cleanly additive. Key risks: the per-row-vs-mega-batch atomicity decision, the retry-idempotency footgun, prefix-only entitlement search UX, and CSV import's upsert (create-vs-update) ambiguity — all surfaced as open questions and mitigations above.

**Open decisions (need product sign-off):**

- CSV import semantics: should an import row that matches an existing entitlement key UPDATE it (current createEntitlement upsert behavior) or be rejected as a conflict? This is a genuine product fork — 'import = provision new only' vs 'import = declarative sync'. Recommend dry-run-flags-create-vs-update + default to update-allowed, but confirm.
- Should bulk ops extend beyond entitlements to customers (bulk disable customers = bulk kill-switch) and account_tokens (bulk revoke) in this workstream, or stay entitlement-only for v1? Bulk customer-disable is high-blast-radius (severs auth) and may warrant its own slice.
- Search scope: should GET /api/admin/search also fan out to account_tokens by token_prefix and to the audit log (entitlement_events/customer_events) by request_id? The prompt names 4 resource types; adding tokens/audit is a natural extension but widens the surface.
- Is the bulk_import_jobs audit table worth the schema cost, or is per-row entitlement_events sufficient (the import is reconstructable by grouping events on request_id)? Leaning toward keeping it for a clean 'who imported this batch' record, but it could be dropped to avoid a migration if import ships in P2.
- Does the org want a feature flag (ADMIN_BULK_ENABLED) to ship the batch/import write surface to prod 'off' first, mirroring the off->soft->required cutover philosophy, or are operator-initiated UI writes low-risk enough to ship on?

---

<!-- WORKSTREAM D — Integration surface: OpenAPI 3.1 spec + signed outbound webhooks + Stripe/Paddle adapter recipe | phase_suggestion=P1 effort=large depends_on=A -->

## Workstream D — Integration Surface: OpenAPI 3.1, Signed Outbound Webhooks, Commerce Adapter

### Goal
Promote the three Workers from an undocumented private REST contract to a documented, integrable platform with three deliverables: (1) an OpenAPI 3.1 document per Worker at `GET /openapi.json` + a rendered `GET /docs`; (2) a signed outbound-webhook dispatcher that fans the *already-recorded* audit events to operator endpoints; (3) a one-file Stripe→`/v1/orders` reference adapter. All three reuse the existing `{ok,code,request_id,data}` envelope, cursor pagination, and `Idempotency-Key` conventions verbatim.

### Design

**OpenAPI.** A single shared spec source (`services/_shared/openapi/`) is compiled by `scripts/build-openapi.mjs` into a generated `src/openapi.generated.ts` per Worker (default-exporting the doc object), bundled at build time so there is zero runtime cost and no live-introspection drift. Each Worker's `fetch()` router gains `GET /openapi.json` (raw spec object, like `/health` at `index.ts:2112`) and `GET /docs` (self-contained HTML rendering via a pinned Scalar/Redoc standalone). Paths are documented against the actual routers: backend `/v1/verify|orders|activate|renew|checkout|heartbeat|release|admin/report` (`index.ts:2114-2140`), admin `/api/admin/*` (`worker/index.ts:846-889`), portal `/api/portal/*` (`worker/index.ts:484-491`).

**Webhook dispatcher (read-side, outbox).** Strictly consumes the append-only audit logs (`entitlement_events.prev_json/next_json`, `customer_events.prev_status/next_status`, `order_events.raw_payload/result_json`). The hot write path (`entitlement_mutation.mjs::createEntitlement`) is **untouched** — emission is decoupled. A `webhook_cursor` watermark table drives a cron scan: read source rows `id > last_seq`, `INSERT OR IGNORE` one `webhook_deliveries` row per matching active endpoint, advance `last_seq` in the **same D1 batch** (the atomic-batch invariant from `entitlement_mutation.mjs:225`). The `UNIQUE(endpoint_id,event_source,source_event_id)` index makes enqueue idempotent across re-scans/crashes. The existing `scheduled()` cron (`index.ts:2156`) drains due deliveries: HMAC-SHA256 over `WEBHOOK\n{id}\n{ts}\n{rawBody}` (framing defined once in `src/webhooks/webhook_hmac.mjs`, shared with the shipped verify helper, mirroring `order_hmac.mjs::canonicalOrderSignedText`), headers `Webhook-Id/Timestamp/Signature`, exponential backoff, terminal `failed` after `max_attempts`. **UNMETERED**: cron-only, no `usage_events`/rate-limit rows.

**Stripe adapter.** One deployable Worker file: verify `Stripe-Signature` over the raw body (constant-time) → map to the closed-set `KNOWN_INTENTS` (`order_event.mjs:42`) → re-sign with `order-sign.mjs`/`order_hmac.mjs` framing → `POST /v1/orders`. Unmapped Stripe types are acknowledged and dropped (never invent an intent). `/v1/orders` stays the authoritative gate (HMAC + skew + nonce + floor).

### Data Model
Migrations `0018_create_webhook_endpoints.sql`, `0019_create_webhook_deliveries.sql` (+ `webhook_cursor`), mirrored byte-for-byte into `schema.sql` (enforced by `check-schema-parity.py`) and hand-ported into `supabase-postgres/schema.pg.sql` (INTEGER→BIGINT, AUTOINCREMENT→`GENERATED ALWAYS AS IDENTITY`; template: the `customer_events` port at `schema.pg.sql:469`). `webhook_endpoints` stores secrets only as `secret_hmac` + `pepper_key_id` + display-only `secret_prefix` (mirrors `account_tokens`, `schema.sql:277`). `webhook_deliveries` is the outbox with the `UNIQUE` dedup index and a `(status,next_attempt_at)` due-index.

### API
Admin (all `requireAdmin`, mirroring the kill-switch at `worker/index.ts:778`): `POST/GET/PATCH /api/admin/webhooks[/{id}]`, `POST .../rotate|disable`, `GET .../{id}/deliveries`, `POST .../deliveries/{id}/redrive` — all via the existing `mutationResponse()`/`envelope()`/`mutation_idempotency` machinery and `boundedCursor`. Backend adds only `GET /openapi.json` + `GET /docs`. Outbound contract: signed `POST` to operator URLs with before/after payload.

### UI
Admin `main.tsx` (React 19 + Vite + `styles.css`): a Webhooks tab — list (cursor-paginated), create (one-time secret banner), detail with a DeliveryLog + per-row Redrive (admin-only), rotate/disable. reader role read-only (server still enforces). Nav link to `/docs`. Portal/Stripe adapter: no UI.

### C++
None. Entirely server-side; the OpenAPI doc only *describes* the existing `/v1/verify` contract the C++ online-verification callback already calls. `licensecc.cpp`, `lease_client.hpp`, `seat_client.hpp`, `hw_identifier/` untouched.

### Security
Fail-closed secret storage (keyed-HMAC + pepper, lint L1/L10 extended). `WEBHOOKS_MODE = off|soft|required` (default `off`, inert tables), mirroring `ACCOUNT_TOKEN_MODE`. SSRF guard (https-only, private/metadata-IP/port rejection) at create AND send. Atomic enqueue+watermark batch. Bounded retries → terminal `failed`. Replay window (300s, constant-time verify). Stripe adapter verifies before normalizing; cross-env replay blocked by `ORDER_INGEST_AUDIENCE`.

### Tests
Real-SQLite outbox matrices (`test/sql/`, the `DatabaseSync` + all-migrations harness from `seat-pool.test.mjs`): idempotent fan-out, atomic watermark, glob filtering, before/after fidelity. Hermetic: HMAC round-trip vs the verify helper (à la `order_sign.test.mjs`), backoff, SSRF unit matrix. Adversarial: proto-pollution config keys, metadata-IP block, hanging endpoint timeout, dup `source_event_id`, no-secret-in-logs. Admin-worker mock-D1 tests (RBAC, idempotency replay, rotate, redrive, pagination). Stripe-adapter sign/verify end-to-end + unmapped-drop. PG parity + `check-schema-parity.py`. OpenAPI 3.1 meta-schema validation + path/code drift cross-check, wired into `validate_release_gates.mjs`.

### Effort: large. Dependencies: Workstream A (shared signed-token/HMAC primitives + service-rename surface) for the `webhook_hmac.mjs` framing to sit alongside `order_hmac.mjs`/`signed_token`.

### Risks
`order_events` TEXT PK forces a `received_at`-keyed watermark (dedup index absorbs same-second collisions). Seat/lease before/after is thin (`usage_events`) — v1 scopes to entitlement/order/customer (open question). Cron wall-clock/subrequest budget — per-tick cap + AbortController + separate enqueue/send; possibly a second cron trigger. UNMETERED only holds if emission stays cron-only. OpenAPI drift mitigated but best-effort.

**Open decisions (need product sign-off):**

- Seat/lease webhook scope: usage_events (checkout/release/reclaim/denied) lacks a full before/after snapshot. Do we (a) ship entitlement/order/customer webhooks now and defer seat/lease, (b) emit thin seat/lease events (event_type + seat_id + reason, no before/after), or (c) widen usage_events first? Recommend (a) for v1; this is a product-scope call.
- Webhook signing-secret rotation UX: account_tokens support replaced_by chaining and a drain window. Do webhook secrets need dual-secret overlap (old+new both valid for N minutes so in-flight retries verify) or is a hard cutover at rotate acceptable? Dual-secret is safer for at-least-once delivery but adds a second secret_hmac column / table.
- Dedicated webhook cron vs reusing the 5-min scheduled() tick: a separate, more frequent trigger (e.g. */1) lowers delivery latency but doubles cron invocations. What latency SLO do operators expect for webhooks (sub-minute vs best-effort few-minutes)? Affects whether we add a second [triggers] crons entry.
- Stripe adapter deployment shape: ship as a standalone fourth Cloudflare Worker (own wrangler.toml, deployable), as a documented snippet operators paste into their own Worker, or as a Node Express handler? The prompt says '1-file reference adapter'; recommend a single deployable Worker file + README, but Paddle parity (the prompt mentions Stripe/Paddle) implies a second adapter — do we ship both or one canonical Stripe + a 'porting to Paddle' doc section?
- Should /openapi.json + /docs be gated behind Cloudflare Access on the admin/portal Workers (they currently front auth at /api/*), or always public? Public is standard for API docs and leaks no secrets, but an operator may prefer the admin console's contract be Access-gated. Recommend public for backend, Access-optional for admin.

---

<!-- E — Multi-language client SDKs (C#/.NET + Python) generated from the OpenAPI spec, with offline signed-token verification helpers | phase_suggestion=P2 effort=large depends_on=D -->

## Workstream E — Multi-language client SDKs (C#/.NET + Python)

### Goal
Most ISVs are not C++ shops. Today the only first-class integration is the C++ static lib (`src/library/`), which excludes the majority of the market. Workstream E ships officially-supported **C#/.NET** and **Python** SDKs that (1) wrap the client-facing HTTP endpoints and (2) port the **offline signed-token verification** kernel so a non-C++ host can verify server-signed `lccoa1.` online assertions and `v201` leases against an embedded public-key ring — without shelling out to the C++ lib. The C++ static lib remains the **deep-enforcement / anti-tamper** path; the SDKs deliberately cover only the HTTP + token contract.

### Design
Two layers per SDK:

1. **HTTP client** over the 6 client-facing endpoints in `services/cloudflare-licensing-backend/src/index.ts`: `POST /v1/verify`, `/v1/activate`, `/v1/renew`, `/v1/checkout`, `/v1/heartbeat`, `/v1/release`. Response envelope is the flat `{ok, code, ...}` shape (NOT the admin `{ok,code,request_id,data}`). Idempotency via the existing `request_id` (lease) / `Idempotency-Key` semantics; bearer (account-token) passed through from the host, respecting the platform's `off->soft->required` posture. The SDK does **not** mint account tokens or device-proof signatures — it serializes what the host hands it.

2. **Offline verifier kernel** — a faithful port of two canonical-payload builders + RSASSA-PKCS1-v1.5/SHA-256 verification:
   - **lccoa1 online assertion** (`OnlineVerification.cpp`): plain `key=value\n` lines, fixed field order (`purpose,version,alg,key-id,project,feature,license-fingerprint,device-hash,nonce,status,issued-at,expires-at,cache-until,revocation-seq`), trailing `\n` required, no `\r`, no `=`/newline in values. Claim validation ports `validate_claims()` exactly: purpose/version/alg match, status in {ok,denied}, request binding, hex field sizes, `issued-at <= now+300`, `expires-at >= issued-at`, `cache-until >= expires-at`, cache window bound, `revocation-seq >= floor`, nonce binding (with bounded cache fallback).
   - **v201 lease** (`v201_canonical_payload.cpp` / `canonical_payload.mjs`): length-framed `k<8hex>:<key>v<8hex>:<value>\n` with domain `licensecc:v201\n`, `CANONICAL_ORDER` as the single source of order, required-field + date/version/key-id validation.

Both verify against an **embedded PKCS#1 RSA DER ring** (key-id -> DER), regenerated by the same artifact `services/cloudflare-licensing-backend/scripts/generate-online-key.mjs` emits (it already prints `public_key_der_base64` + the CMake macro the C++ build consumes). Floor: **3072-bit RSA** (matches `signature_verifier.hpp` `min_public_key_bits=3072`); algorithm string must equal `rsa-pkcs1-sha256`. The host may inject an additional trusted key at runtime (mirrors the C++ `trusted_public_keys` override) for rotation.

### Data model
None. SDKs are pure clients; no `schema.sql`/migration/`schema.pg.sql` edit, so `check-schema-parity.py` and PG parity are untouched. The only embedded 'data' is read-only public-key DER (generated, not secret).

### C++
No library change. The C++ lib is the **parity oracle**: reuse the existing checked-in golden vectors (`test/vectors/online_assertion/golden.*`, `test/vectors/v201/*`, `test/vectors/config_attestation/golden.token`) directly. Avoid adding a C++ emitter target unless a vector is missing.

### Security
Fail-closed: reject unless prefix + key-id-in-ring + modulus>=3072 + alg-exact + signature-over-exact-bytes + all claim/limit checks pass. Two canonical formats must never be conflated. SDK never holds a signing key. Staged `OnlinePolicy` (Disabled/Require) lets hosts roll out online checks without a hard cutover; offline token verification is always strict.

### Tests
Headline gate (mirrors `test/lease-sign.test.mjs`): byte/hex parity of each SDK's canonical builder vs the C++ golden vectors; signature ACCEPT on the goldens and REJECT on byte-flip / wrong key-id / sub-3072 modulus / wrong alg. Port the full C++ negative matrix (bad date, missing newline, embedded `\r`, denied status, expired, cache-exceeds-max, revocation below floor, nonce mismatch). Hermetic HTTP tests stub all 6 endpoints (respx/httpx; .NET `HttpMessageHandler`) against fixtures derived from `index.ts` (incl. 429/503/409/410). Opt-in live e2e mirrors `scripts/remote-cpp-verify.mjs`. Packaging smoke: `dotnet pack` restore-and-run, `pip install` the wheel in a clean venv. New `.github/workflows/sdk.yml`; the parity job needs **no secrets** and is a required check.

### Effort / Dependencies
Large. **Depends on Workstream D** (OpenAPI spec) for the HTTP layer; the offline verifier kernel can start immediately against the checked-in vectors. Phase **P2** — high value but not on the v200 release-readiness critical path.

### Risks
D-spec drift; the two-format conflation trap; PKCS#1-vs-SPKI import differences (.NET `ImportRSAPublicKey` wants PKCS#1, Python `cryptography` wants SPKI); cross-runtime PKCS#1v15 correctness; embedded-key staleness on rotation; scope creep into anti-tamper (explicitly excluded).

**Open decisions (need product sign-off):**

- Codegen vs hand-written HTTP layer: fully generate the HTTP client from OpenAPI (openapi-generator / NSwag / kiota for .NET, openapi-python-client for Python) and hand-write only the offline verifier, OR hand-write thin clients for the 6 endpoints (smaller surface, fewer generated-code headaches)? The 6-endpoint surface is small enough that hand-written may be cleaner and less brittle than generator churn.
- Which languages beyond C#/Python and in what order? Java and Go are the obvious next ISV asks; the verifier port is the reusable kernel. Out of scope for this workstream but affects how the canonical-payload kernel is factored.
- Should the SDK port config_attestation (lcccfg1) verification in v1, or defer? It shares the signed_token envelope discipline but is offline-signed by tooling and a narrower use case.
- Versioning policy: tie SDK semver to the OpenAPI spec version and/or the token format version (lccoa1/v201), or independent? Recommend: independent SDK semver, with a documented compatibility matrix against {spec version, token format version, embedded key-id set}.
- Distribution org/namespace: NuGet 'Licensecc.Client' / PyPI 'licensecc' (or 'licensecc-client') ownership and publishing identity — needs the same npm-org decision (@licensecc) already made for the services packages.

---

<!-- F — Dashboards/analytics UI + operator triage | phase_suggestion=P1 effort=medium depends_on= -->

## Workstream F — Dashboards/analytics UI + operator triage

### Goal
Convert the admin **Reports** tab (14 flat number cards) and **Fulfillment** tab (5 cards) into a lightweight, dependency-free analytics surface, and give operators a one-click triage verb. Concretely: inline-SVG time-series for `peak_concurrent`/`seats_in_use` and a `denial_rate` trend, an entitlements-expiring-in-7/30-days list, a fulfillment-events-over-time chart, a red entitlement-health badge on rows holding expired/expiring-soon/suspended licenses, and an admin-only **force-release seat / end-the-lease** verb backed by the existing seat-reclaim SQL. Mostly front-end (`src/ui/main.tsx`, a new `charts.tsx`, `src/ui/operatorWorkflow.ts`, `styles.css`) plus two small read endpoints and one mutating reclaim endpoint in `src/worker/index.ts` — all on the already-shared single D1.

### Design
The admin Worker binds the **same** D1 as the licensing-backend (`wrangler.toml`: `database_name = licensecc-online-verifier-test`, `migrations_dir` points at the backend), so all reads hit the real `usage_events`/`entitlements`/`order_events`/`seat_checkouts` with no cross-Worker call. The analytics aggregations already exist in `src/lease/usage_report.mjs` (`summarizeUsage`, `computePeakConcurrent`) — reuse them per bucket rather than re-deriving. The force-release verb mirrors `handleSeatRelease`/`recordUsageEvent` from the backend `index.ts`: a guarded `DELETE FROM seat_checkouts ... RETURNING` plus one best-effort `usage_events` `reclaim` row per freed seat (`reclaim` is already CHECK-allowed in migration 0012).

### Data model
**none — no schema change.** `entitlements.valid_until` (+ existing `idx_entitlements_valid_until`) backs the expiring buckets; `usage_events` (`idx_usage_events_ts`) backs the bucketed counts; `order_events.received_at` backs fulfillment-over-time; `seat_checkouts` is the reclaim target. Force-release writes `event_type='reclaim'` — no new event type/column/table. `schema.sql`, `migrations/0001..0017`, and `supabase-postgres/schema.pg.sql` stay byte-identical so `check-schema-parity.py` passes untouched. `createEntitlement`/`entitlement_mutation.mjs` are not touched. (Optional future fast-path, out of scope: `idx_usage_events_type_ts` as migration 0018.)

### API (admin Worker, `{ok,code,request_id,data}` envelope)
- `GET /api/admin/report/timeseries?metric=usage|fulfillment&from&to&bucket=3600|86400` — reader+admin. `usage`: per-bucket `{checkouts,denials,releases,denial_rate,seats_in_use}` via `summarizeUsage`/`computePeakConcurrent` + carried baseline; `window_truncated` honors `USAGE_REPORT_MAX_ROWS`. `fulfillment`: `GROUP BY` over `order_events`. Bounds: default `to=now`, `from=now-30d`, ≤200 buckets, else `invalid_request` 400.
- `GET /api/admin/report/expiring?within_days=7|30` — reader+admin. `items` from `WHERE valid_until BETWEEN now AND now+within_days*86400 ORDER BY valid_until LIMIT 200` + `expired_count`.
- `POST /api/admin/entitlements/{id}/force-release` — **admin-only** (`requireAdmin` first), `{reason}` required, Idempotency-Key supported. Decodes id, `DELETE FROM seat_checkouts WHERE project=? AND feature=? AND license_fingerprint=? RETURNING seat_id`, inserts a `reclaim` `usage_events` row per freed seat + one `entitlement_events` audit row (`event_type='update'`, reason/actor/request_id). Returns `{released_seats}`; codes `seats_force_released`/`not_found`/`admin_role_required`/`reason_required`.

The backend `GET /v1/admin/report` (`handleUsageReport`) is unchanged — it is per-tuple + account-scoped; the new admin endpoint is the cross-tenant operator view reusing the same pure functions.

### C++
none — server-authoritative. The C++ seat client already returns/handles `410 seat_reclaimed` on its next heartbeat, so force-release takes effect within one heartbeat interval with no client change.

### UI
New `src/ui/charts.tsx`: dependency-free `LineChart`/`Sparkline` (pure `{points,height,width}` → polyline), unit-testable like `operatorWorkflow.ts` — **no Recharts**, matching the hand-rolled `styles.css`. Reports tab prepends a `.chartGrid` of usage + denial-rate + fulfillment charts and an Expiring panel (7d/30d toggle). New `operatorWorkflow.ts` pure helpers: `reportTimeseriesPath`, `expiringPath`, `entitlementHealth(status,valid_until,now)`, `canForceRelease(status)`. Entitlement/customer-detail Status cells render a red `.health-bad` pill when unhealthy; an admin-only **Force release seats** button reuses `runMutation()`+`crypto.randomUUID()` idempotency like `transition()`/the kill-switch.

### Security
Fail-closed RBAC: reads are reader+admin; force-release runs `requireAdmin` before any SQL. Single-D1 means the reclaim is atomic and audited in one place (no service binding/secret). Mandatory reason + `entitlement_events` audit row + best-effort (never-fail) `usage_events` insert mirror existing discipline. Idempotent reclaim (second call frees 0). All windows/limits bounded server-side. No staged-cutover mode needed (admin-plane, not a client protocol change).

### Tests
Extend `test/sql/admin-console.test.mjs` (real `node:sqlite` over shared migrations, drives `worker.fetch`): seeded usage/fulfillment buckets matched against direct `summarizeUsage`; expiring 7/30 + `expired_count`; force-release frees N seats, writes N `reclaim` + 1 audit row, idempotent replay, 404/400 gates; extend the reader-RBAC loop (reads 200, force-release 403). Hermetic pure-unit tests for `entitlementHealth`/`canForceRelease`/path builders/`charts.tsx` geometry. Gate on `check-schema-parity.py` (must stay green) + per-service `lint.mjs` + `createEntitlement` byte-identical.

### Effort / Dependencies / Risks
**Medium**, **no hard dependencies** (self-contained on existing tables/aggregations). Risks: per-bucket `usage_events` scan cost at volume (bounded windows/buckets, optional future index), force-release blast radius (admin-only + reason + audit + confirm + recoverable), baseline-carry correctness across buckets (covered by a two-bucket-vs-whole-window test), and chart/CSS drift (geometry-only, classes not colors).

**Open decisions (need product sign-off):**

- Charting approach: inline hand-rolled SVG (recommended — zero deps, matches the hand-rolled styles.css and the operatorWorkflow pure-function testing convention) vs adding Recharts (richer, but a real dependency + bundle cost). The design assumes inline SVG; adopting Recharts is the only genuine fork.
- Should the usage timeseries be cross-tenant (all entitlements, true operator overview) or filterable by project/feature/customer_id? The design ships cross-tenant aggregate first (operator triage) with project/feature query params as an easy follow-on; confirm operators want a global denial_rate vs per-entitlement only (the per-entitlement view already exists via the backend /v1/admin/report).
- Force-release granularity: this design frees ALL live seats for an entitlement (the 'end-the-lease' verb). Do operators also need a per-seat_id force-release (free one specific seat)? Per-seat is a trivial extension (add an optional seat_id to the body) but adds UI surface; defaulting to whole-entitlement matches the one-click triage intent.

---

<!-- G — C++ client lease/seat lifecycle (implement confirm_license()/release_license()) | phase_suggestion=P1 effort=large depends_on=A — shared signed-token core / structure cleanup (the lccoa1 envelope verify the seat path reuses lives in signed_token/online_verification; G must not fork it). -->

## Workstream G — C++ client lease/seat lifecycle (`confirm_license()` / `release_license()`)

### Goal
Implement the network-license lifecycle in the C++ library so a host wires ONE transport callback and gets turnkey acquire/renew/release for **offline leases** and checkout/heartbeat/release for **floating seats**, with the persisted clock floor + revocation floor anti-rollback already enforced. Today `confirm_license`/`release_license` are fail-closed stubs returning `PRODUCT_NOT_LICENSED` (`src/library/licensecc.cpp:1323-1333`), and the load-bearing decision logic exists only as pure, unwired reference headers — so every host hand-rolls HTTP, idempotency, durable writes, and rollback floors. G closes that gap.

### What already exists (do not re-invent)
- **Pure decision logic, unit-tested:** `lease_client.hpp` (`decide_action`, `should_replace_lease`, `LocalCheck`, `LeaseAction`, `RenewOutcome`), `seat_client.hpp` (`classify_seat_token`, `decide_seat_action`, `SeatToken`, `SeatAction`, `SeatServerResult`), `clock_floor.hpp` (`evaluate_clock_floor`, `utc_midnight_epoch`). Green: `test_lease_client` 5/5, `test_seat_client` 6/6, `test_clock_floor` 7/7.
- **Verification primitive:** a held seat is an `lccoa1.` token the existing `license::online_verification::verify_assertion_envelope` already validates — **no new crypto**. A lease is a v201 `.lic` verified by `acquire_license` against the embedded ring (`test_lease_ring` proves JS-signed → C++-verified).
- **Backend endpoints are live:** `/v1/activate`, `/v1/renew`, `/v1/checkout`, `/v1/heartbeat`, `/v1/release` in `services/cloudflare-licensing-backend/src/index.ts`, returning `{lic,server_time,renew_by,valid_to_epoch}` and `{assertion,seat_id,mode,expires_at,heartbeat_in}` respectively.
- **Persistence + fail-closed precedents:** `LCC_REVOCATION_FLOOR_LOAD/STORE`, `LCC_CONFIG_SEQ_FLOOR_LOAD/STORE`, the `call_*_floor_load/store` no-throw wrappers (`licensecc.cpp:610-705`), and the atomic temp+rename floor file in `examples/production_decision_host/main.cpp:182-217`.

### Design
The C++ core stays HTTP-free. G adds a **richer host callback** `LCC_LIFECYCLE_HTTP` (the existing `LCC_ONLINE_CHECK` only returns an `lccoa1` buffer; lease/seat need the full JSON body). It carries an operation enum `LCC_LIFECYCLE_OP {ACTIVATE,RENEW,SEAT_CHECKOUT,SEAT_HEARTBEAT,SEAT_RELEASE}`, the request fields, and a response-out buffer so the client reads `lic`/`valid_to_epoch`/`seat_id`/`expires_at`. Orchestration (in a new `src/library/limits/lifecycle_orchestrator.{hpp,cpp}`, compiled into `licensecc_static`, keeping glue separate from the C-ABI shims per the OBJECT-lib layout):
1. **Local offline check** — `acquire_license` against the embedded ring + `evaluate_clock_floor` → `LocalCheck`.
2. **Decide** — `decide_action` (lease) / `decide_seat_action` (seat) pick the action from local state + connectivity + last server verdict.
3. **Transport** — invoke `LCC_LIFECYCLE_HTTP` for the chosen endpoint; map HTTP status → `RenewOutcome`/`SeatServerResult`.
4. **Persist (lease)** — gate the durable write with `should_replace_lease` (never downgrade a verified-good lease with an older/torn/unverifiable body), then host STORE (atomic temp+fsync+rename); re-anchor `floor = max(floor, server_time)` up-only.
5. **Verify (seat)** — verify the returned `lccoa1` via `verify_assertion_envelope`, classify with `classify_seat_token`.
All wrapped in the established top-level `try/catch` no-throw C-ABI guard; on any deny `license_out` is cleared and a `LICENSE_LEASE_*`/`LICENSE_SEAT_*` event returned.

### Data model
**none.** Client-side only: no D1/Postgres migration, no `schema.sql`/`schema.pg.sql`/`check-schema-parity.py` change. It consumes shipped tables (`entitlements` lease/seat columns from migrations 0010/0011, `lease_issuance`, `seat_checkouts`, `usage_events`). New persisted state is **host-owned files** (`.lic`, seat-token cache, wall-clock floor) written through callbacks the core never opens — mirroring the existing externalized floors.

### API
No new server endpoints; G is a CLIENT. It defines the C++ callback contract for the five existing endpoints (request/response shapes above). Auth (account token, off→soft→required) and optional ECDSA `request_proof` are supplied by the host transport, never minted in C++.

### C++ surface
`datatypes.h`: `LccLeaseOptions/Status`, `LccSeatOptions/Status`, `LCC_LIFECYCLE_HTTP`, `LCC_LIFECYCLE_OP`, clock-floor + lease/seat blob LOAD/STORE typedefs, new `LICENSE_LEASE_*`/`SEAT_*` event codes (size+version+reserved discipline copied from `LccLicenseDecisionOptions`). `licensecc.h`: keep legacy `confirm_license`/`release_license` as thin fail-closed-unless-configured wrappers (preserves the `public_api_test` contract) + add `lcc_lease_acquire/renew/release`, `lcc_seat_checkout/heartbeat/release`, their `lcc_init_*`, and `lcc_strerror` entries.

### Security
Fail-closed on any unset/error/throw/oversized callback; mandatory host-persisted clock floor (load-failure fails closed; `RefuseTamper` when `now < max(floor, valid_from)` regardless of connectivity); durable-write isolation via `should_replace_lease` + atomic rename so a torn/older body never drops a paying user; client holds no signing key (proofs minted by host over a non-exportable device key); inherits https-only scheme allow-listing from the example transport. Documented residuals: snapshot-restore/re-image/device-clone are NOT stopped offline; online checkout is the authoritative seat cap.

### Tests
Keep the 3 header-only suites; add hermetic `test_lifecycle_orchestrator.cpp` (fake `LCC_LIFECYCLE_HTTP`, real `verify_assertion_envelope` with injected trusted key + flipped-byte negative). Matrices: full lease state machine and seat state machine through the C API (asserting event code + `license_out` cleared on deny); durable-write adversarial (older/torn/unverifiable body leaves good lease intact); floor persistence-across-restart + up-only re-anchor + `now<floor` → tamper; callback-fault fail-closed (null/throw/timeout/buffer-too-small/oversized/malformed). Regression: `unimplemented_authorization_apis_fail_closed` must still pass. Optional real-SQLite end-to-end via Miniflare, reusing `remote-cpp-verify.mjs` and `test_lease_ring`.

### Effort / dependencies / risks
**Large.** Depends on **A** (shared signed-token core — the `lccoa1` verify the seat path reuses must not be forked). Risks: permanent ABI commitment in `datatypes.h` (mitigate by copying the proven size/version layout + an ABI-shape assertion); the clock-floor host seam is genuinely new (model on `call_revocation_floor_load/store`); over-promising offline guarantees (carry the threat-model honesty table verbatim into headers).

**Open decisions (need product sign-off):**

- Should the legacy confirm_license(char* feature, LicenseLocation*) be REPURPOSED to mean seat-heartbeat and release_license to mean seat-release (their stub names suggest network-license confirm/release), or kept as permanently-deprecated fail-closed shims with the real verbs being lcc_seat_heartbeat/lcc_seat_release? (Naming/back-compat fork — affects the public header contract and SDK ergonomics.)
- One unified LCC_LIFECYCLE_HTTP callback for all five operations vs. two callbacks (lease vs seat)? One callback is simpler for hosts but couples lease and seat request/response shapes; two is cleaner but more wiring. Genuine ergonomics fork for the SDK pairing.
- Should the library OWN the .lic / seat-token / floor file I/O behind a default file-backed implementation (turnkey, opinionated paths) or stay strictly callback-only (host owns all persistence, like the existing floors)? The repo's current pattern is callback-only; turnkey adopters may want a built-in default. Product call.
- Does G ship a built-in HTTP transport (curl/WinHTTP) as a default, or only the callback + the example transports (online_callback_common.hpp)? CLAUDE.md states the core does no HTTP; a default transport would break that invariant but materially improve turnkey adoption.

---

<!-- H - Fuzzy/partial hardware matching + relink reconciliation | phase_suggestion=P2 effort=large depends_on=A -->

## Workstream H - Fuzzy/partial hardware matching + relink reconciliation

### Goal
Eliminate the top reliability/support cost in hardware binding. Today `hw_identifier` produces a single 8-byte signature and any disk/NIC drift yields a hard `IDENTIFIERS_MISMATCH` (`datatypes.h:44`). WS-H makes drift recoverable on two paths without weakening the cryptographic model:
- Offline `MATCH_MOST`: a v201 license carries a SET of per-component client-signatures and passes when at least N of M still match the host.
- Online relink: the server reconciles a drifted `device_hash` against fingerprints it has already seen for the entitlement, rebinding only when policy allows and the rebind is rate/audit-bounded.

### Design
The per-component identifiers the gap asks for already exist: `DefaultStrategy::alternative_ids()` (`default_strategy.cpp`) aggregates per-disk and per-NIC `HwIdentifier` candidates, and `IdentificationStrategy::validate_identifier` passes if ANY host candidate `operator==` the single stored signature. The single stored signature is the only thing missing a set. So WS-H (a) lets the license store a signature SET + an N-of-M rule folded into the signed v201 canonical payload, and (b) adds a server reconciliation table so a known-good but drifted device can rebind.

Server relink reuses the proven atomic-cap shape from `lease/issuance_sql.mjs` (`LEASE_ISSUANCE_ATOMIC_SQL`): a single `INSERT ... SELECT ... WHERE (COUNT in window) < ceiling RETURNING`, so there is no check-then-write TOCTOU, exactly like the device-rebind and seat-pool caps. Relink is staged behind `RELINK_MODE` (off->soft->required) mirroring `ACCOUNT_TOKEN_MODE`/`REQUEST_SIGNATURE_MODE`.

### Data model (migration 0018_fuzzy_relink.sql)
All-additive so `check-schema-parity.py` stays green and the hand-ported `supabase-postgres/schema.pg.sql` mirrors it.
- Four `entitlements` columns (written only via `setEntitlementCapacity` -> add to `CAPACITY_COLUMNS`; `createEntitlement` untouched/byte-identical): `match_strategy TEXT DEFAULT 'exact' CHECK IN('exact','most')`, `match_min_components INTEGER DEFAULT 0`, `relink_window_sec INTEGER DEFAULT 2592000`, `max_relinks_per_window INTEGER DEFAULT 0` (0 = relink OFF).
- `entitlement_fingerprints` (PK project,feature,license_fingerprint,device_hash; FK->entitlements ON DELETE CASCADE; component_class, first/last_seen_at, seen_count, status active|retired|blocked, notes) - the prior-seen devices to reconcile against.
- `relink_events` (append-only; backs the atomic cap AND audit; decision accepted|denied_rate|denied_policy|denied_unseen; window index on project,feature,license_fingerprint,created_at). Swept by `scheduled()` like `request_proof_nonces`.

### API
- `POST /v1/relink` (new route in `src/index.ts`, beside `/v1/activate` and in `/v1/emergency/*`): account-auth + `IsolationBinding` + `checkDeviceProof` with a new `RELINK_PROOF_PURPOSE='licensecc-relink-request'`. Body `{project,feature,license_fingerprint,old_device_hash?,new_device_hash,component_hashes?,nonce,request_proof?}`. Decision is one atomic `INSERT INTO relink_events ... WHERE COUNT(accepted in window) < max_relinks_per_window AND EXISTS(active+in-validity entitlement AND new_device_hash present in entitlement_fingerprints) RETURNING id`; on accept, move `entitlements.device_hash` + write `entitlement_events` in the same `writeEntitlementWithAudit` batch. Envelope `{ok,code,server_time}`; codes relink_ok|relink_denied_rate|relink_denied_unseen|relink_denied_policy|relink_disabled.
- `POST /v1/verify` (`handleVerify`): add a fourth `deviceHashSatisfied` accept clause - `request.device_hash` present in `entitlement_fingerprints(status='active')` - so a relinked hash keeps verifying. Loosens an accept path only; gated by `max_relinks_per_window>0`.
- Admin Worker: `GET/POST /api/entitlements/:id/fingerprints[/...retire|block]`, `PATCH /api/entitlements/:id/policy`; `{ok,code,request_id,data}` + Idempotency-Key + reader/admin RBAC.

### C++
- `datatypes.h`: additive enum `STRATEGY_MATCH_MOST` (verify-only meta) + new v201 limit-key constants `client-signatures` / `client-signature-match`.
- `hw_identifier_facade.{hpp,cpp}`: new `validate_pc_signature_set(vector<string> license_sigs, unsigned min_match)` - builds host candidates once, counts distinct license sigs with a matching candidate (reusing `operator==` + the existing IP/env/weak-source runtime gates per token), `LICENSE_OK` iff matched>=min_match.
- `license_verifier.cpp`: generalize the single `PARAM_CLIENT_SIGNATURE` path (lines ~286-295) to a SET folded into `v201_fields_for()` so the whole set + N is signed; single-signature path preserved (exact, M=N=1).
- New `src/library/limits/relink_client.hpp`: pure inline decision 'attempt online relink given local mismatch but valid signature?', unit-tested like `decide_action()` in `lease_client.hpp`.

### UI
Admin: Fingerprints panel (list + Retire/Block) and Relink-policy editor on the entitlement detail view, plus a Relink-history table from `relink_events` so support sees rate-ceiling hits. Portal: a session-scoped 'My device changed' action that proxies `POST /v1/relink` via the 120s ephemeral-token mint (`portal_token.mjs`), server-resolving the fingerprint, showing remaining relinks; the portal holds no signing key and never mutates directly.

### Security
Fail-closed by construction: relink OFF until opted in (max=0), drift to an UNSEEN hash denied (`denied_unseen`), the anti-roam ceiling enforced in one atomic statement (no TOCTOU), every accept/deny audited. Offline `MATCH_MOST` cannot weaken binding because the signature SET and N are inside the signed payload (verified before any HW match) and per-token weak/IP/env gates still apply. Isolation reuses `entitlementOwnershipExists()`; D1 errors fail closed (mirroring `consumeRequestProofNonce`). Staged `RELINK_MODE` off->soft->required.

### Tests
C++ Boost: K-of-M matrix in `hw_identifier_facade_test.cpp`; signed-set tamper -> `LICENSE_CORRUPTED` before HW match; legacy single-sig golden under `test/vectors/`. Real-SQLite (`test/sql/`, like `lease-rebind.test.mjs`): atomic relink cap under concurrency, `denied_unseen`, batch device_hash move + audit, window roll-off. Hermetic Worker (`lease-worker.test.mjs` style): mode matrix, isolation, proof-audience, verify fourth-clause. Adversarial: nonce replay, unseen-hash, roam burst, D1-error fail-closed. Gates: `check-schema-parity.py` green, PG parity tests, lint, and `entitlement-mutation.test.mjs` byte-identical `createEntitlement`.

### Effort / Dependencies / Risks
Large; depends on WS-A (per-policy match knob + policy projection). Phase P2. Risks: the offline signature-SET format needs a matching change in the out-of-tree license generator (`extern/license-generator`); `MATCH_MOST` deliberately lowers the binding bar (keep N high, exclude weak-source tokens); `entitlement_fingerprints` accumulates device history (retention sweep + redact logs). Open questions: default N for MATCH_MOST; whether relink may MINT a fresh offline license; whether to allow operator/portal pre-authorization of a never-seen device_hash for disaster recovery.

**Open decisions (need product sign-off):**

- What is the default recommended match_min_components when an operator enables MATCH_MOST (M-1? a fixed 2?), and should policy be expressed as an absolute N or a fraction of M? A product call about how much drift to tolerate vs. how easily a cloned machine passes.
- Should an online /v1/relink success ALSO be allowed to MINT a fresh offline license (new client-signature SET) so a relinked device keeps working fully offline, or is relink online-only (device_hash rebind) for v1? Minting needs the lease/config signer and widens scope considerably.
- Should relink reconcile ONLY to fingerprints the server previously observed (strict, proposed default) or also accept an operator/portal-initiated 'pre-authorize this new device_hash' so a customer can relink a machine the server has never seen (disaster recovery to a brand-new box)? The latter needs an explicit admin/portal pre-seed flow with its own abuse bound.

---

## Consolidated open decisions (product sign-off)

**Workstream A:**

- expiration_basis from_first_use vs from_first_activation: 'first use' implies a client-reported signal distinct from server-side activation. Is there a product distinction, or should from_first_use be an alias of from_first_activation for P1 (server only sees activation)? Recommend: collapse to from_first_activation in P1, keep the enum value for a future client-reported-use channel.
- Should the trial device-lock key on the self-asserted device_hash (spoofable) or the cryptographically-proven ECDSA device_key_id (entitlement_devices, relay-resistant)? device_key_id is far stronger but requires the device-proof path to be active. Recommend device_key_id when a proof is present, else device_hash, with a policy flag trial_require_device_proof.
- Do we want per-project policy uniqueness on name (UNIQUE(project,name)) to prevent operator confusion, or allow duplicates? Leaning UNIQUE(project, lower(name)) like idx_customers_email.
- Should disabling a policy retroactively affect entitlements stamped from it (it does NOT in this design — stamped values are frozen)? Confirm this is the intended product semantics vs a 'live template' expectation.

**Workstream B:**

- Seat-to-device linkage: seat_checkouts is keyed by client_instance_id with no device_key_id column. To free 'this device's' seat on deactivate we either (a) add a device_key_id column to seat_checkouts (schema change to a hot-path table) and bind it at checkout, (b) join through usage_events.device_key_id (best-effort, only populated when a proof was present), or (c) rely solely on the revocation_seq bump + grace lapse (no precise seat free, simplest). Which model — precise per-device seat free (a/b) vs. revocation-only (c)? This is the core product/architecture fork.
- Transfer 'activate-there' semantics: does the new laptop self-enroll its own ECDSA device key (requires a new backend enrollment endpoint, since the portal holds no signing key) — or does transfer only promote a device the customer already uploaded via the CLI/backend (status disabled->active)? The latter is shippable now; the former needs a Plan-3-style backend endpoint and a workstream dependency.
- Should deactivate REVOKE (terminal) or DISABLE the entitlement_devices row? Revoke is terminal and matches 'this laptop is gone'; disable is reversible ('temporarily'). Revoke aligns with the support-ticket intent but forbids re-adding the same key id later (the ON CONFLICT in device-upsert would resurrect it via admin only). Recommend revoke for deactivate, but confirm.
- Does last_seen_at need a new writer (e.g. update it on every /v1/heartbeat and /v1/verify with a proof) so the Devices view is meaningful for floating customers? That is a small backend change with hot-path cost; in scope for this workstream or deferred?

**Workstream C:**

- CSV import semantics: should an import row that matches an existing entitlement key UPDATE it (current createEntitlement upsert behavior) or be rejected as a conflict? This is a genuine product fork — 'import = provision new only' vs 'import = declarative sync'. Recommend dry-run-flags-create-vs-update + default to update-allowed, but confirm.
- Should bulk ops extend beyond entitlements to customers (bulk disable customers = bulk kill-switch) and account_tokens (bulk revoke) in this workstream, or stay entitlement-only for v1? Bulk customer-disable is high-blast-radius (severs auth) and may warrant its own slice.
- Search scope: should GET /api/admin/search also fan out to account_tokens by token_prefix and to the audit log (entitlement_events/customer_events) by request_id? The prompt names 4 resource types; adding tokens/audit is a natural extension but widens the surface.
- Is the bulk_import_jobs audit table worth the schema cost, or is per-row entitlement_events sufficient (the import is reconstructable by grouping events on request_id)? Leaning toward keeping it for a clean 'who imported this batch' record, but it could be dropped to avoid a migration if import ships in P2.
- Does the org want a feature flag (ADMIN_BULK_ENABLED) to ship the batch/import write surface to prod 'off' first, mirroring the off->soft->required cutover philosophy, or are operator-initiated UI writes low-risk enough to ship on?

**Workstream D:**

- Seat/lease webhook scope: usage_events (checkout/release/reclaim/denied) lacks a full before/after snapshot. Do we (a) ship entitlement/order/customer webhooks now and defer seat/lease, (b) emit thin seat/lease events (event_type + seat_id + reason, no before/after), or (c) widen usage_events first? Recommend (a) for v1; this is a product-scope call.
- Webhook signing-secret rotation UX: account_tokens support replaced_by chaining and a drain window. Do webhook secrets need dual-secret overlap (old+new both valid for N minutes so in-flight retries verify) or is a hard cutover at rotate acceptable? Dual-secret is safer for at-least-once delivery but adds a second secret_hmac column / table.
- Dedicated webhook cron vs reusing the 5-min scheduled() tick: a separate, more frequent trigger (e.g. */1) lowers delivery latency but doubles cron invocations. What latency SLO do operators expect for webhooks (sub-minute vs best-effort few-minutes)? Affects whether we add a second [triggers] crons entry.
- Stripe adapter deployment shape: ship as a standalone fourth Cloudflare Worker (own wrangler.toml, deployable), as a documented snippet operators paste into their own Worker, or as a Node Express handler? The prompt says '1-file reference adapter'; recommend a single deployable Worker file + README, but Paddle parity (the prompt mentions Stripe/Paddle) implies a second adapter — do we ship both or one canonical Stripe + a 'porting to Paddle' doc section?
- Should /openapi.json + /docs be gated behind Cloudflare Access on the admin/portal Workers (they currently front auth at /api/*), or always public? Public is standard for API docs and leaks no secrets, but an operator may prefer the admin console's contract be Access-gated. Recommend public for backend, Access-optional for admin.

**Workstream E:**

- Codegen vs hand-written HTTP layer: fully generate the HTTP client from OpenAPI (openapi-generator / NSwag / kiota for .NET, openapi-python-client for Python) and hand-write only the offline verifier, OR hand-write thin clients for the 6 endpoints (smaller surface, fewer generated-code headaches)? The 6-endpoint surface is small enough that hand-written may be cleaner and less brittle than generator churn.
- Which languages beyond C#/Python and in what order? Java and Go are the obvious next ISV asks; the verifier port is the reusable kernel. Out of scope for this workstream but affects how the canonical-payload kernel is factored.
- Should the SDK port config_attestation (lcccfg1) verification in v1, or defer? It shares the signed_token envelope discipline but is offline-signed by tooling and a narrower use case.
- Versioning policy: tie SDK semver to the OpenAPI spec version and/or the token format version (lccoa1/v201), or independent? Recommend: independent SDK semver, with a documented compatibility matrix against {spec version, token format version, embedded key-id set}.
- Distribution org/namespace: NuGet 'Licensecc.Client' / PyPI 'licensecc' (or 'licensecc-client') ownership and publishing identity — needs the same npm-org decision (@licensecc) already made for the services packages.

**Workstream F:**

- Charting approach: inline hand-rolled SVG (recommended — zero deps, matches the hand-rolled styles.css and the operatorWorkflow pure-function testing convention) vs adding Recharts (richer, but a real dependency + bundle cost). The design assumes inline SVG; adopting Recharts is the only genuine fork.
- Should the usage timeseries be cross-tenant (all entitlements, true operator overview) or filterable by project/feature/customer_id? The design ships cross-tenant aggregate first (operator triage) with project/feature query params as an easy follow-on; confirm operators want a global denial_rate vs per-entitlement only (the per-entitlement view already exists via the backend /v1/admin/report).
- Force-release granularity: this design frees ALL live seats for an entitlement (the 'end-the-lease' verb). Do operators also need a per-seat_id force-release (free one specific seat)? Per-seat is a trivial extension (add an optional seat_id to the body) but adds UI surface; defaulting to whole-entitlement matches the one-click triage intent.

**Workstream G:**

- Should the legacy confirm_license(char* feature, LicenseLocation*) be REPURPOSED to mean seat-heartbeat and release_license to mean seat-release (their stub names suggest network-license confirm/release), or kept as permanently-deprecated fail-closed shims with the real verbs being lcc_seat_heartbeat/lcc_seat_release? (Naming/back-compat fork — affects the public header contract and SDK ergonomics.)
- One unified LCC_LIFECYCLE_HTTP callback for all five operations vs. two callbacks (lease vs seat)? One callback is simpler for hosts but couples lease and seat request/response shapes; two is cleaner but more wiring. Genuine ergonomics fork for the SDK pairing.
- Should the library OWN the .lic / seat-token / floor file I/O behind a default file-backed implementation (turnkey, opinionated paths) or stay strictly callback-only (host owns all persistence, like the existing floors)? The repo's current pattern is callback-only; turnkey adopters may want a built-in default. Product call.
- Does G ship a built-in HTTP transport (curl/WinHTTP) as a default, or only the callback + the example transports (online_callback_common.hpp)? CLAUDE.md states the core does no HTTP; a default transport would break that invariant but materially improve turnkey adoption.

**Workstream H:**

- What is the default recommended match_min_components when an operator enables MATCH_MOST (M-1? a fixed 2?), and should policy be expressed as an absolute N or a fraction of M? A product call about how much drift to tolerate vs. how easily a cloned machine passes.
- Should an online /v1/relink success ALSO be allowed to MINT a fresh offline license (new client-signature SET) so a relinked device keeps working fully offline, or is relink online-only (device_hash rebind) for v1? Minting needs the lease/config signer and widens scope considerably.
- Should relink reconcile ONLY to fingerprints the server previously observed (strict, proposed default) or also accept an operator/portal-initiated 'pre-authorize this new device_hash' so a customer can relink a machine the server has never seen (disaster recovery to a brand-new box)? The latter needs an explicit admin/portal pre-seed flow with its own abuse bound.

