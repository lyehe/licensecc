# C++ calculator with licensed operations

A small console application using the real installed Licensecc runtime:

| Command | Permission |
| --- | --- |
| `add NUMBER NUMBER` | Free; no licensing or network call |
| `sub NUMBER NUMBER` | Free; no licensing or network call |
| `mul NUMBER NUMBER` | Fresh online feature session |
| `div NUMBER NUMBER` | Fresh online feature session |
| `activate` | Explicit browser sign-in and device approval |

Multiplication and division share `LCC_BOUND_FEATURE`, default `DEFAULT`. One
activation covers both operations. Each licensed calculation starts a new job;
no cached permission can skip its online start. Invalid numbers and division by
zero are rejected before licensing. Non-finite results are not printed.

## Build on Windows

Start in the repository root, in PowerShell 7 with Visual Studio 2022 x64 and
CMake available. Follow the repository's native prerequisites. The following
commands use new build/install directories and never install into Program Files:

```powershell
cmake -S . -B build/calculator-native -G "Visual Studio 17 2022" -A x64 `
  "-DLCC_PROJECT_NAME=test" "-DLCC_ENABLE_DEVICE_IDENTITY=ON" `
  "-DLCC_ENABLE_WINDOWS_TPM=ON" "-DBUILD_TESTING=OFF" `
  "-DCMAKE_INSTALL_PREFIX=$PWD/build/calculator-install"
cmake --build build/calculator-native --target install --config Debug
```

Place the licensing Worker's **public RSA-3072 DER signing key** at an ignored
local path, such as `build/calculator-signing-public.der`. The Worker's private
signing key must never enter this application. Replace the `.test` URLs,
project/client and audience values below with the registered environment values
before attempting live activation; these placeholders cannot connect to production.
The installed native project component `test` is separate from the backend's
licensing project `CALCULATOR`.

```powershell
cmake -S examples/device_bound -B build/calculator-example `
  -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_PREFIX_PATH=$PWD/build/calculator-install" `
  "-Dlicensecc_DIR=$PWD/build/calculator-install/cmake/licensecc" `
  "-DLCC_PROJECT_NAME=test" `
  "-DLCC_BOUND_APPLICATION_ID=com.example.calculator" `
  "-DLCC_BOUND_ENDPOINT_ORIGIN=https://backend.test" `
  "-DLCC_BOUND_PORTAL_URL=https://portal.test/connect" `
  "-DLCC_BOUND_ISSUER=https://backend.test/" `
  "-DLCC_BOUND_LEASE_AUDIENCE=calculator-desktop" `
  "-DLCC_BOUND_PROOF_AUDIENCE=calculator-proof" `
  "-DLCC_BOUND_PROJECT=CALCULATOR" "-DLCC_BOUND_FEATURE=DEFAULT" `
  "-DLCC_BOUND_CLIENT_ID=calculator-desktop" `
  "-DLCC_BOUND_SIGNING_SPKI=$PWD/build/calculator-signing-public.der" `
  "-DLCC_BOUND_EXAMPLE_TESTS=ON"
cmake --build build/calculator-example --config Debug
ctest --test-dir build/calculator-example -C Debug --output-on-failure
```

This also builds the existing XYZ and multi-feature examples. All five CTest
tests are local: they check installed linking, example recovery behavior,
calculator guards and free arithmetic. The guard fixtures simulate native
outcomes; they do not qualify a TPM or a deployed server. Production calculator
targets have no fixture/bypass mode and always link the native runtime.

## Run

```powershell
& ./build/calculator-example/Debug/licensecc_calculator.exe add 2 3
# 5, exit 0; no account or TPM is needed for free operations.
& ./build/calculator-example/Debug/licensecc_calculator.exe sub 9 4
# 5, exit 0.
```

For licensed operations, the backend must register this client/project and
its loopback `/callback` URL with a dynamic IPv4 port. Assign the signed-in
customer a protected entitlement for the configured feature with available device
capacity. A usable Windows TPM and private local user storage are required.
Then run:

```powershell
& ./build/calculator-example/Debug/licensecc_calculator.exe activate
# Sign in, compare the app/browser code, and approve this machine.
& ./build/calculator-example/Debug/licensecc_calculator.exe mul 6 7
# 42, exit 0 only after successful online permission and local checks.
& ./build/calculator-example/Debug/licensecc_calculator.exe div 9 2
# 4.5, exit 0 under the same conditions; this is a new session.
```

`activate` never silently replaces existing activation state. If it reports an
existing enrollment, use `mul` or `div` to resume online. Missing or unavailable
key providers, denied permission and expired/unusable checkpoints stop licensed
work. Follow the existing device-recovery workflow; do not erase keys or files.

Exit codes: 0 success; 1 licensing, provider, persistence or output failure;
2 invalid arguments/arithmetic input. Failed authorization prints no calculation
result. A shutdown/persistence failure after a result was printed returns 1 and
reports recovery trouble; it cannot undo output already delivered. Ctrl+C cancels
bounded session retry waits. Activation uses the existing console/browser flow.

## Integration boundary

`calculator.cpp` calls the shared `feature_work.hpp` and `enrollment_work.hpp`
helpers used by the existing examples. `licensed_calculation` checks permission
before arithmetic and before printing, including when called directly. The
native owner verifies signatures, identity, feature and time; this example adds
no alternate verifier. Calls are serialized on the console thread. A GUI should
run this sequence on its worker thread, not its UI thread.

For Linux, use the [existing Linux build prerequisites](README.md#linux), omit
the Visual Studio options, enable the TPM2/OpenSSL and Linux desktop providers,
and run `./build/calculator-example/licensecc_calculator`. No separate Linux
authorization implementation is needed. Windows-only local test evidence is not
Linux qualification; simulator and physical-TPM testing remain distinct.

This demonstrates application integration, not resistance to every binary patch.
See the [feature-session contract](../../doc/api/feature_sessions.rst) for expiry,
renewal, revocation latency, checkpoints and persistent-device-slot semantics.
