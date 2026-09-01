.. _tutorial-offline-first-license:

Verify your first offline license
=================================

Audience and result
-------------------

This tutorial is for a C or C++ integrator evaluating Licensecc locally. You
will build and install the runtime for a sample license project, issue a signed
``.lic`` file, build the standalone minimal consumer, and see it print
``license OK``. Nothing in this tutorial contacts or deploys an online service.

Prerequisites
-------------

You need Git, CMake 3.21 or newer, a C++17 compiler, and the Boost development
libraries used by the bundled generator. Linux also needs OpenSSL development
headers and Zlib where required by the installed OpenSSL version. On Windows,
the copyable sequence below uses Visual Studio 2022 x64; other supported
toolchains produce different generator-specific executable paths. Set
``BOOST_ROOT`` if Boost is not in a default CMake search path.

Node, Python, Java, Doxygen, Cloudflare credentials, and PowerShell are not
requirements for the product itself. The Windows command sequence below uses
PowerShell only to make its paths unambiguous.

Clone the repository
--------------------

Starting directory: the parent directory where you keep source checkouts.
Shell: any shell with Git and CMake available.

.. code-block:: console

   git clone https://github.com/lyehe/licensecc.git
   cd licensecc

The ``dev-debug`` preset fixes the sample project name to ``test`` and writes
everything below ``build/dev-debug``. During configuration, CMake reports:

.. code-block:: text

   Project name        : test
   Project base dir    : .../build/dev-debug/projects/test

That project directory contains ``private_key.rsa`` and the generated public
headers. The private key is the authority that can issue licenses accepted by
this build.

Issue and verify on Windows
---------------------------

Starting directory: the Licensecc repository root.
Shell: PowerShell.

.. code-block:: powershell

   $repo = (Resolve-Path ".").Path
   $project = "$repo/build/dev-debug/projects/test"
   $lccgen = "$repo/build/dev-debug/extern/license-generator/src/license_generator/Debug/lccgen.exe"

   cmake --preset dev-debug -G "Visual Studio 17 2022" -A x64
   cmake --build --preset dev-debug --target install
   & $lccgen license issue -p $project -o "$project/licenses/quickstart.lic"
   cmake -S examples/minimal -B build/minimal -G "Visual Studio 17 2022" -A x64 `
     "-DCMAKE_PREFIX_PATH=$repo/build/dev-debug/install" `
     "-Dlicensecc_DIR=$repo/build/dev-debug/install/cmake/licensecc" `
     -DLCC_PROJECT_NAME=test
   cmake --build build/minimal --config Debug
   & "$repo/build/minimal/Debug/minimal.exe" "$project/licenses/quickstart.lic"

The issuer prints ``License written``. The final command prints:

.. code-block:: text

   license OK (days left: ...)

Issue and verify on Linux
-------------------------

Starting directory: the Licensecc repository root.
Shell: Bash.

.. code-block:: bash

   repo="$PWD"
   project="$repo/build/dev-debug/projects/test"
   lccgen="$repo/build/dev-debug/extern/license-generator/src/license_generator/lccgen"

   cmake --preset dev-debug
   cmake --build --preset dev-debug --target install
   "$lccgen" license issue -p "$project" -o "$project/licenses/quickstart.lic"
   cmake -S examples/minimal -B build/minimal \
     -DCMAKE_PREFIX_PATH="$repo/build/dev-debug/install" \
     -Dlicensecc_DIR="$repo/build/dev-debug/install/lib/cmake/licensecc" \
     -DLCC_PROJECT_NAME=test
   cmake --build build/minimal
   "$repo/build/minimal/minimal" "$project/licenses/quickstart.lic"

The expected issuer and consumer output is the same as on Windows.

Why the project name must match
-------------------------------

``LCC_PROJECT_NAME`` selects a generated key pair and public-key header. The
runtime, installed CMake component, consumer, and issuer must all use the same
name. A license produced by a different project's private key is not valid for
this runtime.

On Windows the installed package config is below ``cmake/licensecc``; on Linux
it is below ``lib/cmake/licensecc``. The explicit ``licensecc_DIR`` above is
intentional and avoids relying on platform-dependent package-search heuristics.

Troubleshooting and next steps
------------------------------

* If CMake cannot locate Licensecc, confirm that the install command completed
  and that ``licensecc_DIR`` names the directory containing
  ``licensecc-config.cmake``.
* If the executable reports ``license check failed``, confirm the license path
  and the ``test`` project name before changing search behavior.
* Never copy ``private_key.rsa`` into the consumer, an installer, or a release
  artifact. Back it up and restrict access according to your signing policy.
* Use :doc:`../usage/integration` to replace the sample with your application,
  :doc:`../usage/issue-licenses` for dates, features, and machine binding, and
  :doc:`../usage/examples` for progressively stronger host examples.

Verification
------------

The strict documentation build validates this page's structure and links:

Starting directory: the Licensecc repository root. Shell: PowerShell or Bash.

.. code-block:: console

   npm run check:docs

A native documentation change must also be checked against the source-purity
build from the repository root:

.. code-block:: powershell

   pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug
