"""Typed verification results and rejection codes.

The verifier NEVER raises on a bad token. Every rejection is a typed
``VerificationResult(ok=False, code=...)``. ``RejectionCode`` enumerates the
fail-closed reasons, mirroring the C++ verifier's failure branches.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class RejectionCode(str, enum.Enum):
    """Why a token was rejected (fail-closed). Stable string values."""

    # Envelope / encoding
    ENVELOPE_MALFORMED = "envelope_malformed"
    PREFIX_MISMATCH = "prefix_mismatch"
    BASE64_NOT_CANONICAL = "base64_not_canonical"
    EMPTY_PAYLOAD_OR_SIGNATURE = "empty_payload_or_signature"

    # Signature / key selection
    UNKNOWN_KEY_ID = "unknown_key_id"
    RETIRED_KEY_ID = "retired_key_id"
    SIGNATURE_INVALID = "signature_invalid"
    KEY_TOO_WEAK = "key_too_weak"
    MISSING_SIGNATURE_METADATA = "missing_signature_metadata"

    # Canonical payload parse
    PAYLOAD_NOT_CANONICAL = "payload_not_canonical"
    FIELD_MISSING = "field_missing"
    FIELD_UNEXPECTED = "field_unexpected"
    TRAILING_FIELDS = "trailing_fields"
    INVALID_FIELD_VALUE = "invalid_field_value"
    INTEGER_FIELD_MALFORMED = "integer_field_malformed"

    # Claim validation
    METADATA_MISMATCH = "metadata_mismatch"
    BINDING_MISMATCH = "binding_mismatch"
    EXPIRED = "expired"
    ROLLBACK_BELOW_FLOOR = "rollback_below_floor"
    CONFIG_HASH_MISMATCH = "config_hash_mismatch"
    NO_EXPIRY = "no_expiry"


@dataclass(frozen=True)
class ConfigAttestationClaims:
    """Parsed claims of an ``lcccfg1`` config-attestation token."""

    purpose: str
    version: str
    algorithm: str
    key_id: str
    project: str
    feature: str
    license_fingerprint: str
    device_hash: str
    config_id: str
    config_seq: int
    config_hash: str
    issued_at: int
    expires_at: int


@dataclass(frozen=True)
class VerificationResult:
    """Outcome of verifying a token.

    On success ``ok`` is True and ``claims`` is populated. On failure ``ok`` is
    False, ``code`` is a :class:`RejectionCode`, and ``detail`` carries a
    human-readable reason. Truthiness mirrors ``ok``.
    """

    ok: bool
    code: RejectionCode | None = None
    detail: str = ""
    claims: object | None = None  # ConfigAttestationClaims

    def __bool__(self) -> bool:
        return self.ok

    @classmethod
    def reject(cls, code: RejectionCode, detail: str = "") -> "VerificationResult":
        return cls(ok=False, code=code, detail=detail or code.value)

    @classmethod
    def accept(cls, claims: object) -> "VerificationResult":
        return cls(ok=True, claims=claims)
