###############################
Signed configuration tokens
###############################

Config attestation lets a server sign a blob of configuration bytes and bind
that signature to a valid local license. The application verifies the signed
token offline, in C++, before it trusts the configuration. Use it when a
config file (feature flags, limits, entitlement parameters) must be proven to
come from you and must not be honored on a machine that has no valid license.

This is an optional hardening feature. It is independent from the offline
license check and from online verification: a config token is only honored when
the local license is also valid.

How it works
*************

The server (or your build/release tooling) signs the exact configuration bytes
and produces a token. The client passes both the token and the same bytes to
``lcc_verify_config``. The verifier:

#. reads the one local license and checks it is valid,
#. verifies the token signature against the embedded config-attestation trust
   ring,
#. hashes the supplied ``config_bytes`` and compares the hash to the signed
   ``config-hash``,
#. checks binding (project, feature, license fingerprint, and optional device
   hash), the time window, and the rollback floor.

The configuration is honored only when every step passes. Any failure returns a
``LICENSE_CONFIG_*`` code (or the underlying license failure) and sets the
decision to deny.

Token format
============

A config token is an envelope of three dot-separated parts::

  lcccfg1.<base64url-payload>.<base64url-signature>

The signature algorithm is ``rsa-pkcs1-sha256`` (``RSASSA-PKCS1-v1_5`` with
``SHA-256``). The signed payload carries the ``key-id``
(``sha256:<64-hex>`` of the public key), the ``config-hash``
(``sha256:<hex>`` of the configuration bytes), the binding fields, and the
validity window. The token never contains the configuration itself; the
application always supplies the bytes separately.

Issue a token
*************

Config tokens are signed offline by the tooling in
``services/cloudflare-licensing-backend``. Unlike the online assertion, no
Cloudflare Worker endpoint issues these; they are produced by the
``config-sign.mjs`` script and consumed in C++.

.. code-block:: console

  node services/cloudflare-licensing-backend/scripts/config-sign.mjs \
    --private-key signing-key.pkcs8.pem \
    --key-id sha256:<64-hex-of-public-key> \
    --fingerprint <64-hex-license-fingerprint> \
    --config app-config.json \
    --config-id app-config \
    --config-seq 7 \
    --expires-at 1750000000 \
    [--project DEFAULT] [--feature DEFAULT] \
    [--device-hash <64-hex>] [--issued-at <epoch>]

Notes:

* ``--expires-at`` is required and must be greater than ``--issued-at``. A value
  of ``0`` is rejected; config tokens must carry a finite expiry, matching the
  C++ verifier.
* ``--config-seq`` is a monotonic counter per ``--config-id``. Raise it whenever
  you publish a new config so older tokens are refused by the rollback floor.
* ``--fingerprint`` binds the token to one license. ``--device-hash`` optionally
  binds it to one device.

Trust the signing key in the build
***********************************

The client only trusts config tokens signed by keys baked into the binary at
configure time. Provide the trusted public key(s) through CMake:

.. code-block:: console

  cmake .. \
    -DLCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS="<SignaturePublicKey record(s)>" \
    -DLCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS="\"sha256:<retired-key-id>\""

* ``LCC_CONFIG_ATTESTATION_PUBLIC_KEY_RECORDS`` is a C++ initializer list of
  ``license::os::SignaturePublicKey`` records trusted for config tokens. With no
  records configured the trust ring is empty and every config token is refused,
  so the feature is fail-closed by default.
* ``LCC_CONFIG_ATTESTATION_RETIRED_KEY_IDS`` is a list of ``key-id`` strings that
  are no longer accepted, for key rotation and retirement.

Verify a token in C++
*********************

``lcc_verify_config`` is the combined entry point. It performs the one license
read for you, so call it instead of ``acquire_license`` when you have a config to
check.

.. code-block:: cpp

  #include <licensecc/licensecc.h>

  LccConfigInput input;
  lcc_init_config_input(&input);
  input.token = token_cstr;            // the "lcccfg1...." envelope
  input.config_bytes = bytes;          // the EXACT bytes you will consume
  input.config_len = bytes_len;
  // Optional: lcc_set_config_device_hash(&input, device_hash_hex);

  LccConfigVerifyOptions options;
  lcc_init_config_verify_options(&options);
  // Optional durable rollback floor: set both callbacks together.
  // options.config_seq_floor_load  = my_load_cb;
  // options.config_seq_floor_store = my_store_cb;
  // options.config_seq_floor_user_data = ctx;

  LicenseInfo license_out;
  LccConfigDecision decision;
  lcc_init_config_decision(&decision);

  LCC_EVENT_TYPE rc = lcc_verify_config(
      &caller, &location, &license_out, &input, &decision, &options);

  if (rc == LICENSE_OK && decision.decision == LCC_LICENSE_DECISION_ALLOW) {
      // Safe to honor config_bytes.
  } else {
      // Deny. Inspect rc / decision.event_type for the reason.
  }

Honor the configuration only when ``rc`` is ``LICENSE_OK`` **and**
``decision.decision`` is ``LCC_LICENSE_DECISION_ALLOW``. Treat any other result
as deny.

Rollback protection
===================

To stop an attacker from replaying an older, signed-but-superseded config,
supply a durable per-config-id floor. Set both
``config_seq_floor_load`` and ``config_seq_floor_store`` (both or neither). The
verifier loads the persisted floor for the verified
``(project, feature, license-fingerprint, config-id)``, denies any token with a
``config-seq`` below ``max(min_config_seq, loaded)`` with
``LICENSE_CONFIG_ROLLBACK``, and stores the accepted maximum. A load or store
failure fails closed. This mirrors the online assertion revocation floor.

Security notes
**************

* **Supply the exact bytes.** The verifier hashes ``config_bytes`` and compares
  to the signed ``config-hash``. Load the exact bytes that were signed: no
  re-serialize, no added byte-order mark, no trailing whitespace.
* **``device_hash`` is not device attestation.** ``decision.bound_to_device``
  only reflects that a caller-supplied ``device_hash`` matched the token; it is
  caller-supplied input, not proof of device possession. For cryptographic
  device binding use the online verifier request-proof (ECDSA device key) path.
* **Fail closed.** With no trusted key configured, an empty or malformed token,
  a bad signature, an expired window, a binding mismatch, or a config below the
  rollback floor, the decision is deny.
