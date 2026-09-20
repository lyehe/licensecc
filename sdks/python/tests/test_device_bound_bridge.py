"""Bridge boundary tests; private fakes do not claim TPM or protocol evidence."""
import copy
import ctypes as ct
import gc
import os
from pathlib import Path
import pickle
import threading
from types import SimpleNamespace

import pytest

from licensecc import _device_bound_abi as abi
from licensecc.device_bound import (
    CheckpointResult, Configuration, DeviceBoundClient, DeviceBoundLibrary,
    Outcome, ProviderResult, Result, TrustedSigner,
)


def config(**changes):
    values = dict(application_id="bridge-test", endpoint_origin="https://license.example.test",
                  portal_authorization_url="https://portal.example.test/authorize",
                  issuer="https://license.example.test", lease_audience="desktop", proof_audience="desktop",
                  project="CAD", feature="DEFAULT", client_id="desktop", device_label="Workstation é",
                  trust_keys=(TrustedSigner(b"invalid-public-key"),))
    return Configuration(**(values | changes))


def pointed(pointer, structure):
    return ct.cast(pointer, ct.POINTER(structure)).contents


class FakeApi:
    def __init__(self):
        self.closed = []
        self.operations = []
        self.open_failure = None
        self.operation_code = Result.OK
        self.provider = ProviderResult.OK
        self.checkpoint = CheckpointResult.NOT_ATTEMPTED
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False

    def init_device_bound_options(self, pointer):
        raw = pointed(pointer, abi.Options)
        raw.size, raw.version = ct.sizeof(abi.Options), 1

    def init_device_bound_outcome(self, pointer):
        raw = pointed(pointer, abi.Outcome)
        raw.size, raw.version = ct.sizeof(abi.Outcome), 1

    def init_device_bound_view(self, pointer):
        raw = pointed(pointer, abi.View)
        raw.size, raw.version = ct.sizeof(abi.View), 1

    def device_bound_open_enrollment(self, options, handle, outcome):
        self.options = pointed(options, abi.Options)
        pointed(handle, ct.c_void_p).value = 123
        if self.open_failure is not None:
            raise self.open_failure
        return Result.OK

    device_bound_open_resume = device_bound_open_enrollment

    def device_bound_close(self, handle):
        self.closed.append(handle)

    def device_bound_authorize(self, handle, outcome):
        self.operations.append("authorize")
        if self.block:
            self.entered.set()
            assert self.release.wait(5), "test did not release native call"
        raw = pointed(outcome, abi.Outcome)
        raw.provider_result, raw.checkpoint_result = self.provider, self.checkpoint
        return self.operation_code

    device_bound_activate = device_bound_authorize
    device_bound_renew = device_bound_authorize
    device_bound_save_checkpoint = device_bound_authorize
    device_bound_abandon_pending = device_bound_authorize

    def device_bound_prepare(self, handle, view):
        raw = pointed(view, abi.View)
        raw.comparison_code, raw.expires_at = b"3885-783E-2C02", 2000000300
        return Result.OK

    def device_bound_poll(self, handle, wait_ms):
        self.operations.append(wait_ms)
        return Result.WAITING

    def device_bound_cancel(self, handle):
        return Result.CANCELLED

    def device_bound_launch(self, handle):
        return Result.OK


def library(api):
    result = object.__new__(DeviceBoundLibrary)
    result._api = api
    return result


def test_configuration_is_deeply_immutable_and_utf8_is_copied():
    data = bytearray(b"public-key")
    signer = TrustedSigner(data)
    keys = [signer]
    configuration = config(trust_keys=keys)
    data[0] = 0
    keys.clear()
    assert configuration.trust_keys[0].spki_der == b"public-key"
    api = FakeApi()
    client, result = library(api).open_enrollment(configuration)
    assert result.code is Result.OK
    assert api.options.device_label == "Workstation é".encode()
    assert bytes(api.options.trust_keys[0].spki[:10]) == b"public-key"
    client.close()


@pytest.mark.parametrize("value", ["x\0y", "\ud800", "é" * 161, 12, None])
def test_invalid_text_is_rejected_before_native_open(value):
    with pytest.raises((ValueError, UnicodeError)):
        config(device_label=value)


@pytest.mark.parametrize("value", [-1, 1001, 2**32, True, 1.5, "1"])
def test_wait_conversion_cannot_wrap(value):
    api = FakeApi()
    client, _ = library(api).open_resume(config())
    with client, pytest.raises(ValueError):
        client.poll(value)
    assert not api.operations


def test_no_implicit_authorization_or_copying_and_no_retry():
    api = FakeApi()
    client, _ = library(api).open_resume(config())
    with client:
        for copier in (copy.copy, copy.deepcopy, pickle.dumps):
            with pytest.raises(TypeError):
                copier(client)
        for code in (Result.OK, Result.DENIED):
            with pytest.raises(TypeError):
                bool(code)
            with pytest.raises(TypeError):
                bool(Outcome(code))
        api.operation_code = Result.RETRY
        assert client.renew().code is Result.RETRY
        assert api.operations == ["authorize"]
        code, view = client.prepare()
        assert code is Result.OK and view.comparison_code == "3885-783E-2C02"
        assert client.poll(1000) is Result.WAITING
    client.close()
    assert api.closed == [123]
    with pytest.raises(RuntimeError):
        client.authorize()


