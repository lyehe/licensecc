# Glossary

The customer portal (`services/cloudflare-customer-portal`) and the admin
console (`services/cloudflare-license-admin`) render the same underlying
records for two different audiences: a customer managing their own access,
and an operator managing many customers'. Before this glossary, the two UIs
had drifted onto different words for the same concept (for example
`Binding:`, `Retire connection`, and `Registered nodes` in the admin console
next to `Device ID`, `Disconnect`, and `Legacy device registrations` in the
portal). This page is the single source of truth for the word each app uses.
It is task F1 of the UI/UX workflow remediation plan recorded under
`docs/superpowers/plans/2026-09-23-ui-ux-workflow-remediation.md`, and it
lands first so every later task writes new copy in these terms.

**API codes, JSON field names, route paths, CSS class names, and TypeScript
identifiers are unchanged by this glossary.** It governs rendered text only:
labels, headings, button text, dialog copy, and status text a person reads.
A wire-level value (for example the entitlement status code `disabled`) can
keep its existing code while the text shown for it changes (for example to
`suspended`).

## Canonical terms

| Concept | Customer term (portal) | Operator term (admin) |
|---|---|---|
| Entitlement row | license | license (entitlement) |
| Protected binding | connected device · "Connection ID" · Disconnect | connection · "Connection ID" · Disconnect |
| Legacy device | activated device · Release | activated device · Release |
| Floating seat | seat · Release seat | seat |
| Status | active / suspended / revoked / expired | same |
| Capacity | device limit | device limit |

## What each row means

**Entitlement row.** The grant of a feature to a customer (an
`EntitlementRecord`/`EntitlementRow`: project, feature, license fingerprint,
mode, validity window, status). A customer only ever sees their own rows and
calls each one a **license**. An operator manages rows that belong to many
customers and needs to distinguish the record from the license file it can
issue, so the operator vocabulary is **license (entitlement)**: lead with
"license" in section and page-level copy (the admin console already does —
"License access", "Issued licenses"), and use "entitlement" for the record
itself in management UI (an entitlement's ID, an "entitlement list", "New
entitlement"). Do not force the parenthetical onto every button or label;
it exists to disambiguate the first time a page introduces the record type,
not to replace routine operator terminology.

**Protected binding.** The live link between one device and one
entitlement, keyed by `binding_id` (device-bound licensing, ADR 0006). Both
apps call the record a **connected device** (customer) or **connection**
(operator); either way, when its identifier is shown, the label is always
**"Connection ID"** — never a bare `Binding:`/`Connection:` prefix or
"Device ID" (that label is reserved for the *legacy* device's
`device_key_id`, a different concept — see below). The action that ends the
binding is **Disconnect** in both apps, not "Retire" — "retire"/"retirement"
describes the same action in the current admin/portal copy and code
(`retireBinding`, `retireConnection`, `pendingRetirement.ts`) and may keep
those identifiers, but the words a person reads are "Disconnect".

**Legacy device.** The older node-locked activation keyed by
`device_key_id`, tracked outside the protected-binding path (portal:
"Legacy device registrations"; admin: the customer's device records). Both
apps already call it an **activated device** with a **Release** action, and
that does not change. Its identifier label is **"Device ID"** — this is a
different identifier than a protected binding's Connection ID, and the two
must not be merged or cross-labelled.

**Floating seat.** A time-limited checkout against a floating-mode
entitlement's pool (`seat_id`, heartbeat/lease-based). The customer term is
plain **seat** — not "floating seat" — with a **Release seat** action,
distinct from a legacy device's bare "Release" so the two cannot be confused
in the same UI. The operator term is also **seat** (for example the admin's
bulk "Release seats" action already matches this).

**Status.** The lifecycle of an entitlement or a device: **active**,
**suspended**, **revoked**, or **expired**. Both apps use the same four
words. Two notes:
- The wire-level entitlement/device status code is `disabled`
  (`EntitlementStatus = "active" | "disabled" | "revoked"`,
  `packages/licensing-domain/src/entitlements/contracts.d.ts`); the code is
  unchanged, but rendered text for that code says **suspended**, not
  "disabled" or "enabled". A customer account's own suspension (a different
  field, `customer.status`, also wire-coded `disabled`) is a related but
  separate concept; the admin console's operator-facing views (the customer
  detail badge, its status filter, and the account-token list) display it as
  **suspended** too, as of this task. The portal applies the term to a
  customer's own account at sign-in (task A3): the correct password, or a
  linked Google or GitHub identity, on a suspended account gets "This account
  is suspended." Task C5 applies it to a customer's per-license status
  text: a license wire-coded `disabled` reads "Suspended." followed by the
  support contact.
- "Expired" and "not started" for a portal license are computed from its
  validity window and, for a trial, the date its trial ends; neither is
  stored as a status code. The portal words them "Expired on {date}" and
  "Starts {date}" (task C5). "Not started" is an additional, allowed nuance
  beyond the four canonical words, not a replacement for any of them.

**Capacity.** The maximum concurrent devices an entitlement or policy
allows (`max_active_devices`/`device_limit`). Both apps call this the
**device limit** wherever it names that one field specifically (the portal
already does, in the consent page and in `device_limit_exceeded` copy). A
table column that reports capacity in *either* devices or floating seats,
depending on the entitlement's mode, is a different, dual-unit display and
is out of scope for this rename — relabelling it "device limit" would
misdescribe a seat count.

## Applying this glossary

- Prefer the table's exact words in new copy. If a concept in the table
  needs a new label you have not seen here, check this page before
  inventing a third synonym.
- Keep the customer portal's copy free of "entitlement" — customers read
  "license". The admin console may use "entitlement" for the record itself
  in operator-facing management UI.
- A copy-guard test in each app's `test:ui` suite
  (`services/cloudflare-customer-portal/test/portal-glossary-copy.test.mjs`,
  `services/cloudflare-license-admin/test/admin-ui-workflow/glossary-copy.test.mjs`)
  fails if a retired term (`Binding:`, `Retire connection`, `Registered
  nodes`, a quoted `"enabled"` status, `Floating sessions`) resurfaces in
  `src/ui/**`. Extend that list rather than reintroducing a retired word
  under a new name.
