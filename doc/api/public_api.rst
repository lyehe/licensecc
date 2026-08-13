.. _api/public_api:Public api:

C runtime API
=============

The primary C API is declared in ``include/licensecc/licensecc.h``. Include it
for local license acquisition, fail-closed decisions, online verification,
configuration attestation, hardware identifiers, and compatibility entry
points. Device-key operations are a separate optional header documented in
:doc:`device_identity`; public structures and callbacks are indexed in
:doc:`types`.

Safe calling pattern
--------------------

* Call the matching ``lcc_init_*`` helper before setting a versioned structure.
* Treat :c:enum:`LCC_EVENT_TYPE` and the explicit decision field as the result;
  transport success alone is not a license grant.
* Keep callbacks, user-data pointers, and input buffers alive for the complete
  synchronous call that receives them.
* Use :c:func:`lcc_strerror` or :c:func:`print_error` for diagnostics, but do
  not make authorization decisions from message text.

Generated reference
-------------------

.. _api/public_api:Verify a license:

This section is generated directly from the public header. Keeping it as a
Doxygen group makes the strict documentation build fail when the documented
API group disappears or becomes malformed.

.. doxygengroup:: api
   :content-only:
