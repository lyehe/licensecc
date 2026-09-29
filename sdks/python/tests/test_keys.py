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


def test_pkcs1_der_loads_via_n_e_bridge(config_golden):
    # The golden key is PKCS#1 RSAPublicKey DER ("3082...0282...").
    der = config_golden.public_key_der
    assert der[:2] == b"\x30\x82", "golden key should be a DER SEQUENCE (PKCS#1)"
    # cryptography.load_der_public_key would FAIL on this (it wants SPKI); our
    # bridge parses (n, e) and rebuilds the key.
    key = load_pkcs1_public_key(der)
    assert isinstance(key, RSAPublicKey)
    assert key.key_size == 3072


def test_key_id_is_over_pkcs1_bytes_not_spki(config_golden):
    # The decisive reason to parse PKCS#1 ourselves: the key-id is sha256 of the
    # *PKCS#1* DER. Hashing an SPKI re-encoding would give a DIFFERENT id and
    # break key selection. Guard that the derived id matches the golden key-id.
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    pkcs1_id = key_id_from_pkcs1_der(config_golden.public_key_der)
    assert pkcs1_id == config_golden.key_id

    spki_der = load_pkcs1_public_key(config_golden.public_key_der).public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo
    )
    spki_id = key_id_from_pkcs1_der(spki_der)
    assert spki_id != config_golden.key_id  # SPKI hash != PKCS#1 hash


def test_key_id_matches_golden(config_golden):
    derived = key_id_from_pkcs1_der(config_golden.public_key_der)
    assert derived == config_golden.key_id
    expected = "sha256:" + hashlib.sha256(config_golden.public_key_der).hexdigest()
    assert derived == expected


def test_rsa_public_key_bits(config_golden):
    assert rsa_public_key_bits(config_golden.public_key_der) == 3072


def test_trusted_public_key_derives_key_id(config_golden):
    tk = TrustedPublicKey(public_key_der=config_golden.public_key_der)
    assert tk.key_id == config_golden.key_id
    assert tk.bits == 3072


def test_trusted_public_key_rejects_mismatched_key_id(config_golden):
    with pytest.raises(ValueError):
        TrustedPublicKey(
            public_key_der=config_golden.public_key_der,
            key_id="sha256:" + "0" * 64,
        )


def test_trusted_public_key_from_hex(config_golden):
    der_hex = config_golden.public_key_der.hex()
    tk = TrustedPublicKey.from_pkcs1_der_hex(der_hex)
    assert tk.key_id == config_golden.key_id
