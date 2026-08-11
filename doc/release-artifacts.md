# Release artifact staging

`scripts/assemble-release-artifacts.mjs` assembles only local, inspectable
release evidence. It never tags, publishes, deploys a Worker, or uses a real
Wrangler configuration. It requires an empty output directory and a consumer
ID. Versions are read from tracked `version.json`, `sdks/python/pyproject.toml`,
and the independent CMake project declaration; optional expected values only
assert that authority:

```powershell
node scripts/assemble-release-artifacts.mjs `
  --output build/release-artifacts/acme-0.1.0-rc.1 `
  --consumer-id acme `
  --expect-platform-version 0.1.0-rc.1 `
  --expect-python-version 0.1.0rc1
```

The C++ tarball is source-only and consumer-ID-labelled. It contains canonical
tracked Git blobs for the runtime and its vendored generator source; it does
not contain an install tree, CI binaries, database state, or generated keys.
Consumers generate and retain their own signing keys during their own build or
deployment process. No private key is accepted or packaged by this command.

The command builds admin and portal assets in a temporary staging directory,
then runs each Worker through the local lockfile-pinned Wrangler in
`deploy --dry-run` mode. It emits a valid SPDX 2.3 document with checked
license inputs, including the vendored generator's BSD license and provenance.
`dotnet` is required by default; `--allow-partial` is an explicit exception and
marks the manifest incomplete when the .NET toolchain is unavailable.
