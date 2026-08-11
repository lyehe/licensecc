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
The separately tracked `release-toolchains.json` pins Python **3.12.8**, uv
**0.5.15**, and the .NET SDK **8.0.423**; `global.json` repeats the exact .NET
SDK with roll-forward disabled. These are build-tool authorities, not package
version authorities. The assembler checks all three executable version outputs
before any dependency install, and both release workflows use the same exact
setup-action values.
Before any install or build command, the canonical tree also runs the complete
repository version contract over every tracked projection (workspace and lock
inventory, OpenAPI and snapshots, SDK runtime metadata, maintained prose, the
capability registry, and C++ projections). Optional expected values only
assert those authorities:

```powershell
node scripts/assemble-release-artifacts.mjs `
  --output build/release-artifacts/acme-0.1.0-rc.1 `
  --repeat-output build/release-artifacts/acme-0.1.0-rc.1-repeat `
  --consumer-id acme `
  --expect-platform-version 0.1.0-rc.1 `
  --expect-python-version 0.1.0rc1
```

The output contains exactly four parsed Worker bundle directories, the Python
wheel and sdist, the primary NuGet package and matching `snupkg` symbol
package, and one
consumer-ID-labelled C++ source archive. `dotnet` is required by default;
`--allow-partial` is the explicit exception and records a boolean `incomplete`
field while omitting all NuGet payloads. The manifest records platform, Python,
C++, consumer, and exact HEAD identities plus the C++ archive hash. The
inspector recomputes the exact payload records, checksums, manifest, and SPDX
2.3 object, including the vendored generator BSD license and provenance. It
requires nonempty `index.html` plus built UI assets before the two UI-backed
Workers are bundled, and lexically checks nonempty Worker module entrypoints
without treating comment or string decoys as handlers. It parses ZIP/tar
internals: wheel/sdist member closure is derived from canonical HEAD and their
tracked member bytes are compared; wheel `RECORD` must cover every member with
the correct SHA-256 and size; generated metadata is parsed as RFC 822 headers.
Primary NuGet and `snupkg` archives have exact allowed member closure and a
valid OPC `[Content_Types].xml`/relationship/core-properties structure; their
`.nuspec` identities are XML-parsed, not regex-matched, and the managed DLL
and portable PDB require PE/`BSJB` signatures. The secret/forbidden-member
policy applies inside every package archive. A matching filename alone is
never sufficient.

The Python PEP 517 backend is pinned to Hatchling 1.27.0 in `pyproject.toml`.
The assembler first checks the canonical `uv.lock`, then invokes `uv build`
with the tracked hash-constrained `sdks/python/build-constraints.txt` and
`--require-hashes`. NuGet packaging
sets `SymbolPackageFormat=snupkg` both in the SDK project and the pack command.
Its locked restore targets only
`sdks/dotnet/src/Licensecc.Client/Licensecc.Client.csproj` and its tracked
`packages.lock.json`, using a generated canonical-only NuGet configuration,
package caches, and disabled persistent build servers so host-level NuGet
settings do not influence the staged payload.

The assembler derives `SOURCE_DATE_EPOCH` from the exact Git commit timestamp
and sets UTC, deterministic Python, and .NET reproducibility inputs in its
sanitized build environment. It makes .NET source paths stable, omits
Wrangler's timestamped README, makes Worker source-map roots bundle-relative,
and rewrites only NuGet's generated relationship/container metadata with
ordinal entry order and Git-timestamped ZIP headers. Runtime Worker JavaScript,
managed DLLs/PDBs, and all package metadata are parsed and validated before
and after that normalization. Passing `--repeat-output` performs two
independent canonical assemblies and fails unless every payload and metadata
byte matches.

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
and inspection twice in runner-local temporary staging. Pull requests run the
same real toolchain-backed double assembly (including the no-install CMake
archive verifier), rather than relying only on mocked unit tests. Neither
workflow has an upload, tag, publish, or deployment step.
