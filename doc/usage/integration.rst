#########################################
Integrate Licensecc in your application
#########################################

This short guide explains how to integrate `licensecc` in your application.

A working, standalone example is provided in ``examples/minimal`` in this
repository — its README walks through the exact commands.

Build System - locate and link the licensecc
*********************************************

We strongly recommend CMake. The supported flow is: build **and install**
licensecc for your project name, then locate it with ``find_package``.

1. Build and install licensecc (see the repository ``README.md`` for
   prerequisites):

.. code-block:: console

  cmake -S <licensecc> -B lcc-build -DLCC_PROJECT_NAME=myproject -DCMAKE_INSTALL_PREFIX=<prefix>
  cmake --build lcc-build --target install

2. In your application's ``CMakeLists.txt``:

.. code-block:: console

  find_package(licensecc REQUIRED)

and configure your project with ``-DCMAKE_PREFIX_PATH=<prefix>`` and the same
``-DLCC_PROJECT_NAME=myproject``. This makes the imported target
``licensecc::licensecc_static`` available for linking.

.. NOTE::
  ``LCC_PROJECT_NAME`` selects the license *project* (key pair + generated
  ``licensecc_properties.h``) the library was built for. It must match between
  the licensecc build and your application, or ``find_package`` will not find
  the project component. Alternatively, pass it as a component:
  ``find_package(licensecc REQUIRED COMPONENTS myproject)``.

Call Licensecc from your code
*******************************
The file containing the public api is ``include/licensecc/licensecc.h``. Functions in there are considered stable.

Refer to :ref:`public api <api/public_api:Public api>` to understand how to generate a hardware identifier or validate a license.
