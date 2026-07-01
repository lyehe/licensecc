"""Shared signed-token core — a port of ``src/library/signed_token/SignedToken.cpp``.

Both the ``lccoa1`` online-assertion and ``lcccfg1`` config-attestation tokens
share this plumbing:

  * ``split_envelope`` — ``<prefix>.<b64-payload>.<b64-sig>`` with EXACTLY two
    dots (a third dot is malformed), canonical standard base64 on both parts.
  * ``parse_fields_in_order`` — the canonical payload is a newline-terminated
    list of ``key=value`` lines in a FIXED order; any missing/unexpected key,
    trailing field, or (optionally) a value containing ``=``/CR/LF is rejected.
  * ``verify_payload_signature`` — RSASSA-PKCS1-v1_5 + SHA-256 over the raw
    payload bytes, against the trusted key SELECTED BY the payload's ``key-id``
    (unknown key-id -> reject; key below the bit floor -> reject).

Everything here returns a typed rejection rather than raising.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from ._b64 import decode_std_canonical, encode_std
from .keys import TrustedPublicKey
from .results import RejectionCode, VerificationResult

ALG_RSA_PKCS1_SHA256 = "rsa-pkcs1-sha256"


@dataclass(frozen=True)
class _Envelope:
    payload_bytes: bytes
    signature_bytes: bytes
    payload_text: str


def split_envelope(token: str, expected_prefix: str) -> tuple[_Envelope | None, VerificationResult | None]:
    """Split + base64-decode a 3-part envelope. Returns (envelope, None) or (None, rejection)."""
    first_dot = token.find(".")
    if first_dot == -1:
        return None, VerificationResult.reject(RejectionCode.ENVELOPE_MALFORMED, "missing payload")
    second_dot = token.find(".", first_dot + 1)
    if second_dot == -1:
        return None, VerificationResult.reject(RejectionCode.ENVELOPE_MALFORMED, "envelope malformed")
    # A third dot => more than 3 parts => malformed.
    if token.find(".", second_dot + 1) != -1:
        return None, VerificationResult.reject(RejectionCode.ENVELOPE_MALFORMED, "envelope malformed")

    if token[:first_dot] != expected_prefix:
        return None, VerificationResult.reject(RejectionCode.PREFIX_MISMATCH, "prefix mismatch")

    payload_b64 = token[first_dot + 1 : second_dot]
    signature_b64 = token[second_dot + 1 :]

    payload_bytes = decode_std_canonical(payload_b64)
    signature_bytes = decode_std_canonical(signature_b64)
    if payload_bytes is None or signature_bytes is None:
        # Distinguish "not canonical" from "decoded empty" the way the C++ does:
        # split_envelope first rejects non-canonical base64, then the caller
        # checks for empty decode. Here both map to a fail-closed rejection.
        return None, VerificationResult.reject(
            RejectionCode.BASE64_NOT_CANONICAL, "base64 is not canonical"
        )
    if not payload_bytes or not signature_bytes:
        return None, VerificationResult.reject(
            RejectionCode.EMPTY_PAYLOAD_OR_SIGNATURE, "decoded payload or signature is empty"
        )

    try:
        payload_text = payload_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return None, VerificationResult.reject(
            RejectionCode.PAYLOAD_NOT_CANONICAL, "payload is not valid UTF-8"
        )
    return _Envelope(payload_bytes, signature_bytes, payload_text), None


def build_envelope(prefix: str, payload_text: str, signature_bytes: bytes) -> str:
    """Build ``<prefix>.<b64(payload)>.<b64(signature)>`` (standard base64)."""
    return (
        prefix
        + "."
        + encode_std(payload_text.encode("utf-8"))
        + "."
        + encode_std(signature_bytes)
    )


def extract_preverify_field(payload_text: str, key: str) -> str | None:
    """Pull a single ``key=value`` from the payload BEFORE signature verification.

    Used to read ``alg`` / ``key-id`` so the right trusted key can be selected.
    Mirrors the C++ ``extract_preverify_field`` (returns None if absent/empty).
    """
    prefix = key + "="
    pos = 0
    while pos < len(payload_text):
        nl = payload_text.find("\n", pos)
        if nl == -1:
            return None
        line = payload_text[pos:nl]
        if line.startswith(prefix):
            value = line[len(prefix) :]
            return value if value else None
        pos = nl + 1
    return None


@dataclass(frozen=True)
class FieldSpec:
    key: str


def parse_fields_in_order(
    payload_text: str, fields: Iterable[FieldSpec], validate_values: bool
) -> tuple[dict[str, str] | None, VerificationResult | None]:
    """Parse the canonical payload into a dict, enforcing exact field order.

    Returns (values, None) on success or (None, rejection). Mirrors the C++
    ``parse_fields_in_order``: each expected key must appear, in order, as a
    full ``key=value`` line terminated by ``\\n``; with no unknown trailing
    fields. When ``validate_values`` is set, a value containing ``=``/CR/LF is
    rejected.
    """
    values: dict[str, str] = {}
    pos = 0
    for field in fields:
        nl = payload_text.find("\n", pos)
        if nl == -1:
            return None, VerificationResult.reject(
                RejectionCode.FIELD_MISSING, f"missing field {field.key}"
            )
        line = payload_text[pos:nl]
        prefix = field.key + "="
        if not line.startswith(prefix):
            return None, VerificationResult.reject(
                RejectionCode.FIELD_UNEXPECTED, f"expected field {field.key}"
            )
        value = line[len(prefix) :]
        if validate_values and _value_has_line_breaks_or_equals(value):
            return None, VerificationResult.reject(
                RejectionCode.INVALID_FIELD_VALUE, f"invalid value for {field.key}"
            )
        values[field.key] = value
        pos = nl + 1
    if pos != len(payload_text):
        return None, VerificationResult.reject(
            RejectionCode.TRAILING_FIELDS, "has unknown trailing fields"
        )
    return values, None


def _value_has_line_breaks_or_equals(value: str) -> bool:
    return "\n" in value or "\r" in value or "=" in value


def parse_uint64(value: str) -> int | None:
    """Parse a non-negative base-10 integer (no sign, digits only). C++ ``parse_uint64``."""
    if not value or not value.isascii() or not value.isdigit():
        return None
    result = int(value)
    if result > 0xFFFFFFFFFFFFFFFF:
        return None
    return result


def verify_payload_signature(
    payload_bytes: bytes,
    payload_text: str,
    signature_bytes: bytes,
    trusted_keys: list[TrustedPublicKey],
    min_public_key_bits: int,
    retired_key_ids: "set[str] | None" = None,
) -> VerificationResult | None:
    """RSA-PKCS1-SHA256 verify against the key chosen by the payload's key-id.

    Returns None on success, or a typed rejection. The key is selected strictly
    by the ``key-id`` claim: an unknown key-id is rejected before any crypto. A
    key-id in ``retired_key_ids`` is rejected before crypto too, so a rotated-out
    key that is still present in the trusted ring for continuity no longer
    verifies -- matching the C++ verifier's retired-key list.
    """
    declared_alg = extract_preverify_field(payload_text, "alg")
    key_id = extract_preverify_field(payload_text, "key-id")
    if declared_alg is None or key_id is None:
        return VerificationResult.reject(
            RejectionCode.MISSING_SIGNATURE_METADATA, "missing signature metadata"
        )
    if declared_alg != ALG_RSA_PKCS1_SHA256:
        return VerificationResult.reject(
            RejectionCode.METADATA_MISMATCH, f"unsupported alg {declared_alg!r}"
        )
    if retired_key_ids and key_id in retired_key_ids:
        return VerificationResult.reject(
            RejectionCode.RETIRED_KEY_ID, f"key-id {key_id!r} is retired"
        )

    selected: TrustedPublicKey | None = None
    for key in trusted_keys:
        if key.key_id == key_id:
            selected = key
            break
    if selected is None:
        return VerificationResult.reject(
            RejectionCode.UNKNOWN_KEY_ID, f"no trusted key for key-id {key_id!r}"
        )
    if min_public_key_bits and selected.bits < min_public_key_bits:
        return VerificationResult.reject(
            RejectionCode.KEY_TOO_WEAK,
            f"key {key_id!r} is {selected.bits} bits, below the {min_public_key_bits}-bit floor",
        )

    try:
        selected.rsa_public_key.verify(
            signature_bytes,
            payload_bytes,
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature:
        return VerificationResult.reject(
            RejectionCode.SIGNATURE_INVALID, "signature verification failed"
        )
    except Exception:  # noqa: BLE001 - any crypto error is fail-closed
        return VerificationResult.reject(
            RejectionCode.SIGNATURE_INVALID, "signature verification failed"
        )
    return None
