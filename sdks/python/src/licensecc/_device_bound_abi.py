"""Private ctypes declarations for the installed Windows native owner."""
from __future__ import annotations

import ctypes as ct


class TrustKey(ct.Structure):
    _fields_ = [("spki_size", ct.c_uint32), ("retired", ct.c_uint32), ("spki", ct.c_uint8 * 512)]


class Options(ct.Structure):
    _fields_ = [("size", ct.c_uint32), ("version", ct.c_uint32),
                ("trust_key_count", ct.c_uint32), ("reserved", ct.c_uint32)] + [
        (name, ct.c_char * size) for name, size in [
            ("application_id", 129), ("endpoint_origin", 1025), ("portal_authorization_url", 1025),
            ("issuer", 1025), ("lease_audience", 1025), ("proof_audience", 1025), ("project", 128),
            ("feature", 16), ("client_id", 128), ("device_label", 321), ("callback_path", 256)
        ]
    ] + [("trust_keys", TrustKey * 8)]


class View(ct.Structure):
    _fields_ = [("size", ct.c_uint32), ("version", ct.c_uint32), ("expires_at", ct.c_uint64),
                ("comparison_code", ct.c_char * 15)]


class Outcome(ct.Structure):
    _fields_ = [("size", ct.c_uint32), ("version", ct.c_uint32), ("provider_result", ct.c_uint32),
                ("checkpoint_result", ct.c_uint32), ("renewal_due", ct.c_uint32),
                ("reserved", ct.c_uint32), ("effective_time", ct.c_uint64)]


def expected_layout() -> list[int]:
    values = [1, ct.sizeof(ct.c_void_p), 1, 8, 512]
    for structure in (TrustKey, Options, View, Outcome):
        values.append(ct.sizeof(structure))
        values.append(ct.alignment(structure))
        for field, field_type in structure._fields_:
            values.extend((getattr(structure, field).offset, ct.sizeof(field_type)))
    return values + [0xFFFFFFFF]


class NativeApi:
    def __init__(self, library: ct.CDLL):
        self.library = library  # Keep the DLL alive for every function and client.
        probe = library.lcc_device_bound_bridge_layout
        probe.argtypes, probe.restype = [ct.c_uint32], ct.c_uint32
        if any(probe(index) != value for index, value in enumerate(expected_layout())):
            raise RuntimeError("Incompatible Licensecc device-bound bridge ABI")
        signatures = {
            "init_device_bound_options": (None, [ct.POINTER(Options)]),
            "init_device_bound_view": (None, [ct.POINTER(View)]),
            "init_device_bound_outcome": (None, [ct.POINTER(Outcome)]),
            "device_bound_open_enrollment": (ct.c_int, [ct.POINTER(Options), ct.POINTER(ct.c_void_p), ct.POINTER(Outcome)]),
            "device_bound_open_resume": (ct.c_int, [ct.POINTER(Options), ct.POINTER(ct.c_void_p), ct.POINTER(Outcome)]),
            "device_bound_prepare": (ct.c_int, [ct.c_void_p, ct.POINTER(View)]),
            "device_bound_launch": (ct.c_int, [ct.c_void_p]),
            "device_bound_poll": (ct.c_int, [ct.c_void_p, ct.c_uint32]),
            "device_bound_cancel": (ct.c_int, [ct.c_void_p]),
            "device_bound_close": (None, [ct.c_void_p]),
        }
        for method in ("activate", "renew", "authorize", "save_checkpoint", "abandon_pending"):
            signatures["device_bound_" + method] = (ct.c_int, [ct.c_void_p, ct.POINTER(Outcome)])
        for name, (result, arguments) in signatures.items():
            function = getattr(library, "lcc_" + name)
            function.restype, function.argtypes = result, arguments
            setattr(self, name, function)
