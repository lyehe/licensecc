# Python device-bound native bridge

The same DLL also exports the optional feature-session owner for Python and
.NET. `licensecc.feature_session.FeatureSessionLibrary` and .NET's
`FeatureSessionLibrary` check a separate outcome-layout probe before using it.
The existing device-bound layout and exports retain their contracts. The
bridge ships in the same release as the SDK, so rebuild the DLL against the
current installed runtime: one missing the feature-session exports fails to
load for this API with the platform loader error, while the existing
device-bound adapter stays usable regardless.

This optional 64-bit Windows/Linux library exposes the existing native device-bound owner
to `licensecc.device_bound`. It owns enrollment, HTTP, TPM signing, lease
verification, clocks and checkpoint recovery in C++. Python does not receive
raw leases, enrollment secrets or private-key handles. The bridge adds no
software-provider fallback and does not change the config-token verifier.

Build against an **installed** Licensecc package built with device identity and
Windows TPM enabled, using the same MSVC architecture/configuration/runtime:

```powershell
cmake -S sdks/python/native -B build/python-device-bound -G "Visual Studio 17 2022" -A x64 `
  -Dlicensecc_DIR=C:/your-install/cmake/licensecc -DLCC_PROJECT_NAME=your_project
cmake --build build/python-device-bound --config Release
cmake --install build/python-device-bound --config Release --prefix C:/your-app/native
```

Distribute `bin/licensecc_device_bound_bridge.dll` with the application's matching
native dependencies. Load an application-pinned absolute path. Dependencies
are resolved only beside that DLL or in Windows System32; there is no PATH,
current-directory or alternate-loader fallback. An absolute path does not
authenticate a DLL: protect the application installation and configuration.
No native DLL is bundled in the Python wheel. The Python package can still
be imported and used on other platforms without this DLL.

Use the existing account/browser consent flow. Configure the dedicated public
RSA-3072 **SPKI** trust ring; this is not the legacy SDK's PKCS#1 trust record.
Create a `Configuration` and `DeviceBoundLibrary`, then explicitly choose
`open_enrollment(configuration)` for a new device or
`open_resume(configuration)` for an existing device. Both return
`(client_or_none, outcome)`; inspect `outcome.code` before using the client.
Native validation rejects invalid configuration before opening a provider.

For enrollment, call `prepare()`, display and flush the returned comparison
code, then call `launch()`. Poll with `poll(wait_ms)` (0..1000) until
`CALLBACK_RECEIVED`, then call `activate()`. After resume, call `renew()`;
a persisted checkpoint never restores offline permission by itself.
Retries and `abandon_pending()` are explicit and remain governed by the native
owner. Neither closing nor abandoning an operation reverses a possible server
allocation or deletes the TPM key.

For an established binding, `Result.CONFLICT` preserves the pending renewal.
After an explicit decision to start a new renewal, call `abandon_pending()` and
resolve any checkpoint error. Only its `Result.ONLINE_REQUIRED` outcome leads
to a new `renew()` call; a busy or failed abandonment must not be treated as
success. This recovers from an expired 48-hour response window without changing
the binding. See the [renewal recovery contract](../../../doc/api/device_enrollment.rst).

When activation is refused because every device slot of the license is in use,
the code is `Result.CONFLICT` and `outcome.detail` is `DenialDetail.DEVICE_LIMIT`
(.NET: `Outcome.Detail` is `DeviceBoundDenialDetail.DeviceLimit`). Ask the user
to disconnect a device in the customer portal (Devices), then try again. A detail
never grants access. A value the SDK does not name keeps its number; treat it as
no detail. Python and .NET releases before this detail reject any non-zero value
as an invalid outcome, so upgrade the package together with this bridge.

Every protected operation requires a fresh native check:

```python
from licensecc.device_bound import Result

# client was obtained from a successful open and enrollment/renewal flow.
decision = client.authorize()
if decision.code is not Result.OK:
    raise RuntimeError(f"Access unavailable: {decision.code.name}")
# Invoke the protected native operation immediately; do not cache this decision.
```

`Result` and `Outcome` deliberately reject implicit truth testing. `OK` from
open, activation, renewal or storage is not authorization. Primary result,
provider result and checkpoint result are independent. For example, a renewal
may report a provider failure and `COMMIT_UNKNOWN` together: retain that outcome
and retry persistence using `save_checkpoint()`. A saved checkpoint does not
turn the earlier provider failure into permission. Do not overwrite the previous
unresolved persistence result with a competing operation's `BUSY` result.

Use `with client:` or explicit `close()` before shutting down application worker
threads. Competing operations return `BUSY`; close waits for admitted calls and
closes the handle once. Client copying and pickling are rejected. Garbage
collection supplies best-effort cleanup during normal execution; native cleanup
is intentionally disabled during interpreter shutdown. Close does not silently
save pending state: finish any required save/cancel recovery first.

Keep valuable operations and anti-tamper enforcement inside the native application.
Python callers can be modified; this wrapper does not make Python control flow
tamper-resistant. A live TPM/browser/backend journey and physical-key copy test
remain release requirements; the optional test below proves ABI loading and
no-effect invalid-configuration rejection only.

```powershell
$env:LCC_TEST_DEVICE_BOUND_DLL = 'C:/your-app/native/bin/licensecc_device_bound_bridge.dll'
uv run --directory sdks/python --locked pytest tests/test_device_bound_bridge.py
```

Windows CI builds the `ci-windows-msvc-debug-dynamic-tpm` preset, then builds
and installs this bridge against that package, checks its exact exports and
dependencies, and runs the bridge tests with the installed DLL required.
Run the same gate locally from the repository root with CMake and pinned uv
on PATH:

```powershell
pwsh -NoProfile -File scripts/ci/run-installed-python-device-bound.ps1 -InstallPrefix C:/your-install
```


## Linux build

Install `libssl-dev`, `libcurl4-openssl-dev`, `tpm2-openssl` and `xdg-utils`.
Build/install the runtime with `-DLCC_ENABLE_TPM2_OPENSSL=ON`; Linux device builds
produce position-independent static objects for the SDK bridges. Then:

```sh
cmake -S sdks/python/native -B build/python-device-bound-linux \
  -DCMAKE_PREFIX_PATH=/absolute/runtime-install -DLCC_PROJECT_NAME=your_project
cmake --build build/python-device-bound-linux
cmake --install build/python-device-bound-linux --prefix /absolute/app/native
```

Load `/absolute/app/native/lib/liblicensecc_device_bound_bridge.so` from Python
or .NET. The ABI/export set is the same as Windows. Linux dependencies use the
OS dynamic loader; protect the installation and its library search configuration.
No bridge is bundled in the Python wheel. `LCC_TEST_DEVICE_BOUND_DLL` also accepts
an absolute `.so` path for the installed bridge tests. See the Linux requirements
in [the native API guide](../../../doc/api/device_identity.rst).
