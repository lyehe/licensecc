# Issue licenses

Licensecc supports two issuing paths:

- local/offline license files for the C++ library and inspector;
- online entitlements managed by the Cloudflare backend/admin service.

Use local license files when a product only needs offline verification. Use online
entitlements when you need account-bound activation, node-locked leases, floating
seats, trials, metering, catalog tiers, or customer self-service.

## Local license files

Configure and build the project first. By default, generated project material is
written under the CMake build tree:

```text
build/<preset>/projects/<project-name>
```

The generated project contains the public-key header, private signing key, and a
`licenses/` directory:

```text
projects/
└── DEFAULT
    ├── include/
    │   └── licensecc/
    │       └── DEFAULT/
    │           ├── licensecc_properties.h
    │           └── public_key.h
    ├── licenses/
    └── private_key.rsa
```

Use `LCC_PROJECT_NAME` to choose another project name, and use
`LCC_PROJECTS_BASE_DIR` only when you intentionally want a stable project
directory outside the build tree.

The private key is the authority for that project's offline licenses. Keep it
in publisher-controlled storage and never ship it in the application, SDK
package, installer, container image, or support bundle. Consumers receive only
the public-key material compiled into the runtime and the license files you
issue.

The license generator executable is built with the project; the default install
does not add it to your shell's `PATH`. The checked-in `dev-debug` preset names
the project `test`; a manual configure without `LCC_PROJECT_NAME` uses
`DEFAULT`.

On Windows, after using the Visual Studio 2022 x64 sequence in the
[offline tutorial](../tutorials/offline-first-license.rst), run these PowerShell
commands from the repository root:

```powershell
$repo = (Resolve-Path ".").Path
$project = "$repo/build/dev-debug/projects/test"
$lccgen = "$repo/build/dev-debug/extern/license-generator/src/license_generator/Debug/lccgen.exe"

& $lccgen license issue -p $project -o "$project/licenses/customer.lic"
& $lccgen license issue -p $project --client-signature XXXX-XXXX-XXXX -o "$project/licenses/customer.lic"
```

On Linux, after completing the same tutorial, run these Bash commands from the
repository root:

```bash
repo="$PWD"
project="$repo/build/dev-debug/projects/test"
lccgen="$repo/build/dev-debug/extern/license-generator/src/license_generator/lccgen"

"$lccgen" license issue -p "$project" -o "$project/licenses/customer.lic"
"$lccgen" license issue -p "$project" --client-signature XXXX-XXXX-XXXX -o "$project/licenses/customer.lic"
```

Each pair shows a perpetual license first and a hardware-bound license second;
both write `licenses/customer.lic`, so run the form you intend to keep. Neither
command deploys anything or contacts a remote service. With another CMake
generator, use the `lccgen` path printed by that generator's build rather than
the Visual Studio-specific `Debug` path above.

The destination application can print its hardware identifier through your own
integration code, or you can use `lccinspector` while testing.

Useful options:

| Parameter | Description |
| --- | --- |
| `--base64`, `-b` | Encode the license for environment-variable transport. |
| `--valid-from` | Start date, formatted `YYYY-MM-DD`; defaults to today. |
| `--valid-to` | Expiration date, formatted `YYYY-MM-DD`; omitted means no expiration. |
| `--client-signature` | Hardware identifier in `XXXX-XXXX-XXXX` format. |
| `--output-file-name`, `-o` | License output file path. |
| `--extra-data` | Application-specific data returned by `acquire_license`. |
| `--feature-names` | Comma-separated licensed feature names. |

Run `& $lccgen license issue --help` in PowerShell or
`"$lccgen" license issue --help` in Bash for the full option set.

## Online entitlements

Online entitlements are created through the admin service and stored in the
licensing backend database. The license mode is derived from stamped entitlement
capacity:

- `trial`: `is_trial = 1`
- `floating`: `pool_size > 0`
- `node_locked`: `pool_size = 0`

Node-locked clients use `/v1/activate` and `/v1/renew`. Floating clients use
`/v1/checkout`, `/v1/heartbeat`, and `/v1/release`.

The online server and its SDK clients are supported repository surfaces; the
C++ runtime remains the on-device enforcement layer.

### Choose an online setup

**Local evaluation** runs the production Worker code on a loopback-only Node
host backed by SQLite. It does not require a Cloudflare account and should be
the first path used to evaluate online verification. Start with the
[local SQLite host runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-licensing-backend/local-host#readme).
That runbook owns the local database, test signing-key, entitlement seed, and
smoke-request commands. Its generated database and private key are local
development artifacts, not production credentials.

**Staging or production** creates or changes Cloudflare resources, migrations,
bindings, secrets, and deployed Workers. Those are privileged side effects:
follow the owning service runbooks, use an explicitly selected account and
environment, and review every remote command before running it:

- [licensing backend runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-licensing-backend#readme)
  for D1, signing-key, migration, verification, and deployment order;
- [admin service runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-license-admin#readme)
  for Cloudflare Access authentication, policy templates, entitlement
  stamping, catalog projection, and admin deployment;
- [customer portal runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-customer-portal#readme)
  when customer self-service is part of the deployment.

Install JavaScript dependencies exactly once from the repository root with
`npm ci`. Service-local `npm ci` and `npm --prefix` installs are unsupported
because the root workspace lockfile is the dependency authority.

The backend's online assertion private key and the offline project's
`private_key.rsa` serve different trust domains. Never reuse either key for the
other purpose, expose private material to client applications, or put it in
source control. Clients receive a trusted public key and verify the signed
`lccoa1` assertion locally after an online response.
