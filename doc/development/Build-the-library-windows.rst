#######################################
Build - Windows
#######################################

Use Visual Studio 2022 with the Desktop development with C++ workload, CMake
3.21 or later, and the OpenSSL, Zlib, and Boost dependencies required by the
selected configuration. The platform is at **0.1.0-rc.1** (a prerelease): accepted source
and automated checks are not a published binary support matrix or a remote CI
attestation.

From the repository root, first check the vendored generator and then use the
maintained CMake preset:

.. code-block:: powershell

   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset dev-debug

.. code-block:: console

   cmake --preset dev-debug
   cmake --build --preset dev-debug
   ctest --preset dev-debug

Configure one project per build tree. Generated project material belongs under
``build/<preset>/projects/<project-name>`` or an explicit external
``LCC_PROJECTS_BASE_DIR``; do not create a ``projects`` directory in the source
checkout. See :doc:`Build-the-library` for the shared build-purity contract and
the root ``README.md`` for current prerequisites.
