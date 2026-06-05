# Issue licenses

Issue licenses from the same Licensecc project that was used to build the
runtime library shipped with your application. For release builds, configure a
non-default project name and keep the project folder in an issuer-controlled
location outside the source tree:

```console
cmake -S licensecc -B build-licensecc \
  -DLCC_PROJECT_NAME=MY_PRODUCT \
  -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects \
  -DCMAKE_INSTALL_PREFIX=/opt/licensecc/MY_PRODUCT
cmake --build build-licensecc --target licensecc_static --config Release
```

The automatically-created `DEFAULT` project is only for local tests. Source-tree
project generation requires the explicit development opt-in
`-DLCC_ALLOW_SOURCE_TREE_KEYGEN=ON`; do not use that opt-in for release
packaging.

## Project key generation

Generate the issuer project before building the runtime package you ship:

```console
lccgen project init \
  --project-name MY_PRODUCT \
  --projects-folder /secure/licensecc-projects \
  --templates /path/to/licensecc/src \
  --key-bits 3072
```

`--key-bits` accepts `2048`, `3072`, or `4096`; new projects default to
RSA-3072 when the option is omitted. RSA-1024 generation is available only
through `--legacy-rsa1024` for existing v200 migration or compatibility tests
and must not be used for v201 issuance.

The generated `include/licensecc/MY_PRODUCT/public_key.h` is the verification
key material that is compiled into the consumer application build. The private
`private_key.rsa` remains in the issuer-controlled project folder and is needed
only when issuing licenses. Generated public-key metadata includes the RSA
modulus size, signature algorithm, SHA-256 fingerprint, and key ID
(`sha256:<public-key-der-sha256>`), so repeated validation can detect a
mismatched private key or stale public-key header.

For key rotation, build an overlap runtime that contains both the old and new
public key records, issue replacement licenses with the new private key, then
ship a later runtime that retires or removes the old key ID. v201 verification
selects the embedded public key by the signed `key-id`; duplicate active key
IDs and retired key IDs fail closed.
 
```
/secure/licensecc-projects
└── MY_PRODUCT       #(your project name)
    ├── include
    │   └── licensecc
    │       └── MY_PRODUCT
    │           ├── licensecc_properties.h
    │           └── public_key.h
    ├── licenses
    │   └── test.lic
    └── private_key.rsa
```

Place the `lccgen` executable in your path (this is the executable needed to issue licenses). Runtime installs do not
include issuer tools by default; build or install with `-DLCC_INSTALL_TOOLS=ON` in the issuer environment when you need
`lccgen`.

The lines below will create a perpetual unlimited license for your software:

```
lccgen license issue \
  --project-folder /secure/licensecc-projects/MY_PRODUCT \
  --output-file-name /secure/licensecc-projects/MY_PRODUCT/licenses/{license-file-name}.lic
```

## Licensing software with hardware identifier

To issue a license linked to a specific machine you first need to retrieve an hardware identifier for it.
This can be done running an executable in the destination machine (usually it is your own software, 
that calls `licensecc` api and prints out the required identifier).

