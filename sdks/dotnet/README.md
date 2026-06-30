# Licensecc.Client (.NET SDK)

A .NET 8 client SDK for the **licensecc** online licensing backend. It does two things:

1. **Offline token verifier (the security-critical core).** Fail-closed verification of the two
   signed token kinds the backend / tooling produce:
   - `lccoa1.` — the **online-assertion** token (`POST /v1/verify` and the seat endpoints return it).
   - `lcccfg1.` — the **config-attestation** token (produced offline by
     `services/cloudflare-licensing-backend/scripts/config-sign.mjs`, consumed here).
2. **A thin HTTP client wrapper** over the licensing-backend's client-facing endpoints
   (`/v1/verify`, `/v1/activate`, `/v1/renew`, `/v1/checkout`, `/v1/heartbeat`, `/v1/release`).

> ## Scope — read this
>
> **This SDK covers the HTTP + token contract ONLY.** The binary enforcement layer — anti-tamper,
> hardware fingerprinting, the offline `.lic` license-file check — lives in the **C++ library**
> (`licensecc::licensecc_static`) and is intentionally **not** reimplemented here. A token that
> verifies in this SDK proves the *server's signed assertion is authentic and bound to your
> identifiers*; it does **not** prove the host process is un-tampered. For production copy-protection,
> verify the token here AND run the C++ enforcement layer.

No external NuGet dependencies in the library: it uses only `System.Security.Cryptography`
(`RSA.ImportRSAPublicKey`, which consumes the PKCS#1 `RSAPublicKey` DER natively) and the BCL.

## Layout

```
sdks/dotnet/
  Licensecc.Client.sln
  src/Licensecc.Client/            # the library (PackageId Licensecc.Client, 0.1.0)
    SignedTokenCore.cs             #   shared: envelope split, canonical base64, RSA verify, field parse
    OnlineAssertion.cs             #   lccoa1 verifier  -> OnlineAssertionVerifier.Verify
    ConfigToken.cs                 #   lcccfg1 verifier -> ConfigTokenVerifier.Verify
    VerifyResult.cs                #   Result type + TrustedPublicKey / TrustedKeyRing
    LicensingBackendClient.cs      #   thin HttpClient wrapper (Verify/Activate/Renew/Checkout/Heartbeat/Release)
    Json.cs, Hex.cs                #   zero-dependency helpers
  test/Licensecc.Client.Tests/     # MSTest parity suite against test/vectors (positive + negatives)
```

## Build & test

```console
cd sdks/dotnet
dotnet test
```

The test suite loads the repo's golden vectors from `test/vectors/` (resolved via a build-time
pinned path with a relative-path fallback) and proves parity with the C++ verifier.

## Verifying an online-assertion (`lccoa1`)

```csharp
using Licensecc.Client;

// 1. Trust the backend's RSA signing key (PKCS#1 RSAPublicKey DER, hex-encoded).
//    The key-id is derived as sha256:<hex over the DER> and must match the token's key-id.
var ring = new TrustedKeyRing(TrustedPublicKey.FromPkcs1DerHex(publicKeyPkcs1DerHex));

// 2. State exactly what you expect the token to be bound to (fail-closed).
var expected = new OnlineAssertionExpected
{
    Project            = "DEFAULT",
    Feature            = "EXPORT",
    LicenseFingerprint = licenseFingerprint64Hex,
    DeviceHash         = deviceHash64HexOrEmpty,
    Nonce              = challengeNonce64Hex,   // the nonce you sent to /v1/verify (anti-replay)
    MinRevocationSeq   = lastSeenRevocationSeq, // anti-rollback floor
    TrustedKeys        = ring,
    // NowEpochSeconds defaults to the system clock; set it for deterministic tests.
};

VerifyResult<OnlineAssertionClaims> result = OnlineAssertionVerifier.Verify(assertionToken, expected);
if (result.Ok)
{
    // result.Claims has the validated, parsed fields.
}
else
{
    // result.Code is a typed VerifyFailureCode; result.Detail is a safe-to-log message.
    // NEVER an exception on a bad token.
}
```

