"""licensecc Python client SDK.

Offline token verifier (the security-critical core) — fail-closed
verification of the server-signed ``lcccfg1`` config-attestation token, with
byte-for-byte parity against the C++ verifier and the shared golden vectors:

* :func:`verify_config_token` — the ``lcccfg1`` config-attestation token.

NOT covered here: anti-tamper and hardware fingerprinting. Those are the C++
binary enforcement layer (``licensecc::licensecc_static``); this SDK covers the
token contract only.
"""

from __future__ import annotations

from .config_attestation import (
    ConfigAttestationExpected,
    verify_config_token,
)
from .keys import (
    TrustedPublicKey,
    key_id_from_pkcs1_der,
    load_pkcs1_public_key,
    rsa_public_key_bits,
)
from .results import (
    ConfigAttestationClaims,
    RejectionCode,
    VerificationResult,
)

__version__ = "0.1.0rc2"

__all__ = [
    "__version__",
    # token verifier
    "verify_config_token",
    "ConfigAttestationExpected",
    "ConfigAttestationClaims",
    "VerificationResult",
    "RejectionCode",
    # keys
    "TrustedPublicKey",
    "key_id_from_pkcs1_der",
    "load_pkcs1_public_key",
    "rsa_public_key_bits",
]
