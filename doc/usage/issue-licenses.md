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

The license generator executable is built with the project. Put `lcc` on your
`PATH`, or run it from the build/install tree.

Create a perpetual local license:

```console
cd build/dev-debug/projects/DEFAULT
lcc license issue -o licenses/customer.lic
```

Create a license bound to a hardware identifier:

```console
cd build/dev-debug/projects/DEFAULT
lcc license issue --client-signature XXXX-XXXX-XXXX -o licenses/customer.lic
```

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

Run `lcc license issue --help` for the full option set.

## Online entitlements

Online entitlements are created through the admin service and stored in the
licensing backend database. The license mode is derived from stamped entitlement
capacity:

- `trial`: `is_trial = 1`
- `floating`: `pool_size > 0`
- `node_locked`: `pool_size = 0`

The normal setup path is:

1. Deploy and migrate the licensing backend.
2. Deploy the admin Worker.
3. Enable policy stamping with `POLICY_STAMP_MODE=on`.
4. Create policy templates for node-locked, floating, trial, or subscription use.
5. Create entitlements from policies, or project catalog plans to entitlements.

Node-locked clients use `/v1/activate` and `/v1/renew`. Floating clients use
`/v1/checkout`, `/v1/heartbeat`, and `/v1/release`.

For concrete policy JSON examples and catalog-plan projection commands, see
`services/cloudflare-license-admin/README.md`.
