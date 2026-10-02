Device enrollment
=================

This reference covers the implemented enrollment comparison and license-page
protocol. The public Windows and Linux client and installed example are described in
:doc:`device_identity`; live TPM/browser/backend validation of the complete
protected application workflow remains a release gate. See :doc:`services` for
served request/response schemas and :doc:`../architecture/decisions/0006-device-bound-licensing`
for the authority boundaries.

Renewal recovery
----------------

Transient retries retain the original operation identity and elapsed-time anchor.
The server retains exact operation responses for 48 hours; after that deadline,
the immutable operation tombstone returns ``idempotency_conflict``. A conflict
does not automatically create a new request, and it is not proof that the earlier
request failed to commit.

For an established binding, explicitly abandon the pending renewal with
``lcc_device_bound_abandon_pending``. Handle any checkpoint recovery first. If
the result is ``LCC_BOUND_ONLINE_REQUIRED``, call ``lcc_device_bound_renew`` to
start a new operation for that same binding. Other results require their own
handling; in particular, ``BUSY`` does not authorize starting another operation.
Delayed responses from the abandoned operation cannot authorize the new one.
Always call ``lcc_device_bound_authorize`` before protected work.

Abandonment does not retire a binding, release capacity, delete a key or undo
a possible server commit. Enrollment without an authenticated binding follows
the enrollment recovery flow instead of this renewal procedure.

Renewal refusals
----------------

The backend issues a renewal challenge for every existing binding, whatever the
state of its license, account, binding or device. Before the device proves its
key, a challenge therefore reveals only that the binding exists, and the binding
ID is a 128-bit secret. A challenge for an unknown binding returns
``404 binding_unavailable``.

The reason a renewal is refused is returned only after the proof verifies, on
``/v2/device-leases/renew``. A retiring or released binding, or a disabled
device, is refused with ``403 device_retired`` before any license or account
check, so a disconnected device never learns the state behind it. An inactive,
revoked, expired or not-yet-valid license, an ineligible trial or a disabled
account is refused with ``403 access_denied``. The other refusals and every
rate limit are unchanged. The native client classifies these refusals exactly as
it classified a refused challenge: ``lcc_device_bound_renew`` returns
``LCC_BOUND_DENIED``, and protected work stays denied until a fresh renewal is
accepted.

Enrollment comparison
---------------------

Registration and authenticated inspection return ``comparison_code``. The
portable encoder is ``deviceEnrollmentComparisonInput`` in
``packages/licensing-domain/src/lease/device_protocol.mjs``; the independent
fixture is ``test/vectors/device_bound/v1/enrollment_comparison_feature.json``.

Encode these exact fields in this order. ``requested_feature`` is required;
an empty feature is an encoding error, and the backend refuses a registration
without it.

.. code-block:: text

   attempt_handle
   client_id
   project
   key_id
   redirect_uri
   state
   code_challenge
   requested_feature

The transcript starts with the UTF-8 bytes of
``lcc-device-enrollment-comparison-v2`` followed by LF. For each field, append
canonical unpadded base64url of its UTF-8 value, then LF, including the final
field. Hash the complete transcript with SHA-256. Format the first six digest
bytes as twelve uppercase hexadecimal digits, grouped ``XXXX-XXXX-XXXX``.
Preserve leading zeros. Do not include field names, a BOM, CRLF, padding or
JSON separators in these bytes.

The app must use its original submitted values and locally derived device key
ID, plus the returned attempt handle, to recompute the code. A mismatched
registration response must stop enrollment before opening the browser. The
browser displays the code derived from the stored attempt and asks the user to
confirm that it matches the app. Cancellation does not require confirmation.
Labels, customer/license selection, revisions and timestamps are not part of
this immutable enrollment transcript. Because the browser shows the
app-supplied device label beside the code, registration refuses a label that
holds control, format, line-separator or default-ignorable characters, or text
whose UTS #39 skeleton is shaped like the skeleton of a comparison code once
dashes, spaces and fullwidth forms are folded, so ``O`` for ``0``, ``I`` or
``l`` for ``1`` and look-alike characters in any script cannot spell one;
:doc:`device_identity` lists the exact rule.

The code is a 48-bit human comparison aid, not a credential, lookup key,
signature or proof of key possession. State verification, PKCE, fresh challenges
and device-key proof remain mandatory. The authorization URL carries only the
attempt handle in its fragment; the loopback callback carries only its short-lived
authorization code and state. Native callback handling must remove those values
from its final URL and use no-store/no-referrer behavior before release.

Live license pages
------------------

Inspection accepts an optional ``page_cursor``. Omit it for the first page;
null and empty strings are invalid. Each response contains at most 100 eligible
licenses and a required ``next_page_cursor``. ``has_more`` is true exactly when
that continuation is non-null. Terminal attempts have no choices or continuation.

Pages use strict keyset ordering by feature and license fingerprint. The existing
customer/project index supports traversal. The backend fetches at most 101 rows
and derives continuation from the last returned row, not the overfetch row.
Current account, ownership, attempt status and database-time eligibility are
checked in the same read as the page. Approval independently rechecks authority
and capacity; appearing in a page reserves no device slot.

The opaque cursor is canonical unpadded base64url of this JSON tuple:

.. code-block:: text

   ["ep1", attempt_handle_hash, sha256(customer_id), last_feature, last_fingerprint]

Both hashes are lowercase SHA-256 hex over UTF-8 text. The encoded cursor is at
most 512 characters. Its version, canonical bytes, tuple fields and request
context are validated. It is unsigned because it is only a position; it cannot
grant access or choose the authenticated account. No new cursor secret or
database table is required.

This is live pagination, not a frozen inventory. Deleted or expired cursor rows
do not break continuation. Insertions before the current position appear when
the list is restarted. Every later page can reflect new eligibility or revocation.

The portal keeps one page and previous positions. Successful navigation clears
the selected license; failed navigation preserves the current page and selection.
Only a sole license on the first and final page is selected automatically.
Mutations are disabled while a page loads. Once a mutation is saved, paging is
unavailable and recovery preserves the original choice, comparison code and
idempotency key. The expected-account header remains a precondition checked
against the session, never an authority source.
