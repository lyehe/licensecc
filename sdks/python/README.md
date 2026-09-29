# licensecc — Python client SDK

Verify the **server-signed `lcccfg1` config-attestation token** issued by the
licensecc licensing-backend — from Python, with byte-for-byte parity against
the C++ verifier and the shared golden vectors.

> [!IMPORTANT]
> **This SDK covers the token CONTRACT, not the binary enforcement layer.**
> Anti-tamper, hardware fingerprinting, environment detection, and the offline
> `.lic` license check live in the C++ `licensecc::licensecc_static` library
> and are **deliberately not** reimplemented here. Use this SDK to validate the
> tokens the backend issues; use the C++ library for on-device enforcement.

## What it does

**Offline token verifier** (the security-critical core, fail-closed):

- `verify_config_token()` — the `lcccfg1` config-attestation token.

It mirrors the C++ verifier exactly: 3-part envelope, standard (not url-safe)
**canonical** base64, RSASSA-PKCS1-v1_5 + SHA-256 over the payload bytes
against the trusted key **selected by `key-id`**, strict canonical
`key=value` payload parse (order/duplicates/trailing/values), and full claim
validation (purpose / alg / version, project·feature·fingerprint·device
binding, expiry, anti-rollback floor, and the `config-hash` over the exact
config bytes).

The verifier **never raises on a bad token** — every rejection is a typed
`VerificationResult(ok=False, code=RejectionCode...)`.

## Install

An optional [Windows/Linux device-bound bridge](native/README.md) wraps the native
enrollment and renewal owner with typed Python results. It requires a separately
built application-owned DLL.

The package is not published to PyPI yet — install it from this repository:

```console
pip install ./sdks/python            # from the repo root
```

or, with uv in your application: `uv add <path-to-repo>/sdks/python`.

To run this SDK's tests: `uv run pytest -q` from this directory.

Runtime dependency: only [`cryptography`](https://pypi.org/project/cryptography/).

## Verify a config-attestation token

```python
from licensecc import (
    TrustedPublicKey,
    ConfigAttestationExpected,
    verify_config_token,
)

result = verify_config_token(
    token,                       # "lcccfg1.<b64>.<b64>"
    ConfigAttestationExpected(
        config_bytes=open("app.config", "rb").read(),   # EXACT bytes
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint="a" * 64,
        min_config_seq=last_applied_seq,                # anti-rollback floor
    ),
    [TrustedPublicKey.from_pkcs1_der_hex(config_pkcs1_der_hex)],
)
```

The `config-hash` claim must equal `sha256:` + `sha256(config_bytes)`, binding
the signed token to the exact config you hold.

## The PKCS#1 → import gotcha (why `TrustedPublicKey` exists)

The trusted public keys are **PKCS#1 `RSAPublicKey` DER** (bytes start
`30 82 … 02 82 …`). Python's `cryptography.load_der_public_key` expects
**SPKI / SubjectPublicKeyInfo**, so it will *reject* a raw PKCS#1 key. This SDK
parses the modulus/exponent and rebuilds the key via `RSAPublicNumbers`, so you
can hand it the exact bytes the backend distributes. (.NET's
`RSA.ImportRSAPublicKey` consumes PKCS#1 natively — this is the documented
language asymmetry.)

## Parity & tests

`tests/` loads the repository golden vectors from `../../test/vectors/` and
asserts:

- **Positive:** the golden `lcccfg1` token (standalone and embedded-key)
  verifies, and the claims parse to the exact `golden.payload` values.
- **Negative:** tampered signature, payload byte flip, expired,
  project/feature/fingerprint/device binding mismatch, config-seq below the
  floor, unknown key-id, url-safe / non-canonical base64, and every
  malformed-envelope shape — each is rejected with the expected `RejectionCode`.

```console
uv run pytest -q
```


### Feature work sessions (optional native bridge)

`licensecc.feature_session.FeatureSessionLibrary` uses the same application-owned
64-bit Windows/Linux bridge library and `device_bound.Configuration`. Enroll the configured
feature first with `DeviceBoundLibrary`; normal feature starts never open a
browser. Each logical job opens a **new** owner and must start online:

```python
from licensecc.device_bound import Result
from licensecc.feature_session import FeatureSessionLibrary

sessions = FeatureSessionLibrary(absolute_bridge_path)
job, opened = sessions.open(batch_configuration)  # feature="BATCH_RUN"
if opened.code is not Result.OK:
    raise RuntimeError(f"Cannot open feature: {opened.code.name}")
with job:
    started = job.start()
    if started.code is not Result.OK:
        raise RuntimeError(f"Online approval required: {started.code.name}")
    # Inspect checkpoint_result independently and recover storage if necessary.
    for batch in batches:
        decision = job.authorize("BATCH_RUN")
        if decision.code is Result.OK and decision.renewal_due:
            renewal = job.renew()  # blocking: use an application worker thread
            # Handle renewal/checkpoint outcomes; never infer permission from renew.
            decision = job.authorize("BATCH_RUN")
        if decision.code is not Result.OK:
            break  # pause/stop; do not execute the protected batch
        run_protected_batch(batch)
    stopped = job.stop()  # terminal local shutdown; inspect checkpoint_result
```

Only a current `authorize(required_feature)` OK permits the next operation.
Advisory state, opening, saving a checkpoint, and successful renewal are not
permission. Retry an unresolved start on the same handle with bounded backoff;
never substitute an earlier job's permission. The adapter does not cache tokens,
start a background thread or implement its own clock. Calls overlap as BUSY;
close waits for admitted calls. Stop does not release a device slot or delete the
shared key. Closing ends ownership; a stopped handle cannot start a new job.

Build the bridge against a runtime that includes `feature_session.h`. Its
independent `lcc_feature_session_bridge_layout` probe checks every new field.
A bridge without these exports fails with the platform loader error; rebuild it
in the same release as the SDK. Set `LCC_TEST_DEVICE_BOUND_DLL` to
the newly built absolute DLL path when running pytest to include installed-ABI
checks. Fake-adapter tests alone do not establish a live TPM/server journey.
