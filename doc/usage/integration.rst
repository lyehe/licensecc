#########################################
Integrate Licensecc in your application
#########################################

Audience and result
*******************

This guide is for a C or C++ application owner who has already completed
:doc:`../tutorials/offline-first-license`. The result is an application target
linked to the installed ``licensecc::licensecc_static`` target for one named
license project.

The installed runtime contains the public key for that project. The issuing
private key stays outside the application and release artifact.

Build and install a project component
*************************************

Starting directory: the Licensecc repository root. Shell: any shell with CMake
and the native toolchain available.

Choose a stable project name for the product. The example below uses
``my-product`` and writes generated material only below ``build/my-product``:

.. code-block:: console

   cmake -S . -B build/my-product -DLCC_PROJECT_NAME=my-product -DCMAKE_INSTALL_PREFIX=build/my-product/install
   cmake --build build/my-product --target install --config Release

``LCC_PROJECT_NAME`` selects the generated key pair, configuration, and
installed component. Use the same value when issuing a license and configuring
the consumer. The generated project is:

.. code-block:: text

   build/my-product/projects/my-product/
   |-- include/licensecc/my-product/
   |-- licenses/
   `-- private_key.rsa

The ``licenses`` directory is created when the first license is written. Keep
``private_key.rsa`` out of the consumer, installers, logs, and source control.

Locate and link the installed package
*************************************

In the application's ``CMakeLists.txt``, require the selected component and
link its imported target:

.. code-block:: cmake

   set(LCC_PROJECT_NAME "my-product" CACHE STRING "Licensecc project component")
   find_package(licensecc CONFIG REQUIRED COMPONENTS "${LCC_PROJECT_NAME}")

   add_executable(my_application main.cpp)
   target_link_libraries(my_application PRIVATE licensecc::licensecc_static)

Configure the application with the install prefix and the directory containing
``licensecc-config.cmake``. From the Licensecc repository root, the Windows
layout is:

.. code-block:: powershell

   $repo = (Resolve-Path ".").Path
   cmake -S path/to/application -B build/my-application `
     "-DCMAKE_PREFIX_PATH=$repo/build/my-product/install" `
     "-Dlicensecc_DIR=$repo/build/my-product/install/cmake/licensecc" `
     -DLCC_PROJECT_NAME=my-product
   cmake --build build/my-application --config Release

The Linux layout differs only in the package-config directory:

.. code-block:: bash

   repo="$PWD"
   cmake -S path/to/application -B build/my-application \
     -DCMAKE_PREFIX_PATH="$repo/build/my-product/install" \
     -Dlicensecc_DIR="$repo/build/my-product/install/lib/cmake/licensecc" \
     -DLCC_PROJECT_NAME=my-product
   cmake --build build/my-application

Passing ``licensecc_DIR`` explicitly is intentional: it makes the different
Windows and Linux install layouts unambiguous.

Call the public API
*******************

The minimal consumer is kept executable as source instead of being copied into
this guide:

.. literalinclude:: ../../examples/minimal/main.cpp
   :language: cpp
   :caption: examples/minimal/main.cpp

It passes an explicit license path to ``acquire_license()``, enables protected
behavior only when the result is ``LICENSE_OK``, and reports failures with
``lcc_strerror()`` and ``print_error()``. Use
:ref:`api/public_api:Public api` for the stable declarations and return values.

Issue and test a license
************************

Use :doc:`issue-licenses` for validity dates, features, application-version
ranges, and machine binding. For a complete exact issue-and-run sequence, use
:doc:`../tutorials/offline-first-license` and substitute your project name,
install prefix, application source, and executable paths.

Do not make a successful build the authorization signal. Protected behavior
must remain unavailable until the runtime returns ``LICENSE_OK`` for the exact
product feature being used. :doc:`examples` routes to the fail-closed host and
the production-shaped online decision example.

Verification
************

For an integration-only change, build and run the application against a clean
install tree. For a Licensecc core or packaging change, also run from the
repository root:

.. code-block:: powershell

   pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug

Documentation changes require ``npm run check:docs``.
