#########################################
Integrate Licensecc in your application
#########################################

This short guide explains how to integrate `licensecc` in your application.

Working examples are provided in the `examples <https://github.com/open-license-manager/examples>`_ project. 

Project identity and keys
*************************

Build one Licensecc project per licensed product or product family. The
project name is part of the generated project metadata, the installed runtime
package, and the product or feature section names that the runtime requests.
The automatically-created ``DEFAULT`` project is suitable for local tests, but
it is not suitable for release builds because every default build would share
the same visible product identity.

Use a non-default ``LCC_PROJECT_NAME`` and keep ``LCC_PROJECTS_BASE_DIR`` in an
issuer-controlled location outside the source tree:

.. code-block:: console

  cmake -S licensecc -B build-licensecc \
    -DLCC_PROJECT_NAME=MY_PRODUCT \
    -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects \
    -DCMAKE_INSTALL_PREFIX=/opt/licensecc/MY_PRODUCT

Project initialization writes the issuer private key to
``/secure/licensecc-projects/MY_PRODUCT/private_key.rsa`` and writes the public
verification key to
``/secure/licensecc-projects/MY_PRODUCT/include/licensecc/MY_PRODUCT/public_key.h``.
The public key is compiled into ``licensecc::licensecc_static``. The private key
is used only by ``lccgen`` when issuing licenses and must not be installed or
shipped with the customer runtime package.

Keep the same project identity through the whole flow:

* configure Licensecc with ``-DLCC_PROJECT_NAME=MY_PRODUCT``;
* consume the installed package with ``find_package(... COMPONENTS MY_PRODUCT)``
  or ``-DLCC_PROJECT_NAME=MY_PRODUCT``;
* issue licenses from the same project folder, for example
  ``lccgen license issue --project-folder /secure/licensecc-projects/MY_PRODUCT``;
* request the default product section by leaving ``CallerInformations`` empty,
  or request a specific licensed feature through
  ``CallerInformations.feature_name``.

Build, install, and link Licensecc
**********************************

We strongly recommend CMake as the build system. Build and install Licensecc
for the project key you want to embed, then point your application configure
step at that install prefix with ``CMAKE_PREFIX_PATH``.

The supported production integration mode is the installed CMake package and
the imported ``licensecc::licensecc_static`` target. Direct source-tree include
paths, hand-written library paths, ``add_subdirectory`` embedding, MSBuild-only
projects, Bazel, and raw Makefile consumption are not production interfaces
unless you add and run dedicated smoke tests that prove the generated project
header selection, compile definitions, platform libraries, and package identity
checks for that mode.

For example, configure and install Licensecc with an issuer-controlled project
directory and a non-default project name:

.. code-block:: console

  cmake -S licensecc -B build-licensecc -DLCC_PROJECT_NAME=MY_PRODUCT -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects
  cmake --build build-licensecc --config Release
  cmake --install build-licensecc --config Release --prefix /opt/licensecc/MY_PRODUCT

The installed package currently exposes the static runtime library target
``licensecc::licensecc_static``. There is no supported shared-library target in
the installed package; add and test a shared target before documenting or
shipping shared-library consumption.

Then consume the installed package from your application:

.. code-block:: cmake

  find_package(licensecc 2.1.0 REQUIRED COMPONENTS MY_PRODUCT)
  target_link_libraries(my_app PRIVATE licensecc::licensecc_static)

The package also accepts ``-DLCC_PROJECT_NAME=MY_PRODUCT`` at consumer
configure time when no component is passed to ``find_package``. The component
form is preferred because the selected project is visible at the call site.
Do not copy private include paths or static-library paths into your application
manually; the imported target carries the required public include directories,
the project-scoped generated-properties header selection, and platform
libraries.

Consumer language mode
**********************

The installed public headers and examples are tested with C++11. Newer C++
standards are fine, but consumers do not need C++17 just to call
``acquire_license()``, ``identify_pc()``, ``print_error()``, or
``lcc_strerror()`` through the installed CMake target.

