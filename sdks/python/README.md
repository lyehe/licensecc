# licensecc — Python client SDK

Verify the **server-signed tokens** issued by the licensecc licensing-backend,
and call its client-facing HTTP endpoints — from Python, with byte-for-byte
parity against the C++ verifier and the shared golden vectors.

> [!IMPORTANT]
> **This SDK covers the HTTP + token CONTRACT, not the binary enforcement
> layer.** Anti-tamper, hardware fingerprinting, environment detection, and the
> offline `.lic` license check live in the C++ `licensecc::licensecc_static`
> library and are **deliberately not** reimplemented here. Use this SDK to talk
> to the verifier and to validate the tokens it returns; use the C++ library for
> on-device enforcement.

## What it does

Two surfaces:

1. **Offline token verifier** (the security-critical core, fail-closed):
   - `verify_online_assertion()` — the `lccoa1` online-assertion token (the
     verifier's primary target).
   - `verify_config_token()` — the `lcccfg1` config-attestation token.
   Both mirror the C++ verifier exactly: 3-part envelope, standard (not
   url-safe) **canonical** base64, RSASSA-PKCS1-v1_5 + SHA-256 over the payload
   bytes against the trusted key **selected by `key-id`**, strict canonical
   `key=value` payload parse (order/duplicates/trailing/values), and full claim
   validation (purpose / alg / version / status, project·feature·fingerprint·
   device binding, time window with a configurable skew, anti-rollback floor,
   and — for config — the `config-hash` over the exact config bytes).

2. **Thin HTTP client** (`HttpClient`) — small wrappers over the documented
   client-facing endpoints (`/v1/verify`, `/v1/activate`, `/v1/renew`,
   `/v1/checkout`, `/v1/heartbeat`, `/v1/release`), parsing the FLAT
   `{ ok, code, ... }` response envelope.

The verifier **never raises on a bad token** — every rejection is a typed
`VerificationResult(ok=False, code=RejectionCode...)`.

## Install

```console
# from this directory (uv resolves the cryptography dependency)
uv run pytest -q
```

Runtime dependency: only [`cryptography`](https://pypi.org/project/cryptography/).
The HTTP client uses the standard-library `urllib` — no `requests`/`httpx`
needed (an optional `httpx` extra exists for users who prefer it).

## Verify an online assertion

```python
from licensecc import (
    TrustedPublicKey,
    OnlineAssertionExpected,
    verify_online_assertion,
)

# The trusted RSA public key is PKCS#1 RSAPublicKey DER (as the backend ships it).
# TrustedPublicKey handles the PKCS#1 -> cryptography import for you and derives
# the canonical sha256:<hex> key-id.
trusted = [TrustedPublicKey.from_pkcs1_der_hex(pkcs1_der_hex)]

result = verify_online_assertion(
    token,                       # the "lccoa1.<b64>.<b64>" string from /v1/verify
    OnlineAssertionExpected(
        project="DEFAULT",
        feature="EXPORT",
        license_fingerprint="a" * 64,
        device_hash="b" * 64,    # "" when not device-bound
        nonce=my_nonce,          # the nonce you sent to /v1/verify
        check_nonce_binding=True,
        min_revocation_seq=last_seen_seq,   # anti-rollback floor
        # now=...                # pin a clock for deterministic checks
    ),
    trusted,
)

if result.ok:
    claims = result.claims       # OnlineAssertionClaims dataclass
else:
    print("rejected:", result.code, result.detail)   # typed RejectionCode
```

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

## Call the verifier over HTTP

```python
from licensecc import HttpClient, verify_online_assertion, OnlineAssertionExpected

client = HttpClient("https://licensecc-online-verifier.example.workers.dev")

resp = client.verify(
    project="DEFAULT",
    feature="EXPORT",
    license_fingerprint="a" * 64,
    nonce=my_nonce,
)
# FLAT envelope: resp.ok / resp.code / resp.data. A soft denial is HTTP 200 ok:false.
if resp.ok and resp.assertion:
    # The server is authoritative; the local check is fail-closed defence in depth.
    verify_online_assertion(resp.assertion, OnlineAssertionExpected(...), trusted)
```

The lease/seat endpoints (`activate`, `renew`, `checkout`, `heartbeat`,
`release`) take a JSON body matching the OpenAPI spec and an account bearer:

```python
client = HttpClient(base_url, account_token="lcca_...")
client.checkout({"project": "DEFAULT", "feature": "EXPORT", "license_fingerprint": "a"*64,
                 "client_instance_id": "...", "nonce": "..."})
```

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

- **Positive:** the golden `lccoa1` and `lcccfg1` tokens (standalone and
  embedded-key) verify, and the claims parse to the exact `golden.payload`
  values.
- **Negative:** tampered signature, payload byte flip, expired, wrong purpose,
  project/feature/fingerprint/device binding mismatch, revocation/config-seq
  below the floor, unknown key-id, url-safe / non-canonical base64, and every
  malformed-envelope shape — each is rejected with the expected `RejectionCode`.

```console
uv run pytest -q
```
