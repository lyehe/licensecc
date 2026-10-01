#####################
Capability registry
#####################

This page is the public index for the machine-readable capability registry in
``doc/capabilities/registry.json``. That registry is the canonical authority
for capability status. A capability is ``shipped`` only when its implementation
and automated evidence are present in the accepted repository; it does not mean
that a service is deployed or an SDK is published.

:download:`Download the capability registry <registry.json>`.

The platform is at **0.1.0-rc.2** (a prerelease). Repository-owned, protected
publication and production-deployment workflows are present, but no successful
remote run is inferred from source code. Cloudflare account configuration,
trusted-publisher identities, protected-environment approvals, signing keys,
and the act of publishing or deploying remain operator actions.

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

Current capability map
======================

Local C++ runtime
-----------------

* **C++ local license verification** — shipped for the Windows/Linux C++ runtime.
* **Hardware identifier binding** — shipped, with environment-dependent suitability.
* **Environment-aware identification** — platform-limited: containers and cloud
  environments deliberately default to no hardware binding; Azure, AWS, GCP,
  and Alibaba classification is covered without treating generic Hyper-V or
  SeaBIOS strings as cloud proof.
* **License version limits** and **signed configuration attestation** — shipped.
* **Signed host-defined execution limits** — shipped for v201 licenses. The
  runtime fails closed unless the host evaluates the signed opaque policy.

Online platform
---------------

* **Protected device-bound online licensing** is experimental. The backend
  serves the four ``/v2`` device routes and the portal serves browser consent;
  every grant is protected. Leases last at most 24 hours and never survive a
  process restart. Live TPM, browser, and backend journeys remain a release
  gate, and no protected capacity harness exists yet.
* **Signed order fulfillment** is shipped in the accepted repository.
* **Administrative control plane**, **customer self-service portal** (protected
  devices and consent only), and **D1 backup and restore drill** are shipped in
  the accepted repository.

The capabilities the initial release deliberately does not include are listed
in the launch scope of :doc:`../operations/production-readiness`.

SDKs and platform limits
------------------------

* The **Python**, **.NET**, and dependency-free **Java 17+ SDKs** are shipped and
  tested from the repository for ``lcccfg1`` config-token verification. Their
  optional protected adapters call the installed native runtime; none has an
  HTTP backend client. None is published to its public package registry.
* **Linux ARM64** is platform-limited and runs the native purity suite on an
  Ubuntu 24.04 ARM64 runner. Windows ARM64, macOS, and prebuilt ARM packages are
  not claimed.
* The **TPM device-key providers** (Windows Platform KSP and Ubuntu
  TPM2/OpenSSL) remain platform-limited rather than universal, with conditional
  build and simulator evidence. They are client-runtime integrations, not a
  hosted backend TPM claim.
* The **Windows and Linux device-bound desktop client** has a public C API and
  installed example with local workflow/build evidence. Live TPM/browser/backend
  qualification remains open; see :doc:`../api/device_identity`.

For exact ownership, release availability, limitations, public-document links,
and evidence selectors, consult ``registry.json``. Use
:doc:`../usage/Hardware-identifiers` for maintained hardware-strategy guidance;
historical analysis is retained only as audit evidence and is not a second
status source.

Registry identifiers: ``cpp-local-verification``, ``hardware-binding``,
``environment-aware-identification``, ``license-version-limits``,
``config-attestation``, ``protected-device-licensing``,
``backend-order-fulfillment``, ``admin-control-plane``,
``portal-self-service``, ``d1-backup-and-restore-drill``, ``python-sdk``,
``dotnet-sdk``, ``arm-support``, ``custom-execution-limits``,
``tpm-device-key-provider``, ``windows-device-bound-client``, and ``java-sdk``.
