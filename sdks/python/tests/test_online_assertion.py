"""Parity tests for the lccoa1 online-assertion verifier against the golden vector.

Positive: the golden token verifies and its claims parse to the exact values in
golden.payload. Negatives: every fail-closed branch the C++ verifier enforces.
"""

from __future__ import annotations

import base64

import pytest

from licensecc import (
    OnlineAssertionExpected,
    RejectionCode,
    TrustedPublicKey,
    verify_online_assertion,
)
from licensecc._b64 import decode_std_canonical, encode_std

# Golden facts (from golden.payload): the token is valid in [1000, 1300), cache
# until 1600, revocation-seq 42, project DEFAULT, feature EXPORT.
GOLDEN_NOW = 1200
GOLDEN_FP = "a" * 64
GOLDEN_DEVICE = "b" * 64
GOLDEN_NONCE = "c" * 64
GOLDEN_REVOCATION_SEQ = 42


@pytest.fixture()
def trusted(online_golden):
    return [TrustedPublicKey(public_key_der=online_golden.public_key_der)]


def _expected(**overrides) -> OnlineAssertionExpected:
    base = dict(
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint=GOLDEN_FP,
        device_hash=GOLDEN_DEVICE,
        now=GOLDEN_NOW,
        min_revocation_seq=0,
    )
    base.update(overrides)
    return OnlineAssertionExpected(**base)


# --- POSITIVE -----------------------------------------------------------------


def test_golden_assertion_verifies(online_golden, trusted):
    result = verify_online_assertion(online_golden.token, _expected(), trusted)
    assert result.ok, result.detail
    assert result.code is None


def test_golden_claims_match_payload(online_golden, trusted):
    result = verify_online_assertion(online_golden.token, _expected(), trusted)
    assert result.ok
    c = result.claims
    # Every claim must equal the exact value in golden.payload.
    assert c.purpose == "licensecc-online-assertion"
    assert c.version == "1"
    assert c.algorithm == "rsa-pkcs1-sha256"
    assert c.key_id == online_golden.key_id
    assert c.project == "DEFAULT"
    assert c.feature == "EXPORT"
    assert c.license_fingerprint == GOLDEN_FP
    assert c.device_hash == GOLDEN_DEVICE
    assert c.nonce == GOLDEN_NONCE
    assert c.status == "ok"
    assert c.issued_at == 1000
    assert c.expires_at == 1300
    assert c.cache_until == 1600
    assert c.revocation_seq == GOLDEN_REVOCATION_SEQ


def test_canonical_payload_byte_for_byte(online_golden):
    # The decoded payload bytes equal golden.payload exactly (round-trip oracle).
    payload_b64 = online_golden.token.split(".")[1]
    decoded = decode_std_canonical(payload_b64)
    assert decoded is not None
    assert decoded.decode("utf-8") == online_golden.payload


def test_revocation_floor_at_seq_accepts(online_golden, trusted):
    # floor == revocation-seq is allowed (>=).
    result = verify_online_assertion(
        online_golden.token, _expected(min_revocation_seq=GOLDEN_REVOCATION_SEQ), trusted
    )
    assert result.ok


def test_nonce_binding_match_accepts(online_golden, trusted):
    result = verify_online_assertion(
        online_golden.token,
        _expected(nonce=GOLDEN_NONCE, check_nonce_binding=True),
        trusted,
    )
    assert result.ok


def test_cache_window_accepts_after_expiry(online_golden, trusted):
    # now in (expires_at, cache_until]: rejected without cache, accepted with.
    no_cache = verify_online_assertion(online_golden.token, _expected(now=1400), trusted)
    assert not no_cache.ok and no_cache.code == RejectionCode.EXPIRED
    cached = verify_online_assertion(
        online_golden.token, _expected(now=1400, allow_cache=True), trusted
    )
    assert cached.ok and cached.used_cache


# --- NEGATIVE -----------------------------------------------------------------


def test_tampered_signature_rejected(online_golden, trusted):
    prefix, payload_b64, sig_b64 = online_golden.token.split(".")
    sig = bytearray(decode_std_canonical(sig_b64))
    sig[0] ^= 0xFF  # flip one byte of the signature
    tampered = f"{prefix}.{payload_b64}.{encode_std(bytes(sig))}"
    result = verify_online_assertion(tampered, _expected(), trusted)
    assert not result.ok
    assert result.code == RejectionCode.SIGNATURE_INVALID


def test_payload_byte_flip_rejected(online_golden, trusted):
    prefix, payload_b64, sig_b64 = online_golden.token.split(".")
    payload = bytearray(decode_std_canonical(payload_b64))
    # Flip a byte inside the 'project' value (index 153, the 'D' of DEFAULT).
    # This is AFTER the key-id line, so the same trusted key is selected and the
    # RSA signature genuinely fails to verify against the mutated bytes.
    assert payload[153:154] == b"D"
    payload[153] ^= 0x01
    flipped = f"{prefix}.{encode_std(bytes(payload))}.{sig_b64}"
    result = verify_online_assertion(flipped, _expected(), trusted)
    assert not result.ok
    assert result.code == RejectionCode.SIGNATURE_INVALID


