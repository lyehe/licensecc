# Licensecc Java client

The Java 17 SDK is a dependency-free client for Licensecc's HTTP and
signed-token contracts. It verifies `lccoa1` online assertions and
`lcccfg1` configuration attestations locally, and wraps the documented
licensing-backend routes with the JDK HTTP client.

> [!IMPORTANT]
> This SDK covers the HTTP and signed-token contract, not native enforcement.
> Anti-tamper checks, hardware fingerprinting, offline `.lic` acquisition,
> and TPM-backed identity remain responsibilities of the C++ runtime
> (`licensecc::licensecc_static`). A valid server token proves the signed
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
the parity and HTTP-contract tests, and writes only ignored build output.

The repository builds `build/java-sdk/licensecc-client-0.1.0-rc.2.jar`.

The JAR is not published to Maven Central. Consume it as a checked local
artifact or take it from a reviewed Licensecc release. Add that exact JAR to
your application's compile and runtime classpaths; do not compile copied SDK
sources into the application.

For a direct JDK smoke test, put the complete `VerifyAssertion.java` example
below in an application scratch directory. From that directory, compile
against the built JAR. Replace `/path/to/licensecc` with the checkout path:

```console
javac --release 17 -cp /path/to/licensecc/build/java-sdk/licensecc-client-0.1.0-rc.2.jar VerifyAssertion.java
```

Run from the same directory with that JAR and `.` on the runtime classpath.
Use `:` as the separator on Linux/macOS and `;` on Windows. These commands
only create application class files; they do not contact or mutate a licensing
service.

Replace each uppercase value with the exact claim bound into the assertion.
Use `-` for `DEVICE_HASH_OR_DASH` only when the assertion has no device hash.
On Linux or macOS:

```bash
repo=/path/to/licensecc
java -cp "$repo/build/java-sdk/licensecc-client-0.1.0-rc.2.jar:." VerifyAssertion \
  /path/to/assertion.txt \
  /path/to/public-key.hex \
  PROJECT \
  FEATURE \
  LICENSE_FINGERPRINT_64_HEX \
  DEVICE_HASH_OR_DASH \
  NONCE_64_HEX
```

On Windows in PowerShell:

```powershell
$repo = "C:\path\to\licensecc"
java -cp "$repo\build\java-sdk\licensecc-client-0.1.0-rc.2.jar;." VerifyAssertion `
  C:\path\to\assertion.txt `
  C:\path\to\public-key.hex `
  PROJECT `
  FEATURE `
  LICENSE_FINGERPRINT_64_HEX `
  DEVICE_HASH_OR_DASH `
  NONCE_64_HEX
```

An accepted assertion prints `accepted key <key-id>`. A mismatch exits through
the `SecurityException` path shown below.

## Verify an online assertion

Trust only the backend's published PKCS#1 RSA public-key DER. Never give the
Java application the backend's PKCS#8 signing private key or an offline
project's `private_key.rsa`.

```java
import io.licensecc.client.OnlineAssertion;
import io.licensecc.client.TrustedPublicKey;
import io.licensecc.client.VerificationResult;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public final class VerifyAssertion {
    private VerifyAssertion() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 7) {
            throw new IllegalArgumentException(
                "usage: VerifyAssertion ASSERTION KEY_HEX PROJECT FEATURE FINGERPRINT DEVICE_HASH|- NONCE"
            );
        }

        String assertion = Files.readString(Path.of(args[0])).strip();
        String publicKeyHex = Files.readString(Path.of(args[1])).strip();
        String deviceHash = "-".equals(args[5]) ? "" : args[5];

        TrustedPublicKey trustedKey = TrustedPublicKey.fromHex(publicKeyHex);
        OnlineAssertion.Expected expected = OnlineAssertion.Expected.live(
            args[2], args[3], args[4], deviceHash, args[6]
        );
        VerificationResult<OnlineAssertion.Claims> result =
            OnlineAssertion.verify(assertion, expected, List.of(trustedKey));

        if (!result.ok()) {
            throw new SecurityException(
                "License assertion rejected: " + result.code()
                    + " (" + result.detail() + ")"
            );
        }
        System.out.println("accepted key " + result.claims().keyId());
    }
}
```

`OnlineAssertion.Expected.live` checks the project, feature, license
fingerprint, device hash, nonce, signature-selected key id, token time window,
and a zero revocation floor without permitting cache fallback. Applications
that persist a revocation floor or deliberately support cached assertions
should construct `OnlineAssertion.Expected` explicitly and fail closed when
the result is rejected.

Configuration attestations use the same pattern through
`ConfigAttestation.verify`. Its expected value also includes the exact
configuration bytes and a minimum configuration sequence.

## Call the licensing backend

`LicensingBackendClient` is a thin synchronous wrapper. The public
`/v1/verify` request does not use an account bearer:

```java
import io.licensecc.client.BackendResponse;
import io.licensecc.client.LicensingBackendClient;

import java.net.URI;
import java.util.Map;

LicensingBackendClient client = new LicensingBackendClient(
    URI.create("https://licensecc-online-verifier.example.workers.dev")
);

BackendResponse response = client.verify(Map.of(
    "project", "DEFAULT",
    "feature", "EXPORT",
    "license_fingerprint", licenseFingerprint64Hex,
    "device_hash", deviceHash64HexOrEmpty,
    "nonce", nonce64Hex
));

if (!response.ok()) {
    throw new SecurityException(
        "Backend denied or failed verification: " + response.code()
    );
}

String assertion = response.string("assertion");
```

An HTTP 200 response can still carry `ok:false` for a normal entitlement
denial, so check `BackendResponse.ok()` rather than the status alone. Treat
the returned assertion as untrusted until `OnlineAssertion.verify` accepts
it against the same fingerprint, device hash, and nonce.

`activate`, `renew`, `checkout`, `heartbeat`, `release`, `meter`,
and `report` wrap the remaining client-facing routes. Account-bound routes
require the full constructor with an account bearer. Keep that bearer out of
logs and source control. The configured client applies bounded retries to the
other wrapped operations on selected transport or transient HTTP failures. It
never retries metering, whose counter mutation has no idempotency key.

## Verification coverage

The repository gate exercises golden and malformed shared vectors, canonical
parsing, key selection, signatures, claim binding, expiry and rollback floors,
HTTP response parsing, retries, metering's single-attempt behavior, and JAR
packaging. Run the complete cross-language parity suite from the repository
root when changing a token or SDK contract:

```console
npm run test:sdks
```

That command tests the Python, .NET, and Java clients against the same
repository-owned vectors. Public publication is a separate release operation
and is not implied by either test command.
