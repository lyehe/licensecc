Release Artifact Profiles
=========================

licensecc has two release artifact profiles:

Runtime/customer package
------------------------

The runtime package is the only profile intended for customer application
integration. It contains:

- ``include/licensecc`` public headers.
- ``include/licensecc/<project>/licensecc_properties.h``.
- ``include/licensecc/<project>/public_key.h``.
- ``lib/licensecc/<project>/licensecc_static``.
- ``lib/licensecc/<project>/cmake`` target exports.
- ``lib/cmake/licensecc`` package configuration files.
- ``share/licensecc/<project>/release-manifest.cmake``.

CPack names runtime artifacts with the package name, version, ``runtime``
profile, project name, build configuration, compiler/runtime ABI tag, and
platform. The release manifest records the package name, package version,
profile, project name, project magic, build configuration, platform,
generator, compiler ID/version/architecture, runtime linkage, ABI tag, and
SHA256 hashes for the installed ``public_key.h`` and
``licensecc_properties.h`` files.

Customer applications consume this profile through ``find_package(licensecc
REQUIRED COMPONENTS <project>)`` or ``-DLCC_PROJECT_NAME=<project>`` and link
``licensecc::licensecc_static``. The installed target carries the required
include paths and platform libraries; application build files should not copy
private build-tree include paths or archive paths.

Boost is a build and test dependency for this repository and for issuer-side
tools. It is not a runtime dependency of the final ``licensecc`` library.
Linux runtime builds require OpenSSL for signature verification. Windows
runtime builds use system cryptography libraries and do not require shipping
OpenSSL with the customer application.

It must not contain issuer-side material or tools:

- ``private_key.rsa`` or other private-key files.
- Generated project private folders.
- ``lccgen``.
- ``lccinspector`` unless a separate support-tooling package explicitly allows
  it.
- Test keys or generated local staging directories.

The license file itself is integrity-protected, not confidential. Do not place
secrets in license fields or ``extra-data``; assume customers can read the
license payload even when they cannot forge it.

``LCC_PROJECT_MAGIC_NUM`` is a product/build discriminator used by the host
application and runtime library. It is not a secret and must not be treated as
an anti-tamper mechanism. It helps catch wrong-project linkage and simple
runtime swaps, but entitlement still depends on signature verification and
fail-closed host code.

Developer/tooling package
-------------------------

The tooling profile is opt-in with ``-DLCC_INSTALL_TOOLS=ON``. It may contain
the runtime files plus issuer/support tools such as ``lccgen`` and
``lccinspector``. Do not ship this profile to customers as the normal runtime
package.

The normal release CI validates the runtime/customer package profile. Support
tooling packages that include ``lccinspector`` are not CI-validated release
artifacts unless a separate tooling-profile pipeline explicitly enables
``LCC_BUILD_INSPECTOR``/``LCC_INSTALL_TOOLS`` and runs the inspector redaction
gate.

CPack names tooling artifacts with the ``tools`` profile, selected project
name, build configuration, compiler/runtime ABI tag, and platform. The tooling
profile still writes a release manifest so release automation can distinguish
a deliberately built support artifact from a runtime/customer package that
accidentally picked up issuer tools.

Private signing keys belong only in the issuing environment. Store project
directories containing ``private_key.rsa`` with restricted filesystem access,
backups, and audit logging appropriate for your release process. Losing the
private key prevents issuing compatible licenses; disclosing it lets an
attacker issue licenses that current runtimes trust.

Source package
--------------

Source archives use the explicit ``source`` profile in their filename. They do
not use the runtime or tools profile name, and they are scanned after
extraction before release.

Local client-side licensing is tamper-resistant, not tamper-proof. An attacker
who can patch the application binary or replace linked libraries can bypass
local checks. Use server-side entitlement checks, online activation, or other
defense layers for high-value enforcement.

Validation gates
----------------

Release validation must install the runtime profile to a staging prefix, scan
the staged files, build an external consumer with only
``find_package(licensecc REQUIRED)``, create a runtime package, extract it, scan
the extracted payload, and build/run the same external consumer from the
extracted package prefix.

Release-like configurations reject local placeholder project names such as
``DEFAULT``, ``test``, ``demo``, ``example``, ``sample``, ``magic_smoke``, and
``tools_smoke`` unless a maintainer explicitly opts out for local development.
Binary package creation applies the same release-artifact policy even for
Debug packages, so a local Debug build cannot accidentally create a
customer-looking package for ``DEFAULT`` or for a project with missing signing
keys. Source packages are separate and do not contain project keys or runtime
identity. Release artifacts require the selected project public key and
private key to exist before packaging, so release packaging does not silently
create a new signing identity. CI uses a product-like smoke project name and
prepares its smoke key base in a non-release key-generation build before
Release packaging exercises the same guard that product builds use.

The artifact scanner fails the runtime profile if it finds private-key-like
file names, private-key PEM markers in file contents, generated project
folders, tooling executables, unexpected paths outside the runtime allowlist,
or artifacts for a different project name. Tooling packages must be scanned
with an explicit tools/support profile choice; known tool executables are
allowed only when that opt-in is present.

Source archives are validated separately after extraction. The source scanner
rejects VCS metadata, local build or staging directories, key-like filenames
and extensions such as SSH key names, PKCS/DER/JWK/secret files, files with
``signing`` in the name, generated project folders, symlinks, and private-key
PEM markers including encrypted private-key headers in file contents.

CI should print the sanitized release manifest summary for each installed
release artifact. The summary includes package, profile, project, build,
platform, compiler/runtime ABI, public-key path and checksum, and
generated-properties path and checksum. Manifest readers parse only a strict
data subset of ``set(KEY "VALUE")`` records and reject unsupported syntax,
unexpected keys, duplicate keys, list separators, private-key-like paths, and
PEM private-key material instead of executing extracted manifest content with
``include()``.
