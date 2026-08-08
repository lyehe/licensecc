[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "check-build-purity.ps1")

function Assert-CmakeCondition {
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

function Invoke-FixtureConfigure {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Cmake,

        [Parameter(Mandatory = $true)]
        [string]$Source,

        [Parameter(Mandatory = $true)]
        [string]$Binary,

        [Parameter(Mandatory = $true)]
        [string]$Generator,

        [string]$ProjectsBase
    )

    $arguments = @(
        "-S", $Source,
        "-B", $Binary,
        "-DLCC_LOCATION=$Generator",
        "-DLCC_PROJECT_NAME=pathfixture",
        "-DBUILD_TESTING=OFF"
    )
    if ($ProjectsBase) {
        $arguments += "-DLCC_PROJECTS_BASE_DIR=$ProjectsBase"
    }

    $output = & $Cmake @arguments 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = [string]::Join("`n", @($output))
    }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$fixtureName = "task2-projects-base-" + [guid]::NewGuid().ToString("N")
$buildRoot = Join-Path $repositoryRoot "build/$fixtureName"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) $fixtureName
try {
    $expectedBuildParent = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "build"))
    $resolvedBuildRoot = [System.IO.Path]::GetFullPath($buildRoot)
    Assert-CmakeCondition -Condition $resolvedBuildRoot.StartsWith($expectedBuildParent, [System.StringComparison]::OrdinalIgnoreCase) -Message "fixture build root escaped build/"

    New-Item -ItemType Directory -Force -Path $buildRoot, $temporaryRoot | Out-Null
    $fakeGenerator = Join-Path $temporaryRoot "lccgen.exe"
    [System.IO.File]::WriteAllBytes($fakeGenerator, [byte[]]@())
    $cmake = Resolve-CmakeTool -Name "cmake"

    $defaultResult = Invoke-FixtureConfigure -Cmake $cmake -Source $repositoryRoot -Binary (Join-Path $buildRoot "default") -Generator $fakeGenerator
    Assert-CmakeCondition -Condition ($defaultResult.ExitCode -eq 0) -Message "default build-tree projects directory was rejected: $($defaultResult.Output)"

    $forbiddenResult = Invoke-FixtureConfigure -Cmake $cmake -Source $repositoryRoot -Binary (Join-Path $buildRoot "forbidden") -Generator $fakeGenerator -ProjectsBase (Join-Path $repositoryRoot "projects")
    Assert-CmakeCondition -Condition ($forbiddenResult.ExitCode -ne 0) -Message "source-tree projects directory was accepted"
    Assert-CmakeCondition -Condition ($forbiddenResult.Output -match "LCC_PROJECTS_BASE_DIR") -Message "forbidden source-tree failure was not actionable"

    if ($IsWindows) {
        $caseVariantProjects = Join-Path $repositoryRoot.ToLowerInvariant() "projects"
        $caseVariantResult = Invoke-FixtureConfigure -Cmake $cmake -Source $repositoryRoot -Binary (Join-Path $buildRoot "forbidden-case-variant") -Generator $fakeGenerator -ProjectsBase $caseVariantProjects
        Assert-CmakeCondition -Condition ($caseVariantResult.ExitCode -ne 0) -Message "case-variant source-tree projects directory was accepted"
        Assert-CmakeCondition -Condition ($caseVariantResult.Output -match "LCC_PROJECTS_BASE_DIR") -Message "case-variant source-tree failure was not actionable"
    }

    $externalBase = Join-Path $temporaryRoot "stable-projects"
    $externalResult = Invoke-FixtureConfigure -Cmake $cmake -Source $repositoryRoot -Binary (Join-Path $buildRoot "external") -Generator $fakeGenerator -ProjectsBase $externalBase
    Assert-CmakeCondition -Condition ($externalResult.ExitCode -eq 0) -Message "external stable projects directory was rejected: $($externalResult.Output)"

    $missingGenerator = Join-Path $temporaryRoot "missing-lccgen.exe"
    $strictLocationResult = Invoke-FixtureConfigure -Cmake $cmake -Source $repositoryRoot -Binary (Join-Path $buildRoot "strict-location") -Generator $missingGenerator
    Assert-CmakeCondition -Condition ($strictLocationResult.ExitCode -ne 0) -Message "an invalid explicit LCC_LOCATION fell back to another generator source"
    Assert-CmakeCondition -Condition ($strictLocationResult.Output -match "Unable to locate lccgen") -Message "invalid explicit LCC_LOCATION did not produce the recovery message"

    Write-Host "CMake project-base path fixtures passed."
} finally {
    if (Test-Path -LiteralPath $buildRoot) {
        Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
