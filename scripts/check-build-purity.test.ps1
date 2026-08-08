[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "check-build-purity.ps1")

function Assert-Condition {
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

function Invoke-FixtureGit {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & git -C $Repository @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git fixture command failed: $($Arguments -join ' ')"
    }
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("licensecc-build-purity-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    Invoke-FixtureGit -Repository $fixtureRoot -Arguments @("init", "--quiet")
    Invoke-FixtureGit -Repository $fixtureRoot -Arguments @("config", "user.email", "fixture@example.invalid")
    Invoke-FixtureGit -Repository $fixtureRoot -Arguments @("config", "user.name", "Build Purity Fixture")

    Set-Content -LiteralPath (Join-Path $fixtureRoot ".gitignore") -Value "extern/license-generator/`nprojects/`ninstall/" -NoNewline
    Set-Content -LiteralPath (Join-Path $fixtureRoot "tracked.txt") -Value "base" -NoNewline
    Set-Content -LiteralPath (Join-Path $fixtureRoot "already-dirty.txt") -Value "base" -NoNewline
    Set-Content -LiteralPath (Join-Path $fixtureRoot "staged.txt") -Value "base" -NoNewline
    Set-Content -LiteralPath (Join-Path $fixtureRoot "unstaged.txt") -Value "base" -NoNewline
    Invoke-FixtureGit -Repository $fixtureRoot -Arguments @("add", ".")
    Invoke-FixtureGit -Repository $fixtureRoot -Arguments @("commit", "--quiet", "-m", "fixture")

    $uninitializedGenerator = Join-Path $fixtureRoot "uninitialized-generator"
    New-Item -ItemType Directory -Path $uninitializedGenerator | Out-Null
    Assert-Condition -Condition (-not (Test-NestedGitCheckout -Path $uninitializedGenerator)) -Message "an empty nested directory was treated as a Git checkout"

    Set-Content -LiteralPath (Join-Path $fixtureRoot "already-dirty.txt") -Value "pre-existing dirty bytes" -NoNewline
    Set-Content -LiteralPath (Join-Path $fixtureRoot "staged.txt") -Value "staged bytes" -NoNewline
    Invoke-FixtureGit -Repository $fixtureRoot -Arguments @("add", "staged.txt")
    Set-Content -LiteralPath (Join-Path $fixtureRoot "unstaged.txt") -Value "unstaged bytes" -NoNewline
    Set-Content -LiteralPath (Join-Path $fixtureRoot "root-untracked.txt") -Value "root untracked bytes" -NoNewline

    $generatorRoot = Join-Path $fixtureRoot "extern/license-generator"
    New-Item -ItemType Directory -Force -Path $generatorRoot | Out-Null
    Invoke-FixtureGit -Repository $generatorRoot -Arguments @("init", "--quiet")
    Invoke-FixtureGit -Repository $generatorRoot -Arguments @("config", "user.email", "fixture@example.invalid")
    Invoke-FixtureGit -Repository $generatorRoot -Arguments @("config", "user.name", "Build Purity Fixture")
    Set-Content -LiteralPath (Join-Path $generatorRoot "tracked-generator.txt") -Value "generator base" -NoNewline
    Invoke-FixtureGit -Repository $generatorRoot -Arguments @("add", ".")
    Invoke-FixtureGit -Repository $generatorRoot -Arguments @("commit", "--quiet", "-m", "fixture")
    Set-Content -LiteralPath (Join-Path $generatorRoot "nested-untracked.lic") -Value "license bytes" -NoNewline

    $projectsRoot = Join-Path $fixtureRoot "projects"
    $installRoot = Join-Path $fixtureRoot "install"
    New-Item -ItemType Directory -Force -Path $projectsRoot, $installRoot | Out-Null
    Set-Content -LiteralPath (Join-Path $projectsRoot "private_key.rsa") -Value "external key fixture" -NoNewline
    Set-Content -LiteralPath (Join-Path $installRoot "artifact.txt") -Value "install fixture" -NoNewline

    $before = Get-SourceSnapshot -RepositoryRoot $fixtureRoot
    Assert-Condition -Condition $before.Root.Untracked.Entries.Contains("root-untracked.txt") -Message "root untracked fixture was not fingerprinted"
    Assert-Condition -Condition $before.Generator.Untracked.Entries.Contains("nested-untracked.lic") -Message "nested generator license fixture was not fingerprinted"
    Assert-Condition -Condition (-not [string]::IsNullOrEmpty($before.Root.StagedDiffHash)) -Message "staged diff was not fingerprinted"
    Assert-Condition -Condition (-not [string]::IsNullOrEmpty($before.Root.UnstagedDiffHash)) -Message "unstaged diff was not fingerprinted"

    $same = Get-SourceSnapshot -RepositoryRoot $fixtureRoot
    Assert-Condition -Condition (@(Compare-SourceSnapshots -Before $before -After $same).Count -eq 0) -Message "identical source snapshots differ"

    Set-Content -LiteralPath (Join-Path $fixtureRoot "already-dirty.txt") -Value "mutated after snapshot" -NoNewline
    $changedDirty = Get-SourceSnapshot -RepositoryRoot $fixtureRoot
    $dirtyChanges = Compare-SourceSnapshots -Before $before -After $changedDirty
    Assert-Condition -Condition (@($dirtyChanges -match "root").Count -gt 0) -Message "mutation of an already-dirty file was not detected"

    Set-Content -LiteralPath (Join-Path $projectsRoot "private_key.rsa") -Value "mutated key fixture" -NoNewline
    $changedProjects = Get-SourceSnapshot -RepositoryRoot $fixtureRoot
    $projectChanges = Compare-SourceSnapshots -Before $changedDirty -After $changedProjects
    Assert-Condition -Condition (@($projectChanges -match "projects").Count -gt 0) -Message "projects tree mutation was not detected"

    Set-Content -LiteralPath (Join-Path $installRoot "artifact.txt") -Value "mutated install fixture" -NoNewline
    $changedInstall = Get-SourceSnapshot -RepositoryRoot $fixtureRoot
    $installChanges = Compare-SourceSnapshots -Before $changedProjects -After $changedInstall
    Assert-Condition -Condition (@($installChanges -match "install").Count -gt 0) -Message "install tree mutation was not detected"

    Write-Host "Build purity snapshot fixtures passed."
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
