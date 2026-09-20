"""Optional feature-session exports; old device-bound DLLs remain usable."""
import ctypes as ct
from ._device_bound_abi import Options


class Outcome(ct.Structure):
    _fields_ = [(name, ct.c_uint32) for name in
                ("size", "version", "state", "provider_result", "checkpoint_result", "renewal_due")]
    _fields_ += [("reserved", ct.c_uint32 * 2)]
    _fields_ += [(name, ct.c_uint64) for name in ("effective_time", "renew_after", "expires_at")]


def expected_layout():
    values = [1, ct.sizeof(ct.c_void_p), ct.sizeof(Outcome), ct.alignment(Outcome)]
    for name, kind in Outcome._fields_:
        values.extend((getattr(Outcome, name).offset, ct.sizeof(kind)))
    return values + [0xFFFFFFFF]


class NativeApi:
    def __init__(self, existing):
        self.existing = existing
        self.library = existing.library
        try:
            probe = self.library.lcc_feature_session_bridge_layout
            probe.argtypes, probe.restype = [ct.c_uint32], ct.c_uint32
            if any(probe(index) != value for index, value in enumerate(expected_layout())):
                raise RuntimeError("Incompatible Licensecc feature-session bridge ABI")
            signatures = {
                "init_feature_session_outcome": (None, [ct.POINTER(Outcome)]),
                "feature_session_open": (ct.c_int, [ct.POINTER(Options), ct.POINTER(ct.c_void_p), ct.POINTER(Outcome)]),
                "feature_session_authorize": (ct.c_int, [ct.c_void_p, ct.c_char_p, ct.POINTER(Outcome)]),
                "feature_session_close": (None, [ct.c_void_p]),
            }
            for operation in ("start", "renew", "stop", "save_checkpoint"):
                signatures["feature_session_" + operation] = (ct.c_int, [ct.c_void_p, ct.POINTER(Outcome)])
            for name, (result, arguments) in signatures.items():
                function = getattr(self.library, "lcc_" + name)
                function.restype, function.argtypes = result, arguments
                setattr(self, name, function)
        except AttributeError as error:
            raise NotImplementedError("This native bridge does not support feature sessions") from error