def test_primary_and_checkpoint_outcomes_remain_independent():
    api = FakeApi()
    api.operation_code, api.provider = Result.PROVIDER_ERROR, ProviderResult.SIGN_FAILED
    api.checkpoint = CheckpointResult.COMMIT_UNKNOWN
    client, _ = library(api).open_resume(config())
    with client:
        original = client.renew()
        api.operation_code, api.provider, api.checkpoint = Result.OK, ProviderResult.OK, CheckpointResult.SAVED
        saved = client.save_checkpoint()
        assert original.code is Result.PROVIDER_ERROR and original.provider_result is ProviderResult.SIGN_FAILED
        assert original.checkpoint_result is CheckpointResult.COMMIT_UNKNOWN
        assert saved.checkpoint_result is CheckpointResult.SAVED


@pytest.mark.parametrize("failure", [RuntimeError("failure"), KeyboardInterrupt(), SystemExit()])
def test_open_exception_after_native_handle_allocation_closes_once(failure):
    api = FakeApi()
    api.open_failure = failure
    with pytest.raises(type(failure)):
        library(api).open_enrollment(config())
    gc.collect()
    assert api.closed == [123]


def test_concurrent_call_returns_busy_and_close_waits():
    api = FakeApi()
    client, _ = library(api).open_resume(config())
    api.block = True
    result = []
    call = threading.Thread(target=lambda: result.append(client.authorize()))
    closed = threading.Event()
    closer = threading.Thread(target=lambda: (client.close(), closed.set()))
    call.start()
    try:
        assert api.entered.wait(3)
        assert client.renew().code is Result.BUSY
        assert client.prepare() == (Result.BUSY, None)
        assert client.cancel() is Result.BUSY
        closer.start()
        assert not closed.wait(0.05)
        assert api.closed == []
    finally:
        api.release.set()
        call.join(3)
        if closer.ident is not None:
            closer.join(3)
        client.close()
    assert closed.is_set() and result[0].code is Result.OK
    assert api.closed == [123]


def test_finalizer_owns_state_not_client_and_is_disabled_at_exit():
    api = FakeApi()
    client, _ = library(api).open_resume(config())
    assert client._finalizer.atexit is False
    del client
    gc.collect()
    assert api.closed == [123]


@pytest.mark.parametrize("field,value", [("version", 2), ("renewal_due", 2), ("reserved", 1),
                                          ("provider_result", 99), ("checkpoint_result", 99)])
def test_unknown_native_outcomes_fail_closed(field, value):
    from licensecc.device_bound import _outcome
    raw = abi.Outcome(size=ct.sizeof(abi.Outcome), version=1)
    setattr(raw, field, value)
    with pytest.raises((RuntimeError, ValueError)):
        _outcome(0, raw)
    with pytest.raises(ValueError):
        _outcome(99, abi.Outcome(size=ct.sizeof(abi.Outcome), version=1))


@pytest.mark.parametrize("index", range(len(abi.expected_layout())))
def test_every_layout_mismatch_rejects_before_initialization(index):
    class Probe:
        def __call__(self, position):
            expected = abi.expected_layout()[position]
            return expected ^ 1 if position == index else expected
    fake = SimpleNamespace(lcc_device_bound_bridge_layout=Probe())
    with pytest.raises(RuntimeError, match="ABI"):
        abi.NativeApi(fake)


def test_installed_windows_dll_without_provisioning():
    path = os.environ.get("LCC_TEST_DEVICE_BOUND_DLL")
    if not path:
        pytest.skip("Set LCC_TEST_DEVICE_BOUND_DLL for the installed Windows bridge test")
    assert os.name == "nt" and Path(path).is_absolute()
    native = DeviceBoundLibrary(path)
    # Malformed public DER is rejected by native validation before provider/storage effects.
    for open_method in (native.open_enrollment, native.open_resume):
        client, outcome = open_method(config())
        assert client is None and outcome.code is Result.INVALID_ARGUMENT
        assert outcome.checkpoint_result is CheckpointResult.NOT_ATTEMPTED


@pytest.mark.skipif(os.name != "nt", reason="Windows loader policy")
def test_loader_uses_absolute_path_and_restricted_dependency_search(tmp_path, monkeypatch):
    import licensecc.device_bound as module
    dll = tmp_path / "owned.dll"
    dll.write_bytes(b"not-loaded")
    calls = []
    sentinel = object()
    monkeypatch.setattr(module.ct, "CDLL", lambda path, **kwargs: calls.append((path, kwargs)) or sentinel)
    monkeypatch.setattr(module.abi, "NativeApi", lambda loaded: loaded)
    with pytest.raises(ValueError):
        DeviceBoundLibrary("owned.dll")
    assert not calls
    assert DeviceBoundLibrary(dll)._api is sentinel
    assert calls == [(str(dll.resolve()), {"winmode": 0x900})]