The verifier mirrors `src/library/online_verification/OnlineVerification.cpp` exactly: 3-part envelope,
exact prefix, **canonical standard base64** (url-safe / unpadded / whitespace rejected),
RSA-PKCS1-SHA256 over the payload bytes against the **key-id-selected** trusted key (unknown key-id →
reject; key below 3072 bits → reject), the 14 canonical `key=value` lines in fixed order (no missing /
extra / duplicate / reordered fields, trailing `\n` required, no `\r`), then claim validation:
`purpose`/`version`/`alg`/`status`, project/feature/fingerprint/device-hash binding, 64-hex shape for
fingerprint/nonce/device-hash, the `issued-at <= now+300 && expires-at >= issued-at &&
cache-until >= expires-at` window, the optional max-cache window, and `revocation-seq >= floor`.

## Verifying a config-attestation token (`lcccfg1`)

```csharp
var expected = new ConfigTokenExpected
{
    Project            = "DEFAULT",
    Feature            = "EXPORT",
    LicenseFingerprint = licenseFingerprint64Hex,
    DeviceHash         = "",                 // empty when the config is not device-bound
    ConfigBytes        = File.ReadAllBytes("app-config.json"), // config-hash must equal sha256(these)
    MinConfigSeq       = lastSeenConfigSeq,  // anti-rollback floor
    TrustedKeys        = ring,
};

VerifyResult<ConfigTokenClaims> result = ConfigTokenVerifier.Verify(configToken, expected);
```

Same envelope/signature core; differs by purpose (`licensecc-config-attestation`), the
`config-hash == sha256:<hex of config bytes>` binding, and the rule that a config token **must** carry
a finite (`expires-at != 0`) expiry — mirroring `src/library/config_attestation/ConfigAttestation.cpp`.

## Key-import note (PKCS#1 vs SPKI)

The golden public keys are **PKCS#1 `RSAPublicKey` DER** (`30 82 ... 02 82 ...`). .NET imports these
directly with `RSA.ImportRSAPublicKey` — no SubjectPublicKeyInfo wrapping needed. (A Python port using
`cryptography`'s `load_der_public_key`, which expects SPKI, would have to wrap the bytes in an
`rsaEncryption` AlgorithmIdentifier or rebuild from `n`/`e`. The `CoreEdgeCaseTests` test pins this
asymmetry: bare PKCS#1 bytes fail `ImportSubjectPublicKeyInfo` but succeed `ImportRSAPublicKey`.)

## HTTP client wrapper

```csharp
using var http = new HttpClient();
var client = new LicensingBackendClient(http, "https://licensecc-online-verifier.example.workers.dev")
{
    AuthorizationBearer = "lcca_...",   // applied to lease/seat/report calls; /v1/verify needs none
};

BackendResponse r = await client.VerifyAsync(RequestBody.New()
    .Set("project", "DEFAULT")
    .Set("feature", "EXPORT")
    .Set("license_fingerprint", fingerprint64Hex)
    .Set("nonce", nonce64Hex)
    .Build());

if (r.Ok && r.Code == "entitlement_ok")
{
    string assertion = r.GetString("assertion");   // feed this to OnlineAssertionVerifier.Verify
}
```

Every client-facing endpoint returns the flat `{ ok, code?, ... }` envelope; the wrapper exposes
`Ok`, `Code`, `HttpStatus`, and the full decoded `Fields` (plus `GetString`/`GetInt64` helpers).
Note that `/v1/verify` can return **HTTP 200 with `ok:false`** (a soft denial) — check `Ok`, not just
the status code. The bodies match the shipped OpenAPI spec at
`services/cloudflare-licensing-backend/src/openapi.ts`.

The wrapper is deliberately thin: it does not retry, does not manage device proofs, and does not
perform any local enforcement. Request-proof / device-binding fields, when used, are passed straight
through in the request body.
