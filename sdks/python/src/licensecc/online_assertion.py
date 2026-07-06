"""Verify ``lccoa1`` online-assertion tokens — a port of ``OnlineVerification.cpp``.

The verifier is the security-critical core. It is fail-closed: every rejection
path returns a typed :class:`VerificationResult`, never a raw exception on a bad
token.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field

from ._signed_token import (
    ALG_RSA_PKCS1_SHA256,
    FieldSpec,
    parse_fields_in_order,
    parse_uint64,
    split_envelope,
    verify_payload_signature,
)
from .keys import TrustedPublicKey
from .results import OnlineAssertionClaims, RejectionCode, VerificationResult

ENVELOPE_PREFIX = "lccoa1"
PURPOSE = "licensecc-online-assertion"
VERSION = "1"
ISSUED_AT_FUTURE_SKEW_SECONDS = 300
MIN_PUBLIC_KEY_BITS = 3072

# Field sizes mirror the C++ LCC_API_ONLINE_* limits used by validate_claims.
LICENSE_FINGERPRINT_HEX_LEN = 64
NONCE_HEX_LEN = 64
DEVICE_HASH_HEX_LEN = 64

# Canonical payload field order — must match build_canonical_assertion_payload.
_FIELDS = [
    FieldSpec("purpose"),
    FieldSpec("version"),
    FieldSpec("alg"),
    FieldSpec("key-id"),
    FieldSpec("project"),
    FieldSpec("feature"),
    FieldSpec("license-fingerprint"),
    FieldSpec("device-hash"),
    FieldSpec("nonce"),
    FieldSpec("status"),
    FieldSpec("issued-at"),
    FieldSpec("expires-at"),
    FieldSpec("cache-until"),
    FieldSpec("revocation-seq"),
]


@dataclass
class OnlineAssertionExpected:
    """Caller-supplied expectations for binding + window validation.

    ``project``/``feature``/``license_fingerprint`` are REQUIRED binding values
    (the token's claims must equal them). ``device_hash`` is compared too (pass
    ``""`` when the assertion is not device-bound). ``nonce`` is compared only
    when non-empty (the live-request path supplies a fresh nonce; offline parity
    tests typically leave it empty). ``min_revocation_seq`` is the anti-rollback
    floor. ``now`` defaults to wall-clock; pass a fixed value for deterministic
    tests. ``allow_cache`` + ``max_cache_seconds`` mirror the C++ cache window.
    """

    project: str
    feature: str
    license_fingerprint: str
    device_hash: str = ""
    nonce: str = ""
    min_revocation_seq: int = 0
    now: int | None = None
    allow_cache: bool = False
    max_cache_seconds: int = 0xFFFFFFFFFFFFFFFF
    # When nonce is empty the caller does not pin the nonce; only its shape is
    # validated. Set check_nonce_binding True together with a non-empty nonce to
    # require an exact match (the live-request behaviour).
    check_nonce_binding: bool = False


def _is_ascii_hex(value: str, expected_len: int) -> bool:
    if len(value) != expected_len:
        return False
    return all(c in "0123456789abcdefABCDEF" for c in value)


def _parse_canonical_payload(payload_text: str):
    if not payload_text or payload_text[-1] != "\n" or "\r" in payload_text:
        return None, VerificationResult.reject(
            RejectionCode.PAYLOAD_NOT_CANONICAL, "payload is not canonical"
        )
    values, rejection = parse_fields_in_order(payload_text, _FIELDS, validate_values=True)
    if rejection is not None:
        return None, rejection

    issued_at = parse_uint64(values["issued-at"])
    expires_at = parse_uint64(values["expires-at"])
    cache_until = parse_uint64(values["cache-until"])
    revocation_seq = parse_uint64(values["revocation-seq"])
    if None in (issued_at, expires_at, cache_until, revocation_seq):
        return None, VerificationResult.reject(
            RejectionCode.INTEGER_FIELD_MALFORMED, "integer field malformed"
        )

    claims = OnlineAssertionClaims(
        purpose=values["purpose"],
        version=values["version"],
        algorithm=values["alg"],
        key_id=values["key-id"],
        project=values["project"],
        feature=values["feature"],
        license_fingerprint=values["license-fingerprint"],
        device_hash=values["device-hash"],
        nonce=values["nonce"],
        status=values["status"],
        issued_at=issued_at,
        expires_at=expires_at,
        cache_until=cache_until,
        revocation_seq=revocation_seq,
    )
    return claims, None


def _validate_claims(claims: OnlineAssertionClaims, expected: OnlineAssertionExpected):
    now = expected.now if expected.now is not None else int(time.time())

    if (
        claims.purpose != PURPOSE
        or claims.version != VERSION
        or claims.algorithm != ALG_RSA_PKCS1_SHA256
    ):
        return VerificationResult.reject(RejectionCode.METADATA_MISMATCH, "metadata mismatch"), False
    if claims.status not in ("ok", "denied"):
        return VerificationResult.reject(RejectionCode.STATUS_UNSUPPORTED, "status unsupported"), False
    if claims.status == "denied":
        return VerificationResult.reject(RejectionCode.STATUS_DENIED, "denied entitlement"), False

    if (
        claims.project != expected.project
        or claims.feature != expected.feature
        or claims.license_fingerprint != expected.license_fingerprint
        or claims.device_hash != expected.device_hash
    ):
        return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "request binding mismatch"), False

    if not _is_ascii_hex(claims.license_fingerprint, LICENSE_FINGERPRINT_HEX_LEN) or not _is_ascii_hex(
        claims.nonce, NONCE_HEX_LEN
    ):
        return VerificationResult.reject(RejectionCode.HEX_FIELD_MALFORMED, "hex field malformed"), False
    if claims.device_hash and not _is_ascii_hex(claims.device_hash, DEVICE_HASH_HEX_LEN):
        return VerificationResult.reject(RejectionCode.HEX_FIELD_MALFORMED, "device hash malformed"), False

    if (
        claims.issued_at > now + ISSUED_AT_FUTURE_SKEW_SECONDS
        or claims.expires_at < claims.issued_at
        or claims.cache_until < claims.expires_at
    ):
        return VerificationResult.reject(RejectionCode.TIME_WINDOW_MALFORMED, "time window malformed"), False
    if claims.cache_until - claims.issued_at > expected.max_cache_seconds:
        return VerificationResult.reject(RejectionCode.CACHE_WINDOW_EXCEEDED, "cache window exceeds maximum"), False
    if claims.revocation_seq < expected.min_revocation_seq:
        return VerificationResult.reject(RejectionCode.REVOCATION_BELOW_FLOOR, "revocation sequence below minimum"), False

    # Nonce binding: the live path supplies a fresh nonce and requires an exact
    # match (falling back to cache when it differs). For offline parity we only
    # enforce the match when the caller pins one.
    if expected.check_nonce_binding and claims.nonce != expected.nonce:
        if expected.allow_cache and claims.cache_until >= now:
            return None, True
        return VerificationResult.reject(RejectionCode.BINDING_MISMATCH, "request binding mismatch"), False

    if claims.expires_at >= now:
        return None, False
    if expected.allow_cache and claims.cache_until >= now:
        return None, True
    detail = "cache expired" if expected.allow_cache else "expired"
    return VerificationResult.reject(RejectionCode.EXPIRED, detail), False


def verify_online_assertion(
    token: str,
    expected: OnlineAssertionExpected,
    trusted_keys: list[TrustedPublicKey],
    retired_key_ids: "set[str] | None" = None,
) -> VerificationResult:
    """Verify an ``lccoa1`` token end-to-end. Returns a typed result, never raises.

    Order of checks (fail-closed, matching the C++ verifier):
      1. split + base64-decode the 3-part envelope (prefix/arity/canonical b64),
      2. RSA-PKCS1-SHA256 verify against the key selected by ``key-id`` (a
         ``retired_key_ids`` key-id is rejected before crypto),
      3. parse the canonical payload (order/duplicates/trailing/values),
      4. validate claims (purpose/alg/version/status, binding, hex shape, time
         window, cache window, revocation floor).
    """
    envelope, rejection = split_envelope(token, ENVELOPE_PREFIX)
    if rejection is not None:
        return rejection

    rejection = verify_payload_signature(
        envelope.payload_bytes,
        envelope.payload_text,
        envelope.signature_bytes,
        trusted_keys,
        MIN_PUBLIC_KEY_BITS,
        retired_key_ids,
    )
    if rejection is not None:
        return rejection

    claims, rejection = _parse_canonical_payload(envelope.payload_text)
    if rejection is not None:
        return rejection

    rejection, used_cache = _validate_claims(claims, expected)
    if rejection is not None:
        return rejection

    return VerificationResult.accept(claims, used_cache=used_cache)
