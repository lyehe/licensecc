# Java device-bound native adapter

The JNI library also exposes optional `FeatureSessionLibrary` support through
four separate `FeatureSessionNative` exports. The existing six
`DeviceBoundNative` exports retain their contracts. An older library rejects
the feature-session adapter explicitly while remaining usable for enrollment
and device-bound operations. The installed gate tests this fallback in a
separate JVM as well as the current library's no-effect and malformed-input paths.

The optional Java 17 JNI adapter calls the installed public
`licensecc/device_bound.h` owner. Enrollment secrets, TPM handles, platform HTTPS,
proofs, lease validation, current-process clocks and checkpoints stay in C++.
It adds no Java authority ledger, caller-supplied clock or transport, software
provider fallback, or raw lease API. Python, .NET and Java use the same native
owner; JNI only marshals its C interface.

## Build and install

Use Windows x64, an x64 JDK 17+, and an **installed** Licensecc package with
device identity and Windows TPM enabled. Match the installed package's MSVC
architecture, configuration and CRT. Set `JAVA_HOME` to the JDK directory.
The standalone CMake project needs JNI headers, not a JVM import library; it
does not introduce a JDK dependency into normal C++ builds.

```powershell
cmake -S sdks/java/native -B build/java-device-bound -G "Visual Studio 17 2022" -A x64 `
  -Dlicensecc_DIR=C:/your-install/cmake/licensecc -DLCC_PROJECT_NAME=your_project
