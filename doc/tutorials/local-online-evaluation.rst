Evaluate online verification locally
====================================

Audience and result
-------------------

This entry point is for an evaluator who wants to exercise the real licensing
backend without creating Cloudflare resources. The backend's local host runs
the compiled Worker in Node, substitutes a SQLite adapter for the D1 binding,
and keeps the server on loopback by default.

At the end of the service-owned walkthrough, ``GET /health`` returns the
Licensecc verifier identity and a seeded ``POST /v1/verify`` returns an
``entitlement_ok`` response containing a signed ``lccoa1`` assertion.

Prerequisites and starting point
--------------------------------

You need Node 22.5 or newer, npm ``10.9.8``, and an HTTP client.
Starting directory: the Licensecc repository root. Shell: PowerShell or Bash.

Install the single root workspace, then move to the owning service:

.. code-block:: console

   npm ci
   cd services/cloudflare-licensing-backend

Continue with the `local SQLite host runbook
<https://github.com/lyehe/licensecc/tree/main/services/cloudflare-licensing-backend/local-host>`_.
It owns the exact build, migration, local signing-key, entitlement seed,
server, health, and verification commands. Keeping those commands beside the
service prevents this tutorial from becoming a second operational authority.

Safety boundary
---------------

The local host binds ``127.0.0.1`` by default. Its verification endpoint is a
signing oracle, so do not expose it to a network without the rate limiting,
proxy, TLS, and authentication controls required by the service runbook. Keep
the generated local key, SQLite database, and environment variables out of
source control.

This tutorial does not authorize ``wrangler deploy``, a remote migration, or a
production data mutation. When local evaluation is complete, use
:doc:`../operations/production-readiness` to review the separate production
gate and :doc:`../api/services` for the generated Worker API reference.

Troubleshooting and next step
-----------------------------

If Node reports that ``node:sqlite`` is unavailable, confirm ``node --version``
is at least 22.5 and use the package scripts, which supply the experimental
SQLite flag. If ``/health`` is unreachable, check the foreground server
terminal before changing database state. An ``entitlement_denied`` response
usually means the seeded project, feature, or fingerprint differs from the
request; use the service runbook's exact seed values.

After the local path succeeds, review :doc:`../operations/database-backends`
before choosing D1 or the fenced PostgreSQL work, then use
:doc:`../operations/production-readiness` before any hosted mutation.

Verification
------------

After the runbook, return from the backend service directory to the repository
root and validate the local service implementation. Starting directory: the
Licensecc repository root. Shell: PowerShell or Bash.

.. code-block:: console

   cd ../..
   npm run test:services

Use ``npm run check:dry-run`` only when you also need a credential-free proof
that every Worker bundle can be assembled from its example configuration.
