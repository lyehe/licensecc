Device identity and request proofs
==================================

The device-identity API creates or opens a provider-backed P-256 key and signs
the canonical request-proof payload accepted by online verification, lease,
and seat operations. It is an optional C runtime feature; building the core
library does not automatically enable a platform provider.

Lifecycle
---------

1. Initialize :c:struct:`LccDeviceIdentityOptions`, choose an explicit policy,
   scope, and stable application identifier, then call
   :c:func:`lcc_device_identity_open`.
2. Read :c:struct:`LccDeviceIdentityMetadata` and export the public SPKI when
   registering the key with the licensing service.
3. Initialize :c:struct:`LccDeviceProofInput` for each server challenge and
   call :c:func:`lcc_device_identity_build_request_proof_v1`.
4. Close the process-local handle with
   :c:func:`lcc_device_identity_close`. Delete a persisted key only with the
   exact expected key id and application-level owner coordination.

Provider selection is fail-closed. ``HARDWARE_REQUIRED`` never silently falls
back to the software test provider. The Windows TPM and Ubuntu TPM2/OpenSSL
deployment requirements, storage rules, and simulator commands are maintained
in ``examples/device_identity/README.md``.

Explicit Windows key removal
----------------------------

Deletion remains noninteractive by default. After the user confirms an explicit
local-key removal, set ``options.flags = LCC_DEVICE_DELETE_ALLOW_UI`` when calling
``lcc_device_identity_delete_key`` to permit Windows provider UI. The expected
key id is still checked before deletion. Windows decides whether a prompt is
needed; the application must not rely on it as its confirmation dialog.
Cancellation returns ``LCC_DEVICE_ACCESS_DENIED`` without an automatic retry.

This additive flag preserves the version-1 structure layout and existing
zero-flag behavior. Older runtimes reject the new flag. Open/create rejects it,
as do non-Windows providers; clear it before reusing options for opening a key.
Activation, renewal and automatic creation rollback remain noninteractive.
Silent deletion can fail on providers that reject ``NCRYPT_SILENT_FLAG``;
there is no automatic interactive fallback.

Local deletion does not retire the server binding, free a device slot or erase
checkpoints. Retire the connection through the portal first, close local clients,
then remove the exact local key only when it is no longer needed for recovery.
See Microsoft's `NCryptDeleteKey contract
<https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptdeletekey>`_.

Device-bound protocol integration status
----------------------------------------

The additive ``licensecc/device_bound.h`` C API owns the Windows and Linux desktop flows
through ``LccDeviceBoundClient``. It fixes user scope and hardware-required
provider policy and exposes no caller transport, clock, raw response or storage
root override. It preserves the version-1 identity API and key namespace.

Initialize options, the public signing-key ring and output structures before
opening a client. ``open_enrollment`` permits explicit key creation only when
both committed checkpoint slots are missing; existing or unreadable state cannot
start replacement enrollment. ``open_resume`` opens the existing key and
authenticates stored state without restoring an offline clock. Missing/lost keys
never trigger automatic regeneration. Configuration is copied at open.

Call ``prepare`` to start the listener and registration deadline. Display its
fixed comparison code, flush the native view, then call ``launch`` and ``poll``.
After callback receipt, ``activate`` transfers the same owner into renewal.
Restarted clients call ``renew`` before protected work. Only ``authorize``
returning ``LCC_BOUND_OK`` permits the immediately following protected operation;
successful activation, renewal, persistence or displayed state is insufficient.

Every admitted activation, renewal or abandonment attempts to persist the latest
authenticated checkpoint independently of the primary result. Inspect both the
operation result and ``checkpoint_result``. ``save_checkpoint`` retries storage
only, without replaying HTTP or accepting caller-supplied tokens. A failed
checkpoint capture cannot save an older retained record as though capture
succeeded. Cancellation immediately disables authority; if capture fails,
save/cancel retry retains recovery until cleanup can finish. Close requires all
other calls to have returned and never deletes a TPM key or server allocation.

The installed-header-only desktop example is maintained in
``examples/device_bound/README.md`` and listed in :doc:`../usage/examples`.
Its local build/link check does not prove the live TPM/browser/backend journey,
which remains a release qualification requirement.

The native implementation contains internal version-2 proof and enrollment
comparison encoders, checked against the shared exchange, renewal and comparison
vectors. Typed exchange/renewal signing derives the route, body hash, operation
digest and key identity internally, checks the handle's project, normalizes
P-256 signatures to low-S and verifies them before returning base64url proofs.
Fresh challenges change the proof while preserving the immutable operation
digest. Provider errors remain distinguishable from invalid request fields.

The internal lease verifier accepts the canonical ``lccdl1`` envelope with a
dedicated RSA-3072 SPKI trust set. It rejects retired or unknown signers,
noncanonical fields, mismatched expected identities, stale revisions and expired
leases. Binding and lease identifiers encode exactly 16 bytes; operation IDs
encode 32 bytes. Verification uses the signed expiry without client grace.
Successful signature verification alone does not establish local key possession.
First-enrollment trust bootstrap pins verified context in the native owner;
expected authorization context must not be copied from an unverified token.

The internal process-local anchor generates a fresh operation ID and captures
time before the operation's first request I/O. Retries reuse that ID and original
send instant. It adds the full elapsed time, rounded up to seconds, to signed
issuance time and checks continuity and expiry again after signature verification.
There is no anchor restore, copy or reset API. Clock failures permanently reject
that anchor; recovery requires a fresh online operation.

The Windows pilot samples ``QueryUnbiasedInterruptTimePrecise`` around
``QueryInterruptTimePrecise`` using the realtime API set. It rejects reordered
readings, process changes, sampling brackets over 10 ms and incompatible changes
in the accumulated sleep-time interval. Accepted intervals only narrow across
observations. Small changes inside sampling uncertainty can remain undetected;
this is not a proof against every suspend or VM snapshot. Supported sleep states
and clock-rate error still require hardware release evidence. Other platforms
currently reject production anchor creation. See Microsoft's
`interrupt-time reference <https://learn.microsoft.com/en-us/windows/win32/sysinfo/interrupt-time>`_
and `API-set loader reference <https://learn.microsoft.com/en-us/windows/win32/apiindex/windows-apisets>`_.

The internal local-possession check generates a fresh OS-random challenge for
every call and binds its distinct local purpose to the pinned project, device
key and exact accepted-envelope digest. It signs through the open provider and
verifies locally against the handle's SPKI, exporting neither challenge nor
signature. Cached signatures and signatures from another key fail. Provider
errors propagate without reopening or regenerating a key. This check proves
current key possession only; it does not independently authorize a lease.

The internal renewal session owns its identity handle, copied trust and fixed
authorization context, one pending operation and one accepted lease. It starts
online-only. Repeated renewal preparation preserves the pending request, while
typed signing uses the fixed proof audience and binding. Lease and proof
audiences remain distinct. Construction rejects malformed trust, mismatched
identity and incompatible provider policy before request work.

Each accepted response is checked against the current operation and revision
floor, followed by fresh local possession and a final continuity/expiry check.
A higher authenticated revision remains the floor even if later provider work
or the final check fails. Successful replacement discards the previous lease,
including when its expiry was later. Each protected-operation decision repeats
lease verification, possession and the final clock check; there is no retained
authorization Boolean. Explicit abandonment of a pending renewal permits a new
online operation without revoking server issuance or lowering the revision floor.

Native transport classification belongs to the owning renewal client. A denial
must be authenticated and associated with this session's pinned server/binding/
key context. Such a denial stops accepted and pending authority even if it came
from a superseded operation: operation age alone cannot date a policy decision.
Late successful responses require the current pending operation. Beginning a new
request after denial does not restore access; a fresh verified acceptance does.
The internal session can export an exact signed lease as a restart checkpoint.
A separate resume verifier authenticates its envelope, active signer, configured
issuer/audience/application/feature and locally derived device key. Its output
contains only binding identity, generation and revision floor. It checks timestamp
grammar but makes no current-validity decision; an expired checkpoint can identify
a binding for renewal. Normal lease verification still rejects expired leases.

Resume always starts online-only, without an accepted lease or pending clock
anchor. A fresh online operation and proof are required before protected work.
The saved operation ID is never restored. Unknown or retired signers, altered
records and another device key are rejected. A checkpoint restored from an older
backup is not rollback-proof and still needs current server authorization.

New verified responses publish their signed checkpoint together with the revision
floor before later possession or final-clock checks. Provider failure, continuity
loss, abandonment and denial retain that checkpoint. Checking an older accepted
lease cannot overwrite it. Equal-revision replacement is allowed for a newly
verified response, supporting signer rotation. Checkpoint import/export is still
internal. Enrollment and desktop owners expose it even while bootstrap awaits
retry after a provider failure, before client handoff. The public owner uses a
typed capture result to distinguish absence from busy or failed capture.

