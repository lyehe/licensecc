Native examples catalog
=======================

Every maintained directory below contains a standalone ``CMakeLists.txt`` and
source. Start with the minimal consumer, then move to the example that adds the
specific policy or platform boundary you need.

.. list-table:: Maintained native examples
   :header-rows: 1
   :widths: 19 35 29 17

   * - Directory
     - Use it to learn
     - Important boundary
     - Target
   * - `examples/minimal
       <https://github.com/lyehe/licensecc/tree/main/examples/minimal>`_
     - Acquire one explicit local license and report a useful failure.
     - First success; no online or feature policy.
     - ``minimal``
   * - `examples/fail_closed_host
       <https://github.com/lyehe/licensecc/tree/main/examples/fail_closed_host>`_
     - Keep base and optional capabilities disabled until their individual
       checks succeed.
     - Demonstrates strict source handling and feature-by-feature decisions.
     - ``fail_closed_host``
   * - `examples/anti_tamper_host
       <https://github.com/lyehe/licensecc/tree/main/examples/anti_tamper_host>`_
     - Add an application-owned integrity callback through
       ``acquire_license_ex``.
     - Best-effort signal only; it is not proof that a host is trustworthy.
     - ``anti_tamper_host``
   * - `examples/online_callback
       <https://github.com/lyehe/licensecc/tree/main/examples/online_callback>`_
     - Supply HTTPS transport and require a fresh server-signed assertion.
     - Fails over only on transport/5xx failures, never an entitlement denial.
     - ``online_callback``
   * - `examples/production_decision_host
       <https://github.com/lyehe/licensecc/tree/main/examples/production_decision_host>`_
     - Combine local verification, host integrity, online verification, backup
       endpoints, and a persisted revocation floor.
     - Production-shaped client policy; deployment remains separately owned.
     - ``production_decision_host``
   * - `examples/device_identity
       <https://github.com/lyehe/licensecc/tree/main/examples/device_identity>`_
     - Open or provision the Windows Platform KSP or Linux TPM2/OpenSSL device
       key configured in an installed package.
     - Provider-specific and conditional; it does not perform remote
       attestation or delete keys.
     - ``licensecc_windows_tpm`` or ``licensecc_tpm2_openssl``

Build models
------------

All examples in this catalog are configured as standalone consumers of an
installed Licensecc package; none is enabled by a repository-root examples
switch. Their READMEs derive the exact
``find_package`` component, conditional dependencies, configure/build
commands, executable path, and run arguments from the example's
``CMakeLists.txt``.

The copyable commands assume the Licensecc repository root as the working
directory. Each README labels the shell explicitly (Bash on Linux and
PowerShell 7 with Visual Studio 2022 x64 on Windows/MSVC), points
``CMAKE_PREFIX_PATH`` and ``licensecc_DIR`` at the matching install layout,
and uses an explicit platform executable path. A successful run states its
observable output and exit status; online and hardware-provider examples also
describe the verifier or device prerequisites that must be satisfied.

For the complete issue-and-run sequence, use
:doc:`../tutorials/offline-first-license`. For public C/C++ declarations, use
:doc:`../api/index`; for platform availability and limitations, use the
:doc:`../capabilities/index`.

To validate the offline install, issuance, and installed-consumer path from
the repository root, run the dedicated local gate
``npm run test:docs-quickstart``. It is intentionally separate from the
documentation link/structure checks because it builds native code and does
not contact an online verifier.
