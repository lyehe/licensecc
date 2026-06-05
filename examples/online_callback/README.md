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
online_callback <license-path> https://licensecc-online-verifier.example.workers.dev [audit|require|cache|cache-smoke] [cache-file]
```

Modes:

- `audit`: online failures are audit warnings and a locally valid license remains accepted.
- `require`: online failures deny the license check.
- `cache`: online failures may use a previously returned assertion, subject to the
  `cache-until` time in the signed assertion.
- `cache-smoke`: runs one online check, then switches to an unreachable endpoint
  and runs a second check from the in-memory cache.

When `cache-file` is provided, the example loads and saves one signed assertion
outside licensecc core. Production hosts should store successful assertions in a
host-specific secure location and let `acquire_license_ex()` validate expiry,
nonce/cache binding, signature, request binding, and the in-process revocation
floor before allowing offline grace.
