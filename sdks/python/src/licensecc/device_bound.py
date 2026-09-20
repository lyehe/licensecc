"""Typed Windows native-owner bridge; no Python lease or authorization state.

Build the matching DLL under ``sdks/python/native`` against an installed runtime.
Only ``authorize().code is Result.OK`` permits the next protected operation.
Keep valuable protected work in native code when process tampering matters.
"""
from __future__ import annotations

import ctypes as ct
import os
from pathlib import Path
import re
import threading
import weakref
from dataclasses import dataclass, fields
from enum import IntEnum

from . import _device_bound_abi as abi


class Result(IntEnum):
    OK = 0
    INVALID_ARGUMENT = 1
    UNSUPPORTED_VERSION = 2
    UNSUPPORTED_PLATFORM = 3
    BUSY = 4
    INVALID_STATE = 5
    RETRY = 6
    CONFLICT = 7
    DENIED = 8
    EXPIRED = 9
    WAITING = 10
    CALLBACK_REJECTED = 11
    CALLBACK_RECEIVED = 12
    ENROLLMENT_REQUIRED = 13
    ONLINE_REQUIRED = 14
    RESUME_REQUIRED = 15
    INVALID_RESPONSE = 16
    PROVIDER_ERROR = 17
    STORAGE_ERROR = 18
    BROWSER_UNAVAILABLE = 19
    CANCELLED = 20
    INTERNAL_ERROR = 255

    def __bool__(self) -> bool:
        raise TypeError("Compare the result explicitly; only authorize returning Result.OK grants access")


class CheckpointResult(IntEnum):
    NOT_ATTEMPTED = 0
    SAVED = 1
    UNCHANGED = 2
    MISSING = 3
    BUSY = 4
    STALE = 5
    CONFLICT = 6
    INVALID = 7
    IO_ERROR = 8
    MIRROR_PENDING = 9
    COMMIT_UNKNOWN = 10
    LOADED = 11


class ProviderResult(IntEnum):
    OK = 0
    INVALID_ARGUMENT = 1
    UNSUPPORTED_VERSION = 2
    BUFFER_TOO_SMALL = 3
    PROVIDER_UNAVAILABLE = 4
    HARDWARE_UNAVAILABLE = 5
    ACCESS_DENIED = 6
    KEY_NOT_FOUND = 7
    KEY_CORRUPT = 8
    KEY_LOST = 9
    UNSUPPORTED_ALGORITHM = 10
    SIGN_FAILED = 11
    IO_ERROR = 12
    BUSY = 13
    POLICY_VIOLATION = 14
    INTERNAL_ERROR = 255


@dataclass(frozen=True)
class Outcome:
    code: Result
    provider_result: ProviderResult = ProviderResult.OK
    checkpoint_result: CheckpointResult = CheckpointResult.NOT_ATTEMPTED
    renewal_due: bool = False
    effective_time: int = 0

    def __bool__(self) -> bool:
        raise TypeError("Inspect outcome.code explicitly; only authorize Result.OK grants access")


@dataclass(frozen=True)
class EnrollmentView:
    comparison_code: str
    expires_at: int  # Display only; never an offline acceptance clock.


@dataclass(frozen=True)
class TrustedSigner:
    spki_der: bytes
    retired: bool = False

    def __post_init__(self) -> None:
        if not isinstance(self.spki_der, (bytes, bytearray, memoryview)) or type(self.retired) is not bool:
            raise ValueError("Expected public DER bytes and a boolean retirement flag")
        copied = bytes(self.spki_der)
        if not 1 <= len(copied) <= 512:
            raise ValueError("Public signing SPKI must contain 1..512 bytes")
        object.__setattr__(self, "spki_der", copied)


