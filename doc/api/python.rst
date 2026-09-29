Python SDK API
==============

The Python package verifies ``lcccfg1`` configuration-attestation tokens
offline. Invalid untrusted tokens return a typed rejection result; they are
not raised as verifier exceptions.

The package does not implement local ``.lic`` acquisition, anti-tamper,
hardware fingerprinting, or TPM-backed device identity. Use the C runtime for
those enforcement surfaces.

Verification entry points
-------------------------

.. py:currentmodule:: licensecc

.. autofunction:: verify_config_token

Expected values and results
---------------------------

.. autoclass:: ConfigAttestationExpected
   :members:

.. autoclass:: VerificationResult
   :members:

.. autoclass:: RejectionCode
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
