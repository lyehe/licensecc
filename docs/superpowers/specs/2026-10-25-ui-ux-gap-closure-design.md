# UI UX gap closure design

Status: proposed, 2026-10-25. Reviewed source: main at a22baa14cfa2dcd3bf799517e85757ed6e7d129b.
Implementation is not started. This design resolves the six findings from the current UI workflow review.
The [execution plan](../plans/2026-10-25-ui-ux-gap-closure.md) defines delivery and proof.

The main changes are a working device-capacity recovery path and a customer-centered access workflow.
Keep the existing licensing records and security model while removing unnecessary decisions from ordinary tasks.

## Review outcome and scope

| Finding | Evidence at the reviewed commit | Review conclusion |
| --- | --- | --- |
| UX-1, P1, high confidence | [Consent instruction](../../../services/cloudflare-customer-portal/src/ui/features/consent/ConsentFeature.tsx), [pending intent restoration](../../../services/cloudflare-customer-portal/src/ui/features/consent/pending.ts), [shell selection](../../../services/cloudflare-customer-portal/src/ui/app/App.tsx) | Confirmed recovery dead end. The previous local browser walkthrough reached /#/nodes but still rendered Connect this device. A same-tab link alone cannot resolve it. |
| UX-2, P2, high confidence | [Add user](../../../services/cloudflare-license-admin/src/ui/features/customers/AddUser.tsx), [onboarding instructions](../../../services/cloudflare-license-admin/README.md), [password-mode entry](../../../services/cloudflare-customer-portal/src/ui/features/auth/AuthFeature.tsx) | Confirmed labeling and setup friction. Invite explicitly sends no email. A real automatic invitation is a separate email-delivery feature; the immediate closure is an honest, direct self-setup journey. |
| UX-3, P2, high confidence | [Entitlement editor](../../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementEditor.tsx), [relationships](../../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementRelationships.tsx), [onboarding test](../../../services/cloudflare-license-admin/test/admin-ui.onboarding.e2e.mjs) | Confirmed model exposure. The license and entitlement writes are separate operations. A guided UI must handle partial completion rather than imply atomicity. |
| UX-4, P2, medium confidence | [Customer access](../../../services/cloudflare-license-admin/src/ui/features/customers/CustomerAccess.tsx), [workspace test](../../../services/cloudflare-license-admin/test/admin-ui.workspace.e2e.mjs) | Confirmed extra navigation through a one-row list. The list provides legitimate lifecycle actions; replace its presentation while retaining those actions and customer isolation. |
| UX-5, P2, high confidence | [Date copy](../../../services/cloudflare-license-admin/src/ui/features/entitlements/EntitlementEditor.tsx), [UTC conversion](../../../services/cloudflare-license-admin/src/ui/shared/dates.ts), [patch preservation](../../../services/cloudflare-license-admin/src/ui/features/entitlements/workflow.ts) | Confirmed day-boundary arithmetic. Off-by-one mistakes are an inferred risk, not an observed production incident. Existing precise timestamps must survive the UI change. |
| UX-6, P2, high confidence | [Loaded-row filtering](../../../services/cloudflare-customer-portal/src/ui/features/devices/ProtectedNodes.tsx), [search cases](../../../services/cloudflare-customer-portal/test/portal-ui.devices-search.e2e.mjs), [binding route](../../../services/cloudflare-customer-portal/src/worker/routes/device-bindings.ts) | Confirmed pagination burden. Existing copy acknowledges partial coverage; tests cover that notice rather than finding a later-page match. Search must have explicit completeness and bounded work. |

The earlier [UX remediation plan](../plans/2026-09-23-ui-ux-workflow-remediation.md) and
[customer license device redesign](2026-10-01-customer-license-device-workflow-design.md)
remain unchanged. The latter proposes a much larger identity, license, and connection redesign.
This increment closes the six findings against the current accepted implementation; it does not claim to execute that larger proposal.

Use the existing [ownership map](../../../doc/architecture/ownership.md),
[change guide](../../../doc/architecture/change-guide.md), [glossary](../../../doc/architecture/glossary.md),
and [device authority ADR](../../../doc/architecture/decisions/0006-device-bound-licensing.md).
No native ABI, SDK, database schema, offline format, cryptography, capacity-hold policy, or new shared package is required.

## Target workflows

| Task | Intended journey |
| --- | --- |
| Create a customer account | Add user -> Customer sets password -> clear setup instructions -> portal Set or reset password -> verified email link -> choose password |
| Grant access | Customer -> Grant access -> app and feature -> limit and validity -> review -> save |
| Edit access | Customer -> app -> Manage access -> contextual access details and actions |
| Connect with capacity available | Native app -> portal sign-in if needed -> match code and license -> approve -> return to app |
| Recover full capacity | Consent -> Manage devices within the connection screen -> confirm disconnect -> return and recheck -> approve if the request and capacity permit |
| Find a device | Search the owned account or selected app -> matching results, explicit search progress, and bounded continuation for large accounts |

### Connection recovery

Keep ConsentFeature mounted while an inline device-management view is open. Reuse the Devices feature's
list, confirmation, retirement persistence, and exact-retry behavior through a portal-local component or hook.
Do not introduce a second retirement state machine or globally bypass enrollment precedence.

The management view is scoped to the app when that context is available. Label it as app device management:
the existing binding response does not identify the selected license, so it must not claim that every shown
connection occupies that license. Show the app, feature, and device label before confirmation.

Retain the selected license, page, comparison confirmation for the same unchanged attempt, and the attempt deadline
while the child view is open. Re-inspect before enabling approval again. An account, attempt, or comparison-code
change invalidates the retained confirmation. A saved approval/denial outcome that is unknown must be reconciled
before starting device management; retirement and consent mutations must share an exclusion boundary.

Disconnecting may leave a capacity hold beyond the connection request's five-minute lifetime.
Show the release time and a clear restart-from-app instruction when necessary. Do not extend the request,
release a slot early, or imply that disconnect immediately authorizes another device.
A disconnect that succeeds remains valid even if the connection attempt subsequently expires.

### Account setup

Rename Invite to Customer sets password. Keep No email is sent and the initial-password alternative.
The success view supplies copyable instructions; the portal labels the existing reset request as Set or reset
password and reuses its verification and completion logic. Existing Forgot password access remains understandable.

The existing /?password_action=reset entry opens the request form directly. Documentation may use it on the known
portal origin. The admin has no configured portal-origin field today: do not invent an absolute link from the
admin origin, add a guessed tenant URL, or include a password, token, or email address in a setup URL.
Use generic portal instructions where the deployment's portal URL is unavailable.

This closes the misleading invitation label and first-time password wording. Manual sharing of instructions
remains explicit. Automatic setup-email delivery is deferred rather than reported as implemented.

### Contextual access and guided creation

Manage access opens a customer-scoped detail/action view. It contains validity, device limit, policy, status,
edit/extend, suspend/resume, and revoke where authorized. Reuse existing mutation and confirmation behavior.
Back, browser history, missing records, unsaved changes, and focus return remain supported.

Add Grant access to the customer workspace, including customers who have no app grants yet.
When launched inside an app, prefill the app; otherwise offer existing catalog projects and features with an
explicit manual-identifier alternative. The catalog assists discovery and never becomes a new mandatory prerequisite.
Keep policy configuration optional and advanced relationships available.

Generate one fingerprint per genuinely new draft. Prefilled context and generated defaults do not alone make
the draft dirty. Preserve its identity through policy detours and retry/reconciliation. Reveal the full fingerprint
only in advanced details, never in navigation URLs.

When one existing customer/app license is eligible, select it. When several exist, ask the operator which to use
or let them explicitly choose a new license. Never silently attach a grant to an arbitrary existing purchase.
When none exists, explain that saving will create the license record. Do not create records while merely browsing
the form. On save, use the existing license creation followed by entitlement creation.

Preserve each operation's stable intent and exact-read success proof. If only the license write succeeds,
show Access not granted and let the operator retry using that same license. An uncertain entitlement write
requires reconciliation, not a fresh fingerprint or license. Cancel never deletes a created record.
This is a guided sequence, not a new atomic server operation.

### Inclusive validity dates

Use Valid through for a calendar-day expiry, with an exact UTC expiry preview. For example, choosing
2026-10-25 produces the existing exclusive API deadline 2026-10-26T00:00:00Z.
Valid from keeps its existing start-of-day meaning; no expiry and policy inheritance keep their meanings.

