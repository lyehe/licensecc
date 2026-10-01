Client SDKs
===========

The SDKs share config-token and device-protocol vectors, but their package
surfaces are language-native.
They are source-available release candidates in this repository; public
registry publication is a separate release operation.

.. list-table:: Supported SDK surfaces
   :header-rows: 1
   :widths: 13 22 38 27

   * - Language
     - Primary entry points
     - Scope
     - Detailed reference
   * - Python 3.9+
     - ``verify_config_token``
     - Offline ``lcccfg1`` config-token verification and the optional
       protected native adapters.
     - :doc:`Generated Python API <python>` and
       `SDK guide <https://github.com/lyehe/licensecc/tree/main/sdks/python>`_
   * - .NET 8
     - ``ConfigTokenVerifier``
     - Offline ``lcccfg1`` config-token verification with BCL-only runtime
       dependencies, and the optional protected native adapters.
     - `.NET SDK guide <https://github.com/lyehe/licensecc/tree/main/sdks/dotnet>`_
   * - Java 17
     - ``ConfigAttestation``
     - Dependency-free JDK ``lcccfg1`` config-token verification and the
       optional protected JNI adapters.
     - `Java SDK guide <https://github.com/lyehe/licensecc/tree/main/sdks/java>`_

Optional device-bound and feature-session adapters in Python, .NET and Java
call the same installed C runtime on Windows and Linux for TPM identity,
enrollment, renewal and local authorization. See each SDK guide for its native
packaging and loading requirements; Java uses a separate JNI library and
retains its Java 17 baseline. The SDKs have no HTTP backend client: protected
online licensing always runs through the native runtime, which owns the
device key, the transport and the lease checks.

The config-token APIs do not perform local binary enforcement. A verified
``lcccfg1`` token proves authenticity and claim binding; it does not prove that
the host process, license file, or hardware state is trusted. Managed-language
wrappers do not make application control flow tamper-resistant. Keep protected
operations and enforcement in the native application.
