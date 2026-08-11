"""Request-proof v1 wire-compatibility tests."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from licensecc import HttpClient
from licensecc import http_client as hc


class _FakeResponse:
    def __init__(self, body: dict):
        self._raw = json.dumps(body).encode("utf-8")

    def getcode(self):
        return 200

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


@pytest.fixture()
def capture(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return _FakeResponse({"ok": True, "code": "entitlement_ok"})

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    return captured


def _base_verify(client: HttpClient, **kwargs):
    return client.verify(
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint="a" * 64,
        nonce="b" * 64,
        **kwargs,
    )


def _proof_fields():
    return {
        "device_key_id": "sha256:" + "c" * 64,
        "request_signature_version": 1,
        "request_timestamp": 1_700_000_000,
        "request_signature_algorithm": "ecdsa-p256-sha256",
        "request_signature": base64.b64encode(bytes(range(64))).decode("ascii"),
    }


def _canonical_payload(manifest: dict, purpose: str) -> bytes:
    """Build the frozen v1 bytes locally, without using production helpers."""
    return (
        f"purpose={purpose}\n"
        f"version={manifest['proof_version']}\n"
        f"alg={manifest['algorithm']}\n"
        f"project={manifest['project']}\n"
        f"feature={manifest['feature']}\n"
        f"license-fingerprint={manifest['license_fingerprint']}\n"
        f"device-hash={manifest['device_hash']}\n"
        f"nonce={manifest['nonce']}\n"
        f"request-timestamp={manifest['request_timestamp']}\n"
        f"client-hardening={manifest['client_hardening']}\n"
        f"device-key-id={manifest['device_key_id']}\n"
    ).encode("ascii")


def test_deprecated_request_proof_mapping_is_flattened(capture):
    client = HttpClient("https://verifier.example")
    with pytest.deprecated_call():
        response = _base_verify(client, request_proof=_proof_fields())
    assert response.ok
    assert capture["body"] == {
        "project": "DEFAULT",
        "feature": "EXPORT",
        "license_fingerprint": "a" * 64,
        "nonce": "b" * 64,
        **_proof_fields(),
    }
    assert "request_proof" not in capture["body"]


def test_preferred_top_level_proof_fields_are_emitted_flat(capture):
    client = HttpClient("https://verifier.example")
    response = _base_verify(client, **_proof_fields())
    assert response.ok
    assert capture["body"] == {
        "project": "DEFAULT",
        "feature": "EXPORT",
        "license_fingerprint": "a" * 64,
        "nonce": "b" * 64,
        **_proof_fields(),
    }


def test_conflicting_top_level_and_deprecated_mapping_values_fail_locally(monkeypatch):
    called = False

    def fake_urlopen(_request, timeout=None):
        nonlocal called
        called = True
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    proof = _proof_fields()
    with pytest.deprecated_call(), pytest.raises(ValueError, match="conflicting request proof field"):
        _base_verify(
            HttpClient("https://verifier.example"),
            request_proof=proof,
            device_key_id="sha256:" + "d" * 64,
        )
    assert called is False


@pytest.mark.parametrize(("flat_value", "deprecated_value"), [(True, 1), (1, True)])
def test_bool_and_integer_proof_values_conflict_by_json_type(monkeypatch, flat_value, deprecated_value):
    called = False

    def fake_urlopen(_request, timeout=None):
        nonlocal called
        called = True
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    proof = _proof_fields()
    proof["request_signature_version"] = deprecated_value
    with pytest.deprecated_call(), pytest.raises(ValueError, match="conflicting request proof field"):
        _base_verify(
            HttpClient("https://verifier.example"),
            request_proof=proof,
            request_signature_version=flat_value,
        )
    assert called is False


def test_bool_and_integer_deprecated_aliases_conflict_by_json_type(monkeypatch):
    called = False

    def fake_urlopen(_request, timeout=None):
        nonlocal called
        called = True
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    proof = _proof_fields()
    proof["version"] = True
    with pytest.deprecated_call(), pytest.raises(ValueError, match="conflicting request proof field"):
        _base_verify(HttpClient("https://verifier.example"), request_proof=proof)
    assert called is False


def test_deprecated_aliases_remain_source_compatible(capture):
    legacy = {
        "device_key_id": "sha256:" + "c" * 64,
        "version": 1,
        "request_timestamp": 1_700_000_000,
        "algorithm": "ecdsa-p256-sha256",
        "signature": base64.b64encode(bytes(range(64))).decode("ascii"),
    }
    with pytest.deprecated_call():
        _base_verify(HttpClient("https://verifier.example"), request_proof=legacy)
    assert {key: capture["body"][key] for key in _proof_fields()} == _proof_fields()


def test_v1_vector_payloads_hash_key_id_and_signature_match():
    vector_dir = Path(__file__).resolve().parents[3] / "test" / "vectors" / "device_proof" / "v1"
    manifest = json.loads((vector_dir / "manifest.json").read_text(encoding="utf-8"))
    audiences = {
        "online.payload": "licensecc-online-request",
        "lease.payload": "licensecc-lease-request",
        "seat.payload": "licensecc-seat-request",
    }
    for filename, purpose in audiences.items():
        payload = (vector_dir / filename).read_bytes()
        assert payload == _canonical_payload(manifest, purpose)
        assert b"\r" not in payload
        assert payload.endswith(b"\n")
        assert hashlib.sha256(payload).hexdigest() == manifest["files"][filename]

    payload = (vector_dir / manifest["signed_payload"]).read_bytes()
    spki = base64.b64decode((vector_dir / "public_key.spki.der.b64").read_text(encoding="ascii").strip(), validate=True)
    signature = base64.b64decode((vector_dir / "signature.p1363.b64").read_text(encoding="ascii").strip(), validate=True)
    assert len(spki) == 91
    assert len(signature) == 64
    assert "sha256:" + hashlib.sha256(spki).hexdigest() == manifest["device_key_id"]
    public_key = serialization.load_der_public_key(spki)
    assert isinstance(public_key, ec.EllipticCurvePublicKey)
    assert isinstance(public_key.curve, ec.SECP256R1)
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    public_key.verify(encode_dss_signature(r, s), payload, ec.ECDSA(hashes.SHA256()))
