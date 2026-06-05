Security notes
##############

Licensecc provides local license verification for applications that need
offline or customer-hosted entitlement checks. It is tamper-resistant, not
tamper-proof.

Local enforcement limits
========================

The runtime verifies signed license data and fails closed for malformed,
unsupported, or tampered licenses. This protects against ordinary license file
editing, accidental copying, stale licenses, unsupported license versions, and
hardware-bound license relocation.

It does not make a customer-controlled machine trustworthy. A determined local
attacker may patch the application binary, replace the linked library, hook
``acquire_license``, alter the process environment, or change the system clock.
High-value products should combine local checks with server-side entitlement
checks, account-level authorization, telemetry, or application hardening outside
Licensecc.

``acquire_license_ex`` can report host callback failures and source-shadowing
signals through the audit log, and can fail closed when the host opts into
``LCC_TAMPER_ENFORCE``. Treat those signals as best-effort local diagnostics,
not proof that the process is untampered.

Signing keys and algorithms
===========================

The private signing key is an issuer secret. Keep ``private_key.rsa`` in an
issuer-controlled project directory, outside customer packages and public source
archives. Runtime packages need only the generated public-key metadata compiled
into the project-specific library.

Current v200 licenses retain their legacy signature payload for compatibility.
The hardened v201 format adds explicit canonical-payload, signature-version,
algorithm, and key-id metadata. Release builds should use generated public-key
metadata and should not ship issuer tools or private keys in runtime packages.

Use modern RSA key sizes for new issuing projects. The release guard rejects
runtime/package artifacts that do not meet the configured minimum public-key
metadata requirements unless an explicit release override is supplied for a
controlled migration.

Versioned signing policy
========================

License format and signing policy are versioned together:

* ``lic_ver = 200`` is the legacy compatibility format. Verification accepts
  only ``rsa-pkcs1-sha256`` with the embedded project public key. Existing
  RSA-1024 v200 deployments remain verifiable for compatibility, but new
  RSA-1024 project generation requires the explicit ``--legacy-rsa1024``
  option and must be treated as migration-only.
* New project initialization defaults to RSA-3072. Issuers can choose an
  explicit generated RSA key size with ``lccgen project init --key-bits
  2048|3072|4096``; RSA-1024 generation remains available only through the
  explicit ``--legacy-rsa1024`` migration path. Release runtime/package
  artifacts are expected to carry generated public-key metadata declaring RSA,
  the modulus bit length, the public-key fingerprint, and the signature
  algorithm; release guards reject artifacts below the configured RSA modulus
  minimum.
* ``lic_ver = 201`` uses the canonical payload path and signed
  ``sig-alg``/``key-id`` metadata. The current v201 policy still allows only
  ``rsa-pkcs1-sha256`` with the embedded key ID while the project remains in
  the v200-default compatibility window.
* A future default-to-v201 or newer-format cutover must update the policy,
  release notes, golden vectors, and verifier allowlists in the same change.
  Introducing RSA-PSS or another modern signature scheme requires a new signed
  algorithm identifier, cross-platform vectors, and negative tests for
  algorithm parameters such as salt length and MGF1 before it can become the
  default.

The planned deprecation path is: keep v200 verification for existing deployed
licenses; stop generating RSA-1024 projects except through the explicit legacy
option; move default issuance to canonical v201 only after compatibility gates
are green; then retire legacy generation paths in a later release after release
notes identify the last runtime that needs them.

Key rotation
============

v201 licenses carry a signed ``key-id`` derived from the SHA-256 digest of the
canonical PKCS#1 public-key DER. The runtime policy selects the embedded public
key record by that signed key ID before verifying the signature. A rotation
build can therefore carry both the old and new public keys during an overlap
period, then deny a retired key ID after old licenses have been replaced.

The generated project header contains the active key. For a rotation build,
add older active records through ``LCC_ADDITIONAL_PUBLIC_KEY_RECORDS`` in the
project public-key header, using ``license::os::SignaturePublicKey(key_id,
der_bytes, bits)`` records. Add retired IDs through
``LCC_RETIRED_PUBLIC_KEY_IDS``. The verifier rejects duplicate key IDs,
key-ID/public-key DER mismatches, malformed public-key DER, and keys below the
v201 minimum before attempting signature verification.

Operationally, issue new licenses with the new private key, ship a runtime
that accepts both old and new public keys, wait for the old-license population
to drain, then ship a runtime that marks the old key ID retired or removes the
old public-key record. Do not delete the old private key until all revocation
and reissue evidence for that rotation has been archived.

Hardware identifiers and privacy
================================

Hardware identifiers are device-binding data and may be personal data or
internal asset data depending on jurisdiction and deployment. They are not
secrets. Treat them as customer support data:

* collect only the identifier needed to issue or support a license;
* explain why it is collected before asking customers to send it;
* avoid storing identifiers in public issue trackers, logs, or examples;
* define retention and deletion expectations for support tickets; and
* prefer disk or Ethernet identifiers over IP-address identifiers when hardware
  binding is required.

IP-address binding is weak because IP addresses are often mutable, shared,
NATed, or reused. Use ``--allow-ip-binding`` only when the operator
intentionally accepts that weaker binding. Identifiers selected through an
environment override are support-oriented and require
``--allow-env-selected-binding``.

License data handling
=====================

License files are signed but not encrypted. Do not put secrets, passwords, API
tokens, or confidential customer data in ``extra-data`` or other license fields.
The ``extra-data`` field is returned to the host application after successful
verification and is intended for small application-defined flags or identifiers.

Environment license lookup through ``LICENSE_LOCATION`` and ``LICENSE_DATA`` is
useful for tests, support, and embedded deployments. Production applications
that do not trust their process environment should disable those sources during
startup and provide explicit or colocated license locations instead.

Recommended release checks
==========================

Before shipping a runtime package, require these gates:

* full Debug and Release test suites on supported platforms;
* security-labeled parser, signature, public API, anti-tamper, package,
  install, hardware, platform, validation, verifier, and v201 facets with
  ``--no-tests=error``;
* Linux ASan/UBSan coverage for direct executable tests;
* parser and decoder fuzz smoke under sanitizers;
* artifact scans that reject private keys and issuer-only tooling in runtime
  packages;
* manifest checks that identify package profile, project, ABI, supported
  license format range, and public-key fingerprint; and
* migration notes for any compatibility-breaking parser or validation behavior.

See :doc:`security-model` for the detailed threat model and compatibility
rules.
