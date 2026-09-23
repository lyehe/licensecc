#Requires -Version 7
<#
.SYNOPSIS
Configures, builds, and tests the examples/device_bound consumer against an
already-installed Licensecc package (Windows TPM or Linux TPM2/OpenSSL).

.DESCRIPTION
Generates a throwaway public/private RSA-3072 test key pair (the example
never contacts a backend or a real TPM in this mode), configures the example
with LCC_BOUND_EXAMPLE_TESTS=ON against the given install prefix, builds it,
and runs its isolated recovery-flow CTest suite.

The installed package's CMake config directory differs by platform
(Windows: <prefix>/cmake/licensecc; Linux/Unix: <prefix>/lib/cmake/licensecc).
This script auto-detects the correct directory by probing both layouts, so
callers only need to pass the install prefix. Pass -LicenseccDir to override.
#>
param(
    [Parameter(Mandatory)] [string] $InstallPrefix,
    [Parameter(Mandatory)] [string] $BuildDirectory,
    [string] $Configuration = 'Debug',
    [string] $Generator = $env:CMAKE_GENERATOR,
    [string] $LicenseccDir
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$exampleSource = Join-Path $repositoryRoot 'examples/device_bound'
$resolvedInstallPrefix = (Resolve-Path -LiteralPath $InstallPrefix).Path
$resolvedBuildDirectory = if ([System.IO.Path]::IsPathRooted($BuildDirectory)) {
    [System.IO.Path]::GetFullPath($BuildDirectory)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $BuildDirectory))
}
New-Item -ItemType Directory -Force $resolvedBuildDirectory | Out-Null

if ($LicenseccDir) {
    $packageDirectory = (Resolve-Path -LiteralPath $LicenseccDir).Path
    if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory 'licensecc-config.cmake'))) {
        throw "licensecc-config.cmake was not found in -LicenseccDir: $packageDirectory"
    }
} else {
    # Windows installs to <prefix>/cmake/licensecc; Linux/Unix installs to
    # <prefix>/lib/cmake/licensecc (see CMakeLists.txt pkg_config_dest).
    $packageDirectory = @(
        (Join-Path $resolvedInstallPrefix 'cmake/licensecc'),
        (Join-Path $resolvedInstallPrefix 'lib/cmake/licensecc')
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'licensecc-config.cmake') } | Select-Object -First 1
    if (-not $packageDirectory) {
        throw "Installed licensecc-config.cmake was not found below $resolvedInstallPrefix"
    }
}

$privateKey = Join-Path $resolvedBuildDirectory 'example-signing-key.pem'
$key = Join-Path $resolvedBuildDirectory 'example-signing-key.der'
# Public test key only: the example tests never contact a backend.
& openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out $privateKey
if ($LASTEXITCODE -ne 0) { throw 'openssl genpkey failed' }
& openssl pkey -in $privateKey -pubout -outform DER -out $key
if ($LASTEXITCODE -ne 0) { throw 'openssl pkey failed' }

# No generator requested: let CMake pick its own default instead of forcing one. An explicit
# generator (via -Generator, or its $env:CMAKE_GENERATOR default) is passed through, with
# -A x64 only for Windows' Visual Studio generators (Ninja and others reject -A).
$generatorArguments = if (-not $Generator) { @() } elseif ($IsWindows -and $Generator -like 'Visual Studio*') { @('-G', $Generator, '-A', 'x64') } else { @('-G', $Generator) }
# Every -D value is double-quoted deliberately: PowerShell mis-splits an
# unquoted "-DNAME=value" native-command argument into two argv entries when
# "value" contains two or more dots (confirmed with pwsh 7.6 independent of
# any shell wrapping it), silently truncating values such as a dotted
# application id. Quoting keeps each definition one argv entry.
& cmake -S $exampleSource -B $resolvedBuildDirectory @generatorArguments `
    "-DCMAKE_PREFIX_PATH=$resolvedInstallPrefix" "-Dlicensecc_DIR=$packageDirectory" `
    "-DLCC_PROJECT_NAME=test" "-DLCC_BOUND_EXAMPLE_TESTS=ON" `
    "-DLCC_BOUND_APPLICATION_ID=com.example.cad" "-DLCC_BOUND_ENDPOINT_ORIGIN=https://backend.test" `
    "-DLCC_BOUND_PORTAL_URL=https://portal.test/authorize" "-DLCC_BOUND_ISSUER=https://issuer.test/" `
    "-DLCC_BOUND_LEASE_AUDIENCE=CAD-client" "-DLCC_BOUND_PROOF_AUDIENCE=proof-audience" `
    "-DLCC_BOUND_PROJECT=CAD" "-DLCC_BOUND_FEATURE=DEFAULT" "-DLCC_BOUND_CLIENT_ID=CAD-client" `
    "-DLCC_BOUND_SIGNING_SPKI=$key"
if ($LASTEXITCODE -ne 0) { throw 'configure failed' }
& cmake --build $resolvedBuildDirectory --config $Configuration
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
& ctest --test-dir $resolvedBuildDirectory -C $Configuration --no-tests=error --output-on-failure
if ($LASTEXITCODE -ne 0) { throw 'example tests failed' }
