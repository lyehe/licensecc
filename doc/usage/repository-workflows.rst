Use the Licensecc repository
============================

Licensecc is a native runtime and a platform monorepo. Choose the outcome first
and install only the toolchain that outcome needs.

Choose a workflow
-----------------

.. list-table::
   :header-rows: 1
   :widths: 25 39 36

   * - Goal
     - Start here
     - Main result
   * - Try local ``.lic`` enforcement
     - :doc:`../tutorials/offline-first-license`
     - The minimal consumer accepts a license you just issued.
   * - Embed the native runtime
     - :doc:`integration`
     - An installed, project-specific CMake component linked by your host.
   * - Explore stronger host policies
     - :doc:`examples`
     - A maintained example for fail-closed, online, integrity, or device-key
       behavior.
   * - Evaluate online verification locally
     - :doc:`../tutorials/local-online-evaluation`
     - The real backend Worker running on a loopback SQLite host.
   * - Use a language SDK or support tool
     - :doc:`../tutorials/sdk-and-support`
     - Python, .NET, or Java token verification, or native support diagnostics.
   * - Operate services
     - :doc:`../operations/index`
     - Explicit readiness, database, observability, security, and release gates.
   * - Contribute to the repository
     - :doc:`../architecture/index` and
       :doc:`../development/Development-Environment-Setup`
     - An ownership-scoped change with reproducible verification evidence.

Prerequisites by workflow
-------------------------

.. list-table::
   :header-rows: 1
   :widths: 24 76

   * - Workflow
     - Required tools
   * - Native first success
     - Git, CMake 3.21+, a C++17 compiler, Boost, and the platform dependencies
       named in :doc:`../development/Dependencies`.
   * - Python SDK consumer
     - Python supported by the SDK and the package-local installation method.
   * - .NET SDK consumer
     - .NET 8 SDK.
   * - Java SDK consumer
     - JDK 17 or newer.
   * - Local online evaluator
     - Node 22+ and root npm ``10.9.8`` install; no Cloudflare account.
   * - Repository contributor
     - PowerShell 7, Node 22+, npm ``10.9.8``, Python 3.12, uv ``0.12.5``,
       JDK 17.0.20, and only the optional platform tools required by the
       changed surface. Doxygen is required for documentation builds.

The contributor toolchain is not a product prerequisite. A native integrator
does not need Node, Python, or Java, and an SDK consumer does not need a C++
compiler unless the application also embeds native enforcement.

Prepare a product checkout
--------------------------

Starting directory: the parent directory where you keep source checkouts.
Shell: any shell with Git available.

.. code-block:: console

   git clone https://github.com/lyehe/licensecc.git
   cd licensecc

The repository already contains the reviewed generator source. Native builds
write generated projects, keys, and install artifacts below ``build/`` by
default. Start with :doc:`../tutorials/offline-first-license`; do not run the
monorepo install merely to try the C++ runtime.

Use an SDK
----------

The SDKs verify signed server tokens and wrap selected backend HTTP operations.
They do not implement local ``.lic`` acquisition, hardware identification, or
binary enforcement. Use the native runtime when those properties matter.

The generated Python reference and cross-language scope table are in
:doc:`../api/python` and :doc:`../api/sdks`. Package-local installation and
examples remain owned by each SDK README. Maintainers run all three compatibility
suites from the repository root with:

.. code-block:: console

   npm run test:sdks

Evaluate or operate services
----------------------------

Each directory under ``services/`` is an independent deployable with its own
configuration example, tests, and operational README. All six Node workspaces
share the root lockfile, so run ``npm ci`` once at the repository root; a
service-local ``npm ci`` is unsupported.

The backend's SQLite host provides local end-to-end evaluation without a
Cloudflare deployment. :doc:`../tutorials/local-online-evaluation` routes to
that service-owned runbook. Use :doc:`../operations/production-readiness` only
when planning an authorized deployment.

From the repository root, the service and packaging checks are:

.. code-block:: console

   npm run test:services
   npm run check:dry-run

``check:dry-run`` assembles bundles using example configuration. It does not
authorize deployment. Never commit real Wrangler configuration, ``.dev.vars``,
tokens, signing keys, or local databases.

Validate a repository change
----------------------------

Read :doc:`../architecture/change-guide` and
:doc:`../architecture/ownership` before editing. Preserve pre-existing and
concurrent worktree changes. The deterministic pull-request gate starts from
one root install:

.. code-block:: powershell

   npm ci
   npm run check:pr

Add the gate for every changed surface:

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
   * - Native install, issuance, or ``examples/minimal`` documentation
     - ``npm run test:docs-quickstart``
   * - External links
     - ``npm run check:docs:links`` during scheduled/manual network validation

A useful handoff names the changed ownership boundary, exact commands and
results, remaining untested surfaces, and any generated local state. The phrase
"all green" alone is not evidence of the dedicated SDK, browser, dry-run,
documentation, link, or native purity gates.

Use the repository Agent Skill
------------------------------

Agent-Skills-compatible coding tools can discover
``.agents/skills/using-licensecc/SKILL.md`` from the checkout. Invoke it when a
task crosses surfaces or the owning gate is not obvious:

.. code-block:: text

   Use $using-licensecc to add a backend endpoint and run the required checks.
   Use $using-licensecc to explain how to build the minimal native consumer.
   Use $using-licensecc to update the Python SDK without changing token semantics.

The skill routes an agent to these same human-readable architecture and
service authorities. It does not grant permission to deploy, publish, delete
worktrees, rotate secrets, or mutate remote data.
