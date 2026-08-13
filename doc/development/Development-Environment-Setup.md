# Developer environment setup

Licensecc does not require a particular editor or IDE. Use an environment that
can invoke the checked-in CMake presets and the repository-level npm commands;
the command line remains the reproducible boundary used by CI.

## Required tools

Install the platform prerequisites listed in {doc}`Dependencies`, plus:

- PowerShell 7 (`pwsh`) on Windows or Linux;
- Node.js 22 and npm 10.9.8 for repository orchestration;
- Python 3.12 with uv 0.5.15 for SDK, schema, and documentation checks; and
- `clang-format` for C and C++ formatting.

Visual Studio 2022 is the supported Windows C++ environment. On Linux, a C++17
compiler, CMake, Ninja, OpenSSL, Zlib, and the required Boost development
packages provide the equivalent command-line environment.

## First checkout

From the repository root:

```powershell
pwsh -NoProfile -File scripts/bootstrap.ps1 -CheckOnly
npm ci
npm run doctor
npm run check:pr
```

`npm run doctor` is read-only and reports local tool, checkout, and ignored
output state. For native changes, also run the purity build so generated
projects and vendored generator inputs cannot modify source files:

```powershell
pwsh -NoProfile -File scripts/check-build-purity.ps1 -Preset dev-debug
```

See {doc}`Build-the-library` for manual CMake commands and
{doc}`documentation` for the strict documentation build.

## Editor integration

Configure the editor to consume `compile_commands.json` from a Ninja preset or
the generated Visual Studio solution. Run repository commands in a terminal
instead of replacing them with editor-only tasks. Formatting integrations are
optional, but committed C/C++ changes must match the repository's
`.clang-format` policy.