The internal checkpoint coordinator compares authenticated records by revision,
then signed issue time. Exact bytes are idempotent. Independent requests issued
in the same second can differ only in operation and lease IDs when all signed
identity, signer, revision and validity fields match; these are equivalent
resume checkpoints and can be mirrored normally. Other equal-ordering differences
conflict, including signer or validity changes. This equivalence never restores
an operation's clock anchor or grants work authority after restart.
Binding, fingerprint and generation must match. Every
present committed slot must authenticate, including a secondary slot; corrupt
or untrusted records cannot be silently discarded in favor of an older copy.

Through a private storage interface, the coordinator holds one namespace lock
while reading, selecting and publishing. It keeps the winning slot untouched
while publishing into the other slot, reads back the result even after a reported
publication error, then mirrors the new winner. It distinguishes a known mirror
failure from uncertain publication and never attempts blind rollback. A repeated
save can complete a missing mirror. Visible bytes after an error cannot establish
durability or permit mirroring: the platform must acknowledge checked flushing
and publication, including stabilization of the retained slot before replacement.
An idempotent save also asks the platform to confirm and stabilize both existing
slots; byte equality alone cannot resolve an earlier uncertain mirror result.
Both copies must migrate during signing-key overlap before retiring the old signer.

The internal Windows filesystem adapter stores two bounded committed files below
the actual user's LocalAppData, using a configuration-derived namespace that
does not change with signing-key rotation or device-key loss. It requires local
NTFS and protected current-user/SYSTEM permissions on library-owned directories
and files. It pins every ancestor against rename, rejects reparse points and
hard-linked files, and rechecks private directory permissions during operations.
Unexpected permissions fail closed; the adapter does not repair them.

A stable lock file coordinates processes with bounded lock admission. Publication
uses checked staging writes, flushing, same-directory replacement and readback;
staging is never a resume source. Real-file tests exercise permissions, path
pinning, independent-process contention and lock-owner termination. Injected OS
failures cover writes, flushes, replacement, readback and mirroring. These tests
use a private test root, not the production LocalAppData directory. Hard-power-loss
durability and live installed-consumer restart behavior
remain qualification requirements.

Windows browser launch and flow/listener composition are connected to the public
owner. Native comparison display is demonstrated by the installed example.
Tests use ephemeral RSA signers and the explicit software
provider; they do not replace the physical hardware release gate.

The internal renewal wire codec serializes the pending challenge/renewal intent
and validates bounded response bodies. Its JSON subset rejects duplicate decoded
keys, unsafe integer forms, invalid Unicode and excessive depth. Response schemas
and HTTP status/code combinations are checked together. Unsigned renewal echoes
must agree with the parsed lease; only the session's later signature and context
checks can authorize it. Tracing IDs are bounded text and may refer to an original
recovered response, so they are never used for operation correlation.

Expired challenges preserve the pending operation for a fresh challenge.
Idempotency conflicts remain explicit conflicts, since the backend code can mean
either changed intent or unavailable recovery; the codec does not silently start
a new operation or change authority. Unknown status/code combinations are invalid
responses. The HTTP owner must authenticate the configured endpoint and associate
the response with its outbound request before applying a classified denial.
Shared wire vectors are checked by both native and backend tests.

The internal ``BoundRenewalClient`` owns the session and fixed-origin transport.
One renewal runs at a time; network I/O does not hold the session authority lock.
Retries preserve the pending operation and original timing anchor. Only a
complete authenticated response may apply a typed denial, and only verified
session acceptance establishes authority. Conflict requires explicit resolution;
local abandonment is available without changing server allocations or holds.

An enrollment session starts without a binding, fingerprint or generation.
Its local configuration pins issuer, lease/proof audiences, project and feature;
the device key ID comes from its owned native provider. The native consent owner
supplies the approval code, PKCE verifier and exact loopback callback in one
immutable exchange draft. The session generates an operation ID and timing anchor
before requesting an exchange challenge. A retry must match every draft field.

The first lease introduces a binding only after signature, fixed context,
operation and time verification. Those authenticated binding/fingerprint/
generation pins and the revision floor survive a later provider or final-time
failure. Local possession and a final anchor check are still required for access.
Successful bootstrap uses the same owning session for ordinary renewal.
Explicit abandonment or lost continuity after discovering a verified binding
allows fresh online renewal of that binding, without restoring authority or
lowering the revision floor. A denial before discovering a binding requires
a new enrollment owner. Expired/unavailable authorization ends the attempt;
it is distinct from revocation of an already authenticated binding.
The client reports ``renewal_required`` when that attempt had already established
verified binding pins, and ``enrollment_required`` when it remains unbound. Neither
outcome grants access or discards the retained revision floor.

