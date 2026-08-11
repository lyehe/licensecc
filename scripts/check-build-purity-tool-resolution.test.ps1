[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "check-build-purity.ps1")

function Assert-ToolResolutionCondition {
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

function New-ApplicationCandidate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return [pscustomobject]@{
        Source = $Path
        Path = $Path
    }
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("licensecc-cmake-tool-resolution-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $alphaTool = Join-Path $fixtureRoot "a-cmake.exe"
    $zuluTool = Join-Path $fixtureRoot "z-cmake.exe"
    New-Item -ItemType File -Path $alphaTool, $zuluTool | Out-Null
    $normalizedAlphaTool = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $alphaTool).Path)
    $normalizedZuluTool = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $zuluTool).Path)

    $neverValid = { param([string]$Tool) $false }
    $zeroCandidateFailure = $null
    try {
        Resolve-CmakeTool -Name "cmake" -CommandResolver { param([string]$CommandName) @() } -ToolValidator $neverValid | Out-Null
    } catch {
        $zeroCandidateFailure = $_.Exception.Message
    }
    Assert-ToolResolutionCondition -Condition ($zeroCandidateFailure -match "no usable executable passed '--version'") -Message "zero candidates did not produce the usable-tool failure"

    $oneCandidateValidator = {
        param([string]$Tool)
        $Tool -eq $normalizedAlphaTool
    }.GetNewClosure()
    $oneCandidate = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        New-ApplicationCandidate -Path $alphaTool
    }.GetNewClosure() -ToolValidator $oneCandidateValidator
    Assert-ToolResolutionCondition -Condition ($oneCandidate -is [string]) -Message "one candidate did not resolve to a string"
    Assert-ToolResolutionCondition -Condition ($oneCandidate -eq $normalizedAlphaTool) -Message "one candidate did not resolve to its normalized executable path"

    $multipleCandidateValidator = {
        param([string]$Tool)
        $Tool -in @($normalizedAlphaTool, $normalizedZuluTool)
    }.GetNewClosure()
    $multipleCandidate = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        @(
            New-ApplicationCandidate -Path $zuluTool
            New-ApplicationCandidate -Path $alphaTool
            New-ApplicationCandidate -Path $zuluTool
        )
    }.GetNewClosure() -ToolValidator $multipleCandidateValidator
    Assert-ToolResolutionCondition -Condition ($multipleCandidate -is [string]) -Message "multiple candidates did not resolve to exactly one string"
    Assert-ToolResolutionCondition -Condition ($multipleCandidate -eq $normalizedAlphaTool) -Message "multiple candidates were not selected by normalized ordinal path order"

    Write-Host "CMake tool resolution fixtures passed."
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
