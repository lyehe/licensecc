Python SDK API
==============

The Python package verifies ``lccoa1`` online assertions and ``lcccfg1``
configuration attestations offline, and provides a thin HTTP client for the
licensing backend. Invalid untrusted tokens return a typed rejection result;
they are not raised as verifier exceptions.

The package does not implement local ``.lic`` acquisition, anti-tamper,
hardware fingerprinting, or TPM-backed device identity. Use the C runtime for
those enforcement surfaces.

Verification entry points
-------------------------

.. py:currentmodule:: licensecc

.. autofunction:: verify_online_assertion

.. autofunction:: verify_config_token

Expected values and results
---------------------------

.. autoclass:: OnlineAssertionExpected
   :members:

.. autoclass:: ConfigAttestationExpected
   :members:

.. autoclass:: VerificationResult
   :members:

.. autoclass:: RejectionCode
   :members:

.. autoclass:: OnlineAssertionClaims
   :members:

.. autoclass:: ConfigAttestationClaims
   :members:

Trusted keys
------------

.. autoclass:: TrustedPublicKey
   :members:

.. autofunction:: key_id_from_pkcs1_der

.. autofunction:: load_pkcs1_public_key

.. autofunction:: rsa_public_key_bits

HTTP client
-----------

.. autoclass:: HttpClient
   :members:

.. autoclass:: ApiResponse
   :members:
