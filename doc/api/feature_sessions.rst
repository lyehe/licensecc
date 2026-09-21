Feature work sessions
=====================

Use a feature work session when each new job must obtain fresh permission from
the licensing Worker. This is an additional native API in
``licensecc/feature_session.h``. Existing device-bound enrollment and renewal
APIs retain their behavior. Windows uses the user-scoped TPM provider; Linux
uses the TPM2/OpenSSL provider. Both expose the same C API and SDK adapters.

One session authorizes one immutable feature, such as ``BATCH_RUN`` or ``EXPORT``.
Feature IDs contain 1–15 ASCII letters, digits, underscores, dots, colons or
hyphens. Display labels can be more descriptive; they are not protocol IDs.

Enrollment and starting work
----------------------------

First enroll each feature with the existing :doc:`device_identity` browser
flow. The app shows its expected feature and includes it in registration.
The portal lists only matching entitlements; approval cannot change the requested
feature. The comparison code binds the feature as well as the app, key and callback.
Older clients that omit the feature retain their project-wide selection behavior.
One approval does not enroll all features.

Features in the same application/project reuse the device key, but have separate
checkpoints and entitlement bindings. Do not create or delete a key when starting
or stopping work. Deleting the shared key affects every feature using it.

For each job:

1. Open a new feature session with developer-owned ``LccDeviceBoundOptions``.
   Open reads the existing key/checkpoint; it creates no key, performs no network
   request and grants no permission.
2. Call ``lcc_feature_session_start``. It requests a fresh server challenge,
   proves device possession, receives a signed lease and verifies it locally.
   Every new session needs this online step, even within the same app process.
3. Immediately before each protected work unit, including the first, call
   ``lcc_feature_session_authorize`` with the operation's required feature.
   Only ``LCC_BOUND_OK`` permits that unit. Guard the implementation as well as
   updating the UI; command-line and scripting entry points need the same check.
4. When a successful authorization reports ``renewal_due``, renew on the app's
   serialized worker thread, then authorize again before continuing work.
5. Stop and close when the job ends. Stopped handles cannot restart: open a new
   handle for the next job. Stop ends local permission, not device activation.

The installed example in ``examples/device_bound`` provides
``licensecc_feature_sessions``: two consecutive ``BATCH_RUN`` jobs followed by
an ``EXPORT`` job in one process. It uses the real public API and checks both
computation and result publication. Its README describes configuration and
per-feature enrollment commands.

Failures and long-running work
------------------------------

An unresolved start permits no work. Retry that same handle so its operation ID
and original clock anchor remain intact. Starting an unrelated new handle is a
new job, not recovery of a lost response. No cached lease can bypass startup.

During an active session, a transient renewal failure can leave the existing
lease usable until its signed expiration. Call authorize again; a renewal
failure itself never grants permission. Malformed responses and internal errors
pause the new session API until a successful online recovery. Known authority
denial stops the session. No offline allowance extends the signed expiration,
and restarting the process never restores offline permission.

Check at bounded safe points and before publishing protected results. The
library cannot interrupt arbitrary application computation. Run blocking
network operations on an application worker thread, use bounded retry backoff,
and provide cancellation. The coarse ``RETRY`` result may represent a rate
limit; the example uses a conservative 60-second retry interval. No library
renewal thread or browser polling is created.

``checkpoint_result`` is independent of the primary result. A save failure can
coexist with valid current-process permission; a successful save grants none.
Use ``lcc_feature_session_save_checkpoint`` for storage-only recovery of the
exact native-owned statement. Handle stop/capture failures before closing when
the newest statement needs recovery. Never erase checkpoints as a retry tactic.

State and signed deadline fields are advisory snapshots. Only an authorization
result for the next operation is permission. Calls on the same owner must be
serialized; overlapping calls return ``BUSY``. Close requires exclusive ownership
after other calls have returned.

Capacity and compatibility
--------------------------

The Worker uses the existing protected-device endpoints and signed lease format.
Each successful start or renewal normally uses two HTTPS POST requests; local
authorization generates no server traffic. The entitlement's existing
``lease_seconds`` sets the lease duration, bounded by its validity and trial.
Renewal is due at the signed halfway point. Frequent sessions increase signing,
database and retained audit work; choose job boundaries deliberately.

Capacity remains per ``(project, feature, license_fingerprint)`` entitlement.
Repeated jobs on one binding do not consume additional device slots. Two
separately licensed features can consume one slot in each feature's entitlement.
Stop neither retires the binding nor frees its persistent slot. This API does
not impose a concurrent-process limit and does not replace floating-seat
checkout/heartbeat/release. Existing legacy and floating APIs are unchanged.

Python ``licensecc.feature_session``, .NET ``FeatureSessionLibrary`` and Java
``FeatureSessionLibrary`` provide optional opaque native adapters using the
application-owned Windows bridge DLL (JNI for Java). Older DLLs are
explicitly unsupported for this new adapter; their existing device-bound API
remains usable. Adapter tests alone are not proof of a live TPM/server journey.
See the SDK README for installed-bridge validation and current availability.

Generated C reference
---------------------

.. doxygengroup:: featuresession
   :content-only:

Session traffic limits
----------------------

Protected endpoints keep a global 1,000-request/minute ceiling. Registration is
limited to 20 requests/minute per source IP; challenge and issuance traffic share
a separate 600-request/minute IP ceiling so machines behind one NAT can start
short jobs. After proof and current-authority validation, issuance and recovery
share limits of 60 requests/minute per device key and 240 per customer. A job
normally uses two HTTP requests. These limits do not change lease lifetimes or
the existing conservative retry interval.
