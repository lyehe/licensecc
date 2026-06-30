"""licensecc Python client SDK.

Two surfaces:

1. **Offline token verifier** (the security-critical core) — fail-closed
   verification of the server-signed tokens, with byte-for-byte parity against
   the C++ verifier and the shared golden vectors:

   * :func:`verify_online_assertion` — the ``lccoa1`` online-assertion token
     (the verifier's primary target).
   * :func:`verify_config_token` — the ``lcccfg1`` config-attestation token.

2. **Thin HTTP client** — :class:`HttpClient`, small hand-written wrappers over
   the documented client-facing Worker endpoints (``/v1/verify``, ``/v1/activate``,
   ``/v1/renew``, ``/v1/checkout``, ``/v1/heartbeat``, ``/v1/release``), parsing
   the FLAT ``{ ok, code, ... }`` response envelope.

NOT covered here: anti-tamper and hardware fingerprinting. Those are the C++
binary enforcement layer (``licensecc::licensecc_static``); this SDK covers the
HTTP + token contract only.
"""

from __future__ import annotations

from .config_attestation import (
    ConfigAttestationExpected,
    verify_config_token,
)
from .http_client import ApiResponse, HttpClient
from .keys import (
    TrustedPublicKey,
    key_id_from_pkcs1_der,
    load_pkcs1_public_key,
    rsa_public_key_bits,
)
from .online_assertion import (
    OnlineAssertionExpected,
    verify_online_assertion,
)
from .results import (
    ConfigAttestationClaims,
    OnlineAssertionClaims,
    RejectionCode,
    VerificationResult,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # token verifier
    "verify_online_assertion",
    "verify_config_token",
    "OnlineAssertionExpected",
    "ConfigAttestationExpected",
    "OnlineAssertionClaims",
    "ConfigAttestationClaims",
    "VerificationResult",
    "RejectionCode",
    # keys
    "TrustedPublicKey",
    "key_id_from_pkcs1_der",
    "load_pkcs1_public_key",
    "rsa_public_key_bits",
    # http client
    "HttpClient",
    "ApiResponse",
]
