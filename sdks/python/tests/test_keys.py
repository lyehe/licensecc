"""Key-import tests — the PKCS#1 -> SPKI gotcha and key-id derivation."""

from __future__ import annotations

import hashlib

import pytest
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey

from licensecc import (
    TrustedPublicKey,
    key_id_from_pkcs1_der,
    load_pkcs1_public_key,
    rsa_public_key_bits,
)


def test_pkcs1_der_loads_via_n_e_bridge(online_golden):
    # The golden key is PKCS#1 RSAPublicKey DER ("3082...0282...").
    der = online_golden.public_key_der
    assert der[:2] == b"\x30\x82", "golden key should be a DER SEQUENCE (PKCS#1)"
    # cryptography.load_der_public_key would FAIL on this (it wants SPKI); our
    # bridge parses (n, e) and rebuilds the key.
    key = load_pkcs1_public_key(der)
    assert isinstance(key, RSAPublicKey)
    assert key.key_size == 3072


def test_bridge_is_version_independent(online_golden):
    # The PKCS#1 -> import gotcha is version-dependent: older `cryptography`
    # rejects raw PKCS#1 in load_der_public_key (it wants SPKI), while recent
    # versions accept it. Our bridge parses (n, e) and rebuilds the key, so it
    # works EITHER way and yields the same modulus as the std loader does when
    # the std loader happens to accept the bytes.
    from cryptography.hazmat.primitives.serialization import load_der_public_key

    bridged = load_pkcs1_public_key(online_golden.public_key_der)
    try:
        std = load_der_public_key(online_golden.public_key_der)
    except Exception:
        # Older cryptography: std loader refuses PKCS#1. Bridge still works.
        std = None
    if std is not None:
        assert std.public_numbers().n == bridged.public_numbers().n
        assert std.public_numbers().e == bridged.public_numbers().e


def test_key_id_is_over_pkcs1_bytes_not_spki(online_golden):
    # The decisive reason to parse PKCS#1 ourselves: the key-id is sha256 of the
    # *PKCS#1* DER. Hashing an SPKI re-encoding would give a DIFFERENT id and
    # break key selection. Guard that the derived id matches the golden key-id.
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    pkcs1_id = key_id_from_pkcs1_der(online_golden.public_key_der)
    assert pkcs1_id == online_golden.key_id

    spki_der = load_pkcs1_public_key(online_golden.public_key_der).public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo
    )
    spki_id = key_id_from_pkcs1_der(spki_der)
    assert spki_id != online_golden.key_id  # SPKI hash != PKCS#1 hash


def test_key_id_matches_golden(online_golden):
    derived = key_id_from_pkcs1_der(online_golden.public_key_der)
    assert derived == online_golden.key_id
    expected = "sha256:" + hashlib.sha256(online_golden.public_key_der).hexdigest()
    assert derived == expected


def test_rsa_public_key_bits(online_golden):
    assert rsa_public_key_bits(online_golden.public_key_der) == 3072


def test_trusted_public_key_derives_key_id(online_golden):
    tk = TrustedPublicKey(public_key_der=online_golden.public_key_der)
    assert tk.key_id == online_golden.key_id
    assert tk.bits == 3072


def test_trusted_public_key_rejects_mismatched_key_id(online_golden):
    with pytest.raises(ValueError):
        TrustedPublicKey(
            public_key_der=online_golden.public_key_der,
            key_id="sha256:" + "0" * 64,
        )


def test_trusted_public_key_from_hex(online_golden):
    der_hex = online_golden.public_key_der.hex()
    tk = TrustedPublicKey.from_pkcs1_der_hex(der_hex)
    assert tk.key_id == online_golden.key_id
