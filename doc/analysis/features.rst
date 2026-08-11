###########
Features
###########

Capability status is maintained in the machine-readable
:doc:`capability registry <../capabilities/index>`, not in this historical
overview. In particular, ``shipped`` means implemented with automated evidence
in the accepted repository; it does not imply a deployed Worker, a published
SDK, or an Ubuntu release attestation.

Historical context
******************

The C++ library originated as a local license-file verifier with expiry,
feature, version, and hardware-binding inputs. The repository has since gained
online verification, floating-seat lifecycle routes, administration, a customer
portal, backup tooling, and Python/.NET token SDKs. Their exact current status
and constraints are intentionally centralized in the registry.

The remaining recorded directions are ARM support, additional execution-limit
types, a TPM-backed request-proof provider, and a Java SDK. Container and cloud
hardware identification are deliberately constrained rather than described as
universal machine binding.
