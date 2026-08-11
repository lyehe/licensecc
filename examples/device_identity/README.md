# Device identity provider examples

This page documents the conditional Windows and Ubuntu provider examples.

## Windows TPM device identity example

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
canonical public SPKI; it does not delete keys. The package requires OpenSSL
3.x and a distro `tpm2-openssl` provider. This is not an FIPS certification
claim: configure and validate the provider separately if your deployment has
FIPS requirements.

On Ubuntu, enable the `universe` repository. Runtime needs OpenSSL 3,
`tpm2-openssl`, a usable pre-start TCTI, and `/proc/self/fd` (the provider uses
it for descriptor-relative STORE loading and inode-bound cleanup). `tpm2-tools`
and `swtpm` are diagnostic/CI-only packages; the library does not invoke either
at runtime. For a hardware TCTI, the service account needs access to
`/dev/tpmrm0` (or the explicitly selected TPM device). Set
`TPM2OPENSSL_TCTI` and, when the TPM hierarchy requires it,
`TPM2OPENSSL_PARENT_AUTH` in the service/process environment before starting
the application; configure `tpm2-abrmd` and its TCTI there as well when a
resource manager is needed. The library itself does not read those variables,
log their values, or mutate global OpenSSL state.

The provider uses a local filesystem directory with a persistent `flock`
namespace lock, descriptor-relative no-follow checks, `renameat2`
no-replace (with the constrained hard-link fallback), and directory `fsync`
for publication and rollback. Do not place the directory on NFS, FUSE, or a
shared/network volume; their rename, locking, ownership, or durability
semantics are not supported. The directory must remain private to the
effective user and its ancestors must not be group/world writable.

TPM resource pressure can make an operation busy while the TPM or an optional
user-space resource manager is retrying or has constrained session/object
memory. TPM operations are intentionally slower and more failure-prone than
software-key operations, especially under constrained TPM or resource-manager
memory. Applications should apply bounded retry/backoff at their operation
boundary and avoid assuming that a transient resource failure means the key
is gone.

The `.tss2.pem` file is a machine-specific recovery reference for the same TPM,
not a raw private key and not a guaranteed backup. Protect it with the same
filesystem controls, and retain it only according to the deployment's
recovery policy. Expected-id namespace deletion removes the reference file and
is not cryptographic erasure of TPM-resident state; follow the TPM/platform
provisioning policy for lifecycle destruction.

The simulator runner is intentionally separate from hardware validation. An
operator may opt into the production test with
`LCC_RUN_REAL_TPM2_TESTS=1 TPM2OPENSSL_TCTI=<preconfigured-tcti>` and an
existing effective-user `0700` storage directory; ordinary CI uses an isolated
`swtpm` instance instead.

For a configured build, the real CTest entry is opt-in and uses its build-local
`test/library/device_identity/tpm2-real-keyrefs` directory:

```bash
LCC_RUN_REAL_TPM2_TESTS=1 TPM2OPENSSL_TCTI=device:/dev/tpmrm0 \
  ctest --test-dir build/ci-linux-debug-tpm2 -R device_identity_tpm2_openssl_real
```