def test_key_id_byte_flip_rejected(online_golden, trusted):
    # Flipping a byte INSIDE the key-id hex changes which key is selected, so the
    # verifier fails closed at key selection (still a rejection, different code).
    prefix, payload_b64, sig_b64 = online_golden.token.split(".")
    payload = bytearray(decode_std_canonical(payload_b64))
    assert payload[80:81] == b"a"  # a key-id hex digit
    payload[80] ^= 0x01
    flipped = f"{prefix}.{encode_std(bytes(payload))}.{sig_b64}"
    result = verify_online_assertion(flipped, _expected(), trusted)
    assert not result.ok
    assert result.code == RejectionCode.UNKNOWN_KEY_ID


def test_expired_rejected(online_golden, trusted):
    # now > expires_at AND no cache.
    result = verify_online_assertion(online_golden.token, _expected(now=2000), trusted)
    assert not result.ok
    assert result.code == RejectionCode.EXPIRED


def test_wrong_project_binding_rejected(online_golden, trusted):
    result = verify_online_assertion(online_golden.token, _expected(project="OTHER"), trusted)
    assert not result.ok
    assert result.code == RejectionCode.BINDING_MISMATCH


def test_wrong_feature_binding_rejected(online_golden, trusted):
    result = verify_online_assertion(online_golden.token, _expected(feature="IMPORT"), trusted)
    assert not result.ok
    assert result.code == RejectionCode.BINDING_MISMATCH


def test_wrong_fingerprint_binding_rejected(online_golden, trusted):
    result = verify_online_assertion(
        online_golden.token, _expected(license_fingerprint="d" * 64), trusted
    )
    assert not result.ok
    assert result.code == RejectionCode.BINDING_MISMATCH


def test_wrong_device_hash_binding_rejected(online_golden, trusted):
    result = verify_online_assertion(
        online_golden.token, _expected(device_hash="e" * 64), trusted
    )
    assert not result.ok
    assert result.code == RejectionCode.BINDING_MISMATCH


def test_revocation_below_floor_rejected(online_golden, trusted):
    result = verify_online_assertion(
        online_golden.token, _expected(min_revocation_seq=GOLDEN_REVOCATION_SEQ + 1), trusted
    )
    assert not result.ok
    assert result.code == RejectionCode.REVOCATION_BELOW_FLOOR


def test_unknown_key_id_rejected(online_golden, config_golden):
    # Present a DIFFERENT trusted key (the config golden key). Its id will not
    # match the assertion's key-id, so selection fails before any crypto.
    other = [TrustedPublicKey(public_key_der=config_golden.public_key_der)]
    result = verify_online_assertion(online_golden.token, _expected(), other)
    assert not result.ok
    assert result.code == RejectionCode.UNKNOWN_KEY_ID


def test_empty_trusted_keys_rejected(online_golden):
    result = verify_online_assertion(online_golden.token, _expected(), [])
    assert not result.ok
    assert result.code == RejectionCode.UNKNOWN_KEY_ID


@pytest.mark.parametrize(
    "bad_token",
    [
        "",  # empty
        "lccoa1",  # no dots
        "lccoa1.onlyonepart",  # one dot
        "lccoa1.a.b.c",  # too many dots
        "wrongprefix.aGVsbG8=.aGVsbG8=",  # wrong prefix
        "lccoa1.!!!notb64!!!.aGVsbG8=",  # non-canonical payload b64
    ],
)
def test_malformed_envelope_rejected(bad_token, trusted):
    result = verify_online_assertion(
        bad_token,
        OnlineAssertionExpected(
            project="DEFAULT", feature="EXPORT", license_fingerprint="a" * 64, now=GOLDEN_NOW
        ),
        trusted,
    )
    assert not result.ok
    assert result.code in (
        RejectionCode.ENVELOPE_MALFORMED,
        RejectionCode.PREFIX_MISMATCH,
        RejectionCode.BASE64_NOT_CANONICAL,
    )


def test_wrong_prefix_uses_config_prefix(online_golden, trusted):
    # An lcccfg1-prefixed token must be rejected by the online verifier.
    _, payload_b64, sig_b64 = online_golden.token.split(".")
    swapped = f"lcccfg1.{payload_b64}.{sig_b64}"
    result = verify_online_assertion(swapped, _expected(), trusted)
    assert not result.ok
    assert result.code == RejectionCode.PREFIX_MISMATCH


def test_url_safe_base64_rejected(online_golden, trusted):
    # If the payload b64 happens to contain '+' or '/', a url-safe variant must
    # be rejected as non-canonical. Force it by swapping standard chars.
    prefix, payload_b64, sig_b64 = online_golden.token.split(".")
    if "+" in payload_b64 or "/" in payload_b64:
        urlsafe = payload_b64.replace("+", "-").replace("/", "_")
        result = verify_online_assertion(f"{prefix}.{urlsafe}.{sig_b64}", _expected(), trusted)
        assert not result.ok
        assert result.code == RejectionCode.BASE64_NOT_CANONICAL


def test_never_raises_on_garbage(trusted):
    # Fuzz a few nasty inputs; the verifier must always return a typed result.
    for junk in ["\x00\x01\x02", "lccoa1." * 50, "lccoa1.\n.\n", "lccoa1..", "....."]:
        result = verify_online_assertion(
            junk,
            OnlineAssertionExpected(
                project="DEFAULT", feature="EXPORT", license_fingerprint="a" * 64, now=GOLDEN_NOW
            ),
            trusted,
        )
        assert result.ok is False
        assert result.code is not None
