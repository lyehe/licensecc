# Windows TPM device identity example

This example opens the application-scoped P-256 key in the Microsoft Platform
Crypto Provider and prints its public metadata. The provider is reported
hardware; possession is not remote TPM attestation.

Build it against an installed Licensecc package that was configured with
`LCC_ENABLE_WINDOWS_TPM=ON`:

```powershell
cmake -S examples/device_identity -B build/device-identity-example `
  -DCMAKE_PREFIX_PATH=build/ci-windows-msvc-debug-dynamic-tpm/install `
  -DLCC_PROJECT_NAME=test
cmake --build build/device-identity-example --config Debug
```

Open an existing user-scoped key without creating anything:

```powershell
build/device-identity-example/Debug/licensecc_windows_tpm.exe com.example.product DEFAULT
```

Add `--create` only during explicit provisioning. Add `--machine` for a
machine-scoped key. Creation is silent, signing-only, and non-exportable; it
keeps the Platform KSP's default security descriptor and does not broaden the
key DACL. A custom service identity must be authorized by an
administrator-owned provisioning/ACL step, or use user scope under that
identity. Do not create or set key properties inside a Windows service
`StartService` callback—provision beforehand or initialize from normal worker
execution.

The example deliberately does not delete keys. Local deletion is irreversible
for bindings that depend on the key and should be a separate, explicit workflow
using the exact expected device-key id.

## Ubuntu TPM2/OpenSSL provider

The same installed example builds as `licensecc_tpm2_openssl` when the package
was configured with `LCC_ENABLE_TPM2_OPENSSL=ON` on Linux. The storage directory
must already exist, be owned by the effective user, and have mode `0700`:

```bash
cmake -S examples/device_identity -B build/device-identity-tpm2 \
  -DCMAKE_PREFIX_PATH=build/ci-linux-debug-tpm2/install \
  -DLCC_PROJECT_NAME=test
cmake --build build/device-identity-tpm2
build/device-identity-tpm2/licensecc_tpm2_openssl \
  com.example.product DEFAULT /var/lib/licensecc --create
```

The TPM2/OpenSSL provider signs the fixed 32-byte device-identity digest with
the distro `tpm2` provider. The example reports provider metadata and the
canonical public SPKI; it does not delete keys.