The exported functions use C linkage, but the distributed target is a C++
static library. Pure C hosts should link through a build rule that uses the C++
linker or a project-owned C wrapper, and should add their own installed-prefix
smoke test for that integration mode.

The installed runtime package is project-specific because it contains the
public key for one Licensecc project. Do not ship ``private_key.rsa``,
``lccgen``, or ``lccinspector`` with your customer application unless you are
building a separate issuer/tooling package.

If a host shows an ``identify_pc()`` value to help a customer request a
hardware-bound license, treat that value as support-sensitive data. It may
contain device, network, disk, host, tenant, or personal information. Do not
write raw identifiers to normal application logs or telemetry, and redact them
from support bundles unless the customer explicitly agrees to provide raw
values through a trusted support channel. The ``lccinspector`` support tool
redacts hardware identifiers by default; its raw diagnostic mode is an
intentional support opt-in.

License data compatibility
**************************

Current runtimes accept strict legacy ``lic_ver = 200`` licenses and canonical
``lic_ver = 201`` licenses. The generator still defaults to v200 for migration
compatibility. Issue v201 only for deployed runtimes that are known to support
it by passing both ``--license-version=201`` and
``--target-license-format-max=201``. Older v200-only runtimes reject v201
license files as malformed or unsupported. v200 compatibility is intentionally
strict: unknown keys, duplicate keys, duplicate requested sections,
non-canonical ``lic_ver``, invalid base64 ``sig`` values, malformed dates,
malformed version bounds, and malformed hardware identifiers fail with
``LICENSE_MALFORMED``.

The v200 reader accepts LF or CRLF line endings, full-line ``;`` and ``#``
comments, and case-insensitive project or feature section names. For delimiter
spacing it accepts ``key=value``, ``key= value``, ``key =value``, and generated
``key = value``. Key names must still be lowercase allowlisted v200 names with
no leading whitespace, no tab spacing, and at most one ASCII space before
``=``. Values must not contain leading or trailing whitespace after the
optional delimiter space; inline comments are parsed as value text.

Raw license data containing embedded NUL bytes is malformed. v201 canonical
payload values are printable ASCII only, not UTF-8 or arbitrary binary text:
control bytes, DEL, and high-bit bytes are rejected by the generator and
runtime before signing or verification.

For v201 hardware-bound licenses, the generator signs
``client-signature-source-strength`` next to ``client-signature``. The runtime
rejects missing or inconsistent source-strength metadata. Weak disk-label
or mutable-disk fallback requires ``--allow-weak-disk-label-binding`` during
issuance and a project runtime built with
``LCC_ALLOW_WEAK_DISK_LABEL_BINDING``.

A malformed requested section fails with ``LICENSE_MALFORMED``. A missing
requested section fails with ``PRODUCT_NOT_LICENSED``. A malformed unrelated
section is ignored until that section is requested and never grants access to
another feature.

The installed package uses the following CMake variables.
 
==================== ====================
Cmake variable        Description
==================== ====================
LCC_PROJECT_NAME     | Name of the installed project to load when no component
                     | is passed to ``find_package``. Prefer the component form
                     | for release builds.
==================== ====================



Call Licensecc from your code
*******************************
Include ``licensecc/licensecc.h`` from your application. Consumers should not
include generated project headers directly; use the installed CMake target so
the correct project-scoped generated-properties header is selected through the
target compile definitions. Functions in ``licensecc.h`` are considered stable.

Refer to :ref:`public api <api/public_api:Public api>` to understand how to generate an hardware identifier or validate a license.

Fail-closed license checks
==========================

Only ``LICENSE_OK`` grants access. Treat every other return value from
``acquire_license()`` as not licensed, then use ``print_error()`` or
``lcc_strerror()`` only for diagnostics:

.. code-block:: c

  CallerInformations caller;
  lcc_init_caller_informations(&caller);
  if (!lcc_set_caller_feature_name(&caller, "MY_FEATURE") ||
      !lcc_set_caller_version(&caller, "1.2.3")) {
      deny_access("caller metadata is too long");
      return;
  }

  LicenseInfo info;
  lcc_init_license_info(&info);
  LCC_EVENT_TYPE result = acquire_license(&caller, NULL, &info);
  if (result != LICENSE_OK) {
      char message[LCC_API_ERROR_BUFFER_SIZE];
      print_error(message, &info);
      deny_access(message);
      return;
  }

  grant_access();

