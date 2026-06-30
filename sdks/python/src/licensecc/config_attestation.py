"""Verify ``lcccfg1`` config-attestation tokens — a port of ``ConfigAttestation.cpp``.

Same envelope/canonical-payload discipline as the online assertion, with a
config-attestation purpose and a ``config-hash`` claim that binds the token to
the exact config bytes. Fail-closed: typed rejection, never a raw exception.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from ._signed_token import (
    ALG_RSA_PKCS1_SHA256,
    FieldSpec,
    parse_fields_in_order,
    parse_uint64,
    split_envelope,
    verify_payload_signature,
)
from .keys import TrustedPublicKey
from .results import ConfigAttestationClaims, RejectionCode, VerificationResult

ENVELOPE_PREFIX = "lcccfg1"
PURPOSE = "licensecc-config-attestation"
VERSION = "1"
ISSUED_AT_FUTURE_SKEW_SECONDS = 300
MIN_PUBLIC_KEY_BITS = 3072

# Canonical payload field order — must match build_canonical_config_payload.
_FIELDS = [
    FieldSpec("purpose"),
    FieldSpec("version"),
    FieldSpec("alg"),
    FieldSpec("key-id"),
    FieldSpec("project"),
    FieldSpec("feature"),
    FieldSpec("license-fingerprint"),
    FieldSpec("device-hash"),
    FieldSpec("config-id"),
    FieldSpec("config-seq"),
    FieldSpec("config-hash"),
    FieldSpec("issued-at"),
    FieldSpec("expires-at"),
]


@dataclass
class ConfigAttestationExpected:
    """Caller-supplied expectations for a config token.

    ``config_bytes`` are the EXACT bytes the token must attest (its
    ``config-hash`` must equal ``sha256:`` + sha256(config_bytes)).
    ``project``/``feature``/``license_fingerprint``/``device_hash`` are binding
    values. ``min_config_seq`` is the anti-rollback floor. ``now`` defaults to
    wall-clock; pass a fixed value for deterministic tests.
    """

    config_bytes: bytes
    project: str
    feature: str
    license_fingerprint: str
    device_hash: str = ""
    min_config_seq: int = 0
    now: int | None = None


def _parse_canonical_payload(payload_text: str):
    if not payload_text or payload_text[-1] != "\n" or "\r" in payload_text:
        return None, VerificationResult.reject(
            RejectionCode.PAYLOAD_NOT_CANONICAL, "payload is not canonical"
        )
    # Config payload uses validate_values=False (matches the C++ call).
    values, rejection = parse_fields_in_order(payload_text, _FIELDS, validate_values=False)
    if rejection is not None:
        return None, rejection

    config_seq = parse_uint64(values["config-seq"])
    issued_at = parse_uint64(values["issued-at"])
    expires_at = parse_uint64(values["expires-at"])
    if None in (config_seq, issued_at, expires_at):
        return None, VerificationResult.reject(
            RejectionCode.INTEGER_FIELD_MALFORMED, "integer field malformed"
        )

    claims = ConfigAttestationClaims(
        purpose=values["purpose"],
        version=values["version"],
        algorithm=values["alg"],
        key_id=values["key-id"],
        project=values["project"],
        feature=values["feature"],
        license_fingerprint=values["license-fingerprint"],
        device_hash=values["device-hash"],
        config_id=values["config-id"],
        config_seq=config_seq,
        config_hash=values["config-hash"],
        issued_at=issued_at,
        expires_at=expires_at,
    )
    return claims, None


def _validate_claims(claims: ConfigAttestationClaims, expected: ConfigAttestationExpected):
    if (
        claims.purpose != PURPOSE
        or claims.version != VERSION
        or claims.algorithm != ALG_RSA_PKCS1_SHA256
    ):
        return VerificationResult.reject(RejectionCode.METADATA_MISMATCH, "metadata mismatch")
    if (
        claims.project != expected.project
        or claims.feature != expected.feature
        or claims.license_fingerprint != expected.license_fingerprint
        or claims.device_hash != expected.device_hash
    ):
        return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "request binding mismatch")

    expected_hash = "sha256:" + hashlib.sha256(expected.config_bytes).hexdigest()
    if claims.config_hash != expected_hash:
        return VerificationResult.reject(
            RejectionCode.CONFIG_HASH_MISMATCH, "hash does not match config bytes"
        )

    now = expected.now if expected.now is not None else int(time.time())
    if claims.issued_at > now + ISSUED_AT_FUTURE_SKEW_SECONDS:
        return VerificationResult.reject(RejectionCode.EXPIRED, "issued in the future")
    if claims.expires_at == 0:
        # Never-expiring config tokens are rejected: every config token must
        # carry a finite expiry, matching the C++ verifier.
        return VerificationResult.reject(RejectionCode.NO_EXPIRY, "config token has no expiry")
    if claims.expires_at < claims.issued_at or claims.expires_at < now:
        return VerificationResult.reject(RejectionCode.EXPIRED, "expired")
    if claims.config_seq < expected.min_config_seq:
        return VerificationResult.reject(RejectionCode.ROLLBACK_BELOW_FLOOR, "sequence below the minimum")
    return None


def verify_config_token(
    token: str,
    expected: ConfigAttestationExpected,
    trusted_keys: list[TrustedPublicKey],
) -> VerificationResult:
    """Verify an ``lcccfg1`` token end-to-end. Returns a typed result, never raises."""
    envelope, rejection = split_envelope(token, ENVELOPE_PREFIX)
    if rejection is not None:
        return rejection

    rejection = verify_payload_signature(
        envelope.payload_bytes,
        envelope.payload_text,
        envelope.signature_bytes,
        trusted_keys,
        MIN_PUBLIC_KEY_BITS,
    )
    if rejection is not None:
        return rejection

    claims, rejection = _parse_canonical_payload(envelope.payload_text)
    if rejection is not None:
        return rejection

    rejection = _validate_claims(claims, expected)
    if rejection is not None:
        return rejection

    return VerificationResult.accept(claims)
