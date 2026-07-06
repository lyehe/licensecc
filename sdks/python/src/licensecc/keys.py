"""RSA public-key import and key-id derivation.

THE KEY-IMPORT GOTCHA
---------------------
The golden trusted public keys are stored as **PKCS#1 ``RSAPublicKey`` DER**
(the bytes start ``30 82 .. .. 02 82 ..`` — a SEQUENCE of two INTEGERs:
modulus and exponent). That is exactly what ``RSA.ImportRSAPublicKey`` consumes
on .NET and what the C++ side derives a bit-length from.

Python's ``cryptography`` only exposes:

  * ``load_der_public_key`` — expects **SPKI / SubjectPublicKeyInfo** DER
    (an ``rsaEncryption`` AlgorithmIdentifier wrapping the PKCS#1 bytes in a
    BIT STRING), and
  * ``load_pem_public_key`` — PEM of the same SPKI structure.

So a raw PKCS#1 ``RSAPublicKey`` will NOT load directly. We handle the
asymmetry by parsing the PKCS#1 DER ourselves into ``(n, e)`` and rebuilding an
``RSAPublicKey`` via ``RSAPublicNumbers`` — no fragile byte-stuffing of an SPKI
header required, and it works for any modulus size.

The ``key_id`` is ``"sha256:" + hex(sha256(pkcs1_der))`` — identical to the C++
``public_key_id_from_der`` and the Worker / signer tooling.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey


def key_id_from_pkcs1_der(pkcs1_der: bytes) -> str:
    """Derive the canonical ``sha256:<64hex>`` key-id from PKCS#1 DER bytes."""
    return "sha256:" + hashlib.sha256(pkcs1_der).hexdigest()


# --- Minimal DER reader for a PKCS#1 RSAPublicKey -------------------------------
# RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }


def _read_len(der: bytes, off: int) -> tuple[int, int]:
    if off >= len(der):
        raise ValueError("truncated DER length")
    first = der[off]
    off += 1
    if first & 0x80 == 0:
        return first, off
    num = first & 0x7F
    if num == 0 or num > 8 or off + num > len(der):
        raise ValueError("invalid DER long-form length")
    if der[off] == 0:
        raise ValueError("non-minimal DER length")
    value = 0
    for _ in range(num):
        value = (value << 8) | der[off]
        off += 1
    if value <= 0x7F:
        raise ValueError("non-minimal DER length")
    return value, off


def _read_integer(der: bytes, off: int) -> tuple[int, int]:
    if off >= len(der) or der[off] != 0x02:
        raise ValueError("expected DER INTEGER")
    off += 1
    length, off = _read_len(der, off)
    if length == 0 or off + length > len(der):
        raise ValueError("invalid DER INTEGER length")
    chunk = der[off : off + length]
    off += length
    # Reject a negative / non-minimally-encoded integer (high bit set, or a
    # superfluous leading zero). Matches the C++ DER integer reader.
    if chunk[0] & 0x80:
        raise ValueError("negative DER INTEGER")
    if len(chunk) > 1 and chunk[0] == 0 and (chunk[1] & 0x80) == 0:
        raise ValueError("non-minimal DER INTEGER")
    return int.from_bytes(chunk, "big"), off


def _parse_pkcs1_rsa_public_key(pkcs1_der: bytes) -> tuple[int, int]:
    if not pkcs1_der or pkcs1_der[0] != 0x30:
        raise ValueError("PKCS#1 public key must start with a SEQUENCE")
    off = 1
    seq_len, off = _read_len(pkcs1_der, off)
    if seq_len != len(pkcs1_der) - off:
        raise ValueError("PKCS#1 SEQUENCE length mismatch")
    n, off = _read_integer(pkcs1_der, off)
    e, off = _read_integer(pkcs1_der, off)
    if off != len(pkcs1_der):
        raise ValueError("trailing bytes after PKCS#1 RSAPublicKey")
    return n, e


def load_pkcs1_public_key(pkcs1_der: bytes) -> RSAPublicKey:
    """Load a PKCS#1 ``RSAPublicKey`` DER into a ``cryptography`` RSA public key.

    This is the PKCS#1 -> SPKI bridge: we parse ``(n, e)`` and rebuild the key
    via ``RSAPublicNumbers`` rather than wrapping bytes in an SPKI header.
    """
    n, e = _parse_pkcs1_rsa_public_key(pkcs1_der)
    return rsa.RSAPublicNumbers(e=e, n=n).public_key()


def rsa_public_key_bits(pkcs1_der: bytes) -> int:
    """Modulus bit-length of a PKCS#1 RSAPublicKey (0 if unparseable)."""
    try:
        n, _ = _parse_pkcs1_rsa_public_key(pkcs1_der)
    except ValueError:
        return 0
    return n.bit_length()


@dataclass(frozen=True)
class TrustedPublicKey:
    """A trusted RSA verification key, addressed by its canonical key-id.

    ``public_key_der`` is the PKCS#1 ``RSAPublicKey`` DER (as shipped in the
    golden vectors and the embedded key ring). ``key_id`` defaults to the
    derived ``sha256:<hex>`` id and, if supplied, must match.
    """

    public_key_der: bytes
    key_id: str = ""

    def __post_init__(self) -> None:
        derived = key_id_from_pkcs1_der(self.public_key_der)
        if not self.key_id:
            object.__setattr__(self, "key_id", derived)
        elif self.key_id != derived:
            raise ValueError(
                f"key_id {self.key_id!r} does not match the DER-derived id {derived!r}"
            )

    @classmethod
    def from_pkcs1_der_hex(cls, der_hex: str, key_id: str = "") -> "TrustedPublicKey":
        """Build from a hex-encoded PKCS#1 DER string (as in the golden vectors)."""
        return cls(public_key_der=bytes.fromhex(der_hex.strip()), key_id=key_id)

    @property
    def rsa_public_key(self) -> RSAPublicKey:
        return load_pkcs1_public_key(self.public_key_der)

    @property
    def bits(self) -> int:
        return rsa_public_key_bits(self.public_key_der)
