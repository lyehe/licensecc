# Online Callback Example

This example shows how a host application can implement `LCC_ONLINE_CHECK`
without adding HTTP transport to licensecc core.

Build it against an installed licensecc package. The example uses libcurl when
available and falls back to WinHTTP on Windows:

```console
cmake -S examples/online_callback -B build/online_callback ^
  -DCMAKE_PREFIX_PATH=<licensecc install dir> ^
  -DLCC_PROJECT_NAME=<project name>
cmake --build build/online_callback
```

Run:

```console
online_callback <license-path> https://licensecc-online-verifier.example.workers.dev
```

You can pass backup verifier endpoints after the primary endpoint:

```console
online_callback <license-path> https://primary.example.workers.dev https://backup.example.workers.dev
```

Verifier URLs must use HTTPS by default. For local development against a test
server, pass `--allow-insecure-http-for-test` before the HTTP endpoint:

```console
online_callback <license-path> --allow-insecure-http-for-test http://127.0.0.1:8787
```

Endpoints are tried in order. The callback falls through to the next endpoint
only for transport-level failures such as timeout, connection failure, or HTTP
5xx. It does not fail over after an entitlement denial, malformed response, or
local buffer problem; those are treated as authoritative failures for that
check. Keep primary and backup verifiers on the same entitlement projection and
monotonic `revocation_seq` stream, and build the C++ runtime with every online
assertion public key that any accepted verifier can use.

Verifier response bodies are capped by the example before parsing. Production
hosts should keep an equivalent cap and should avoid logging raw hardware
identifiers, license fingerprints, verifier secrets, or full assertion bodies.

The shared helper also exposes an optional request proof hook:
`OnlineClient::request_proof_provider`. A host can generate or load a registered
device key, build the exact payload with `canonical_request_proof_payload()`,
sign it, and return `device_key_id`, `request_timestamp`, and
`request_signature`. When present, the JSON request includes the proof fields
accepted by the Cloudflare verifier's `REQUEST_SIGNATURE_MODE=soft|required`
policy. Key generation, secure private-key storage, and registration with the
verifier remain host responsibilities.

The example uses the secure online policy: a locally valid license still needs a
fresh signed assertion from the verifier. Transport failures, entitlement
denials, malformed assertions, expired assertions, or rollback below the
in-process revocation floor fail closed.

For production-shaped integrations that need a durable rollback floor, use the
`production_decision_host` example. It wires `lcc_acquire_license_decision()`,
backup verifier endpoints, a host-integrity callback, and a file-backed
revocation floor together.
