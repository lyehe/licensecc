##############
Licensecc
##############
*Copy protection, licensing library, and license generator integration for Windows and Linux.*

Licensecc helps applications verify local license files, bind licenses to machine
identifiers, and enforce execution limits such as expiration dates and licensed
features. If the software runs on real hardware (not a container/VM) it can generate
a signature of that hardware and report when the signature doesn't match — for
instance because the software was copied to another machine.

A list of features and their status is in :ref:`features <analysis/features:Features>`.

License (AGPL-3.0-or-later)
****************************
This repository is licensed under the `GNU Affero General Public License v3.0 or
later <https://www.gnu.org/licenses/agpl-3.0.html>`_. See the ``LICENSE`` file at
the repository root for the full text. Inclusion in proprietary or closed-source
software is subject to the AGPL's terms — review them (and your obligations for
network-accessible services) before integrating.

Project Structure
*******************
This repository contains:

* ``licensecc``      : the C++ library with a C API (the part you integrate in your software), with minimal external dependencies.
* ``lccinspector``   : a license debugger for end customers, to diagnose licensing problems or calculate the hardware id before issuing a license.
* ``lccgen``         : the license generator (vendored as the ``extern/license-generator`` submodule), used to initialize projects and issue licenses.
* ``examples/minimal``: a standalone integration example.
* ``services/``      : Cloudflare Workers for online licensing (backend, operator console, customer portal, D1 backup).
* ``sdks/``          : Python and .NET client SDKs for token verification and backend HTTP calls.

How to build
****************
The repository ``README.md`` is the source of truth for prerequisites and build
commands. In short, with CMake ≥ 3.21 and a C++17 compiler:

.. code-block:: console

  git clone --recursive https://github.com/lyehe/licensecc.git
  cd licensecc
  cmake --preset dev-debug
  cmake --build --preset dev-debug
  ctest --preset dev-debug

Platform-specific detail lives in :ref:`Linux <development/Build-the-library:Build - Linux>`
and :ref:`Windows <development/Build-the-library-windows:Build - Windows>`.

How to use
**************
Start from ``examples/minimal`` in this repository and the
:ref:`integration guide <usage/integration:Integrate Licensecc in your application>`.
Issuing licenses (local files with ``lccgen``, or online entitlements through the
backend/admin services) is covered in ``doc/usage/issue-licenses.md``.

How to contribute
********************
Open issues and pull requests on the `repository <https://github.com/lyehe/licensecc>`_.
Pull requests target the ``main`` branch. See ``CONTRIBUTING.md`` for guidelines and
run ``scripts/dev-check.ps1`` before submitting.

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`


.. toctree::
   :glob:
   :maxdepth: 2
   :hidden:
   :caption: Build the library:

   development/*

.. toctree::
   :glob:
   :maxdepth: 2
   :hidden:
   :caption: Integrate and use:

   usage/*


.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: API:

   api/public_api
   api/extend

.. toctree::
   :glob:
   :maxdepth: 2
   :hidden:
   :caption: Analysis:

   analysis/*

.. toctree::
   :glob:
   :maxdepth: 2
   :hidden:
   :caption: Architecture:

   architecture/*
   architecture/decisions/*

.. toctree::
   :glob:
   :maxdepth: 2
   :hidden:
   :caption: Miscellaneous:

   other/*

.. meta::
   :description: open source license manager, copy protection library in C++.
   :keywords: c++, open source, licensing software, copy protection, license manager, hardware identification

.. title::
   C++ copy protection library
