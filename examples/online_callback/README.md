# Online Callback Example

This example shows how a host application can implement `LCC_ONLINE_CHECK`
without adding HTTP transport to licensecc core.

## Build and run

This is a standalone consumer of an installed Licensecc package; it is not a
target in the repository-root build. First complete the
[offline-first tutorial](../../doc/tutorials/offline-first-license.rst), which
installs the `test` project under `build/dev-debug/install` and issues the
matching sample license. The commands below start in the Licensecc repository
root. Linux needs a libcurl development package; otherwise CMake intentionally
skips this target. On Windows/MSVC, CMake uses libcurl when available and
otherwise selects the native WinHTTP implementation.

Starting directory: the Licensecc repository root. Shell: Bash on Linux or
PowerShell 7 on Windows/MSVC.

### Linux (Bash)

```bash
repo="$PWD"
cmake -S examples/online_callback -B build/online-callback \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_PREFIX_PATH="$repo/build/dev-debug/install" \
  -Dlicensecc_DIR="$repo/build/dev-debug/install/lib/cmake/licensecc" \
  -DLCC_PROJECT_NAME=test
cmake --build build/online-callback
"$repo/build/online-callback/online_callback" \
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" \
  https://licensecc-online-verifier.example.workers.dev
```

### Windows/MSVC (PowerShell 7)

```powershell
$repo = (Resolve-Path ".").Path
cmake -S examples/online_callback -B build/online-callback `
  -G "Visual Studio 17 2022" -A x64 `
  "-DCMAKE_PREFIX_PATH=$repo/build/dev-debug/install" `
  "-Dlicensecc_DIR=$repo/build/dev-debug/install/cmake/licensecc" `
  -DLCC_PROJECT_NAME=test
cmake --build build/online-callback --config Debug
& "$repo/build/online-callback/Debug/online_callback.exe" `
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" `
  https://licensecc-online-verifier.example.workers.dev
```

Replace the example verifier URL with a deployed HTTPS endpoint that returns a
valid signed assertion for the `test` project. With a valid local license and
an accepted online assertion, the executable exits 0 and prints:

```text
result=license OK
license OK
```

You can pass backup verifier endpoints after the primary endpoint. From the
same repository-root shells above:

```bash
"$repo/build/online-callback/online_callback" \
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" \
  https://primary.example.workers.dev \
  https://backup.example.workers.dev
```

```powershell
& "$repo/build/online-callback/Debug/online_callback.exe" `
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" `
  https://primary.example.workers.dev `
  https://backup.example.workers.dev
```

Verifier URLs must use HTTPS by default. For local development against a test
server, pass `--allow-insecure-http-for-test` before the HTTP endpoint:

```bash
"$repo/build/online-callback/online_callback" \
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" \
  --allow-insecure-http-for-test http://127.0.0.1:8787
```

```powershell
& "$repo/build/online-callback/Debug/online_callback.exe" `
  "$repo/build/dev-debug/projects/test/licenses/quickstart.lic" `
  --allow-insecure-http-for-test http://127.0.0.1:8787
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
