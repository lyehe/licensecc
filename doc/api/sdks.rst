Client SDKs
===========

The SDKs share token vectors and HTTP contracts, but their package surfaces
are language-native. They are source-available release candidates in this
repository; public registry publication is a separate release operation.

.. list-table:: Supported SDK surfaces
   :header-rows: 1
   :widths: 13 22 38 27

   * - Language
     - Primary entry points
     - Scope
     - Detailed reference
   * - Python 3.9+
     - ``verify_online_assertion``, ``verify_config_token``, ``HttpClient``
     - Offline signed-token verification and backend HTTP calls.
     - :doc:`Generated Python API <python>` and
       `SDK guide <https://github.com/lyehe/licensecc/tree/main/sdks/python>`_
   * - .NET 8
     - ``OnlineAssertionVerifier``, ``ConfigTokenVerifier``,
       ``LicensingBackendClient``
     - Offline signed-token verification and backend HTTP calls with BCL-only
       runtime dependencies.
     - `.NET SDK guide <https://github.com/lyehe/licensecc/tree/main/sdks/dotnet>`_
   * - Java 17
     - ``OnlineAssertion``, ``ConfigAttestation``,
       ``LicensingBackendClient``
     - Dependency-free JDK token verification and backend HTTP calls.
     - `Java SDK guide <https://github.com/lyehe/licensecc/tree/main/sdks/java>`_

Optional Windows device-bound adapters in Python, .NET and Java call the same
installed C runtime for TPM identity, enrollment, renewal and local authorization.
See each SDK guide for its native packaging and loading requirements; Java uses
a separate JNI DLL and retains its Java 17 baseline.

The HTTP/token APIs do not perform local binary enforcement. A verified server
token proves authenticity and claim binding; it does not prove that the host
process, license file, or hardware state is trusted. Managed-language wrappers
do not make application control flow tamper-resistant. Keep protected operations
and enforcement in the native application.
