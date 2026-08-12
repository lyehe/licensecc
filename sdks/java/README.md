# Licensecc Java client

The Java 17 SDK is a dependency-free client for Licensecc's HTTP and signed-token contracts. It verifies `lccoa1` online assertions and `lcccfg1` configuration attestations locally, and wraps the documented Worker routes with the JDK HTTP client.

It deliberately does not implement binary anti-tamper, local license acquisition, hardware fingerprinting, or TPM key storage. Those remain C++ runtime responsibilities. Invalid untrusted tokens return a typed `VerificationResult`; they do not escape as verifier exceptions.

Run the golden-vector, malformed-input, retry, idempotency, and packaging gates from the repository root:

```sh
npm run test:java-sdk
```

The repository builds `build/java-sdk/licensecc-client-0.1.0-rc.1.jar`. Public package publication is a separate release operation and is not implied by this source tree.
