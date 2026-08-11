"""Thin HTTP client for the licensecc licensing-backend Worker.

SCOPE — read this first
-----------------------
This client is a small, hand-written wrapper over the documented client-facing
endpoints (``POST /v1/verify``, ``/v1/activate``, ``/v1/renew``, ``/v1/checkout``,
``/v1/heartbeat``, ``/v1/release``, ``/v1/meter`` and ``GET /v1/admin/report``).
It sends the documented JSON body/query and parses
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
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from dataclasses import dataclass, field
from typing import Any, Mapping

DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_BACKOFF_SECONDS = 0.5
# 429 (rate limited) + transient 5xx are retryable; 4xx (auth/validation) and 200 are not.
RETRYABLE_STATUSES = frozenset({429, 502, 503, 504})
_REQUEST_PROOF_FIELDS = (
    "device_key_id",
    "request_signature_version",
    "request_timestamp",
    "request_signature_algorithm",
    "request_signature",
)
_DEPRECATED_REQUEST_PROOF_ALIASES = {
    "device_key_id": "device_key_id",
    "version": "request_signature_version",
    "request_signature_version": "request_signature_version",
    "request_timestamp": "request_timestamp",
    "algorithm": "request_signature_algorithm",
    "request_signature_algorithm": "request_signature_algorithm",
    "signature": "request_signature",
    "request_signature": "request_signature",
}


def _json_values_equal(left: Any, right: Any) -> bool:
    """Compare values without Python's bool-is-an-int equality leak."""
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        return isinstance(left, (int, float)) and isinstance(right, (int, float)) and left == right
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if isinstance(left, Mapping) or isinstance(right, Mapping):
        if not isinstance(left, Mapping) or not isinstance(right, Mapping) or left.keys() != right.keys():
            return False
        return all(_json_values_equal(left[key], right[key]) for key in left)
    if isinstance(left, (list, tuple)) or isinstance(right, (list, tuple)):
        if not isinstance(left, (list, tuple)) or not isinstance(right, (list, tuple)) or len(left) != len(right):
            return False
        return all(_json_values_equal(left_value, right_value) for left_value, right_value in zip(left, right))
    return type(left) is type(right) and left == right


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
        user_agent: str = "licensecc-python-sdk/0.1.0rc1",
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_backoff: float = DEFAULT_RETRY_BACKOFF_SECONDS,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.account_token = account_token
        self.timeout = timeout
        self.user_agent = user_agent
        # Bounded retry: a transient transport failure or a 429/5xx is retried up to max_retries times,
        # honoring a Retry-After header, else exponential backoff. Set max_retries=0 to disable.
        self.max_retries = max(0, int(max_retries))
        self.retry_backoff = max(0.0, float(retry_backoff))

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

        attempt = 0
        while True:
            retry_after: float | None = None
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return _parse_response(response.getcode(), response.read())
            except urllib.error.HTTPError as exc:
                # The Worker returns the FLAT envelope even on 4xx/5xx — parse it.
                if exc.code in RETRYABLE_STATUSES and attempt < self.max_retries:
                    retry_after = _parse_retry_after(exc.headers.get("Retry-After") if exc.headers else None)
                else:
                    return _parse_response(exc.code, exc.read())
            except urllib.error.URLError as exc:
                if attempt >= self.max_retries:
                    return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc.reason))
            except Exception as exc:  # noqa: BLE001 - surface transport errors, never raise
                if attempt >= self.max_retries:
                    return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc))
            # Retryable outcome: back off (Retry-After, else exponential) and try again.
            delay = retry_after if retry_after is not None else self.retry_backoff * (2 ** attempt)
            if delay > 0:
                time.sleep(delay)
            attempt += 1

    def _get(self, path: str, query: Mapping[str, Any]) -> ApiResponse:
        query_string = urllib.parse.urlencode(query)
        url = self.base_url + path
        if query_string:
            url += "?" + query_string
        headers = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self.account_token:
            headers["Authorization"] = f"Bearer {self.account_token}"
        request = urllib.request.Request(url, headers=headers, method="GET")

        attempt = 0
        while True:
            retry_after: float | None = None
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return _parse_response(response.getcode(), response.read())
            except urllib.error.HTTPError as exc:
                if exc.code in RETRYABLE_STATUSES and attempt < self.max_retries:
                    retry_after = _parse_retry_after(exc.headers.get("Retry-After") if exc.headers else None)
                else:
                    return _parse_response(exc.code, exc.read())
            except urllib.error.URLError as exc:
                if attempt >= self.max_retries:
                    return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc.reason))
            except Exception as exc:  # noqa: BLE001 - surface transport errors, never raise
                if attempt >= self.max_retries:
                    return ApiResponse(status=0, ok=False, code=None, data={}, error=str(exc))
            delay = retry_after if retry_after is not None else self.retry_backoff * (2 ** attempt)
            if delay > 0:
                time.sleep(delay)
            attempt += 1

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
        *,
        device_key_id: str | None = None,
        request_signature_version: int | None = None,
        request_timestamp: int | None = None,
        request_signature_algorithm: str | None = None,
        request_signature: str | None = None,
    ) -> ApiResponse:
        """``POST /v1/verify`` — request a signed ``lccoa1`` assertion (or a denial).

        On ``ok:true`` the ``assertion`` field carries the token; verify it
        locally with :func:`licensecc.verify_online_assertion` using the nonce
        you supplied here. A soft denial is HTTP 200 with ``ok:false``. The
        ``request_proof`` mapping remains accepted for 0.1.x compatibility but
        is deprecated; pass its five fields as keyword arguments instead.
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
        proof_fields = {
            key: value
            for key, value in {
                "device_key_id": device_key_id,
                "request_signature_version": request_signature_version,
                "request_timestamp": request_timestamp,
                "request_signature_algorithm": request_signature_algorithm,
                "request_signature": request_signature,
            }.items()
            if value is not None
        }
        if request_proof is not None:
            warnings.warn(
                "request_proof is deprecated; pass the five flat request-proof fields instead",
                DeprecationWarning,
                stacklevel=2,
            )
            deprecated_fields: dict[str, Any] = {}
            for key, value in request_proof.items():
                wire_key = _DEPRECATED_REQUEST_PROOF_ALIASES.get(key)
                if wire_key is None:
                    raise ValueError(f"unsupported request proof field: {key}")
                if wire_key in deprecated_fields and not _json_values_equal(deprecated_fields[wire_key], value):
                    raise ValueError(f"conflicting request proof field: {wire_key}")
                deprecated_fields[wire_key] = value
            for key, value in deprecated_fields.items():
                if key in proof_fields and not _json_values_equal(proof_fields[key], value):
                    raise ValueError(f"conflicting request proof field: {key}")
                proof_fields[key] = value
        for key in _REQUEST_PROOF_FIELDS:
            if key in proof_fields:
                body[key] = proof_fields[key]
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

    def meter(self, body: Mapping[str, Any]) -> ApiResponse:
        """``POST /v1/meter`` — record metered units for an entitlement.

        The body follows ``MeterRequest``: ``project``, ``feature`` and
        ``license_fingerprint`` are required; ``units`` is an optional positive
        integer and defaults to one. The account bearer, when configured, is
        applied just as it is for the lease/seat endpoints.
        """
        return self._post("/v1/meter", body)

    def report(
        self,
        project: str,
        feature: str,
        license_fingerprint: str,
        from_epoch: int | None = None,
        to_epoch: int | None = None,
    ) -> ApiResponse:
        """``GET /v1/admin/report`` — return the usage summary for an entitlement.

        ``from_epoch`` and ``to_epoch`` map to the route's optional ``from`` and
        ``to`` Unix-second query parameters. The response remains the generic
        flat :class:`ApiResponse` so endpoint-specific report fields are
        available through ``data`` without introducing a second wire contract.
        """
        query: dict[str, Any] = {
            "project": project,
            "feature": feature,
            "license_fingerprint": license_fingerprint,
        }
        if from_epoch is not None:
            query["from"] = from_epoch
        if to_epoch is not None:
            query["to"] = to_epoch
        return self._get("/v1/admin/report", query)


def _parse_retry_after(value: str | None) -> float | None:
    """Retry-After as delay seconds. Only the integer-seconds form is honored; the HTTP-date form
    falls back to exponential backoff (returns None)."""
    if value is None:
        return None
    stripped = value.strip()
    return float(stripped) if stripped.isdigit() else None


def _parse_response(status: int, raw: bytes) -> ApiResponse:
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        return ApiResponse(status=status, ok=False, code=None, data={}, error=f"malformed JSON: {exc}")
    if not isinstance(data, dict):
        return ApiResponse(status=status, ok=False, code=None, data={}, error="response was not a JSON object")
    # Strictly require a real JSON boolean true. bool("false") is truthy, so the
    # previous bool(...) coercion read a string/number body as a grant (fail-open).
    ok = data.get("ok") is True
    code = data.get("code")
    code = code if isinstance(code, str) else None
    return ApiResponse(status=status, ok=ok, code=code, data=data)
