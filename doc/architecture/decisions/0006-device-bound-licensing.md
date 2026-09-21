# ADR 0006: Device-bound licensing authority and persistent slots

- Status: Accepted for staged implementation; public v2 endpoints and a reviewed
  browser consent flow exist. Public Windows and Linux owners and installed
  consumers exist; each live TPM/browser/backend journey remains a release gate.
- Date: 2026-09-13
- Decision owners: licensing backend, native runtime, portal and release maintainers.

## Context

Account authentication identifies the customer entitled to use an application.
It does not establish which machine is presenting a request. A supplied machine
identifier or copied license file is insufficient evidence of private-key
possession. Floating-seat checkouts also have a different lifecycle from a
persistent device allocation and cannot serve as its authority ledger.

The new flow must enforce a device cap under concurrent requests, tolerate lost
responses, retain capacity while an offline lease can still be accepted, and
remain separate from supported legacy and floating clients.

## Decision

### Authority and ownership

The existing entitlement remains the commercial authority for the customer,
project, feature and license fingerprint. Protected mode uses a device record
with an immutable customer, project and public key, plus a binding allocating
one slot of that entitlement. The backend owns these mutations. Portal sessions
authorize browser consent through a named internal service binding; a public
customer-id header is never an ownership assertion.

The native desktop flow uses a user-scoped, application-specific Windows TPM
or Linux TPM2/OpenSSL key and system-browser enrollment. The server verifies key possession. Provider
metadata alone never establishes hardware attestation. Any hardware-only policy
needs a separately reviewed attestation verifier and trust lifecycle.

### Persistence and atomicity

D1 is the authoritative store. One guarded batch rechecks current ownership,
entitlement/device revisions, complete request intent, challenge deadline and
slot capacity while committing the binding, lease, proof consumption, exact
operation result and audit. A final failing constraint rolls back an incomplete
causal chain. No KV lock, in-memory mutex or second slot ledger participates.

An active binding occupies a slot even while its application is offline. A
retiring binding occupies the slot until its maximum acceptance hold ends.
Retirement stops new issuance and advances generation; it cannot invalidate a
signed offline lease immediately. Capacity reductions below occupied slots and
ownership changes while occupied are rejected. Pruning lease history never
shrinks a hold or removes the identity tombstone.

Stable operation ids identify semantic requests; fresh invocation ids identify
individual batch executions. Recovery requires fresh proof of the same intent,
current authority and the original committed operation. It returns the exact
stored response without issuing another lease or extending the hold.

### Protocol and time

The protected lease has its own purpose and envelope. Canonical bytes, strict
parsing, key identity and independent vectors belong to the portable domain and
cryptographic consumer boundaries. Private signing keys remain Worker secrets;
clients receive public trust material only. See the implementation specification
for the field-level wire contract rather than duplicating it in this ADR.

The native consumer anchors a fresh current-process operation to its original
monotonic send time and includes the entire request/response delay. Cached state
does not restore offline authority after a process restart or uncertain clock
continuity; those cases require online renewal. Clients stop at signed expiry.
The server's conservative clock allowance belongs only to capacity holds and
must be supported by native clock-continuity evidence before release.

### Compatibility and cutover

Entitlements explicitly distinguish legacy and protected enforcement. Legacy
verification, issuance, device registration and floating-seat writes fail closed
for protected mode. There is no fallback from a protected validation failure to
a legacy format or an environment-wide optional-proof setting.

Migration 0036 leaves existing entitlements in legacy mode. Automatic in-place
conversion is blocked: retained lease/seat rows cannot prove complete historical
authority, and legacy offline clients have different clock and expiry semantics.
Future conversion needs reviewed issuer fencing and durable cutover evidence,
including externally issued and pruned grants. Development uses fresh synthetic
protected cohorts. Rollback must preserve mode, generations, identities and holds.

PostgreSQL remains a fenced v1 verification adapter. Its disposable bootstrap
mirrors schema and row guards, with static parity and real-engine conformance
tests; protected issuance remains D1-only.

## Consequences and release evidence

This design keeps commercial authority, proof of device identity and capacity
allocation distinct. The cost is bounded transfer delay and online renewal after
restart in the initial native profile. These are explicit product behavior.

The implementation must demonstrate atomic capacity and rollback, authenticated
recovery, parser/crypto interoperability, restored holds, protected legacy-route
denial, browser consent and a real native protected operation. Schema and helper
tests alone do not establish end-to-end protection.

The maintained native API and enrollment references describe the application
contract. Backend deployment and end-to-end qualification remain separate from
building and testing the native runtime and SDK adapters.
