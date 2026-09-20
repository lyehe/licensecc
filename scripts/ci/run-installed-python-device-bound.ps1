[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallPrefix,
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [string]$ProjectName = 'test',
    [string]$BuildDirectory = 'build/installed-python-device-bound'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'device-bound-exports.ps1')
if (-not $IsWindows) { throw 'The installed Python bridge gate requires Windows' }
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$prefix = [IO.Path]::GetFullPath($InstallPrefix, $repositoryRoot)
$outputRoot = [IO.Path]::GetFullPath($BuildDirectory, $repositoryRoot)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build')) + [IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Bridge output must be a child of the repository build directory'
}
$packageDirectory = Join-Path $prefix 'cmake/licensecc'
if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory 'licensecc-config.cmake') -PathType Leaf)) {
    throw 'InstallPrefix must contain an installed Licensecc CMake package'
}
$bridgeSource = Join-Path $repositoryRoot 'sdks/python/native'
$bridgeInstall = Join-Path $outputRoot 'installed'
$testDll = Join-Path $bridgeInstall 'bin/licensecc_device_bound_bridge.dll'
$previousDll = [Environment]::GetEnvironmentVariable('LCC_TEST_DEVICE_BOUND_DLL', 'Process')
$previousOldDll = [Environment]::GetEnvironmentVariable('LCC_TEST_OLD_DEVICE_BOUND_DLL', 'Process')

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

Push-Location $repositoryRoot
try {
    & (Join-Path $PSScriptRoot 'device-bound-exports.test.ps1')
    # CMake rejects a foreign cached source/generator; never delete or reset it.
    Invoke-Checked 'cmake' @('-S', $bridgeSource, '-B', $outputRoot,
        '-G', 'Visual Studio 17 2022', '-A', 'x64', "-Dlicensecc_DIR=$packageDirectory", "-DLCC_PROJECT_NAME=$ProjectName", '-DLCC_BRIDGE_BUILD_TESTS=ON')
    Invoke-Checked 'cmake' @('--build', $outputRoot, '--config', $Configuration, '-j', '4')
    Invoke-Checked 'cmake' @('--install', $outputRoot, '--config', $Configuration, '--prefix', $bridgeInstall)

    $linkers = @(Get-Content -LiteralPath (Join-Path $outputRoot 'CMakeCache.txt') | ForEach-Object {
        if ($_ -match '^CMAKE_LINKER:FILEPATH=(.+)$') { $Matches[1] }
    })
    if ($linkers.Count -ne 1) { throw 'Expected one configured MSVC linker' }
    $dumpbin = Join-Path (Split-Path -Parent $linkers[0]) 'dumpbin.exe'
    if (-not (Test-Path -LiteralPath $dumpbin -PathType Leaf)) { throw 'Configured MSVC dumpbin is missing' }
    $exports = & $dumpbin /exports $testDll
    if ($LASTEXITCODE -ne 0) { throw 'Installed bridge export inspection failed' }
    $exportCount = Assert-DeviceBoundExports $exports (Get-Content -LiteralPath (Join-Path $bridgeSource 'bridge.def'))
    $oldDll = Join-Path $outputRoot "$Configuration/licensecc_device_bound_original.dll"
    $oldExports = & $dumpbin /exports $oldDll
    if ($LASTEXITCODE -ne 0) { throw 'Original export fixture inspection failed' }
    $oldDefinition = Get-Content -LiteralPath (Join-Path $bridgeSource 'bridge.def') | Where-Object { $_ -notmatch 'feature_session' }
    $null = Assert-DeviceBoundExports $oldExports $oldDefinition
    $imports = & $dumpbin /dependents $testDll
    if ($LASTEXITCODE -ne 0) { throw 'Installed bridge dependency inspection failed' }
    if ($imports -match '(?i)(?:lib)?(?:ssl|crypto)[^\s]*\.dll') { throw 'Unexpected OpenSSL DLL dependency' }

    # Require a real installed DLL, not the optional-test skip path. Invalid
    # native configuration is rejected before storage, key creation or network.
    $env:LCC_TEST_DEVICE_BOUND_DLL = $testDll
    $env:LCC_TEST_OLD_DEVICE_BOUND_DLL = $oldDll
    Invoke-Checked 'uv' @('run', '--directory', 'sdks/python', '--locked', 'pytest',
        'tests/test_device_bound_bridge.py', 'tests/test_feature_session_bridge.py')
    Write-Host "Installed Python bridge passed: $exportCount exact exports, ABI and lifecycle boundary tests; no provisioning"
} finally {
    [Environment]::SetEnvironmentVariable('LCC_TEST_DEVICE_BOUND_DLL', $previousDll, 'Process')
    [Environment]::SetEnvironmentVariable('LCC_TEST_OLD_DEVICE_BOUND_DLL', $previousOldDll, 'Process')
    Pop-Location
}
