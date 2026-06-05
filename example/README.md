# Licensecc Workflow Example

This standalone example demonstrates the supported application workflow:

- consume an installed Licensecc project package with `find_package`;
- check the base product and optional features with `acquire_license()`;
- pass caller version metadata for version-bound licenses;
- display signed `extra-data` only after `LICENSE_OK`;
- fail closed for every non-`LICENSE_OK` result;
- optionally print a hardware identifier for license enrollment or support.

It is intentionally separate from the main build. Build it the same way a real
application should consume Licensecc: from an installed package.

## 1. Build and Install Licensecc

From the repository root:

```console
cmake -S . -B build-demo-licensecc ^
  -G "Visual Studio 17 2022" -A x64 ^
  -DLCC_PROJECT_NAME=DEMO_PRODUCT ^
  -DLCC_PROJECTS_BASE_DIR=C:/secure/licensecc-projects ^
  -DCMAKE_INSTALL_PREFIX=C:/licensecc/DEMO_PRODUCT
cmake --build build-demo-licensecc --target install --config Release
```

On Linux, use the same variables without the Visual Studio generator:

```console
cmake -S . -B build-demo-licensecc \
  -DCMAKE_BUILD_TYPE=Release \
  -DLCC_PROJECT_NAME=DEMO_PRODUCT \
  -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects \
  -DCMAKE_INSTALL_PREFIX=/opt/licensecc/DEMO_PRODUCT
cmake --build build-demo-licensecc --target install -j
```

The runtime package contains the public verification key. The private
`private_key.rsa` remains under the issuer-controlled project folder and is
used only by `lccgen`.

## 2. Build This Example

```console
cmake -S example -B build-workflow-example ^
  -DCMAKE_PREFIX_PATH=C:/licensecc/DEMO_PRODUCT ^
  -DLCC_PROJECT_NAME=DEMO_PRODUCT
cmake --build build-workflow-example --config Release
```

Linux:

```console
cmake -S example -B build-workflow-example \
  -DCMAKE_PREFIX_PATH=/opt/licensecc/DEMO_PRODUCT \
  -DLCC_PROJECT_NAME=DEMO_PRODUCT
cmake --build build-workflow-example -j
```

## 3. Issue a License

Create a license for the base product plus two optional features. Include the
project name in `--feature-names` when you want the same license file to satisfy
the default base-product check and separate feature checks:

```console
lccgen license issue ^
  --project-folder C:/secure/licensecc-projects/DEMO_PRODUCT ^
  --primary-key C:/secure/licensecc-projects/DEMO_PRODUCT/private_key.rsa ^
  --output-file-name C:/secure/licensecc-projects/DEMO_PRODUCT/licenses/customer.lic ^
  --feature-names DEMO_PRODUCT,REPORTS,EXPORT ^
  --valid-from 2026-01-01 ^
  --valid-to 2035-12-31 ^
  --start-version 1.0 ^
  --end-version 2.0 ^
  --extra-data tier-pro
```

For v201-capable runtimes, add the explicit compatibility gate:

```console
  --license-version 201 --target-license-format-max 201
```

## 4. Run the Workflow

```console
build-workflow-example/Release/licensecc_workflow.exe ^
  --license C:/secure/licensecc-projects/DEMO_PRODUCT/licenses/customer.lic ^
  --version 1.2.3 ^
  --feature REPORTS ^
  --feature EXPORT
```

Expected behavior:

- with a valid license, the base product and requested features print
  `granted`;
- with a missing, malformed, corrupted, expired, wrong-version, or wrong-feature
  license, the example exits nonzero and prints diagnostics;
- `extra-data` is printed only after the base product check succeeds;
- optional feature failures do not grant those features.

To print the local hardware identifier for enrollment or support:

```console
licensecc_workflow --print-id
```

Do not log raw hardware identifiers by default in production applications. Ask
the customer before collecting them and transmit them through a trusted support
channel.

## Options

```text
--license PATH                 Use an explicit license file path.
--plain-license-data TEXT      Pass raw license text through LicenseLocation.
--encoded-license-data TEXT    Pass base64 license text through LicenseLocation.
--version VERSION              Caller version for start/end-version checks.
--feature NAME                 Check an optional feature. Repeatable.
--print-id                     Print a support hardware identifier.
--allow-env                    Enable LICENSE_LOCATION/LICENSE_DATA lookup.
--lenient-sources              Do not make malformed higher-priority sources fatal.
```
