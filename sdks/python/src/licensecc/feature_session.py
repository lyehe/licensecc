"""One native owner per feature job. No Python permission cache or token parser.

Enroll each feature with DeviceBoundLibrary first. Every start is online; only
authorize(required_feature).code == Result.OK permits the next work unit.
"""
from __future__ import annotations
import ctypes as ct
from dataclasses import dataclass
from enum import IntEnum
import re
import threading
import weakref
from . import _feature_session_abi as abi
from .device_bound import (
    Configuration, DeviceBoundLibrary, Result, CheckpointResult, ProviderResult,
    _encode_configuration,
)


class State(IntEnum):
    UNKNOWN = 0
    READY = 1
    STARTING = 2
    ACTIVE = 3
    NEEDS_ONLINE = 4
    DENIED = 5
    FAILED = 6
    STOPPED = 7


@dataclass(frozen=True)
class Outcome:
    code: Result
    state: State = State.UNKNOWN
    provider_result: ProviderResult = ProviderResult.OK
    checkpoint_result: CheckpointResult = CheckpointResult.NOT_ATTEMPTED
    renewal_due: bool = False
    effective_time: int = 0
    renew_after: int = 0
    expires_at: int = 0

    def __bool__(self):
        raise TypeError("Compare outcome.code explicitly; authorize Result.OK permits the next work unit")


def _decode(code, raw):
    if (raw.size != ct.sizeof(abi.Outcome) or raw.version != 1 or any(raw.reserved)
            or raw.renewal_due not in (0, 1)):
        raise RuntimeError("Invalid native feature-session outcome ABI")
    return Outcome(Result(code), State(raw.state), ProviderResult(raw.provider_result),
                   CheckpointResult(raw.checkpoint_result), raw.renewal_due == 1,
                   raw.effective_time, raw.renew_after, raw.expires_at)


class _Owner:
    def __init__(self, api):
        self.api, self.handle, self.lock = api, ct.c_void_p(), threading.Lock()

    def close(self):
        with self.lock:
            if self.handle.value:
                handle, self.handle.value = self.handle.value, None
                self.api.feature_session_close(handle)


class FeatureSessionLibrary:
    """Load the same application-owned absolute 64-bit Windows/Linux bridge library.

    An older DLL raises NotImplementedError here; old DeviceBoundLibrary APIs
    remain available. Calls block and belong on an application worker thread.
    """
    def __init__(self, dll_path):
        self._device_library = DeviceBoundLibrary(dll_path)
        self._api = abi.NativeApi(self._device_library._api)

    def open(self, configuration: Configuration) -> tuple[FeatureSession | None, Outcome]:
        options = _encode_configuration(self._api.existing, configuration)
        session = FeatureSession._create(self._api)
        accepted = False
        try:
            raw = abi.Outcome()
            self._api.init_feature_session_outcome(ct.byref(raw))
            code = self._api.feature_session_open(ct.byref(options), ct.byref(session._owner.handle), ct.byref(raw))
            result = _decode(code, raw)
            if result.code is not Result.OK:
                if session._owner.handle.value:
                    raise RuntimeError("Failed native open returned a handle")
                return None, result
            if not session._owner.handle.value:
                raise RuntimeError("Successful native open returned no handle")
            accepted = True
            return session, result
        finally:
            if not accepted:
                session.close()


class FeatureSession:
    """Opaque, non-copyable, terminal work session; use a new owner for a new job."""
    def __init__(self):
        raise TypeError("Use FeatureSessionLibrary.open")

    @classmethod
    def _create(cls, api):
        session = object.__new__(cls)
        session._owner = _Owner(api)
        session._finalizer = weakref.finalize(session, session._owner.close)
        session._finalizer.atexit = False
        return session

    def __copy__(self):
        raise TypeError("Feature sessions cannot be copied")

    def __deepcopy__(self, memo):
        raise TypeError("Feature sessions cannot be copied")

    def __reduce_ex__(self, protocol):
        raise TypeError("Feature sessions cannot be pickled")

    def _call(self, operation, feature=None):
        owner = self._owner
        if not owner.lock.acquire(blocking=False):
            return Outcome(Result.BUSY)
        try:
            if not owner.handle.value:
                raise RuntimeError("Feature session is closed")
            raw = abi.Outcome()
            owner.api.init_feature_session_outcome(ct.byref(raw))
            function = getattr(owner.api, "feature_session_" + operation)
            code = function(owner.handle, feature, ct.byref(raw)) if feature is not None else function(owner.handle, ct.byref(raw))
            return _decode(code, raw)
        finally:
            owner.lock.release()

    def start(self) -> Outcome:
        return self._call("start")

    def authorize(self, required_feature: str) -> Outcome:
        if not isinstance(required_feature, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", required_feature):
            raise ValueError("Expected a 1..15-character feature ID")
        return self._call("authorize", required_feature.encode("ascii"))

    def renew(self) -> Outcome:
        return self._call("renew")

    def stop(self) -> Outcome:
        return self._call("stop")

    def save_checkpoint(self) -> Outcome:
        return self._call("save_checkpoint")

    def close(self):
        self._owner.close()
        self._finalizer.detach()

    def __enter__(self):
        with self._owner.lock:
            if not self._owner.handle.value:
                raise RuntimeError("Feature session is closed")
        return self

    def __exit__(self, *_):
        self.close()
