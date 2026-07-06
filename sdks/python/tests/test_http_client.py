"""HTTP client tests: body construction + FLAT {ok, code, ...} envelope parsing.

No network: a fake urlopen captures the request and returns canned responses.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from licensecc import ApiResponse, HttpClient
from licensecc import http_client as hc


class _FakeResponse:
    def __init__(self, status: int, body: dict):
        self._status = status
        self._raw = json.dumps(body).encode("utf-8")

    def getcode(self):
        return self._status

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.fixture()
def capture(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        captured["headers"] = dict(request.header_items())
        captured["body"] = request.data.decode("utf-8") if request.data else None
        captured["timeout"] = timeout
        return _FakeResponse(captured.get("status", 200), captured.get("response", {"ok": True}))

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    return captured


def test_verify_builds_body_and_parses_envelope(capture):
    capture["response"] = {"ok": True, "code": "entitlement_ok", "assertion": "lccoa1.x.y", "server_time": 1700}
    client = HttpClient("https://verifier.example.com/")
    resp = client.verify(
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint="a" * 64,
        nonce="c" * 64,
        device_hash="b" * 64,
    )
    # URL + method
    assert capture["url"] == "https://verifier.example.com/v1/verify"
    assert capture["method"] == "POST"
    # Body matches the documented VerifyRequest shape.
    body = json.loads(capture["body"])
    assert body == {
        "project": "DEFAULT",
        "feature": "EXPORT",
        "license_fingerprint": "a" * 64,
        "nonce": "c" * 64,
        "device_hash": "b" * 64,
    }
    # FLAT envelope parsed.
    assert isinstance(resp, ApiResponse)
    assert resp.ok and bool(resp)
    assert resp.code == "entitlement_ok"
    assert resp.assertion == "lccoa1.x.y"


def test_verify_soft_denial_is_200_ok_false(capture):
    capture["status"] = 200
    capture["response"] = {"ok": False, "code": "entitlement_denied", "server_time": 1700}
    client = HttpClient("https://verifier.example.com")
    resp = client.verify("DEFAULT", "EXPORT", "a" * 64, "c" * 64)
    assert resp.status == 200
    assert not resp.ok
    assert resp.code == "entitlement_denied"
    assert resp.assertion is None


def test_account_token_sets_authorization_header(capture):
    capture["response"] = {"ok": True}
    client = HttpClient("https://verifier.example.com", account_token="lcca_secret")
    client.activate({"project": "DEFAULT", "feature": "EXPORT", "license_fingerprint": "a" * 64, "device_key_id": "sha256:" + "0" * 64})
    headers = {k.lower(): v for k, v in capture["headers"].items()}
    assert headers["authorization"] == "Bearer lcca_secret"


def test_seat_endpoints_paths(capture):
    capture["response"] = {"ok": True}
    client = HttpClient("https://verifier.example.com")
    for method, path in [
        (client.renew, "/v1/renew"),
        (client.checkout, "/v1/checkout"),
        (client.heartbeat, "/v1/heartbeat"),
        (client.release, "/v1/release"),
    ]:
        method({"project": "DEFAULT"})
        assert capture["url"].endswith(path)


def test_http_error_still_parses_flat_envelope(monkeypatch):
    def fake_urlopen(request, timeout=None):
        body = json.dumps({"ok": False, "code": "rate_limited"}).encode("utf-8")
        raise urllib.error.HTTPError(
            url=request.full_url, code=429, msg="Too Many Requests", hdrs=None, fp=io.BytesIO(body)
        )

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    client = HttpClient("https://verifier.example.com")
    resp = client.verify("DEFAULT", "EXPORT", "a" * 64, "c" * 64)
    assert resp.status == 429
    assert not resp.ok
    assert resp.code == "rate_limited"


def test_transport_error_returns_typed_response(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    client = HttpClient("https://verifier.example.com")
    resp = client.verify("DEFAULT", "EXPORT", "a" * 64, "c" * 64)
    assert resp.status == 0
    assert not resp.ok
    assert resp.error is not None


@pytest.mark.parametrize(
    "body",
    [
        {"ok": "false"},  # truthy string — the old bool() coercion read this as a grant
        {"ok": "true"},
        {"ok": 1},
        {"ok": 0},
        {"ok": None},
        {"ok": "1"},
        {},  # missing
    ],
)
def test_parse_response_ok_requires_json_true(body):
    # Only a real JSON boolean true is a grant; every other shape is fail-closed.
    resp = hc._parse_response(200, json.dumps(body).encode("utf-8"))
    assert resp.ok is False


def test_parse_response_ok_accepts_only_boolean_true():
    resp = hc._parse_response(200, json.dumps({"ok": True}).encode("utf-8"))
    assert resp.ok is True


def test_retries_on_429_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def fake_urlopen(request, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            body = json.dumps({"ok": False, "code": "rate_limited"}).encode("utf-8")
            raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", hdrs=None, fp=io.BytesIO(body))
        return _FakeResponse(200, {"ok": True, "assertion": "lccoa1.x.y"})

    monkeypatch.setattr(hc.time, "sleep", lambda _s: None)
    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    resp = HttpClient("https://verifier.example.com").verify("DEFAULT", "EXPORT", "a" * 64, "c" * 64)
    assert resp.ok
    assert calls["n"] == 2  # one retry after the 429


def test_max_retries_zero_disables_retry(monkeypatch):
    def fake_urlopen(request, timeout=None):
        body = json.dumps({"ok": False, "code": "rate_limited"}).encode("utf-8")
        raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", hdrs=None, fp=io.BytesIO(body))

    monkeypatch.setattr(hc.time, "sleep", lambda _s: None)
    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    resp = HttpClient("https://verifier.example.com", max_retries=0).verify("DEFAULT", "EXPORT", "a" * 64, "c" * 64)
    assert not resp.ok
    assert resp.status == 429
    assert resp.code == "rate_limited"


def test_parse_retry_after_seconds_only():
    assert hc._parse_retry_after("5") == 5.0
    assert hc._parse_retry_after("Wed, 21 Oct 2025 07:28:00 GMT") is None
    assert hc._parse_retry_after(None) is None
