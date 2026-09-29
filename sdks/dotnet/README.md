# Licensecc.Client (.NET SDK)

## Optional feature sessions

`Licensecc.Client.DeviceBound.FeatureSessionLibrary` uses the installed Windows
bridge to authorize one named feature for one job. Configure and enroll each
feature through the existing device-bound flow first.

Open a new session for every job, call `Start()`, then call
`Authorize("BATCH_RUN")` before the first protected unit, each subsequent unit,
and result publication. Only `Result.Ok` from that authorization permits work.
When `RenewalDue` is set, call `Renew()` and authorize again. Calls block and
belong on an application worker thread. Serialize access to each session.

`Stop()` ends local authority; dispose the session afterward. It does not retire
the machine or release its device slot. Handle `CheckpointResult` separately:
retry `SaveCheckpoint()` when persistence needs recovery. Neither saving nor
renewal alone authorizes work. Do not fall back to cached permission after a
failed start. Retry transient starts on the same handle with bounded backoff.

The adapter requires the feature-session exports in the application-owned
bridge DLL; an older DLL remains usable through `DeviceBoundLibrary` and
explicitly rejects this optional adapter. See the
[native API guide](../../doc/api/feature_sessions.rst) for failure semantics and
the [installed bridge](../python/native/README.md) for building the shared DLL.

A .NET 8 client SDK for **licensecc** licensing:

1. **Offline token verifier (the security-critical core).** Fail-closed verification of the
   `lcccfg1.` **config-attestation** token, produced offline by
   `services/cloudflare-licensing-backend/scripts/config-sign.mjs` and consumed here.
2. **An optional 64-bit Windows/Linux native bridge** for protected-device enrollment,
   renewal, checkpoint recovery and per-operation authorization.

> ## Scope — read this
>
> The managed verifier covers the token contract. The binary enforcement layer — anti-tamper,
> hardware fingerprinting, the offline `.lic` license-file check — lives in the **C++ library**
> (`licensecc::licensecc_static`) and is intentionally **not** reimplemented here; the optional
> protected-device client calls that native owner. A token that
> verifies in this SDK proves the *server's signed assertion is authentic and bound to your
> identifiers*; it does **not** prove the host process is un-tampered. For production copy-protection,
> verify the token here AND run the C++ enforcement layer.

No external NuGet dependencies in the library: it uses only `System.Security.Cryptography`
(`RSA.ImportRSAPublicKey`, which consumes the PKCS#1 `RSAPublicKey` DER natively) and the BCL.

## Windows protected-device client

`Licensecc.Client.DeviceBound` wraps the installed Windows/Linux native owner.
Build the shared C bridge using [the native bridge instructions](../python/native/README.md)
and load its application-owned absolute DLL path with `DeviceBoundLibrary`.
No native binary is bundled in this NuGet package. Loading checks every ABI size,
alignment and field offset before passing any structure. Dependencies resolve
beside the DLL or in System32; protect the DLL and application configuration.

Construct an immutable `Configuration` with the registered application/client,
fixed service origins, project/feature, and dedicated public RSA-3072 DER SPKI
`TrustedSigner` records. `OpenEnrollment(configuration)` may explicitly create
a missing app/user key; `OpenResume(configuration)` requires the existing key
and checkpoint. Both return `(Client, Outcome)`; inspect `Outcome.Code` before
using the client. Native validation and hardware-required policy remain in C++.

For enrollment, call `Prepare()`, display its comparison code, then `Launch()`.
Poll at 0..1,000 milliseconds until `CallbackReceived`, then call `Activate()`.
For resume, call `Renew()`; a saved checkpoint never restores offline permission.
Calls block and belong on an application worker thread. Before every protected
operation, use the native check:

```csharp
using Licensecc.Client.DeviceBound;

// client comes from a successful open and enrollment/renewal flow.
Outcome decision = client.Authorize();
if (decision.Code != Result.Ok)
    throw new InvalidOperationException($"Access unavailable: {decision.Code}");
// Perform the protected native operation immediately; never cache this decision.
```

Only `Authorize()` returning `Ok` permits work. Open, activation, renewal, or
storage success is not an access decision. Primary, provider and checkpoint
results remain independent. On a checkpoint error, retain the original outcome
and use `SaveCheckpoint()` for storage-only recovery. A later `Busy` result does
not replace an earlier unresolved storage failure. A renewal conflict preserves
the request; an explicit `AbandonPending()` returning `OnlineRequired` permits
starting a new renewal. See the [renewal recovery contract](../../doc/api/device_enrollment.rst).

When activation is refused because every device slot of the license is in use,
`Code` is `Conflict` and `Outcome.Detail` is `DeviceBoundDenialDetail.DeviceLimit`:
ask the user to disconnect a device in the customer portal (Devices), then try
again. A detail never grants access. A value this SDK does not name keeps its
number; treat it as `None`. Earlier SDK releases reject any non-zero detail as an
invalid outcome, so upgrade this package together with the bridge DLL.

Dispose clients deterministically. Competing calls return `Busy`; `Dispose()`
waits for an admitted call and closes once. Disposing the library prevents new
opens but existing clients retain a native-library pin. Finalization is fallback
cleanup only. Close/abandon neither undo a server commit nor retire a binding or
delete a key; finish any required checkpoint recovery before closing.

Managed control flow can be modified. Keep valuable protected work and tamper
resistance in native code. Physical TPM/browser/backend qualification remains
required; the installed-DLL test proves ABI loading and no-effect rejection only.
Set `LCC_TEST_DEVICE_BOUND_DLL` to an installed absolute DLL path when running
`dotnet test` to require that test. Windows CI supplies it after the shared bridge
is built and checked; other SDK runs explicitly skip the installed-DLL test.
Set `LCC_TEST_OLD_DEVICE_BOUND_DLL` to the shared bridge's test-only
`licensecc_device_bound_original.dll` to require the original-export compatibility
test too. Windows CI supplies both paths. The fixture is not a distributable DLL.

## Layout

```
sdks/dotnet/
  Licensecc.Client.sln
  src/Licensecc.Client/            # the library (PackageId Licensecc.Client, 0.1.0-rc.2)
    SignedTokenCore.cs             #   shared: envelope split, canonical base64, RSA verify, field parse
    ConfigToken.cs                 #   lcccfg1 verifier -> ConfigTokenVerifier.Verify
    VerifyResult.cs                #   Result type + TrustedPublicKey / TrustedKeyRing
    Hex.cs                         #   zero-dependency helper
  test/Licensecc.Client.Tests/     # MSTest parity suite against test/vectors (positive + negatives)
```

## Build & test

```console
cd sdks/dotnet
dotnet test
```

The test suite loads the repo's golden vectors from `test/vectors/` (resolved via a build-time
pinned path with a relative-path fallback) and proves parity with the C++ verifier.

## Use it in your application

The package is not published to NuGet yet — reference the project from a checkout:

```xml
<ProjectReference Include="<path-to-repo>/sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj" />
```

or produce a local package with `dotnet pack src/Licensecc.Client` and consume it from a
local NuGet feed.

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