@dataclass(frozen=True)
class Configuration:
    application_id: str
    endpoint_origin: str
    portal_authorization_url: str
    issuer: str
    lease_audience: str
    proof_audience: str
    project: str
    feature: str
    client_id: str
    device_label: str
    trust_keys: tuple[TrustedSigner, ...]
    callback_path: str = "/callback"

    def __post_init__(self) -> None:
        keys = tuple(self.trust_keys)
        if not 1 <= len(keys) <= 8 or any(type(key) is not TrustedSigner for key in keys):
            raise ValueError("Expected 1..8 TrustedSigner records")
        object.__setattr__(self, "trust_keys", keys)
        capacities = dict(abi.Options._fields_)
        for field in fields(self):
            if field.name == "trust_keys":
                continue
            value = getattr(self, field.name)
            if not isinstance(value, str) or "\0" in value:
                raise ValueError("Configuration text must be NUL-free UTF-8")
            if len(value.encode("utf-8", errors="strict")) >= ct.sizeof(capacities[field.name]):
                raise ValueError("Configuration text exceeds its native field capacity")


def _outcome(code: int, raw: abi.Outcome) -> Outcome:
    if raw.size != ct.sizeof(abi.Outcome) or raw.version != 1 or raw.reserved != 0 or raw.renewal_due not in (0, 1):
        raise RuntimeError("Invalid native outcome ABI")
    return Outcome(Result(code), ProviderResult(raw.provider_result), CheckpointResult(raw.checkpoint_result),
                   raw.renewal_due == 1, raw.effective_time)


def _encode_configuration(api, configuration: Configuration) -> abi.Options:
    if type(configuration) is not Configuration:
        raise TypeError("Expected Configuration")
    options = abi.Options()
    api.init_device_bound_options(ct.byref(options))
    for field in fields(configuration):
        if field.name != "trust_keys":
            setattr(options, field.name, getattr(configuration, field.name).encode("utf-8"))
    options.trust_key_count = len(configuration.trust_keys)
    for index, key in enumerate(configuration.trust_keys):
        options.trust_keys[index].spki_size = len(key.spki_der)
        options.trust_keys[index].retired = int(key.retired)
        options.trust_keys[index].spki[:len(key.spki_der)] = key.spki_der
    return options


class _State:
    def __init__(self, api: abi.NativeApi):
        self.api = api
        self.handle = ct.c_void_p()
        self.lock = threading.Lock()

    def close(self) -> None:
        with self.lock:
            if self.handle.value:
                handle = self.handle.value
                self.handle.value = None
                self.api.device_bound_close(handle)


class DeviceBoundLibrary:
    """Load an application-owned absolute DLL path; never search PATH or cwd.

    The application must protect the DLL and its configuration from replacement.
    The bridge does not establish trust in an arbitrary caller-supplied DLL.
    """

    def __init__(self, dll_path: str | os.PathLike[str]):
        if os.name != "nt" or ct.sizeof(ct.c_void_p) != 8:
            raise OSError("The device-bound Python bridge requires 64-bit Windows")
        path = Path(dll_path)
        if not path.is_absolute():
            raise ValueError("An absolute application-owned DLL path is required")
        path = path.resolve(strict=True)
        if not path.is_file():
            raise ValueError("The DLL path must name a file")
        # LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32.
        # Do not inherit cwd, PATH or process-added DLL directories.
        self._api = abi.NativeApi(ct.CDLL(str(path), winmode=0x00000100 | 0x00000800))

    def open_enrollment(self, configuration: Configuration) -> tuple[DeviceBoundClient | None, Outcome]:
        """Explicitly allow key creation when native storage proves no prior state."""
        return self._open(configuration, "open_enrollment")

    def open_resume(self, configuration: Configuration) -> tuple[DeviceBoundClient | None, Outcome]:
        """Open an existing key/checkpoint; fresh online renewal is mandatory."""
        return self._open(configuration, "open_resume")

    def _open(self, configuration: Configuration, operation: str) -> tuple[DeviceBoundClient | None, Outcome]:
        options = _encode_configuration(self._api, configuration)
        client = DeviceBoundClient._create(self._api)
        accepted = False
        try:
            raw = abi.Outcome()
            self._api.init_device_bound_outcome(ct.byref(raw))
            code = getattr(self._api, "device_bound_" + operation)(
                ct.byref(options), ct.byref(client._state.handle), ct.byref(raw))
            outcome = _outcome(code, raw)
            if outcome.code is not Result.OK:
                return None, outcome
            if not client._state.handle.value:
                raise RuntimeError("Native open returned no client")
            result = (client, outcome)
            accepted = True
            return result
        finally:
            if not accepted:
                client.close()


