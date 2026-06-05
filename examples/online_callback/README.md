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

The example uses the secure online policy: a locally valid license still needs a
fresh signed assertion from the verifier. Transport failures, entitlement
denials, malformed assertions, expired assertions, or rollback below the
in-process revocation floor fail closed.
