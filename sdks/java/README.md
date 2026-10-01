# Licensecc Java client

## Optional feature sessions

`FeatureSessionLibrary` loads the installed JNI bridge on Windows x64 or Linux. Use
`open(configuration)` with a feature already enrolled through the device-bound
flow. Every job needs a new session and a successful `start()` online decision.
Call `authorize("BATCH_RUN")` before the first protected unit, every subsequent
unit, and publication; only `DeviceBoundClient.Result.OK` permits work.

When `renewalDue()` is set, call `renew()` and authorize again. Serialize these
blocking calls on an application worker thread. Retry transient starts on the
same handle with bounded backoff. Handle checkpoint failures independently with
`saveCheckpoint()`; persistence success never grants permission.

Call `stop()` to end local authority and use try-with-resources to close the
session. Stop does not retire the machine or release a device slot. Another
feature, such as `EXPORT`, needs its own enrolled configuration and session.
Build the JNI library from the same SDK version as the JAR: a JNI library built
for a different JNI protocol is rejected at load, by `DeviceBoundLibrary` as
well as by this adapter. See the [installed adapter guide](native/README.md) and
[native session contract](../../doc/api/feature_sessions.rst).

The Java 17 SDK is a dependency-free client for Licensecc's signed-token
contract. It verifies `lcccfg1` configuration attestations locally. An
optional [device-bound JNI adapter](native/README.md) for Windows x64 and Linux calls the
installed native runtime for browser enrollment, TPM identity, renewal and
local authorization.

> [!IMPORTANT]
> The signed-token API does not perform native enforcement.
> Anti-tamper checks, hardware fingerprinting, offline `.lic` acquisition,
> and TPM-backed identity remain responsibilities of the C++ runtime
> (`licensecc::licensecc_static`), including when called through the JNI adapter.
> A valid server token proves the signed
> claims and request bindings; it does not prove that the Java process or host
> is untampered.

Invalid or untrusted tokens return a typed `VerificationResult`. They do not
escape as verifier exceptions.

## Build and consume the artifact

Prerequisites are JDK 17 or newer and the root workspace dependencies. Run the
SDK gate from the repository root:

```console
npm run test:java-sdk
```

This compiles production code with `--release 17 -Xlint:all -Werror`, runs
the parity and native-adapter ownership tests against the built
JAR, and writes only ignored build output. Actual JNI loading requires the
separate installed-adapter gate below; portable tests do not provision a device.

The repository builds `build/java-sdk/licensecc-client-0.1.0-rc.2.jar`.

The JAR is not published to Maven Central. Consume it as a checked local
artifact or take it from a reviewed Licensecc release. Add that exact JAR to
your application's compile and runtime classpaths; do not compile copied SDK
sources into the application.

## Verify a configuration attestation

Trust only the backend's published PKCS#1 RSA public-key DER. Never give the
Java application the backend's PKCS#8 signing private key or an offline
project's `private_key.rsa`.

```java
import io.licensecc.client.ConfigAttestation;
import io.licensecc.client.TrustedPublicKey;
import io.licensecc.client.VerificationResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

byte[] configBytes = Files.readAllBytes(Path.of("app-config.json"));
TrustedPublicKey trustedKey = TrustedPublicKey.fromHex(configPkcs1DerHex);

ConfigAttestation.Expected expected = new ConfigAttestation.Expected(
    configBytes,
    "DEFAULT",
    "EXPORT",
    licenseFingerprint64Hex,
    "",                     // empty when the config is not device-bound
    lastAppliedConfigSeq,   // anti-rollback floor
    null                    // use the current time
);

VerificationResult<ConfigAttestation.Claims> result =
    ConfigAttestation.verify(configToken, expected, List.of(trustedKey));

if (!result.ok()) {
    throw new SecurityException("Config token rejected: " + result.code());
}
```

The `config-hash` claim must equal `sha256:` plus the SHA-256 of
`configBytes`, binding the signed token to the exact configuration you hold.
`minConfigSequence` enforces the anti-rollback floor: a token whose
`config-seq` falls below the last-applied sequence is rejected with
`RejectionCode.ROLLBACK_BELOW_FLOOR`.

## Verification coverage

The repository gate exercises golden and malformed shared vectors, canonical
parsing, key selection, signatures, claim binding, expiry and rollback floors,
and JAR packaging. Run the complete cross-language parity suite from the
repository root when changing a token or SDK contract:

```console
npm run test:sdks
```

That command tests the Python, .NET, and Java clients against the same
repository-owned vectors. Public publication is a separate release operation
and is not implied by either test command.

For the optional JNI surface, follow the [installed adapter guide](native/README.md)
and run its Windows gate with an installed TPM-enabled Licensecc package:

```powershell
pwsh -NoProfile -File scripts/ci/run-installed-java-device-bound.ps1 -InstallPrefix C:/your-install
```

Linux CI builds the same bridge against an installed TPM2 package and runs
`scripts/test-java-sdk.mjs` against it.
