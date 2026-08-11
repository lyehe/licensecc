# Release artifact staging

`scripts/assemble-release-artifacts.mjs` is a local release-candidate evidence
tool. It never tags, publishes, uploads, deploys a Worker, or reads a real
Wrangler configuration. Its only Worker operation is the lockfile-pinned local
Wrangler `deploy --dry-run` bundle command against each tracked example config.

The command materializes regular files from the exact Git `HEAD` tree into an
owned temporary source tree before it builds anything. It runs a locked npm
install there with a sanitized environment, then builds the admin and portal
UI assets and all four Worker bundles from that tree. Python and .NET packaging
also use the canonical tree; a mutable checkout, ignored `.dev.vars`, local
Wrangler configuration, local database, or existing build output is not an
input.

The output must be new and either outside the checkout or below
`build/release-artifacts/`. The command checks lexical and real paths before
and after creation, rejects symlink/junction aliases, and only removes staging
that carries its own verified ownership marker.

Versions come from the same hardened readers used by
`scripts/check-version-contract.mjs`: tracked `version.json` is the sole
platform authority, the Python PEP 440 form is derived and checked, and the
CMake `project(licensecc VERSION ...)` remains the independent C++ authority.
Optional expected values only assert those authorities:

```powershell
node scripts/assemble-release-artifacts.mjs `
  --output build/release-artifacts/acme-0.1.0-rc.1 `
  --consumer-id acme `
  --expect-platform-version 0.1.0-rc.1 `
  --expect-python-version 0.1.0rc1
```

The output contains exactly four Worker bundle directories, the Python wheel
and sdist, the primary NuGet package and matching symbol package, and one
consumer-ID-labelled C++ source archive. `dotnet` is required by default;
`--allow-partial` is the explicit exception and records a boolean `incomplete`
field while omitting all NuGet payloads. The manifest records platform, Python,
C++, consumer, and exact HEAD identities plus the C++ archive hash. The
inspector recomputes the exact payload records, checksums, manifest, and SPDX
2.3 object, including the vendored generator BSD license and provenance.

The C++ archive is built from ordinal-sorted canonical Git blobs only. It
contains the curated runtime CMake/include/source inputs and the vendored
generator's CMake/source/license/provenance closure, never CI install binaries,
tests, generated keys, private keys, or generic consumer keys. A consumer
generates and retains any signing keys during its own build or deployment; no
key is accepted or packaged here.

Before metadata succeeds, the assembler parses and safely extracts its own
archive into an owned temporary directory, configures and builds the embedded
`lccgen`, then configures the extracted root with the documented
`-DLCC_LOCATION=<built lccgen>` selector and builds `licensecc_static` with
`BUILD_TESTING=OFF`. It supplies an install prefix only inside that temporary
directory and never invokes `cmake --install`.

Run the deterministic coverage locally with:

```powershell
npm run test:release-artifacts
```

The manual **Release artifact dry-run** workflow performs the same assembly
and inspection in runner-local temporary staging. It has no upload, tag,
publish, or deployment step.
