# UI UX gap closure implementation plan

Status: proposed, 2026-10-25; implementation not started.
Reviewed baseline: main at a22baa14cfa2dcd3bf799517e85757ed6e7d129b.
Design and finding evidence: [UI UX gap closure design](../specs/2026-10-25-ui-ux-gap-closure-design.md).

Close UX-1 through UX-6 with small changes in the two existing UI deployables.
Deliver a working capacity-recovery journey first, then reduce operator setup and access-management steps.
Execute the packets sequentially; no parallel checkout or agent work is required.

Read [AGENTS.md](../../../AGENTS.md), the [change guide](../../../doc/architecture/change-guide.md),
[ownership map](../../../doc/architecture/ownership.md), and
[task packet and handoff convention](../../../CONTRIBUTING.md#task-packets-and-handoffs).
The existing protected plans and larger proposed redesign are context, not files to rewrite.
Record implementation progress and verified outcomes under docs/implementation/ rather than editing this plan.

## Delivery sequence and dependencies

| Packet | Finding | Owner and dependency | Observable result |
| --- | --- | --- | --- |
| T1 | UX-1, P1 | Portal deployable; first | Full-capacity customers can manage devices and return to the same unexpired connection. |
| T2 | UX-2, P2 | Admin and portal deployables | Self-setup is named honestly and uses the existing verified password flow. |
| T3 | UX-5, P2 | Admin deployable; before T5 | Operators choose the last included day without changing untouched exact deadlines. |
| T4 | UX-4, P2 | Admin deployable; before T5 | Manage access opens useful details/actions directly. |
| T5 | UX-3, P2 | Admin deployable; after T3 and T4 | Grant access starts in customer/app context and safely handles both existing writes. |
| T6 | UX-6, P2 | Portal deployable; integrate with T1 | Search finds later-page matches with bounded work and explicit completeness. |
| T7 | All six | Both deployables; after T1 through T6 | Combined onboarding, editing, search, and capacity recovery are demonstrated. |

Keep packets reviewable as separate patches or PRs during implementation. Do not split a packet's behavioral
change from the tests and documentation needed to understand it. Planning does not authorize deployment or live emails.

## T1 Recover device capacity inside consent

**Owning surface:** portal features/consent and features/devices; App.tsx remains composition-only.
Read ConsentFeature.tsx, pending.ts, ProtectedNodes.tsx, pendingRetirement.ts, and App.tsx.
Allow a new portal-local recovery presentation module and a coherent device-workflow extraction if needed.

- [ ] Add Manage devices to the full-capacity state and show device management inline, leaving the consent owner mounted.
- [ ] Reuse the existing listing, disconnect confirmation, saved retirement, and exact-binding reconciliation. Scope by app where available; do not claim license-specific filtering from the current binding DTO.
- [ ] Share mutation exclusion between consent and device management. Block entry while approval/denial is unresolved and block approval while a disconnect is unresolved.
- [ ] Return to connection by explicitly re-inspecting. Preserve selection and code confirmation only for the same unchanged attempt; retain the original deadline.
- [ ] Give actionable release-time and restart instructions when the hold outlives the request. Keep a completed disconnect recoverable after attempt expiry.
- [ ] Add browser regressions to portal-ui.consent.e2e.mjs and relevant retirement/session cases, including an actual navigation/recovery path rather than only changing an inspection mock.

**Acceptance:** same-tab full-capacity -> Manage devices -> confirm one owned disconnect -> re-inspect ->
Approve when the hold has ended and the attempt remains valid -> app handoff.
Also prove long holds, attempt expiry while the child view is open, account change, failed re-inspection,
lost retirement response and exact retry, already-connected devices, and unchanged approval request identity.
No intent handle or fingerprint enters a navigation URL or telemetry.
At 390px and desktop widths, keyboard users can enter, operate, and leave recovery with sensible focus.

**Checks:** portal group P and focused consent/nodes/session browser commands below.
No backend authority, native protocol, hold policy, or new route change belongs in T1.

## T2 Make account self-setup explicit

**Owning surfaces:** admin features/customers/AddUser.tsx and onboarding copy; portal features/auth
PasswordSignIn.tsx, AuthFeature.tsx, and existing password-message/completion views.
Include PasswordSettings.tsx copy where it points people to the renamed request action.

- [ ] Rename Invite to Customer sets password; retain No email is sent and the initial-password alternative.
- [ ] Provide concise, copyable setup instructions after creation, distinguishing account creation from access assignment.
- [ ] Label the existing portal request path Set or reset password for first-time and returning users. Reuse /?password_action=reset and the existing email verification/completion behavior.
- [ ] Keep the existing anti-enumeration response and email-disabled/provider-only behavior. Do not expose an undisclosed credential or imply that an email has already been sent.
- [ ] Update both service READMEs and browser copy assertions. The admin has no portal-origin setting; do not manufacture a link from its own origin.
- [ ] Add a first-time admin-created-account scenario that reaches the existing verified password setup path. Use a test email sink or existing mock, not a real email.

**Acceptance:** a new customer and operator can identify exactly how setup works and whether they need to share
instructions. A copied instruction leads to the existing portal request form and a valid setup link can complete
the password flow. Existing customers still recover passwords normally. Email-disabled deployments retain
the initial-password route. Automated invitations remain explicitly out of scope.

**Checks:** groups A and P; focused admin onboarding and portal auth/password browser cases.
Do not add an invitation service, new credential type, cross-service email sender, or new auth operation.

## T3 Remove expiry day arithmetic

**Owning surface:** admin entitlement editor/workflow and an entitlement-local date adapter.
Read shared/dates.ts and all callers before changing date conversion. Keep other callers' semantics unchanged.
Include entitlement lists, CustomerAccess.tsx, and Reports.tsx where expiry is summarized.

- [ ] Add calendar-day Valid through conversion and a visible exact UTC expiry preview.
- [ ] Display an existing midnight deadline as its previous included day; keep precise non-midnight or unrepresentable deadlines in an explicit custom state.
- [ ] Preserve original seconds when expiry is untouched, including when notes, relationships, or another date changes.
- [ ] Keep Valid from, null/no-expiry, policy inheritance, trial-derived deadlines, and server validation intact.
- [ ] Use consistent included-day or precise-UTC expiry text in the editor, entitlement lists, customer access, and expiring reports. Keep exact-instant report calculations unchanged.
- [ ] Add semantic date tests and update admin-ui.datedisplay.e2e.mjs plus policy/catalog cases only where touched.

**Acceptance:** 2026-10-25 means access through that whole UTC day and sends 2026-10-26T00:00:00Z.
Cover leap day, month/year rollover, invalid and upper-bound dates, UTC versus non-UTC browser zones,
clear-to-no-expiry, policy inheritance, untouched midnight, and untouched non-midnight seconds.
The UI must not silently round an existing deadline or change expiry merely by opening and saving.
Editor, customer summary, list, and report must agree about the same record's expiry.

**Checks:** group A; focused datedisplay and lifecycle browser cases.
The backend's exclusive epoch-seconds field and shared policy-date semantics remain compatible.

## T4 Open contextual access details

**Owning surface:** admin CustomerAccess.tsx, app navigation state, and entitlement feature modules.

- [ ] Replace the scoped one-row list presentation with a customer/app/grant detail and action view.
- [ ] Reuse edit, extend, device-limit, suspend/resume, revoke, reason capture, and confirmation workflows.
- [ ] Preserve exact customer-scoped reads, stable mutation identity, and exact success proof. Keep full fingerprints out of URLs and history.
- [ ] Support Back to app, browser back/forward, missing/removed grant handling, unsaved-change protection, and focus return.
- [ ] Update workspace/navigation/lifecycle regressions to assert those behaviors rather than requiring a one-row table.

**Acceptance:** Customer -> app -> Manage access exposes the selected grant's details and relevant actions
without a second list selection. Another customer's grant is never displayed or mutable from that context.
An unresolved mutation cannot be bypassed by navigating between list and detail.
Global License access remains available for multi-customer operations.

**Checks:** group A; focused workspace, navigation, lifecycle, and recovery browser cases.
Avoid duplicating the existing entitlement mutation logic in a second customer-only implementation.

## T5 Guide access creation from the customer

**Owning surface:** admin customer workspace, entitlement editor/workflow, relationships, protectedCreate.ts,
and CreateLicense.tsx. Reuse catalog UI access patterns without making catalog setup mandatory.
Depends on T3 and T4.

- [ ] Add Grant access for a new customer with no grants as well as an existing customer/app. Prefill the customer and known app.
- [ ] Offer catalog app/feature choices with explicit manual entry for valid uncatalogued IDs. Keep policy selection optional.
- [ ] Generate one fingerprint per new draft, move technical fields under advanced details, and use the initialized draft as the dirty-state baseline.
- [ ] Automatically select one eligible license, explicitly choose among multiple licenses, or offer creation on save when none exists. Resolve authoritative reads before choosing.
- [ ] Extract a callable license-creation workflow from the existing button if needed; retain keyed mutations and exact-read proof.
- [ ] Sequence license creation and entitlement creation only on Save. Retain each intent and the created license across partial failure, uncertain outcomes, reconciliation, and policy detours.
- [ ] On success, show the grant in the same customer/app context. On partial success, say Access not granted and identify the retry step; never silently create a replacement license or fingerprint.
- [ ] Keep the global advanced entry path supported; update the admin onboarding guide and tests.

**Acceptance:** a new ordinary grant requires no fingerprint operation, repeated customer selection, or manual
license-record setup. Multiple existing purchases still require an explicit choice. A suspended customer is
refused by existing server authority. Test zero/one/multiple licenses, uncatalogued valid app/feature,
policy detour, cancel before Save, double-submit, lost responses for each write, license-created/grant-refused,
and stale customer/app context. Those cases must never create duplicate records or claim access prematurely.

**Checks:** group A; focused onboarding, workspace, catalog, navigation, and recovery browser cases.
No new atomic grant API, schema redesign, global terminology rewrite, or automatic cleanup of existing records.

## T6 Search devices across pages

**Owning surface:** portal binding-list Worker route, portal shared validation/matcher, device UI/API adapter,
matching OpenAPI fragment, portal README, and test/contracts/portal.json. Integrate with T1's reused manager.

- [ ] Add optional q and project under the design's exact parameter rules; preserve the old list and binding_id lookup behavior.
- [ ] Use bounded candidate pages and the existing JavaScript matcher for Unicode consistency. For nonempty q, advance next_cursor across scanned candidates, including empty matching pages.
- [ ] Update query-aware page validation: old requests retain their exact full-page checks; search pages allow fewer matches with a strictly advancing canonical cursor.
- [ ] Debounce and fence query/app/account changes. Automatically traverse sparse pages within the five-request budget, then offer Continue search with an incomplete status when needed.
- [ ] Keep exact retirement reconciliation independent of the active query. Query text must never alter which saved disconnect intent is retried.
- [ ] Add Worker, UI-workflow, browser, OpenAPI, and canonical-contract coverage together. Regenerate only the reviewed portal baseline change.
- [ ] Deploy the compatible Worker before the UI in a later authorized rollout; a rollback restores the old UI first.

**Acceptance:** a match after at least 100 earlier nonmatching bindings appears without manual Load more
of unrelated devices. Unicode case matching remains consistent with the old matcher, and literal percent,
underscore, quotes, and backslashes never become query syntax. Test app scoping before pagination,
empty/oversized/duplicate/unknown parameters, binding_id exclusivity, sparse and empty search pages,
end-of-search versus budget exhaustion, cursor loops, query A -> B -> A, late responses, account changes,
and disconnection of a found result. No foreign-account rows, fingerprints, keys, unbounded download, or
silent final no-match claim is permitted.

**Checks:** group P plus contract group C; focused devices-search, nodes, consent, and session browser cases.
No general query language, search service, FTS index, baseline migration, or Google-style API renaming.

## T7 Prove the combined workflows

**Owning surfaces:** concern-specific browser specs, service READMEs when user instructions change,
and a new evidence report under docs/implementation/. Depends on all prior packets.

- [ ] Prove admin-created account -> verified password setup -> customer-scoped grant -> portal license -> native connection handoff fixture.
- [ ] Prove full capacity -> search for a later-page device -> confirm disconnect -> return/re-inspect -> approve or explain the remaining hold and required restart.
- [ ] Prove contextual edit -> inclusive date -> expected UTC deadline, preserving another grant's precise untouched timestamp.
- [ ] Exercise keyboard-only and 390px/1440px layouts for setup, guided grant, access details, search progress, and recovery.
- [ ] Run the required integration gates below, fix failures within their owners, and retain exact command outcomes and screenshots/traces.
- [ ] Write the handoff at the final verified commit. Include all six finding IDs, acceptance outcomes, compatibility decisions, and relevant surfaces not exercised.

A mocked app callback establishes the browser handoff only. A real configured email/backend/native connection
is separate operational qualification and must be marked unrun unless actually demonstrated.

## Validation commands

Run from the repository root. Use npm 10.9.8, Python 3.12, and uv 0.12.18 from the current root toolchain contracts.
The Sphinx gate separately selects its maintained Python 3.13 environment.
Use the existing root lockfile; install browser binaries with the one root setup command when needed.

**Admin group A:**

~~~powershell
npm run lint --workspace @licensecc/cloudflare-license-admin
npm run typecheck --workspace @licensecc/cloudflare-license-admin
npm run test --workspace @licensecc/cloudflare-license-admin
npm run test:sql --workspace @licensecc/cloudflare-license-admin
npm run test:ui --workspace @licensecc/cloudflare-license-admin
~~~

**Portal group P:**

~~~powershell
npm run lint --workspace @licensecc/cloudflare-customer-portal
npm run typecheck --workspace @licensecc/cloudflare-customer-portal
npm run test --workspace @licensecc/cloudflare-customer-portal
npm run test:ui --workspace @licensecc/cloudflare-customer-portal
~~~

**Focused browser examples:** select the concern files named in each packet; these commands are maintained
workspace scripts with Playwright filename filters. The fixtures must drive the actual UI recovery path.

~~~powershell
npm run test:e2e --workspace @licensecc/cloudflare-license-admin -- admin-ui.onboarding.e2e.mjs admin-ui.workspace.e2e.mjs admin-ui.datedisplay.e2e.mjs admin-ui.navigation.e2e.mjs admin-ui.recovery.e2e.mjs
npm run test:e2e --workspace @licensecc/cloudflare-customer-portal -- portal-ui.consent.e2e.mjs portal-ui.nodes.e2e.mjs portal-ui.devices-search.e2e.mjs portal-ui.session-expired.e2e.mjs portal-ui.e2e.mjs
~~~

**Contract group C for T6:** build the serving Worker before canonical comparison. Inspect the baseline diff;
do not refresh unrelated service fixtures merely to make the gate pass.

~~~powershell
npm run test:openapi --workspace @licensecc/cloudflare-customer-portal
npm run write:contract-baselines
npm run test:contracts
npm run check:architecture
~~~

**Required integration and documentation proof for the implemented series:**

~~~powershell
npm ci
npm run check:pr
npm run setup:browsers
npm run test:e2e
npm run check:dry-run
npm run test:docs-accuracy
npm run check:docs
git diff --check
~~~

SDK tests, native build purity, native docs quickstart, and network link checks are not required for these
bounded UI/portal changes; add their dedicated gates if implementation actually crosses those surfaces.

## Definition of done and evidence

Each finding has its corresponding behavior and regression proof, not merely new copy or a screenshot.
All required checks pass at a named final commit; an incomplete or environment-blocked proof remains explicit.
No packet may weaken account ownership, code matching, confirmation, lease holds, or safe retry to simplify a screen.

The implementation evidence records the before/after journey, commands and results, test-data boundaries,
remaining manual setup-instruction sharing, large-account search continuation, and real-service/native checks not run.
The planning change itself adds only this plan and its preceding design; it makes no application behavior claim.
