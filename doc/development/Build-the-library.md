# Build - Linux

## Build contract

This page describes the maintained Linux build path. The platform is **0.1.0
prerelease**: source and automated checks are accepted-repository evidence, not
a claim that binaries are published, remote CI is current, or an Ubuntu release
has been attested. The root `README.md` and `AGENTS.md` are the current command
authority.

Install CMake 3.21 or later, a C++17 compiler, OpenSSL, Zlib where required,
and the Boost development components used by the generator/tests. Package names
vary by distribution; use the root README as the maintained dependency list.

Before configuring, validate the vendored generator without changing it:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-build-purity.ps1 -Preset dev-debug
```

Generate project material under the active build tree or an explicitly external
`LCC_PROJECTS_BASE_DIR`; never under the source checkout.

## Configure, build, and test

From the repository root:

```console
cmake --preset dev-debug
cmake --build --preset dev-debug
ctest --preset dev-debug
```

The purity command above runs the same preset and is required for core changes.
Use a separate build directory for each project/key configuration. `LCC_LOCATION`
can select a standalone generator executable, installation prefix, or CMake
package location. A raw external generator executable is production-only, so
configure with `-DBUILD_TESTING=OFF` for that mode.

## Documentation

Install the pinned documentation dependencies with `uv` and run the repository
docs command:

```console
uv pip sync doc/requirements.txt
npm run check:docs
```

The docs gate requires Doxygen and writes only ignored `doc/_build` and
`doc/_doxygen` output directories. Use `npm run check:docs:links` only for
scheduled or manual network validation.
