#######################
Hardware Identifiers
#######################

Hardware identifiers are used to link the execution of the software to a physical hardware (a pc). 
The software executing on client's hardware, when it finds the license is missing, calls the api 
:ref:`identify_pc <api/public_api:Public api>`
and generates an hardware identifier. The client has to communicate the hardware id back to the software publisher that 
will issue a license for him (for details see: :ref:`issue licenses <usage/issue-licenses:Issue Licenses>`).   

Hardware identifiers may contain device or personal data, including network,
disk, host, or tenant-specific information. Treat them as support secrets:
collect only the identifier needed to issue or troubleshoot a license, avoid
posting raw values in public tickets or logs, and redact identifiers from
support bundles unless the user explicitly agrees to share them.

.. NOTE::

  Licensecc will guess the environment where the user is trying to launch the software (eg. a Virtual Machine), 
  embed the information into the hardware id and report it to the software publisher before he is issuing the license.

*****************
Usage scenarios
*****************
With the recent coming of virtualized environments the installation of software directly on the machine has been less and less.


Execution in a physical hardware
=================================
If the client executes the software on a physical hardware it is possible to identify the 
hardware by various parameters (cpu type/memory/disk label/mac address) see :ref:`features <analysis/features:Features>`
for detail of supported identification strategies.

Disk identifiers
----------------

Disk binding prefers serial or UUID-derived bytes. Volume labels are weak
binding data because users can rename them, labels are often reused across
images, and labels can reveal personal or device information in support
requests.

Legacy v200 identifiers do not carry a signed source-strength field. Because a
legacy verifier cannot reliably distinguish a serial/UUID-derived disk
identifier from a label-derived one, label-only disk fallback is disabled by
default. Builds that intentionally need compatibility with label-only disk
identifiers must opt in at build time with
``LCC_ALLOW_WEAK_DISK_LABEL_BINDING`` and should treat those licenses as weak
support or migration artifacts, not as strong hardware binding.

For v201 licenses, the generator derives and signs
``client-signature-source-strength`` whenever a license contains
``client-signature``. Disk label fallback is marked as ``weak-disk-label``;
mutable disk fallback such as a Windows volume serial without a volume GUID is
marked as ``weak-disk-mutable``. Both require the issuer to pass
``--allow-weak-disk-label-binding``. The runtime cross-checks the signed
source-strength value against the identifier bits before hardware matching.

Host and OS machine identifiers
-------------------------------

Host names and OS-level machine IDs are not supported hardware binding
strategies in v200. ``STRATEGY_HOST_NAME`` remains in the public enum only as a
reserved value for compatibility, but default generation skips it and direct
requests fail closed.

These values are weak binding material: host names are easy to rename, and
machine IDs are often cloned with VM or disk images. They may also identify a
person, tenant, or internal asset name. Treat them as support diagnostics only.
If a future v201 format uses host or OS identifiers, it should salt them and
carry explicit source-strength metadata so verifiers can reject them unless a
project policy opts in.

Execution in a virtual machine
==============================
If you're allowing software users to generate pc identifiers in a virtual machine
you should ask yourself what's the real use of it, since the vm can be copied as a whole elsewhere 
and there are few ways to detect this (without using an external license server that's not yet supported by this library).

* Usually when the machine is copied the MAC address is changed. But sometimes it changes on its own. Software publishers may want to use this as a last resort to prevent the vm for being cloned. It has to be verified case by case.
* Software editors may want to prevent people from extracting the software from the VM. They can use an hidden registry key or a specific file in a location outside the installation directory to verify the software is distributed in the original VM. Or they can link the execution to a specific kind of virtualization (this is supported by OpenLicenseManager).

.. TIP::

    In this case issuing a `demo` license with just a date limitation is advised.

Execution in a container
========================
Depending on how containers are used having hardware identifiers may make sense or no sense at all. 
For instance if containers are used to avoid to pollute the external distribution it makes perfect sense to have an 
hardware identifier, if users are running dockers in a kubernetes cluster in the cloud it makes no sense at all.

*************************************************
Hardware Identifier Generation
*************************************************

The licensed application will call the api method :ref:`identify_pc <api/public_api:Public api>` to generate an hardware 
identifier and print it out to the user, the user then will contact the software licensor to get an appropriate license.

The licensed application can either decide an identification strategy by passing it in the ``identify_pc`` parameter ``hw_id_method``
(see: ``LCC_API_HW_IDENTIFICATION_STRATEGY``) or let `licensecc` automatically choose how to generate the
identifier (by passing `hw_id_method=STRATEGY_DEFAULT`).
In this case `licensecc` is able to identify which virtual environment the user is running in and select the appropriate generation
strategy. 

Below the full identifier generation workflow used by the :ref:`identify_pc <api/public_api:Public api>` method. 

.. figure:: ../_static/pc-id-selection.png


Default identifier generation (implementation details)
=======================================================

This section describes the inner working of the default hardware identifier strategy.

When the licensed software calls :ref:`identify_pc <api/public_api:Public api>` with ``STRATEGY_DEFAULT``
the identifier generation will follow these steps:

 - It will first look to the environment variable ``IDENTIFICATION_STRATEGY``. If set it will use the identification strategy in that variable.
 - It will try to determine which virtual environment the licensed software is running in. 
    * If no virtual environment found it will use the strategies in ``LCC_BARE_TO_METAL_STRATEGIES``, it will try them one by one until the first one succeeds.
    * If it detects it's running in a Virtual Machine it will try the strategies in ``LCC_VM_STRATEGIES``, it will try them one by one until the first one succeeds.

if you're interested in implementing your own hardware identification strategy you can have a look to the library
 :ref:`extension points <api/extend:Tweak hardware signature generator>`.

.. TIP::

    If `licensecc` is generating a bad hardware identifier (eg. 'AAAA-AAAA-AAAA') software licensor can ask the user 
    to set the environment variable ``IDENTIFICATION_STRATEGY`` and try again. Or he can send the user the `lccinspector`
    support tool to inspect which identifier strategies are available.
    ``lccinspector`` redacts hardware identifiers, IP addresses, and MAC
    addresses by default; use ``--raw-hardware-identifiers`` only for a trusted
    diagnostic exchange where raw values are required.


.. NOTE::
    
    `licensecc` will try to validate the identifier using the same strategy that was used to generate it, regardless  
    of what is the default method now in use. eg: disk identifiers will always be validated by ``DiskStrategy``.
