[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-BootstrapCondition {
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

function Invoke-BootstrapFixtureGit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & git -C $Repository @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "fixture command failed: $($Arguments -join ' ')"
    }
}

$bootstrap = Join-Path $PSScriptRoot "bootstrap.ps1"
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("licensecc-bootstrap-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("init", "--quiet")
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("config", "user.email", "fixture@example.invalid")
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("config", "user.name", "Bootstrap Fixture")
    Set-Content -LiteralPath (Join-Path $fixtureRoot "tracked.txt") -Value "fixture" -NoNewline
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("add", "tracked.txt")
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("commit", "--quiet", "-m", "fixture")

    $gitlinkCommit = (& git -C $fixtureRoot rev-parse --verify HEAD).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "could not resolve fixture commit"
    }
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("update-index", "--add", "--cacheinfo", "160000,$gitlinkCommit,extern/license-generator")
    Invoke-BootstrapFixtureGit -Repository $fixtureRoot -Arguments @("commit", "--quiet", "-m", "generator gitlink")
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureRoot "extern/license-generator") | Out-Null

    $before = [string]::Join("`n", @(& git -C $fixtureRoot status --porcelain=v1 --untracked-files=all))
    $output = @(& pwsh -NoProfile -File $bootstrap -CheckOnly -RepositoryRoot $fixtureRoot 2>&1)
    $exitCode = $LASTEXITCODE
    $after = [string]::Join("`n", @(& git -C $fixtureRoot status --porcelain=v1 --untracked-files=all))

    Assert-BootstrapCondition -Condition ($exitCode -eq 1) -Message "check-only should report an uninitialized generator checkout"
    Assert-BootstrapCondition -Condition (@($output -match "Generator initialized: no").Count -gt 0) -Message "an empty generator directory was treated as initialized"
    Assert-BootstrapCondition -Condition (@($output -match "Generator actual SHA: <unavailable>").Count -gt 0) -Message "bootstrap walked up to the superproject for an uninitialized generator directory"
    Assert-BootstrapCondition -Condition ($before -eq $after) -Message "check-only changed fixture source state"

    Write-Host "Bootstrap uninitialized-directory fixture passed."
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
