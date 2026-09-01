Choose an SDK or support tool
=============================

SDK clients
-----------

The Python, .NET, and Java SDKs verify signed server tokens and wrap selected
backend HTTP operations. They do not acquire local ``.lic`` files, fingerprint
hardware, or enforce native application execution. Use the C/C++ runtime for
those properties.

Start with :doc:`../api/sdks` for the cross-language scope and token contract,
then follow the README owned by the selected package:

* `Python SDK guide
  <https://github.com/lyehe/licensecc/tree/main/sdks/python>`_ — Python 3.9+
  token verification and HTTP client.
* `.NET SDK guide
  <https://github.com/lyehe/licensecc/tree/main/sdks/dotnet>`_ — .NET 8,
  BCL-only token verification and HTTP client.
* `Java SDK guide
  <https://github.com/lyehe/licensecc/tree/main/sdks/java>`_ — dependency-free
  Java 17 token verification and HTTP client.

The packages are source-available release candidates. Their public registry
publication is a separate release operation, so use the package-local README's
checkout or local-artifact instructions rather than assuming a registry name.

Maintainers run the cross-language compatibility gate from the repository
root:

.. code-block:: console

   npm run test:sdks

.. _support-with-lccinspector:

Support with lccinspector
-------------------------

``lccinspector`` is the native support utility installed for the selected
license project. Run it without a license to print the identifiers and
execution-environment details that a support workflow may use. Pass one
explicit ``.lic`` path to inspect that license for each project configured in
the installed build.

The ``dev-debug`` sample install places it at:

.. code-block:: text

   Windows: build/dev-debug/install/bin/test/lccinspector.exe
   Linux:   build/dev-debug/install/bin/test/lccinspector

Machine identifiers and environment details can be sensitive support data.
Collect only what the issuing workflow needs, transmit it through an approved
channel, and do not treat it as proof of entitlement. See
:doc:`../usage/Hardware-identifiers` for identifier selection and
:doc:`../usage/issue-licenses` for issuing a bound license.
