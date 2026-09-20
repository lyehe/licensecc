"""Independent byte/crypto oracle for the proposed device-bound protocol.

This is not the SDK's production verifier. It freezes interop evidence before
the typed client and native consumer are implemented.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import pytest

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature


VECTOR = json.loads(
    (Path(__file__).resolve().parents[3] / "test/vectors/device_bound/v1/protocol.json").read_text()
)
EXCHANGE = json.loads(
    (Path(__file__).resolve().parents[3] / "test/vectors/device_bound/v1/exchange.json").read_text()
)


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def text(value: str) -> str:
    return b64(value.encode("utf-8"))


def test_enrollment_comparison_bytes_and_display_independently():
    vector = json.loads((Path(__file__).resolve().parents[3] / "test/vectors/device_bound/v1/enrollment_comparison.json").read_text())
    fields = ["attempt_handle", "client_id", "project", "key_id", "redirect_uri", "state", "code_challenge"]
    transcript = ("lcc-device-enrollment-comparison-v1\n" + "".join(text(vector["input"][field]) + "\n" for field in fields)).encode("utf-8")
    digest = hashlib.sha256(transcript).digest()
    display = digest[:6].hex().upper()
    assert transcript.hex() == vector["input_hex"]
    assert digest.hex() == vector["sha256_hex"]
    assert "-".join(display[i:i + 4] for i in range(0, 12, 4)) == vector["comparison_code"]


@pytest.mark.parametrize("vector,purpose", [(VECTOR, "renew"), (EXCHANGE, "exchange")])
def test_device_proof_and_operation_digest_bytes_independently(vector, purpose):
    body, proof = vector["body"], vector["proof"]
    values = ([text(body["binding_id"]), body["generation"], text(body["operation_id"])]
              if purpose == "renew" else
              [text(body[field]) for field in ["attempt_handle", "code", "code_verifier", "redirect_uri", "operation_id"]])
    semantic = json.dumps(
        values,
        separators=(",", ":"),
    ).encode()
    assert hashlib.sha256(semantic).hexdigest() == proof["body_sha256"]
    operation = ("\n".join([
        "lcc-device-operation-v1", text(purpose), text(proof["key_id"]), b64(semantic), "",
    ])).encode()
    assert operation.hex() == vector["operation_digest_input_hex"]
    assert hashlib.sha256(operation).hexdigest() == vector["operation_digest"]
    fields = ["audience", "method", "path", "key_id", "operation_id",
              "body_sha256", "challenge_id", "nonce"]
    payload = ("\n".join(["lcc-device-proof-v2"] + [text(proof[f]) for f in fields]
                         + [str(proof["expires_at"]), ""])).encode()
    assert payload.hex() == vector["proof_input_hex"]
    public_der = unb64(vector["device_spki"])
    assert "sha256:" + hashlib.sha256(public_der).hexdigest() == proof["key_id"]
    public_key = serialization.load_der_public_key(public_der)
    signature = unb64(vector["proof_signature"])
    assert len(signature) == 64
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    order = int("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    assert 0 < r < order and 0 < s <= order // 2
    public_key.verify(encode_dss_signature(r, s), payload, ec.ECDSA(hashes.SHA256()))


def test_device_lease_payload_and_signature_independently():
    fields = ["version", "purpose", "key-id", "issuer", "audience", "project", "feature",
              "license-fingerprint", "binding-id", "device-key-id", "generation",
              "revocation-seq", "lease-id", "operation-id", "issued-at", "renew-after", "expires-at"]
    claims = VECTOR["claims"]
    payload = "".join(f"{key}={str(claims[key]) if isinstance(claims[key], int) else text(claims[key])}\n"
                      for key in fields).encode()
    assert payload.hex() == VECTOR["lease_payload_hex"]
    signing_input = b"lccdl1." + payload
    assert signing_input.hex() == VECTOR["lease_signing_input_hex"]
    prefix, encoded_payload, encoded_signature = VECTOR["token"].split(".")
    assert prefix == "lccdl1" and unb64(encoded_payload) == payload
    signature = unb64(encoded_signature)
    assert len(signature) == 384
    public_der = unb64(VECTOR["lease_signer_spki"])
    assert claims["key-id"] == "sha256:" + hashlib.sha256(public_der).hexdigest()
    public_key = serialization.load_der_public_key(public_der)
    assert public_key.key_size == 3072
    public_key.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
