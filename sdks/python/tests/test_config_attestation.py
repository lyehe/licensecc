"""Parity tests for the lcccfg1 config-attestation verifier against the golden vectors.

Covers both the standalone golden.token (its own key) and the embedded_golden
token (build-time embedded key ring), plus negatives.
"""

from __future__ import annotations

import hashlib

import pytest

from licensecc import (
    ConfigAttestationExpected,
    RejectionCode,
    TrustedPublicKey,
    verify_config_token,
)
from licensecc._b64 import decode_std_canonical, encode_std

# Golden facts: config token valid in [1000, 2000], config-seq 9, project
# DEFAULT, feature EXPORT, fingerprint aaaa..., device-hash empty.
GOLDEN_NOW = 1500
GOLDEN_FP = "a" * 64
GOLDEN_CONFIG_SEQ = 9


@pytest.fixture()
def trusted(config_golden):
    return [TrustedPublicKey(public_key_der=config_golden.public_key_der)]


def _expected(config_golden, **overrides) -> ConfigAttestationExpected:
    base = dict(
        config_bytes=config_golden.config_bytes,
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint=GOLDEN_FP,
        device_hash="",
        now=GOLDEN_NOW,
        min_config_seq=0,
    )
    base.update(overrides)
    return ConfigAttestationExpected(**base)


# --- POSITIVE -----------------------------------------------------------------


def test_golden_config_token_verifies(config_golden, trusted):
    result = verify_config_token(config_golden.token, _expected(config_golden), trusted)
    assert result.ok, result.detail


def test_golden_config_claims(config_golden, trusted):
    result = verify_config_token(config_golden.token, _expected(config_golden), trusted)
    assert result.ok
    c = result.claims
    assert c.purpose == "licensecc-config-attestation"
    assert c.version == "1"
    assert c.algorithm == "rsa-pkcs1-sha256"
    assert c.key_id == config_golden.key_id
    assert c.project == "DEFAULT"
    assert c.feature == "EXPORT"
    assert c.license_fingerprint == GOLDEN_FP
    assert c.device_hash == ""
    assert c.config_id == "app-config"
    assert c.config_seq == GOLDEN_CONFIG_SEQ
    expected_hash = "sha256:" + hashlib.sha256(config_golden.config_bytes).hexdigest()
    assert c.config_hash == expected_hash
    assert c.issued_at == 1000
    assert c.expires_at == 2000


def test_embedded_golden_config_token_verifies(embedded_config_golden):
    trusted = [TrustedPublicKey(public_key_der=embedded_config_golden.public_key_der)]
    expected = ConfigAttestationExpected(
        config_bytes=embedded_config_golden.config_bytes,
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint=GOLDEN_FP,
        device_hash="",
        now=GOLDEN_NOW,
    )
    result = verify_config_token(embedded_config_golden.token, expected, trusted)
    assert result.ok, result.detail
    assert result.claims.key_id == embedded_config_golden.key_id


def test_config_seq_floor_at_seq_accepts(config_golden, trusted):
    result = verify_config_token(
        config_golden.token, _expected(config_golden, min_config_seq=GOLDEN_CONFIG_SEQ), trusted
    )
    assert result.ok


# --- NEGATIVE -----------------------------------------------------------------


def test_config_hash_mismatch_rejected(config_golden, trusted):
    result = verify_config_token(
        config_golden.token,
        _expected(config_golden, config_bytes=b"different config bytes"),
        trusted,
    )
    assert not result.ok
    assert result.code == RejectionCode.CONFIG_HASH_MISMATCH


def test_config_tampered_signature_rejected(config_golden, trusted):
    prefix, payload_b64, sig_b64 = config_golden.token.split(".")
    sig = bytearray(decode_std_canonical(sig_b64))
    sig[5] ^= 0xFF
    tampered = f"{prefix}.{payload_b64}.{encode_std(bytes(sig))}"
    result = verify_config_token(tampered, _expected(config_golden), trusted)
    assert not result.ok
    assert result.code == RejectionCode.SIGNATURE_INVALID


def test_config_payload_byte_flip_rejected(config_golden, trusted):
    prefix, payload_b64, sig_b64 = config_golden.token.split(".")
    payload = bytearray(decode_std_canonical(payload_b64))
    # Flip the 'project' value byte (index 155, 'D' of DEFAULT) — after key-id,
    # so the same key is selected and the RSA signature genuinely fails.
    assert payload[155:156] == b"D"
    payload[155] ^= 0x01
    flipped = f"{prefix}.{encode_std(bytes(payload))}.{sig_b64}"
    result = verify_config_token(flipped, _expected(config_golden), trusted)
    assert not result.ok
    assert result.code == RejectionCode.SIGNATURE_INVALID


def test_config_expired_rejected(config_golden, trusted):
    result = verify_config_token(config_golden.token, _expected(config_golden, now=3000), trusted)
    assert not result.ok
    assert result.code == RejectionCode.EXPIRED


def test_config_wrong_binding_rejected(config_golden, trusted):
    result = verify_config_token(
        config_golden.token, _expected(config_golden, project="OTHER"), trusted
    )
    assert not result.ok
    assert result.code == RejectionCode.BINDING_MISMATCH


def test_config_rollback_below_floor_rejected(config_golden, trusted):
    result = verify_config_token(
        config_golden.token, _expected(config_golden, min_config_seq=GOLDEN_CONFIG_SEQ + 1), trusted
    )
    assert not result.ok
    assert result.code == RejectionCode.ROLLBACK_BELOW_FLOOR


def test_config_unknown_key_id_rejected(config_golden, embedded_config_golden):
    # The embedded golden uses a different key ring than the standalone golden,
    # so it is an "unknown key" relative to config_golden's token.
    other = [TrustedPublicKey(public_key_der=embedded_config_golden.public_key_der)]
    result = verify_config_token(config_golden.token, _expected(config_golden), other)
    assert not result.ok
    assert result.code == RejectionCode.UNKNOWN_KEY_ID


@pytest.mark.parametrize(
    "bad_token",
    ["", "lcccfg1", "lcccfg1.onlyone", "lcccfg1.a.b.c", "lccdl1.aGVsbG8=.aGVsbG8="],
)
def test_config_malformed_envelope_rejected(bad_token, config_golden, trusted):
    result = verify_config_token(bad_token, _expected(config_golden), trusted)
    assert not result.ok
    assert result.code in (
        RejectionCode.ENVELOPE_MALFORMED,
        RejectionCode.PREFIX_MISMATCH,
        RejectionCode.BASE64_NOT_CANONICAL,
    )