The ``examples/fail_closed_host`` project shows the same policy in a small
host application: protected features start disabled, the base product is
checked before optional features, and each optional feature remains unavailable
unless its own license check returns ``LICENSE_OK``. It disables environment
license sources and enables strict source-fatal handling during startup so a
malformed higher-priority license source cannot be hidden by a later valid
explicit license path.

Runtime policy toggles such as
``lcc_set_environment_license_sources_enabled(false)`` and
``lcc_set_strict_source_fatal_enabled(true)`` are process-global. Their storage
is atomic, but production applications should still configure them once during
single-threaded startup before worker threads begin license checks.

Use ``CallerInformations.feature_name`` when a product has multiple licensed
capabilities. Use ``CallerInformations.version`` when a license contains
``start-version`` or ``end-version``. Missing, malformed, below-range, or
above-range caller versions fail closed with ``PRODUCT_NOT_LICENSED``.

Runtime anti-tamper rollout
===========================

Use ``acquire_license_ex()`` when a host wants runtime tamper diagnostics in
addition to license verification. Initialize options for every call:

.. code-block:: c

  LicenseCheckOptions options;
  lcc_init_license_check_options(&options);
  options.host_integrity_check = my_integrity_check;
  options.host_integrity_user_data = my_state;
  options.tamper_flags = LCC_TAMPER_FLAG_STRICT_SOURCE_SHADOWING;

  LicenseInfo info;
  lcc_init_license_info(&info);
  LCC_EVENT_TYPE result = acquire_license_ex(&caller, &location, &info, &options);

``lcc_init_license_check_options()`` defaults to ``LCC_TAMPER_AUDIT``. Audit
mode is the recommended rollout mode: a valid license still returns
``LICENSE_OK`` while tamper signals are visible as warning audit events through
``print_error()`` or ``LicenseInfo.status``.

After host-specific false-positive testing, set
``options.tamper_policy = LCC_TAMPER_ENFORCE`` to fail closed on the same
signals. Enforcement returns ``LICENSE_TAMPER_DETECTED`` only after the license
would otherwise have returned ``LICENSE_OK``; ordinary license failures keep
their original result.

The host callback owns product-specific policy such as binary signing checks,
self-hash checks, debugger policy, monotonic-clock strategy, or platform
hardening probes. Licensecc core intentionally avoids generic debugger, VM,
process-list, module-injection, and self-hash checks because those are
deployment-specific and can have high false-positive rates.

Project magic
=============

``LCC_PROJECT_MAGIC_NUM`` is an optional build-time guard that binds a host
application to the Licensecc runtime it was configured to use. It is not a
secret and it does not replace signature verification, but it helps catch
accidental linkage to the wrong project build and raises the bar for simple
library swaps.

The default magic value is ``0``. Use a nonzero value for release builds when
you control both the Licensecc build and the host application build:

.. code-block:: console

  cmake -S licensecc -B build-licensecc \
    -DLCC_PROJECT_NAME=MY_PRODUCT \
    -DLCC_PROJECT_MAGIC_NUM=123456

The generated ``licensecc_properties.h`` exposes the configured value as
``LCC_PROJECT_MAGIC_NUM``. Populate ``CallerInformations.magic`` with that
constant before checking a license:

.. code-block:: c

  CallerInformations caller = {};
  caller.magic = LCC_PROJECT_MAGIC_NUM;

  LicenseInfo info = {};
  LCC_EVENT_TYPE result = acquire_license(&caller, NULL, &info);

If the host passes the wrong magic value, verification fails closed with
``LICENSE_CORRUPTED``. Keep the value in one build-system variable or generated
host header; avoid copying independent numeric literals into application code.

``confirm_license()`` and ``release_license()`` are placeholders for future
network-license workflows. They are not entitlement APIs and must not be used
for authorization decisions; use ``acquire_license()``.
