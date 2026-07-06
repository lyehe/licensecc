# Development and usage workflow

This document describes the current development workflow for the `main` branch.

## Development workflow

The current public branch for normal development is `main`.

Before opening or reviewing a C++ core change, run the local core verification command:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1
```

Equivalent preset commands:

```console
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --preset dev-debug
```

The local command is the source of truth for developer parity. GitHub Actions should run the same CMake shape rather than carrying workflow-only build behavior.
The existing Linux and Windows workflows call `scripts/dev-check.ps1` with CI presets instead of duplicating CMake commands. Linux uses `ci-linux-debug` and `ci-linux-release`; Windows uses explicit Debug/Release static/dynamic MSVC presets.

For service, SDK, database-backend, and portal changes, run the matching local gates:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeServices -IncludeUi -IncludeSchemaParity
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeE2E
powershell -ExecutionPolicy Bypass -File scripts/dev-check.ps1 -SkipCore -IncludeSdks
```

Root npm shortcuts call the same PowerShell script for common service workflows:

```powershell
npm run check:services
npm run check:e2e
npm run check:all
```

## Generated project files

Licensecc needs a generated license project containing keys and generated headers. By default, those files are written under the build tree:

```text
build/<preset>/projects/<project-name>
```

Use `LCC_PROJECTS_BASE_DIR` only when a workflow intentionally needs a stable external project directory.

## Release build contents

A release should contain:

- the license generator executable (`lccgen`) or a documented way to obtain it,
- the configured or configurable `licensecc` library artifacts,
- public headers,
- integration examples,
- enough test or smoke-test material to verify the package,
- license and source-notice files required by AGPL-3.0-or-later.

## Integration workflow

1. Build or obtain the license generator.
2. Configure `licensecc` with a project name.
3. Generate the project keys and public-key header under the build tree or an explicitly supplied project directory.
4. Link the C++ library into the protected product.
5. Issue a license file for the customer or machine.
6. Ship the application with the runtime license-checking path documented for operators.

## Platform workflow

Service, SDK, database-backend, and portal work is handled in deliberate slices. Each slice needs local validation before CI wiring:

- backend unit and DB tests,
- SQLite local backend tests,
- fenced PostgreSQL/Supabase adapter tests when applicable,
- SDK unit tests,
- portal UI and E2E tests,
- deployment dry-runs using example configuration files rather than local secrets.

Keep real Wrangler configs and secrets local. Track `wrangler.example.*` templates, not deployment-specific `wrangler.toml`, `wrangler.jsonc`, `.dev.vars`, or `.online-key/` files.
