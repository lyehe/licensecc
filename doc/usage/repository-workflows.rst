Use the Licensecc repository
============================

Licensecc is both a native licensing runtime and a platform monorepo. Start by
choosing the surface you need; most users do not need to build or deploy every
part of the repository.

Choose a workflow
-----------------

.. list-table::
   :header-rows: 1
   :widths: 23 39 38

   * - Goal
     - Start here
     - Main result
   * - Embed local license enforcement
     - :doc:`integration` and ``examples/minimal/README.md``
     - Installed CMake package and ``licensecc::licensecc_static`` target.
   * - Issue local license files
     - :doc:`issue-licenses`
     - A consumer-specific project and signed ``.lic`` files from ``lccgen``.
   * - Add online verification
     - ``services/cloudflare-licensing-backend/README.md`` and
       :doc:`../api/services`
     - Backend contract, D1 schema, and optional local SQLite host.
   * - Operate licenses and customers
     - Admin, portal, and backup READMEs under ``services/``
     - Separate operator, customer, and recovery surfaces.
   * - Verify tokens from another language
     - :doc:`../api/sdks` and the chosen SDK README
     - Python, .NET, or Java token verifier and HTTP client.
   * - Contribute to the repository
     - ``AGENTS.md``, :doc:`../architecture/index`, and
       :doc:`../development/Development-Environment-Setup`
     - An ownership-scoped change with reproducible validation.

Prepare a checkout
------------------

Clone the repository, validate the repository-owned generator, install the
root Node workspace, and inspect local readiness:

.. code-block:: powershell

   git clone https://github.com/lyehe/licensecc.git
   cd licensecc
   pwsh -NoProfile -File scripts/bootstrap.ps1 -CheckOnly
   npm ci
   npm run doctor

``npm run doctor`` is read-only. It distinguishes repository contract failures
from advisory local state such as an active branch or ignored build output.
The root ``package-lock.json`` is authoritative for all Node workspaces; do not
create service-local lockfiles.

Build and try the native runtime
--------------------------------

Build and install a runtime for one license project, then build the standalone
minimal consumer against that install:

.. code-block:: console

   cmake -S . -B build/myproject -DLCC_PROJECT_NAME=myproject -DCMAKE_INSTALL_PREFIX=<prefix>
   cmake --build build/myproject --target install
   cmake -S examples/minimal -B build/minimal -DCMAKE_PREFIX_PATH=<prefix> -DLCC_PROJECT_NAME=myproject
   cmake --build build/minimal

Run the resulting ``minimal`` program with a license path. The same
``LCC_PROJECT_NAME`` must be used by the runtime, consumer, and license
generator. Project generation creates consumer-specific signing material under
the build tree. Protect the private key, never embed it in an application, and
never include it in a release artifact.

For fail-closed feature checks, start with ``examples/fail_closed_host``. For
online callbacks and durable revocation floors, use
``examples/production_decision_host``. Provider-backed request proofs are
documented in :doc:`../api/device_identity` and
``examples/device_identity/README.md``.

Use an SDK
----------

The Python, .NET, and Java SDKs verify signed server tokens and wrap selected
HTTP operations. They do not implement local ``.lic`` acquisition, hardware
identification, or binary enforcement. Use the native runtime when those
properties matter.

Run all maintained SDK tests from the repository root:

.. code-block:: console

   npm run test:sdks

Each SDK README contains language-specific installation and examples. The
generated Python symbols and cross-language scope table are in
:doc:`../api/python` and :doc:`../api/sdks`.

Work with hosted services
-------------------------

Each deployable under ``services/`` owns its Worker, configuration example,
tests, and operational README. The public backend also provides a local SQLite
host for end-to-end development without a Cloudflare deployment. Start at
``services/cloudflare-licensing-backend/local-host/README.md`` when evaluating
online verification locally.

Run all service and schema checks with:

.. code-block:: console

   npm run test:services

Run ``npm run check:dry-run`` to validate all Worker bundles against example
configuration. A dry run does not authorize deployment. Never commit real
Wrangler configuration, ``.dev.vars``, tokens, keys, or local databases.

Validate a change
-----------------

The normal pull-request gate is deterministic from an intentionally classified
checkout:

.. code-block:: powershell

   npm ci
   npm run check:pr

Add the surface-specific gate when applicable:

.. list-table::
   :header-rows: 1
   :widths: 27 73

   * - Surface
     - Additional command
   * - C/C++ core
     - ``pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug``
   * - SDKs
     - ``npm run test:sdks``
   * - Browser workflows
     - ``npm run setup:browsers`` followed by ``npm run test:e2e``
   * - Worker packaging
     - ``npm run check:dry-run``
   * - Documentation
     - ``npm run check:docs``

Use :doc:`../development/documentation` for documentation details and the
:doc:`../architecture/change-guide` to find the narrow gate for a code change.

Use the repository Agent Skill
------------------------------

Agentskills-compatible coding tools can discover
``.agents/skills/using-licensecc/SKILL.md`` from the checkout. Invoke it
explicitly when a task crosses repository surfaces or the correct gate is not
obvious:

.. code-block:: text

   Use $using-licensecc to add a backend endpoint and run the required checks.
   Use $using-licensecc to explain how to build the minimal native consumer.
   Use $using-licensecc to update the Python SDK without changing token semantics.

The skill reads the same architecture, ownership, and service documentation as
human contributors. It does not grant permission to deploy, publish, delete
worktrees, or modify remote data.