If you are just experimenting the library you can compile and use the [examples project](https://github.com/open-license-manager/examples) to print out such hardware signature or
you can run `lccinspector` in the destination machine.

Once you have the hardware identifier you can issue the command:

```
lccgen license issue \
  --project-folder /secure/licensecc-projects/MY_PRODUCT \
  --client-signature XXXX-XXXX-XXXX \
  --output-file-name /secure/licensecc-projects/MY_PRODUCT/licenses/{license-file-name}.lic
```
to create the license file (usually this command is issued in the host machine where you compiled `licensecc`).

Hardware identifiers based on the disk or Ethernet address are accepted by default.
IP-address based identifiers are weaker because IP addresses are often mutable or reused.
To issue a license for an IP-based identifier, pass `--allow-ip-binding` explicitly:

```
lccgen license issue \
  --project-folder /secure/licensecc-projects/MY_PRODUCT \
  --client-signature XXXX-XXXX-XXXX \
  --allow-ip-binding \
  --output-file-name /secure/licensecc-projects/MY_PRODUCT/licenses/{license-file-name}.lic
```

Identifiers generated through the `IDENTIFICATION_STRATEGY` environment variable are also disabled by default
because the issuing operator may not have selected the strategy intentionally. To issue one for a support or
compatibility flow, pass `--allow-env-selected-binding` explicitly.

## Full set of options
A good way to start exploring available options is the command: `lccgen license issue --help`

| Parameter        | Description                                                                                  |
|------------------|----------------------------------------------------------------------------------------------|
|base64,b          | Encode the emitted license data as base64 for `LICENSE_ENCODED` or environment-variable loading. The encoded output is the license payload, not a file path. |
|valid-from        | Specify the start of the validity for this license. Format YYYY-MM-DD. If not specified defaults to today. |
|valid-to          | The expire date for this license. Format YYYY-MM-DD. If not specified the license won't expire |
|client-signature  | The signature of the hardware where the licensed software will run. It should be in the format XXXX-XXXX-XXXX. If not specified the license won't be linked to a specific pc. |
|allow-ip-binding  | Allow issuing a license for an IP-address hardware identifier. This weak binding is disabled by default. |
|allow-env-selected-binding | Allow issuing a license for an identifier produced through `IDENTIFICATION_STRATEGY`. This support-oriented binding is disabled by default. |
|output-file-name  | License output file path.                                                                    |
|license-version   | License file format version. `200` is the default compatible format. `201` emits the canonical format only when the target runtime is known to support v201. |
|target-license-format-max | Maximum license file format supported by the deployed target runtime. Defaults to `200`; pass `201` together with `--license-version=201` only for v201-capable runtimes. |
|extra-data        | Application specific signed data returned by `acquire_license` after a successful check. It must be 1-16 bytes by default, printable text, may contain interior spaces, and must not start/end with whitespace or contain control characters. |
|feature-names     | Comma separated list of features to license. See `multi-feature` discussion.               |

Date limits are signed and verified using the canonical `YYYY-MM-DD` license
format. The generator also accepts `YYYYMMDD` and `YYYY/MM/DD` as operator
input, but it normalizes them before signing. Runtime verification rejects
impossible dates, non-leap-year February 29, zero month/day, slash forms,
compact forms, trailing garbage, and padded values. Local date checks use the
host wall clock; a privileged local attacker who can change that clock can
bypass time limits unless the host application adds an external time authority.

`extra-data` is signed but not confidential. The runtime returns it through
`LicenseInfo.proprietary_data`, whose default payload capacity is 16 bytes plus
the terminating NUL. A signed license with empty, oversized, control-character,
or whitespace-padded `extra-data` fails with `LICENSE_MALFORMED` instead of
returning truncated application data.

## Strict v200 file format

By default, current releases issue strict legacy v200 licenses. The generated
spelling is:

```ini
[MY_PRODUCT]
lic_ver = 200
sig = ...
```

Do not add fields to a v200 license. Hardened runtimes reject unknown keys,
duplicate keys, duplicate requested sections, bad dates, bad version bounds,
non-canonical `lic_ver`, invalid or non-canonical base64 signatures, and
malformed hardware identifiers with `LICENSE_MALFORMED`.

For compatibility the reader accepts LF or CRLF line endings, full-line `;` and
`#` comments, case-insensitive product/feature section names, and these four
delimiter forms: `key=value`, `key= value`, `key =value`, and generated
`key = value`. Key names must be lowercase allowlisted v200 names and may not
have leading whitespace, tab spacing, or more than one space before `=`. Values
must not have leading or trailing whitespace after the optional delimiter space;
inline comments are treated as value text and can make the field malformed.

If an old hand-edited license no longer parses, regenerate it with the current
`lccgen license issue` command instead of editing the signed license file.

## Canonical v201 issuance

Use v201 only for applications built with a runtime that verifies
`lic_ver = 201` licenses:

```console
lccgen license issue \
  --project-folder /secure/licensecc-projects/MY_PRODUCT \
  --primary-key /secure/licensecc-projects/MY_PRODUCT/private_key.rsa \
  --output-file-name customer.lic \
  --license-version 201 \
  --target-license-format-max 201
```

Without `--target-license-format-max 201`, the generator refuses v201 issuance
so an issuance script cannot accidentally create licenses for older v200-only
runtimes. v201 licenses include signed `canonical-v`, `sig-v`, `sig-alg`, and
`key-id` metadata and verify through the canonical payload path.

Note:
<sup>1</sup> a project is a container for the customizations of licensecc. In special way its keys and build parameters. 
The name should reflect the name of the software you want to add a license to. The project name appears in the license file.
