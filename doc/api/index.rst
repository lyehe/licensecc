API reference
=============

Use the reference that matches the boundary you integrate. The C runtime is
the on-device enforcement surface. The Worker contracts are HTTP/OpenAPI
surfaces. The language SDKs verify signed tokens and wrap selected backend
operations; they do not replace the C runtime's local enforcement.

Runtime library
---------------

* :doc:`public_api` — license acquisition, decisions, online verification,
  configuration attestation, and compatibility entry points.
* :doc:`types` — public structures, enums, callbacks, limits, and result data.
* :doc:`device_identity` — provider-backed P-256 keys and signed request
  proofs.
* :doc:`extend` — supported host callbacks, hardware-identifier strategies,
  and application-owned license sources.

Hosted services and SDKs
------------------------

* :doc:`services` — the canonical backend, admin, and customer-portal OpenAPI
  operation inventories, plus the private backup control surface.
* :doc:`python` — generated Python verifier and HTTP-client reference.
* :doc:`sdks` — scope and entry points for the Python, .NET, and Java SDKs.

Reference policy
----------------

Generated C/C++ sections come from public headers through Doxygen and Breathe.
Python sections come from the installed package through Sphinx autodoc. Worker
tables come from the reviewed contract snapshots under ``test/contracts``.
These sources are part of the strict ``npm run check:docs`` build, so a stale
symbol, import failure, or route-count mismatch fails documentation CI.

.. toctree::
   :maxdepth: 2

   public_api
   types
   device_identity
   services
   python
   sdks
   extend
