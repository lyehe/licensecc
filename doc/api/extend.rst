Extension points
================

Keep application transport, persistence, and policy at explicit public
boundaries. Do not subclass or include implementation headers from ``src/``.

Hardware identifiers
--------------------

.. _api/extend:Tweak hardware signature generator:

If the provided hardware signatures don't behave well for your customers, or you want to change the default
way the library generates the pc identifier you can have a look at the following section.

First of all be sure to read about the standard behavior of :c:func:`identify_pc` here:

:doc:`hardware_identifiers` documents strategy ordering and the supported C++
extension interface. Provider-backed device identity is a different surface;
see :doc:`device_identity`.

Supply a custom license source
------------------------------

Applications do not need to subclass an internal locator to load a license from
a database, secret store, embedded resource, or authenticated download. Fetch
the data in application code, copy it into a zero-initialized
:c:type:`LicenseLocation`, and pass that location to :c:func:`acquire_license`
or one of the decision APIs. This keeps network credentials, retries, trust
policy, and cancellation in the host application rather than in Licensecc.

For an in-memory INI license use ``LICENSE_PLAIN_DATA``:

.. code-block:: c

   LicenseLocation location = {0};
   location.license_data_type = LICENSE_PLAIN_DATA;
   if (license_text_length >= sizeof location.licenseData) {
       /* Reject: the public input is bounded and must remain NUL-terminated. */
       return LICENSE_MALFORMED;
   }
   memcpy(location.licenseData, license_text, license_text_length);
   location.licenseData[license_text_length] = '\0';

   CallerInformations caller;
   lcc_init_caller_informations(&caller);
   caller.magic = LCC_PROJECT_MAGIC_NUM;
   lcc_set_caller_feature_name(&caller, "my-feature");
   return acquire_license(&caller, &location, NULL);

``LICENSE_ENCODED`` accepts the same INI bytes in canonical standard Base64.
``LICENSE_PATH`` accepts one or more absolute or application-resolved file paths
separated by ``;``. A null location pointer leaves discovery to the configured
near-module and environment-variable strategies.

The input contract is deliberately strict:

* ``licenseData`` is at most ``LCC_API_MAX_LICENSE_DATA_LENGTH - 1`` bytes and
  must contain one terminating NUL followed only by zero-filled storage;
* plain or decoded data must be a complete INI license, not a URL or an HTTP
  response envelope;
* an encoded value must use canonical standard Base64; and
* the caller owns transport authentication, response-size limits, timeouts,
  TLS policy, and secure disposal of temporary buffers.

Malformed, oversized, hidden-after-NUL, missing, or unreadable input is rejected
through the normal audit events. Licensecc never downloads a URL supplied in a
license location and never falls back from malformed explicit data to a less
trusted source.

Host policy callbacks
---------------------

The public structures in :doc:`types` expose callbacks for host-integrity
checks, custom signed execution limits, online verification, revocation-floor
persistence, and configuration-sequence persistence. Keep each callback
bounded and deterministic. Return failure when durable state cannot be loaded
or stored; silently accepting an unavailable anti-rollback floor weakens the
decision contract.

.. toctree::
   :hidden:

   hardware_identifiers
