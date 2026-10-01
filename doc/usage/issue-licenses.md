# Issue licenses

Licensecc supports two issuing paths:

- offline v201 `.lic` files issued with `lccgen` for the C++ library and
  inspector;
- protected grants managed by the Cloudflare admin service and served by the
  licensing backend to the native device-bound client.

Use offline license files when a product only needs offline verification. Use
protected grants when each machine must enroll a TPM-held device key through
browser consent and hold a short signed lease: node-locked or trial access, a
device limit, catalog tiers, and customer self-service. Protected grants need a
TPM and a desktop browser on the client machine.

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

`lccgen` issues only the v201 format, which is the only format the runtime
accepts. It refuses project keys below 3072 bits and project names the v201
format cannot carry: a name must start with an ASCII letter or `_` and contain
only ASCII letters, digits, and `_`.

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

## Protected grants

Protected grants are created through the admin service, the bearer-authenticated
sync endpoint, or signed orders, and are stored in the licensing backend
database. Every grant is protected and names its owning customer. Its license
mode is derived, not chosen:

- `trial`: `is_trial = 1`
- `node_locked`: every other grant

A grant's only capacity is its device limit, `max_active_devices`. A native
client enrolls through `POST /v2/device-authorizations` and customer consent in
the portal, then exchanges and renews signed `lccdl1` leases through
`POST /v2/device-challenges`, `POST /v2/device-authorizations/exchange`, and
`POST /v2/device-leases/renew`. A lease lasts at most 24 hours and never
survives a process restart. The C++ runtime is the on-device enforcement layer;
the SDKs reach the backend only through its native adapters.

### Set up hosted licensing

Hosted licensing creates or changes Cloudflare resources, the D1 baseline,
bindings, secrets, and deployed Workers. Those are privileged side effects:
follow the owning service runbooks, use an explicitly selected account and
environment, and review every remote command before running it. Start with
staging:

- [licensing backend runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-licensing-backend#readme)
  for D1, signing-key, baseline schema, protected readiness, and deployment
  order;
- [admin service runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-license-admin#readme)
  for Cloudflare Access authentication, policy templates, entitlement
  stamping, catalog projection, and admin deployment;
- [customer portal runbook](https://github.com/lyehe/licensecc/tree/main/services/cloudflare-customer-portal#readme)
  for customer sign-in, device consent, and connected devices.

Install JavaScript dependencies exactly once from the repository root with
`npm ci`. Service-local `npm ci` and `npm --prefix` installs are unsupported
because the root workspace lockfile is the dependency authority.

The backend's protected lease signing key
(`BOUND_LEASE_SIGNING_PRIVATE_KEY_PKCS8_PEM`) and the offline project's
`private_key.rsa` serve different trust domains. Never reuse either key for the
other purpose, expose private material to client applications, or put it in
source control. Native clients ship the lease signer's public key in their
trust set and verify each signed `lccdl1` lease locally after an online
response.
