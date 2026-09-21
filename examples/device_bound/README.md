# Windows device-bound application example

This standalone consumer uses only installed public headers. It enrolls through
the system browser, persists signed checkpoints through the native core, resumes
with a fresh online renewal, and authorizes each batch before computing XYZ point
bounds. It never prints proofs, callback codes, PKCE values or signed tokens.

Starting directory: the Licensecc repository root. Shell: PowerShell 7 with
Visual Studio 2022 x64. Install a package built with
`LCC_ENABLE_DEVICE_IDENTITY=ON` and `LCC_ENABLE_WINDOWS_TPM=ON` into the prefix
below. Use an existing classified build; do not install into Program Files.

```powershell
cmake --install build/device-bound-native-windows --config Debug `
  --prefix "$PWD/build/device-bound-public-install"
```

Configure the application with developer-controlled endpoint/issuer/audience
values and its **public RSA-3072 DER signing key**. These settings are compiled
into the executable, rather than accepted from an end user's command line.
Replace the example `.test` values with the registered pilot configuration.
The installed package component (`LCC_PROJECT_NAME=test`) is separate from the
backend licensing project (`LCC_BOUND_PROJECT=CAD`).

```powershell
cmake -S examples/device_bound -B build/device-bound-public-example `
  -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_PREFIX_PATH=$PWD/build/device-bound-public-install" `
  "-Dlicensecc_DIR=$PWD/build/device-bound-public-install/cmake/licensecc" `
  -DLCC_PROJECT_NAME=test `
  -DLCC_BOUND_APPLICATION_ID=com.example.cad `
  -DLCC_BOUND_ENDPOINT_ORIGIN=https://backend.test `
  -DLCC_BOUND_PORTAL_URL=https://portal.test/authorize `
  -DLCC_BOUND_ISSUER=https://issuer.test/ `
  -DLCC_BOUND_LEASE_AUDIENCE=CAD-client `
  -DLCC_BOUND_PROOF_AUDIENCE=proof-audience `
  -DLCC_BOUND_PROJECT=CAD -DLCC_BOUND_FEATURE=DEFAULT `
  -DLCC_BOUND_CLIENT_ID=CAD-client `
  "-DLCC_BOUND_SIGNING_SPKI=$PWD/build/pilot-public-signing-key.der"
cmake --build build/device-bound-public-example --config Debug
& ./build/device-bound-public-example/Debug/licensecc_device_bound.exe --check-api
```

The check prints `Installed public API linked; invalid configuration rejected
without provisioning.` and exits 0. It performs no network or TPM provisioning.
It proves installed linking and invalid-input behavior, not live enrollment.

For signing-key rotation, retain the primary key and compile additional public
keys into the same application using a semicolon-separated CMake list:

```powershell
cmake -S examples/device_bound -B build/device-bound-public-example `
  "-DLCC_BOUND_ADDITIONAL_SIGNING_SPKIS=$PWD/build/next-public-signing-key.der"
cmake --build build/device-bound-public-example --config Debug
```

The primary key plus additional keys must total at most eight distinct public
DER files. Empty, oversized, missing and duplicate key files fail configuration;
the native API remains responsible for strict RSA-3072/SPKI validation. All keys
are active verification trust (`retired=0`); no private key is embedded. Reopen
the application under this overlap build before changing backend issuance.
Follow the [rotation runbook](../../doc/operations/device-bound-key-rotation.md)
before removing a key: both saved checkpoint slots can still depend on it.
Set `LCC_BOUND_ADDITIONAL_SIGNING_SPKIS` to an empty string explicitly when clearing
the cached list after an approved trust-retirement decision.

The optional isolated example tests stub update/save outcomes and exercise quit,
unresolved storage recovery, provider-error preservation and configured UTF-8
bytes. They do not contact a backend or provision a key:

```powershell
cmake -S examples/device_bound -B build/device-bound-public-example `
  -DLCC_BOUND_EXAMPLE_TESTS=ON "-DLCC_BOUND_DEVICE_LABEL=工作站"
