# License retrieval

## How `licensecc` finds license data

Licensecc, when integrated into a software can automatically find its license file (or multiple license files) based on:
 * Environment variables, when the host application explicitly enables this lookup:
 	* Placing the full path of the license file in the environment variable `LICENSE_LOCATION` the library will look for it. Multiple license files can be separated by ';'
 	* Placing the full license content in the environment `LICENSE_DATA` will let the library load it.
 * Placing the license in the same folder of the licensed executable will make the software find its own license. The filename must be the same of the executable, the extension `.lic`. eg. if you're licensing `my_awesome_software.exe` the license file must be in the same folder and must be called `my_awesome_software.lic`.
 * The calling application can specify the location (or the complete license data) using `LicenseLocation` structure.
 * Implementing and registering the interface `LicenseLocator` software authors can easily define their own strategy.

Hardened generated projects set `FIND_LICENSE_WITH_ENV_VAR` to `false`, so
environment-variable license sources are disabled by default. This is a
compatibility break from deployments that relied on ambient process
environment variables. Prefer an explicit `LicenseLocation` or the colocated
executable license-file flow.

Enable environment lookup only when the process environment is trusted, for
example in controlled tests or support workflows:

```cpp
lcc_set_environment_license_sources_enabled(true);
```

When environment sources are disabled, setting `LICENSE_LOCATION` or
`LICENSE_DATA` will not affect `acquire_license()`.

## Deployment recommendations

For production deployments, prefer one of these source patterns:

* Place a signed license file next to the licensed executable. The file name
  must match the executable name with a `.lic` extension.
* Pass an explicit `LicenseLocation` from trusted host configuration.

`LicenseLocation` supports three explicit source types:

* `LICENSE_PATH`: `licenseData` contains one or more license file paths
  separated by `;`.
* `LICENSE_PLAIN_DATA`: `licenseData` contains the full license text.
* `LICENSE_ENCODED`: `licenseData` contains a base64-encoded license payload.

If the process accepts a license path from an administrator-controlled
configuration file, read that configuration yourself, copy the selected value
into `LicenseLocation.licenseData` with a bounded copy, set
`license_data_type`, and pass the structure directly to `acquire_license()`.
This keeps the source decision visible in the host application.

Treat process environment variables as support-only or test-only inputs unless
your deployment model proves they are trusted. In many desktop, service, shell,
and launcher deployments, users or surrounding processes can set
`LICENSE_LOCATION` and `LICENSE_DATA`. Leave environment lookup disabled with:

```cpp
lcc_set_environment_license_sources_enabled(false);
```

When you temporarily enable environment lookup for support workflows, prefer
also enabling strict source-fatal handling so malformed environment data cannot
be masked by a fallback file:

```cpp
lcc_set_environment_license_sources_enabled(true);
lcc_set_strict_source_fatal_enabled(true);
```

## Multiple source policy

By default, Licensecc keeps a compatibility fallback policy. If several
candidate sources are configured and one candidate verifies successfully,
`acquire_license()` returns `LICENSE_OK`; malformed candidates remain visible
as warning audit events in `LicenseInfo.status`.

Hosts that treat a configured source as authoritative can opt into strict
source-fatal handling:

```cpp
lcc_set_strict_source_fatal_enabled(true);
```

With strict source-fatal handling enabled, malformed or invalid-format
candidates return `LICENSE_MALFORMED` or `FILE_FORMAT_NOT_RECOGNIZED` even when
another candidate verifies successfully. This is the safer mode for hosts that
accept explicit license data from an administrator-controlled path, or that
temporarily enable `LICENSE_LOCATION`/`LICENSE_DATA` and do not want those
sources masked by a fallback license.

New integrations that need per-call policy can use `acquire_license_ex()` with
`LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING` instead of the process-global
source-fatal toggle. `lcc_init_license_check_options()` enables strict
source-shadowing by default, so a shadowed malformed source returns
`LICENSE_TAMPER_DETECTED` even when another fallback source is valid. Use
`acquire_license()` for the historical fallback behavior, or set
`tamper_policy = LCC_TAMPER_DISABLED` only for compatibility tests.

Production online integrations should prefer `lcc_acquire_license_decision()`.
It fixes the secure policy choices for the host: tamper enforcement, strict
source-shadowing, required online verification, and persisted revocation-floor
load/store callbacks. Use `acquire_license_ex()` directly when you intentionally
need lower-level control or compatibility with an existing integration.
