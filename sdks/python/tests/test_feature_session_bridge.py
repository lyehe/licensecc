"""Optional adapter contract; fake calls are not native authorization evidence."""
import copy
import ctypes as ct
import os
from types import SimpleNamespace
import pytest
from licensecc import _feature_session_abi as abi
from licensecc.feature_session import FeatureSession, FeatureSessionLibrary, Outcome, State, _decode
from licensecc.device_bound import CheckpointResult, Result, DeviceBoundLibrary
from test_device_bound_bridge import FakeApi as DeviceApi, config, pointed


class FakeApi:
    def __init__(self):
        self.existing = DeviceApi()
        self.closed, self.calls = [], []
        self.code = Result.OK
        self.checkpoint = CheckpointResult.UNCHANGED
        self.next_handle = 1

    def init_feature_session_outcome(self, pointer):
        raw = pointed(pointer, abi.Outcome)
        raw.size, raw.version = ct.sizeof(abi.Outcome), 1

    def feature_session_open(self, options, handle, outcome):
        pointed(handle, ct.c_void_p).value = self.next_handle
        self.next_handle += 1
        pointed(outcome, abi.Outcome).state = State.READY
        return Result.OK

    def feature_session_close(self, handle):
        self.closed.append(handle)

    def feature_session_start(self, handle, pointer):
        self.calls.append((handle.value, "start"))
        raw = pointed(pointer, abi.Outcome)
        raw.state, raw.checkpoint_result = State.ACTIVE, self.checkpoint
        return self.code

    def feature_session_authorize(self, handle, feature, pointer):
        self.calls.append((handle.value, feature))
        raw = pointed(pointer, abi.Outcome)
        raw.state = State.ACTIVE
        raw.effective_time, raw.renew_after, raw.expires_at = 1000, 1450, 1900
        return self.code

    feature_session_renew = feature_session_start
    feature_session_save_checkpoint = feature_session_start
    feature_session_stop = feature_session_start


def library(api):
    result = object.__new__(FeatureSessionLibrary)
    result._api = api
    return result


def test_independent_owners_forward_explicit_features_and_dispose_once():
    api = FakeApi()
    for feature in ("BATCH_RUN", "EXPORT", "BATCH_RUN"):
        client, opened = library(api).open(config(feature=feature))
        assert opened.state is State.READY
        with client:
            assert client.start().code is Result.OK
            checked = client.authorize(feature)
            assert checked.expires_at == 1900 and checked.renew_after == 1450
            assert checked.effective_time == 1000
            client.stop()
        client.close()
    assert api.closed == [1, 2, 3]
    assert [call for call in api.calls if isinstance(call[1], bytes)] == [
        (1, b"BATCH_RUN"), (2, b"EXPORT"), (3, b"BATCH_RUN")]


def test_no_python_permission_cache_and_separate_persistence_result():
    api = FakeApi()
    client, _ = library(api).open(config())
    with client:
        api.checkpoint = CheckpointResult.COMMIT_UNKNOWN
        assert client.start().checkpoint_result is CheckpointResult.COMMIT_UNKNOWN
        for code in (Result.OK, Result.RETRY, Result.DENIED, Result.ONLINE_REQUIRED, Result.CANCELLED):
            api.code = code
            assert client.authorize("DEFAULT").code is code
        with pytest.raises(TypeError):
            bool(Outcome(Result.OK))
        with pytest.raises(TypeError):
            copy.copy(client)


def test_feature_validation_busy_and_closed_owner():
    api = FakeApi()
    client, _ = library(api).open(config())
    for value in ("", "a" * 16, "FEATURE\0", "é", 1):
        with pytest.raises(ValueError):
            client.authorize(value)
    assert client.authorize("A.b:c-d_e").code is Result.OK
    with client._owner.lock:
        assert client.start().code is Result.BUSY
        assert client.authorize("DEFAULT").state is State.UNKNOWN
    client.close()
    with pytest.raises(RuntimeError, match="closed"):
        client.renew()


@pytest.mark.parametrize("field,value", [("version", 2), ("state", 99), ("renewal_due", 2),
                                         ("provider_result", 99), ("checkpoint_result", 99)])
def test_unknown_native_metadata_is_rejected(field, value):
    raw = abi.Outcome(size=ct.sizeof(abi.Outcome), version=1)
    setattr(raw, field, value)
    with pytest.raises((ValueError, RuntimeError)):
        _decode(0, raw)


def test_old_library_is_explicitly_unsupported_only_for_new_api():
    with pytest.raises(NotImplementedError):
        abi.NativeApi(SimpleNamespace(library=SimpleNamespace()))


@pytest.mark.parametrize("index", range(len(abi.expected_layout())))
def test_every_layout_mismatch_is_rejected_before_open(index):
    class Probe:
        def __call__(self, position):
            expected = abi.expected_layout()[position]
            return expected ^ 1 if position == index else expected
    with pytest.raises(RuntimeError, match="ABI"):
        abi.NativeApi(SimpleNamespace(library=SimpleNamespace(lcc_feature_session_bridge_layout=Probe())))


def test_installed_optional_bridge_rejects_invalid_config_without_provisioning():
    path = os.environ.get("LCC_TEST_DEVICE_BOUND_DLL")
    if not path:
        pytest.skip("Set LCC_TEST_DEVICE_BOUND_DLL to the new installed bridge")
    client, result = FeatureSessionLibrary(path).open(config())
    assert client is None and result.code is Result.INVALID_ARGUMENT
    assert result.state is State.UNKNOWN


def test_original_exports_reject_optional_api_without_breaking_device_bound():
    path = os.environ.get("LCC_TEST_OLD_DEVICE_BOUND_DLL")
    if not path:
        pytest.skip("Set LCC_TEST_OLD_DEVICE_BOUND_DLL to the original-export fixture")
    with pytest.raises(NotImplementedError):
        FeatureSessionLibrary(path)
    client, outcome = DeviceBoundLibrary(path).open_resume(config())
    assert client is None and outcome.code is Result.INVALID_ARGUMENT
