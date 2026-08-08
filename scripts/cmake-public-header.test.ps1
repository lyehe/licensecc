[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "check-build-purity.ps1")

function Assert-HeaderCondition {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-HeaderCmake {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Cmake,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    & $Cmake @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

function Invoke-HeaderCmakeExpectFailure {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Cmake,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $output = (& $Cmake @Arguments 2>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) {
        throw "$Name unexpectedly succeeded."
    }
    return $output
}

function New-FixtureGenerator {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    if ($IsWindows) {
        $path = Join-Path $Directory "lccgen-fixture.cmd"
        $content = @'
@echo off
setlocal EnableExtensions
set "project="
set "base="
:arguments
if "%~1"=="" goto generate
if /I "%~1"=="-n" (
  set "project=%~2"
  shift
  shift
  goto arguments
)
if /I "%~1"=="-p" (
  set "base=%~2"
  shift
  shift
  goto arguments
)
shift
goto arguments
:generate
set "include=%base%\%project%\include\licensecc\%project%"
if not exist "%include%" mkdir "%include%"
if not exist "%base%\%project%\private_key.rsa" > "%base%\%project%\private_key.rsa" echo deterministic-private-key
> "%include%\public_key.h" echo #define PRODUCT_NAME %project%
>> "%include%\public_key.h" echo #define PUBLIC_KEY {1}
>> "%include%\public_key.h" echo #define PUBLIC_KEY_LEN 1
exit /b 0
'@
        [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
        return $path
    }

    $path = Join-Path $Directory "lccgen-fixture.sh"
    $content = @'
#!/bin/sh
project=""
base=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n) project="$2"; shift 2 ;;
    -p) base="$2"; shift 2 ;;
    *) shift ;;
  esac
done
include="$base/$project/include/licensecc/$project"
mkdir -p "$include"
if [ ! -f "$base/$project/private_key.rsa" ]; then
  printf '%s\n' deterministic-private-key > "$base/$project/private_key.rsa"
fi
printf '%s\n' "#define PRODUCT_NAME $project" "#define PUBLIC_KEY {1}" "#define PUBLIC_KEY_LEN 1" > "$include/public_key.h"
'@
    [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
    & chmod +x $path
    if ($LASTEXITCODE -ne 0) {
        throw "Could not mark the fixture generator executable."
    }
    return $path
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$fixtureName = "task2-public-header-" + [guid]::NewGuid().ToString("N")
$buildRoot = Join-Path $repositoryRoot "build/$fixtureName"
$testSupportFailureRoot = Join-Path $repositoryRoot "build/$fixtureName-tests-on"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) $fixtureName
try {
    $buildParent = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "build")).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $resolvedBuildRoot = [System.IO.Path]::GetFullPath($buildRoot)
    $buildPrefix = "$buildParent$([System.IO.Path]::DirectorySeparatorChar)"
    Assert-HeaderCondition -Condition ($resolvedBuildRoot.StartsWith($buildPrefix, [System.StringComparison]::OrdinalIgnoreCase)) -Message "fixture build root escaped build/"
    New-Item -ItemType Directory -Force -Path $buildRoot, $temporaryRoot | Out-Null
    $cmake = Resolve-CmakeTool -Name "cmake"
    $generator = New-FixtureGenerator -Directory $temporaryRoot
    $externalProjects = Join-Path $temporaryRoot "stable-projects"
    $installRoot = Join-Path $buildRoot "install"
    $projectName = "keyfixture"
    $publicHeader = Join-Path $externalProjects "$projectName/include/licensecc/$projectName/public_key.h"
    $privateKey = Join-Path $externalProjects "$projectName/private_key.rsa"

    $testSupportFailureOutput = Invoke-HeaderCmakeExpectFailure -Cmake $cmake -Name "external executable test-support configure" -Arguments @(
        "-S", $repositoryRoot,
        "-B", $testSupportFailureRoot,
        "-DLCC_LOCATION=$generator",
        "-DLCC_PROJECT_NAME=$projectName",
        "-DLCC_PROJECTS_BASE_DIR=$externalProjects",
        "-DBUILD_TESTING=ON"
    )
    Assert-HeaderCondition -Condition ($testSupportFailureOutput -match [regex]::Escape("BUILD_TESTING=ON requires generator test support")) -Message "external executable BUILD_TESTING=ON did not fail with the generator test-support guidance"

    Invoke-HeaderCmake -Cmake $cmake -Name "fixture configure" -Arguments @(
        "-S", $repositoryRoot,
        "-B", $buildRoot,
        "-DLCC_LOCATION=$generator",
        "-DLCC_PROJECT_NAME=$projectName",
        "-DLCC_PROJECTS_BASE_DIR=$externalProjects",
        "-DCMAKE_INSTALL_PREFIX=$installRoot",
        "-DCPACK_TOPLEVEL_DIRECTORY=$(Join-Path $buildRoot 'cpack-work')",
        "-DCPACK_PACKAGE_DIRECTORY=$(Join-Path $buildRoot 'cpack-output')",
        "-DBUILD_TESTING=OFF"
    )
    Invoke-HeaderCmake -Cmake $cmake -Name "public header generation" -Arguments @("--build", $buildRoot, "--target", "project_public_header")
    Assert-HeaderCondition -Condition (Test-Path -LiteralPath $publicHeader -PathType Leaf) -Message "public header was not generated"
    Assert-HeaderCondition -Condition (Test-Path -LiteralPath $privateKey -PathType Leaf) -Message "fixture private key was not generated externally"
    $privateKeyHash = Get-FileHashValue -Path $privateKey

    Remove-Item -LiteralPath $publicHeader -Force
    Invoke-HeaderCmake -Cmake $cmake -Name "clean public header rebuild" -Arguments @("--build", $buildRoot, "--target", "project_public_header", "--clean-first")
    Assert-HeaderCondition -Condition (Test-Path -LiteralPath $publicHeader -PathType Leaf) -Message "public header was not regenerated after clean"
    Assert-HeaderCondition -Condition ($privateKeyHash -eq (Get-FileHashValue -Path $privateKey)) -Message "external private key changed during public-header clean/regeneration"

    Invoke-HeaderCmake -Cmake $cmake -Name "fixture install build" -Arguments @("--build", $buildRoot, "--target", "install", "--config", "Release")
    $installedPrivateKeys = @(Get-ChildItem -LiteralPath $installRoot -Recurse -File -Filter "private_key.rsa" -ErrorAction SilentlyContinue)
    Assert-HeaderCondition -Condition ($installedPrivateKeys.Count -eq 0) -Message "private key was installed"
    Assert-HeaderCondition -Condition (Test-Path -LiteralPath (Join-Path $installRoot "include/licensecc/$projectName/public_key.h") -PathType Leaf) -Message "public header was not installed"

    Write-Host "Public-header generation and install fixtures passed."
} finally {
    if (Test-Path -LiteralPath $buildRoot) {
        Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $testSupportFailureRoot) {
        Remove-Item -LiteralPath $testSupportFailureRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
