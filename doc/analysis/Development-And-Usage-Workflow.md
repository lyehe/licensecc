# Development and usage workflow

This page describes the accepted repository workflow for the `main` branch.
The root npm workspace is the command authority: install dependencies once with
the pinned npm version, then run the deterministic pull-request gate:

```powershell
npm ci
npm run check:pr
```

`check:pr` runs the deterministic secret, documentation-accuracy, capability,
lint, type, architecture, contract, and service checks. It intentionally does
not claim browser, SDK, dry-run, or documentation validation as part of that
single gate. Run the dedicated surfaces when the change requires them:

```powershell
npm run test:sdks
npm run setup:browsers
npm run test:e2e
npm run check:dry-run
npm run check:docs
```

The docs gate requires Doxygen and `uv`; link checking is network-sensitive and
is reserved for `npm run check:docs:links` scheduled or manual validation.

For C++ core changes, also run the build-purity gate for the selected preset:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset dev-debug
```

The Windows and Linux workflows run the same purity boundary around their
configured CMake presets. Service workflows use the root workspace commands,
including separate SDK and documentation jobs, rather than a second set of
workflow-only developer shortcuts.

## Generated project files

Licensecc needs a generated license project containing keys and generated
headers. By default, those files are written under the build tree:

```text
build/<preset>/projects/<project-name>
```

Use `LCC_PROJECTS_BASE_DIR` only when a workflow intentionally needs a stable
external project directory. Do not generate project material in the source
checkout.

## Integration workflow

1. Configure a C++ build with the selected project name.
2. Generate keys and the public-key header under the build tree or an explicit
   external project directory.
3. Link the C++ library into the protected product.
4. Issue a local license or configure the online backend lifecycle.
5. Validate the affected repository surfaces before release or deployment.

Keep real Wrangler configurations and secrets local. Track
`wrangler.example.*` templates, not deployment-specific `wrangler.toml`,
`wrangler.jsonc`, `.dev.vars`, or `.online-key/` files.