Native-owned exchange copies and serialized request buffers have wiping owners.
Allocations are completed before copying secrets into those buffers, and the
transport borrows their view synchronously through response completion and handle
closure. This guarantee does not extend to OS/network buffers or caller-owned
input. The pilot callback codec accepts explicit ``127.0.0.1`` or ``[::1]``, a
canonical non-default port, and unescaped ASCII path segments; it rejects query,
fragment, dot segments and alternate loopback spellings. Registration must still
pin the exact callback path. The internal ``BoundEnrollmentFlow`` generates
independent state and PKCE verifier values from the native platform RNG,
registers the S256 challenge, and pins the returned URL to the configured portal
path and returned attempt handle. It independently recomputes the comparison
code before publishing browser metadata. Device labels are trimmed with the
backend's ECMAScript whitespace rules and must contain 1–80 Unicode code points
after trimming. Registration retries preserve their original inputs and
five-minute inclusive-clock deadline.

The owner accepts exactly one canonical code/state callback for the registered
loopback URI. Invalid callbacks leave the valid attempt usable; duplicates
cannot replace its code. A pending exchange can recover with the same operation
for up to 48 hours from the first owned attempt. This secret deadline is checked
lazily on callback/activation entry and before a delayed retry returns, without
a background erasure timer. Cancellation/destruction also clear owned secrets.
Cancellation reports busy during synchronous I/O and cannot undo a server-side
allocation. Bootstrap clock loss requires a new enrollment while unbound, or
fresh online renewal when verified binding pins survive.

The internal Windows ``BoundLoopbackListener`` opens an exclusive ephemeral
socket on explicitly selected IPv4 or IPv6 loopback. Both listener and accepted
sockets are noninheritable; IPv6 is restricted to IPv6. Its strict HTTP codec
accepts only a bodyless HTTP/1.1 GET with the exact registered path and one
matching Host header. Four bounded connection slots prevent one idle browser
preconnection from blocking a valid callback. Each request has at most 8 KiB
of headers and an original five-second connection deadline. The listener's
five-minute deadline starts before registration and is never renewed by retry.
The default clock is Windows ``GetTickCount64``; a private test clock cannot
replace the separate enrollment or lease-authority clocks.

Only the enrollment owner's state verification can accept a callback. Busy
flow admission retains the complete bounded request until its original deadline.
The listener closes after acceptance even if sending the static response fails.
Both success and rejection pages use no-store/no-referrer headers and a fixed
CSP-authorized script to remove the query from browser history. This requires
the browser to receive and execute the response; it does not erase OS/network
buffers or history from a browser that blocks script execution.

Closing the listener cancels only its sockets. The internal Windows
``BoundDesktopEnrollment`` owns the flow, listener and browser launcher together.
It checks both original deadlines before publishing the prepared view and before
and after shell submission. The application must display the native comparison
before calling ``launch()`` and retain it during consent; returning the view does
not prove that the user saw or compared it. A caller cannot change the owner's
pinned URL by modifying its copy of the view.

The launcher uses a dedicated COM apartment and submits only the configured
HTTPS portal path with the validated attempt handle. ``opened`` means successful
shell submission, not successful navigation or authentication. Shell failure can
be ambiguous, so the same prepared attempt remains available for retry or callback
receipt. Windows can still show security prompts. Shell submission and pending
accept cancellation have no hard OS completion bound; cancellation reports busy
while another synchronous operation holds the owner.

After callback acceptance, the owner closes the browser route and lets the flow
govern exchange recovery independently of the listener deadline. It transfers a
verified client exactly once, including a client that needs online renewal or
remains denied. Cancellation clears owned enrollment state and closes sockets;
it does not delete the device key or undo server allocation. Pending Windows
accept I/O is observed complete before its memory is released. The live installed
application journey remains a qualification requirement. Shell tests replace OS
side effects; they do not demonstrate real
browser navigation.

The Windows adapter uses WinHTTP with normal OS certificate/name validation,
revocation checking, TLS 1.2/1.3, and checked disabling of redirects, cookies,
automatic credentials, cross-session pooling and protocol fallback. Configuration
is a canonical lowercase HTTPS DNS origin with an optional non-default port;
paths, credentials, query/fragment and IP literals/aliases are rejected. This
origin is pinned local routing configuration, separate from the signed issuer
and proof/lease audience values. Responses cannot change it. Unsupported
security options fail closed; older Windows compatibility is not yet certified.
Windows Server 2022 rejects the required
``WINHTTP_OPTION_DISABLE_GLOBAL_POOLING`` option, so protected enrollment and
renewal are unavailable there. Protected-device CI uses Windows Server 2025
with Visual Studio 2026, explicitly selected for the core and installed bridges;
the legacy licensing builds retain Windows Server 2022 coverage. This does not
establish a minimum supported Windows desktop version; desktop qualification
remains separate from hosted CI.
There is no production transport on non-Windows platforms in this pilot.

