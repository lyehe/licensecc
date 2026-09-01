Licensecc
=========

Licensecc provides a native C/C++ licensing runtime, a local license issuer,
optional online entitlement services, and Python, .NET, and Java client SDKs.
Use this site by outcome; you do not need to build or deploy every repository
surface.

Choose a starting point
-----------------------

.. list-table::
   :class: licensecc-starting-points
   :header-rows: 1
   :widths: 25 39 36

   * - Goal
     - Start here
     - Successful result
   * - Try offline licensing
     - :doc:`tutorials/offline-first-license`
     - A newly issued ``.lic`` file is accepted by the minimal consumer.
   * - Integrate a C or C++ application
     - :doc:`usage/integration`
     - Your CMake target links the matching installed Licensecc component.
   * - Evaluate online verification locally
     - :doc:`tutorials/local-online-evaluation`
     - The real Worker returns a signed assertion through its SQLite host.
   * - Use Python, .NET, or Java
     - :doc:`tutorials/sdk-and-support` and :doc:`api/sdks`
     - The selected SDK verifies server tokens against the shared contract.
   * - Diagnose a customer machine
     - :ref:`support-with-lccinspector`
     - ``lccinspector`` reports identifiers and checks an explicit license.
   * - Operate the hosted platform
     - :doc:`operations/production-readiness`
     - Required resources, controls, and evidence are known before rollout.
   * - Change the repository
     - :doc:`usage/repository-workflows` and :doc:`architecture/change-guide`
     - The change stays inside its owner and runs the correct focused gates.

For the shortest product result, follow
:doc:`tutorials/offline-first-license`. It names the starting directory and
shell, keeps generated keys under the build tree, and ends with the observable
``license OK`` result.

Status, license, and versions
-----------------------------

The :doc:`capability registry <capabilities/index>` is the source for shipped,
limited, experimental, and planned behavior. The native C++ lineage is
versioned independently from the platform services and SDKs; see
:doc:`architecture/decisions/0005-platform-version-and-release-tags` before
interpreting a version or release tag.

This repository is licensed under the `GNU Affero General Public License v3.0
or later <https://www.gnu.org/licenses/agpl-3.0.html>`_. Review the license,
including its network-use obligations, before integrating Licensecc into
proprietary or closed-source software.

The files below are deliberately ordered. Historical analysis remains in the
repository for auditability but is not part of the maintained reader path.

.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: Tutorials

   tutorials/index

.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: Use Licensecc

   usage/index

.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: Reference

   api/index
   capabilities/index
   other/glossary

.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: Operate and release

   operations/index
   security/index
   release-artifacts

.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: Build and contribute

   development/Development-Environment-Setup
   development/Dependencies
   development/Build-the-library
   development/Build-the-library-windows
   development/documentation

.. toctree::
   :maxdepth: 2
   :hidden:
   :caption: Architecture

   architecture/index
   architecture/system-map
   architecture/change-guide
   architecture/ownership
   architecture/decisions/0001-module-boundaries
   architecture/decisions/0002-node-workspace
   architecture/decisions/0003-route-openapi-ownership
   architecture/decisions/0004-build-bootstrap-purity
   architecture/decisions/0005-platform-version-and-release-tags

.. toctree::
   :maxdepth: 1
   :hidden:
   :caption: Project information

   other/QA
   other/CREDITS

* :ref:`genindex`
* :ref:`modindex`
* :ref:`search`

.. meta::
   :description: Licensecc native licensing runtime, online entitlement services, and client SDKs.
   :keywords: c++, licensing software, copy protection, license manager, hardware identification

.. title::
   Licensecc documentation
