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

Generated C reference
---------------------

.. doxygengroup:: deviceidentity
   :content-only:
