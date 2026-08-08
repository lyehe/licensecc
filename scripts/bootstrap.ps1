[CmdletBinding()]
param(
    [switch]$CheckOnly,

    [string]$RepositoryRoot = (Join-Path $PSScriptRoot "..")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$generatorRelativePath = "extern/license-generator"
$generatorPath = Join-Path $repositoryRoot $generatorRelativePath

function Invoke-BootstrapGitText {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [switch]$AllowFailure
    )

    $result = & git -C $repositoryRoot @Arguments 2>$null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "Bootstrap prerequisite command failed with exit code $exitCode."
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Text = [string]::Join("`n", @($result))
    }
}

function Get-GeneratorState {
    $gitAvailable = $null -ne (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
    if (-not $gitAvailable) {
        return [pscustomobject]@{
            GitAvailable = $false
            ExpectedCommit = $null
            Initialized = $false
            ActualCommit = $null
            DirtyEntries = @()
        }
    }

    $gitlink = Invoke-BootstrapGitText -Arguments @("ls-tree", "HEAD", "--", $generatorRelativePath)
    $expectedCommit = $null
    if ($gitlink.Text -match "^160000 commit ([0-9a-f]{40})\s+$([regex]::Escape($generatorRelativePath))$") {
        $expectedCommit = $Matches[1]
    }

    $generatorGitMarker = Join-Path $generatorPath ".git"
    $initialized = (Test-Path -LiteralPath $generatorPath -PathType Container) -and (
        (Test-Path -LiteralPath $generatorGitMarker -PathType Leaf) -or
        (Test-Path -LiteralPath $generatorGitMarker -PathType Container)
    )
    $actualCommit = $null
    $dirtyEntries = @()
    if ($initialized) {
        $topLevel = & git -C $generatorPath rev-parse --show-toplevel 2>$null
        if ($LASTEXITCODE -eq 0) {
            $resolvedTopLevel = (Resolve-Path -LiteralPath ([string]::Join("`n", @($topLevel))).Trim()).Path
            $resolvedGenerator = (Resolve-Path -LiteralPath $generatorPath).Path
            $pathComparison = if ($IsWindows) {
                [System.StringComparison]::OrdinalIgnoreCase
            } else {
                [System.StringComparison]::Ordinal
            }
            if (-not $resolvedTopLevel.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar).Equals(
                $resolvedGenerator.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar),
                $pathComparison)) {
                $initialized = $false
            }
        } else {
            $initialized = $false
        }

        if ($initialized) {
            $actual = & git -C $generatorPath rev-parse --verify HEAD 2>$null
            if ($LASTEXITCODE -ne 0) {
                $initialized = $false
            } else {
                $actualCommit = ([string]::Join("`n", @($actual))).Trim()
            }
        }

        if ($initialized) {
            $dirty = & git -C $generatorPath status --porcelain=v1 --untracked-files=all 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw "Could not inspect the initialized generator checkout."
            }
            $dirtyEntries = @($dirty | Where-Object { $_ })
        }
    }

    return [pscustomobject]@{
        GitAvailable = $true
        ExpectedCommit = $expectedCommit
        Initialized = $initialized
        ActualCommit = $actualCommit
        DirtyEntries = $dirtyEntries
    }
}

function Get-CmakeAvailability {
    if (Get-Command cmake -CommandType Application -ErrorAction SilentlyContinue) {
        return "available on PATH"
    }

    if ($IsWindows) {
        $programFiles = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)
        foreach ($edition in @("Community", "Professional", "Enterprise", "BuildTools")) {
            $candidate = Join-Path $programFiles "Microsoft Visual Studio/2022/$edition/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return "available from Visual Studio"
            }
        }
    }

    return "not found"
}

function Write-BootstrapReport {
    param(
        [Parameter(Mandatory = $true)]
        [object]$State
    )

    Write-Host "Repository: $repositoryRoot"
    Write-Host "Prerequisite git: $(if ($State.GitAvailable) { 'available' } else { 'missing' })"
    Write-Host "Prerequisite CMake: $(Get-CmakeAvailability)"
    Write-Host "Expected generator gitlink: $(if ($State.ExpectedCommit) { $State.ExpectedCommit } else { '<missing>' })"
    Write-Host "Generator initialized: $(if ($State.Initialized) { 'yes' } else { 'no' })"
    Write-Host "Generator actual SHA: $(if ($State.ActualCommit) { $State.ActualCommit } else { '<unavailable>' })"
    Write-Host "Generator matches gitlink: $(if ($State.ExpectedCommit -and $State.ActualCommit -eq $State.ExpectedCommit) { 'yes' } else { 'no' })"
    Write-Host "Generator dirty: $(if ($State.DirtyEntries.Count -gt 0) { "yes ($($State.DirtyEntries.Count) status entries)" } else { 'no' })"
}

$state = Get-GeneratorState
Write-BootstrapReport -State $state

if ($CheckOnly) {
    if (-not $state.GitAvailable -or -not $state.ExpectedCommit -or -not $state.Initialized -or
        $state.ActualCommit -ne $state.ExpectedCommit -or $state.DirtyEntries.Count -gt 0) {
        exit 1
    }
    exit 0
}

if (-not $state.GitAvailable) {
    throw "git is required for bootstrap. Install it, then rerun scripts/bootstrap.ps1."
}

if (-not $state.ExpectedCommit) {
    throw "The generator gitlink is missing from HEAD; bootstrap cannot determine the pinned checkout."
}

if ($state.Initialized) {
    if ($state.DirtyEntries.Count -gt 0) {
        throw "The initialized generator checkout is dirty. Preserve or commit its work before bootstrap; no update was attempted."
    }
    if ($state.ActualCommit -ne $state.ExpectedCommit) {
        throw "The initialized generator checkout is not at the pinned gitlink. Reconcile it deliberately before bootstrap; no update was attempted."
    }

    Write-Host "Generator checkout already matches the pinned gitlink; no update is needed."
    exit 0
}

Write-Host "Initializing the pinned generator checkout."
& git -C $repositoryRoot submodule update --init --recursive
if ($LASTEXITCODE -ne 0) {
    throw "Pinned generator initialization failed with exit code $LASTEXITCODE."
}

$after = Get-GeneratorState
Write-BootstrapReport -State $after
if (-not $after.Initialized -or $after.ActualCommit -ne $after.ExpectedCommit -or $after.DirtyEntries.Count -gt 0) {
    throw "Bootstrap completed without a clean generator checkout at the pinned gitlink."
}