Headers and bodies are bounded to 16 KiB. Representation checks reject redirects,
ambiguous content headers, compression, conflicting transfer/length framing and
truncated declared lengths. A 30-second elapsed acceptance budget is checked
between blocking phases and reads, with shrinking finite phase timeouts. This
is not a hard cancellation deadline: OS name resolution, proxy discovery or
multiple connection attempts can delay a synchronous call. Call renewal on an
application worker thread; end-to-end cancellation and minimum-OS/network
qualification remain release work. Deterministic Windows API-shim tests exercise
the actual adapter's failure paths but do not prove real certificate validation
or replace the installed application/network/hardware release journey.

The public desktop API composes these internal signing and enforcement components.
The enrollment owner must supply its pinned server/callback context and the
local provider key identity; encoding a value does not establish trust in it.
See :doc:`device_enrollment` for the staged browser/native contract.
Exchange transcript scratch buffers use bounded, wipe-on-destruction storage;
the caller remains responsible for its code/verifier input storage and copies.

Generated C reference
---------------------

.. doxygengroup:: deviceidentity
   :content-only:

.. doxygengroup:: devicebound
   :content-only:

Linux protected desktop requirements
------------------------------------

Build with ``LCC_ENABLE_TPM2_OPENSSL=ON``. Linux requires OpenSSL 3 with the
TPM2 provider, TPM device permissions, libcurl 7.85 or newer with HTTPS support,
a system CA trust store, and the first ``xdg-open`` on an absolute ``PATH``
entry for browser consent. Use a local filesystem supporting ``flock``,
atomic rename and directory ``fsync``.
The user must have a desktop browser on the same machine as the callback
listener. Failure to start the opener returns ``BROWSER_UNAVAILABLE``. A successful
launch only starts consent; if the desktop cannot open a browser, the attempt
remains pending and can be retried. Launching a browser grants no access.

On Linux the callback listener accepts connections only from sockets owned by
the same user, proven through ``/proc/self/net/tcp`` and ``tcp6``; without a
readable ``/proc`` the callback is refused. The consent URL is passed to
``xdg-open`` as an argument, so other local users can see it. They cannot
complete enrollment for you, but they can use up the attempt, which then shows
as a refused approval. Start a new attempt if that happens.

The native owner obtains the home directory from the OS account database.
It uses ``~/.licensecc/device-keys`` for TPM-wrapped key references and
``~/.licensecc/checkpoint-<namespace-hash>`` for signed checkpoints. Directories
are private (0700), files are private (0600), and symbolic links, hard-linked
files, changed ownership and unsafe permissions are rejected. The one
exception: under the storage lock, the library removes a second link left by
its own interrupted publish or delete. The application cannot override these
paths through the public protected API. Do not copy or remove these files to
bypass enrollment or recover a lost key.

Linux uses ``CLOCK_BOOTTIME`` bracketed by ``CLOCK_MONOTONIC`` readings in the
same 100-nanosecond units as Windows. Suspend, fork, clock discontinuity or a
process restart requires fresh online permission. Checkpoints contain signed
recovery state, not restored authority. Linux desktop/browser/TLS and physical
TPM qualification remains distinct from simulator and local integration tests.

The Linux desktop adapters default ``ON`` only when a device-key provider is
enabled (``LCC_ENABLE_TPM2_OPENSSL=ON``, or the test-only
``LCC_BUILD_DEVICE_IDENTITY_TEST_PROVIDER=ON``); otherwise they default
``OFF``. Setting ``LCC_ENABLE_LINUX_DESKTOP=ON`` without either provider stops
the configure with a ``FATAL_ERROR``. For a provider-only runtime (including
Ubuntu 22.04 with its older system curl), leave ``LCC_ENABLE_LINUX_DESKTOP=OFF``
(the default). The low-level TPM proof API remains available; public protected
enrollment and feature-session opens then return ``UNSUPPORTED_PLATFORM``.
Desktop builds require libcurl >= 7.85 with thread-safe global initialization
and asynchronous DNS support; configuring with an older libcurl stops with a
``FATAL_ERROR`` naming the version found.