Use an entitlement-specific date adapter rather than changing every caller of the shared date helper.
An existing midnight expiry displays the previous included day. A non-midnight expiry, or an out-of-range date
that the calendar cannot represent, displays its precise custom UTC deadline. Preserve the original seconds
when the operator does not explicitly change expiry; changing another field is not consent to round a deadline.
Policy-derived or trial deadlines remain visibly derived and are not silently reinterpreted.
Use the same expiry presentation in entitlement lists, customer access summaries, and expiring-access reports:
show the included day for calendar deadlines or the exact UTC instant for custom deadlines. Keep report
classification and days-left calculations based on the existing exact instant.

### Device search and contract compatibility

Treat GET /api/portal/device-bindings as a stable existing contract. Extend it with optional q and project
constraints; retain the existing response keys, unfiltered behavior, binding-ID order, and exact-binding inspection.
Use q as a literal substring, not SQL syntax, regular expressions, wildcards, or a new filter language.
A nonempty trimmed q is at most 128 Unicode code points; project uses the existing project identifier rules.
Reject duplicate or unknown parameters. Allow cursor with q and project; keep binding_id mutually exclusive
with cursor and the new constraints. Empty q behaves as omitted.
For list matching this empty value is unfiltered; presence of q is still rejected with binding_id,
so exact-binding lookup keeps one unambiguous request shape.

Use the same JavaScript trim and lowercase matching semantics as the current UI, including Unicode labels and
the Unnamed device fallback. Move the pure matcher to portal-local shared code if used by both UI and Worker.
Do not import UI implementation into the Worker or another deployable's implementation into the portal.

To avoid a new search index or a Unicode regression, process a bounded candidate page in the Worker:
push the exact app and ownership predicates into the existing query, read at most 101 candidates, inspect
the first 100, and return only matches. In nonempty-q mode, next_cursor advances over the scanned candidates,
so a page can contain fewer than 100 matches or no matches while has_more is true. Document this new,
opt-in mode; preserve the old full-page validation rules for requests without q.

SQLite's default [lower function](https://www.sqlite.org/lang_corefunc.html#lower) folds ASCII only.
Do not substitute it for the existing JavaScript behavior or assume an ICU extension is available.
[D1 documents its SQLite basis](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
The bounded Worker matcher avoids requiring new schema or platform extensions.

The client debounces search, resets the cursor on query/app/account changes, fences late responses, and continues
sparse pages automatically up to five requests per interaction. If more work remains, show Search incomplete and
Continue search with the preserved cursor; never show a final no-match result until next_cursor is null.
Load more matching results remains available when results fill a page. This is account-wide, paginated search,
not an assertion that an arbitrarily large account can be searched in one unbounded request.

Keep the session as authority and the displayed-account header as a precondition. Preserve no-store, exact
disconnect lookup/retry, and absence of fingerprints and device keys from this response.
Deploy the compatible Worker extension before the new search UI; rollback the UI first.

The compatibility review uses [AIP 158](https://google.aip.dev/158), [AIP 180](https://google.aip.dev/180),
and [AIP 210](https://google.aip.dev/210) for pagination, unchanged defaults, and explicit Unicode units.
This is the repository's existing REST surface; adopting Google's resource naming or a general filter grammar
is outside this increment.

| API review surface | Coverage |
| --- | --- |
| Resource and method | Reviewed: existing GET binding list and POST retirement; no new route or rename. |
| Fields and pagination | Reviewed: optional constraints and opt-in scan cursor semantics; response keys unchanged. |
| Compatibility | Reviewed: existing unfiltered and binding_id clients retain their behavior; new UI requires the extended Worker. |
| Documentation and examples | Required with implementation: OpenAPI, portal README, and portal canonical baseline. |
| Errors, auth, and retry | Reviewed: existing session/customer check, strict invalid requests, no-store, and retirement reconciliation remain. |
| SDK surface | Not applicable: native SDKs do not call this portal binding-list operation. |

## Completion criteria

Each finding closes only with the task's observable acceptance checks and the combined browser journeys in the plan.
The review used source/test tracing and prior synthetic-data browser observations at the same commit.
Production analytics, user interviews, a live tenant, real email delivery, and a native application GUI
have not been evaluated. Implementation proof must distinguish mocked browser paths from a real configured
email/backend/native journey.
