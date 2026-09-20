[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallPrefix,
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [string]$ProjectName = 'test',
    [string]$BuildDirectory = 'build/installed-java-device-bound'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'device-bound-exports.ps1')
if (-not $IsWindows) { throw 'The installed Java JNI gate requires Windows' }
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$prefix = [IO.Path]::GetFullPath($InstallPrefix, $repositoryRoot)
$outputRoot = [IO.Path]::GetFullPath($BuildDirectory, $repositoryRoot)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build')) + [IO.Path]::DirectorySeparatorChar
if (-not $outputRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'JNI output must be a child of the repository build directory'
}
$packageDirectory = Join-Path $prefix 'cmake/licensecc'
if (-not (Test-Path -LiteralPath (Join-Path $packageDirectory 'licensecc-config.cmake') -PathType Leaf)) {
    throw 'InstallPrefix must contain an installed Licensecc CMake package'
}
$bridgeSource = Join-Path $repositoryRoot 'sdks/java/native'
$bridgeInstall = Join-Path $outputRoot 'installed'
$testDll = Join-Path $bridgeInstall 'bin/licensecc_device_bound_jni.dll'
$previousDll = [Environment]::GetEnvironmentVariable('LCC_TEST_DEVICE_BOUND_JNI_DLL', 'Process')
$previousBad = [Environment]::GetEnvironmentVariable('LCC_TEST_BAD_JNI_DLL', 'Process')
$previousFixture = [Environment]::GetEnvironmentVariable('LCC_TEST_JNI_FIXTURE_DLL', 'Process')
function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
Push-Location $repositoryRoot
try {
    & (Join-Path $PSScriptRoot 'device-bound-exports.test.ps1')
    # No cleanup: a foreign cached source/generator is an error, not permission to reset it.
    Invoke-Checked 'cmake' @('-S', $bridgeSource, '-B', $outputRoot, '-G', 'Visual Studio 17 2022', '-A', 'x64',
        "-Dlicensecc_DIR=$packageDirectory", "-DLCC_PROJECT_NAME=$ProjectName", '-DLCC_JNI_BUILD_TESTS=ON')
    Invoke-Checked 'cmake' @('--build', $outputRoot, '--config', $Configuration, '-j', '4')
    Invoke-Checked 'cmake' @('--install', $outputRoot, '--config', $Configuration, '--prefix', $bridgeInstall)
    $linkers = @(Get-Content -LiteralPath (Join-Path $outputRoot 'CMakeCache.txt') | ForEach-Object {
        if ($_ -match '^CMAKE_LINKER:FILEPATH=(.+)$') { $Matches[1] }
    })
    if ($linkers.Count -ne 1) { throw 'Expected one configured MSVC linker' }
    $dumpbin = Join-Path (Split-Path -Parent $linkers[0]) 'dumpbin.exe'
    $exports = & $dumpbin /exports $testDll
    if ($LASTEXITCODE -ne 0) { throw 'JNI export inspection failed' }
    $expected = @('LIBRARY licensecc_device_bound_jni', 'EXPORTS') + @('version', 'openNative', 'invokeNative', 'prepareNative', 'simpleNative', 'closeNative' |
        ForEach-Object { "Java_io_licensecc_client_DeviceBoundNative_$_" })
    $expected += @('version', 'openNative', 'invokeNative', 'closeNative' |
        ForEach-Object { "Java_io_licensecc_client_FeatureSessionNative_$_" })
    $exportCount = Assert-DeviceBoundExports $exports $expected -Java
    $imports = & $dumpbin /dependents $testDll
    if ($LASTEXITCODE -ne 0) { throw 'JNI dependency inspection failed' }
    $dependencies = @(Get-DeviceBoundDependencies $imports)
    # These OS/CRT imports still require trusted JVM/application and Windows loader directories.
    # System.load does not impose Python/.NET's LOAD_LIBRARY_SEARCH_* dependency isolation.
    $allowed = @('kernel32.dll', 'advapi32.dll', 'bcrypt.dll', 'ncrypt.dll', 'crypt32.dll', 'winhttp.dll',
        'ws2_32.dll', 'shell32.dll', 'ole32.dll', 'user32.dll', 'msvcp140.dll', 'msvcp140d.dll',
        'vcruntime140.dll', 'vcruntime140d.dll', 'vcruntime140_1.dll', 'vcruntime140_1d.dll', 'ucrtbase.dll', 'ucrtbased.dll')
    foreach ($dependency in $dependencies) {
        if ($dependency -notin $allowed -and $dependency -notmatch '^api-ms-win-crt-[a-z0-9-]+-l1-1-0\.dll$') {
            throw "Unreviewed JNI dependency: $dependency"
        }
    }
    $env:LCC_TEST_DEVICE_BOUND_JNI_DLL = $testDll
    $env:LCC_TEST_BAD_JNI_DLL = Join-Path $outputRoot "$Configuration/licensecc_device_bound_jni_bad.dll"
    $env:LCC_TEST_JNI_FIXTURE_DLL = Join-Path $outputRoot "$Configuration/licensecc_device_bound_jni_fixture.dll"
    Invoke-Checked 'node' @('scripts/test-java-sdk.mjs')
    Write-Host "Installed Java adapter passed: $exportCount exact exports; imports: $($dependencies -join ', ')"
} finally {
    [Environment]::SetEnvironmentVariable('LCC_TEST_DEVICE_BOUND_JNI_DLL', $previousDll, 'Process')
    [Environment]::SetEnvironmentVariable('LCC_TEST_BAD_JNI_DLL', $previousBad, 'Process')
    [Environment]::SetEnvironmentVariable('LCC_TEST_JNI_FIXTURE_DLL', $previousFixture, 'Process')
    Pop-Location
}
