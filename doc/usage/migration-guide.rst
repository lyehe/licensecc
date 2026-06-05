Migration guide for hardened licenses
#####################################

This guide is for issuers and host applications moving from permissive legacy
v200 parsing to the current hardened v200 behavior and the opt-in v201 license
format.

What changed in hardened v200
=============================

Current runtimes still accept valid ``lic_ver = 200`` licenses, but they reject
ambiguous or non-canonical input that older deployments may have tolerated.
The requested product or feature section now fails closed for these cases:

* unknown license keys;
* uppercase or mixed-case keys;
* duplicate keys, including duplicate ``lic_ver`` or ``sig``;
* duplicate requested sections;
* missing, empty, malformed, or non-canonical base64 ``sig`` values;
* unsupported or non-canonical ``lic_ver`` values such as ``+200``, ``0200``,
  ``200x``, or whitespace-padded values;
* bad date values, including compact dates, slash dates, impossible calendar
  dates, trailing garbage, and padded values;
* malformed ``start-version`` or ``end-version`` bounds;
* signed field mutations, including date, version, ``extra-data``, feature, and
  ``client-signature`` changes;
* malformed hardware identifiers in signed licenses; and
* oversized license sources or non-NUL-terminated public API buffers.

Most malformed license text returns ``LICENSE_MALFORMED``. A license whose
syntax is valid but whose signed data no longer matches returns
``LICENSE_CORRUPTED``. A missing requested product or feature returns
``PRODUCT_NOT_LICENSED``.

Regenerate affected licenses
============================

Do not patch signed license files by hand. Regenerate affected licenses with
the current ``lccgen license issue`` command from the same Licensecc project
folder used to build the target runtime package:

.. code-block:: console

   lccgen license issue \
     --project-folder /secure/licensecc-projects/MY_PRODUCT \
     --primary-key /secure/licensecc-projects/MY_PRODUCT/private_key.rsa \
     --output-file-name /secure/licensecc-projects/MY_PRODUCT/licenses/customer.lic

If the legacy license contained validity dates, version bounds, features,
hardware binding, or ``extra-data``, pass those options again. The generator
normalizes supported operator input and signs the canonical runtime form.

Legacy compatibility window
===========================

Valid v200 licenses remain supported by current runtimes. The compatibility
boundary is the documented v200 grammar, not every historical parser quirk.
Issuers should treat hand-edited, parser-normalized, or whitespace-dependent
license files as invalid and regenerate them before upgrading customer
runtime packages.

The generator still defaults to strict v200 issuance:

.. code-block:: console

   lccgen license issue --license-version 200 ...

Keep that default for deployed applications that may still run v200-only
runtimes.

Opting into v201
================

The v201 format signs an explicit canonical payload and includes metadata such
as ``canonical-v``, ``sig-v``, ``sig-alg``, and ``key-id``. Issue v201 only for
applications built with a runtime that advertises v201 support:

.. code-block:: console

   lccgen license issue \
     --project-folder /secure/licensecc-projects/MY_PRODUCT \
     --primary-key /secure/licensecc-projects/MY_PRODUCT/private_key.rsa \
     --output-file-name customer-v201.lic \
     --license-version 201 \
     --target-license-format-max 201

The ``--target-license-format-max=201`` option is an explicit compatibility
signal. Without it, ``lccgen`` refuses v201 issuance so an issuance script does
not accidentally create licenses for older v200-only runtimes.
Treat this as a deployment contract, not just a generator option: installed
packages expose the supported range through ``licensecc_LICENSE_FORMAT_MIN`` and
``licensecc_LICENSE_FORMAT_MAX`` in CMake, and generated runtimes expose
``LCC_SUPPORTED_LICENSE_FORMAT_MIN`` and ``LCC_SUPPORTED_LICENSE_FORMAT_MAX``.
A v200-only runtime has maximum format ``200`` and rejects ``lic_ver = 201`` as
malformed or unsupported.

The v201 reader accepts the same delimiter spacing forms as hardened v200:
``key=value``, ``key= value``, ``key =value``, and generated
``key = value``. Keys must be lowercase allowlisted v201 names with no leading
whitespace, no tab spacing, and at most one ASCII space before ``=``. Values
must not contain leading or trailing whitespace after the optional delimiter
space. Raw license data containing embedded NUL bytes is malformed. v201
canonical fields are printable ASCII only; control bytes, DEL, and high-bit
bytes are rejected by both the generator and runtime. v201 license files are
not UTF-8 text containers for arbitrary user-visible strings.

Hardware-binding policy changes
===============================

Hardware identifiers are binding hints, not secrets. Disk and Ethernet
identifiers are the normal issuance paths. IP-address binding is weaker because
IP addresses are often mutable or reused, so the generator rejects IP-bound
identifiers unless the operator passes ``--allow-ip-binding``.

Identifiers produced through the ``IDENTIFICATION_STRATEGY`` environment
variable are also rejected by default and require
``--allow-env-selected-binding`` for explicit support or compatibility flows.

Relevant public results:

* malformed signed hardware identifiers return ``LICENSE_MALFORMED``;
* well-formed identifiers that do not match the current machine return
  ``IDENTIFIERS_MISMATCH``; and
* weak bindings should be issued only when the support policy explicitly
  accepts that risk.

Host application changes
========================

Host applications should treat every result other than ``LICENSE_OK`` as not
licensed. For production deployments:

* initialize ``CallerInformations`` and ``LicenseInfo`` with zeroes;
* set ``CallerInformations.magic`` to ``LCC_PROJECT_MAGIC_NUM``;
* pass ``CallerInformations.version`` whenever licenses use ``start-version``
  or ``end-version``;
* disable environment license lookup unless it is a trusted compatibility path
  by calling ``lcc_set_environment_license_sources_enabled(false)`` during
  startup; and
* enable strict source-fatal behavior when explicit or environment sources are
  authoritative by calling ``lcc_set_strict_source_fatal_enabled(true)``.

Related details are covered in :doc:`../analysis/security-model`,
:doc:`License-retrieval`, and :doc:`issue-licenses`.

Public ABI compatibility
========================

The public ABI profile includes the numeric values of public enums, the public
buffer constants, and the layouts of ``AuditEvent``, ``LicenseLocation``,
``CallerInformations``, ``LicenseInfo``, and
``ExecutionEnvironmentInfo``. CI records these values in both in-tree public
API tests and an installed-package C++11 consumer smoke.

Changing those structs, constants, enum values, or exported C API symbols is a
consumer-visible compatibility change. Such a change must update this migration
guide or the release notes in the same patch, name the affected public type or
symbol, and state the required consumer action, such as rebuilding against a
new package, migrating stored struct data, or updating wrapper bindings.
