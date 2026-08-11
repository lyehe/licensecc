# Dependencies

Licensecc’s maintained source-build contract is a C++17 compiler, CMake 3.21
or later, OpenSSL, Zlib where required by the selected OpenSSL configuration,
and the Boost development components used by the vendored generator and tests.
The C++ runtime keeps downstream link requirements minimal; the generator and
test suite require their configured Boost components.

Use a current supported Linux distribution or Visual Studio 2022 on Windows,
then follow the root `README.md` and `AGENTS.md` for current prerequisite and
validation commands. This project does not publish a frozen distribution,
compiler, or binary compatibility matrix in this page.

The vendored generator is already present in the checkout. Before configuring,
validate it without modifying source:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1 -CheckOnly
```

Generate project material under the selected build tree or an explicit external
`LCC_PROJECTS_BASE_DIR`. Do not put generated keys or projects in the source
checkout.
