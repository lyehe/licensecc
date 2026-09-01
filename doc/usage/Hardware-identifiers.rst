#######################
Hardware Identifiers
#######################

Hardware identifiers bind a license decision to properties observed on a
client device. When a local license is missing, the application can call
:ref:`identify_pc <api/public_api:Public api>`, display the resulting
identifier, and ask the customer to send it to the publisher. The publisher
then issues a bound license as described in
:ref:`issue licenses <usage/issue-licenses:Issue Licenses>`.

Raw identifiers can contain device, network, host, tenant, or personal data.
Redact them from routine logs, telemetry, public issues, and support bundles;
request the full value only through an explicit trusted support channel.

.. NOTE::

  A hardware identifier is a licensing signal, not proof of an untampered
  physical machine. Licensecc records the selected strategy in the identifier
  so the runtime can validate it consistently later.

*****************
Usage scenarios
*****************
Choose a strategy that matches where the application actually runs. Hardware
properties that are useful on a workstation may be unstable or meaningless in
virtual machines and orchestrated containers.


Execution on physical hardware
==============================
On a physical machine, Licensecc can derive an identifier from supported
device properties. See :doc:`../api/hardware_identifiers` for the current
identification strategies and project configuration points.

Execution in a virtual machine
==============================
Treat a virtual-machine identifier as clone resistance, not clone prevention.
A copied VM can retain many of the same properties, while ordinary VM
maintenance can change others. A MAC address, for example, may change during a
legitimate move or be preserved by a clone.

Licensecc's supported online backend can add account-bound activation,
node-locked leases, floating seats, renewal, and revocation controls. Those
server decisions improve lifecycle control but do not turn a mutable VM
property into a hardware root of trust. See
:doc:`issue-licenses` for local evaluation and hosted runbook boundaries.

.. TIP::

    For an evaluation running in a disposable VM, prefer a short-lived trial
    over a long-lived hardware-bound license.

Execution in a container
========================
A long-lived desktop container may inherit stable host properties, but an
ephemeral replica in an orchestrated cluster generally does not. Prefer
account, entitlement, lease, or seat identity for elastic workloads. Validate
the selected strategy on every supported deployment platform before treating
it as a binding input.

*************************************************
Hardware Identifier Generation
*************************************************

Call :ref:`identify_pc <api/public_api:Public api>` to generate the identifier
that the application displays or returns through a support workflow. Pass an
explicit :cpp:enum:`LCC_API_HW_IDENTIFICATION_STRATEGY` when the product owns
a tested strategy choice, or pass
:cpp:enumerator:`LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_DEFAULT` to use
the project-configured order for the detected environment.

The following diagram summarizes the default selection:

.. figure:: ../_static/pc-id-selection.png
   :alt: Default hardware-identifier strategy selection by execution environment


Default identifier generation (implementation details)
=======================================================

With
:cpp:enumerator:`LCC_API_HW_IDENTIFICATION_STRATEGY::STRATEGY_DEFAULT`, the
runtime:

#. Uses ``IDENTIFICATION_STRATEGY`` only when the process environment provides
   a valid numeric strategy id.
#. Otherwise classifies the environment as bare metal, VM, cloud VM, Docker,
   or LXC.
#. Tries the corresponding project macros in order until a supported strategy
   succeeds. These are :c:macro:`LCC_BARE_TO_METAL_STRATEGIES`,
   :c:macro:`LCC_VM_STRATEGIES`, ``LCC_CLOUD_STRATEGIES``,
   ``LCC_DOCKER_STRATEGIES``, and ``LCC_LXC_STRATEGIES``.
#. Fails when no configured strategy produces an identifier; it does not
   silently invent an identifier.

The generated identifier records the strategy that produced it. Verification
uses that recorded strategy even if the project's later default order changes.
Runtime policy rejects IP-address, environment-selected, and weak disk-label
bindings by default through ``LCC_ALLOW_RUNTIME_IP_BINDING``,
``LCC_ALLOW_RUNTIME_ENV_SELECTED_BINDING``, and
``LCC_ALLOW_WEAK_DISK_LABEL_BINDING``. Opt in only after a deliberate security
review.

.. tip::

   Use ``lccinspector`` to enumerate candidate identifiers when diagnosing an
   unstable machine. Treat ``IDENTIFICATION_STRATEGY`` as a controlled support
   override, not as a customer-selected production policy.

To add a product-specific generator, use the
:ref:`extension points <api/extend:Tweak hardware signature generator>` and
test generation and validation on every supported platform.
