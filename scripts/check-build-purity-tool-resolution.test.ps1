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
        [string]$Path,

        [ValidateSet("Source", "Path", "Both")]
        [string]$Property = "Both"
    )

    $properties = [ordered]@{}
    if ($Property -eq "Source" -or $Property -eq "Both") {
        $properties.Source = $Path
    }
    if ($Property -eq "Path" -or $Property -eq "Both") {
        $properties.Path = $Path
    }
    return [pscustomobject]$properties
}

function New-ToolFixture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [int]$VersionExitCode
    )

    if ($IsWindows) {
        Set-Content -LiteralPath $Path -Value "@echo off`r`nif `"%~1`"==`"--version`" exit /b $VersionExitCode`r`nexit /b $VersionExitCode`r`n" -NoNewline
    } else {
        Set-Content -LiteralPath $Path -Value "#!/bin/sh`nif [ `"`$1`" = `"--version`" ]; then exit $VersionExitCode; fi`nexit $VersionExitCode`n" -NoNewline
        & chmod +x $Path
        if ($LASTEXITCODE -ne 0) {
            throw "Could not make fixture tool executable."
        }
    }

    return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("licensecc-cmake-tool-resolution-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $extension = if ($IsWindows) { ".cmd" } else { ".sh" }
    $invalidTool = New-ToolFixture -Path (Join-Path $fixtureRoot "a-invalid$extension") -VersionExitCode 1
    $firstValidTool = New-ToolFixture -Path (Join-Path $fixtureRoot "z-first$extension") -VersionExitCode 0
    $secondValidTool = New-ToolFixture -Path (Join-Path $fixtureRoot "a-second$extension") -VersionExitCode 0
    $fallbackTool = New-ToolFixture -Path (Join-Path $fixtureRoot "vs-fallback$extension") -VersionExitCode 0
    $applicationInfo = Get-Command -Name $firstValidTool -CommandType Application -ErrorAction Stop

    $puritySource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "check-build-purity.ps1") -Raw
    Assert-ToolResolutionCondition -Condition ($puritySource -match 'Get-Command\s+\$CommandName\s+-CommandType\s+Application\s+-All') -Message "production command resolution must request all application candidates in PowerShell precedence order"
    Assert-ToolResolutionCondition -Condition (Test-CmakeTool -Tool $firstValidTool) -Message "valid fixture tool did not pass the production version probe"
    Assert-ToolResolutionCondition -Condition (-not (Test-CmakeTool -Tool $invalidTool)) -Message "invalid fixture tool passed the production version probe"

    $normalizedCandidates = @(Get-NormalizedToolCandidates -Candidates @(
        $secondValidTool
        (New-ApplicationCandidate -Path $firstValidTool -Property "Source")
        (New-ApplicationCandidate -Path $secondValidTool -Property "Path")
        $applicationInfo
    ))
    Assert-ToolResolutionCondition -Condition ($normalizedCandidates.Count -eq 2) -Message "candidate normalization did not remove duplicate executable paths"
    Assert-ToolResolutionCondition -Condition ($normalizedCandidates[0] -eq $secondValidTool) -Message "candidate normalization did not preserve the first occurrence"
    Assert-ToolResolutionCondition -Condition ($normalizedCandidates[1] -eq $firstValidTool) -Message "candidate normalization reordered later candidates"

    $zeroCandidateFailure = $null
    try {
        Resolve-CmakeTool -Name "cmake" -CommandResolver { param([string]$CommandName) @() } -VisualStudioCandidateResolver { param([string]$CommandName) @() } | Out-Null
    } catch {
        $zeroCandidateFailure = $_.Exception.Message
    }
    Assert-ToolResolutionCondition -Condition ($zeroCandidateFailure -match "no usable executable passed '--version'") -Message "zero candidates did not produce the usable-tool failure"

    $oneCandidate = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        $applicationInfo
    }.GetNewClosure() -VisualStudioCandidateResolver { param([string]$CommandName) @() }
    Assert-ToolResolutionCondition -Condition ($oneCandidate -is [string]) -Message "one candidate did not resolve to a string"
    Assert-ToolResolutionCondition -Condition ($oneCandidate -eq $firstValidTool) -Message "one candidate did not resolve to its normalized executable path"

    $invalidFirst = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        @(
            (New-ApplicationCandidate -Path $invalidTool -Property "Source")
            (New-ApplicationCandidate -Path $firstValidTool -Property "Path")
        )
    }.GetNewClosure() -VisualStudioCandidateResolver { param([string]$CommandName) @() }
    Assert-ToolResolutionCondition -Condition ($invalidFirst -eq $firstValidTool) -Message "an invalid first PATH candidate did not fall through to the next valid candidate"

    $reversedCandidates = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        @(
            (New-ApplicationCandidate -Path $firstValidTool -Property "Source")
            (New-ApplicationCandidate -Path $secondValidTool -Property "Path")
        )
    }.GetNewClosure() -VisualStudioCandidateResolver { param([string]$CommandName) @() }
    Assert-ToolResolutionCondition -Condition ($reversedCandidates -eq $firstValidTool) -Message "multiple candidates did not retain PowerShell precedence order"

    $sourceOnly = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        New-ApplicationCandidate -Path $secondValidTool -Property "Source"
    }.GetNewClosure() -VisualStudioCandidateResolver { param([string]$CommandName) @() }
    Assert-ToolResolutionCondition -Condition ($sourceOnly -eq $secondValidTool) -Message "Source-only candidate was not resolved"

    $pathOnly = Resolve-CmakeTool -Name "cmake" -CommandResolver {
        param([string]$CommandName)
        New-ApplicationCandidate -Path $secondValidTool -Property "Path"
    }.GetNewClosure() -VisualStudioCandidateResolver { param([string]$CommandName) @() }
    Assert-ToolResolutionCondition -Condition ($pathOnly -eq $secondValidTool) -Message "Path-only candidate was not resolved"

    $visualStudioFallback = Resolve-CmakeTool -Name "cmake" -CommandResolver { param([string]$CommandName) @() } -VisualStudioCandidateResolver {
        param([string]$CommandName)
        $fallbackTool
    }.GetNewClosure()
    Assert-ToolResolutionCondition -Condition ($visualStudioFallback -eq $fallbackTool) -Message "validated Visual Studio fallback was not selected"

    Write-Host "CMake tool resolution fixtures passed."
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
