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
portal, backup tooling, signed host-defined execution policies, native Linux
ARM64 evidence, and Python/.NET/Java token SDKs. Their exact current status
and constraints are intentionally centralized in the registry.

TPM-backed request-proof providers, Linux ARM64, and environment classification
remain platform-limited rather than universal. Container and cloud hardware
identification is deliberately constrained rather than described as universal
machine binding. The signed ``custom-limit`` value is intentionally opaque:
Licensecc authenticates and bounds it while the embedding host owns the policy
schema and deterministic evaluator.
