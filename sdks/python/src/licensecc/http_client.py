"""Thin HTTP client for the licensecc licensing-backend Worker.

SCOPE — read this first
-----------------------
This client is a small, hand-written wrapper over the documented client-facing
endpoints (``POST /v1/verify``, ``/v1/activate``, ``/v1/renew``, ``/v1/checkout``,
``/v1/heartbeat``, ``/v1/release``). It sends the documented JSON body and parses
the FLAT ``{ ok, code, ... }`` response envelope that every Worker route returns
(see ``services/cloudflare-licensing-backend/src/openapi.ts``).

It does NOT implement anti-tamper, hardware fingerprinting, or any binary
enforcement — those stay C++-only in the licensecc static library. This SDK
covers the HTTP + token CONTRACT, not the enforcement layer. After a successful
``/v1/verify``, verify the returned ``assertion`` locally with
:func:`licensecc.verify_online_assertion`.

Transport: std-lib ``urllib`` (no ``requests``/``httpx`` dependency). A response
that is HTTP 200 with ``ok:false`` (a soft denial / cached replay) is returned
as a normal :class:`ApiResponse`, not an error — the FLAT envelope is the
source of truth, per the OpenAPI doc.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Mapping

DEFAULT_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class ApiResponse:
    """A parsed FLAT ``{ ok, code, ... }`` response.

    ``status`` is the HTTP status code. ``ok`` and ``code`` come from the JSON
    body (``ok`` defaults to False when absent — fail-closed). ``data`` is the
    full decoded body. ``error`` is set for transport/parse failures (no body).
    """

    status: int
    ok: bool
    code: str | None
    data: Mapping[str, Any]
    error: str | None = None

    def __bool__(self) -> bool:
        return self.ok

    @property
    def assertion(self) -> str | None:
        """The ``lccoa1`` assertion string, when present (verify/checkout/heartbeat)."""
        value = self.data.get("assertion")
        return value if isinstance(value, str) else None


class HttpClient:
    """Thin client over the licensing-backend Worker's client-facing endpoints.

    Parameters
    ----------
    base_url:
        Worker origin, e.g. ``https://licensecc-online-verifier.example.workers.dev``.
    account_token:
        Optional account bearer (``lcca_...``) for the lease/seat endpoints.
        Sent as ``Authorization: Bearer <token>``.
    timeout:
        Per-request timeout in seconds.
    user_agent:
        Sent as the ``User-Agent`` header.
    """

    def __init__(
        self,
        base_url: str,
        account_token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        user_agent: str = "licensecc-python-sdk/0.1.0",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.account_token = account_token
        self.timeout = timeout
        self.user_agent = user_agent

    # -- transport -------------------------------------------------------------

    def _post(self, path: str, body: Mapping[str, Any]) -> ApiResponse:
        url = self.base_url + path
        payload = json.dumps(body).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self.account_token:
            headers["Authorization"] = f"Bearer {self.account_token}"
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                status = response.getcode()
                raw = response.read()
        except urllib.error.HTTPError as exc:
            # The Worker returns the FLAT envelope even on 4xx/5xx — parse it.
            status = exc.code
            raw = exc.read()
        except urllib.error.URLError as exc:
            return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc.reason))
        except Exception as exc:  # noqa: BLE001 - surface transport errors, never raise
            return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc))
        return _parse_response(status, raw)

    def health(self) -> ApiResponse:
        """``GET /health`` — service liveness."""
        url = self.base_url + "/health"
        headers = {"Accept": "application/json", "User-Agent": self.user_agent}
        request = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return _parse_response(response.getcode(), response.read())
        except urllib.error.HTTPError as exc:
            return _parse_response(exc.code, exc.read())
        except Exception as exc:  # noqa: BLE001
            return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc))

    # -- client-facing endpoints ----------------------------------------------

    def verify(
        self,
        project: str,
        feature: str,
        license_fingerprint: str,
        nonce: str,
        device_hash: str | None = None,
        client_version: str | None = None,
        client_hardening: int | None = None,
        request_proof: Mapping[str, Any] | None = None,
    ) -> ApiResponse:
        """``POST /v1/verify`` — request a signed ``lccoa1`` assertion (or a denial).

        On ``ok:true`` the ``assertion`` field carries the token; verify it
        locally with :func:`licensecc.verify_online_assertion` using the nonce
        you supplied here. A soft denial is HTTP 200 with ``ok:false``.
        """
        body: dict[str, Any] = {
            "project": project,
            "feature": feature,
            "license_fingerprint": license_fingerprint,
            "nonce": nonce,
        }
        if device_hash is not None:
            body["device_hash"] = device_hash
        if client_version is not None:
            body["client_version"] = client_version
        if client_hardening is not None:
            body["client_hardening"] = client_hardening
        if request_proof is not None:
            body["request_proof"] = dict(request_proof)
        return self._post("/v1/verify", body)

    def activate(self, body: Mapping[str, Any]) -> ApiResponse:
        """``POST /v1/activate`` — issue a hardware-bound v201 lease.

        Requires an account token. The success body carries ``lic`` (the signed
        v201 lease text) rather than an ``lccoa1`` assertion.
        """
        return self._post("/v1/activate", body)

    def renew(self, body: Mapping[str, Any]) -> ApiResponse:
        """``POST /v1/renew`` — renew a hardware-bound v201 lease."""
        return self._post("/v1/renew", body)

    def checkout(self, body: Mapping[str, Any]) -> ApiResponse:
        """``POST /v1/checkout`` — reserve a floating/concurrent seat.

        The success body carries a short-TTL ``lccoa1`` ``assertion`` plus
        ``seat_id``/``mode``/``expires_at``/``heartbeat_in``.
        """
        return self._post("/v1/checkout", body)

    def heartbeat(self, body: Mapping[str, Any]) -> ApiResponse:
        """``POST /v1/heartbeat`` — renew a live seat's heartbeat. ``seat_id`` required."""
        return self._post("/v1/heartbeat", body)

    def release(self, body: Mapping[str, Any]) -> ApiResponse:
        """``POST /v1/release`` — release a seat (idempotent). ``seat_id`` required."""
        return self._post("/v1/release", body)


def _parse_response(status: int, raw: bytes) -> ApiResponse:
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        return ApiResponse(status=status, ok=False, code=None, data={}, error=f"malformed JSON: {exc}")
    if not isinstance(data, dict):
        return ApiResponse(status=status, ok=False, code=None, data={}, error="response was not a JSON object")
    ok = bool(data.get("ok", False))
    code = data.get("code")
    code = code if isinstance(code, str) else None
    return ApiResponse(status=status, ok=ok, code=code, data=data)
