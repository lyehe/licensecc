# Anti-tamper host example

This example shows how a host application supplies a best-effort
`LCC_HOST_INTEGRITY_CHECK` callback through `acquire_license_ex()`.

The callback `host_integrity_check` runs only after the base license verifies as
`LICENSE_OK`. It is the place where a product implements its own best-effort
runtime probes (a debugger check, a self-measurement, a parent-process check).
Returning `true` lets the license stand; returning `false` signals a tamper
suspicion and writes a short reason into the supplied detail buffer.

The check options initializer sets the secure defaults, so `tamper_policy` is
`LCC_TAMPER_ENFORCE`. Under that policy, returning `false` denies the license:
`acquire_license_ex()` clears the result and returns `LICENSE_TAMPER_DETECTED`.

## Best-effort, NOT tamper-proof

A `host_integrity_check` runs on a machine the attacker may fully control. It can
be patched out, hooked, or stubbed to always return `true`. Do not treat it as a
guarantee. Use it as one input to a layered defense: combine it with server-side
entitlement checks and online verification (see the `online_callback` example),
plus telemetry. On its own it stops nothing.

## Build and run

Enable examples when configuring, then build the `anti_tamper_host` target:

```console
cmake -S . -B build -DLCC_BUILD_EXAMPLES=ON
cmake --build build --target anti_tamper_host
```

Run it with an explicit license path:

```console
anti_tamper_host <license-path>
```

The example disables environment-sourced license lookup, then acquires the
license with the integrity callback wired in. On success it prints that the
runtime integrity check passed; on denial it prints `lcc_strerror()` and the
detail from `print_error()`.
