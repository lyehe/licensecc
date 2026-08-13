Hosted service APIs
===================

Each deployed public Worker serves a same-origin ``GET /docs`` reference and
``GET /openapi.json`` document. Use the deployment's own document when making
requests: it describes that deployed version and requires no third-party CDN.
The tables below are rendered from the reviewed repository contract snapshots,
not copied from route implementation files.

Common response and authentication rules
----------------------------------------

* JSON operations use a flat ``{ ok, code?, ... }`` envelope. A successful
  HTTP transport does not imply an allowed licensing decision; inspect ``ok``
  and ``code``.
* Backend account operations use an account bearer when account isolation is
  enabled. Admin operations use the configured reader/admin authorization
  boundary. Portal operations bind data to the opaque customer session.
* Mutation retry behavior is operation-specific. Do not retry metering or an
  ambiguous mutation unless the operation documents an idempotency contract.
* ``/docs``, ``/openapi.json``, and health routes are meta surfaces and may be
  intentionally outside an individual service's operation inventory.

Licensing backend
-----------------

The backend owns online verification, leases, floating seats, metering,
usage reports, signed assertions, and order ingestion.

.. licensecc-openapi:: backend

Admin API
---------

The admin Worker owns operator reads and consequence-bearing mutations. Its
browser UI consumes the same API; the API contract remains authoritative for
non-browser clients.

.. licensecc-openapi:: admin

Customer portal API
-------------------

The portal owns session-bound customer reads, device release, downloads, and
floating-seat actions. It server-resolves customer and entitlement ownership
rather than trusting those identities from request bodies.

.. licensecc-openapi:: portal

Backup control API
------------------

The D1 backup Worker is an operator-only recovery service, not a public client
API, and therefore has no OpenAPI document. Its small authenticated control
surface is:

.. list-table::
   :header-rows: 1
   :widths: 12 33 55

   * - Method
     - Path
     - Purpose
   * - ``GET``
     - ``/health``
     - Report normalized backup configuration without exposing secrets.
   * - ``POST``
     - ``/backup/run``
     - Start a manual Workflow instance; requires the backup trigger bearer.
   * - ``GET``
     - ``/backup/status/:workflow_instance_id``
     - Read an authenticated Workflow instance status.

Backup deployment, retention, Time Travel, and scratch-restore procedures live
in ``services/cloudflare-d1-backup/README.md``.