class DeviceBoundClient:
    """Opaque native owner. Close explicitly before shutting down worker threads.

    Calls do no automatic retries. Handle primary and checkpoint outcomes
    independently. Closing does not save pending state or delete the TPM key.
    """

    def __init__(self) -> None:
        raise TypeError("Use DeviceBoundLibrary.open_enrollment or open_resume")

    def __copy__(self):
        raise TypeError("Device-bound clients cannot be copied")

    def __deepcopy__(self, memo):
        raise TypeError("Device-bound clients cannot be copied")

    def __reduce_ex__(self, protocol):
        raise TypeError("Device-bound clients cannot be pickled")

    @classmethod
    def _create(cls, api: abi.NativeApi) -> DeviceBoundClient:
        client = object.__new__(cls)
        client._state = _State(api)
        client._finalizer = weakref.finalize(client, client._state.close)
        client._finalizer.atexit = False
        return client

    def close(self) -> None:
        # Explicit callers always wait for an in-flight close as well as a call.
        self._state.close()
        self._finalizer.detach()

    def __enter__(self) -> DeviceBoundClient:
        with self._state.lock:
            if not self._state.handle.value:
                raise RuntimeError("Device-bound client is closed")
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _call(self, operation: str, *, wait_ms: int = 0):
        state = self._state
        if not state.lock.acquire(blocking=False):
            return Outcome(Result.BUSY) if operation in _OUTCOME_CALLS else (Result.BUSY, None) if operation == "prepare" else Result.BUSY
        try:
            if not state.handle.value:
                raise RuntimeError("Device-bound client is closed")
            function = getattr(state.api, "device_bound_" + operation)
            if operation in _OUTCOME_CALLS:
                raw = abi.Outcome()
                state.api.init_device_bound_outcome(ct.byref(raw))
                return _outcome(function(state.handle, ct.byref(raw)), raw)
            if operation == "prepare":
                view = abi.View()
                state.api.init_device_bound_view(ct.byref(view))
                code = Result(function(state.handle, ct.byref(view)))
                if code is not Result.OK:
                    return code, None
                display = view.comparison_code.decode("ascii", errors="strict")
                if view.size != ct.sizeof(abi.View) or view.version != 1 or not re.fullmatch(r"[0-9A-F]{4}(?:-[0-9A-F]{4}){2}", display):
                    raise RuntimeError("Invalid native enrollment view")
                return code, EnrollmentView(display, view.expires_at)
            return Result(function(state.handle, wait_ms) if operation == "poll" else function(state.handle))
        finally:
            state.lock.release()

    def prepare(self) -> tuple[Result, EnrollmentView | None]:
        return self._call("prepare")

    def launch(self) -> Result:
        """Launch only after displaying and flushing prepare's comparison code."""
        return self._call("launch")

    def poll(self, wait_ms: int = 0) -> Result:
        if type(wait_ms) is not int or not 0 <= wait_ms <= 1000:
            raise ValueError("wait_ms must be an integer in 0..1000")
        return self._call("poll", wait_ms=wait_ms)

    def activate(self) -> Outcome:
        return self._call("activate")

    def renew(self) -> Outcome:
        return self._call("renew")

    def authorize(self) -> Outcome:
        return self._call("authorize")

    def save_checkpoint(self) -> Outcome:
        return self._call("save_checkpoint")

    def abandon_pending(self) -> Outcome:
        return self._call("abandon_pending")

    def cancel(self) -> Result:
        return self._call("cancel")


_OUTCOME_CALLS = frozenset({"activate", "renew", "authorize", "save_checkpoint", "abandon_pending"})