cmake --build build/java-device-bound --config Release
cmake --install build/java-device-bound --config Release --prefix C:/your-app/native
npm run test:java-sdk
```

Distribute the built SDK JAR with
`bin/licensecc_device_bound_jni.dll` and its matching runtime dependencies.
No DLL is embedded in or automatically extracted from the JAR. The legacy
HTTP/token APIs remain usable without JNI on other platforms. The public
classes are `DeviceBoundLibrary`, `DeviceBoundConfiguration` and
`DeviceBoundClient`, all under `io.licensecc.client`.

## Loading and ownership

Construct `DeviceBoundLibrary` with the application-owned absolute DLL path.
The adapter resolves a real regular file, uses `System.load`, checks the JNI
protocol version and pins that path for its defining classloader. A second path
or failed load/probe cannot silently replace it. The JVM owns native-library
lifetime; there is no manual unload. Use one shared SDK classloader rather than
loading the same JNI library through independent plugin classloaders.

An absolute path selects the JNI file; **it does not restrict dependent DLL
search**. The installed gate permits only the reviewed Windows and MSVC CRT
imports and rejects OpenSSL/JVM/other dependencies. Deployment must protect the
JVM/application installation, current directory, configured DLL directories and
PATH entries participating in Windows loader search. Do not launch with
user-writable search directories. Match and distribute the supported CRT;
Debug CRT imports are development-only. This is a host deployment precondition,
not an isolation guarantee supplied by `System.load`. See
[JDK loading](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/System.html#load(java.lang.String))
and [Windows DLL search](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order).

Each client is `AutoCloseable`. Use try-with-resources. Overlapping calls return
`BUSY`; close waits for admitted calls and closes once. Reentrant close from an
active call is rejected. A Cleaner is a last-resort leak guard, not a prompt
shutdown mechanism. Native calls are blocking; run them on an application
worker thread. Java thread interruption does not cancel native I/O.

## Application workflow

Configure the application's fixed backend/portal origins, issuer, lease/proof
audiences, project, feature, registered client and callback path. Supply the
dedicated public RSA-3072 **DER SPKI** trust ring via
`DeviceBoundConfiguration.TrustedSigner`; the legacy PKCS#1 key type is different.
Configuration and trust bytes are defensively copied, and text uses strict
UTF-8. Native policy validation remains authoritative.

1. Explicitly call `openEnrollment(configuration)` for a new device or
   `openResume(configuration)` for existing state. Inspect `OpenResult.outcome()`;
   a failed open has no client. Never silently change resume into enrollment.
2. Enrollment: call `prepare()`, display and flush its comparison code, then
   call `launch()`. Poll the owned listener with `poll(0..1000)` until
   `CALLBACK_RECEIVED`; `WAITING` and rejected callbacks are not approval.
   Call `activate()` only after the callback arrives.
3. Resume: call `renew()` for fresh online authority. Restart/reboot does not
   restore offline permission from a checkpoint.
4. Immediately before every protected operation, call `authorize()` and allow
   work only when its code is `OK`. Opening, activation, renewal, a saved
   checkpoint, comparison display or any scheduling hint never grants access.
5. Handle `Outcome.checkpointResult()` independently from the operation result.
   `saveCheckpoint()` retries the owner's exact pending statement. No caller
   bytes are accepted. For unresolved issuance, retry the same native operation
   or explicitly `abandonPending()`; abandonment does not undo a server allocation.
6. `cancel()` shuts down local authority. Finish save/cancel recovery before
   `close()`: close does not save, delete the TPM key, retire a binding or free
   a device slot. Retirement and transfers use the customer/admin portal.

For example, after the application has completed the required enrollment or
online renewal and checked persistence outcomes:

```java
DeviceBoundClient.Outcome access = client.authorize();
if (access.code() != DeviceBoundClient.Result.OK) {
    throw new SecurityException("Protected access unavailable: " + access.code());
}
performProtectedOperation();
```

This call pattern does not make modifiable Java control flow tamper-resistant.
Keep valuable operations and anti-tamper enforcement in the native application.
The maintained [native API guide](../../../doc/api/device_identity.rst) and
[enrollment guide](../../../doc/api/device_enrollment.rst) own protocol behavior.

## Verification

With CMake, Node and the JDK on PATH, run from the repository root:

```powershell
pwsh -NoProfile -File scripts/ci/run-installed-java-device-bound.ps1 -InstallPrefix C:/your-install
```

The gate builds and installs against the supplied package, checks the ten exact
JNI exports and dependency inventory, and runs tests against the built JAR with
`-Xcheck:jni`. Tests cover Unicode/copy bounds, ownership after malformed/open
publication failures, exact dispatch, independent outcomes, concurrency,
reentrancy, Cleaner cleanup, real JNI malformed inputs and sticky version/path
loading. A separate synthetic native fixture exercises the actual JNI marshaler
and exceptions before and after handle publication, requiring exactly one close.
Real-library calls use invalid configuration rejected before any key,
checkpoint or network provisioning. The incompatible-version DLL and synthetic
fixture are test-only and are never installed.

Windows CI runs this gate for the existing TPM-enabled installed package.
Physical TPM/browser/backend, copied-checkpoint and host deployment qualification
remain separate release requirements; this gate does not claim those results.


## Linux build

Use a 64-bit JDK 17+ and an installed Linux runtime built with
`LCC_ENABLE_TPM2_OPENSSL=ON`. Set `JAVA_HOME` to that JDK. Install the runtime's
OpenSSL 3/TPM2, libcurl and desktop-browser prerequisites described in
[the native API guide](../../../doc/api/device_identity.rst).

```sh
cmake -S sdks/java/native -B build/java-device-bound-linux \
  -DCMAKE_PREFIX_PATH=/absolute/runtime-install -DLCC_PROJECT_NAME=your_project
cmake --build build/java-device-bound-linux
cmake --install build/java-device-bound-linux --prefix /absolute/app/native
```

Pass `/absolute/app/native/lib/liblicensecc_device_bound_jni.so` to
`DeviceBoundLibrary`. Linux uses the same JNI protocol and pinned-path lifetime.
The OS dynamic loader resolves dependent libraries; protect those paths as part
of the application installation. `LCC_TEST_DEVICE_BOUND_JNI_DLL` also accepts a
Linux `.so` for installed adapter tests.
