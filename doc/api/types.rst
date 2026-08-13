Runtime data types
==================

The public structures are versioned or initialized through their matching
``lcc_init_*`` function. Zero-initialize storage first when interoperating
across a foreign-function boundary, call the initializer, and populate only
documented fields. Fixed-size strings must be NUL-terminated and must not hide
data after their first NUL.

The generated reference below comes from
``include/licensecc/datatypes.h``.

.. doxygengroup:: apistruct
   :content-only:
