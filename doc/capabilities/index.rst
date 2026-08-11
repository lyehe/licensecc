#####################
Capability registry
#####################

This page is the public index for the machine-readable capability registry in
``doc/capabilities/registry.json``. That registry is the canonical authority
for capability status. A capability is ``shipped`` only when its implementation
and automated evidence are present in the accepted repository; it does not mean
that a service is deployed or an SDK is published.

:download:`Download the capability registry <registry.json>`.

The platform is at **0.1.0-rc.1** (a prerelease). Remote CI and Ubuntu release evidence
are intentionally not claimed by this registry. Deployment, Cloudflare account
configuration, signing keys, and package publication remain operator or release
work outside the repository.

Status vocabulary
=================

``shipped``
  Implemented and covered by automated evidence in the accepted repository.
``experimental``
  Implemented with explicit integration or rollout constraints.
``platform_limited``
  Implemented, but support is constrained by environment or platform behavior.
``planned``
  A recorded direction without accepted implementation and automated evidence.
``deprecated``
  Retained only for compatibility; use the replacement named in the registry.

Current capability map
======================

Local C++ runtime
-----------------

* **C++ local license verification** — shipped for the Windows/Linux C++ runtime.
* **Hardware identifier binding** — shipped, with environment-dependent suitability.
* **Environment-aware identification** — platform-limited: containers and cloud
  environments deliberately default to no hardware binding.
* **License version limits** and **signed configuration attestation** — shipped.
* **Legacy ``LCC_REMOTE`` license type** — deprecated and unsupported; use the
  online callback and backend lifecycle rather than this compatibility enum.

Online platform
---------------

* **Fail-closed online verification**, **floating-seat lifecycle**, **backend
  usage metering**, and **signed order fulfillment** are shipped in the accepted
  repository.
* **Backend request proof of possession** is experimental. The protocol is
  implemented; the C++ runtime now has platform-limited Windows Platform KSP
  and Ubuntu TPM2/OpenSSL provider surfaces with conditional build and
  simulator evidence. These are client-runtime integrations, not a hosted
  backend TPM claim.
* **Administrative control plane**, **customer self-service portal**, and **D1
  backup and restore drill** are shipped in the accepted repository.

SDKs and planned work
---------------------

* The **Python SDK** and **.NET SDK** are shipped and tested from the repository.
  Neither is published to its public package registry.
* **ARM support**, **additional execution-limit types**, and a **Java SDK** are
  planned. TPM provider support remains platform-limited rather than universal.

For exact ownership, release availability, limitations, public-document links,
and evidence selectors, consult ``registry.json``. Historical feature prose is
kept briefly in :doc:`../analysis/features`; it is not a second status source.

Registry identifiers: ``cpp-local-verification``, ``hardware-binding``,
``environment-aware-identification``, ``license-version-limits``,
``online-verification``, ``config-attestation``, ``floating-seats``,
``legacy-remote-license-type``, ``backend-request-proof``,
``backend-metering``, ``backend-order-fulfillment``, ``admin-control-plane``,
``portal-self-service``, ``d1-backup-and-restore-drill``, ``python-sdk``,
``dotnet-sdk``, ``arm-support``, ``custom-execution-limits``,
``tpm-request-proof-provider``, and ``java-sdk``.