cmake --build build/device-bound-public-example --config Debug
ctest --test-dir build/device-bound-public-example -C Debug --output-on-failure
```

For the live journey, the backend must register the client, project, callback
path `/callback` with dynamic IPv4 loopback port, and consent origin. The customer
needs a protected entitlement for the configured feature with available device
capacity. Windows needs a usable TPM and local NTFS LocalAppData. Linux needs the
TPM2/OpenSSL provider, libcurl, private local user storage and a desktop browser.
Use a text file containing whitespace-separated finite `x y z` triples:

```powershell
& ./build/device-bound-public-example/Debug/licensecc_device_bound.exe enroll ./points.xyz
# Close the first process, then prove restart requires fresh online renewal:
& ./build/device-bound-public-example/Debug/licensecc_device_bound.exe resume ./points.xyz
```

`enroll` explicitly permits creation of the app/user key only when no committed
checkpoint exists. It displays and flushes the comparison code before opening
the browser. Compare the code, verify the account/application, then approve.
Existing checkpoint state requires `resume`; corrupt or mismatched state fails
closed. Neither mode silently deletes a key or changes its namespace.

### Separate feature work sessions

The same build also produces `licensecc_feature_sessions`. It starts two
independent `BATCH_RUN` jobs and an `EXPORT` job in one process. Each job opens
a new native feature-session owner and obtains fresh online permission; every
protected batch and result publication checks its required feature explicitly.
The toy batch calculates a byte count and checksum of an input file.

Assign protected `BATCH_RUN` and `EXPORT` entitlements to the same customer and
project. Enroll each feature once, selecting its matching feature in the portal:

```powershell
& ./build/device-bound-public-example/Debug/licensecc_device_bound.exe enroll-batch ./points.xyz
& ./build/device-bound-public-example/Debug/licensecc_device_bound.exe enroll-export ./points.xyz
& ./build/device-bound-public-example/Debug/licensecc_feature_sessions.exe ./points.xyz
```

These modes use the same configured app/project key and separate feature
checkpoints; `LCC_BOUND_FEATURE` still controls the original `enroll`/`resume`
modes. The feature enrollment modes finish after enrollment without starting
protected work. Selecting another feature in consent cannot enable the requested
feature and can leave an unwanted binding needing explicit review.

Ordinary feature-session starts do not open a browser. The example renews when
the native signed deadline is due, preserves a pending retry, checks permission
again after renewal, and stops work on loss of authorization. Transient renewal
failure permits continued work only when the current local check still succeeds.
Startup retries use a conservative 60-second delay for the coarse retry result;
Ctrl+C cancels that wait. Local stop never retires a binding or deletes a key.

`--check-api` on `licensecc_feature_sessions` validates the installed new symbols
without provisioning. `LCC_BOUND_EXAMPLE_TESTS=ON` registers this check alongside
the existing recovery tests. A successful link/test is not a live server/TPM
qualification; use the synthetic two-feature journey for that evidence.

The feature-session example exits 0 after both batch jobs and export succeed,
and prints CSV with `bytes,checksum`. A failed guard stops the current operation;
the process exits 1. The batch calculation is an integration demonstration, not
a metered service or a concurrent-seat allocator.

### Original point-analysis flow

The original `enroll`/`resume` example exits 0 on success and prints
`Analyzed N points. Bounds: ...`.
Activation and storage success are not authorization: the example calls
`lcc_device_bound_authorize` immediately before each bounded computation batch.
After transient renewal failure, the explicit `offline` choice can use an
existing unexpired current-process lease only after that final check. `quit`
always stops work. A restarted process always needs online renewal.

Persistence failures prompt for a storage-only retry while retaining the client.
Unresolved issuance retries preserve the same operation. A renewal conflict offers
an explicit `restart`: abandon the pending local request and renew the same
binding with a new operation. This is useful after the 48-hour exact-response
recovery window expires. It neither frees a slot nor reverses an earlier server
commit. A failed abandonment stops the action; it does not start another request.
Enrollment conflicts still require resolving consent/capacity rather than
silently reusing a consumed code. Choosing `quit` or
closing input exits without claiming that an uncertain server allocation was
undone; recovery may then need operator assistance. No example action deletes
the TPM key, retires a server binding or erases committed checkpoint files.

The build and `--check-api` path are local verification. A complete release also
requires the live TPM/browser/backend journey, copied-checkpoint rejection on a
different key, and platform clock/storage qualification. This example does not
establish hardware attestation, power-loss durability or resistance to a patched
application binary. See the [native API documentation](../../doc/api/device_identity.rst).


### Linux

Build/install the native runtime with `LCC_ENABLE_TPM2_OPENSSL=ON` and libcurl
7.85+. Configure this example with the same `LCC_BOUND_*` public values and
`CMAKE_PREFIX_PATH=/absolute/runtime-install`; use a Linux build directory and
omit the Visual Studio generator/architecture. `licensecc_device_bound` and
`licensecc_feature_sessions` have the same commands as their Windows executables.
The native owner selects the TPM2 provider and private user directories; there
is no application-supplied key-storage override. See
[Linux requirements](../../doc/api/device_identity.rst).
