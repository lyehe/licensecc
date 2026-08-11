# Licensecc request-proof v1 vector

This directory freezes the request-proof v1 bytes shared by the Worker, CLI,
and SDK tests. The three payloads have identical semantic fields and differ
only in their exact `purpose` line. `online.payload` is the signed payload.

The fixture was generated once with Node.js WebCrypto in Node v22.12.0,
backed by OpenSSL 3.0.15+quic on Windows. The P-256 private key was generated
non-exportable in process memory, used once to sign the canonical online
payload, and discarded when that process exited. It was never exported,
printed, or written. Only the public coordinates/canonical SPKI and randomized
IEEE-P1363 signature are retained. The fixture key is unrelated to the
software-test provider introduced by a later task.

Verify the complete inventory with:

```text
npm --prefix services/cloudflare-licensing-backend run device-key -- verify-vectors --dir ../../test/vectors/device_proof/v1
```

`--write-manifest` may rebuild only the three payloads and manifest hashes. It
never regenerates or replaces the public-key or signature fixtures.
