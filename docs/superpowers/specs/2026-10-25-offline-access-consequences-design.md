# Offline access consequence design

The customer and operator UIs must explain what disconnecting, suspending or
revoking access does to an already-running offline application. The present
messages describe delayed expiry inconsistently, omit online authorization
after restart, and sometimes imply an immediate stop to all access.

## Authority and scope

This is a presentation correction to the accepted behavior in
[ADR 0006](../../../doc/architecture/decisions/0006-device-bound-licensing.md)
and the maintained
[native session reference](../../../doc/api/device_identity.rst).
The native runtime, backend authority, lease duration, capacity holds,
authorization rules and wire contracts remain authoritative and unchanged.

The portal owns its disconnect confirmation. The admin UI owns customer
suspension, single and bulk entitlement lifecycle confirmations, and device
disconnect confirmation. Follow the
[ownership map](../../../doc/architecture/ownership.md) and
[UI change guide](../../../doc/architecture/change-guide.md).

## Required meaning

1. A disconnect stops renewals for that connection. Suspension stops new
   authorization and renewals until resumed. Revocation is permanent for
   the selected grant.
2. Existing offline access may continue until the signed permission expires.
   No message promises immediate offline revocation or a new duration
   starting at the destructive action.
3. Restarting an application requires an online authorization check. For a
   disconnected connection that check is refused; suspension and revocation
   also prevent new permission while their applicable restriction remains.
4. A device slot remains reserved until the displayed release time. That
   timestamp includes a safety allowance and does not extend offline access.
   The browser must not infer a client's expiry from the slot timestamp.
5. Reason, typed-confirmation, cancellation, ownership and retry protections
   keep their current behavior. The customer remains unnotified by an admin
   suspension; the confirmation must continue to state that.

## Copy ownership

The admin UI will keep its repeated offline-expiry/restart sentence in a
small service-local shared module. Single and bulk grant confirmations
will use the same lifecycle consequence helper. Portal wording follows
the same glossary meaning within its own feature boundary. No new shared
package or cross-service UI import is needed.

The glossary will distinguish offline expiry, slot release, portal sign-out
and network disconnection. Service READMEs will describe the same behavior.
The UIs will avoid hard-coded offline durations and new API fields.

## Observable acceptance

At 1440px and 390px, the relevant confirmations visibly explain the
immediate renewal effect, possible continuing offline use, restart check
and, for device disconnection, the distinct slot-release time. Cancellation
sends no mutation. Existing reason and typed-confirmation gates remain
effective, and confirmed operations retain their exact request/key behavior.
The full repository, browser and documentation gates must pass.
